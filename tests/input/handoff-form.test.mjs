// The Cloudflare bug from real use (MANAGER.md, 2026-11-21 13:54), as its
// regression tests, on a React-style form (react-form.mjs). An agent filled
// a token form with page code and handed off. The page loaded afresh under
// the user, and they submitted it at its defaults: a framework's state doesn't
// come back with the form's fields. Under the evidence model, only a page the
// agent's code left something in that outlives its world (zen-observe's
// hooked) loads afresh for the user:
//   (a) Page code that only sets values, dispatches events and clicks, as
//       on Cloudflare's form, leaves nothing: the page is written but not
//       hooked. hand_off works with nothing reloaded, the user's press on
//       Submit lands, and the form sends the agent's values. The same at the
//       user's Take over.
//   (b) The same code with a script element or an inline handler added: the
//       page is hooked. The user's press in the agent's tab gets the clean
//       copy and zen-ux's notice, and is dropped. The custom select and
//       multi-select come back at their defaults (the text field comes back
//       by the carry-over). A hand-off or the user's Take over loads the
//       page afresh first, and the user's press sends the defaults.
//   (c) Input tools only: hand_off works, nothing reloads, and the user's
//       press sends what the agent filled.
// The user's input needs the page shown, so those cases run in a watched
// agent tab.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";
import { DEFAULTS, fillByCode, reactFormSite } from "./react-form.mjs";

let h;
let site;

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const UI = `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;`;
const N = `const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");`;
const EV = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");`;
const where = page => ({ space: page.spaceId, page: page.label });

/** What the agent puts in the form. */
const FILLED = { name: "CI deploys", perm: "edit", zones: ["example.com", "example.org"] };

before(async () => {
  h = await openHarness("handoff-form");
  site = await reactFormSite();
});

after(async () => {
  await site?.close();
  await h?.finish();
});

/** The form as the page's own code holds it: its document, its state, what it submitted. */
const formOf = page =>
  h.asUser(
    page,
    `const d = document.body?.dataset ?? {};
     return { doc: d.doc ?? null, load: d.load ?? null, state: d.state ? JSON.parse(d.state) : null,
              submits: Number(d.submits ?? 0), submitted: d.submitted ? JSON.parse(d.submitted) : null };`
  );

/** zen-observe's evidence on the page's document: reason → detail. */
const evidenceOf = page =>
  chrome(`${SERVICE} ${EV} const { tab } = ZeniusService.resolvePage(arg); return { ...EV.evidenceOf(tab.linkedBrowser) };`, where(page));

/** The page, once zen-observe has marked it hooked: what hooked it. */
const hookedBy = page => h.until(async () => (await evidenceOf(page)).hooked, "the page, hooked");

/** zen-ux's notice on the page's tab that it loaded afresh, or null. */
const reloadNotice = page =>
  chrome(
    `${SERVICE} ${N} const { tab } = ZeniusService.resolvePage(arg);
     const el = N.noticeElement(tab, "zenius-reloaded");
     return el ? { text: N.noticeText(tab, "zenius-reloaded"), note: el.querySelector(".zenius-card-note")?.textContent ?? null } : null;`,
    where(page)
  );

/** zen-core's clean copies on demand since the case began. */
const COUNT = `${SERVICE}
  if (!Object.hasOwn(ZeniusService, "cleanOnDemand")) {
    const real = ZeniusService.cleanOnDemand;
    win.__formCleanCalls = 0;
    ZeniusService.cleanOnDemand = function (browser) {
      win.__formCleanCalls++;
      return real.call(this, browser);
    };
  }
  return win.__formCleanCalls;`;
const UNCOUNT = `${SERVICE} if (Object.hasOwn(ZeniusService, "cleanOnDemand")) delete ZeniusService.cleanOnDemand; delete win.__formCleanCalls; return true;`;
const cleanCalls = () => chrome(`return win.__formCleanCalls ?? 0;`);

const ownership = page => chrome(`${SERVICE} return ZeniusService.spaces.peek(arg)?.ownership ?? null;`, page.spaceId);

/** The agent's hand-off: its result, or its refusal's {code, data}. */
async function handOff(page) {
  try {
    return { result: await h.call("spaces.handOff", { space: page.spaceId }) };
  } catch (e) {
    return { refused: { code: e.code, message: e.message, data: e.data } };
  }
}

