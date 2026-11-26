// The working folder (the core; docs/SPI.md "The working folder"): where an
// agent tab's finished downloads land, and where the agent's scripts read,
// write and delete files. The installers set it (--working-dir,
// ~/zenius-files by default) in <zenius home>/config.json, which the runtime
// reads once at each start, as the sandboxed launcher does at each command.
// The sidebar asks the runtime (workingFolder). Changing it moves no files.
//
// A Zen on a dev profile (scripts/zen-dev.sh's) reads its own,
// zenius.dev.workingFolder, never the config: no dev or test run reaches the
// user's folder.
//
// The rules are scripts/working-folder.sh's: the agent's scripts write the
// folder, so it holds a task's files and nothing more.

import { devProfile, zeniusHome } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

/** The folder an install sets when it's given none, in the home folder. */
export const DEFAULT_NAME = "zenius-files";
/** A dev profile's working folder, which zen-dev.sh sets. */
export const DEV_PREF = "zenius.dev.workingFolder";

/**
 * @typedef {object} WorkingFolder
 * @property {string} [path]   as the config names it
 * @property {string} [real]   with every link resolved, as checks compare it
 * @property {string} [error]  why there's none to use, in place of both
 * @property {"config"|"default"|"dev"} source
 */

/** @type {WorkingFolder|null} */
let current = null;
/** @type {Promise<WorkingFolder>|null} */
let loading = null;

/**
 * The working folder this run of Zen uses, read at its start: `{path, real}`,
 * or `{error}` saying why there's none to use (shown to the agent and the
 * user as is). Null until loadWorkingFolder has read it.
 *
 * @returns {WorkingFolder|null}
 */
export function workingFolder() {
  return current;
}

/** Read the working folder once per run of Zen; later calls get that read. */
export function loadWorkingFolder() {
  loading ??= readWorkingFolder().then(found => {
    current = found;
    return found;
  });
  return loading;
}

/** Tests only (dev profiles): read it again, as a new start would. */
export function reloadWorkingFolder() {
  loading = null;
  return loadWorkingFolder();
}

