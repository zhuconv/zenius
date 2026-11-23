// The typing guard (content/typing.sys.mjs, input/typing.sys.mjs;
// 2026-11-20), on evidence only (the user's call, 2026-11-21). In a page the
// agent's code left something hooked in (zen-observe's evidence), the user's
// first press or key is stopped before any listener of the page, and so is
// their typing there until the page's top document is replaced, and zen-core
// is asked for a clean copy. A page the agent's code only filled, clicked or
// wrote text into has no evidence, and neither has one it pasted plain
// markup into: the user's input goes in. A listed or flagged page doesn't
// hold it either, since a clean copy can't remove the page's own danger
// (zen-ux warns there; the manager's call, 2026-11-21). A page the agent
// made keeps the user's typing on (the user's decision).
// The page's own listeners stand for code the agent left in it. zen-core's
// cleanOnDemand is stubbed here, since its reload is zen-core's to test,
// except in the replay's cases at the end: their keys go into its clean
// copy. The user's input needs the page shown, so these cases run in a
// watched agent tab.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";

let h;
let task;

before(async () => {
  h = await openHarness("typing");
  task = await h.taskSpace("zen-input typing");
});

after(async () => {
  await h?.finish();
});

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const UI = `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;`;
const TYPING = `const T = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/typing.sys.mjs");`;
const WORLD = `const AW = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");`;
const EVIDENCE = `const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");`;
const where = page => ({ space: page.spaceId, page: page.label });
const formsUrl = what => `${h.baseUrl}/zoo/forms.html?typing=${what}-${Date.now()}`;

const HEARD = [
  "keydown",
  "keypress",
  "keyup",
  "paste",
  "drop",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
  "input",
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
];
/** The page's own code, logging what it hears; optionally it moves the focus itself. */
const LISTEN = focus => `window.__heard = [];
  for (const type of ${JSON.stringify(HEARD)}) window.addEventListener(type, () => window.__heard.push(type), true);
  ${focus ? `document.querySelector(${JSON.stringify(focus)}).focus();` : ""}
  return true;`;
/** What the page's code heard since the last look, read whoever holds the Space. */
const heard = page => h.asUser(page, "return window.__heard.splice(0)");
const valueOf = (page, selector) => h.asUser(page, `return document.querySelector(${JSON.stringify(selector)}).value`);
const activeId = page => h.asUser(page, "return document.activeElement?.id || document.activeElement?.getAttribute('name') || document.activeElement?.localName");

/** zen-ux's side: what onUserTyping reported, in order. */
const triggers = () => chrome(`return win.__zeniusTyping ?? [];`);
const someTrigger = (n = 1) => h.until(async () => (await triggers()).length >= n, "the user's trigger reported");
/** The pages zen-core was asked to load afresh, by browserId. */
const cleanCalls = () => chrome(`return win.__zenInputCleanCalls ?? [];`);
const browserIdOf = page => chrome(`${SERVICE} return ZeniusService.resolvePage(arg).browser.browserId;`, where(page));

/**
 * Back to the page's top, for the user's clicks on its fields. After the
 * agent's paste, the page's scroll to the editor waits for the next refresh
 * tick, and under load that tick can come after a plain scrollTo, taking the
 * fields out of view before the user's click (zen-core's flake, 2026-11-21).
 * So let the ticks pass, and scroll again until the top holds.
 */
const toTop = page =>
  h.until(
    () => h.asUser(page, "scrollTo(0, 0); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(scrollY === 0))))"),
    "the page at its top"
  );

/**
 * The user clicks into `selector`, again if the window doesn't send keys
 * there within 5 s (a click right after a load could miss), and types.
 */
async function userTypes(page, selector, ...keys) {
  const there = () =>
    chrome(
      `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
       return Services.focus.focusedContentBrowsingContext === browser.browsingContext;`,
      where(page)
    ).then(async top => top && h.asUser(page, `return document.activeElement === document.querySelector(${JSON.stringify(selector)})`));
  for (let attempt = 1; ; attempt++) {
    await h.userClick(page, selector);
    const ok = await h.until(there, `the user's keys to go to ${selector}`, 5000).catch(e => (attempt === 4 ? Promise.reject(e) : false));
    if (ok) {
      break;
    }
  }
  await h.userPress(page, ...keys);
}

/**
 * The user moves the pointer over the page, and the page's code hears it.
 * Pointer moves pass every hold, and reach the page after the user's input
 * sent before them: what the page hadn't heard by then, it never will.
 */
let moves = 0;
async function userMoved(page) {
  const before = await h.asUser(
    page,
    `if (!window.__moves) { window.__moves = { n: 0 }; window.addEventListener("mousemove", () => window.__moves.n++, true); }
     return window.__moves.n;`
  );
  moves++;
  await chrome(
    `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
     const r = browser.getBoundingClientRect();
     // A card of zen-ux's may cover part of the page: the first point that's
     // the page's, a few pixels off the last move's.
     const jitter = (arg.moves % 5) * 2;
     const at = [[0.5, 0.5], [0.25, 0.35], [0.75, 0.35], [0.5, 0.2], [0.3, 0.65], [0.7, 0.65]]
       .map(([fx, fy]) => [r.x + r.width * fx + jitter, r.y + r.height * fy + jitter])
       .find(([x, y]) => win.document.elementFromPoint(x, y) === browser);
     if (!at) {
       const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
       const there = win.document.elementsFromPoint(x, y).slice(0, 3).map(e => e.localName + (e.id ? "#" + e.id : "")).join(" > ");
       throw new Error("the page isn't under the pointer anywhere: at its middle, " + there);
     }
     win.synthesizeMouseEvent("mousemove", at[0], at[1], { button: 0, buttons: 0 }, { isDOMEventSynthesized: false });
     return true;`,
    { ...where(page), moves }
  );
  await h.until(async () => (await h.asUser(page, "return window.__moves.n")) > before, "the user's pointer move to reach the page");
}

/**
 * Evidence against the page's current top document (zen-observe's
 * markEvident), with `reason`: hooked, as its world marks what the agent's
 * code left there, and written too, as the world marks that until written
 * retires (zen-core's real clean copy reads written until its switch);
 * listed, as zen-core's list check; flagged, as the agent's own flag.
 */
