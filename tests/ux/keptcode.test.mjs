// Pages a task left open. The agent's code
// runs in a sandbox that zenius discards at the task's end, so a kept page
// shows nothing: no mark, no tooltip line, no card, nothing heard, and
// nothing takes the focus or moves a view (I1). zenius makes it safe itself:
// - a page with evidence of danger (the observe layer's evidenceOf, a stand-in
//   here) loads afresh, quietly, when something the user just did there was
//   refused (the core's onKeptRefused, called directly here), through
//   the core's cleanLoad (a stand-in);
// - the input layer's guard has the core reload such a page before the user types
//   there (not the UI's: the input layer's suite tests it);
// - a page the agent made itself can't be cleaned so: its card, whose form
//   waits on the user's answer, says it might contain malicious code.
// ZeniusUI notes the kept pages the agent made (madePage, on the observe layer's
// real record here), for that card.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
});

after(async () => {
  await h?.chrome(`const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI; UI.cleanLoad = null; UI.evidenceOf = null; return true;`).catch(() => {});
  await h?.close();
});

const madeLine = "It might contain malicious code. Keep sensitive information out.";
/** A page the agent makes itself. */
const madeURL = "data:text/html,<title>Agent page</title><input id=x style='display:block;width:300px;height:40px'>";

// Chrome-side helpers: pages by browserId, which outlives their labels.
const K = `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
  const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
  const UI = UIM.ZeniusUI;
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const tabOf = bid => [...Win.uniqueTabs()].find(t => t.linkedBrowser?.browserId === bid) ?? null;
  // ZeniusUI's note: the agent made the page's document.
  const noted = bid => !!UI.madePage(tabOf(bid)?.linkedBrowser ?? null);
  // What would show it: a mark on the tab, a line in its tooltip.
  const shown = bid => {
    const t = tabOf(bid);
    return t.hasAttribute("zenius-agent-code") || t.ownerDocument.defaultView.gBrowser.getTabTooltip(t).includes("The agent ran its own code");
  };
  const cardOf = bid => N.noticeElement(tabOf(bid), "zenius-kept-code");
  const card = bid => {
    const el = cardOf(bid);
    return el ? { text: N.noticeText(tabOf(bid), "zenius-kept-code"), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: [...el.querySelectorAll("button")].map(b => b.textContent) } : null;
  };
  const docOf = bid => tabOf(bid)?.linkedBrowser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
  // The user's click on a card's button, once the card has armed (it ignores clicks for 400 ms).
  const press = async (el, label) => {
    await sleep(450);
    const b = [...(el?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);
    if (!b) throw new Error("no " + label + " button");
    b.click();
  };
  const inPage = (bid, code) => ctx.content(tabOf(bid).linkedBrowser.browsingContext, "dev#evalContent", { code });
  // The user's own click at (x, y) in the page in view, entering through the
  // parent as the OS's would.
  const userClick = (bid, x, y) => {
    const b = tabOf(bid).linkedBrowser;
    const w = b.ownerDocument.defaultView;
    const r = b.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      w.synthesizeMouseEvent(type, r.x + x, r.y + y, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
    }
  };
  // Firefox's announcer; announcements go out a moment after the first.
  const announcer = win.document.getElementById("a11y-announcement");
  const hush = async () => {
    await UIM.announcementsOut(win);
    announcer?.replaceChildren();
  };
  const heard = async () => {
    await UIM.announcementsOut(win);
    return announcer?.firstChild?.getAttribute("aria-label") ?? null;
  };
`;

/**
 * A task with a page on each of `urls` (key → url), the first its p1.
 * Returns its id, its name, and each page's label and browserId by key.
 */
async function task(name, urls) {
  const full = `UI kept ${name} ${run}`;
  const { id: space } = await h.createSpace({ name: full });
  const bids = {};
  const labels = {};
  for (const [i, [key, url]] of Object.entries(urls).entries()) {
    const label = i === 0 ? "p1" : (await h.call("pages.new", { space })).label;
    labels[key] = label;
    await h.call("page.goto", { space, page: label, url });
    bids[key] = await h.chrome(`return ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(label)} }).browser.browserId;`);
  }
  return { space, name: full, bids, labels };
}

