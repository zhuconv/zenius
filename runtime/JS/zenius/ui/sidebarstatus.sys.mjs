// What zenius's agent sidebar reports about itself, for zen-sdk's doctor
// (ui.sidebarStatus). At the end of each window's start, agent-sidebar.uc.js
// sets window.zeniusSidebarStart = {error}: a property, so the sidebar's start
// loads no zenius module (I4), and this module loads with the method modules
// at the first connection. A sidebar script that isn't zenius's never sets
// it, so a profile where such a script ran never reads as loaded.

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

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
 * What doctor calls `win`: "popup" when its toolbar isn't visible, as a
 * site's sign-in window's (the sidebar's own test: it doesn't start there),
 * "private" for a private window, else "browser".
 *
 * @returns {"browser"|"private"|"popup"}
 */
function kindOf(win) {
  if (!win.toolbar?.visible) {
    return "popup";
  }
  return PrivateBrowsingUtils.isWindowPrivate(win) ? "private" : "browser";
}

/**
 * A window as perWindow lists it, from its kind and start (startOf): the
 * sidebar there is "started"; "failed", with its start's error; "skipped" in
 * a popup; "none" in another window with no start recorded, one still
 * opening or a profile whose sidebar file isn't zenius's. A popup's start,
 * which only an older sidebar file made, shows as it was.
 *
 * Only a failed window and one with no start carry their kind, the ones
 * doctor names. Any socket client may call the method, and the other
 * windows' kinds would tell it whether the user has a private window open.
 *
 * @returns {{sidebar: "started"|"failed"|"skipped"|"none", kind?: "browser"|"private"|"popup", error?: string}}
 */
function listed({ kind, start }) {
  if (!start) {
    return kind === "popup" ? { sidebar: "skipped" } : { kind, sidebar: "none" };
  }
  return start.error ? { kind, sidebar: "failed", error: start.error } : { sidebar: "started" };
}

/**
 * Where the sidebar reads its agents: the pref, else config.json in
 * zenius's own zenius-agent-sidebar folder, which it only reads.
 *
 * @returns {string}
 */
export function configPath() {
  return Services.prefs.getStringPref(PREF_CONFIG, "") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ...DEFAULT_CONFIG);
}

/**
 * - perWindow: each open browser window, oldest first, popups too (listed);
 * - open: those the sidebar starts in, all but popups; windows: in how many
 *   it started; failed: in how many its start threw; error: the first of
 *   those starts' message. A popup counts in none of them: a site's popup's
 *   error would hide that the main window loaded. open - windows - failed
 *   have no start recorded;
 * - loaded: zenius's sidebar started in at least one open window;
 * - config: whether its agents' config is there ("none": no agents, as in a
 *   dev profile), and configPath, so doctor can name it. Without the user's
 *   own file while the pref is unset, or with the pref "builtin", "builtin"
 *   when the sidebar's built-in agents can run, else "missing";
 * - builtin, where the sidebar would use them: what it found of its built-in
 *   agents (builtinStatus). Never for a path the pref names: the sidebar
 *   doesn't fall back to them there (AgentService.loadConfig);
 *
 * @returns {Promise<{loaded: boolean, windows: number, open: number, failed: number, perWindow: object[], config: "found"|"missing"|"builtin"|"none", configPath: string, builtin?: object, error?: string}>}
 */
export async function sidebarStatus() {
  const all = [];
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed) {
      all.push({ kind: kindOf(win), start: startOf(win) });
    }
  }
  // Counted by each window's kind, which perWindow mostly leaves out.
  const counted = all.filter(w => w.kind !== "popup");
  const windows = counted.filter(w => w.start && !w.start.error).length;
  const failures = counted.filter(w => w.start?.error);
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
  return {
    loaded: windows > 0,
    windows,
    open: counted.length,
    failed: failures.length,
    perWindow: all.map(listed),
    config,
    configPath: path,
    ...(builtin ? { builtin } : {}),
    ...(failures.length ? { error: failures[0].start.error } : {}),
  };
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
