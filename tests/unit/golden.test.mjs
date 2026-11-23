// Checks the golden snapshot set and the tooling around it. Runs without a browser:
//   node --test tests/unit/
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { closeFixtureServer, listZooPages, startFixtureServer } from "../fixtures/server.mjs";
import { FIXTURE_PAGES, SITE_PAGES } from "../golden/pages.mjs";
import { scrubDom } from "../golden/scrub.mjs";
import { REPO_ROOT } from "../lib/targets.mjs";

const egoDir = join(REPO_ROOT, "tests", "golden", "ego");

test("every golden record points at files in Ego's format", async () => {
  const index = JSON.parse(await readFile(join(egoDir, "index.json"), "utf8"));
  assert.equal(index.target, "ego");
  assert.match(index.version, /^0\.6\.3\.17$/);
  const slugs = new Set(index.pages.map((r) => r.slug));
  for (const page of [...FIXTURE_PAGES, ...SITE_PAGES]) assert.ok(slugs.has(page.slug), `golden for ${page.slug}`);
  for (const record of index.pages) {
    assert.ok(!record.error && !(record.errors?.length), `${record.slug} captured cleanly`);
    for (const scope of ["viewport", "full_page"]) {
      const text = await readFile(join(egoDir, record.files[scope]), "utf8");
      assert.match(text.split("\n")[0], /^\[p\d+ ".*" \| space ".*"\(\d+\): /, `${record.files[scope]} header`);
      assert.equal(text.split("\n")[1], "root", `${record.files[scope]} starts at root`);
      assert.ok(!/127\.0\.0\.1:\d+|localhost:\d+/.test(text), `${record.files[scope]} has normalized fixture URLs`);
    }
    if (record.kind === "site") await stat(join(egoDir, record.dom));
  }
});

test("goldens carry nothing from the user's accounts", async () => {
  const index = JSON.parse(await readFile(join(egoDir, "index.json"), "utf8"));
  for (const record of index.pages) {
    for (const file of Object.values(record.files)) {
      const text = await readFile(join(egoDir, file), "utf8");
      // A capture made from a profile in someone's home would name the folder.
      // The account names themselves aren't in this repo, and no test reads
      // them: a scan before each publish checks for them.
      assert.ok(!/(^|[\s"'(=]|file:\/\/)\/(Users|home)\/(?!u\/)[\w.-]+\//m.test(text), `${file} names a home folder`);
    }
  }
  assert.ok(!index.pages.some((r) => r.slug.includes("reddit")), "reddit (logged in) stays out");
});

test("scrubDom blanks session values and keeps structure", () => {
  const html =
    '<meta name="csrf-token" content="abc"><meta name="description" content="keep">' +
    '<input type="hidden" name="t" value="secret"><input value="v" name="a" type="hidden">' +
    '<input type="text" value="visible"><script nonce="n1"></script>';
  const out = scrubDom(html);
  assert.ok(!out.includes("abc") && !out.includes("secret") && !out.includes("n1"));
  assert.ok(out.includes('content="keep"') && out.includes('value="visible"'));
});

test("fixture server serves zoo pages, cross-site URLs and replays", async () => {
  const { server, baseUrl } = await startFixtureServer("unit");
  try {
    const zoo = await listZooPages();
    assert.ok(zoo.includes("forms.html") && zoo.includes("bench.html"));
    const frames = await (await fetch(`${baseUrl}/zoo/frames.html`)).text();
    assert.ok(frames.includes(baseUrl.replace("127.0.0.1", "localhost")), "{{CROSS}} is substituted");
    const replay = await fetch(`${baseUrl}/golden-replay/site-example.html`);
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /<base href="https:\/\/example\.com\/">/);
    assert.equal((await fetch(`${baseUrl}/golden-replay/..%2Fx`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/zoo/missing.html`)).status, 404);
  } finally {
    await closeFixtureServer(server);
  }
});