/** The user's Take over, as the prompt's or the panel's (zen-ux's takeOverByUser). */
async function userTakesOver(page) {
  await chrome(`${SERVICE} ${UI} await UI.takeOverByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
  await h.until(async () => (await ownership(page)) === "agentDelegatedToUser", "the task, the user's");
}

/** The agent's page code: page.evaluate as the agent calls it, in its own world. */
const evaluate = (page, fn) => h.call("page.evaluate", { ...where(page), isFunction: false, fn });

/** The agent fills the form with page code: its state after, which the code returns. */
const fillWithCode = async (page, opts) => JSON.parse(await evaluate(page, fillByCode(FILLED, opts)));

/**
 * A case's own task, with the form open in it: zenius remembers per task
 * where the agent's code ran, and one case's code mustn't count in another.
 */
async function startCase(tag) {
  const path = `/form?${tag}-${Date.now()}`;
  const task = await h.taskSpace(`zen-input handoff form ${tag}`);
  return { task, path, page: await h.newPageAt(task, site.url(path)) };
}

/** Back to the agent, whoever holds the task now, and the case's pages closed. */
async function endCase(task, pages) {
  await chrome(UNCOUNT).catch(() => {});
  await chrome(
    `${SERVICE} ${UI}
     const rec = ZeniusService.spaces.peek(arg);
     if (UI.takeover.promptState(arg)) UI.takeover.resolve(arg, "continue");
     if (rec?.paused) UI.resumeByUser(rec);
     if (typeof rec?.lastUserInputAt === "number") rec.lastUserInputAt -= 10000;
     return true;`,
    task.spaceId
  ).catch(() => {});
  if ((await ownership(task).catch(() => null)) === "agentDelegatedToUser") {
    await h.call("spaces.takeOver", { space: task.spaceId }).catch(() => {});
  }
  for (const page of pages.reverse()) {
    await page?.close().catch(() => {});
  }
}

const custom = state => ({ perm: state.perm, zones: state.zones });

/** The agent fills the form with input tools: fill, and clicks on the custom controls. */
async function fillWithTools(page, { name, perm, zones }) {
  await page.fill("#name", name);
  await page.click("#perm-button");
  await page.click(`#perm-list [data-value="${perm}"]`);
  for (const zone of zones) {
    await page.click(`#zones [data-value="${zone}"]`);
  }
}

/** The page, once a document other than `doc` is in. */
const freshDoc = (page, doc, what) =>
  h.until(
    async () => {
      const f = await formOf(page);
      return f.doc && f.doc !== doc && f;
    },
    what,
    15_000
  );

/** The user's press on Submit, once the form has sent it. */
async function userSubmits(page) {
  await h.userClick(page, "#submit");
  return h.until(async () => {
    const f = await formOf(page);
    return f.submits > 0 && f;
  }, "the user's press, submitted");
}

const NOTE = /^A form here may be back to its defaults: check it before you submit\./;

/** hand_off goes through with nothing reloaded, and the user presses Submit: what the form sent. */
async function handedOffAndSubmitted(page) {
  const before = await formOf(page);
  const handed = await handOff(page);
  assert.equal(handed.refused, undefined, `hand_off went through: ${JSON.stringify(handed.refused)}`);
  assert.equal(handed.result.ownership, "agentDelegatedToUser");
  assert.deepEqual(handed.result.reloaded ?? [], [], "nothing loaded afresh at the hand-off");
  const back = await h.watch(page);
  try {
    const sent = await userSubmits(page);
    assert.equal(sent.doc, before.doc, "the same document: the page never reloaded under the user");
    assert.equal(sent.submits, 1);
    return sent.submitted;
  } finally {
    await back();
  }
}

test("(a) the Cloudflare case: a React-style form filled with page code that only sets values, dispatches events and clicks isn't hooked; hand_off works with nothing reloaded, and the user's press on Submit lands and sends the agent's values", async () => {
  const { task, path, page } = await startCase("code");
  try {
    await chrome(COUNT);
    assert.deepEqual(await fillWithCode(page), FILLED, "the agent's code filled the form's state");
    assert.deepEqual(await evidenceOf(page), {}, "nothing the agent's code did is evidence: the page isn't hooked");
    assert.deepEqual(await handedOffAndSubmitted(page), FILLED, "the form sent the agent's values");
    assert.equal(await cleanCalls(), 0, "no clean copy");
    assert.equal(await reloadNotice(page), null, "no notice of a reload");
    assert.equal(site.loadsOf(path), 1, "the form loaded once");
  } finally {
    await endCase(task, [page]);
  }
});

test("(a) the same at the user's Take over: nothing reloads, and the user's press sends the agent's values", async () => {
  const { task, path, page } = await startCase("code-takeover");
  let back = null;
  try {
    await chrome(COUNT);
    assert.deepEqual(await fillWithCode(page), FILLED);
    assert.deepEqual(await evidenceOf(page), {}, "the page isn't hooked");
    const filled = await formOf(page);

    back = await h.watch(page);
    await userTakesOver(page);
    const sent = await userSubmits(page);
    assert.equal(sent.doc, filled.doc, "the same document: nothing reloaded at the Take over");
    assert.deepEqual(sent.submitted, FILLED, "the form sent the agent's values");
    assert.equal(await cleanCalls(), 0, "no clean copy");
    assert.equal(await reloadNotice(page), null, "no notice of a reload");
    assert.equal(site.loadsOf(path), 1, "the form loaded once");
  } finally {
    await back?.();
    await endCase(task, [page]);
  }
});

test("(b) the same code adding a script element hooks the page: the user's press in the agent's tab gets the clean copy and zen-ux's notice, and is dropped; the custom select and multi-select are back at their defaults", async () => {
  const { task, page } = await startCase("press");
  let back = null;
  try {
    await chrome(COUNT);
    assert.deepEqual(await fillWithCode(page, { hook: "script" }), FILLED);
    assert.equal(await hookedBy(page), "a script element");
    const filled = await formOf(page);

    back = await h.watch(page);
    await h.userClick(page, "#submit");
    await h.until(async () => (await cleanCalls()) >= 1, "the clean copy at the user's press", 10_000);
    const fresh = await freshDoc(page, filled.doc, "the clean copy's document");
    const notice = await h.until(() => reloadNotice(page), "zen-ux's notice");
    assert.equal(notice.text, "Your click didn't go through · the page reloaded, as the agent's code had changed it");
    assert.match(notice.note, NOTE);
    assert.deepEqual(custom(fresh.state), custom(DEFAULTS), "the custom select and the multi-select are at their defaults");
    // Long enough for a click that got through to have submitted.
    await h.sleep(500);
    const after = await formOf(page);
    assert.equal(after.doc, fresh.doc);
    assert.equal(after.submits, 0, "the press was dropped: nothing was submitted");
    assert.equal(await cleanCalls(), 1, "one clean copy");
  } finally {
    await back?.();
    await endCase(task, [page]);
  }
});

test("(b) the same code adding an inline handler hooks the page: hand_off loads it afresh first, and the user's press sends the defaults", async () => {
  const { task, page } = await startCase("handoff-hooked");
  let back = null;
  try {
    await chrome(COUNT);
    assert.deepEqual(await fillWithCode(page, { hook: "handler" }), FILLED);
    assert.equal(await hookedBy(page), "an inline handler (onfocus)");
    const filled = await formOf(page);

    const handed = await handOff(page);
    assert.equal(handed.refused, undefined, `hand_off went through: ${JSON.stringify(handed.refused)}`);
    assert.equal(handed.result.ownership, "agentDelegatedToUser");
    assert.deepEqual(handed.result.reloaded, [page.label], "the hand-off loaded the page afresh");
    const fresh = await freshDoc(page, filled.doc, "the page, loaded afresh at the hand-off");
    assert.deepEqual(custom(fresh.state), custom(DEFAULTS), "the custom select and the multi-select are at their defaults");
    // zen-ux's notice says so, as at Take over (zen-ux's glue; its title gains why once zen-core's evidence comes with the hold).
    const notice = await h.until(() => reloadNotice(page), "zen-ux's notice");
    assert.match(notice.text, /^This page reloaded(?: · |$)/);
    assert.match(notice.note, NOTE);

    back = await h.watch(page);
    const sent = await userSubmits(page);
    assert.equal(sent.doc, fresh.doc, "the press went to the page the hand-off loaded");
    assert.deepEqual(custom(sent.submitted), custom(DEFAULTS), "what the user submitted: the defaults");
    assert.equal(await cleanCalls(), 0, "the press brought no clean copy: the hand-off had loaded one");
  } finally {
    await back?.();
    await endCase(task, [page]);
  }
});

test("(b) a hooked form at the user's Take over: it loads afresh at once, zen-ux's notice says so, and the user's press sends the defaults it warns of", async () => {
  const { task, page } = await startCase("takeover-hooked");
  let back = null;
  try {
    await chrome(COUNT);
    assert.deepEqual(await fillWithCode(page, { hook: "script" }), FILLED);
    await hookedBy(page);
    const filled = await formOf(page);

    back = await h.watch(page);
    await userTakesOver(page);
    const taken = await freshDoc(page, filled.doc, "the page, loaded afresh at the Take over");
    assert.deepEqual(custom(taken.state), custom(DEFAULTS), "the custom select and the multi-select are at their defaults");
    const notice = await h.until(() => reloadNotice(page), "zen-ux's notice");
    assert.equal(notice.text, "This page reloaded · the agent's code had changed it", "the notice says why: Take over's evidence");
    assert.match(notice.note, NOTE);

    const sent = await userSubmits(page);
    assert.equal(sent.doc, taken.doc, "the press went to the page the Take over loaded");
    assert.deepEqual(custom(sent.submitted), custom(DEFAULTS), "what the user submitted: the defaults, which the notice warned of");
    assert.equal(await cleanCalls(), 0, "the press brought no clean copy: the Take over had loaded one");
  } finally {
    await back?.();
    await endCase(task, [page]);
  }
});

test("(c) a React-style form filled with input tools only: hand_off works, nothing reloads, and the user's press sends what the agent filled", async () => {
  const { task, path, page } = await startCase("tools");
  try {
    await chrome(COUNT);
    await fillWithTools(page, FILLED);
    assert.deepEqual((await formOf(page)).state, FILLED, "the agent's input reached the form's state");
    assert.deepEqual(await handedOffAndSubmitted(page), FILLED, "the form sent what the agent filled");
    assert.equal(await cleanCalls(), 0, "no clean copy");
    assert.equal(await reloadNotice(page), null, "no notice of a reload");
    assert.equal(site.loadsOf(path), 1, "the form loaded once");
  } finally {
    await endCase(task, [page]);
  }
});