async function flagEvident(page, reason = "hooked", detail = "a script element") {
  await chrome(
    `${SERVICE} ${WORLD} ${EVIDENCE} const { browser } = ZeniusService.resolvePage(arg.P);
     const bc = browser.browsingContext;
     if (arg.reason === "hooked") AW.noteWritten(bc, [bc.currentWindowGlobal.innerWindowId]);
     return EV.markEvident(bc, arg.reason, arg.detail);`,
    { P: where(page), reason, detail }
  );
  await h.until(async () => reason in (await evidenceInPage(page)), `the page's process to see the evidence (${reason})`);
}

/** The page's evidence, as its own process reads it (content/evidence.sys.mjs). */
const evidenceInPage = page =>
  inPageAsChrome(page, `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/evidence.sys.mjs").evidenceOf(actor.contentWindow);`);

/** zen-observe's written flag, which the guard doesn't read since the switch to evidence. */
const writtenFlag = page => chrome(`${SERVICE} ${WORLD} return AW.isWritten(ZeniusService.resolvePage(arg).browser);`, where(page));
/** The page's evidence, as the parent holds it. */
const evidenceOf = page => chrome(`${SERVICE} ${EVIDENCE} return EV.evidenceOf(ZeniusService.resolvePage(arg).browser);`, where(page));

/** Privileged code in the page's process, with `actor` as dev#evalContent gives it. */
const inPageAsChrome = (page, code) =>
  chrome(
    `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
     return ZeniusService.content(browser.browsingContext, "dev#evalContent", { code: arg.code, privileged: true });`,
    { ...where(page), code }
  );
/** zen-observe's evidence flag in the page's process: "clean", "drop" (a page the agent made) or null. */
const pageFlag = page =>
  inPageAsChrome(page, `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/evidence.sys.mjs").evidenceFlag(actor.contentWindow);`);

/**
 * The agent takes its Space back, as after the user approved: the user's
 * input in a task page took it over (manual_takeover). Their last input
 * holds a takeOver for 10 s (zen-core's rule): age it first.
 */
async function takeBack(page) {
  await chrome(
    `const s = ctx.spaces.peek(arg);
     if (typeof s?.lastUserInputAt === "number") s.lastUserInputAt -= 10000;
     return true;`,
    page.spaceId
  );
  return h.call("spaces.takeOver", { space: page.spaceId });
}

async function letAgentGoOn(page) {
  await chrome(
    `${SERVICE} ${UI}
     const rec = ZeniusService.spaces.peek(arg);
     if (UI.takeover.promptState(arg)) UI.takeover.resolve(arg, "continue");
     if (rec.paused) UI.resumeByUser(rec);
     return true;`,
    page.spaceId
  );
}

/** zen-ux's hook and zen-core's reload, as stand-ins that record their calls. */
const listen = () =>
  chrome(
    `${SERVICE} ${TYPING}
     win.__zeniusTypingOff?.();
     win.__zeniusTyping = [];
     win.__zeniusTypingOff = T.onUserTyping(e => win.__zeniusTyping.push({ trigger: e.trigger, reloaded: !!e.reloaded }));
     win.__zenInputCleanCalls = [];
     if (!("__zenInputCleanWas" in win)) win.__zenInputCleanWas = Object.getOwnPropertyDescriptor(ZeniusService, "cleanOnDemand") ?? null;
     ZeniusService.cleanOnDemand = browser => { win.__zenInputCleanCalls.push(browser.browserId); return new Promise(() => {}); };
     return true;`
  );
const unlisten = () =>
  chrome(
    `${SERVICE}
     win.__zeniusTypingOff?.();
     win.__zeniusTypingOff = null;
     const was = win.__zenInputCleanWas;
     delete win.__zenInputCleanWas;
     if (was) Object.defineProperty(ZeniusService, "cleanOnDemand", was); else delete ZeniusService.cleanOnDemand;
     return true;`
  );

async function inWatchedPage(url, fn) {
  const page = await h.newPageAt(task, url);
  const back = await h.watch(page);
  await listen();
  try {
    await fn(page);
  } finally {
    await unlisten().catch(() => {});
    await letAgentGoOn(page).catch(() => {});
    await takeBack(page).catch(() => {});
    await back();
    await page.close().catch(() => {});
  }
}

test("in a page with evidence, the user's press into a field is stopped whole, the focus stays, and zen-core is asked for a clean copy", () =>
  inWatchedPage(formsUrl("press"), async page => {
    // The agent's own typing there is no trigger.
    await page.fill("#email", "agent@example.com");
    await page.click("[name=nickname]");
    await h.asUser(page, LISTEN());
    await flagEvident(page);
    const id = await browserIdOf(page);

    await h.userClick(page, "#email");
    await someTrigger();
    await userMoved(page);
    assert.deepEqual(await triggers(), [{ trigger: "press", reloaded: true }], "zen-ux heard the user's press");
    assert.deepEqual(await heard(page), [], "the page heard nothing of the press");
    assert.equal(await activeId(page), "nickname", "the focus stayed where it was");
    assert.deepEqual(await cleanCalls(), [id], "zen-core was asked for a clean copy, once");

    await h.userPress(page, "a", "b");
    await userMoved(page);
    assert.deepEqual(await heard(page), [], "nor any key after it, wherever it went");
    assert.deepEqual(await h.asUser(page, "return [email.value, document.querySelector('[name=nickname]').value]"), ["agent@example.com", ""]);
    // Nor a press on what isn't a text field: nothing of the user's reaches
    // the page until its clean copy is in (the manager's change).
    await h.userClick(page, "#mixed");
    await userMoved(page);
    assert.deepEqual(await heard(page), [], "nor a click after it");
    assert.deepEqual(await h.asUser(page, "return [mixed.checked, mixed.indeterminate]"), [false, true], "the checkbox didn't change");
    assert.equal((await triggers()).length, 1, "one trigger for the document");
    assert.deepEqual(await cleanCalls(), [id]);
  }));

