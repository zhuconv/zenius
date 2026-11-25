// A scratch home for every test that runs an installer, the sandboxed
// launcher or the CLI, and the guard that keeps them off the account's own.
//
// Those read and write <zenius home>/config.json and make the working folder
// (~/zenius-files by default), so one run with the real HOME or ZENIUS_HOME
// would change the user's own install, and the suites also run on the user's
// own computer. Every suite imports this file (tests/lib/scratch-home.sh
// wraps it for shell runners):
//
//   const scratch = scratchHome("cli");             // in a before hook
//   spawn(command, args, { env: scratch.env() });   // HOME and ZENIUS_HOME of its own
//   guardHome(env, "my helper");                    // for an env built another way
//   scratch.remove();                               // in an after hook
//
// scratchHome makes a private folder (0700) in the suite's temporary folder
// with home/ as HOME, zhome/ as ZENIUS_HOME, and zhome/config.json naming
// files/ as the working folder, in the installer's form. Since its
// ZENIUS_HOME isn't HOME/.zenius, no reader falls back to a default folder:
// each one reads that config, or stops. guardHome refuses an environment
// whose HOME or ZENIUS_HOME is unset, or is (links resolved) the account's
// own home folder, as the password database names it, or its .zenius or a
// folder inside that. The test process's own HOME may already be a scratch
// one, so the guard never trusts it.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `path` with its existing part's links resolved, as the installers compare paths. */
export function realPath(path) {
  let head = resolve(path);
  let rest = "";
  for (;;) {
    try {
      return join(realpathSync(head), rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) {
        return join(head, rest);
      }
      rest = join(basename(head), rest);
      head = parent;
    }
  }
}

/** The account's own home folder, from the password database, whatever HOME says. */
export const REAL_HOME = realPath(userInfo().homedir);
const REAL_ZENIUS = realPath(join(REAL_HOME, ".zenius"));

function inside(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Returns `env` (a child's whole environment) when it names a HOME and a
 * ZENIUS_HOME that are neither the account's own home nor its .zenius, nor a
 * folder inside that; throws otherwise.
 *
 * @template {Record<string, string | undefined>} T
 * @param {T} env
 * @param {string} [what]  who asks, for the message
 * @returns {T}
 */
export function guardHome(env, what = "this test") {
  const problems = [];
  for (const name of ["HOME", "ZENIUS_HOME"]) {
    const value = env[name];
    if (!value) {
      problems.push(`${name} is unset`);
      continue;
    }
    const real = realPath(value);
    if (real === REAL_HOME) {
      problems.push(`${name} is ${value}, the account's own home folder`);
    } else if (inside(real, REAL_ZENIUS)) {
      problems.push(`${name} is ${value}, in the account's own ${REAL_ZENIUS}`);
    }
  }
  if (problems.length) {
    throw new Error(
      `${what} runs an installer, the launcher or the CLI only with a scratch HOME and ZENIUS_HOME (tests/lib/scratch-home.mjs): ${problems.join("; ")}`,
    );
  }
  return env;
}

/** Whether the config file can name `path` as the installer writes it. */
function plain(path) {
  return path.startsWith("/") && !/["\\\u0000-\u001f\u007f]/.test(path);
}

/**
 * @typedef {object} ScratchHome
 * @property {string} root          the private folder that holds the rest
 * @property {string} home          HOME
 * @property {string} zeniusHome    ZENIUS_HOME
 * @property {string} workingFolder the folder the config names (not made: readers make it)
 * @property {(extra?: Record<string, string | undefined>) => NodeJS.ProcessEnv} env
 *   process.env with HOME and ZENIUS_HOME here, then `extra`, guarded
 * @property {(folder?: string) => void} writeConfig
 *   writes zhome/config.json naming `folder` (the working folder by default)
 * @property {(from?: string) => void} shareRuntime
 *   links zhome/run and zhome/instances to those of `from` (the dev Zens'
 *   zenius home by default), for a launcher that must reach a dev Zen's
 *   socket and registry record; config.json stays this home's own
 * @property {() => void} remove
 */

/**
 * Makes a scratch home in `parent` (the suite's temporary folder).
 *
 * @param {string} [label]  names the folder (zt-<label>-XXXXXX); keep it short,
 *   since a Unix socket path in it must fit in 104 bytes on macOS
 * @param {{ parent?: string, config?: boolean, workingFolder?: string }} [options]
 *   `config: false` leaves out config.json, for a test of a first install
 * @returns {ScratchHome}
 */
export function scratchHome(label = "home", { parent = tmpdir(), config = true, workingFolder } = {}) {
  const root = mkdtempSync(join(parent, `zt-${label}-`));
  const home = join(root, "home");
  const zeniusHome = join(root, "zhome");
  const files = workingFolder ?? join(root, "files");
  mkdirSync(home, { mode: 0o700 });
  /** @type {ScratchHome} */
  const scratch = {
    root,
    home,
    zeniusHome,
    workingFolder: files,
    env: (extra = {}) => guardHome({ ...process.env, HOME: home, ZENIUS_HOME: zeniusHome, ...extra }, `scratch home ${root}`),
    writeConfig(folder = files) {
      if (!plain(folder)) {
        throw new Error(`the config file can't name ${JSON.stringify(folder)}: it takes an absolute path with no double quote, backslash or control character`);
      }
      mkdirSync(zeniusHome, { recursive: true, mode: 0o700 });
      writeFileSync(join(zeniusHome, "config.json"), `{\n  "workingFolder": "${folder}"\n}\n`, { mode: 0o600 });
    },
    shareRuntime(from = process.env.ZENIUS_HOME || join(homedir(), ".zenius")) {
      mkdirSync(zeniusHome, { recursive: true, mode: 0o700 });
      for (const name of ["run", "instances"]) {
        symlinkSync(join(from, name), join(zeniusHome, name));
      }
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  if (config) {
    scratch.writeConfig();
  }
  return scratch;
}

// For shell runners (tests/lib/scratch-home.sh): `node scratch-home.mjs
// --check <what>` exits 1 with the reason unless its own HOME and ZENIUS_HOME
// pass guardHome.
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url)) && process.argv[2] === "--check") {
  try {
    guardHome(process.env, process.argv[3] || "this runner");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
