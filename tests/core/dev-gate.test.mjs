// The dev.* methods, and every method of I5 class "dev", need a profile of
// the dev launcher's as well as pref zenius.dev (readSettings in
// modules/util.sys.mjs). A user.js line in the user's own profile, which
// anything that can save a file there could write, turns none of them on.
//
// The first test starts a Zen of its own on a daily-like profile: outside
// ~/.zenius-dev/profiles/, with zenius installed by scripts/install.sh as on
// the daily, and zenius.dev set in its user.js. It runs on Linux only: on a
// Mac its Zen would be the user's own Zen.app, started outside zen-dev.sh.
// The second checks the path rule, links included, in this lane's dev Zen.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "../../scripts/lib/rpc.mjs";
import { guardHome } from "../lib/scratch-home.mjs";
import { setup, sleep } from "./lib.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Short, so the socket's path stays within macOS's 104 bytes.
const work = mkdtempSync(join(tmpdir(), "zdg-"));
after(() => rmSync(work, { recursive: true, force: true }));

// Every method the runtime declares of class dev, and every dev.* it defines,
// so one added later is probed too.
const methodsDir = join(root, "runtime/JS/zenius/methods");
const DEV_ONLY = new Set();
for (const file of readdirSync(methodsDir).filter(name => name.endsWith(".sys.mjs"))) {
  const source = readFileSync(join(methodsDir, file), "utf8");
  for (const [, method] of source.matchAll(/^\s*"([a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+)"\s*:\s*"dev"\s*,?\s*$/gm)) {
    DEV_ONLY.add(method);
  }
  for (const [, method] of source.matchAll(/^\s*"(dev\.[A-Za-z0-9]+)"\s*:/gm)) {
    DEV_ONLY.add(method);
  }
}

/** A client on `sock` once the runtime answers there, retried until `deadline`. */
async function connectTo(sock, deadline, alive) {
  for (;;) {
    alive();
    if (existsSync(sock)) {
      const client = new Client(net.createConnection(sock), { callTimeout: 30_000 });
      try {
        await client.ready(10_000);
        return client;
      } catch (error) {
        client.close();
        if (Date.now() > deadline) {
          throw error;
        }
      }
    }
    assert.ok(Date.now() < deadline, `no zenius at ${sock} in time`);
    await sleep(100);
  }
}

