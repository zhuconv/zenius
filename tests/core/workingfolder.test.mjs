// The runtime's half of the working folder's shared rules
// (tests/fixtures/working-folder.json, which the installers' and the
// launcher's suites read too), its reading of config.json, its rule when
// there's none, and a dev profile's pref: modules/workingfolder.sys.mjs's
// readWorkingFolder, asked through the dev channel, with each case's folders
// standing in for Zen's own (the home folder, the zenius home, the temporary
// folder, Zen's profile and app). The runtime has no check of who owns a
// folder, so a case the installers refuse as not the user's only has to be
// refused here, for any reason. The cases it doesn't run name what Zen
// doesn't know (the CLI copy, the zenius command's folder, the node on
// PATH), which the installers check before they write the config.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { realPath } from "../lib/scratch-home.mjs";
import { setup } from "./lib.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/working-folder.json", import.meta.url), "utf8"));
const WORKING = `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/workingfolder.sys.mjs");`;
/** Root reads any folder, so a case with one that can't be listed proves nothing then. */
const AS_ROOT = process.getuid?.() === 0;

let h;
let work;
/** Folders made unlistable, for after() to give their mode back. */
const unlistable = [];
before(async () => {
  h = await setup();
  // By real path, as the runtime compares paths: on macOS tmpdir() is a link.
  work = realpathSync(mkdtempSync(join(tmpdir(), "zwf-")));
});
after(async () => {
  // rmSync can't remove a folder that can't be listed, even an empty one.
  for (const folder of unlistable) chmodSync(folder, 0o700);
  rmSync(work, { recursive: true, force: true });
  await h.close();
});

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The runtime's words for each category of refusal (it has no ownership check: any refusal is one). */
const SAYS = {
  shared: () => /: it's your home folder, a temporary folder, or a folder above one$/,
  kept: kept => new RegExp(`: it(?: holds|'s inside) ${escape(kept)}, which the agent's scripts must not reach$`),
  project: () => /: it holds (\.git, so it's a project's folder|\.envrc, which direnv runs)$/,
  worktree: repo => new RegExp(`: it's inside a git work tree, ${escape(repo)}$`),
  "not-yours": () => /./,
  "not-a-folder": () => /^the working folder, .*, isn't a folder$/,
  "no-parent": () => /^the working folder's parent folder, .*, isn't there$/,
  // config.json can't hold one: the runtime refuses the file.
  "not-plain": () => / doesn't name the working folder on a line of its own, as the installer writes it: /,
};

let roots = 0;
/** A case's scratch root (~), its tokens filled in, and stand-ins for Zen's profile and app. */
function caseRoot() {
  const root = join(work, String((roots += 1)));
  mkdirSync(root, { mode: 0o700 });
  const profile = join(root, "zen-profiles", "default");
  const app = join(root, "zen-app");
  mkdirSync(profile, { recursive: true });
  mkdirSync(app);
  const tokens = { "{profile}": profile, "{profiles}": dirname(profile), "{app}": app };
  const fill = text => {
    let out = text.startsWith("~") ? root + text.slice(1) : text;
    for (const [token, value] of Object.entries(tokens)) out = out.replaceAll(token, value);
    return out;
  };
  return { root, fill, profile, app };
}

/** Makes a case's entries: "x/" a folder, "x" an empty file, "x -> y" a link to y; then its unlistable folders. */
function make(c, fill) {
  for (const entry of c.make ?? []) {
    const link = /^(.*) -> (.*)$/.exec(entry);
    if (link) {
      mkdirSync(dirname(fill(link[1])), { recursive: true });
      symlinkSync(fill(link[2]), fill(link[1]));
    } else if (entry.endsWith("/")) {
      mkdirSync(fill(entry), { recursive: true });
    } else {
      mkdirSync(dirname(fill(entry)), { recursive: true });
      writeFileSync(fill(entry), "");
    }
  }
  for (const folder of c.unlistable ?? []) {
    mkdirSync(fill(folder), { recursive: true });
    chmodSync(fill(folder), 0);
    unlistable.push(fill(folder));
  }
}

const config = folder => `{\n  "workingFolder": "${folder}"\n}\n`;

/** One case's setting: its folders, and its zenius home made, with config.json holding `text` (none for undefined). */
function setUp(c, text) {
  const { fill, profile, app } = caseRoot();
  make(c, fill);
  const env = { ...FIXTURE.env, ...c.env };
  const zhome = fill(env.ZENIUS_HOME);
  mkdirSync(zhome, { recursive: true, mode: 0o700 });
  if (text !== undefined) {
    writeFileSync(join(zhome, "config.json"), text, { mode: 0o600 });
  }
  return {
    fill,
    options: { dev: false, home: fill(env.HOME), zhome, tmp: env.TMPDIR ? fill(env.TMPDIR) : tmpdir(), profile, app, run: null },
  };
}

const read = options => h.chrome(`${WORKING} return await W.readWorkingFolder(arg);`, options);

