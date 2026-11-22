// tests/live/round.mjs: the order of each task's two runs, and the round's table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TASKS, markdown, orderOf } from "../live/round.mjs";

test("orderOf: round 1 starts with Ego on odd tasks and zenius on even ones; round 2 swaps", () => {
  assert.deepEqual(orderOf("T1", 1), ["ego", "zenius"]);
  assert.deepEqual(orderOf("T2", 1), ["zenius", "ego"]);
  assert.deepEqual(orderOf("T15", 1), ["ego", "zenius"]);
  assert.deepEqual(orderOf("T1", 2), ["zenius", "ego"]);
  assert.deepEqual(orderOf("T14", 2), ["ego", "zenius"]);
  // Each target goes first on about half the tasks in each round.
  const firsts = ALL_TASKS.map((t) => orderOf(t, 1)[0]);
  assert.equal(firsts.filter((f) => f === "ego").length, 8);
  assert.equal(firsts.filter((f) => f === "zenius").length, 7);
});

test("markdown: each run's row, then each target pooled", () => {
  const run = (task, target, order, success, turns, wallMs, costUsd) => ({
    task,
    target,
    order,
    success,
    rubricAverage: success ? 1 : 0.5,
    items: [{ id: "a", pass: true }, { id: "b", pass: success ? true : false }],
    turns,
    wallMs,
    costUsd,
    usage: { input_tokens: 1000, output_tokens: 500 },
    permissionDenials: [],
    safety: [],
    leftoverSpaces: [],
    wiring: { pass: true },
  });
  const text = markdown({
    round: 1,
    commit: "abc1234",
    dirty: [],
    started: "2026-11-21T18:00:00.000Z",
    waits: [{ task: "T2", target: "zenius", waitedS: 60, reasons: ["screen-locked"] }],
    runs: [run("T1", "ego", 1, true, 10, 100_000, 1), run("T1", "zenius", 2, false, 20, 200_000, 2)],
  });
  assert.match(text, /^Round 1 at abc1234, started 2026-11-21T18:00:00.000Z\./);
  assert.match(text, /\| T1 \| ego \| 1 \| yes \| a ✓, b ✓ \| 10 \| 100 s \| \$1\.00 \| 1\.0k\/0\.5k \| 0 \| 0 \| 0 \| ok \|/);
  assert.match(text, /\| T1 \| zenius \| 2 \| no \| a ✓, b ✗ \|/);
  assert.match(text, /\| ego \| 1 \| 1\/1 \| 100\.0% \| 10\.0 \| 100 s \| \$1\.00 \|/);
  assert.match(text, /\| zenius \| 1 \| 0\/1 \| 50\.0% \| 20\.0 \| 200 s \| \$2\.00 \|/);
  assert.match(text, /Waits before runs: T2\/zenius 60 s \(screen-locked\)\./);
});

test("siteState: HTTP 5xx or no answer is down; a refusal such as 403 is up", async () => {
  const { siteState } = await import("../live/round.mjs");
  const answering = (status) => async () => ({ status });
  assert.deepEqual(await siteState(["www.gutenberg.org"], answering(503)), { down: true, site: "www.gutenberg.org", status: "HTTP 503" });
  assert.deepEqual(await siteState(["a.example", "b.example"], answering(200)), { down: false });
  assert.deepEqual(await siteState(["a.example"], answering(403)), { down: false });
  const failing = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  assert.deepEqual(await siteState(["gone.example"], failing), { down: true, site: "gone.example", status: "ENOTFOUND" });
  const seen = [];
  await siteState(["x.example"], async (url, init) => (seen.push([url, init.method ?? "GET", Boolean(init.signal)]), { status: 200 }));
  assert.deepEqual(seen, [["https://x.example/", "GET", true]]);
});

test("markdown: a site that was down shows apart, outside the pooled numbers", () => {
  const text = markdown({ round: 1, commit: "abc1234", dirty: [], started: "s", waits: [], siteDown: [{ task: "T9", site: "www.gutenberg.org", status: "HTTP 503", at: "2026-11-21T18:40:00.000Z" }], runs: [] });
  assert.match(text, /Site down, not run \(they wait for the next round\): T9 \(www\.gutenberg\.org, HTTP 503 at 2026-11-21T18:40:00\.000Z\)\./);
});

test("keyPending: fixed items need a recorded key; live and trajectory items don't", async () => {
  const { keyPending } = await import("../live/round.mjs");
  const { TASKS } = await import("../live/tasks.mjs");
  assert.equal(keyPending(TASKS.T9, { pending: "the site is down" }), true);
  assert.equal(keyPending(TASKS.T9, undefined), true);
  assert.equal(keyPending(TASKS.T9, { bytes: "1", title_line: "x" }), false);
  const liveOnly = { rubric: [{ id: "a", type: "live" }, { id: "b", type: "trajectory" }] };
  assert.equal(keyPending(liveOnly, undefined), false);
});

test("recordPendingKey: runs the recorder with the task, keys file and checkout, then reloads the keys in place", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { recordPendingKey, keyPending } = await import("../live/round.mjs");
  const dir = mkdtempSync(join(tmpdir(), "record-key-"));
  try {
    const keysFile = join(dir, "keys.json");
    writeFileSync(keysFile, JSON.stringify({ T1: { en_length: "1230" }, T9: { pending: "site down" } }));
    const keyData = JSON.parse(readFileSync(keysFile, "utf8"));
    const task = { rubric: [{ id: "size", type: "fixed" }] };
    const good = join(dir, "good.sh");
    // Writes what it was given into the key, so the test sees the arguments too.
    writeFileSync(good, `#!/bin/sh\nprintf '{"T1": {"en_length": "1230"}, "T9": {"bytes": "1", "title_line": "%s %s"}}' "$1" "$3" > "$2"\n`);
    chmodSync(good, 0o755);
    const ok = recordPendingKey({ taskId: "T9", recorder: good, keysFile, root: "/checkout", keyData });
    assert.equal(ok.exit, 0);
    assert.equal(ok.task, "T9");
    assert.deepEqual(keyData.T9, { bytes: "1", title_line: "T9 /checkout" });
    assert.equal(keyPending(task, keyData.T9), false);

    writeFileSync(keysFile, JSON.stringify({ T9: { pending: "site down" } }));
    const bad = join(dir, "bad.sh");
    writeFileSync(bad, "#!/bin/sh\nexit 3\n");
    chmodSync(bad, 0o755);
    const failed = recordPendingKey({ taskId: "T9", recorder: bad, keysFile, root: "/checkout", keyData });
    assert.equal(failed.exit, 3);
    assert.deepEqual(Object.keys(keyData), ["T9"], "keys gone from the file are gone from keyData");
    assert.equal(keyPending(task, keyData.T9), true);

    assert.equal(recordPendingKey({ taskId: "T9", recorder: join(dir, "missing.sh"), keysFile, root: "/checkout", keyData }).exit, "ENOENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markdown: keys recorded during the round show apart", () => {
  const out = markdown({ round: 2, commit: "abc1234", dirty: [], started: "2026-11-21T23:30:00Z", runs: [], waits: [], siteDown: [], keysRecorded: [{ task: "T9", at: "2026-11-22T02:10:00Z", exit: 0 }] });
  assert.match(out, /Keys recorded during the round, when their site came back: T9 at 2026-11-22T02:10:00Z \(recorder exit 0\)\./);
});
