// The escape suite (SPEC §3.9 I5). The browser runs with the user's full
// rights, outside any sandbox around the agent's CLI, so nothing an agent's
// script does through zenius may reach past the web: no forbidden scheme
// loads, no agent method acts in a privileged document, and the runtime never
// opens a path an agent names, nor accepts a certificate warning's risk.
// Each probe tries one way out and must fail with
// a clear error; the first test shows that ordinary agent work still works.
//
// The probes are zen-eval's from the Mac (docs/eval/live-pilot.md), with the
// profile seeded as there: a saved login and a cookie. Each test runs all its
// probes and then lists every one that got through, so a run shows the whole
// picture. tests/security/run.sh runs this on a fresh headless dev instance,
// where "the user" acts through the dev channel, then dev-off.test.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startHttpsFixture } from "../input/https-fixture.mjs";
import * as S from "./lib.mjs";

const planted = S.plant();
/** Where probes ask the runtime to write: it must stay empty. */
const untouched = join(planted.dir, "untouched");
/** Where the CLI writes for the controls. */
const saved = join(planted.dir, "saved");
mkdirSync(untouched);
mkdirSync(saved);

let fx;
let FORBIDDEN;
let DISGUISED;
/** The forbidden documents that load when the user opens them, and a linkable about: page. */
let PRIVILEGED;
/** What /openers links to and opens, by index. */
let OPENED;

before(async () => {
  fx = await S.startFixtures();
  await S.seedSecrets();
  const extension = await S.liveExtension();
  FORBIDDEN = S.forbiddenUrls(planted, fx.base, extension);
  DISGUISED = S.disguisedUrls(planted);
  const robots = { scheme: "about:", url: "about:robots" };
  PRIVILEGED = [
    ...FORBIDDEN.filter(({ scheme }) => scheme !== "javascript:" && (scheme !== "moz-extension:" || extension)),
    robots,
  ];
  OPENED = [...FORBIDDEN, robots];
  fx.setOpeners(OPENED.map(({ url }) => url));
});

after(async () => {
  await fx?.close();
  planted.cleanup();
});