test("the runtime agrees with tests/fixtures/working-folder.json: each refused folder with its reason, each allowed one taken", async () => {
  const cases = FIXTURE.cases.filter(c => (!c.by || c.by.includes("runtime")) && !(c.unlistable && AS_ROOT));
  assert.ok(cases.length > 30, `${cases.length} cases for the runtime`);
  const got = [];
  for (const c of cases) {
    const { fill, options } = setUp(c);
    const folder = fill(c.folder);
    writeFileSync(join(options.zhome, "config.json"), config(folder), { mode: 0o600 });
    const found = await read(options);
    if (c.outcome === "allowed") {
      if (found.error) got.push(`${c.name}: ${found.error}`);
      else if (found.path !== folder || found.real !== realPath(folder) || found.source !== "config") got.push(`${c.name}: ${JSON.stringify(found)}`);
      continue;
    }
    const said = SAYS[c.outcome]?.(c.repo ? realpathSync(fill(c.repo)) : c.kept ? realPath(fill(c.kept)) : "");
    if (!said) got.push(`${c.name}: no runtime wording for ${c.outcome}`);
    else if (!found.error || !said.test(found.error)) got.push(`${c.name}: expected ${c.outcome}, got ${JSON.stringify(found)}`);
  }
  assert.deepEqual(got, []);
});

test("the runtime reads config.json as the installers write it, and refuses a file that doesn't name the folder on a line of its own, never taking ~/zenius-files instead", async () => {
  const got = [];
  for (const { name, text } of FIXTURE.configs.readable) {
    const { fill, options } = setUp({});
    const folder = fill("~/files");
    writeFileSync(join(options.zhome, "config.json"), text.replaceAll("{folder}", folder), { mode: 0o600 });
    const found = await read(options);
    if (found.error || found.path !== folder) got.push(`readable, ${name}: ${JSON.stringify(found)}`);
  }
  for (const { name, text } of FIXTURE.configs.unreadable) {
    const { fill, options } = setUp({});
    const file = join(options.zhome, "config.json");
    writeFileSync(file, text.replaceAll("{folder}", fill("~/files")), { mode: 0o600 });
    const found = await read(options);
    const said = `${file} doesn't name the working folder on a line of its own, as the installer writes it: run the installer again with --working-dir <folder>`;
    if (found.error !== said || found.path !== undefined) got.push(`unreadable, ${name}: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(got, []);
});

test("without config.json the runtime takes ~/zenius-files only while its zenius home is ~/.zenius, by any path; another has no default", async () => {
  const plain = setUp({});
  assert.deepEqual(await read(plain.options), {
    path: plain.fill("~/zenius-files"),
    real: realPath(plain.fill("~/zenius-files")),
    source: "default",
  });
  // ~/.zenius through a link is still ~/.zenius.
  const linked = setUp({ make: ["~/.zenius/", "~/zhome-link -> ~/.zenius"] });
  const viaLink = await read({ ...linked.options, zhome: linked.fill("~/zhome-link") });
  assert.equal(viaLink.source, "default", JSON.stringify(viaLink));
  const moved = setUp({ env: { ZENIUS_HOME: "~/elsewhere/zhome" } });
  assert.deepEqual(await read(moved.options), {
    error: `there's no default working folder: ZENIUS_HOME is ${moved.options.zhome}, not ~/.zenius, and it holds no config.json: run the installer again with --working-dir <folder>`,
    source: "config",
  });
});

test("a dev profile reads its own pref, never config.json, has no working folder without it, and none from a pref with a \"..\" part", async () => {
  const pref = await h.chrome(`${WORKING} return Services.prefs.prefHasUserValue(W.DEV_PREF) ? Services.prefs.getStringPref(W.DEV_PREF) : null;`);
  assert.ok(pref, "zen-dev.sh sets the dev profile's working folder");
  const { fill, options } = setUp({}, config("/nowhere/from/the/config"));
  const dev = await read({ ...options, dev: true });
  assert.equal(dev.source, "dev");
  assert.equal(dev.path, pref.replace(/\/+$/, ""));
  try {
    const none = await h.chrome(`${WORKING} Services.prefs.clearUserPref(W.DEV_PREF); return await W.readWorkingFolder(arg);`, { ...options, dev: true });
    assert.deepEqual(none, { error: "this dev profile has no working folder: set zenius.dev.workingFolder", source: "dev" });
    // The config line's rule holds for the pref, a ".." part included: after
    // a link it leads elsewhere for the runtime than for the SDK.
    for (const bad of [`${pref}/../elsewhere`, `${pref}/..`]) {
      const refused = await h.chrome(`${WORKING} Services.prefs.setStringPref(W.DEV_PREF, arg.bad); return await W.readWorkingFolder(arg.options);`, {
        bad,
        options: { ...options, dev: true },
      });
      assert.deepEqual(
        refused,
        { error: `the working folder must be named without a ".." part, which can lead elsewhere through a link: ${JSON.stringify(bad)}`, source: "dev" },
        bad,
      );
    }
  } finally {
    await h.chrome(`${WORKING} Services.prefs.setStringPref(W.DEV_PREF, arg); return true;`, pref);
  }
  assert.equal(fill("~"), dirname(options.zhome));
});
