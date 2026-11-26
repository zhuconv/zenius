// scripts/zen-dev.sh's working folder keeps the config file's rule
// (scripts/working-folder.sh), which the runtime holds a dev profile's
// zenius.dev.workingFolder to and the CLI a ZENIUS_WORKING_DIR: absolute,
// with no ".." part, double quote, backslash or control character. After a
// link, a ".." leads to the target's parent for the runtime but drops the
// link's name for the SDK's path.resolve, so the two would name different
// folders. A start or restart refuses such a folder before it stops anything
// or looks for Zen. These tests start no Zen: the runs that pass the check
// stop at a Zen that isn't there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../lib/targets.mjs";

/** zen-dev.sh zzwork <command>, in a zenius home of its own, with a Zen at a path that isn't there. */
function zenDev(dir, command, more) {
  const env = { ...process.env, ZENIUS_HOME: join(dir, "zhome"), ZENIUS_DEV_HOME: join(dir, "dev"), ZEN_BIN: join(dir, "no-zen", "zen"), TMPDIR: dir };
  delete env.ZENIUS_DEV_WORKING_DIR;
  const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "zen-dev.sh"), "zzwork", command], {
    env: { ...env, ...more },
    encoding: "utf8",
    timeout: 60000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('zen-dev.sh refuses to start or restart a dev Zen whose working folder has a ".." part, a double quote, a backslash or a control character, before it looks for Zen, and makes no profile or folder', () => {
  const dir = mkdtempSync(join(tmpdir(), "zt-zw-"));
  try {
    const refused = [
      ['a ".." part', { ZENIUS_DEV_WORKING_DIR: `${dir}/a/../b` }],
      ['a ".." at the end', { ZENIUS_DEV_WORKING_DIR: `${dir}/a/..` }],
      ["a double quote", { ZENIUS_DEV_WORKING_DIR: `${dir}/a"b` }],
      ["a backslash", { ZENIUS_DEV_WORKING_DIR: `${dir}/a\\b` }],
      ["a newline", { ZENIUS_DEV_WORKING_DIR: `${dir}/a\nb` }],
      ['the default, under a TMPDIR with a ".." part', { TMPDIR: `${dir}/t/..` }],
    ];
    for (const [what, env] of refused) {
      for (const command of ["start", "restart"]) {
        const r = zenDev(dir, command, env);
        assert.equal(r.status, 1, `${what}, ${command}: ${r.out}`);
        assert.match(r.out, /zen-dev\.sh: the working folder, .+, has a "\.\." part, a double quote, a backslash or a control character/s, `${what}, ${command}: ${r.out}`);
        assert.doesNotMatch(r.out, /Zen not found/, `refused before it looks for Zen: ${what}, ${command}`);
      }
    }
    const relative = zenDev(dir, "start", { ZENIUS_DEV_WORKING_DIR: "relative/files" });
    assert.equal(relative.status, 1, relative.out);
    assert.match(relative.out, /ZENIUS_DEV_WORKING_DIR must be an absolute path: relative\/files/);
    // zen-dev.sh makes its own dev home's folder first, whatever it's asked.
    assert.deepEqual(readdirSync(dir), ["dev"], "no working folder or zenius home made");
    assert.ok(!existsSync(join(dir, "dev", "profiles", "zzwork")), "no profile made");

    // One that keeps the rule passes, and the start goes on to look for Zen.
    for (const [what, env] of [
      ["a ZENIUS_DEV_WORKING_DIR", { ZENIUS_DEV_WORKING_DIR: join(dir, "files") }],
      ["one with a trailing slash", { ZENIUS_DEV_WORKING_DIR: `${join(dir, "files")}/` }],
      ["the default", {}],
    ]) {
      const r = zenDev(dir, "start", env);
      assert.equal(r.status, 1, `${what}: ${r.out}`);
      assert.match(r.out, /Zen not found at /, `${what}: ${r.out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
