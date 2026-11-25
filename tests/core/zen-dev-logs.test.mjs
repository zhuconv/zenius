// zen-dev.sh keeps each start's log: the core suite restarts Zen between
// tests, and a failing test's lines must outlive the starts after it. The
// instance's log holds its latest start only, as the suites read it; the ones
// before are in logs/<name>/, named by when each start began. No Zen runs: a
// stand-in "zen" in a scratch install, under a ZENIUS_DEV_HOME and HOME of
// the test's own, prints a line it's given and the runtime's ready line, then
// waits.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { after, test } from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repo, "scripts/zen-dev.sh");
const root = realpathSync(mkdtempSync(join(tmpdir(), "zdl-")));
const app = join(root, "zen-9.9");
const home = join(root, "home");
const logs = join(root, "dev", "logs");
mkdirSync(home);
mkdirSync(app);
writeFileSync(join(app, "application.ini"), "[App]\nVendor=Mozilla\nName=Zen\nVersion=9.9\nBuildID=1\n");
// On the Mac, start looks for fx-autoconfig's config.js in the bundle's
// Resources folder, <app>/../Resources.
mkdirSync(join(root, "Resources"));
writeFileSync(join(root, "Resources", "config.js"), "");
// A shell that stays itself (no exec): its command line names the profile,
// which is how zen-dev.sh knows it may stop it. Its second argument is the
// profile, whose folder is the instance's name.
writeFileSync(
  join(app, "zen"),
  `#!/bin/sh\necho "$STAND_IN_LINE"\necho "[zenius] window loaded, instance=$(basename "$2")"\nwhile :; do sleep 1; done\n`
);
chmodSync(join(app, "zen"), 0o755);

const started = new Set();
after(async () => {
  for (const name of started) await zenDev(name, "stop");
  rmSync(root, { recursive: true, force: true });
});