/** Stops a Zen this file started: SIGTERM, then SIGKILL after 15 s. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise(resolve => child.once("exit", () => resolve("exited")));
  child.kill("SIGTERM");
  if ((await Promise.race([exited, sleep(15_000).then(() => "late")])) === "late") {
    child.kill("SIGKILL");
    await exited;
  }
}

test(
  "a daily-like profile whose user.js sets zenius.dev gets no dev methods",
  { skip: process.platform !== "linux" && "Linux only: on a Mac its Zen would be the user's own Zen.app, started outside zen-dev.sh" },
  async () => {
    assert.ok(DEV_ONLY.has("dev.evalChrome") && DEV_ONLY.has("dev.answerClaim"), `found ${[...DEV_ONLY].join(", ")}`);
    const lane = process.env.ZENIUS_INSTANCE;
    assert.ok(lane, "ZENIUS_INSTANCE is not set; run tests/core/run.sh");
    // zen-dev.sh's check that no update waits for this Zen install, which any
    // Zen started from it would first try to apply. It exits 3 if one does.
    execFileSync(join(root, "scripts/zen-dev.sh"), [lane, "updates"], { encoding: "utf8" });

    const zen = process.env.ZEN_BIN ?? join(homedir(), "opt/zen-1.24.2b/zen");
    const profile = join(work, "daily");
    const zhome = join(work, "z");
    const instance = `dg${process.pid}`;
    mkdirSync(profile);
    // A HOME and zenius home of the test's own: the installer never reads or
    // writes the user's ~/.zenius/config.json.
    const home = join(work, "home");
    mkdirSync(home, { mode: 0o700 });
    execFileSync(join(root, "scripts/install.sh"), ["--profile", profile, "--loader", "--working-dir", join(work, "files")], {
      env: guardHome({ ...process.env, HOME: home, ZENIUS_HOME: zhome }, "dev-gate's install.sh"),
      encoding: "utf8",
    });
    // The prefs zen-dev.sh gives every dev Zen (no update downloads, no
    // first-run screens, no agent started from the sidebar), taken from this
    // lane's own profile under a name of its own. zenius.dev stays true.
    const laneProfile = join(process.env.ZENIUS_DEV_HOME ?? join(homedir(), ".zenius-dev"), "profiles", lane);
    const prefs = readFileSync(join(laneProfile, "user.js"), "utf8");
    assert.match(prefs, /^user_pref\("zenius\.dev", true\);$/m);
    assert.match(prefs, /^user_pref\("zenius\.instance", /m);
    writeFileSync(join(profile, "user.js"), prefs.replace(/^user_pref\("zenius\.instance", .*$/m, `user_pref("zenius.instance", "${instance}");`));

    const logFile = join(work, "zen.log");
    const log = openSync(logFile, "w");
    // A temporary folder of its own, as zen-dev.sh gives every dev Zen on
    // Linux: a download this Zen starts, such as the intermediate
    // certificates' bundle, would outlive it in /tmp if the test stops it
    // first.
    const zenTmp = join(work, "zen-tmp");
    mkdirSync(zenTmp, { mode: 0o700 });
    const child = spawn(zen, ["--profile", profile, "--no-remote", "--headless"], {
      env: { ...process.env, TMPDIR: zenTmp, MOZ_HEADLESS: "1", MOZ_CRASHREPORTER_DISABLE: "1", ZENIUS_HOME: zhome },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const tail = () => readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n");
    let client;
    try {
      const alive = () => assert.ok(child.exitCode === null && child.signalCode === null, `Zen exited before zenius answered:\n${tail()}`);
      client = await connectTo(join(zhome, "run", `${instance}.sock`), Date.now() + 120_000, alive).catch(error => {
        throw new Error(`${error.message}\n${tail()}`);
      });
      assert.ok((await client.call("browser.version")).runtimeVersion, "zenius runs in that profile");
      const { methods } = await client.call("browser.methods");
      assert.ok(methods.includes("spaces.list"), methods.join(", "));
      assert.deepEqual(
        methods.filter(method => method.startsWith("dev.") || DEV_ONLY.has(method)),
        [],
        "methods only a dev profile may have"
      );
      for (const method of [...DEV_ONLY, "dev.anything"]) {
        await assert.rejects(client.call(method, { code: "return Services.appinfo.name" }), { code: "ZEN_UNSUPPORTED" }, method);
      }
    } finally {
      client?.close();
      await stop(child);
    }
  }
);

test("a dev profile is one whose real path is under the real ~/.zenius-dev/profiles/", async () => {
  const home = join(work, "home");
  const dev = join(home, ".zenius-dev");
  const profiles = join(dev, "profiles");
  const elsewhere = join(work, "elsewhere");
  for (const dir of [join(profiles, "p"), join(dev, "profiles-x", "p"), join(dev, "outside"), join(elsewhere, "daily")]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync(join(elsewhere, "daily"), join(profiles, "link-out"));
  symlinkSync(join(profiles, "p"), join(elsewhere, "link-in"));
  // A home whose ~/.zenius-dev is itself a link, as to a folder on another disk.
  const linkedHome = join(work, "home2");
  const disk = join(work, "disk", "zenius-dev");
  mkdirSync(join(disk, "profiles", "q"), { recursive: true });
  mkdirSync(linkedHome);
  symlinkSync(disk, join(linkedHome, ".zenius-dev"));
  /** [profile, home, whether it's a dev profile] */
  const cases = [
    [join(profiles, "p"), home, true],
    // A link to a dev profile.
    [join(elsewhere, "link-in"), home, true],
    [join(linkedHome, ".zenius-dev", "profiles", "q"), linkedHome, true],
    [join(disk, "profiles", "q"), linkedHome, true],
    // The folder itself.
    [profiles, home, false],
    // A folder whose name only starts the same.
    [join(dev, "profiles-x", "p"), home, false],
    // Out of it by "..": join() would take that out, so the string keeps it.
    [`${profiles}/../outside`, home, false],
    // A link in it to a profile elsewhere, such as the user's own.
    [join(profiles, "link-out"), home, false],
    [join(elsewhere, "daily"), home, false],
    [join(profiles, "missing"), home, false],
    ["profiles/p", home, false],
    // A home without ~/.zenius-dev.
    [join(profiles, "p"), join(work, "nobody"), false],
  ];
  const h = await setup();
  try {
    const got = await h.chrome(
      `const { devProfile } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/util.sys.mjs");
       return arg.map(([profile, home]) => devProfile(profile, home));`,
      cases.map(([profile, home]) => [profile, home])
    );
    assert.deepEqual(
      cases.map(([profile], i) => [profile, got[i]]),
      cases.map(([profile, , want]) => [profile, want])
    );
    // This lane's own Zen, from zen-dev.sh, is a dev profile by the same rule.
    assert.equal(
      await h.chrome(
        `const U = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/util.sys.mjs");
         return U.devProfile() && U.devMode();`
      ),
      true
    );
  } finally {
    await h.close();
  }
});