test("in a page with evidence, the user's first press anywhere, not only into a field, is the trigger, and nothing of theirs after it reaches the page", () =>
  inWatchedPage(formsUrl("anywhere"), async page => {
    await page.click("[name=nickname]");
    await h.asUser(page, LISTEN());
    await flagEvident(page);
    const id = await browserIdOf(page);

    // The heading: no field, and nothing a press there would focus.
    await h.userClick(page, "h1");
    await someTrigger();
    await userMoved(page);
    assert.deepEqual(await triggers(), [{ trigger: "press", reloaded: true }]);
    assert.deepEqual(await heard(page), [], "the page heard nothing of the press");
    assert.equal(await activeId(page), "nickname", "the focus stayed where it was");
    assert.deepEqual(await cleanCalls(), [id], "zen-core was asked for a clean copy");

    await h.userClick(page, "#email");
    await h.userPress(page, "Tab", "x", "Enter");
    await userMoved(page);
    assert.deepEqual(await heard(page), [], "nor any press or key after it");
    assert.equal(await activeId(page), "nickname");
    assert.deepEqual(await h.asUser(page, "return [email.value, document.querySelector('[name=nickname]').value]"), ["", ""]);
    assert.equal((await triggers()).length, 1, "one trigger for the document");
  }));

test("in a page with evidence, the user's first key with no field focused is the trigger too", () =>
  inWatchedPage(formsUrl("key-anywhere"), async page => {
    await flagEvident(page);
    await h.asUser(page, LISTEN());
    assert.equal(await activeId(page), "body", "no field has the focus");
    await h.userPress(page, "ArrowDown", "Space");
    await someTrigger();
    await userMoved(page);
    assert.deepEqual(await triggers(), [{ trigger: "key", reloaded: true }]);
    assert.deepEqual(await heard(page), [], "the page heard neither key");
  }));

test("in a page with evidence, the user's first key into a field the page focused itself is stopped, and that focus set off nothing", () =>
  inWatchedPage(formsUrl("key"), async page => {
    await flagEvident(page);
    await h.asUser(page, LISTEN("[name=nickname]"));
    await h.sleep(200);
    assert.deepEqual(await triggers(), [], "focus without the user's press is no trigger");
    await h.userPress(page, "x", "y");
    await someTrigger();
    await userMoved(page);
    assert.deepEqual(await triggers(), [{ trigger: "key", reloaded: true }]);
    assert.deepEqual(await heard(page), [], "the page's code heard neither key");
    assert.equal(await valueOf(page, "[name=nickname]"), "");
  }));

test("the replay's own keys never set off a hold, though the page they go into has evidence (zen-core's reload loop, 2026-11-21)", () =>
  inWatchedPage(formsUrl("replay-own"), async page => {
    // A clean copy can be born with evidence (a listed site, or a hooked
    // popup or opener in its group): the replay's keys there must not hold,
    // load afresh and replay again, without end.
    await flagEvident(page);
    await h.asUser(page, LISTEN("[name=nickname]"));
    const after = await inPageAsChrome(
      page,
      `const T = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/typing.sys.mjs");
       const win = actor.contentWindow;
       const field = win.document.querySelector("[name=nickname]");
       const typed = T.typeAgainForTest(win, field, [{ key: "a", code: "KeyA", keyCode: 65 }, { key: "b", code: "KeyB", keyCode: 66 }]);
       return { typed, held: T.typingHeld(win.browsingContext) };`
    );
    assert.deepEqual(after, { typed: 2, held: false }, "the replay typed both keys and held nothing");
    assert.equal(await valueOf(page, "[name=nickname]"), "ab");
    await userMoved(page);
    assert.deepEqual(await triggers(), [], "no trigger reached zen-ux");
    assert.deepEqual(await cleanCalls(), [], "zen-core was asked for no clean copy");
    // The user's own key there still is the trigger.
    await h.userPress(page, "c");
    await someTrigger();
    assert.deepEqual(await triggers(), [{ trigger: "key", reloaded: true }]);
    assert.equal(await valueOf(page, "[name=nickname]"), "ab", "the user's own key was stopped");
  }));

test("in a page with evidence, the user's IME composition into a field never reaches the page", () =>
  inWatchedPage(formsUrl("ime"), async page => {
    await flagEvident(page);
    await h.asUser(page, LISTEN("[name=nickname]"));
    await chrome(
      `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
       browser.focus();
       const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
       if (!tip.beginInputTransactionForTests(win)) throw new Error("no input transaction");
       tip.setPendingCompositionString("か");
       tip.appendClauseToPendingComposition(1, tip.ATTR_RAW_CLAUSE);
       tip.flushPendingComposition();
       tip.commitComposition();
       return true;`,
      where(page)
    );
    await someTrigger();
    assert.deepEqual(await triggers(), [{ trigger: "composition", reloaded: true }]);
    assert.deepEqual(await heard(page), [], "the page's code heard nothing of it");
    assert.equal(await valueOf(page, "[name=nickname]"), "", "nothing went into the field");
  }));

test("in a page with evidence, the user's paste or drop into a field never reaches the page", async () => {
  for (const [kind, make] of [
    [
      "paste",
      `const w = actor.contentWindow;
       w.document.querySelector("[name=nickname]").focus();
       const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
       t.init(null);
       t.addDataFlavor("text/plain");
       const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
       s.data = "secret";
       t.setTransferData("text/plain", s);
       w.windowUtils.sendContentCommandEvent("pasteTransferable", t);
       return true;`,
    ],
    [
      "drop",
      `const w = actor.contentWindow;
       const ev = new w.DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: new w.DataTransfer() });
       ev.dataTransfer.setData("text/plain", "secret");
       return w.windowUtils.dispatchDOMEventViaPresShellForTesting(w.document.querySelector("[name=nickname]"), ev);`,
    ],
  ]) {
    await inWatchedPage(formsUrl(kind), async page => {
      await flagEvident(page);
      await h.asUser(page, LISTEN());
      // The trusted events the user's own paste or drop makes, sent by no
      // call of zenius's: the editor's paste of a transferable (no
      // clipboard), and a drop through the presshell's test dispatch, which
      // marks it trusted.
      await inPageAsChrome(page, make);
      await someTrigger();
      assert.deepEqual(await triggers(), [{ trigger: kind, reloaded: true }]);
      assert.deepEqual(await heard(page), [], `${kind}: the page's code didn't hear it`);
      assert.equal(await valueOf(page, "[name=nickname]"), "", `${kind}: nothing went into the field`);
    });
  }
});

