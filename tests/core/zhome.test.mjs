// zenius's own folder (~/.zenius, or ZENIUS_HOME) follows no link planted in
// it (zen-snapshot's sweep, docs/reports/zen-snapshot.md, 2026-11-21 09:55
// CST). A link in place of one of its folders, or at a record's temporary
// name, would otherwise steer its socket, its records and their modes into a
// place of the planter's choosing. The folders above its home may be links:
// macOS's /tmp is one, and so may the user's home be.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const UTIL = "chrome://userscripts/content/zenius/modules/util.sys.mjs";

let h;
let dir;
before(async () => {
  h = await setup();
  dir = mkdtempSync(join(tmpdir(), "zenius-zhome-"));
});
after(() => {
  h?.close();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `body` in the browser with util.sys.mjs as U; returns its value, or the message it throws. */
const inZen = (body, arg) =>
  h.chrome(`const U = ChromeUtils.importESModule("${UTIL}"); try { return await (async () => { ${body} })(); } catch (e) { return "threw: " + e.message; }`, arg);

/** A home folder of zenius's and a folder elsewhere with mode 755. */
function homeAndElsewhere(name) {
  const home = join(dir, `${name}-home`);
  const elsewhere = join(dir, `${name}-elsewhere`);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(elsewhere);
  chmodSync(elsewhere, 0o755);
  return { home, elsewhere };
}

test("a link in place of a folder above the one it makes is refused, and nothing lands where it points", async () => {
  const { home, elsewhere } = homeAndElsewhere("parent");
  symlinkSync(elsewhere, join(home, "run"));
  const r = await inZen("await U.ensurePrivateDir(arg.path, arg.home); return 'made';", { path: join(home, "run", "instances"), home });
  assert.match(String(r), /^threw: .*is a link/);
  assert.equal(existsSync(join(elsewhere, "instances")), false);
  assert.equal(statSync(elsewhere).mode & 0o777, 0o755);
});

test("a link in place of the folder itself is refused, and its target keeps its mode", async () => {
  const { home, elsewhere } = homeAndElsewhere("self");
  symlinkSync(elsewhere, join(home, "state"));
  const r = await inZen("await U.ensurePrivateDir(arg.path, arg.home); return 'made';", { path: join(home, "state"), home });
  assert.match(String(r), /^threw: .*is a link/);
  assert.equal(statSync(elsewhere).mode & 0o777, 0o755);
});

test("its folders are made, private, when no link is in the way, and a home reached through a link is fine", async () => {
  const real = join(dir, "real-home");
  mkdirSync(real, { mode: 0o700 });
  const home = join(dir, "linked-home");
  symlinkSync(real, home);
  const r = await inZen("await U.ensurePrivateDir(arg.path, arg.home); return 'made';", { path: join(home, "run", "instances"), home });
  assert.equal(r, "made");
  assert.equal(statSync(join(real, "run", "instances")).mode & 0o777, 0o700);
});

test("a record is written neither through a link at a temporary name nor into a link at its own", async () => {
  const { home } = homeAndElsewhere("record");
  const record = join(home, "default.json");
  const theirs = join(dir, "record-theirs");
  writeFileSync(theirs, "theirs");
  chmodSync(theirs, 0o644);
  // The name the registry was written through before, and the record itself.
  symlinkSync(theirs, `${record}.tmp`);
  const alsoTheirs = join(dir, "record-also-theirs");
  writeFileSync(alsoTheirs, "also theirs");
  chmodSync(alsoTheirs, 0o644);
  const swapped = join(home, "swapped.json");
  symlinkSync(alsoTheirs, swapped);
  const r = await inZen("await U.writePrivateJSON(arg.record, { a: 1 }); await U.writePrivateJSON(arg.swapped, { b: 2 }); return 'written';", { record, swapped });
  assert.equal(r, "written");
  assert.equal(readFileSync(theirs, "utf8"), "theirs");
  assert.equal(statSync(theirs).mode & 0o777, 0o644);
  assert.equal(readFileSync(alsoTheirs, "utf8"), "also theirs");
  assert.equal(statSync(alsoTheirs).mode & 0o777, 0o644);
  for (const [path, value] of [[record, { a: 1 }], [swapped, { b: 2 }]]) {
    assert.ok(lstatSync(path).isFile(), `${path} is a file of its own`);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value);
  }
});
