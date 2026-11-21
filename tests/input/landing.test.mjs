// Input lands only in web content (SPEC I5). Firefox's error pages aren't
// the site's: a certificate warning shows under the site's own https URL,
// and its "Accept the Risk and Continue" adds a lasting certificate
// exception to the user's profile. An agent can't operate one, as its page
// or in a frame of it: not by a click at a point, keys, a forced click or a
// wheel. zen-observe's gate refuses every method on such a page and every
// call to such a frame; content/actions.sys.mjs refuses input that the
// page's own process would deliver into one.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";
import { loginSite, startHttpsFixture } from "./https-fixture.mjs";

let h;
let task;
let site;
let untrusted;

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;

before(async () => {
  h = await openHarness("landing");
  task = await h.taskSpace("zen-input landing");
  // A site the dev Zen trusts, for the pages that frame the warning.
  site = await loginSite(h, { username: "landing-user", password: "landing-pass" });
  // A server nobody trusts: every page it serves is a certificate warning.
  const dir = join(h.artifactDir, "untrusted");
  mkdirSync(dir, { recursive: true });
  untrusted = await startHttpsFixture(dir);
});

after(async () => {
  try {
    await untrusted?.close();
    await site?.close();
  } finally {
    await h?.finish();
  }
});

/**
 * Privileged JS in the certificate warning of `page`, whether it is the page
 * or one of its frames; also where it is.
 */
const inWarning = (page, code) =>
  chrome(
    `${SERVICE}
     const { browsingContext } = ZeniusService.resolvePage(arg);
     const bc = browsingContext.getAllBrowsingContextsInSubtree().find(b => b.currentWindowGlobal?.documentURI?.spec.startsWith("about:certerror"));
     if (!bc) return null;
     const value = await ZeniusService.content(bc, "dev#evalContent", { code: arg.code, privileged: true });
     return { value, top: bc === browsingContext, sameProcess: bc.currentWindowGlobal.osPid === browsingContext.currentWindowGlobal.osPid };`,
    { space: page.spaceId, page: page.label, code }
  );

/** Record in the warning every input event that reaches it. */
const RECORD = `
  const root = document.documentElement;
  root.setAttribute("data-zen-landed", "");
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "keyup", "keypress", "wheel"]) {
    document.addEventListener(type, () => root.setAttribute("data-zen-landed", root.getAttribute("data-zen-landed") + type + " "), true);
  }`;
const LANDED = `return document.documentElement.getAttribute("data-zen-landed");`;
/** The warning's Advanced button (in its net-error-card), which reveals "Accept the Risk and Continue". */
const ADVANCED_BUTTON = `document.querySelector("net-error-card")?.openOrClosedShadowRoot?.querySelector("#advanced-button")`;
const ADVANCED = `const b = ${ADVANCED_BUTTON};
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };`;
/** "Proceed to <host> (Risky)": a top-level warning's exception button, once Advanced is open and Firefox's delay has passed. */
const PROCEED = `const b = document.querySelector("net-error-card")?.openOrClosedShadowRoot?.querySelector("#exception-button");
  const inner = b?.openOrClosedShadowRoot?.querySelector("button");
  if (!b || !inner || inner.disabled) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };`;

/** Certificate exceptions for the untrusted server, which must stay none. */
const exceptions = () =>
  chrome(
    `const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
     return overrides.getOverrides().filter(o => o.port === arg).map(o => o.asciiHost);`,
    untrusted.port
  );

/** zen-observe's gate names the page's URL; a frame's refusal, the frame's document. */
const ERROR_PAGE_REFUSAL = /it is Firefox's error page|about:certerror/;

async function refused(what, attempt) {
  const e = await attempt().then(
    () => null,
    err => err
  );
  assert.equal(e?.code, "ZEN_PAGE_NOT_WEB_CONTENT", `${what}: ${e ? `${e.code} ${e.message}` : "it went through"}`);
  assert.match(e.message, ERROR_PAGE_REFUSAL, what);
  return e;
}

async function warningIn(page, where) {
  return h.until(async () => {
    const w = await inWarning(page, ADVANCED);
    return w?.value?.w > 0 && w;
  }, `the certificate warning ${where}`);
}