test("while the user's input is held, zenius's own clicks, typing and paste go in", () =>
  inWatchedPage(formsUrl("passes"), async page => {
    await flagEvident(page);
    await h.asUser(page, LISTEN());
    await h.userClick(page, "[name=nickname]");
    await someTrigger();
    await heard(page);
    // The user lets the agent go on (Resume agent at the takeover prompt).
    await letAgentGoOn(page);
    await page.click("[name=nickname]");
    await page.keyboard.type("agent");
    await page.keyboard.paste(" pasted");
    assert.equal(await valueOf(page, "[name=nickname]"), "agent pasted");
    const agentHeard = await heard(page);
    assert.ok(agentHeard.includes("keydown") && agentHeard.includes("paste"), `the page heard the agent's keys and paste: ${agentHeard}`);
    assert.equal((await triggers()).length, 1, "zenius's input set off nothing");
  }));

test("the hold ends with the document: the next one is unflagged, and the user's typing goes in", () =>
  inWatchedPage(formsUrl("ends"), async page => {
    await flagEvident(page);
    await h.asUser(page, LISTEN("#email"));
    await h.userPress(page, "x");
    await someTrigger();
    await letAgentGoOn(page);
    // As zen-core's clean copy: a new document.
    await page.goto(formsUrl("ends-next"));
    assert.equal(await pageFlag(page), null, "the new document carries no flag");
    await h.asUser(page, LISTEN("#email"));
    await h.userPress(page, "o", "k");
    await h.until(async () => (await valueOf(page, "#email")) === "ok", "the user's keys in the new document");
    assert.ok((await heard(page)).includes("keydown"), "the new document's code heard them");
    assert.equal((await triggers()).length, 1, "the new document set off nothing");
  }));

test("a page the agent made keeps the user's typing on: no trigger, nothing stopped (the user's decision)", () =>
  inWatchedPage(formsUrl("made"), async page => {
    await page.goto("data:text/html,<input id=f>");
    await h.until(async () => (await pageFlag(page)) === "drop", "zen-observe's made flag");
    await h.asUser(page, LISTEN());
    await userTypes(page, "#f", "a");
    await h.until(async () => (await valueOf(page, "#f")) === "a", "the user's key in the field", 30_000);
    const pageHeard = await heard(page);
    assert.ok(pageHeard.includes("mousedown") && pageHeard.includes("keydown"), `the page heard the user's press and key: ${pageHeard}`);
    assert.deepEqual(await triggers(), [], "no trigger");
    assert.deepEqual(await cleanCalls(), []);
  }));

test("a page the agent's code wrote into, leaving nothing hooked, keeps the user's input on: no trigger, nothing stopped", () =>
  inWatchedPage(formsUrl("unhooked"), async page => {
    // The agent's own page code, as in the Cloudflare case: a value, an
    // attribute, text, a class and a style on elements already there, an
    // event and a click. It made the page written (zen-observe's old flag),
    // and none of it is evidence.
    const filled = await h.call("page.evaluate", {
      ...where(page),
      isFunction: false,
      fn: `(() => {
        const nick = document.querySelector("[name=nickname]");
        nick.setAttribute("value", "agent");
        nick.value = "agent";
        nick.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("label[for=email]").textContent = "Work email";
        document.body.classList.add("filled");
        document.body.style.outline = "1px solid green";
        document.querySelector("[name=terms]").click();
        return nick.value;
      })()`,
    });
    assert.equal(filled, "agent");
    assert.equal(await writtenFlag(page), true, "written, which the guard no longer reads");
    assert.deepEqual(await evidenceOf(page), {}, "no evidence");
    assert.equal(await pageFlag(page), null);
    await h.asUser(page, LISTEN());
    await userTypes(page, "#email", "o", "k");
    await h.until(async () => (await valueOf(page, "#email")) === "ok", "the user's keys in the field", 30_000);
    const pageHeard = await heard(page);
    assert.ok(pageHeard.includes("mousedown") && pageHeard.includes("keydown"), `the page heard the user's press and keys: ${pageHeard}`);
    assert.deepEqual(await triggers(), [], "no trigger");
    assert.deepEqual(await cleanCalls(), [], "no clean copy");
  }));

test("only hooked evidence holds the user's input: a listed or flagged page leaves it on, for zen-ux's warning (the manager's call)", async () => {
  for (const [reason, detail] of [
    ["listed", "goog-phish-proto"],
    ["flagged", "it asks for the card's PIN"],
  ]) {
    await inWatchedPage(formsUrl(`reason-${reason}`), async page => {
      await flagEvident(page, reason, detail);
      assert.deepEqual(await evidenceOf(page), { [reason]: detail });
      await h.asUser(page, LISTEN());
      await userTypes(page, "#email", "o", "k");
      await h.until(async () => (await valueOf(page, "#email")) === "ok", `${reason}: the user's keys in the field`, 30_000);
      const pageHeard = await heard(page);
      assert.ok(pageHeard.includes("mousedown") && pageHeard.includes("keydown"), `${reason}: the page heard the user: ${pageHeard}`);
      assert.deepEqual(await triggers(), [], `${reason}: no trigger`);
      assert.deepEqual(await cleanCalls(), [], `${reason}: no clean copy`);
    });
  }
  // Hooked beside them: the press is held.
  await inWatchedPage(formsUrl("reason-hooked"), async page => {
    await flagEvident(page, "listed", "goog-phish-proto");
    await flagEvident(page, "hooked", "a script element");
    await h.asUser(page, LISTEN());
    await h.userClick(page, "[name=nickname]");
    await someTrigger();
    assert.deepEqual(await triggers(), [{ trigger: "press", reloaded: true }]);
    assert.deepEqual(await cleanCalls(), [await browserIdOf(page)], "zen-core was asked for a clean copy");
    assert.deepEqual(await heard(page), [], "the page's code heard nothing");
  });
});

test("the agent's paste of plain markup leaves the user's input on; a paste whose markup carries a form holds it", () =>
  inWatchedPage(formsUrl("paste-evidence"), async page => {
    await page.click("#editor");
    await page.keyboard.paste({ text: "bold", html: "<p>Dear <b>team</b>, <a href='https://example.com/'>the notes</a></p>" });
    assert.match(await h.asUser(page, `return document.querySelector("#editor").innerHTML`), /<b>team<\/b>/, "the html went in");
    assert.deepEqual(await evidenceOf(page), {}, "plain markup is no evidence");
    assert.equal(await pageFlag(page), null);
    // The editor is far down the page: back to its fields, for the user.
    await toTop(page);
    await h.asUser(page, LISTEN());
    await userTypes(page, "#email", "o", "k");
    await h.until(async () => (await valueOf(page, "#email")) === "ok", "the user's keys in the field", 30_000);
    assert.deepEqual(await triggers(), [], "no trigger after a plain paste");

    // The agent takes the Space back, and pastes a form.
    await letAgentGoOn(page);
    await takeBack(page).catch(() => {});
    await page.click("#editor");
    await page.keyboard.paste({ text: "sign in", html: "<form action='/x'><input type=password name=p></form>" });
    await h.until(async () => "hooked" in (await evidenceInPage(page)), "the page's process to see the paste's evidence");
    assert.deepEqual(await evidenceOf(page), { hooked: "a paste with a form" });
    await toTop(page);
    await heard(page);
    await h.userClick(page, "[name=nickname]");
    await someTrigger();
    assert.deepEqual(await triggers(), [{ trigger: "press", reloaded: true }]);
    assert.deepEqual(await cleanCalls(), [await browserIdOf(page)]);
    assert.deepEqual(await heard(page), [], "the page's code heard nothing of the press");
  }));

