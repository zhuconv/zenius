// test-all stops on a TMPDIR too long for the suites' Unix sockets, before
// it writes anything there, and runs on with one that fits. Each run names
// a suite that doesn't exist, so a test-all that got past the check would
// run nothing, not this suite again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../lib/targets.mjs";

const run = (tmp, env = {}) =>
  spawnSync("bash", [join(REPO_ROOT, "scripts/test-all.sh"), "zz-no-such-suite"], {
    env: { ...process.env, ...env, TMPDIR: tmp },
    encoding: "utf8",
    timeout: 60000,
  });

test("a TMPDIR longer than 40 bytes stops test-all with the reason, and nothing is written there", { skip: platform() !== "linux" && "the check is Linux's: the Mac keeps its own temporary folder" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-guard-"));
  try {
    const long = join(dir, "x".repeat(Math.max(1, 41 - dir.length - 1)));
    mkdirSync(long);
    assert.ok(long.length > 40, `${long} is longer than 40 bytes`);
    const r = run(long);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^test-all: TMPDIR is \d+ bytes long, too long for the tests' Unix sockets \(108 bytes\)\. Use one of at most 40 bytes, or unset it for \/tmp\.$/m);
    assert.deepEqual(readdirSync(long), [], "test-all wrote nothing in the TMPDIR it refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TMPDIR of 40 characters but more bytes is refused too: the socket limit counts bytes, in a UTF-8 locale as well", { skip: platform() !== "linux" && "the check is Linux's" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "zt-guard-"));
  try {
    if (dir.length > 38) {
      t.skip(`${dir} is ${dir.length} bytes: no room for a name of two-byte characters within 40 characters`);
      return;
    }
    // Two bytes a character, up to 40 characters in all, which is past 40 bytes.
    const tmp = join(dir, "\u00e9".repeat(39 - dir.length));
    mkdirSync(tmp);
    assert.ok([...tmp].length <= 40 && Buffer.byteLength(tmp) > 40, `${tmp}: at most 40 characters, more than 40 bytes`);
    const r = run(tmp, { LC_ALL: "C.UTF-8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^test-all: TMPDIR is ${Buffer.byteLength(tmp)} bytes long, `, "m"));
    assert.deepEqual(readdirSync(tmp), [], "test-all wrote nothing in the TMPDIR it refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TMPDIR of 40 bytes or less passes the check", { skip: platform() !== "linux" && "the check is Linux's" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "zt-guard-"));
  try {
    if (dir.length > 40) {
      // Under test-all, tmpdir() is the suite's own folder, 15 bytes below
      // test-all's TMPDIR: this case runs where that is /tmp or as short.
      t.skip(`${dir} is ${dir.length} bytes: the base temporary folder is too long to make one that fits`);
      return;
    }
    const r = run(dir);
    assert.doesNotMatch(r.stderr, /too long for the tests' Unix sockets/);
    assert.ok(existsSync(join(dir, "zenius-test-all")), "test-all went on to make its log folder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