test("an agent can't click through a certificate warning shown as its page", async () => {
  const page = await task.newPage();
  try {
    // zen-observe's goto fails on a certificate warning, and the page shows it.
    const nav = await page.goto(`${untrusted.origin}/`).then(
      () => null,
      e => e
    );
    assert.equal(nav?.code, "ZEN_NAVIGATION_FAILED", nav?.message);
    assert.equal(nav.data?.certificateWarning, true);
    const w = await warningIn(page, "as the page");
    assert.equal(w.top, true);
    await inWarning(page, RECORD);
    const p = w.value;
    await refused("a click at the Advanced button", () => page.mouse.click(p.x, p.y));
    await refused("a forced click on it", () => page.click("#advanced-button", { force: true }));
    await refused("Tab", () => page.keyboard.press("Tab"));
    await refused("Enter", () => page.keyboard.press("Enter"));
    await refused("a wheel", () => page.mouse.wheel(0, 200));

    // As if the user had opened Advanced before handing the tab back: the
    // exception button is there, and enabled.
    await inWarning(page, `${ADVANCED_BUTTON}.click(); return true;`);
    const proceed = await h.until(async () => (await inWarning(page, PROCEED))?.value, "the enabled Proceed button");
    await inWarning(page, RECORD);
    await refused("a click at Proceed", () => page.mouse.click(proceed.x, proceed.y));
    await refused("a forced click on it", () => page.click("#exception-button", { force: true }));
    await inWarning(page, `document.querySelector("net-error-card").openOrClosedShadowRoot.querySelector("#exception-button").focus(); return true;`);
    await refused("Enter on it", () => page.keyboard.press("Enter"));
    // The agent's page.evaluate (the harness's evaluate is a dev method).
    await refused("its script", () =>
      h.call("page.evaluate", { space: page.spaceId, page: page.label, fn: "typeof document.addCertException", isFunction: false })
    );
    assert.equal((await inWarning(page, LANDED)).value, "", "no input reached the warning");
    assert.deepEqual(await exceptions(), [], "no certificate exception");
  } finally {
    await page.close().catch(() => {});
  }
});

for (const [kind, origin] of [
  // The same site as the warning's: one process, whose own events would reach the frame.
  ["the page's own process", () => site.origin],
  // Another site: the frame has its own process, reached only through the runtime.
  ["a process of its own", () => site.crossOrigin],
]) {
  test(`an agent can't click through a certificate warning in a frame, in ${kind}`, async () => {
    const page = await h.newPageAt(task, `${origin()}/framed?src=${encodeURIComponent(`${untrusted.origin}/`)}`);
    try {
      const w = await warningIn(page, "in the frame");
      assert.equal(w.top, false);
      assert.equal(w.sameProcess, kind === "the page's own process", `the warning runs in ${kind}`);
      await inWarning(page, RECORD);
      const box = await page.evaluate(() => {
        const f = document.querySelector("#frame");
        const r = f.getBoundingClientRect();
        return { x: r.x + f.clientLeft, y: r.y + f.clientTop };
      });
      const p = { x: box.x + w.value.x, y: box.y + w.value.y };

      await refused("a click at the Advanced button", () => page.mouse.click(p.x, p.y));
      await refused("a press there", () => page.mouse.down());
      await refused("a wheel there", () => page.mouse.wheel(0, 200));
      // Released in the page, where input is allowed.
      await page.mouse.move(5, 5);
      await page.mouse.up();
      if (kind === "the page's own process") {
        // A click on the frame element lands in the warning it shows.
        await refused("a click on the frame", () => page.click("#frame"));
        await refused("a forced click on the frame", () => page.click("#frame", { force: true }));
      }
      // Keys follow the focus into the frame.
      await inWarning(page, `${ADVANCED_BUTTON}.focus(); return true;`);
      await refused("Enter in the warning", () => page.keyboard.press("Enter"));
      await refused("Space in the warning", () => page.keyboard.press(" "));
      await refused("typing in the warning", () => page.keyboard.insertText("x"));
      assert.equal((await inWarning(page, LANDED)).value, "", "no input reached the warning");
      assert.deepEqual(await exceptions(), [], "no certificate exception");

      // The page around it still takes input.
      await page.focus("#topbtn");
      const top = await page.evaluate(() => {
        const r = document.querySelector("#topbtn").getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(top.x, top.y);
      await page.keyboard.press("Shift");
    } finally {
      await page.close().catch(() => {});
    }
  });
}