test("a page with evidence the user keeps after the task still keeps their typing out", async () => {
  // zen-core's landing (2) reloads a written page at its task's end (one with
  // evidence, after its switch); with its quiet loads off (as for the
  // hand-off's other layers) the page stays as it was (glue by zen-core).
  await chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
  const { id: space } = await h.call("spaces.create", { name: `zen-input kept ${Date.now() % 100000}` });
  const mark = `zen-input-kept-${Date.now()}`;
  let finished = false;
  /** Chrome code with `tab`, `browser` and `tabWin` for the kept page, in whichever window it went to. */
  const kept = code =>
    chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const tab = [...W.allTabs()].find(t => t.getAttribute("zen-input-kept") === arg);
       if (!tab) throw new Error("the kept page is gone");
       const browser = tab.linkedBrowser;
       const tabWin = tab.ownerDocument.defaultView;
       ${code}`,
      mark
    );
  const keptPage = code =>
    kept(`${SERVICE} return ZeniusService.content(browser.browsingContext, "dev#evalContent", { code: ${JSON.stringify(code)}, privileged: false });`);
  await listen();
  try {
    const P = { space, page: "p1" };
    // Another site than the other task pages', so no task page keeps its
    // process armed after the task: its evidence must.
    await h.call("page.goto", { ...P, url: formsUrl("kept").replace("//127.0.0.1:", "//localhost:") });
    await chrome(
      `${WORLD} ${EVIDENCE} const { tab, browser } = ctx.resolvePage(arg.P);
       tab.setAttribute("zen-input-kept", arg.mark);
       AW.noteWritten(browser.browsingContext, [browser.browsingContext.currentWindowGlobal.innerWindowId]);
       EV.markEvident(browser.browsingContext, "hooked", "a script element");
       return true;`,
      { P, mark }
    );
    await h.call("spaces.finish", { space, keep: ["p1"] });
    finished = true;
    const browserId = await kept("return browser.browserId;");
    // The task's end has reached the page's process: its guard stays.
    await h.sleep(1000);
    const armed = await kept(
      `${SERVICE} return ZeniusService.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: ${JSON.stringify(
        `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/capture.sys.mjs").isArmed(actor.docShell.chromeEventHandler);`
      )} });`
    );
    assert.equal(armed, true, "the kept page's process is still armed");
    await keptPage(LISTEN("[name=nickname]"));
    // Keys into the field the page focused, as trusted as the user's and
    // sent by no call of zenius's: an input processor in the page's own
    // process, so the user's view (another tab) stays as it is.
    await kept(
      `${SERVICE} return ZeniusService.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: ${JSON.stringify(`const w = actor.contentWindow;
         const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
         if (!tip.beginInputTransactionForTests(w)) throw new Error("no input transaction");
         for (const key of ["s", "e"]) { const ev = new w.KeyboardEvent("", { key }); tip.keydown(ev); tip.keyup(ev); }
         return true;`)} });`
    );
    await someTrigger();
    assert.deepEqual(await triggers(), [{ trigger: "key", reloaded: true }]);
    assert.deepEqual(await cleanCalls(), [browserId], "zen-core was asked for a clean copy");
    assert.deepEqual(await keptPage("return window.__heard.splice(0)"), [], "the kept page's code heard nothing");
    assert.equal(await keptPage("return document.querySelector('[name=nickname]').value"), "");
  } finally {
    await unlisten().catch(() => {});
    if (!finished) {
      await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    } else {
      await kept(`tabWin.gBrowser.removeTab(tab); return true;`).catch(() => {});
    }
    await chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
  }
});

test("zen-core's dropUserTyping holds the user's typing in a page until released, and holds nest", () =>
  inWatchedPage(formsUrl("hold"), async page => {
    // A page with no evidence: the user's typing goes in, and sets off nothing.
    await userTypes(page, "#email", "a");
    await h.until(async () => (await valueOf(page, "#email")) === "a", "the user's first key", 30_000);
    const seesHold = () => inPageAsChrome(page, `return !!Services.cpmm.sharedData.get("zenius:typingHeldTabs")?.has(actor.browsingContext.browserId);`);
    const hold = () =>
      chrome(`${SERVICE} ${TYPING} const { browser } = ZeniusService.resolvePage(arg); (win.__zenInputHolds ??= []).push(T.dropUserTyping(browser)); return true;`, where(page));
    const release = () => chrome(`win.__zenInputHolds.shift()(); return true;`);
    try {
      await hold();
      await hold();
      await h.until(seesHold, "the page's process to see the hold");
      await h.userPress(page, "b");
      // zen-core's hold drops typing only: the user's presses pass.
      await h.userClick(page, "[name=nickname]");
      await h.until(async () => (await activeId(page)) === "nickname", "the user's click in the held tab");
      assert.equal(await valueOf(page, "#email"), "a", "the key before it went nowhere");
      await h.userClick(page, "#email");
      await h.until(async () => (await activeId(page)) === "email", "the user's click back");
      await release();
      await h.userPress(page, "c");
      assert.equal(await valueOf(page, "#email"), "a", "held while either hold is on");
      await release();
      await h.until(async () => !(await seesHold()), "the page's process to see the release");
      await h.userPress(page, "d");
      await h.until(async () => (await valueOf(page, "#email")) === "ad", "the user's key after the release");
      assert.deepEqual(await triggers(), [], "a page with no evidence sets off nothing");
    } finally {
      await chrome(`for (const release of win.__zenInputHolds?.splice(0) ?? []) release(); return true;`).catch(() => {});
    }
  }));

test("zen-core's failed release keeps the user's typing out of the document the hold began in, until another replaces it", () =>
  inWatchedPage(formsUrl("failed"), async page => {
    await userTypes(page, "#email", "a");
    await h.until(async () => (await valueOf(page, "#email")) === "a", "the user's first key", 30_000);
    const held = () =>
      inPageAsChrome(page, `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/typing.sys.mjs").typingHeld(actor.browsingContext);`);
    const browserId = await browserIdOf(page);
    const doc = await chrome(`${SERVICE} return ZeniusService.resolvePage(arg).browser.browsingContext.currentWindowGlobal.innerWindowId;`, where(page));
    try {
      await chrome(`${SERVICE} ${TYPING} const { browser } = ZeniusService.resolvePage(arg); win.__zenInputFailed = T.dropUserTyping(browser); return true;`, where(page));
      // As the hand-off when no new document came in time.
      await chrome(`win.__zenInputFailed({ failed: true }); win.__zenInputFailed = null; return true;`);
      const holds = await chrome(`${TYPING} return T.typingHolds();`);
      assert.ok(!holds.tabs.includes(browserId), "the tab's hold went");
      assert.ok(holds.docs.includes(doc), "its document's hold stayed");
      await h.until(held, "the page's process to see the document's hold");
      await h.asUser(page, LISTEN());
      await h.userPress(page, "b");
      await h.userClick(page, "[name=nickname]");
      await userMoved(page);
      assert.deepEqual(await heard(page), [], "nothing of the user's reached the document");
      assert.equal(await valueOf(page, "#email"), "a", "the key went nowhere");
      assert.equal(await activeId(page), "email", "nor did the click");
      await letAgentGoOn(page);
      await page.goto(formsUrl("failed-next"));
      assert.equal(await held(), false, "the next document is free");
      await userTypes(page, "#email", "c");
      await h.until(async () => (await valueOf(page, "#email")) === "c", "the user's key in the next document", 30_000);
      assert.deepEqual(await triggers(), [], "zen-core's hold tells zen-ux nothing");
    } finally {
      await chrome(`win.__zenInputFailed?.(); win.__zenInputFailed = null; return true;`).catch(() => {});
    }
  }));