/** The agent runs its own code in a page: the observe layer records its site. */
const agentCode = (space, page) => h.call("page.evaluate", { space, page, fn: "() => document.title", isFunction: true });
/** The agent's code adds a field to the page: the observe layer's world flags it hooked. */
const agentWrites = (space, page) =>
  h.call("page.evaluate", { space, page, fn: "() => { document.body.insertAdjacentHTML('beforeend', '<input id=zenius-agent-field>'); return true; }", isFunction: true });
/**
 * The core's quiet loads off: a page with evidence that stays open isn't reloaded
 * at its task's end, as when that reload fails. The core's closed-groups
 * tests do the same.
 */
const quietLoads = on =>
  h.chrome(`${on ? 'Services.prefs.clearUserPref("zenius.handoff.quietReload");' : 'Services.prefs.setBoolPref("zenius.handoff.quietReload", false);'} return true;`);

/** Where a field of the page is, in the page's coordinates (its center). */
const fieldAt = (space, page, selector) =>
  h.call("dev.evalContent", {
    space,
    page,
    privileged: false,
    code: `const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`,
  });

/** Close the tabs a test kept, in every window. */
const closeTabs = bids =>
  h.chrome(`${K}
    for (const bid of ${JSON.stringify(Object.values(bids))}) {
      const t = tabOf(bid);
      if (t) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
    }
    return true;
  `);

/** Show a task's page as the user's click would; back to their Space after. */
const view = bid =>
  h.chrome(`${K}
    const t = tabOf(${bid});
    Pages.landOn(t);
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    await until(() => gBrowser.selectedTab === t);
    return true;
  `);
const backToUser = () =>
  h.chrome(`
    if (gZenWorkspaces.activeWorkspace !== ${JSON.stringify(userView.windows[0].activeWorkspace)}) await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
    return true;
  `);

test("a task that ends keeping pages shows nothing on them: no mark, no tooltip line, no card, no focus taken or view moved; only the page the agent made is noted, not one its code ran in or one where it only clicked and typed", async () => {
  const { space, bids, labels } = await task("focus", { p1: `${h.base}/zoo/forms.html`, p2: `${h.base.replace("127.0.0.1", "localhost")}/zoo/forms.html`, p3: madeURL });
  try {
    await agentCode(space, labels.p1);
    // On p2's site the agent only clicks and types: no code of its own.
    await h.call("page.click", { space, page: labels.p2, target: "#email", options: {} });
    await h.call("page.fill", { space, page: labels.p2, target: "#email", value: "a@example.com", options: {} });
    const before = await h.call("dev.viewState");
    await h.call("spaces.finish", { space, keep: [labels.p1, labels.p2, labels.p3] });
    const out = await h.chrome(`${K}
      await until(() => noted(${bids.p3}));
      await sleep(300);
      const of = bid => ({ noted: noted(bid), shown: shown(bid), card: card(bid) });
      return { p1: of(${bids.p1}), p2: of(${bids.p2}), p3: of(${bids.p3}) };
    `);
    const after = await h.call("dev.viewState");
    assert.deepEqual(out.p1, { noted: false, shown: false, card: null }, "a page the agent's code ran in");
    assert.deepEqual(out.p2, { noted: false, shown: false, card: null }, "a page on a site where the agent ran no code");
    assert.deepEqual(out.p3, { noted: true, shown: false, card: null }, "the page the agent made");
    assert.deepEqual(after, before, "no focus taken, no view moved");
  } finally {
    await closeTabs(bids);
  }
});

