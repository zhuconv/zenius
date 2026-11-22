// What zenius's agent sidebar reports about itself, for zen-sdk's doctor
// (ui.sidebarStatus). At the end of each window's start, agent-sidebar.uc.js
// sets window.zeniusSidebarStart = {error}: a property, so the sidebar's start
// loads no zenius module (I4), and this module loads with the method modules
// at the first connection. The user's own sidebar never sets it, so a profile
// where it is the one that ran never reads as loaded.

const PREF_CONFIG = "uc.agent-sidebar.config";
const DEFAULT_CONFIG = ["Library", "Application Support", "zenius-agent-sidebar", "config.json"];
/** The pref's value that means no agents at all (every dev profile). */
const NO_AGENTS = "none";
/** The pref's value for the built-in agents alone, whatever file is there (tests). */
const BUILTIN = "builtin";

/** How zenius's sidebar started in `win`: null when it didn't. */
function startOf(win) {
  const s = win.zeniusSidebarStart;
  if (!s || typeof s !== "object") {
    return null;
  }
  return { error: typeof s.error === "string" && s.error ? s.error.slice(0, 500) : null };
}

/**
 * Where the sidebar reads its agents: the pref, else the user's own
 * zenius-agent-sidebar config, which it only reads.
 *
 * @returns {string}
 */
export function configPath() {
  return Services.prefs.getStringPref(PREF_CONFIG, "") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ...DEFAULT_CONFIG);
}

/**
 * - loaded: zenius's sidebar started in at least one open window;
 * - windows: how many;
 * - config: whether its agents' config is there ("none": no agents, as in a
 *   dev profile), and configPath, so doctor can name it. Without the user's
 *   own file while the pref is unset, or with the pref "builtin", "builtin"
 *   when the sidebar's built-in agents can run, else "missing";
 * - builtin, where the sidebar would use them: what it found of its built-in
 *   agents (builtinStatus). Never for a path the pref names: the sidebar
 *   doesn't fall back to them there (AgentService.loadConfig);
 * - error: the startup's exception message from a window where it threw.
 *
 * @returns {Promise<{loaded: boolean, windows: number, config: "found"|"missing"|"builtin"|"none", configPath: string, builtin?: object, error?: string}>}
 */
export async function sidebarStatus() {
  let windows = 0;
  let error = null;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const s = !win.closed && startOf(win);
    if (!s) {
      continue;
    }
    if (s.error) {
      error ??= s.error;
    } else {
      windows++;
    }
  }
  const set = Services.prefs.getStringPref(PREF_CONFIG, "");
  const path = configPath();
  let config = "none";
  let builtin = null;
  if (path !== NO_AGENTS) {
    config = path !== BUILTIN && (await IOUtils.exists(path).catch(() => false)) ? "found" : "missing";
    if (config === "missing" && (!set || set === BUILTIN)) {
      builtin = await builtinStatus();
      if (builtin.agents.length) {
        config = "builtin";
      }
    }
  }
  return { loaded: windows > 0, windows, config, configPath: path, ...(builtin ? { builtin } : {}), ...(error ? { error } : {}) };
}

/**
 * The sidebar's built-in agents, as its builtin.sys.mjs finds them now (it
 * writes nothing): which can run, the adapters' folder and Node's link, each
 * agent's CLI and whether its adapter is there, and the line saying what's
 * missing when none can run. Loaded only here, where the sidebar would use
 * them.
 *
 * @returns {Promise<{agents: string[], folder?: string, node?: string|null, clis?: Record<string, string|null>, adapters?: Record<string, boolean>, missing?: string|null, error?: string}>}
 */
async function builtinStatus() {
  try {
    const { builtinAgents } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/builtin.sys.mjs");
    const found = await builtinAgents();
    const each = pick => Object.fromEntries(Object.entries(found.found).map(([id, f]) => [id, pick(f)]));
    return {
      agents: Object.keys(found.config?.agents ?? {}),
      folder: found.folder,
      node: found.node,
      clis: each(f => f.cli),
      adapters: each(f => !!f.adapter),
      missing: found.missing,
    };
  } catch (e) {
    return { agents: [], error: String(e?.message ?? e).slice(0, 300) };
  }
}
