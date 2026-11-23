// zen-dev.sh never starts a Zen whose install has an update waiting: Zen
// applies it at startup, before it reads a
// profile, and on the Mac the install is the user's own Zen.app, whose switch
// asks for an admin password. No Zen runs here: a stand-in "zen" in a scratch
// install notes that it ran, under a ZENIUS_DEV_HOME of the test's own. The
// fake update goes where zen-dev.sh looks for one: next to the binary, or on
// the Mac under ~/Library/Caches, with HOME the test's own folder there, never
// the user's.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/zen-dev.sh", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "zenius-updates-")));
const app = join(root, "zen-9.9");
const ran = join(app, "ran");
/** zen-dev.sh's HOME in these tests. */
const home = join(root, "home");
mkdirSync(home);
mkdirSync(app);
writeFileSync(join(app, "application.ini"), "[App]\nVendor=Mozilla\nName=Zen\nVersion=9.9\nBuildID=1\n");
writeFileSync(join(app, "zen"), `#!/bin/sh\necho ran >> "${ran}"\nexit 0\n`);
chmodSync(join(app, "zen"), 0o755);
// On the Mac, start looks for fx-autoconfig's config.js in the bundle's
// Resources folder, <app>/../Resources, and never writes one there.
mkdirSync(join(root, "Resources"));
writeFileSync(join(root, "Resources", "config.js"), "");

// The script's own update_root, with the platform given: on the Mac the folder
// is under ~/Library/Caches, named after the app's path.
const updateRoot = readFileSync(script, "utf8").match(/^update_root\(\) \{[\s\S]*?^\}$/m)[0];
function updateRootOn(platform, bin, home) {
  return execFileSync("bash", ["-c", `set -euo pipefail\n${updateRoot}\nupdate_root "$1" "$2"`, "_", platform, bin], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  }).trim();
}

/** This install's update folder, where zen-dev.sh looks on this platform. */
const updates = join(updateRootOn(process.platform === "darwin" ? "Darwin" : "Linux", join(app, "zen"), home), "updates");
assert.ok(updates.startsWith(`${root}/`), `the fake update would go outside the test's folder: ${updates}`);
const ready = join(updates, "0");
mkdirSync(ready, { recursive: true });

after(() => {
  try {
    chmodSync(join(ready, "update.status"), 0o644);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

function zenDev(cmd) {
  return new Promise(resolve => {
    execFile(
      "bash",
      [script, "updates-check", cmd],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          ZEN_BIN: join(app, "zen"),
          ZENIUS_DEV_HOME: join(root, "dev"),
          ZENIUS_HOME: join(root, "zhome"),
          ZENIUS_START_WAIT_S: "5",
          ZENIUS_START_RETRIES: "0",
        },
        timeout: 60000,
      },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

/** update.status as `text` (null: no file), and nothing else in the update folder but update.version. */
function updateState(text, { downloading = false } = {}) {
  rmSync(join(ready, "update.status"), { force: true });
  rmSync(join(updates, "downloading"), { recursive: true, force: true });
  rmSync(ran, { force: true });
  if (text !== null) {
    writeFileSync(join(ready, "update.status"), text);
  }
  writeFileSync(join(ready, "update.version"), "9.10\n");
  if (downloading) {
    mkdirSync(join(updates, "downloading"), { recursive: true });
    writeFileSync(join(updates, "downloading", "update.mar"), "");
  }
}

async function assertRefused(label) {
  const started = await zenDev("start");
  assert.equal(started.status, 3, `${label}: ${started.stderr}`);
  assert.match(started.stderr, /not starting updates-check: an update is waiting/);
  assert.ok(started.stderr.includes(ready), started.stderr);
  assert.ok(!existsSync(ran), `${label}: the stand-in Zen ran`);
  const restarted = await zenDev("restart");
  assert.equal(restarted.status, 3, `${label}: ${restarted.stderr}`);
  assert.ok(!existsSync(ran), `${label}: restart ran the stand-in Zen`);
  const told = await zenDev("updates");
  assert.equal(told.status, 3);
  assert.match(told.stdout, /waiting: .* \(start refuses\)/);
  return started.stderr;
}

test("start and restart refuse while an update is pending, applying, applied or downloading, and say which", async () => {
  for (const state of ["pending", "pending-service", "pending-elevate", "applying", "applied", "applied-service", "downloading"]) {
    updateState(`${state}\n`);
    const said = await assertRefused(state);
    assert.ok(said.includes(`(${state}, version 9.10)`), said);
  }
});

test("a state zen-dev.sh doesn't know counts as waiting", async () => {
  updateState("staged-somehow\n");
  await assertRefused("unknown state");
});

test("a download in progress counts, while update.status still describes no update", async () => {
  updateState(null, { downloading: true });
  const said = await assertRefused("updates/downloading");
  assert.match(said, /\(downloading, version 9\.10\)/);
});

test("an update.status that can't be read counts as waiting", { skip: process.getuid?.() === 0 }, async () => {
  updateState("applied\n");
  chmodSync(join(ready, "update.status"), 0o000);
  try {
    await assertRefused("unreadable");
  } finally {
    chmodSync(join(ready, "update.status"), 0o644);
  }
});

test("with nothing to apply, start goes ahead", async () => {
  for (const state of [null, "", "null\n", "succeeded\n", "download-failed\n", "failed: 7\n"]) {
    updateState(state);
    const told = await zenDev("updates");
    assert.equal(told.status, 0, `${JSON.stringify(state)}: ${told.stdout}`);
    assert.match(told.stdout, /nothing waiting/);
    const started = await zenDev("start");
    // The stand-in exits at once, so start fails, but after running it.
    assert.notEqual(started.status, 3, `${JSON.stringify(state)}: ${started.stderr}`);
    assert.ok(existsSync(ran), `${JSON.stringify(state)}: the stand-in Zen didn't run`);
  }
});

function bundle(at, ini) {
  mkdirSync(join(at, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(at, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(at, "Contents", "MacOS", "zen"), "");
  writeFileSync(join(at, "Contents", "Resources", "application.ini"), ini);
  return join(at, "Contents", "MacOS", "zen");
}

test("on the Mac the update folder is ~/Library/Caches/<Vendor>/updates/<the app's path, without .app>", () => {
  const zen = bundle(join(root, "Applications", "Zen.app"), "[App]\nVendor=Mozilla\nName=Zen\n");
  // /Applications/Zen.app's is .../updates/Applications/Zen (the relay's find on the Mac).
  assert.equal(updateRootOn("Darwin", zen, home), `${home}/Library/Caches/Mozilla/updates/${root.slice(1)}/Applications/Zen`);
  // Through a link, the app's real path.
  const link = join(root, "zen-link");
  symlinkSync(zen, link);
  assert.equal(updateRootOn("Darwin", link, home), `${home}/Library/Caches/Mozilla/updates/${root.slice(1)}/Applications/Zen`);
  // No Vendor: Gecko takes the app's Name.
  const named = bundle(join(root, "Other", "Zen.app"), "[App]\nName=Zen\n");
  assert.equal(updateRootOn("Darwin", named, home), `${home}/Library/Caches/Zen/updates/${root.slice(1)}/Other/Zen`);
  // On Linux it is the install's own folder.
  assert.equal(updateRootOn("Linux", join(app, "zen"), home), app);
});