// ------------------------------------------------- the clean copy's replay
// The keys the user types while a page with evidence loads afresh are typed again
// into its clean copy, in the field they went for (the manager's rule,
// 2026-11-20). zen-core's real clean copy, from a site whose second load of
// a page is slow: the user's keys come while it loads.

const REPLAY_FIELD_USER = `<input id="user" name="user" autocomplete="off">`;
const REPLAY_PAGE = `<!doctype html><meta charset="utf-8"><title>replay</title>
<body data-load="%LOAD%">
<form id="f" action="/sent" method="get">
  ${REPLAY_FIELD_USER}
  <input id="pass" name="pass" type="password" autocomplete="off">
  <button id="go">Go</button>
</form>
<p id="text">Text the user may press.</p>
%EXTRA%
<script>
  // The site's own code, which runs in the clean copy: what its fields hear as typing.
  for (const id of ["user", "pass"]) {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => el.setAttribute("data-typed", el.value));
  }
  document.getElementById("f").addEventListener("submit", e => {
    e.preventDefault();
    document.documentElement.setAttribute("data-submitted", "1");
  });
</script>`;

/**
 * A site of the test's own on loopback. Each page's first load is quick;
 * from its second on (zen-core's clean copy) it waits `slowMs`, and is
 * `again`. `slowLoadMs` holds the clean copy's load event back that much
 * more, behind an image.
 */