function zenDev(name, cmd, env = {}) {
  const base = { ...process.env };
  delete base.ZENIUS_KEEP_LOGS;
  if (cmd === "start") started.add(name);
  return new Promise(resolve => {
    execFile(
      "bash",
      [script, name, cmd],
      {
        encoding: "utf8",
        env: {
          ...base,
          HOME: home,
          ZEN_BIN: join(app, "zen"),
          ZENIUS_DEV_HOME: join(root, "dev"),
          ZENIUS_HOME: join(root, "zhome"),
          ZENIUS_DEV_WORKING_DIR: join(root, `work-${name}`),
          ZENIUS_START_WAIT_S: "20",
          ...env,
        },
        timeout: 120000,
      },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

/** One start and stop of `name`, its stand-in printing `line`. */
async function run(name, line, env = {}) {
  const r = await zenDev(name, "start", { STAND_IN_LINE: line, ...env });
  assert.equal(r.status, 0, r.stderr);
  const s = await zenDev(name, "stop");
  assert.equal(s.status, 0, s.stderr);
}

const current = name => readFileSync(join(logs, `${name}.log`), "utf8");
const keptNames = name => (existsSync(join(logs, name)) ? readdirSync(join(logs, name)).sort() : []);
/** A kept log's text, gzipped or not. */
function kept(name, file) {
  const bytes = readFileSync(join(logs, name, file));
  return (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
}
/** The start line's time as kept files are named: 2026-11-25T02:40:01Z becomes 20261125T024001Z. */
function stampOf(log) {
  const at = /^\[zen-dev\] started at (\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z: /.exec(log);
  assert.ok(at, `no start line: ${JSON.stringify(log.slice(0, 120))}`);
  return `${at[1]}${at[2]}${at[3]}T${at[4]}${at[5]}${at[6]}Z`;
}
const daysAgo = (path, days) => {
  const when = new Date(Date.now() - days * 86400000);
  utimesSync(path, when, when);
};

test("each start's log is kept, named by when that start began, and the ones before the last are gzipped", async () => {
  await run("keep-check", "first start's line");
  const first = current("keep-check");
  assert.match(first, /^\[zen-dev\] started at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: keep-check, headless\n/);
  assert.match(first, /first start's line/);
  assert.deepEqual(keptNames("keep-check"), [], "a first start has nothing to keep");

  await run("keep-check", "second start's line");
  const second = current("keep-check");
  assert.match(second, /second start's line/);
  assert.doesNotMatch(second, /first start's line/, "the instance's log holds its latest start only");
  assert.deepEqual(keptNames("keep-check"), [`${stampOf(first)}.log`]);
  assert.equal(kept("keep-check", `${stampOf(first)}.log`), first);

  await run("keep-check", "third start's line");
  const names = keptNames("keep-check");
  const newer = `${stampOf(second)}${stampOf(second) === stampOf(first) ? "-2" : ""}.log`;
  assert.deepEqual(names, [`${stampOf(first)}.log.gz`, newer].sort(), "the last start's log stays plain, the ones before are gzipped");
  assert.equal(kept("keep-check", `${stampOf(first)}.log.gz`), first);
  assert.equal(kept("keep-check", newer), second);
  assert.match(current("keep-check"), /third start's line/);
});

test("two starts that began in one second keep both logs, and a log without a start line is named by when it was kept", async () => {
  // The last start's log names a second that already has a kept log.
  mkdirSync(join(logs, "same-second"), { recursive: true });
  writeFileSync(join(logs, "same-second", "20260102T030405Z.log"), "the earlier start's lines\n");
  const last = "[zen-dev] started at 2026-01-02T03:04:05Z: same-second, headless\nthe later start's lines\n";
  writeFileSync(join(logs, "same-second.log"), last);
  await run("same-second", "a new start's line");
  assert.deepEqual(keptNames("same-second"), ["20260102T030405Z-2.log", "20260102T030405Z.log.gz"]);
  assert.equal(kept("same-second", "20260102T030405Z-2.log"), last);
  assert.equal(kept("same-second", "20260102T030405Z.log.gz"), "the earlier start's lines\n");

  // A log from before start lines, or one that lost its first line.
  writeFileSync(join(logs, "no-start-line.log"), "lines from a start with no start line\n");
  const before = new Date(Math.floor(Date.now() / 1000) * 1000);
  await run("no-start-line", "a new start's line");
  const after = new Date();
  const [file, ...more] = keptNames("no-start-line");
  assert.deepEqual(more, []);
  const at = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.log$/.exec(file);
  assert.ok(at, file);
  const when = Date.UTC(at[1], at[2] - 1, at[3], at[4], at[5], at[6]);
  assert.ok(when >= before.getTime() && when <= after.getTime(), `${file} is named by when it was kept, between ${before.toISOString()} and ${after.toISOString()}`);
  assert.equal(kept("no-start-line", file), "lines from a start with no start line\n");
});

test("an instance keeps its newest ZENIUS_KEEP_LOGS, and no instance's kept log outlives 3 days", async () => {
  for (const n of [1, 2, 3, 4]) await run("keep-two", `start ${n}'s line`, { ZENIUS_KEEP_LOGS: "02" });
  const names = keptNames("keep-two");
  assert.equal(names.length, 2, names.join(", "));
  const texts = names.map(file => kept("keep-two", file)).join("");
  assert.match(texts, /start 2's line/);
  assert.match(texts, /start 3's line/);
  assert.doesNotMatch(texts, /start 1's line/, "the oldest went");

  // Another instance's, which no start names any more: its logs past 3
  // days go, a recent one stays, and its folder stays while it holds one.
  const gone = join(logs, "removed-checkout");
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, "20260101T000000Z.log.gz"), "");
  writeFileSync(join(gone, "20260101T000001Z.log"), "");
  writeFileSync(join(gone, "20260104T000000Z.log"), "");
  daysAgo(join(gone, "20260101T000000Z.log.gz"), 4);
  daysAgo(join(gone, "20260101T000001Z.log"), 3.1);
  daysAgo(join(gone, "20260104T000000Z.log"), 2.9);
  // An empty folder that old goes; one another start may just have made stays.
  mkdirSync(join(logs, "emptied-long-ago"));
  daysAgo(join(logs, "emptied-long-ago"), 4);
  mkdirSync(join(logs, "just-made"));
  // Logs beside the folders are no kept start's: they stay, however old.
  writeFileSync(join(logs, "old-instance.log"), "");
  daysAgo(join(logs, "old-instance.log"), 30);
  // A first start, with no log of its own to keep, sweeps too.
  await run("expire-check", "a first start's line");
  assert.deepEqual(readdirSync(gone).sort(), ["20260104T000000Z.log"]);
  assert.equal(existsSync(join(logs, "emptied-long-ago")), false);
  assert.equal(existsSync(join(logs, "just-made")), true);
  assert.equal(existsSync(join(logs, "old-instance.log")), true);
  assert.equal(keptNames("keep-two").length, 2, "recent kept logs stay");
});