test("the user's click into a field of a kept page the agent's code ran in shows nothing, and the focus stays in the field", async () => {
  const { space, bids, labels } = await task("remind", { p1: `${h.base}/zoo/forms.html` });
  try {
    await agentCode(space, labels.p1);
    // Where the field is, while the page is still the task's.
    const email = await fieldAt(space, labels.p1, "#email");
    await h.call("spaces.finish", { space, keep: [labels.p1] });
    await view(bids.p1);
    const out = await h.chrome(`${K}
      const b = tabOf(${bids.p1}).linkedBrowser;
      await hush();
      userClick(${bids.p1}, ${email[0]}, ${email[1]});
      await sleep(1000);
      return { noted: noted(${bids.p1}), card: card(${bids.p1}), heard: await heard(), focus: Services.focus.focusedElement === b };
    `);
    assert.deepEqual(out, { noted: false, card: null, heard: null, focus: true });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a kept page the agent made itself that asks for a password: as the user is about to type there, its card says it might contain malicious code, with a ✕ that hides it for that document; a refusal of what they just did there says what and why", async () => {
  const { space, bids, labels } = await task("made", {
    p1: `${h.base}/zoo/forms.html`,
    p2: "data:text/html,<title>Agent page</title><input id=x type=password style='display:block;width:300px;height:40px'>",
  });
  try {
    await agentCode(space, labels.p1);
    const field = await fieldAt(space, labels.p2, "#x");
    await h.call("spaces.finish", { space, keep: [labels.p1, labels.p2] });
    await view(bids.p2);
    const out = await h.chrome(`${K}
      await until(() => noted(${bids.p2}));
      userClick(${bids.p2}, ${field[0]}, ${field[1]});
      await until(() => cardOf(${bids.p2}));
      const res = { card: card(${bids.p2}) };
      await press(cardOf(${bids.p2}), "Dismiss");
      await until(() => !cardOf(${bids.p2}));
      userClick(${bids.p2}, ${field[0]}, ${field[1]});
      await sleep(1000);
      res.dismissed = card(${bids.p2});
      UI.keptRefused({ browser: tabOf(${bids.p2}).linkedBrowser, kind: "deviceAccess", asked: "camera" });
      await until(() => cardOf(${bids.p2}));
      res.refused = card(${bids.p2});
      return res;
    `);
    assert.deepEqual(out, {
      card: { text: "The agent made this page", note: madeLine, buttons: ["Dismiss"] },
      dismissed: null,
      refused: { text: "Camera blocked", note: "The agent made this page, and it might contain malicious code, so it can't use your camera.", buttons: ["Dismiss"] },
    });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

// The card comes only when the page asks for a password, a card's details or a
// one-time code, or the agent flagged it.
test("a kept page the agent made that asks for no secret: the user's click into its field shows nothing, and the focus stays in the field", async () => {
  const { space, bids, labels } = await task("plain", {
    p1: `${h.base}/zoo/forms.html`,
    p2: madeURL,
  });
  try {
    await agentCode(space, labels.p1);
    const field = await fieldAt(space, labels.p2, "#x");
    await h.call("spaces.finish", { space, keep: [labels.p1, labels.p2] });
    await view(bids.p2);
    const out = await h.chrome(`${K}
      await until(() => noted(${bids.p2}));
      userClick(${bids.p2}, ${field[0]}, ${field[1]});
      await sleep(1500);
      return { card: card(${bids.p2}), focused: Services.focus.focusedElement === tabOf(${bids.p2}).linkedBrowser };
    `);
    assert.deepEqual(out, { card: null, focused: true });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a refusal of what the user just did in a kept page with evidence of danger loads it afresh, quietly, through the core's cleanLoad: no card, nothing heard, no view moved; with no input of theirs just before, for the speakers, or in a page without evidence a clean copy clears (none, or a list's or the agent's flag), nothing happens", async () => {
  const { space, bids, labels } = await task("refused", { p1: `${h.base}/zoo/forms.html` });
  try {
    await agentCode(space, labels.p1);
    await h.call("spaces.finish", { space, keep: [labels.p1] });
    await view(bids.p1);
    const before = await h.call("dev.viewState");
    const out = await h.chrome(`${K}
      const b = tabOf(${bids.p1}).linkedBrowser;
      // The observe layer's evidence and the core's cleanLoad, standing in.
      UI.evidenceOf = target => (target === b ? { hooked: "a script element" } : {});
      const calls = [];
      UI.cleanLoad = async browser => {
        calls.push(browser.browserId);
        browser.reload();
        return { how: "reload" };
      };
      const res = {};
      // The page asks on its own: the user did nothing there.
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "camera" });
      await sleep(200);
      res.unasked = calls.length;
      userClick(${bids.p1}, 5, 5);
      await sleep(100);
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "speakers" });
      UI.evidenceOf = () => ({});
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "camera" });
      // A list or the agent's flag: a clean copy can't clear the page itself.
      UI.evidenceOf = target => (target === b ? { listed: "goog-phish-proto", flagged: "it asks for a seed phrase" } : {});
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "camera" });
      UI.evidenceOf = target => (target === b ? { hooked: "a script element" } : {});
      await sleep(200);
      res.ignored = calls.length;
      await hush();
      const doc = docOf(${bids.p1});
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "camera microphone" });
      await until(() => docOf(${bids.p1}) !== doc && !b.webProgress.isLoadingDocument);
      res.reloaded = { calls: calls.slice(), card: card(${bids.p1}), heard: await heard() };
      // The event's own word: evident, though the page's read says no.
      UI.evidenceOf = () => ({});
      userClick(${bids.p1}, 5, 5);
      await sleep(100);
      const next = docOf(${bids.p1});
      UI.keptRefused({ browser: b, kind: "deviceAccess", asked: "camera", evident: true });
      await until(() => docOf(${bids.p1}) !== next && !b.webProgress.isLoadingDocument);
      res.flagged = calls.length;
      return res;
    `);
    const after = await h.call("dev.viewState");
    assert.equal(out.unasked, 0, "no input of the user's");
    assert.equal(out.ignored, 0, "the speakers, and a page without evidence a clean copy clears");
    assert.deepEqual(out.reloaded, { calls: [bids.p1], card: null, heard: null });
    assert.equal(out.flagged, 2, "the event's evident: true, with the page's read saying no");
    assert.deepEqual(after, before, "no focus taken, no view moved");
  } finally {
    await h.chrome(`${K} UI.cleanLoad = null; UI.evidenceOf = null; return true;`);
    await closeTabs(bids);
    await backToUser();
  }
});

test("the note goes when its document changes, and stays on the other kept pages", async () => {
  const { space, bids, labels } = await task("goes", { p1: madeURL, p2: `${madeURL}<p>2` });
  try {
    await h.call("spaces.finish", { space, keep: [labels.p1, labels.p2] });
    const out = await h.chrome(`${K}
      await until(() => noted(${bids.p1}) && noted(${bids.p2}));
      // The user moves p1 on: a new document, which the agent didn't make.
      await inPage(${bids.p1}, "location.href = '${h.base}/api/text?moved'; return true;");
      await until(() => !noted(${bids.p1}));
      await sleep(200);
      return { p1: noted(${bids.p1}), p2: noted(${bids.p2}) };
    `);
    assert.deepEqual(out, { p1: false, p2: true });
  } finally {
    await closeTabs(bids);
  }
});

test("a waiting close of the ended task says nothing of the agent's page; Keep tab on a page the agent made notes it among the kept ones, and shows nothing", async () => {
  const { space, bids, labels } = await task("waiting", { p1: `${h.base}/zoo/forms.html`, p2: madeURL });
  try {
    await agentCode(space, labels.p1);
    // The user looks at p2, so its close waits for them.
    await view(bids.p2);
    await h.call("spaces.finish", { space, keep: [labels.p1] });
    const out = await h.chrome(`${K}
      const closing = () => N.noticeElement(tabOf(${bids.p2}), "zenius-task-finished");
      await until(() => closing() && noted(${bids.p2}));
      const res = { waiting: { note: closing().querySelector(".zenius-card-note")?.textContent ?? null, buttons: [...closing().querySelectorAll("button")].map(b => b.textContent) } };
      await press(closing(), "Keep tab");
      await until(() => !closing());
      await sleep(200);
      res.kept = { p1: noted(${bids.p1}), p2: UI.madePage(tabOf(${bids.p2}).linkedBrowser), shown: shown(${bids.p2}), card: card(${bids.p2}) };
      return res;
    `);
    assert.deepEqual(out.waiting, { note: null, buttons: ["Keep tab", "Close now"] });
    assert.deepEqual(out.kept, { p1: false, p2: { task: space, kept: true }, shown: false, card: null });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a hand-off between the agent's close of a page and its finish keeps that page's note through Keep tab after the finish", async () => {
  const { space, bids, labels } = await task("handoff", { p1: `${h.base}/zoo/forms.html`, p2: madeURL });
  try {
    // The user looks at p2, the page the agent made, so the agent's close of
    // it waits for them.
    await view(bids.p2);
    const closed = await h.call("pages.close", { space, page: labels.p2 });
    assert.equal(closed.deferred, true, "the close waits for the user");
    // The agent hands the task to the user and gets it back, then finishes.
    await h.chrome(`${K}
      const rec = ctx.spaces.peek(${space});
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "agent" });
      await sleep(100);
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      return true;
    `);
    await h.call("spaces.finish", { space, keep: [labels.p1] });
    const out = await h.chrome(`${K}
      const closing = () => N.noticeElement(tabOf(${bids.p2}), "zenius-task-finished");
      await until(() => closing());
      await press(closing(), "Keep tab");
      await until(() => !closing());
      return { p1: noted(${bids.p1}), p2: UI.madePage(tabOf(${bids.p2}).linkedBrowser) };
    `);
    assert.deepEqual(out, { p1: false, p2: { task: space, kept: true } });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a finish that kept nothing, while the user looks at a page the agent made: its waiting close has no line, and Keep tab notes the page, with nothing shown", async () => {
  const { space, bids, labels } = await task("nothing", { p1: madeURL });
  try {
    await view(bids.p1);
    await h.call("spaces.finish", { space, keep: [] });
    const out = await h.chrome(`${K}
      const closing = () => N.noticeElement(tabOf(${bids.p1}), "zenius-task-finished");
      await until(() => closing());
      const res = { waiting: { note: closing().querySelector(".zenius-card-note")?.textContent ?? null, buttons: [...closing().querySelectorAll("button")].map(b => b.textContent) } };
      await press(closing(), "Keep tab");
      await until(() => !closing());
      await sleep(200);
      res.kept = { noted: noted(${bids.p1}), shown: shown(${bids.p1}), card: card(${bids.p1}) };
      return res;
    `);
    assert.deepEqual(out.waiting, { note: null, buttons: ["Keep tab", "Close now"] });
    assert.deepEqual(out.kept, { noted: true, shown: false, card: null });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a task that finishes on a kept page the user is looking at, one the agent made, says nothing about it", async () => {
  const { space, bids, labels } = await task("heard", { p1: madeURL });
  try {
    await view(bids.p1);
    await h.chrome(`win.document.getElementById("a11y-announcement")?.replaceChildren(); return true;`);
    await h.call("spaces.finish", { space, keep: [labels.p1] });
    const out = await h.chrome(`${K}
      await until(() => noted(${bids.p1}));
      return { heard: await heard(), card: card(${bids.p1}) };
    `);
    assert.deepEqual(out, { heard: null, card: null });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("a page the agent made that the user kept from its close while the task went on joins the kept pages when the task finishes", async () => {
  const { space, bids, labels } = await task("midway", { p1: madeURL, p2: `${h.base.replace("127.0.0.1", "localhost")}/zoo/forms.html` });
  try {
    await view(bids.p1);
    await h.call("pages.close", { space, page: labels.p1 });
    const before = await h.chrome(`${K}
      const closing = () => N.noticeElement(tabOf(${bids.p1}), "zenius-task-finished");
      await until(() => closing());
      const title = closing().querySelector(".zenius-card-title")?.textContent ?? N.noticeText(tabOf(${bids.p1}), "zenius-task-finished");
      const notes = { closing: UI.madePage(tabOf(${bids.p1}).linkedBrowser) };
      await press(closing(), "Keep tab");
      await until(() => !closing());
      await sleep(200);
      notes.kept = UI.madePage(tabOf(${bids.p1}).linkedBrowser);
      return { title, noted: notes };
    `);
    await h.call("spaces.finish", { space, keep: [labels.p2] });
    const after = await h.chrome(`${K}
      await sleep(300);
      return { p1: UI.madePage(tabOf(${bids.p1}).linkedBrowser), p2: noted(${bids.p2}), shown: shown(${bids.p1}) };
    `);
    assert.match(before.title, /^Agent closed this page/);
    const waiting = { task: space, kept: false };
    assert.deepEqual(before.noted, { closing: waiting, kept: waiting }, "the note from the agent's close to the finish");
    assert.deepEqual(after, { p1: { task: space, kept: true }, p2: false, shown: false });
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("in a claimed Space, a blank tab of the user's that the agent adopted, wrote into and released: after the finish, the user's click there brings a clean copy, and the UI adds nothing: no note, no card, no load of its own", async () => {
  const { id: space, page } = await h.claimedSpace(`UI kept adopted ${run}`);
  const user = await h.chrome(`${K}
    const rec = ctx.spaces.peek(${space});
    const agentBid = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(page)} }).browser.browserId;
    const t = ctx.service.pages.tabsOf(rec).find(t => t.linkedBrowser.browserId !== agentBid);
    return { agentBid, bid: t.linkedBrowser.browserId, tab: ctx.service.pages.tabId(t), url: t.linkedBrowser.currentURI.spec };
  `);
  const { label } = await h.call("pages.adopt", { space, tab: user.tab });
  await agentWrites(space, label);
  await h.call("pages.release", { space, page: label });
  // A claimed Space's tabs are the task's at its end too: with quiet loads
  // on, the core would reload the hooked page then. Off, as when that
  // reload fails, so the user's click finds it hooked.
  await quietLoads(false);
  let out;
  try {
    await h.call("spaces.finish", { space, keep: [] });
    await view(user.bid);
    out = await h.chrome(`${K}
      const b = tabOf(${user.bid}).linkedBrowser;
      const calls = [];
      UI.cleanLoad = async browser => {
        calls.push(browser.browserId);
        return { how: "reload" };
      };
      try {
        // The input layer's guard has the core load a clean copy before the
        // user's press in a hooked page lands.
        Services.prefs.clearUserPref("zenius.handoff.quietReload");
        const hooked = "hooked" in (UI.evidenceOf?.(b) ?? {});
        const before = docOf(${user.bid});
        userClick(${user.bid}, 5, 5);
        await until(() => (docOf(${user.bid}) || before) !== before, 8000);
        return { hooked, noted: noted(${user.bid}), calls, card: card(${user.bid}) };
      } finally {
        UI.cleanLoad = null;
      }
    `);
  } finally {
    await quietLoads(true);
  }
  await backToUser();
  assert.equal(user.url, "about:blank");
  assert.deepEqual(out, { hooked: true, noted: false, calls: [], card: null });
  await closeTabs({ agent: user.agentBid });
});

test("the panel's Stop leaves the page the agent made noted, with nothing shown until the user goes to type there; if the agent has the Space again, it's its own again: the page loses its card, and no view moves", async () => {
  const { space, bids, labels } = await task("stop", {
    p1: `${h.base}/zoo/forms.html`,
    p2: "data:text/html,<title>Agent page</title><input id=x type=password style='display:block;width:300px;height:40px'>",
  });
  try {
    await agentCode(space, labels.p1);
    const field = await fieldAt(space, labels.p2, "#x");
    await view(bids.p2);
    const stopped = await h.chrome(`${K}
      const rec = ctx.spaces.peek(${space});
      UI.stopByUser(rec);
      await until(() => noted(${bids.p2}));
      await sleep(200);
      const res = { owner: rec.ownership, p1: noted(${bids.p1}), noted: noted(${bids.p2}), shown: shown(${bids.p2}), card: card(${bids.p2}) };
      // The user goes to type in the page the agent made: its card.
      userClick(${bids.p2}, ${field[0]}, ${field[1]});
      await until(() => cardOf(${bids.p2}));
      res.made = card(${bids.p2}).text;
      return res;
    `);
    const before = await h.call("dev.viewState");
    const again = await h.chrome(`${K}
      // The user lets the agent have the Space again (its claim).
      ctx.spaces.setOwnership(ctx.spaces.peek(${space}), "agent", { source: "user" });
      await until(() => !cardOf(${bids.p2}));
      await sleep(200);
      return card(${bids.p2});
    `);
    const after = await h.call("dev.viewState");
    assert.deepEqual(stopped, { owner: "user", p1: false, noted: true, shown: false, card: null, made: "The agent made this page" });
    assert.equal(again, null);
    assert.deepEqual(after, before, "no focus taken, no view moved");
  } finally {
    await closeTabs(bids);
    await backToUser();
  }
});

test("in a claimed Space the user's own blank tab isn't noted, and the page the agent made is: a document with no site counts as the agent's only in a tab the agent opened", async () => {
  const { id: space, page } = await h.claimedSpace(`UI kept claimed ${run}`);
  const out = await h.chrome(`${K}
    const rec = ctx.spaces.peek(${space});
    const agentBid = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(page)} }).browser.browserId;
    const userTabs = ctx.service.pages.tabsOf(rec).filter(t => t.linkedBrowser.browserId !== agentBid);
    return { agentBid, user: userTabs.map(t => ({ bid: t.linkedBrowser.browserId, url: t.linkedBrowser.currentURI.spec })) };
  `);
  await h.call("page.goto", { space, page, url: madeURL });
  await h.call("spaces.finish", { space, keep: [page] });
  const after = await h.chrome(`${K}
    await until(() => noted(${out.agentBid}));
    await sleep(200);
    return { agent: noted(${out.agentBid}), user: ${JSON.stringify(out.user.map(u => u.bid))}.map(bid => noted(bid)) };
  `);
  assert.ok(out.user.length >= 1 && out.user.every(u => u.url === "about:blank"), JSON.stringify(out.user));
  assert.deepEqual(after, { agent: true, user: out.user.map(() => false) });
  await closeTabs({ agent: out.agentBid });
});

// The reply after a finish: the user's click or key in a tab an ended task
// kept goes to the core (noteKeptInput; finishedTaskOf too, stand-ins here),
// so a reply to the task's chat leaves that page with the user. The user's
// input enters through the parent, as OS input does (takeover.test.mjs).
test("the user's click and typing in a tab an ended task kept reach the core as clicked and typed; an arrow key and Escape don't count, nor does input in a tab no task kept", async () => {
  const out = await h.chrome(`
    const svc = win.ucAgentSidebar.AgentService.zenius();
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const gBrowser = win.gBrowser;
    const until = async (fn, ms = 10000) => {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) throw new Error("timed out: " + fn);
        await new Promise(r => win.setTimeout(r, 50));
      }
    };
    const names = ["finishedTaskOf", "noteKeptInput"];
    const own = Object.fromEntries(names.map(n => [n, Object.hasOwn(svc, n)]));
    const real = Object.fromEntries(names.map(n => [n, svc[n]]));
    const url = "data:text/html,<title>Kept</title><input id=x style='display:block;width:300px;height:40px'>";
    const open = async () => {
      const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      gBrowser.selectedTab = tab;
      await until(() => tab.linkedBrowser.currentURI.spec.startsWith("data:") && !tab.hasAttribute("busy") && gBrowser.selectedTab === tab);
      return tab;
    };
    const userClick = tab => {
      const browser = tab.linkedBrowser;
      const r = browser.getBoundingClientRect();
      const px = r.x + r.width / 2;
      const py = r.y + Math.min(r.height / 2, 30);
      if (win.document.elementFromPoint(px, py) !== browser) {
        throw new Error("the click point isn't the page's");
      }
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, px, py, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      }
    };
    const userKey = (tab, key) => {
      tab.linkedBrowser.focus();
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      tip.beginInputTransactionForTests(win);
      const ev = new win.KeyboardEvent("", { key });
      tip.keydown(ev);
      tip.keyup(ev);
    };
    const was = gBrowser.selectedTab;
    const tabs = [];
    const calls = [];
    const ended = { id: 2147480002, kind: "task" };
    let kept = null;
    try {
      kept = await open();
      tabs.push(kept);
      svc.finishedTaskOf = tab => (tab === kept ? ended : null);
      svc.noteKeptInput = (rec, browser, kind) => calls.push({ rec: rec?.id ?? null, browser: browser === kept.linkedBrowser, kind });
      const skipped = () => ({ ...UI.takeover.stats.skipped });
      userClick(kept);
      await until(() => calls.length >= 1);
      userKey(kept, "a");
      await until(() => calls.length >= 2);
      const before = calls.length;
      const quiet = skipped();
      userKey(kept, "ArrowDown");
      userKey(kept, "Escape");
      await new Promise(r => win.setTimeout(r, 300));
      const uncounted = calls.length - before;
      const notInput = (skipped().notInput ?? 0) - (quiet.notInput ?? 0);
      const other = await open();
      tabs.push(other);
      const managedBefore = skipped().notManaged ?? 0;
      userClick(other);
      await until(() => (skipped().notManaged ?? 0) > managedBefore);
      return { calls, uncounted, notInput, otherCalls: calls.length - before - uncounted };
    } finally {
      for (const n of names) {
        if (own[n]) svc[n] = real[n];
        else delete svc[n];
      }
      gBrowser.selectedTab = was;
      for (const tab of tabs) gBrowser.removeTab(tab, { animate: false });
    }
  `);
  assert.deepEqual(out.calls, [
    { rec: 2147480002, browser: true, kind: "clicked" },
    { rec: 2147480002, browser: true, kind: "typed" },
  ]);
  assert.equal(out.uncounted, 0, "an arrow key and Escape don't count");
  assert.equal(out.notInput, 2, "both reached the listener as input that doesn't count");
  assert.equal(out.otherCalls, 0, "input in a tab no task kept goes nowhere");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTabSyncId, userView.windows[0].selectedTabSyncId);
});