const word = (scheme) => scheme.replace(/:$/, "").toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isWebUrl = (url) => url === "" || /^(https?:|data:|blob:|about:blank([?#]|$))/i.test(url);
const shown = (value) => JSON.stringify(value)?.slice(0, 300);

/**
 * Collects what got through, so one run reports every probe: check() records
 * a failed assertion, and done() fails the test with the whole list.
 */
function findings() {
  const found = [];
  return {
    check(what, fn) {
      try {
        fn();
      } catch (error) {
        found.push(`${what}: ${String(error?.message ?? error).split("\n")[0]}`);
      }
    },
    async probe(what, fn) {
      try {
        return await fn();
      } catch (error) {
        found.push(`${what}: ${String(error?.message ?? error).split("\n").slice(0, 2).join(" ")}`);
        return undefined;
      }
    },
    done() {
      if (found.length) assert.fail(`${found.length} got through:\n- ${found.join("\n- ")}`);
    },
  };
}

/**
 * A load the runtime refuses: ZEN_URL_NOT_ALLOWED, naming the scheme. A bare
 * path, which URL fixup would turn into file:, may instead be refused as no
 * URL at all, as Ego refuses it.
 */
function assertLoadRefused(result, { scheme, url }) {
  assert.equal(result?.ok, false, `opened, returning ${shown(result?.value)}`);
  const bare = !/^\s*[a-z][a-z0-9+.-]*:/i.test(url);
  if (bare && /invalid URL/i.test(result.message)) return;
  const codes = bare ? ["ZEN_URL_NOT_ALLOWED", "ZEN_INVALID_ARGUMENT"] : ["ZEN_URL_NOT_ALLOWED"];
  assert.ok(codes.includes(result.code), `must fail with ${codes.join(" or ")}, not ${result.code}: ${result.message}`);
  if (result.code === "ZEN_URL_NOT_ALLOWED") {
    assert.match(result.message, new RegExp(escapeRegExp(word(scheme)), "i"), `the error must name ${scheme}: ${result.message}`);
  }
}

/** An agent method in a document that isn't web content: ZEN_PAGE_NOT_WEB_CONTENT, naming the document when known. */
function assertGated(result, scheme) {
  assert.equal(result?.ok, false, `ran, returning ${shown(result?.value)}`);
  assert.equal(result.code, "ZEN_PAGE_NOT_WEB_CONTENT", `must fail with ZEN_PAGE_NOT_WEB_CONTENT, not ${result.code}: ${result.message}`);
  if (scheme) assert.match(result.message, new RegExp(escapeRegExp(word(scheme)), "i"), `the error must name the document: ${result.message}`);
}

/**
 * Where a page-made load left a page, the agent sees either a web document
 * with no chrome globals, or refusals: never a privileged document.
 */
function assertWebOrGated({ evaluate, snapshot }) {
  if (evaluate.ok) {
    const [href, ...globals] = evaluate.value;
    assert.ok(isWebUrl(href), `the agent evaluated in ${href}`);
    assert.deepEqual(globals, ["undefined", "undefined", "undefined"], `chrome globals in ${href}`);
    assert.ok(snapshot.ok, `evaluate ran in ${href}, but snapshot failed: ${snapshot.code} ${snapshot.message}`);
  } else {
    assertGated(evaluate);
    assertGated(snapshot);
  }
}

/** Evaluates where a page now is, with the chrome globals a privileged document has; then snapshots it. */
const LOOK = `async (p) => ({
  label: p.label,
  evaluate: await attempt(() => p.evaluate(() => [location.href, typeof ChromeUtils, typeof Services, typeof globalThis.Components?.classes])),
  snapshot: await attempt(() => p.snapshot()),
})`;

test("ordinary agent work still works: goto, evaluate, uploads, screenshots, downloads, fetch", async () => {
  const notes = join(planted.dir, "notes.txt");
  const data = join(planted.dir, "data.json");
  writeFileSync(notes, "hello upload\n");
  writeFileSync(data, '{"ok":true}\n');
  const A = {
    base: fx.base,
    notes,
    data,
    shot: join(saved, "shot.png"),
    download: join(saved, "report.bin"),
    fetched: join(saved, "fetched.bin"),
  };
  const out = await S.run(
    `const fs = await import("node:fs");
const crypto = await import("node:crypto");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const out = {};
out.goto = await attempt(async () => { await page.goto(A.base + "/"); return await page.url(); });
out.evaluate = await attempt(() => page.evaluate(() => [document.title, typeof ChromeUtils, typeof Services, typeof globalThis.Components?.classes]));
out.data = await attempt(async () => { await page.goto("data:text/html,<title>data page</title>"); return await page.title(); });
out.blank = await attempt(async () => { await page.goto("about:blank"); return await page.url(); });
out.blob = await attempt(async () => {
  await page.goto(A.base + "/");
  const url = await page.evaluate(() => URL.createObjectURL(new Blob(["<title>blob page</title>"], { type: "text/html" })));
  await page.goto(url);
  return await page.title();
});
await page.goto(A.base + "/upload");
out.upload = await attempt(async () => {
  await page.setInputFiles("#files", [A.notes, A.data]);
  await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null"));
  return await page.evaluate(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null"));
});
out.chooser = await attempt(async () => {
  await page.evaluate(() => { document.documentElement.dataset.uploaded = "null"; });
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click("#files")]);
  await chooser.setFiles(A.notes);
  await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null"));
  return await page.evaluate(() => JSON.parse(document.documentElement.dataset.uploaded ?? "null"));
});
out.shot = await attempt(() => page.screenshot({ path: A.shot }));
out.defaultShot = await attempt(async () => {
  const file = await page.screenshot();
  return { file, head: fs.readFileSync(file).subarray(0, 8).toString("hex") };
});
await page.goto(A.base + "/download");
out.download = await attempt(async () => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#get")]);
  await download.saveAs(A.download);
  return { name: download.suggestedFilename(), copy: sha(await download.path()) };
});
out.fetch = await attempt(async () => {
  const { ok, status, savedPath } = await page.fetch(A.base + "/report.bin", { saveAs: A.fetched });
  return { ok, status, savedPath };
});
console.log(JSON.stringify(out));`,
    { name: "controls", arg: A },
  );
  const ok = (name) => {
    assert.ok(out[name]?.ok, `${name} failed: ${out[name]?.code} ${out[name]?.message}`);
    return out[name].value;
  };
  assert.equal(ok("goto"), `${fx.base}/`);
  assert.deepEqual(ok("evaluate"), ["security fixture", "undefined", "undefined", "undefined"]);
  assert.equal(ok("data"), "data page");
  assert.equal(ok("blank"), "about:blank");
  assert.equal(ok("blob"), "blob page");
  assert.deepEqual(ok("upload"), [
    { name: "notes.txt", type: "text/plain", size: 13, text: "hello upload\n" },
    { name: "data.json", type: "application/json", size: 12, text: '{"ok":true}\n' },
  ]);
  assert.deepEqual(ok("chooser"), [{ name: "notes.txt", type: "text/plain", size: 13, text: "hello upload\n" }]);
  const png = "89504e470d0a1a0a";
  assert.equal(ok("shot"), A.shot);
  assert.equal(readFileSync(A.shot).subarray(0, 8).toString("hex"), png, "screenshot({ path }) wrote a PNG");
  assert.equal(ok("defaultShot").head, png, "screenshot() wrote a PNG where it said");
  // Its default place is the CLI's temporary folder, outside the test's own.
  rmSync(ok("defaultShot").file, { force: true });
  assert.deepEqual(ok("download"), { name: "report.bin", copy: sha256(S.REPORT) });
  assert.equal(sha256(readFileSync(A.download)), sha256(S.REPORT), "download.saveAs() wrote the download's bytes");
  assert.deepEqual(ok("fetch"), { ok: true, status: 200, savedPath: A.fetched });
  assert.equal(sha256(readFileSync(A.fetched)), sha256(S.REPORT), "fetch's saveAs wrote the body's bytes");
});

test("goto refuses every forbidden scheme, however it is spelled, and the page stays where it was", async () => {
  const f = findings();
  const urls = [...FORBIDDEN, ...DISGUISED];
  const out = await f.probe("the goto probe", () =>
    S.run(
      `const out = [];
for (const { url } of A.urls) {
  const goto = await attempt(() => page.goto(url, { timeout: 5000 }));
  const after = await attempt(() => page.url());
  const title = await attempt(() => page.title());
  out.push({ goto, after: after.value, title: title.value });
  // Back to the web page, so each probe starts from one.
  if (after.value !== A.web) await attempt(() => page.goto(A.web));
}
console.log(JSON.stringify(out));`,
      { name: "goto", start: `${fx.base}/`, arg: { urls, web: `${fx.base}/` } },
    ),
  );
  for (const [i, entry] of urls.entries()) {
    if (!out) break;
    f.check(`page.goto ${entry.url}`, () => {
      assertLoadRefused(out[i].goto, entry);
      assert.equal(out[i].after, `${fx.base}/`, "the page must stay on its web page");
      assert.equal(out[i].title, "security fixture", "nothing may run in the page");
    });
  }
  f.done();
});

test("a new page refuses every forbidden scheme", async () => {
  const f = findings();
  const space = await S.newSpace("new page");
  try {
    for (const entry of [...FORBIDDEN, ...DISGUISED]) {
      // pages.new takes a URL on the wire, though task.newPage() doesn't.
      const answer = S.asAttempt(await S.raw("pages.new", { space, url: entry.url, options: { timeout: 5000 } }));
      f.check(`pages.new ${entry.url}`, () => assertLoadRefused(answer, entry));
      // Whatever it left behind is closed, so the page budget can't end the probe early.
      const listed = await S.call("pages.list", { space });
      for (const left of Array.isArray(listed) ? listed : (listed?.pages ?? [])) {
        if (left.label === "p1") continue;
        f.check(`pages.new ${entry.url}`, () => assert.ok(isWebUrl(left.url ?? ""), `left page ${left.label} on ${left.url}`));
        await S.raw("pages.close", { space, page: left.label });
      }
    }
  } finally {
    await S.endSpace(space);
  }
  f.done();
});

test("reload never reopens a forbidden document the user opened in an agent tab", async () => {
  const f = findings();
  const space = await S.newSpace("reload");
  try {
    for (const entry of PRIVILEGED) {
      if (!(await f.probe(`the user's load of ${entry.url}`, () => S.userLoads(space, "p1", entry.url).then(() => true)))) continue;
      const out = await f.probe(`page.reload on ${entry.url}`, () =>
        S.run(`console.log(JSON.stringify(await attempt(() => page.reload({ timeout: 5000 }))));`, { name: "reload", space }),
      );
      if (!out) continue;
      f.check(`page.reload on ${entry.url}`, () => {
        assert.equal(out.ok, false, `reloaded, returning ${shown(out.value)}`);
        assert.ok(
          ["ZEN_URL_NOT_ALLOWED", "ZEN_PAGE_NOT_WEB_CONTENT"].includes(out.code),
          `must fail with ZEN_URL_NOT_ALLOWED or ZEN_PAGE_NOT_WEB_CONTENT, not ${out.code}: ${out.message}`,
        );
      });
    }
  } finally {
    await S.endSpace(space);
  }
  f.done();
});

test("a page's history.back() and history.forward() give the agent no forbidden document the user opened", async () => {
  // Session history keeps the user's entries, and loads them as they were loaded.
  const f = findings();
  const space = await S.newSpace("history");
  const web = `${fx.base}/`;
  // page.url() waits for a pending navigation, so the look comes after the
  // traversal however slow the machine is, never before it.
  const script = (move) => `const look = ${LOOK};
const moved = await attempt(() => page.evaluate(() => { history.${move}(); return true; }));
await new Promise((resolve) => setTimeout(resolve, 300));
const url = await attempt(() => page.url());
console.log(JSON.stringify({ moved, url, ...(await look(page)) }));`;
  try {
    for (const entry of PRIVILEGED.filter(({ scheme, url }) => scheme === "file:" || scheme === "chrome:" || url === "about:config")) {
      const user = (what, steps) => f.probe(`the user's ${what} around ${entry.url}`, async () => {
        for (const step of steps) await step();
        return true;
      });
      if (!(await user("loads", [() => S.userLoads(space, "p1", web), () => S.userLoads(space, "p1", entry.url), () => S.userLoads(space, "p1", `${fx.base}/next`)]))) continue;
      const back = await f.probe(`history.back() to ${entry.url}`, () => S.run(script("back"), { name: "back", space }));
      if (back) f.check(`history.back() to ${entry.url}`, () => assertWebOrGated(back));

      if (!(await user("loads and Back", [() => S.userLoads(space, "p1", web), () => S.userLoads(space, "p1", entry.url), () => S.userGoes(space, "p1", "back", web)]))) continue;
      const forward = await f.probe(`history.forward() to ${entry.url}`, () => S.run(script("forward"), { name: "forward", space }));
      if (forward) f.check(`history.forward() to ${entry.url}`, () => assertWebOrGated(forward));
    }
  } finally {
    await S.endSpace(space);
  }
  f.done();
});

test("agent methods refuse every privileged document the user opened in an agent tab", async () => {
  const f = findings();
  const space = await S.newSpace("privileged");
  try {
    for (const entry of PRIVILEGED) {
      if (!(await f.probe(`the user's load of ${entry.url}`, () => S.userLoads(space, "p1", entry.url).then(() => true)))) continue;
      const out = await f.probe(`in ${entry.url}`, () =>
        S.run(
          `const T = { timeout: 1500 };
const out = {};
// What these documents' powers could reach: chrome APIs, an add-on's
// cookies, about:logins' own data, and the file itself.
out.evaluate = await attempt(() => page.evaluate(async (secretPath) => {
  const found = { html: document.documentElement.outerHTML.slice(0, 2000) };
  const tryTo = async (key, get) => { try { found[key] = await get(); } catch (error) { found[key] = "threw " + String(error).slice(0, 80); } };
  await tryTo("passwords", async () => typeof Services === "object" ? (await Services.logins.getAllLogins()).map((login) => login.password) : null);
  await tryTo("read", async () => typeof IOUtils === "object" ? await IOUtils.readUTF8(secretPath) : null);
  await tryTo("cookies", async () => typeof browser === "object" && browser.cookies ? (await browser.cookies.getAll({})).map((cookie) => cookie.value) : null);
  if (location.href.startsWith("about:logins")) {
    await tryTo("logins", () => new Promise((resolve) => {
      const got = [];
      const listen = (event) => got.push(JSON.stringify(event.detail ?? null).slice(0, 4000));
      window.addEventListener("AboutLoginsChromeToContent", listen);
      document.dispatchEvent(new CustomEvent("AboutLoginsInit", { bubbles: true }));
      setTimeout(() => { window.removeEventListener("AboutLoginsChromeToContent", listen); resolve(got.join(" ")); }, 1000);
    }));
  }
  await tryTo("file", async () => (await (await fetch(location.href)).text()).slice(0, 2000));
  return found;
}, A.secretPath));
out.waitForFunction = await attempt(() => page.waitForFunction(() => document.readyState === "complete", null, T));
out.waitForSelector = await attempt(() => page.waitForSelector("body", T));
out.snapshot = await attempt(() => page.snapshot());
out.screenshot = await attempt(() => page.screenshot());
out.click = await attempt(() => page.click("body", T));
out.dblclick = await attempt(() => page.dblclick("body", T));
out.hover = await attempt(() => page.hover("body", T));
out.focus = await attempt(() => page.focus("body", T));
out.fill = await attempt(() => page.fill("input", "zenius", T));
out.press = await attempt(() => page.press("body", "Tab", T));
out.selectOption = await attempt(() => page.selectOption("select", "zenius", T));
out.setInputFiles = await attempt(() => page.setInputFiles("input", []));
out.mouse = await attempt(() => page.mouse.click(5, 5));
out.keyboard = await attempt(() => page.keyboard.press("Tab"));
out.fetch = await attempt(() => page.fetch(A.secret));
// Not asserted: events must only never carry the document's contents (run() checks).
out.events = await attempt(() => page.events());
console.log(JSON.stringify(out));`,
          { name: "privileged", space, arg: { secret: `file://${planted.secret}`, secretPath: planted.secret } },
        ),
      );
      if (!out) continue;
      for (const [method, result] of Object.entries(out)) {
        if (method !== "events") f.check(`page.${method} in ${entry.url}`, () => assertGated(result, entry.scheme));
      }
    }
  } finally {
    await S.endSpace(space);
  }
  f.done();
});

test("a certificate warning gives the agent nothing: goto fails clearly, no method acts in it, and no exception is added", async () => {
  const f = findings();
  const dir = mkdtempSync(join(tmpdir(), "zenius-security-cert-"));
  // A self-signed site that this run never trusts.
  const site = await startHttpsFixture(dir);
  const url = `${site.origin}/login`;
  try {
    const out = await S.run(
      `const T = { timeout: 1500 };
const out = {};
out.goto = await attempt(() => page.goto(A.url));
out.url = await attempt(() => page.url());
// Firefox's warning page, under the site's URL: every document method, and
// the buttons that would accept the risk, clicked with force.
out.evaluate = await attempt(() => page.evaluate(() => [location.href, document.documentElement.outerHTML.slice(0, 500)]));
out.waitForFunction = await attempt(() => page.waitForFunction(() => document.readyState === "complete", null, T));
out.waitForSelector = await attempt(() => page.waitForSelector("body", T));
out.snapshot = await attempt(() => page.snapshot());
out.screenshot = await attempt(() => page.screenshot());
out.click = await attempt(() => page.click("body", T));
out.hover = await attempt(() => page.hover("body", T));
out.focus = await attempt(() => page.focus("body", T));
out.fill = await attempt(() => page.fill("input", "zenius", T));
out.press = await attempt(() => page.press("body", "Enter", T));
out.mouse = await attempt(() => page.mouse.click(5, 5));
out.keyboard = await attempt(() => page.keyboard.press("Enter"));
out.fetch = await attempt(() => page.fetch(A.url));
// Gecko 160's buttons: Advanced, then the exception; and Go Back.
out.advanced = await attempt(() => page.click("moz-button#advanced-button", { force: true }));
out.exception = await attempt(() => page.click("#exception-button", { force: true }));
out.accept = await attempt(() => page.click("text=Accept the Risk and Continue", { force: true }));
out.back = await attempt(() => page.click("#returnButton", { force: true }));
out.reload = await attempt(() => page.reload());
// The same warning in a frame of a web page shows nothing of itself.
out.frame = await attempt(async () => {
  await page.goto("data:text/html,<p>top text</p><iframe src='" + A.url + "'></iframe>");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return JSON.stringify(await page.snapshot());
});
console.log(JSON.stringify(out));`,
      { name: "certificate", arg: { url } },
    );
    // A script sees Ego's plain Error for a failed load, and the message says what it was.
    const warned = (method) =>
      `${method} failed: net::ERR_CERT_AUTHORITY_INVALID. Firefox showed a certificate warning for 127.0.0.1:${site.port} ` +
      "(MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT): it can't verify that the site is who it says. " +
      "An agent can't accept the risk or add an exception; ask the user to check the site.";
    // The SDK's next step for it (sdk/src/error-guide.ts): only the user decides.
    const handOff =
      "Call task.handOff() and end the round: tell the user which site showed the warning. Only they can decide whether to trust it; never look for a way past it.";
    f.check("page.goto onto the warning", () => {
      assert.equal(out.goto.ok, false, `loaded, returning ${shown(out.goto.value)}`);
      assert.equal(out.goto.code, "Error", `a plain Error, as Ego throws, not ${out.goto.code}`);
      assert.equal(out.goto.message, `${warned("page.goto")}\n${handOff}`);
    });
    f.check("page.url on the warning", () => assert.deepEqual(out.url, { ok: true, value: url }));
    for (const method of ["evaluate", "waitForFunction", "waitForSelector", "snapshot", "screenshot", "click", "hover", "focus", "fill", "press", "mouse", "keyboard", "fetch", "advanced", "exception", "accept", "back"]) {
      f.check(`${method} in the warning`, () => {
        assertGated(out[method]);
        assert.equal(out[method].data?.url, url, `data.url: ${shown(out[method].data)}`);
      });
    }
    f.check("page.reload of the warning", () => {
      assert.equal(out.reload.ok, false, `reloaded, returning ${shown(out.reload.value)}`);
      assert.equal(out.reload.message, `${warned("page.reload")}\n${handOff}`);
    });
    f.check("the warning in a frame", () => {
      assert.equal(out.frame.ok, true, `${out.frame.code}: ${out.frame.message}`);
      assert.match(out.frame.value, /top text/);
      assert.doesNotMatch(out.frame.value, /risk|advanced|exception/i, out.frame.value.slice(0, 500));
    });
    // On the wire, the runtime marks the failure as a certificate warning.
    const space = await S.newSpace("certificate wire");
    try {
      const wire = S.asAttempt(await S.raw("page.goto", { space, page: "p1", url }));
      f.check("the wire's page.goto error", () => {
        assert.equal(wire.ok, false, `loaded, returning ${shown(wire.value)}`);
        assert.equal(wire.code, "ZEN_NAVIGATION_FAILED", wire.message);
        assert.deepEqual([wire.data?.certificateWarning, wire.data?.plain], [true, true], shown(wire.data));
        assert.equal(wire.message, warned("page.goto"));
      });
    } finally {
      await S.endSpace(space);
    }
  } finally {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const overrides = await f.probe("reading the certificate overrides", () =>
    S.chrome(
      `const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
       return overrides.getOverrides().filter((override) => override.port === arg).map((override) => override.hostPort);`,
      site.port,
    ),
  );
  f.check("no certificate exception for the site", () => assert.deepEqual(overrides, []));
  f.done();
});

test("pages a web page opens show no forbidden document to the agent", async () => {
  const f = findings();
  const out = await f.probe("the openers probe", () =>
    S.run(
      `const look = ${LOOK};
const others = async () => (await task.pages()).filter((p) => p.label !== "p1");
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const out = [];
for (const [i] of A.urls.entries()) {
  const row = [];
  for (const how of ["blank", "open"]) {
    const click = await attempt(() => page.click("#" + how + "-" + i, { timeout: 5000 }));
    await settle();
    const opened = await others();
    row.push({ how, click, pages: await Promise.all(opened.map(look)) });
    for (const p of opened) await p.close().catch(() => {});
  }
  const tab = await task.newPage();
  await tab.goto(A.base + "/openers");
  const click = await attempt(() => tab.click("#same-" + i, { timeout: 5000 }));
  await settle();
  await attempt(() => tab.url());
  row.push({ how: "same", click, pages: [await look(tab)] });
  for (const p of await others()) await p.close().catch(() => {});
  out.push(row);
}
// A popup that opened late was looked at with the next row; the last row's go here.
await new Promise((resolve) => setTimeout(resolve, 1000));
out.push([{ how: "late", pages: await Promise.all((await others()).map(look)) }]);
console.log(JSON.stringify(out));`,
      { name: "openers", start: `${fx.base}/openers`, arg: { base: fx.base, urls: OPENED.map(({ url }) => url) } },
    ),
  );
  const how = { blank: "a target=_blank link", open: "window.open()", same: "a link", late: "a late popup" };
  for (const [i, row] of (out ?? []).entries()) {
    const to = OPENED[i]?.url ?? "one of the URLs";
    for (const attempt of row) {
      for (const page of attempt.pages) f.check(`${how[attempt.how]} to ${to}, page ${page.label}`, () => assertWebOrGated(page));
    }
  }
  f.done();
});

test("the runtime never opens a path an agent names: uploads, screenshots, fetch and downloads", async () => {
  const f = findings();
  const space = await S.newSpace("paths");
  const connection = await S.connectRaw();
  const call = async (method, params) => S.asAttempt(await connection.call(method, params));
  const P = { space, page: "p1" };
  const refusedArgument = (result) => {
    assert.equal(result.ok, false, `accepted, returning ${shown(result.value)}`);
    assert.equal(result.code, "ZEN_INVALID_ARGUMENT", `must fail with ZEN_INVALID_ARGUMENT, not ${result.code}: ${result.message}`);
  };
  const uploaded = async () => (await call("page.evaluate", { ...P, fn: 'JSON.parse(document.documentElement.dataset.uploaded ?? "null")', isFunction: false })).value;
  try {
    await call("page.goto", { ...P, url: `${fx.base}/upload`, options: {} });
    for (const [shape, files] of [
      ["a path", [planted.secret]],
      ["a file: URL", [`file://${planted.secret}`]],
      ["{ path }", [{ path: planted.secret }]],
      ["{ name, mimeType, path }", [{ name: "secret.txt", mimeType: "text/plain", path: planted.secret }]],
    ]) {
      const result = await call("page.setInputFiles", { ...P, target: "#files", files });
      f.check(`page.setInputFiles with ${shape}`, () => refusedArgument(result));
    }
    const leaked = await uploaded();
    f.check("a refused upload", () => assert.equal(leaked, null, `gave the page ${shown(leaked)}`));

    // A payload's name is only a name, even when it reads like a path.
    const decoy = { name: planted.secret, mimeType: "text/plain", lastModified: Date.now(), base64: Buffer.from("decoy").toString("base64") };
    const set = await call("page.setInputFiles", { ...P, target: "#files", files: [decoy] });
    await call("page.waitForFunction", { ...P, fn: 'JSON.parse(document.documentElement.dataset.uploaded ?? "null")', isFunction: false, options: { timeout: 5000 } });
    const [file] = (await uploaded()) ?? [];
    f.check("page.setInputFiles with contents named like a path", () => {
      assert.ok(set.ok, `failed: ${set.code} ${set.message}`);
      assert.equal(file?.text, "decoy", "the page must get the payload's contents");
      assert.ok(!String(file?.name).includes("/"), `File.name must be one path component, not ${file?.name}`);
    });

    const [chosen] = await Promise.all([
      call("page.waitForEvent", { ...P, event: "filechooser", options: { timeout: 5000 } }),
      call("page.click", { ...P, target: "#files", options: {} }),
    ]);
    if (chosen.ok) {
      const result = await call("filechooser.setFiles", { chooser: chosen.value.chooser, files: [planted.secret] });
      f.check("filechooser.setFiles with a path", () => refusedArgument(result));
      await call("filechooser.setFiles", { chooser: chosen.value.chooser, files: [] });
    } else f.check("the file chooser", () => assert.fail(`didn't open: ${chosen.code} ${chosen.message}`));

    const shot = await call("page.screenshot", { ...P, options: { path: join(untouched, "shot.png") } });
    f.check("page.screenshot with a path", () => refusedArgument(shot));
    const fetched = await call("page.fetch", { ...P, url: `${fx.base}/report.bin`, options: { saveAs: join(untouched, "fetched.bin") } });
    f.check("page.fetch with saveAs", () => refusedArgument(fetched));

    await call("page.goto", { ...P, url: `${fx.base}/download`, options: {} });
    const [started] = await Promise.all([
      call("page.waitForEvent", { ...P, event: "download", options: { timeout: 10_000 } }),
      call("page.click", { ...P, target: "#get", options: {} }),
    ]);
    if (started.ok) {
      const download = started.value.download;
      const saveAs = await call("download.saveAs", { download, path: join(untouched, "download.bin") });
      f.check("download.saveAs with a path", () => refusedArgument(saveAs));
      // The finished file is the one the runtime moved into the working
      // folder, by a name of the runtime's own: the CLI copies it from there.
      const path = await call("download.path", { download });
      f.check("download.path", () => {
        assert.ok(path.ok, `failed: ${path.code} ${path.message}`);
        assert.ok(path.value.path.startsWith(`${S.WORKING}/`), `${path.value.path} isn't in the working folder, ${S.WORKING}`);
        assert.equal(sha256(readFileSync(path.value.path)), sha256(S.REPORT), "must be the download's bytes");
      });
      const read = await call("download.read", { download, offset: 0, length: 8 * 1024 * 1024 });
      f.check("download.read, which is gone", () => {
        refusedArgument(read);
        assert.match(read.message, /download\.path/);
      });
    } else f.check("the download", () => assert.fail(`didn't start: ${started.code} ${started.message}`));

    f.check("the folder probes named", () => assert.deepEqual(readdirSync(untouched), [], "the runtime wrote there"));
  } finally {
    connection.close();
    await S.endSpace(space);
  }
  f.done();
});

test("this dev profile has the dev channel the probes use as the user", async () => {
  assert.equal(typeof (await S.call("dev.stats")), "object");
});
