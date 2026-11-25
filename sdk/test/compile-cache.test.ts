// Node's compile cache (sdk/bin/zenius): in a folder of this account's own
// in the temporary folder, zenius-compile-cache-<uid>, not Node's default
// there, which any account on Linux could make first, and only in a 0700
// folder of this account's that isn't a link. Nothing goes in ZENIUS_HOME,
// which outlives an uninstall: the cache holds the text of the scripts the
// CLI runs. A folder of another account's fails the same owner check, which
// a test can't stage without root.

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

import { guardHome } from "../../tests/lib/scratch-home.mjs";
import { CLI } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "zcc-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const FOLDER = `zenius-compile-cache-${process.getuid?.()}`;

let cases = 0;
/** A ZENIUS_HOME that doesn't exist yet, and an empty temporary folder. */
function place(): { home: string; tmp: string } {
  const dir = join(scratch, String(++cases));
  mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
  return { home: join(dir, "zhome"), tmp: join(dir, "tmp") };
}

/** `zenius --version` with Node's two settings unset unless `env` sets them: Node takes NODE_DISABLE_COMPILE_CACHE even when it's empty. */
function version(home: string, tmp: string, env: Record<string, string> = {}): void {
  const { NODE_COMPILE_CACHE: _cache, NODE_DISABLE_COMPILE_CACHE: _off, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [CLI, "--version"], {
    env: guardHome({ ...inherited, ZENIUS_HOME: home, TMPDIR: tmp, ...env }, "compile-cache.test"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

describe("the CLI's compile cache", () => {
  it("is zenius-compile-cache-<uid> in the temporary folder, made 0700, and nothing goes in ZENIUS_HOME", () => {
    const { home, tmp } = place();
    version(home, tmp);
    const cache = join(tmp, FOLDER);
    assert.equal(lstatSync(cache).mode & 0o777, 0o700);
    assert.ok(readdirSync(cache).length > 0, "Node wrote its cache there");
    assert.deepEqual(readdirSync(tmp), [FOLDER]);
    assert.equal(existsSync(home), false);
  });

  it("isn't used when its folder is open to others, or a link", () => {
    const open = place();
    mkdirSync(join(open.tmp, FOLDER));
    chmodSync(join(open.tmp, FOLDER), 0o755);
    version(open.home, open.tmp);
    assert.deepEqual(readdirSync(join(open.tmp, FOLDER)), []);
    assert.equal(lstatSync(join(open.tmp, FOLDER)).mode & 0o777, 0o755, "left as it was");

    const linked = place();
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(linked.tmp, FOLDER));
    version(linked.home, linked.tmp);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.ok(lstatSync(join(linked.tmp, FOLDER)).isSymbolicLink(), "left as it was");
  });

  it("keeps Node's own settings: NODE_DISABLE_COMPILE_CACHE (the sandboxed launcher's) makes no folder, and NODE_COMPILE_CACHE is used as it is", () => {
    const off = place();
    version(off.home, off.tmp, { NODE_DISABLE_COMPILE_CACHE: "1" });
    assert.deepEqual(readdirSync(off.tmp), []);

    const named = place();
    const chosen = join(named.tmp, "chosen");
    version(named.home, named.tmp, { NODE_COMPILE_CACHE: chosen });
    assert.deepEqual(readdirSync(named.tmp), ["chosen"]);
    assert.ok(readdirSync(chosen).length > 0, "Node wrote its cache in the folder named");
  });
});