async function withReloadSite(fn, { slowMs = 1000, again = REPLAY_PAGE, slowLoadMs = 0 } = {}) {
  const loads = new Map();
  const server = createServer((req, res) => {
    if (req.url.startsWith("/slow.png")) {
      setTimeout(() => res.writeHead(404, { "cache-control": "no-store" }).end(), slowLoadMs);
      return;
    }
    if (!req.url.startsWith("/form")) {
      res.writeHead(404).end();
      return;
    }
    const n = (loads.get(req.url) ?? 0) + 1;
    loads.set(req.url, n);
    const extra = n > 1 && slowLoadMs ? `<img src="/slow.png?${Date.now()}" alt="">` : "";
    const send = () => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end((n === 1 ? REPLAY_PAGE : again).replace("%LOAD%", String(n)).replace("%EXTRA%", extra));
    };
    if (n === 1) {
      send();
    } else {
      setTimeout(send, slowMs);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn((name, host = "127.0.0.1") => `http://${host}:${port}/form?${name}-${Date.now()}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

/** A watched task page at `url`, hooked (and written, see flagEvident), with zen-core's real clean copy. */
async function inEvidentPage(url, fn) {
  const page = await h.newPageAt(task, url);
  const back = await h.watch(page);
  try {
    await flagEvident(page);
    await fn(page);
  } finally {
    await letAgentGoOn(page).catch(() => {});
    await takeBack(page).catch(() => {});
    await back();
    await page.close().catch(() => {});
  }
}

const FIELDS = `const u = document.getElementById("user");
  const p = document.getElementById("pass");
  return {
    load: document.body?.dataset.load ?? null,
    user: u ? u.value : null,
    pass: p ? p.value : null,
    typed: [u?.getAttribute("data-typed") ?? null, p?.getAttribute("data-typed") ?? null],
    focus: document.activeElement?.id || null,
    submitted: document.documentElement.hasAttribute("data-submitted"),
  };`;
/** The replay page's fields, as the user sees them. */
const fields = page => h.asUser(page, FIELDS);

/** zen-core's clean copy is in, and its hold on the tab lifted. */
async function cleanCopyIn(page) {
  const id = await browserIdOf(page);
  await h.until(async () => (await fields(page)).load === "2", "the clean copy", 15_000);
  await h.until(async () => !(await chrome(`${TYPING} return T.typingHolds().tabs;`)).includes(id), "the clean copy's hold to lift");
}

/** Wait until the fields show `want`, then compare them whole. */
async function fieldsAre(page, want, what) {
  await h.until(async () => JSON.stringify(await fields(page)) === JSON.stringify(want), what, 5000).catch(() => {});
  assert.deepEqual(await fields(page), want, what);
}

/** The user's keys `ms` apart, entering through the parent like OS input. */
const userTypesPaced = (page, keys, ms) =>
  chrome(
    `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
     if (win.gBrowser.selectedBrowser !== browser) throw new Error("the page isn't shown");
     browser.focus();
     const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
     if (!tip.beginInputTransactionForTests(win)) throw new Error("no input transaction");
     for (const key of arg.keys) {
       const ev = new win.KeyboardEvent("", { key });
       tip.keydown(ev);
       tip.keyup(ev);
       await new Promise(resolve => win.setTimeout(resolve, arg.ms));
     }
     return true;`,
    { ...where(page), keys, ms }
  );

/**
 * The user's next keydown of `key` to the page's tab stops at the parent:
 * the parent routes it, and no document gets it. Gecko does that to a key
 * typed at the very moment a clean copy commits (a chrome listener that
 * cancels a key keeps it from content too).
 */
const keyReachesNoDocument = (page, key) =>
  chrome(
    `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
     const onKey = e => {
       if (e.target === browser && e.key === arg.key) {
         e.preventDefault();
         win.removeEventListener("keydown", onKey, true);
       }
     };
     win.addEventListener("keydown", onKey, true);
     return true;`,
    { ...where(page), key }
  );

/** A chord of the user's, entering through the parent like OS input: `mods` held around `key`. */
const userChord = (page, mods, key) =>
  chrome(
    `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
     if (win.gBrowser.selectedBrowser !== browser) throw new Error("the page isn't shown");
     browser.focus();
     const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
     if (!tip.beginInputTransactionForTests(win)) throw new Error("no input transaction");
     const mods = arg.mods.map(m => new win.KeyboardEvent("", { key: m }));
     for (const m of mods) tip.keydown(m);
     const ev = new win.KeyboardEvent("", { key: arg.key });
     tip.keydown(ev);
     tip.keyup(ev);
     for (const m of mods.reverse()) tip.keyup(m);
     return true;`,
    { ...where(page), mods, key }
  );

const UNTOUCHED = { load: "2", user: "", pass: "", typed: [null, null], focus: "user", submitted: false };

test("the keys the user types while a page with evidence loads afresh are typed again into the field they pressed (zen-snapshot's 400 ms case)", () =>
  withReloadSite(urlFor =>
    inEvidentPage(urlFor("snapshot"), async page => {
      await h.userClick(page, "#user");
      await h.sleep(400);
      await h.userPress(page, "a", "b");
      assert.equal((await fields(page)).load, "1", "the keys came while the clean copy loaded");
      await cleanCopyIn(page);
      await fieldsAre(page, { ...UNTOUCHED, user: "ab", typed: ["ab", null] }, "the user's keys, typed again where they pressed, as the page's own typing");
    })
  ));

test("keys typed before the clean copy's arrival, during its hold and across the hold's end keep their order", () =>
  withReloadSite(
    urlFor =>
      inEvidentPage(urlFor("order"), async page => {
        const text = "abcdefghijklmnopqrstuvwxyz0123";
        await h.userClick(page, "#user");
        await h.sleep(100);
        // The user's typing pauses from before the clean copy commits until
        // it's in. A key that comes at the very moment it commits reaches no
        // document: Gecko drops it during the swap, before the page's or
        // zenius's listeners could see it, as a plain reload does. With keys
        // 15 ms apart, 2 or 3 runs of 12 lost the one at that moment
        // (2026-11-20). The parent's own record of the keys is for the
        // first update.
        await userTypesPaced(page, [...text.slice(0, 5)], 40);
        assert.equal((await fields(page)).load, "1", "the first keys came while the clean copy loaded");
        await h.until(async () => (await fields(page)).load === "2", "the clean copy", 15_000);
        await userTypesPaced(page, [...text.slice(5)], 50);
        await cleanCopyIn(page);
        await fieldsAre(page, { ...UNTOUCHED, user: text, typed: [text, null] }, "every key once, in order");
      }),
    { slowMs: 600 }
  ));

test("a key that reached no document as the clean copy came in is typed again in its place, from the parent's record", () =>
  withReloadSite(
    urlFor =>
      inEvidentPage(urlFor("order"), async page => {
        await h.userClick(page, "#user");
        await h.sleep(100);
        await userTypesPaced(page, [..."abc"], 40);
        await keyReachesNoDocument(page, "d");
        await userTypesPaced(page, [..."d"], 40);
        assert.equal((await fields(page)).load, "1", "the first keys came while the clean copy loaded");
        await h.until(async () => (await fields(page)).load === "2", "the clean copy", 15_000);
        await userTypesPaced(page, [..."efg"], 50);
        await cleanCopyIn(page);
        await fieldsAre(page, { ...UNTOUCHED, user: "abcdefg", typed: ["abcdefg", null] }, "every key once, in order");
      }),
    { slowMs: 600 }
  ));

test("a password field gets the user's keys again too, Backspace included", () =>
  withReloadSite(urlFor =>
    inEvidentPage(urlFor("password"), async page => {
      await h.userClick(page, "#pass");
      await h.sleep(300);
      await h.userPress(page, "s", "3", "c", "x", "Backspace", "r", "3", "t");
      await cleanCopyIn(page);
      await fieldsAre(page, { ...UNTOUCHED, pass: "s3cr3t", typed: [null, "s3cr3t"], focus: "pass" }, "the password, as typed");
    })
  ));

test("Enter or Tab ends the replay: the keys before it are typed, and it's neither typed nor sent", () =>
  withReloadSite(async urlFor => {
    for (const stop of ["Enter", "Tab"]) {
      await inEvidentPage(urlFor(stop), async page => {
        await h.userClick(page, "#user");
        await h.sleep(300);
        await h.userPress(page, "a", "b", stop, "c", "d");
        await cleanCopyIn(page);
        await userMoved(page);
        await fieldsAre(page, { ...UNTOUCHED, user: "ab", typed: ["ab", null] }, `the keys before ${stop}, and nothing of it or after it`);
      });
    }
  }));

test("an arrow key, a shortcut or more than 64 keys cancel the replay: nothing is typed", () =>
  withReloadSite(async urlFor => {
    const cases = {
      arrow: page => h.userPress(page, "a", "b", "ArrowLeft", "c"),
      shortcut: async page => {
        await h.userPress(page, "a", "b");
        await userChord(page, ["Control"], "a");
        await h.userPress(page, "c");
      },
      many: page => h.userPress(page, ..."x".repeat(65)),
    };
    for (const [name, typeIt] of Object.entries(cases)) {
      await inEvidentPage(urlFor(name), async page => {
        await h.userClick(page, "#user");
        await h.sleep(300);
        await typeIt(page);
        await cleanCopyIn(page);
        await userMoved(page);
        assert.deepEqual(await fields(page), UNTOUCHED, `${name}: nothing typed`);
      });
    }
  }));

test("a second press on the same field keeps the replay going; a press on another field ends it there", () =>
  withReloadSite(async urlFor => {
    await inEvidentPage(urlFor("again"), async page => {
      await h.userClick(page, "#user");
      await h.sleep(200);
      // No caret showed, so the user presses again.
      await h.userClick(page, "#user");
      await h.userPress(page, "a", "b");
      await cleanCopyIn(page);
      await fieldsAre(page, { ...UNTOUCHED, user: "ab", typed: ["ab", null] }, "a second press on the field");
    });
    await inEvidentPage(urlFor("other"), async page => {
      await h.userClick(page, "#user");
      await h.sleep(200);
      await h.userPress(page, "a", "b");
      await h.userClick(page, "#pass");
      await h.userPress(page, "c", "d");
      await cleanCopyIn(page);
      await userMoved(page);
      await fieldsAre(page, { ...UNTOUCHED, user: "ab", typed: ["ab", null] }, "the keys before the press on another field");
    });
  }));

test("no replay when the trigger press went for no field, or the clean copy lacks the field", () =>
  withReloadSite(
    async urlFor => {
      await inEvidentPage(urlFor("text"), async page => {
        await h.userClick(page, "#text");
        await h.sleep(300);
        await h.userPress(page, "a", "b");
        await cleanCopyIn(page);
        await userMoved(page);
        assert.deepEqual(await fields(page), { load: "2", user: null, pass: "", typed: [null, null], focus: null, submitted: false }, "a press on text");
      });
      await inEvidentPage(urlFor("gone"), async page => {
        await h.userClick(page, "#user");
        await h.sleep(300);
        await h.userPress(page, "a", "b");
        await cleanCopyIn(page);
        await userMoved(page);
        assert.deepEqual(await fields(page), { load: "2", user: null, pass: "", typed: [null, null], focus: null, submitted: false }, "no field to go back to");
      });
    },
    { again: REPLAY_PAGE.replace(REPLAY_FIELD_USER, "") }
  ));

test("a kept page's clean copy holds the keys the user types into it until their replay, though its task is over", async () => {
  // As in "a page with evidence the user keeps after the task": zen-core's
  // quiet loads off, so the task's end leaves the page as it was (glue by
  // zen-core).
  await chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
  const mark = `zen-input-kept-replay-${Date.now()}`;
  /** Chrome code with `tab` and `browser` for the kept page, in whichever window it went to. */
  const kept = code =>
    chrome(
      `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
       const tab = [...W.allTabs()].find(t => t.getAttribute("zen-input-kept") === arg);
       if (!tab) throw new Error("the kept page is gone");
       const browser = tab.linkedBrowser;
       ${code}`,
      mark
    );
  const keptPage = (code, privileged = false) =>
    kept(`${SERVICE} return ZeniusService.content(browser.browsingContext, "dev#evalContent", { code: ${JSON.stringify(code)}, privileged: ${privileged} });`);
  // Keys as trusted as the user's and sent by no call of zenius's, into the
  // page's current document from an input processor in its own process: the
  // user's view (another tab) stays as it is.
  const keys = (...list) =>
    keptPage(
      `const w = actor.contentWindow;
       const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
       if (!tip.beginInputTransactionForTests(w)) throw new Error("no input transaction");
       for (const key of ${JSON.stringify(list)}) { const ev = new w.KeyboardEvent("", { key }); tip.keydown(ev); tip.keyup(ev); }
       return true;`,
      true
    );
  const docOf = () => kept(`return browser.browsingContext.currentWindowGlobal?.innerWindowId ?? 0;`);
  let space = null;
  let finished = false;
  try {
    await withReloadSite(
      async urlFor => {
        ({ id: space } = await h.call("spaces.create", { name: `zen-input kept replay ${Date.now() % 100000}` }));
        const P = { space, page: "p1" };
        // Another site than the other task pages', so no task page keeps its
        // process armed after the task: only its evidence, then the hold.
        await h.call("page.goto", { ...P, url: urlFor("kept", "localhost") });
        await chrome(
          `${WORLD} ${EVIDENCE} const { tab, browser } = ctx.resolvePage(arg.P);
           tab.setAttribute("zen-input-kept", arg.mark);
           AW.noteWritten(browser.browsingContext, [browser.browsingContext.currentWindowGlobal.innerWindowId]);
           EV.markEvident(browser.browsingContext, "hooked", "a script element");
           return true;`,
          { P, mark }
        );
        await h.call("spaces.finish", { space, keep: ["p1"] });
        finished = true;
        const browserId = await kept("return browser.browserId;");
        await h.sleep(1000);
        const armed = await keptPage(
          `return ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/capture.sys.mjs").isArmed(actor.docShell.chromeEventHandler);`,
          true
        );
        assert.equal(armed, true, "the kept page's process is armed by its evidence");
        await keptPage(`document.getElementById("user").focus(); return true;`);
        const before = await docOf();
        // The user's first key is the trigger, and the replay's first.
        await keys("a");
        await keys("b", "c");
        // The clean copy is in, its load still held back behind its image:
        // what the user types now waits for the replay, after "abc".
        await h.until(async () => (await docOf()) !== before && (await keptPage(`return !!document.getElementById("user");`)), "the clean copy's document", 15_000);
        await keys("d", "e");
        await h.until(async () => !(await chrome(`${TYPING} return T.typingHolds().tabs;`)).includes(browserId), "the clean copy's hold to lift", 15_000);
        const value = () => keptPage(`return document.getElementById("user").value;`);
        await h.until(async () => (await value()) === "abcde", "the user's keys in the kept page's field", 5000).catch(() => {});
        assert.equal(await value(), "abcde", "the keys from before the clean copy, then those typed into it, in order");
      },
      { slowMs: 600, slowLoadMs: 1500 }
    );
  } finally {
    if (space && !finished) {
      await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    } else if (finished) {
      await kept(`tab.ownerDocument.defaultView.gBrowser.removeTab(tab); return true;`).catch(() => {});
    }
    await chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
  }
});
