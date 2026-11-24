// On the Mac a dev Zen runs a copy of Zen.app with an identity of its own,
// never the user's Zen.app itself (ensure_dev_app in scripts/zen-dev.sh). No
// Mac and no Zen here: zen-dev.sh runs with stand-ins for the Mac's tools
// (uname says Darwin, cp -cR copies, df reports a number the test sets, and
// plutil, xattr, codesign, tmutil, lsregister and defaults note their
// arguments), against a stand-in Zen.app in the test's own folder, with HOME
// and ZENIUS_DEV_HOME the test's too.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const script = join(ROOT, "scripts", "zen-dev.sh");
const root = realpathSync(mkdtempSync(join(tmpdir(), "zenius-devapp-")));
const home = join(root, "home");
const dev = join(root, "dev");
const apps = join(dev, "app.noindex");
const source = join(root, "Applications", "Zen.app");
const calls = join(root, "calls.tsv");
const state = join(root, "state");
/** The stand-in zen writes the path it ran from here. */
const ran = join(root, "ran");
const ID = "io.github.zhuconv.zenius.zen-dev";
mkdirSync(home);
mkdirSync(state);

const running = new Set();
after(() => {
  for (const child of running) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const NOTE = `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >>"$STUB_CALLS"`;
const LAST = `for last; do :; done`;
const MAC_TOOLS = {
  uname: "echo Darwin",
  // The clone, at the cost in KB the test sets (none for an APFS clone).
  cp: `if [ "$1" = -cR ]; then
  ${NOTE}
  sleep "\${STUB_CP_SLEEP:-0}"
  echo $(($(cat "$STUB_STATE/avail") - \${STUB_CP_COST_KB:-0})) >"$STUB_STATE/avail"
  exec /bin/cp -R "$2" "$3"
fi
exec /bin/cp "$@"`,
  df: `echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/stub 900000000 1 $(cat "$STUB_STATE/avail") 1% /"`,
  // Zen.app declares URL and document types; the rest it doesn't.
  plutil: `${NOTE}
${LAST}
[ -f "$last" ] || { echo "plutil: no file $last" >&2; exit 1; }
if [ "$1" = -extract ]; then [ "$2" = CFBundleURLTypes ] || [ "$2" = CFBundleDocumentTypes ]; exit; fi`,
  xattr: `${NOTE}
${LAST}
[ -e "$last" ] || { echo "xattr: no file $last" >&2; exit 1; }
[ "$1" != -p ]`,
  // It refuses to sign when the test says, as it does a bundle with Finder information.
  codesign: `${NOTE}
${LAST}
[ -e "$last" ] || { echo "codesign: no file $last" >&2; exit 1; }
if [ "$1" = --force ] && [ -n "\${STUB_CODESIGN_REFUSE:-}" ]; then echo "$last: resource fork, Finder information, or similar detritus not allowed" >&2; exit 1; fi`,
  tmutil: NOTE,
  lsregister: NOTE,
  defaults: NOTE,
};

function toolDir(name, tools) {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const [tool, body] of Object.entries(tools)) {
    writeFileSync(join(dir, tool), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  return dir;
}
const macTools = toolDir("mac-bin", MAC_TOOLS);
const linuxTools = toolDir("linux-bin", { uname: "echo Linux" });

/** A stand-in Zen.app with build id `build`, and an application.ini of `ini` if given. */
function makeSource(build, { ini } = {}) {
  rmSync(source, { recursive: true, force: true });
  const contents = join(source, "Contents");
  const res = join(contents, "Resources");
  for (const dir of ["MacOS", "Resources/en.lproj", "Resources/distribution"]) mkdirSync(join(contents, dir), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), "<plist/>\n");
  mkdirSync(join(contents, "_CodeSignature"));
  writeFileSync(join(contents, "_CodeSignature", "CodeResources"), "<plist/>\n");
  // Zen.app's custom icon, which carries Finder information and a resource fork.
  writeFileSync(join(source, "Icon\r"), "");
  // The app inside it that content processes run from.
  mkdirSync(join(contents, "MacOS", "plugin-container.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(contents, "MacOS", "plugin-container.app", "Contents", "MacOS", "plugin-container"), "");
  writeFileSync(join(contents, "embedded.provisionprofile"), "Zen's profile\n");
  writeFileSync(join(contents, "MacOS", "zen"), `#!/bin/sh\necho "$0" >>"${ran}"\nexit 0\n`);
  chmodSync(join(contents, "MacOS", "zen"), 0o755);
  writeFileSync(
    join(res, "application.ini"),
    ini ?? `[App]\nVendor=Mozilla\nName=Zen\nRemotingName=zen\nVersion=9.9\nProfile=zen\nBuildID=${build}\n\n[Gecko]\nMinVersion=1\n`
  );
  writeFileSync(join(res, "en.lproj", "InfoPlist.strings"), 'CFBundleName = "Zen";\n');
  writeFileSync(join(res, "en.lproj", "other.strings"), 'x = "y";\n');
  writeFileSync(join(res, "config.js"), "// the user's own\n");
  writeFileSync(join(res, "distribution", "policies.json"), '{"policies": {"DisableTelemetry": true}}\n');
}

/** Every file under `dir`, with its mode and a hash of its content. */
function snapshot(dir) {
  const out = {};
  const walk = at => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else out[relative(dir, path)] = `${st.mode.toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}

function zenDev(args, { env = {}, tools = macTools } = {}) {
  const base = {
    ...process.env,
    HOME: home,
    ZENIUS_DEV_HOME: dev,
    ZENIUS_HOME: join(root, "zhome"),
    ZEN_APP: source,
    STUB_CALLS: calls,
    STUB_STATE: state,
    ZENIUS_START_WAIT_S: "5",
    ZENIUS_START_RETRIES: "0",
    PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  delete base.ZEN_BIN;
  return new Promise(resolve => {
    execFile("bash", [script, ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 120000 }, (error, stdout, stderr) =>
      resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

function resetCalls() {
  rmSync(calls, { force: true });
  writeFileSync(join(state, "avail"), "500000000\n");
}

function callsOf(tool) {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => line.split("\t"))
    .filter(c => c[0] === tool)
    .map(c => c.slice(1));
}

const has = (list, args) => list.some(c => JSON.stringify(c) === JSON.stringify(args));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const copyPath = new RegExp(`^${esc(apps)}/(\\d{14}-[0-9a-f]{12})/zenius-dev-zen\\.app/Contents/MacOS/zen$`);
const mode = path => statSync(path).mode & 0o777;
/** Gecko's update folder for the copy of key `key`: the copies' real path under updates/, cut at ".app". */
const updateFolder = key => join(home, "Library", "Caches", "Mozilla", "updates", realpathSync(apps).slice(1), key, "zenius-dev-zen");

test("the first dev start on the Mac makes a copy of Zen.app with an identity of its own, and changes nothing in Zen.app", async () => {
  makeSource("20990101000000");
  const before = snapshot(source);
  resetCalls();
  const made = await zenDev(["--app", "path"]);
  assert.equal(made.status, 0, made.stderr);
  const zen = made.stdout.trim();
  const key = zen.match(copyPath)?.[1];
  assert.ok(key?.startsWith("20990101000000-"), zen);
  const copy = join(apps, key, "zenius-dev-zen.app");

  // One clone of the app, into a folder that takes the key's name once the
  // copy is whole. Every other tool works on that copy, never on Zen.app.
  const clones = callsOf("cp");
  assert.equal(clones.length, 1);
  const [flag, from, making] = clones[0];
  assert.deepEqual([flag, from], ["-cR", source]);
  assert.match(making, new RegExp(`^${esc(apps)}/\\.make\\.[^/]+/zenius-dev-zen\\.app$`));
  for (const tool of ["plutil", "xattr", "codesign"]) {
    for (const c of callsOf(tool)) assert.ok(c.every(a => !a.startsWith(source)), `${tool} ${c.join(" ")} names Zen.app`);
  }
  assert.ok(has(callsOf("xattr"), ["-drs", "com.apple.quarantine", making]));
  assert.ok(callsOf("xattr").every(c => c[0] === "-p" || c[0].includes("s")), "every removal acts on a link itself, never on what it points to");

  // Its own id and name, and no claim on links or files.
  const plist = join(making, "Contents", "Info.plist");
  const plutil = callsOf("plutil");
  assert.ok(has(plutil, ["-replace", "CFBundleIdentifier", "-string", ID, plist]));
  assert.ok(has(plutil, ["-replace", "CFBundleName", "-string", "zenius Dev Zen", plist]));
  assert.ok(has(plutil, ["-replace", "CFBundleDisplayName", "-string", "zenius Dev Zen", plist]));
  assert.deepEqual(
    plutil.filter(c => c[0] === "-remove").map(c => c[1]),
    ["CFBundleURLTypes", "CFBundleDocumentTypes"],
    "only the keys the app has are removed"
  );
  assert.ok(!existsSync(join(copy, "Contents", "Resources", "en.lproj", "InfoPlist.strings")), "a localized name would stand in for its own");
  assert.ok(existsSync(join(copy, "Contents", "Resources", "en.lproj", "other.strings")));
  assert.ok(!existsSync(join(copy, "Contents", "embedded.provisionprofile")), "Zen's provisioning profile went");

  // codesign refuses Finder information and resource forks, which Zen.app's
  // folder and its Icon\r file carry: both go from those, then from the
  // whole copy, before it signs.
  const xattrs = callsOf("xattr");
  for (const name of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
    for (const args of [["-ds", name, making], ["-ds", name, join(making, "Icon\r")], ["-drs", name, making]]) {
      assert.ok(has(xattrs, args), args.join(" "));
    }
  }
  const order = readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => line.split("\t"));
  const lastStrip = order.findLastIndex(c => c[0] === "xattr" && /^com\.apple\.(FinderInfo|ResourceFork)$/.test(c[2] ?? ""));
  assert.ok(lastStrip >= 0 && lastStrip < order.findIndex(c => c[0] === "codesign"), "they go before codesign signs");

  // Signed ad hoc at the top level only, then checked as a whole.
  assert.deepEqual(callsOf("codesign"), [
    ["--force", "--sign", "-", making],
    ["--verify", "--deep", "--strict", making],
  ]);
  assert.ok(has(callsOf("tmutil"), ["addexclusion", apps]), "Time Machine leaves the copies out");

  // Its own profile folder and remote name; the rest of application.ini as it was.
  const ini = readFileSync(join(copy, "Contents", "Resources", "application.ini"), "utf8");
  assert.equal(ini, "[App]\nVendor=Mozilla\nName=Zen\nRemotingName=zen-dev\nVersion=9.9\nProfile=zen-dev\nBuildID=20990101000000\n\n[Gecko]\nMinVersion=1\n");
  // This checkout's loader, and no update checks beside Zen's own policies.
  const res = join(copy, "Contents", "Resources");
  const vendor = join(ROOT, "runtime", "vendor", "fx-autoconfig", "program");
  assert.equal(readFileSync(join(res, "config.js"), "utf8"), readFileSync(join(vendor, "config.js"), "utf8"));
  assert.equal(
    readFileSync(join(res, "defaults", "pref", "config-prefs.js"), "utf8"),
    readFileSync(join(vendor, "defaults", "pref", "config-prefs.js"), "utf8")
  );
  assert.deepEqual(JSON.parse(readFileSync(join(res, "distribution", "policies.json"), "utf8")), {
    policies: { DisableTelemetry: true, DisableAppUpdate: true },
  });

  assert.ok(existsSync(join(apps, key, "ready")));
  assert.deepEqual(readdirSync(apps), [key], "no half-made copy or lock is left");
  assert.equal(mode(apps), 0o700);
  assert.equal(mode(join(apps, key)), 0o700);
  assert.deepEqual(snapshot(source), before, "Zen.app is as it was");

  resetCalls();
  const again = await zenDev(["--app", "path"]);
  assert.equal(again.stdout, made.stdout);
  assert.deepEqual(callsOf("cp"), [], "the copy is made once per version");
});

test("a dev start on the Mac runs the copy, with macOS's notifications off", async () => {
  makeSource("20990101000000");
  rmSync(ran, { force: true });
  const started = await zenDev(["devapp-check", "start"]);
  // The stand-in exits at once, so start fails, but after running it.
  assert.ok(existsSync(ran), started.stderr);
  assert.match(readFileSync(ran, "utf8").trim(), copyPath);
  const profile = join(dev, "profiles", "devapp-check");
  const prefs = readFileSync(join(profile, "user.js"), "utf8");
  assert.match(prefs, /^user_pref\("alerts\.useSystemBackend", false\);$/m);
  // Downloads go to the profile's own folder, never the user's real one.
  assert.match(prefs, /^user_pref\("browser\.download\.folderList", 2\);$/m);
  assert.ok(prefs.split("\n").includes(`user_pref("browser.download.dir", ${JSON.stringify(join(profile, "downloads"))});`), prefs);
  assert.equal(mode(join(profile, "downloads")), 0o700);
});

test("ZEN_BIN still runs the binary it names, with no copy", async () => {
  makeSource("20990101000000");
  rmSync(apps, { recursive: true, force: true });
  rmSync(ran, { force: true });
  const zen = join(source, "Contents", "MacOS", "zen");
  const started = await zenDev(["devapp-check", "start"], { env: { ZEN_BIN: zen } });
  assert.ok(existsSync(ran), started.stderr);
  assert.equal(readFileSync(ran, "utf8").trim(), zen);
  assert.ok(!existsSync(apps), "no copy was made");
});

test("a new Zen version gets a new copy, and an old one goes once no Zen runs from it", async () => {
  makeSource("20990101000000");
  resetCalls();
  const first = await zenDev(["--app", "path"]);
  assert.equal(first.status, 0, first.stderr);
  const old = dirname(dirname(dirname(dirname(first.stdout.trim()))));

  // A process running from the old copy, as a dev Zen or its content processes do.
  const sleeper = join(old, "zenius-dev-zen.app", "Contents", "MacOS", "sleeper");
  // A process that runs from the copy, as ps shows it: the system's own sleep
  // under that name. macOS kills a copy of /bin/sleep as it starts.
  const child = spawn("sleep", ["60"], { argv0: sleeper, stdio: "ignore" });
  running.add(child);
  for (let i = 0; i < 40 && !execFileSync("ps", ["-axo", "args="], { encoding: "utf8" }).includes(sleeper); i++) {
    await new Promise(r => setTimeout(r, 50));
  }

  makeSource("20990202000000");
  const before = snapshot(source);
  resetCalls();
  const second = await zenDev(["--app", "path"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout.trim(), copyPath);
  assert.ok(second.stdout.includes("/20990202000000-"), second.stdout);
  assert.ok(existsSync(join(old, "ready")), "the copy a Zen runs from stays");
  assert.match(second.stderr, /keeping .* while a Zen runs from it/);

  // Gecko's update folders, which it makes for each install it runs from:
  // the two copies', and the user's Zen's.
  const newKey = second.stdout.trim().match(copyPath)[1];
  const oldUpdates = updateFolder(basename(old));
  const newUpdates = updateFolder(newKey);
  const usersUpdates = join(home, "Library", "Caches", "Mozilla", "updates", "Applications", "Zen");
  for (const dir of [oldUpdates, newUpdates, usersUpdates]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "active-update.xml"), "<updates/>\n");
  }

  child.kill();
  await once(child, "exit");
  running.delete(child);
  resetCalls();
  const third = await zenDev(["--app", "path"]);
  assert.equal(third.stdout, second.stdout);
  assert.ok(!existsSync(old), "the old copy went once nothing ran from it");
  assert.ok(!existsSync(dirname(oldUpdates)), "its update folder went with it");
  assert.ok(existsSync(join(newUpdates, "active-update.xml")), "the copy in use keeps its own");
  assert.ok(existsSync(join(usersUpdates, "active-update.xml")), "the user's Zen's is untouched");
  assert.deepEqual(callsOf("cp"), [], "no new copy");
  if (process.platform !== "darwin") {
    // On the Mac the script uses the system's lsregister, not the stand-in.
    // The copy's record goes, and that of the app inside it.
    const app = join(old, "zenius-dev-zen.app");
    assert.deepEqual(
      callsOf("lsregister").map(c => c.join(" ")).sort(),
      [`-u ${app}`, `-u ${join(app, "Contents", "MacOS", "plugin-container.app")}`].sort()
    );
  }
  assert.deepEqual(snapshot(source), before, "Zen.app is as it was");
});

test("starts at the same moment make one copy between them", async () => {
  makeSource("20990303000000");
  resetCalls();
  const made = await Promise.all([1, 2, 3].map(() => zenDev(["--app", "path"], { env: { STUB_CP_SLEEP: "1" } })));
  for (const r of made) assert.equal(r.status, 0, r.stderr);
  assert.equal(new Set(made.map(r => r.stdout)).size, 1);
  assert.equal(callsOf("cp").length, 1);
});

test("a copy codesign refuses isn't kept, and the start says how to see why", async () => {
  makeSource("20990808000000");
  resetCalls();
  const refused = await zenDev(["--app", "path"], { env: { STUB_CODESIGN_REFUSE: "1" } });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /detritus not allowed/);
  assert.match(refused.stderr, /codesign refused the copy at .*; xattr -lr on it shows what the copy carries/);
  assert.deepEqual(
    readdirSync(apps).filter(name => name.startsWith(".") || name.startsWith("20990808000000-")),
    [],
    "no copy, half-made copy or lock is left"
  );
});

test("a half-made copy stays while its maker runs, and goes once the maker is gone", async () => {
  makeSource("20990909000000");
  mkdirSync(apps, { recursive: true });
  // A maker still copying, one that died, and one from before makers named their folders.
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  running.add(child);
  const ended = spawn("true", [], { stdio: "ignore" });
  await once(ended, "exit");
  const live = join(apps, `.make.${child.pid}.aaaaaa`);
  const dead = join(apps, `.make.${ended.pid}.bbbbbb`);
  const old = join(apps, ".make.cccccc");
  for (const dir of [live, dead, old]) mkdirSync(join(dir, "zenius-dev-zen.app"), { recursive: true });

  resetCalls();
  const made = await zenDev(["--app", "path"]);
  assert.equal(made.status, 0, made.stderr);
  assert.ok(existsSync(live), "a maker that still runs keeps its folder");
  assert.ok(!existsSync(dead) && !existsSync(old), "the others go");

  child.kill();
  await once(child, "exit");
  running.delete(child);
  const removed = await zenDev(["--app", "remove"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(apps), "once its maker is gone, so is its folder");
});

test("a start that finishes after another made the same copy keeps that one, which a Zen may run from", async () => {
  makeSource("20991010000000");
  const first = await zenDev(["--app", "path"]);
  assert.equal(first.status, 0, first.stderr);
  const key = first.stdout.trim().match(copyPath)[1];
  rmSync(join(apps, key), { recursive: true });

  // This start copies slowly, and meanwhile another, as if it had also taken
  // over a dead start's lock, finishes the same version's copy.
  const slow = zenDev(["--app", "path"], { env: { STUB_CP_SLEEP: "1.5" } });
  await (async () => {
    for (let i = 0; i < 100 && !readdirSync(apps).some(name => name.startsWith(".make.")); i++) await new Promise(r => setTimeout(r, 20));
  })();
  mkdirSync(join(apps, key, "zenius-dev-zen.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(apps, key, "ready"), "the other start's\n");
  writeFileSync(join(apps, key, "zenius-dev-zen.app", "marker"), "");
  const done = await slow;
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, first.stdout, "the same copy's path");
  assert.ok(existsSync(join(apps, key, "zenius-dev-zen.app", "marker")), "the copy already made stays as it was");
  assert.deepEqual(readdirSync(apps).filter(name => name.startsWith(".")), [], "its own half goes");
});

test("a Zen.app with a link where the copy is written, or codesign writes, isn't copied into", async () => {
  // Each a link to what it was, moved elsewhere: writes in the copy, or codesign's, would land there.
  for (const at of [["Contents", "Resources"], ["Contents", "_CodeSignature"], ["Contents", "MacOS", "zen"]]) {
    makeSource("20991111000000");
    const elsewhere = join(root, `elsewhere-${at.at(-1)}`);
    rmSync(elsewhere, { recursive: true, force: true });
    execFileSync("mv", [join(source, ...at), elsewhere]);
    execFileSync("ln", ["-s", elsewhere, join(source, ...at)]);
    const before = statSync(elsewhere).isDirectory() ? snapshot(elsewhere) : readFileSync(elsewhere, "utf8");
    resetCalls();
    const refused = await zenDev(["--app", "path"]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.ok(refused.stderr.includes(`${at.join("/")} in `) && refused.stderr.includes("is a link, so a write in the copy could reach what it points to"), refused.stderr);
    assert.deepEqual(statSync(elsewhere).isDirectory() ? snapshot(elsewhere) : readFileSync(elsewhere, "utf8"), before, "nothing it points to changed");
    assert.deepEqual(readdirSync(apps).filter(name => name.startsWith(".") || name.startsWith("20991111000000-")), [], "no copy is left");
    assert.deepEqual(callsOf("codesign"), [], "nothing was signed");
  }
});

test("a copy that takes real space isn't kept", async () => {
  makeSource("20990404000000");
  resetCalls();
  const made = await zenDev(["--app", "path"], { env: { STUB_CP_COST_KB: String(600 * 1024) } });
  assert.equal(made.status, 3, made.stderr);
  assert.match(made.stderr, /took 600 MB, so it isn't an APFS clone/);
  assert.match(made.stderr, /ZEN_BIN/);
  assert.deepEqual(
    readdirSync(apps).filter(n => n.startsWith("20990404000000") || n.startsWith(".")),
    [],
    "no copy, half-made copy or lock is left"
  );
});

test("an application.ini gets its own Profile and RemotingName in [App] wherever that is, and one without [App] isn't copied", async () => {
  makeSource("20990505000000", { ini: "[Gecko]\nMinVersion=1\n\n[App]\nVendor=Mozilla\nName=Zen\nBuildID=20990505000000\n" });
  const made = await zenDev(["--app", "path"]);
  assert.equal(made.status, 0, made.stderr);
  const ini = readFileSync(join(dirname(dirname(made.stdout.trim())), "Resources", "application.ini"), "utf8");
  assert.equal(ini, "[Gecko]\nMinVersion=1\n\n[App]\nVendor=Mozilla\nName=Zen\nBuildID=20990505000000\nProfile=zen-dev\nRemotingName=zen-dev\n");

  makeSource("20990606000000", { ini: "[Gecko]\nBuildID=20990606000000\n" });
  const refused = await zenDev(["--app", "path"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /has no \[App\] section/);
  assert.deepEqual(
    readdirSync(apps).filter(n => n.startsWith("20990606000000") || n.startsWith(".")),
    []
  );
});

test("--app status lists the copies and --app remove removes them, but not one a Zen runs from", async () => {
  makeSource("20990707000000");
  const made = await zenDev(["--app", "path"]);
  assert.equal(made.status, 0, made.stderr);
  const copy = dirname(dirname(dirname(made.stdout.trim())));
  const status = await zenDev(["--app", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.split("\n").includes(`${copy} (this Zen version's)`), status.stdout);

  const sleeper = join(copy, "Contents", "MacOS", "sleeper");
  // A process that runs from the copy, as ps shows it: the system's own sleep
  // under that name. macOS kills a copy of /bin/sleep as it starts.
  const child = spawn("sleep", ["60"], { argv0: sleeper, stdio: "ignore" });
  running.add(child);
  for (let i = 0; i < 40 && !execFileSync("ps", ["-axo", "args="], { encoding: "utf8" }).includes(sleeper); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  const busy = await zenDev(["--app", "remove"]);
  assert.equal(busy.status, 1, busy.stderr);
  assert.ok(existsSync(copy), "a copy a Zen runs from stays");
  assert.match((await zenDev(["--app", "status"])).stdout, /, in use$/m);

  child.kill();
  await once(child, "exit");
  running.delete(child);
  const saved = join(home, "Library", "Saved Application State", `${ID}.savedState`);
  mkdirSync(saved, { recursive: true });
  // The copy's update folder, one a copy removed some other way left, and
  // the user's Zen's.
  const updates = join(home, "Library", "Caches", "Mozilla", "updates");
  const usersUpdates = join(updates, "Applications", "Zen");
  for (const dir of [updateFolder(basename(dirname(copy))), updateFolder("20990101000000-000000000000"), usersUpdates]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "active-update.xml"), "<updates/>\n");
  }
  // The settings' file, which cfprefsd leaves behind after defaults delete.
  const prefs = join(home, "Library", "Preferences", `${ID}.plist`);
  mkdirSync(dirname(prefs), { recursive: true });
  writeFileSync(prefs, "{ }\n");
  resetCalls();
  const removed = await zenDev(["--app", "remove"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(apps), "every copy went");
  assert.ok(!existsSync(prefs), "the settings' empty file went");
  if (process.platform !== "darwin") {
    assert.ok(has(callsOf("lsregister"), ["-u", join(copy, "Contents", "MacOS", "plugin-container.app")]), "the record of the app inside the copy went");
  }
  assert.deepEqual(readdirSync(updates), ["Applications"], "every copy's update folder went, with the folders above it");
  assert.ok(existsSync(join(usersUpdates, "active-update.xml")), "the user's Zen's is untouched");
  assert.ok(has(callsOf("defaults"), ["delete", ID]), "the copy's settings went");
  assert.ok(!existsSync(saved), "its saved windows went");
});

test("--app is the Mac's", async () => {
  const told = await zenDev(["--app", "path"], { tools: linuxTools });
  assert.equal(told.status, 2);
  assert.match(told.stderr, /only the Mac runs a dev copy/);
});
