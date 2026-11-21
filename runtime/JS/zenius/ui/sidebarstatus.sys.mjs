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
 *   dev profile), and configPath, so doctor can name it;
 * - error: the startup's exception message from a window where it threw.
 *
 * @returns {Promise<{loaded: boolean, windows: number, config: "found"|"missing"|"none", configPath: string, error?: string}>}
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
  const path = configPath();
  let config = "none";
  if (path !== NO_AGENTS) {
    config = (await IOUtils.exists(path).catch(() => false)) ? "found" : "missing";
  }
  return { loaded: windows > 0, windows, config, configPath: path, ...(error ? { error } : {}) };
}