function localFile(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

/** Whether `path` is a folder, or a link to one; never throws (isDirectory does for nothing there). */
function isFolder(path) {
  try {
    return localFile(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether anything is at `path`, a dangling link included. */
function present(path) {
  const file = localFile(path);
  try {
    if (file.isSymlink()) {
      return true;
    }
  } catch {
    return false;
  }
  return file.exists();
}

/**
 * Whether the .git at `path` makes its folder a project's, as git takes it
 * (scripts/working-folder.sh's wf_git_found). An empty folder (a real one,
 * not a link, that can be listed) is no repository to git, which looks on
 * above it, nor here: Codex's sandbox on Linux makes one in each folder its
 * commands may write, while each runs. Anything else there counts: a link
 * (dangling or not), a file, a folder with anything in it, or one that
 * can't be listed.
 */
async function gitFound(path) {
  if (!present(path)) {
    return false;
  }
  try {
    const file = localFile(path);
    if (file.isSymlink() || !file.isDirectory()) {
      return true;
    }
    return (await IOUtils.getChildren(path)).length > 0;
  } catch {
    return true;
  }
}

/** `path` with its existing part's links resolved, as the sandbox rules compare paths. */
export function resolvePath(path) {
  let head = path;
  let rest = "";
  while (head !== "/" && !localFile(head).exists()) {
    rest = `/${PathUtils.filename(head)}${rest}`;
    head = PathUtils.parent(head);
  }
  const file = localFile(head);
  try {
    file.normalize();
  } catch {}
  return `${file.path === "/" ? "" : file.path}${rest}` || "/";
}

/** Whether `inner` is `outer` or inside it. */
function within(inner, outer) {
  return inner === outer || inner.startsWith(outer === "/" ? "/" : `${outer}/`);
}

/** Whether `path` needs no escaping in the config file: no double quote, backslash or control character. */
function plain(path) {
  return !/["\\\u0000-\u001f\u007f]/.test(path);
}

/**
 * The config file's workingFolder line, as scripts/working-folder.sh's
 * wf_saved and the launcher read it: the key on a line of its own, any
 * spacing around it ([[:space:]] in sed's C locale), a value with no double
 * quote or backslash, and an optional comma.
 */
const CONFIG_LINE = /^[ \t\v\f\r]*"workingFolder"[ \t\v\f\r]*:[ \t\v\f\r]*"([^"\\]*)"[ \t\v\f\r]*,?[ \t\v\f\r]*$/;

/**
 * The folder the config file's text names, by the shell's rule: exactly one
 * such line, holding an absolute path with no control character and no ".."
 * part. Otherwise null: the file is refused, as the launcher refuses it,
 * never read another way or replaced by the default. No installer writes a
 * "..": after a link it leads to the target's parent for the files read
 * here, but drops the link's name for the SDK's path.resolve, so the two
 * would name different folders.
 */
export function configuredFolder(text) {
  const found = text.split("\n").flatMap(line => {
    const match = CONFIG_LINE.exec(line);
    return match ? [match[1]] : [];
  });
  return found.length === 1 && found[0].startsWith("/") && plain(found[0]) && !/\/\.\.(\/|$)/.test(found[0]) ? found[0] : null;
}

function dirPath(key) {
  try {
    return Services.dirsvc.get(key, Ci.nsIFile).path;
  } catch {
    return null;
  }
}

/**
 * Where the folder comes from: the dev pref on a dev profile, else the
 * config file, else the default. `zhome`, `home` and `dev` stand in for Zen's
 * own in tests.
 *
 * @returns {Promise<{path?: string, error?: string, source: WorkingFolder["source"]}>}
 */
async function configured({ zhome = zeniusHome(), home = dirPath("Home"), dev = devProfile() } = {}) {
  if (dev) {
    const path = Services.prefs.getStringPref(DEV_PREF, "");
    return path ? { path, source: "dev" } : { error: `this dev profile has no working folder: set ${DEV_PREF}`, source: "dev" };
  }
  const file = PathUtils.join(zhome, "config.json");
  let text;
  try {
    text = await IOUtils.readUTF8(file);
  } catch (e) {
    if (e.name === "NotFoundError") {
      // ~/zenius-files is the default only while zenius's home is ~/.zenius:
      // a ZENIUS_HOME elsewhere has none, so a run that moved zenius's home
      // alone can't reach the user's own folder.
      if (resolvePath(zhome) !== resolvePath(PathUtils.join(home, ".zenius"))) {
        return {
          error: `there's no default working folder: ZENIUS_HOME is ${zhome}, not ~/.zenius, and it holds no config.json: run the installer again with --working-dir <folder>`,
          source: "config",
        };
      }
      return { path: PathUtils.join(home, DEFAULT_NAME), source: "default" };
    }
    return { error: `can't read ${file} (${e.message})`, source: "config" };
  }
  const path = configuredFolder(text);
  if (!path) {
    return {
      error: `${file} doesn't name the working folder on a line of its own, as the installer writes it: run the installer again with --working-dir <folder>`,
      source: "config",
    };
  }
  return { path, source: "config" };
}

/** The user's runtime folder on Linux, /run/user/<uid>, which holds their session's sockets; null elsewhere. */
async function userRuntimeDir() {
  try {
    // A /proc file's size reads as 0, so it's read up to a bound (readUTF8
    // reads nothing).
    const status = new TextDecoder().decode(await IOUtils.read("/proc/self/status", { maxBytes: 16384 }));
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    return uid ? `/run/user/${uid}` : null;
  } catch {
    return null;
  }
}

/**
 * Why the folder at the real path `real` can't be the working folder, or
 * null: scripts/working-folder.sh's wf_why_not, with Zen's own profile and
 * app among the folders it may neither hold nor be inside. (The installers
 * also keep out the CLI copy, the zenius command's folder and its node,
 * which Zen doesn't know: they check the folder before it's written here.)
 */
export async function whyNot(real, { home = dirPath("Home"), zhome = zeniusHome(), profile = PathUtils.profileDir, app = dirPath("GreD"), tmp = dirPath("TmpD"), run } = {}) {
  if (real === "/") {
    return "it's the root folder";
  }
  const homeReal = resolvePath(home);
  const shared = [homeReal, "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/dev/shm", tmp && resolvePath(tmp)].filter(Boolean);
  if (shared.some(folder => within(folder, real))) {
    return "it's your home folder, a temporary folder, or a folder above one";
  }
  const kept = [
    zhome,
    run === undefined ? await userRuntimeDir() : run,
    profile,
    // Zen.app as a whole, where GreD is Contents/Resources.
    app && app.endsWith("/Contents/Resources") ? PathUtils.parent(app, 2) : app,
    ...[".zenius-dev", ".zen", ".config", ".local", ".ssh", ".gnupg", ".aws", ".docker", ".kube", "Library"].map(name => PathUtils.join(home, name)),
  ];
  for (const folder of kept) {
    if (!folder) {
      continue;
    }
    const keptReal = resolvePath(folder);
    if (within(keptReal, real)) {
      return `it holds ${keptReal}, which the agent's scripts must not reach`;
    }
    if (within(real, keptReal)) {
      return `it's inside ${keptReal}, which the agent's scripts must not reach`;
    }
  }
  if (await gitFound(PathUtils.join(real, ".git"))) {
    return "it holds .git, so it's a project's folder";
  }
  if (present(PathUtils.join(real, ".envrc"))) {
    return "it holds .envrc, which direnv runs";
  }
  // A repository at the home folder or a temporary folder itself (dotfiles,
  // or a stray one on a shared machine) doesn't count: every folder below
  // sits in its work tree, and its .git is out of the scripts' reach. Nor
  // does an empty .git folder, past which the walk goes on, as git's does.
  for (let dir = PathUtils.parent(real); dir && dir !== "/" && !shared.includes(dir); dir = PathUtils.parent(dir)) {
    if (await gitFound(PathUtils.join(dir, ".git"))) {
      return `it's inside a git work tree, ${dir}`;
    }
  }
  return null;
}

/**
 * The working folder as this start finds it: where it comes from, and
 * whether it can be used. A folder that's missing is fine while its parent
 * folder is there: the first download makes it (makeWorkingFolder), as the
 * installer and the launcher do. Options stand in for Zen's own folders in
 * tests.
 *
 * @returns {Promise<WorkingFolder>}
 */
export async function readWorkingFolder(options = {}) {
  const found = await configured(options);
  if (found.error) {
    return found;
  }
  const { source } = found;
  const path = found.path === "/" ? "/" : found.path.replace(/\/+$/, "");
  if (!path.startsWith("/") || !plain(path)) {
    return { error: `the working folder must be an absolute path with no double quote, backslash or control character: ${JSON.stringify(path)}`, source };
  }
  // As scripts/working-folder.sh refuses a given one (wf_dotdot), for the
  // reason configuredFolder gives. The config file's line can't hold one, so
  // this is a dev profile's pref.
  if (/\/\.\.(\/|$)/.test(path)) {
    return { error: `the working folder must be named without a ".." part, which can lead elsewhere through a link: ${JSON.stringify(path)}`, source };
  }
  if (present(path) ? !isFolder(path) : !isFolder(PathUtils.parent(path))) {
    return {
      error: present(path) ? `the working folder, ${path}, isn't a folder` : `the working folder's parent folder, ${PathUtils.parent(path)}, isn't there`,
      path,
      source,
    };
  }
  const real = resolvePath(path);
  const why = await whyNot(real, options);
  if (why) {
    return { error: `the working folder can't be ${path}: ${why}`, path, source };
  }
  return { path, real, source };
}

/**
 * Make the working folder if it's missing (0700, its parent must be there),
 * and check it's still a folder that resolves where it did at the start.
 * Rejects with the reason otherwise.
 *
 * @param {WorkingFolder} folder
 */
export async function makeWorkingFolder(folder) {
  if (folder.error) {
    throw new Error(folder.error);
  }
  if (!present(folder.path)) {
    await IOUtils.makeDirectory(folder.path, { createAncestors: false, ignoreExisting: true, permissions: 0o700 });
  }
  if (!isFolder(folder.path) || resolvePath(folder.path) !== folder.real) {
    throw new Error(`the working folder, ${folder.path}, has changed since Zen started: restart Zen to read it again`);
  }
}
