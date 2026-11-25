// Small helpers shared by the parent-process modules.

export const RUNTIME_VERSION = "0.1.7";
export const PROTOCOL_VERSION = 1;

/** Base URL of the runtime inside the profile (fx-autoconfig maps chrome/JS here). */
export const BASE_URL = "chrome://userscripts/content/zenius/";

/**
 * dump() reaches stdout only when browser.dom.window.dump.enabled is set,
 * which dev profiles do and a daily profile doesn't, so logging stays silent
 * there without a check of our own.
 *
 * @param {...any} args
 */
export function log(...args) {
  const text = args.map(a => (typeof a === "string" ? a : safeStringify(a))).join(" ");
  dump(`[zenius] ${text}\n`);
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Instance settings, read once at startup. `dev` turns on the dev.* methods
 * and every method of I5 class "dev". It needs pref zenius.dev and a profile
 * of the dev launcher's (devProfile), because the pref alone can come from a
 * user.js that anything able to save a file into the user's own profile
 * could write.
 */
export function readSettings() {
  return {
    instance: Services.prefs.getStringPref("zenius.instance", "default"),
    dev: devMode(),
  };
}

let devModeOn;

/** readSettings' `dev`, decided once: a profile doesn't move while Zen runs. */
export function devMode() {
  devModeOn ??= Services.prefs.getBoolPref("zenius.dev", false) && devProfile();
  return devModeOn;
}

/**
 * Whether a profile is one of scripts/zen-dev.sh's: its real path, links
 * resolved, is under the real <home>/.zenius-dev/profiles/. The user's own
 * profile never is, whatever its prefs say. By default, Zen's own profile
 * and home folder.
 *
 * @param {string} [profile]
 * @param {string} [home]
 */
export function devProfile(profile, home) {
  try {
    const root = realPath(PathUtils.join(home ?? Services.dirsvc.get("Home", Ci.nsIFile).path, ".zenius-dev", "profiles"));
    const real = realPath(profile ?? PathUtils.profileDir);
    return root !== null && real !== null && real.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/** `path` with every link resolved, or null when it doesn't exist. */
function realPath(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  if (!file.exists()) {
    return null;
  }
  file.normalize();
  return file.path;
}

/**
 * ~/.zenius, or $ZENIUS_HOME. The socket path must stay short (macOS allows
 * 104 bytes), which is why it isn't under the profile directory.
 */
export function zeniusHome() {
  const env = Services.env.get("ZENIUS_HOME");
  if (env) {
    return env;
  }
  return PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".zenius");
}

/**
 * The post-install self-check's folder, which holds its socket and its runs.
 * It's outside run/ on purpose: the sandboxed
 * launcher allows run/<instance>.sock for any instance name a caller gives.
 */
export function selfCheckDir(home = zeniusHome()) {
  return PathUtils.join(home, "selfcheck");
}

/**
 * An instance name that may name the self-check's socket and runs' folder:
 * letters, digits and . _ -, with no leading dot, so selfcheck/<instance>/
 * stays inside selfcheck/.
 */
export function plainInstance(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name);
}

/**
 * mkdir -p with mode 0700 on every directory it creates or finds, never
 * through a link: zenius's socket, records and modes go only where its own
 * folders are. Throws if `path`, or a
 * folder between `home` and it, is a link. `home` and the folders above it
 * may be links: macOS's /tmp is one, and so may the user's home be.
 */
export async function ensurePrivateDir(path, home = zeniusHome()) {
  refuseLinks(path, home);
  await IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true, permissions: 0o700 });
  // Again: a link swapped in while the folders were made.
  refuseLinks(path, home);
  await IOUtils.setPermissions(path, 0o700);
}

/** Throws if `path`, or a folder between `home` and it, is a symbolic link. */
function refuseLinks(path, home) {
  const parts = PathUtils.split(path);
  const top = PathUtils.split(home);
  const below = top.length < parts.length && top.every((part, i) => part === parts[i]);
  for (let i = below ? top.length : parts.length - 1; i < parts.length; i++) {
    const at = PathUtils.join(...parts.slice(0, i + 1));
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(at);
    let link = false;
    try {
      link = file.isSymlink();
    } catch {
      // Not there yet: makeDirectory makes it.
    }
    if (link) {
      throw new Error(`${at} is a link, and zenius follows none in its own folder`);
    }
  }
}

/**
 * Write JSON atomically with mode 0600: into a fresh temporary file made
 * exclusively, so a link planted at its name fails the write instead of
 * taking it, then renamed over `path`, which replaces a link there instead
 * of writing through it.
 */
export async function writePrivateJSON(path, value) {
  const tmp = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await IOUtils.writeJSON(tmp, value, { mode: "create" });
  try {
    await IOUtils.setPermissions(tmp, 0o600);
    await IOUtils.move(tmp, path);
  } catch (e) {
    await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
    throw e;
  }
}

export function zenVersion() {
  return Services.appinfo.version;
}

/**
 * The site of an http(s) URL as the user knows it, zenius's one rule for a
 * site: its registrable domain ("accounts.google.com.evil.co" is evil.co;
 * an IP address or a one-label host is itself), shown as Firefox's address
 * bar shows it. An IDN is Unicode when it's safe, and punycode when its
 * letters could spoof another name, as for a Latin and Cyrillic mix.
 *
 * @param {nsIURI} uri  http(s)
 * @returns {string}
 */
export function siteName(uri) {
  let host;
  try {
    host = Services.eTLD.getBaseDomain(uri);
  } catch {
    host = uri.asciiHost;
  }
  try {
    return Services.io.newURI(`${uri.scheme}://${host.includes(":") ? `[${host}]` : host}/`).displayHost;
  } catch {
    return host;
  }
}

/**
 * The site (siteName) of the top document a <browser> shows, by the
 * document's own principal; null for anything but an http(s) page: about:,
 * file:, an error page, or no document yet.
 *
 * @param {object} browser
 * @returns {string|null}
 */
export function documentSite(browser) {
  const principal = browser?.browsingContext?.currentWindowGlobal?.documentPrincipal;
  if (!principal?.isContentPrincipal || !(principal.schemeIs("http") || principal.schemeIs("https"))) {
    return null;
  }
  try {
    return siteName(principal.URI);
  } catch {
    return null;
  }
}

/** Milliseconds with sub-ms precision, monotonic. */
export const now = () => ChromeUtils.now();

/** A promise that rejects after `ms`; `clear()` cancels it. */
export function deadline(ms, makeError) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

export const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
