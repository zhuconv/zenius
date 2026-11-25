// Takeover (runtime/JS/zenius/ui/takeover.sys.mjs and ui/index.sys.mjs): the
// user's own input in an agent page pauses the agent and asks whether to take
// over; the agent's own input never does.
//
// The test plays the user with input that enters through the parent, like OS
// input (the chrome window's synthesizeMouseEvent and nsITextInputProcessor),
// and the agent with input synthesized in the page's process.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, prelude, setup } from "./lib.mjs";

let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let P;
let userView;
const QUIET_MS = 1500;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux takeover test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const T = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/takeover.sys.mjs");
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const notice = value => N.noticeElement(tab, value);
    // A pill ignores clicks for 400 ms after it appears, so the second
    // click of a double click can't land on the pill that replaces it.
    const clickNoticeButton = async (value, label) => {
      await until(() => notice(value));
      const buttons = [...notice(value).querySelectorAll("button")];
      const b = buttons.find(b => b.textContent.trim() === label);
      if (!b) throw new Error("no button " + label + " in " + value + ": " + buttons.map(b => b.textContent).join("|"));
      await sleep(450);
      b.click();
    };
    // The user's click, entering through the parent like OS input; by
    // default in the middle of the page, away from the window's corners,
    // where Firefox anchors its doorhangers. It checks first that the point
    // reaches the page: on the Mac, Firefox's update doorhanger once took
    // the clicks.
    const userClick = (x, y) => {
      const r = browser.getBoundingClientRect();
      const px = r.x + (x ?? r.width / 2);
      const py = r.y + (y ?? r.height / 2);
      const hit = win.document.elementFromPoint(px, py);
      // elementFromPoint doesn't see popups: compare their screen rects.
      const sx = win.mozInnerScreenX + px;
      const sy = win.mozInnerScreenY + py;
      const popup = [...win.document.querySelectorAll("panel, menupopup")].find(p => {
        if (p.state !== "open" && p.state !== "showing") return false;
        const pr = p.getOuterScreenRect();
        return sx >= pr.left && sx < pr.right && sy >= pr.top && sy < pr.bottom;
      });
      if (hit !== browser || popup) {
        throw new Error("the click point is covered by " + (popup ? "the popup " + (popup.id || popup.localName) : describeEl(hit)) + "; " + JSON.stringify(windowState()));
      }
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, px, py, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      }
    };
    const describeEl = el => {
      if (!el) return "nothing";
      if (el.localName === "browser") return "the browser of " + (el === browser ? "the agent's page" : "another tab: " + gBrowser.getTabForBrowser(el)?.label);
      return el.localName + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : "");
    };
    // What earlier test files could have left behind, for a prompt that
    // doesn't open (seen only on the Mac, in full runs).
    const windowState = () => ({
      detector: UI.takeover.stats,
      attached: UI.takeover.isAttached(win),
      lookup: !!UI.lookup(tab),
      space: { ownership: rec.ownership, paused: rec.paused, gone: !!rec.gone, pausedByUser: UI.describe(rec).pausedByUser },
      selected: gBrowser.selectedTab === tab,
      focused: describeEl(Services.focus.focusedElement),
      activeWindow: Services.focus.activeWindow === win,
      urlbar: { focused: gURLBar.focused, floating: gURLBar.getAttribute("zen-floating-urlbar"), open: gURLBar.view.isOpen },
      popups: [...win.document.querySelectorAll("panel, menupopup")].filter(p => p.state !== "closed").map(p => (p.id || p.localName) + ":" + p.state),
      sidebarExpanded: win.document.documentElement.getAttribute("zen-sidebar-expanded"),
      dragSession: (() => {
        try {
          return !!Cc["@mozilla.org/widget/dragservice;1"].getService(Ci.nsIDragService).getCurrentSession(win);
        } catch (e) {
          return "unknown: " + e.message;
        }
      })(),
    });
    // Wait for the prompt; if it doesn't come, say what the detector saw.
    const waitPrompt = async () => {
      try {
        await until(() => notice(T.PROMPT));
      } catch {
        throw new Error("no takeover prompt: " + JSON.stringify(windowState()));
      }
    };
    const userKey = key => {
      browser.focus();
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      tip.beginInputTransactionForTests(win);
      const ev = new win.KeyboardEvent("", { key });
      tip.keydown(ev);
      tip.keyup(ev);
    };
  `;
  // The user opens the agent Space, and the quiet timer is shortened.
  // Earlier test files may leave state behind: close popups, and give the
  // window its default layout and focus.
  await h.chrome(`${P}
    // Firefox's own doorhangers (an update is available, say) open over
    // the window's top-left corner a moment after start.
    const { AppMenuNotifications } = ChromeUtils.importESModule("resource://gre/modules/AppMenuNotifications.sys.mjs");
    AppMenuNotifications.removeNotification(/.*/);
    for (const p of win.document.querySelectorAll("panel, menupopup")) {
      if (p.state === "open" || p.state === "showing") p.hidePopup();
    }
    if (gURLBar.focused || gURLBar.view.isOpen) {
      gURLBar.view.close();
      gURLBar.handleRevert();
      gBrowser.selectedBrowser.focus();
    }
    Services.prefs.clearUserPref("zen.view.sidebar-expanded");
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    win.focus();
    Services.prefs.setIntPref("zenius.ux.takeover.quietMs", ${QUIET_MS});
    UI.takeover.reset();
    // The user opens the Space at the agent's page, as the panel's Open does
    // (agent actions pick it only in a Space the agent created).
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs").landOn(tab);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
  `);
});

after(async () => {
  await h?.chrome(`
    Services.prefs.clearUserPref("zenius.ux.takeover.quietMs");
    const ws = ${JSON.stringify(userView?.windows?.[0]?.activeWorkspace ?? null)};
    if (ws && gZenWorkspaces.activeWorkspace !== ws) await gZenWorkspaces.changeWorkspaceWithID(ws);
  `);
  await h?.close();
});

const state = () => h.call("ui.state", { space });
/** The task's state once `ok` holds of it: a hand back waits for zen-input's check of typed secrets first. */
async function stateWhen(ok, ms = 5000) {
  for (const end = Date.now() + ms; ; ) {
    const s = await state();
    if (ok(s) || Date.now() > end) {
      return s;
    }
    await sleep(50);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("the agent's own input never opens the prompt, nor counts as the user's", async () => {
  await h.chrome(`${P} delete rec.lastUserInputAt;`);
  await h.call("dev.evalContent", {
    space,
    page: "p1",
    privileged: true,
    code: `
      const w = actor.contentWindow;
      for (const type of ["mousedown", "mouseup"]) w.synthesizeMouseEvent(type, 40, 40, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      tip.beginInputTransactionForTests(w);
      for (const key of ["a", "Enter"]) { const ev = new w.KeyboardEvent("", { key }); tip.keydown(ev); tip.keyup(ev); }
    `,
  });
  // Parent-side input that zenius code dispatches inside withAgentInput().
  await h.chrome(`${P} T.withAgentInput(() => userClick());`);
  await sleep(100);
  const s = await state();
  assert.equal(s.prompt, null);
  assert.equal(s.paused, false);
  assert.equal(s.ownership, "agent");
  assert.equal(await h.chrome(`${P} return rec.lastUserInputAt ?? null;`), null, "zen-core's 10 s rule counts only the user's input");
});

test("keys that aren't typing don't count", async () => {
  await h.chrome(`${P} for (const key of ["Escape", "F6", "Shift"]) userKey(key);`);
  await sleep(100);
  assert.equal((await state()).prompt, null);
});

test("a user click pauses the agent and shows the prompt in the agent's page", async () => {
  const out = await h.chrome(`${P}
    delete rec.lastUserInputAt;
    userClick();
    const pausedAtOnce = rec.paused;
    const noted = Date.now() - (rec.lastUserInputAt ?? 0);
    await waitPrompt();
    return { pausedAtOnce, noted, text: N.noticeText(tab, T.PROMPT) };
  `);
  assert.equal(out.pausedAtOnce, true, "paused synchronously, inside the input listener");
  assert.ok(out.noted >= 0 && out.noted < 1000, `zen-core has the time of the user's input (${out.noted} ms ago)`);
  // This file shortens the quiet time to 1.5 s.
  assert.match(out.text, /^Agent paused · it resumes in [12] s$/);
  const s = await state();
  assert.deepEqual(s.prompt, { typed: false, inputs: 1 });
  assert.equal(s.taskBadge.state, "paused");
});

test("while the prompt is open the agent's next action waits; Resume agent releases it", async () => {
  const move = h.call("ui.cursor", { space, page: "p1", x: 300, y: 200, label: "Click Next", kind: "click" });
  let settled = false;
  move.then(() => (settled = true), () => (settled = true));
  await sleep(700);
  assert.equal(settled, false, "the action is held while paused");
  await h.chrome(`${P} await clickNoticeButton(T.PROMPT, "Resume agent");`);
  const r = await move;
  assert.equal(r.ok, true);
  const s = await state();
  assert.equal(s.paused, false);
  assert.equal(s.prompt, null);
  assert.equal(s.ownership, "agent");
});

test("right after Resume agent, clicks don't re-prompt", async () => {
  await h.chrome(`${P} userClick();`);
  await sleep(100);
  assert.equal((await state()).prompt, null);
});

test("an ignored prompt after clicks only lets the agent continue", async () => {
  await sleep(3000); // let the grace period lapse
  await h.chrome(`${P} userClick(); await waitPrompt();`);
  assert.equal((await state()).paused, true);
  await sleep(QUIET_MS + 300);
  const s = await state();
  assert.equal(s.prompt, null);
  assert.equal(s.paused, false);
  assert.equal(s.ownership, "agent");
  assert.equal(await h.chrome(`${P} return !!notice(T.PROMPT);`), false, "the prompt is gone");
});

test("an ignored prompt after typing leaves the user in control", async () => {
  await sleep(3000);
  await h.chrome(`${P} userClick(); userKey("x");`);
  const typing = await state();
  assert.deepEqual(typing.prompt, { typed: true, inputs: 2 });
  await sleep(QUIET_MS + 300);
  const s = await state();
  assert.equal(s.ownership, "agentDelegatedToUser");
  assert.equal(s.reason, "manual_takeover");
  assert.equal(s.paused, false);
  assert.equal(s.taskBadge.state, "user");
  assert.equal(s.controlNotice, `You're in control · the agent waits until you resume it on ${site()}`);
  await assert.rejects(h.call("ui.cursor", { space, page: "p1", x: 10, y: 10 }), {
    code: "ZEN_TASK_SPACE_USER_IN_CONTROL",
    data: { space, reason: "manual_takeover" },
  });
  const drawn = await h.chrome(`${P} return !!C.cursorState(tab)?.inDom || !!browser.parentElement.querySelector(".zenius-cursor-layer");`);
  assert.equal(drawn, false, "no agent cursor appears while the user is in control");
});

test("input while the user is in control opens no prompt, but still counts for zen-core's 10 s rule; Resume agent returns control", async () => {
  const ago = await h.chrome(`${P} delete rec.lastUserInputAt; userClick(); return Date.now() - (rec.lastUserInputAt ?? 0);`);
  assert.ok(ago >= 0 && ago < 2000, `the user's input in a task they hold is noted (${ago} ms ago)`);
  assert.equal((await state()).prompt, null);
  await h.chrome(`${P} await clickNoticeButton("zenius-control", "Resume agent");`);
  const s = await stateWhen(x => x.ownership === "agent");
  assert.equal(s.ownership, "agent");
  assert.equal(s.controlNotice, null);
  const r = await h.call("ui.cursor", { space, page: "p1", x: 20, y: 20 });
  assert.equal(r.ok, true);
});

test("Take over hands the Space to the user and fails the waiting action", async () => {
  await sleep(3000);
  await h.chrome(`${P} userClick(); await waitPrompt();`);
  // Settle into a value at once: the call rejects while the test is still
  // clicking, before an assert.rejects() could attach.
  const move = h.call("ui.cursor", { space, page: "p1", x: 200, y: 100, kind: "click" }).then(
    () => null,
    e => e
  );
  await sleep(300);
  await h.chrome(`${P} await clickNoticeButton(T.PROMPT, "Take over");`);
  const err = await move;
  assert.equal(err?.code, "ZEN_TASK_SPACE_USER_IN_CONTROL");
  assert.deepEqual(err.data, { space, reason: "manual_takeover" });
  const s = await state();
  assert.equal(s.ownership, "agentDelegatedToUser");
  assert.equal(s.taskBadge.state, "user");
  const cursorGone = await h.chrome(`${P} return !C.cursorState(tab)?.inDom && !browser.parentElement.querySelector(".zenius-cursor-layer");`);
  assert.equal(cursorGone, true, "the agent's cursor is gone while the user is in control");
  await h.chrome(`${P} await clickNoticeButton("zenius-control", "Resume agent");`);
  assert.equal((await stateWhen(x => x.ownership === "agent")).ownership, "agent");
});

// The classifier takes the platform as a parameter, so the Mac's rules run
// on Linux too. The Mac cases come from the guided check with the user:
// Cmd+L counted as typing while a Chinese IME was active.
test("which keys count as typing, on the Mac and elsewhere", async () => {
  const out = await h.chrome(`
    const T = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/takeover.sys.mjs");
    const out = {};
    for (const mac of [true, false]) {
      const k = (key, mods = {}) => T.classifyInput(new win.KeyboardEvent("keydown", { key, ...mods }), { mac });
      const accel = (mods = {}) => (mac ? { metaKey: true, ...mods } : { ctrlKey: true, ...mods });
      const otherModifier = mac ? { ctrlKey: true } : { metaKey: true };
      const composing = { isComposing: true };
      out[mac ? "mac" : "other"] = {
        typing: {
          a: k("a"), space: k(" "), Enter: k("Enter"), Backspace: k("Backspace"), Delete: k("Delete"), Tab: k("Tab"),
          "é": k("é"), Dead: k("Dead"),
          // A Chinese IME's keys come as Process; the first one starts the
          // composition, so it isn't composing yet.
          Process: k("Process"), composingProcess: k("Process", composing), composingLetter: k("n", composing),
          composingEnter: k("Enter", composing),
          "accel+v": k("v", accel()), "accel+x": k("x", accel()), "accel+z": k("z", accel()),
          "accel+shift+Z": k("Z", accel({ shiftKey: true })), "accel+Backspace": k("Backspace", accel()),
        },
        notTyping: {
          Escape: k("Escape"), F5: k("F5"), F6: k("F6"), ArrowDown: k("ArrowDown"), ArrowRight: k("ArrowRight"), PageDown: k("PageDown"),
          // Lone modifiers, as their own keydown reports them.
          Shift: k("Shift", { shiftKey: true }), Meta: k("Meta", { metaKey: true }), Control: k("Control", { ctrlKey: true }),
          Alt: k("Alt", { altKey: true }), Fn: k("Fn"),
          // Input-source switches: CapsLock and Shift toggle a Chinese IME
          // between Chinese and English, even mid-composition.
          CapsLock: k("CapsLock"), composingCapsLock: k("CapsLock", composing), composingShift: k("Shift", { shiftKey: true, ...composing }),
          composingMeta: k("Meta", { metaKey: true, ...composing }), Eisu: k("Eisu"), KanjiMode: k("KanjiMode"),
          "accel+t": k("t", accel()), "accel+l": k("l", accel()), "accel+1": k("1", accel()), "accel+w": k("w", accel()),
          "accel+f": k("f", accel()),
          // Shortcuts stay shortcuts while an IME composes.
          "composing accel+l": k("l", accel(composing)), "composing accel+Process": k("Process", accel(composing)),
          "otherModifier+a": k("a", otherModifier),
        },
        altLetter: k("f", { altKey: true }),
        altGraphLetter: k("ą", { altKey: true, ctrlKey: !mac, modifierAltGraph: true }),
      };
    }
    // Without the parameter it uses this build's platform.
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    const mac = AppConstants.platform === "macosx";
    const accelV = new win.KeyboardEvent("keydown", { key: "v", ...(mac ? { metaKey: true } : { ctrlKey: true }) });
    const otherV = new win.KeyboardEvent("keydown", { key: "v", ...(mac ? { ctrlKey: true } : { metaKey: true }) });
    out.defaultPlatform = T.classifyInput(accelV) === "key" && T.classifyInput(otherV) === null;
    return out;
  `);
  for (const platform of ["mac", "other"]) {
    const { typing, notTyping, altLetter, altGraphLetter } = out[platform];
    const wrong = [
      ...Object.entries(typing).filter(([, kind]) => kind !== "key").map(([key]) => `${key} should count`),
      ...Object.entries(notTyping).filter(([, kind]) => kind !== null).map(([key]) => `${key} shouldn't count`),
    ];
    assert.deepEqual(wrong, [], platform);
    // Option+letter types a character on the Mac; Alt+letter opens menus
    // elsewhere, while AltGr+letter types.
    assert.equal(altLetter, platform === "mac" ? "key" : null, `${platform}: Alt+letter`);
    assert.equal(altGraphLetter, "key", `${platform}: AltGr+letter`);
  }
  assert.equal(out.defaultPlatform, true);
});

test("IME composition counts as typing; an input-source switch doesn't", async () => {
  // A Chinese IME on the Mac: CapsLock switches to English and back, then
  // the user composes. Keys enter through the parent, like OS input.
  const out = await h.chrome(`${P}
    browser.focus();
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const press = init => { const ev = new win.KeyboardEvent("", init); tip.keydown(ev); tip.keyup(ev); };
    for (let i = 0; i < 2; i++) press({ key: "CapsLock", code: "CapsLock" });
    await sleep(100);
    const afterSwitch = !!UI.takeover.promptState(rec.id);
    tip.setPendingCompositionString("n");
    tip.appendClauseToPendingComposition(1, tip.ATTR_RAW_CLAUSE);
    tip.flushPendingComposition(new win.KeyboardEvent("", { key: "Process", code: "KeyN", keyCode: 229 }));
    const prompt = UI.takeover.promptState(rec.id);
    tip.cancelComposition();
    await until(() => notice(T.PROMPT));
    const text = N.noticeText(tab, T.PROMPT);
    UI.takeover.resolve(rec.id, "continue");
    return { afterSwitch, typed: prompt?.typed ?? null, text };
  `);
  assert.equal(out.afterSwitch, false, "CapsLock opened no prompt");
  assert.equal(out.typed, true, "composing opened the prompt as typing");
  assert.match(out.text, /^You're taking over · in [12] s$/);
  await sleep(3200); // the grace period after Resume agent
});

// Issue #3, R2: the arrow stayed at the agent's last click in one page while
// the agent worked in another, and under the prompt.
test("the agent's cursor leaves a page once the agent's call names another page of the task, a read too, and comes back with its next action there; closing the other page leaves it", async () => {
  const p2 = await h.call("pages.new", { space, url: `${h.base}/` });
  let closed = false;
  try {
    // The user still looks at p1.
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
    await h.call("ui.cursor", { space, page: "p1", x: 200, y: 150, label: "Click Next", kind: "click" });
    const shown = await h.chrome(`${P} const s = C.cursorState(tab); return s && { hidden: s.hidden, inDom: s.inDom };`);
    await h.call("page.title", { space, page: p2.label });
    const left = await h.chrome(`${P} return { state: C.cursorState(tab), layer: !!browser.parentElement.querySelector(".zenius-cursor-layer") };`);
    await h.call("ui.cursor", { space, page: "p1", x: 220, y: 160, label: "Click Done", kind: "click" });
    const back = await h.chrome(`${P} const s = C.cursorState(tab); return s && { hidden: s.hidden, inDom: s.inDom, label: s.label };`);
    assert.deepEqual(shown, { hidden: false, inDom: true });
    assert.deepEqual(left, { state: null, layer: false }, "a read in p2 takes the cursor off p1");
    assert.deepEqual(back, { hidden: false, inDom: true, label: "Click Done" });
    // Closing a page isn't work there.
    await h.call("pages.close", { space, page: p2.label });
    closed = true;
    const afterClose = await h.chrome(`${P} const s = C.cursorState(tab); return s && { hidden: s.hidden, inDom: s.inDom, label: s.label };`);
    assert.deepEqual(afterClose, { hidden: false, inDom: true, label: "Click Done" }, "closing p2 leaves p1's cursor");
  } finally {
    if (!closed) await h.call("pages.close", { space, page: p2.label }).catch(() => {});
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
  }
});

test("a page whose action is still under way keeps its cursor when a call names another page of the task, as a script's calls on two pages at once do, until a call after that action", async () => {
  const p2 = await h.call("pages.new", { space, url: `${h.base}/` });
  try {
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
    await h.call("ui.cursor", { space, page: "p1", x: 200, y: 150, label: "Click Next", kind: "click" });
    // A button shown only after a while: a click on it waits, its step under way.
    await h.call("dev.evalContent", {
      space,
      page: "p1",
      privileged: true,
      code: `
        const w = actor.contentWindow;
        w.document.body.insertAdjacentHTML("beforeend", "<button id='late' style='display:none;position:fixed;left:40px;top:40px'>Late</button>");
        w.setTimeout(() => (w.document.getElementById("late").style.display = "block"), 1500);
      `,
    });
    const click = h.call("page.click", { space, page: "p1", target: "#late" });
    await sleep(400);
    await h.call("page.title", { space, page: p2.label });
    const pick = `const s = C.cursorState(tab); return s && { hidden: s.hidden, inDom: s.inDom };`;
    const during = await h.chrome(`${P} ${pick}`);
    await click;
    const after = await h.chrome(`${P} ${pick}`);
    await h.call("page.title", { space, page: p2.label });
    const later = await h.chrome(`${P} return C.cursorState(tab);`);
    assert.deepEqual(during, { hidden: false, inDom: true }, "p1's click was under way: its cursor stays");
    assert.deepEqual(after, { hidden: false, inDom: true });
    assert.equal(later, null, "once that click ended, the next call on p2 takes it");
  } finally {
    await h.call("pages.close", { space, page: p2.label }).catch(() => {});
    await h.call("dev.evalContent", { space, page: "p1", privileged: true, code: `actor.contentWindow.document.getElementById("late")?.remove();` }).catch(() => {});
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
  }
});

test("while Take over's prompt is open on a page, the agent's cursor there hides; Resume agent brings it back at the point of the action that waited, with its label", async () => {
  await h.call("ui.cursor", { space, page: "p1", x: 200, y: 150, label: "Click Next", kind: "click" });
  // Long enough that the countdown can't end the prompt before the test's
  // Resume agent.
  await h.chrome(`Services.prefs.setIntPref("zenius.ux.takeover.quietMs", 20000);`);
  let out;
  try {
    out = await h.chrome(`${P}
      const pick = s => s && { hidden: s.hidden, inDom: s.inDom, x: s.x, y: s.y, label: s.label };
      const shown = pick(C.cursorState(tab));
      userClick();
      await waitPrompt();
      const during = pick(C.cursorState(tab));
      // A call waits before it starts while the prompt is open, but one
      // already past that check may still move: a drag's way to its target.
      const r = await C.moveCursor(tab, { x: 300, y: 210 }, { label: "Drop on Done", kind: "move" });
      const held = { ...pick(C.cursorState(tab)), visible: r.visible };
      await clickNoticeButton(T.PROMPT, "Resume agent");
      await until(() => C.cursorState(tab)?.inDom);
      return { shown, during, held, after: pick(C.cursorState(tab)) };
    `);
  } finally {
    await h.chrome(`Services.prefs.setIntPref("zenius.ux.takeover.quietMs", ${QUIET_MS});`);
  }
  const was = { x: 200, y: 150, label: "Click Next" };
  const goes = { x: 300, y: 210, label: "Drop on Done" };
  assert.deepEqual(out.shown, { hidden: false, inDom: true, ...was });
  assert.deepEqual(out.during, { hidden: true, inDom: false, ...was }, "hidden while the prompt is open there");
  assert.deepEqual(out.held, { hidden: true, inDom: false, ...goes, visible: false }, "the waiting action's point, not drawn");
  assert.deepEqual(out.after, { hidden: false, inDom: true, ...goes });
  await sleep(3200); // the grace period after Resume agent
});

test("a step that left its task's ring while it ran (zen-input keeps 50 steps) no longer keeps its page's cursor", async () => {
  const p2 = await h.call("pages.new", { space, url: `${h.base}/` });
  try {
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
    await h.call("ui.cursor", { space, page: "p1", x: 200, y: 150, label: "Click Next", kind: "click" });
    // A step on p1 that never ends, as a script's long wait there, through
    // zen-input's own ring.
    await h.chrome(`
      const St = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");
      win.zenuxHeldStep = St.beginCall({ method: "page.click", params: { space: ${space}, page: "p1", target: "#held" } });
    `);
    await h.call("page.title", { space, page: p2.label });
    const kept = await h.chrome(`${P} return !!C.cursorState(tab);`);
    // 55 actions under way on p2 at once push it out of the ring, which
    // keeps 50 steps, the oldest going first, running or not.
    await h.chrome(`
      const St = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");
      win.zenuxHeldSteps = [];
      for (let i = 0; i < 55; i++) {
        win.zenuxHeldSteps.push(St.beginCall({ method: "page.click", params: { space: ${space}, page: ${JSON.stringify(p2.label)}, target: "#b" + i } }));
      }
    `);
    await h.call("page.title", { space, page: p2.label });
    const later = await h.chrome(`${P} return C.cursorState(tab);`);
    assert.equal(kept, true, "its step under way keeps p1's cursor");
    assert.equal(later, null, "once the ring no longer shows it running, the next call on p2 takes it");
  } finally {
    await h.chrome(`
      const St = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/steps.sys.mjs");
      // dev.evalChrome's calls share no globalThis: the window keeps them.
      const step = win.zenuxHeldStep;
      delete win.zenuxHeldStep;
      if (step) St.endCall(step, { method: "page.click", params: { space: ${space}, page: "p1", target: "#held" }, outcome: "ok", ms: 1 });
      for (const [i, held] of (win.zenuxHeldSteps ?? []).entries()) {
        St.endCall(held, { method: "page.click", params: { space: ${space}, page: ${JSON.stringify(p2.label)}, target: "#b" + i }, outcome: "ok", ms: 1 });
      }
      delete win.zenuxHeldSteps;
    `).catch(() => {});
    await h.call("pages.close", { space, page: p2.label }).catch(() => {});
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
  }
});

test("Take over's prompt follows the user's input to another page of the task and hides the agent's cursor there too; when the agent goes on, both come back", async () => {
  const p2 = await h.call("pages.new", { space, url: `${h.base}/` });
  await h.chrome(`Services.prefs.setIntPref("zenius.ux.takeover.quietMs", 20000);`);
  let out;
  try {
    out = await h.chrome(`${P}
      const { tab: tab2, browser: browser2 } = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(p2.label)} });
      const pick = s => s && { hidden: s.hidden, inDom: s.inDom };
      const both = () => ({ p1: pick(C.cursorState(tab)), p2: pick(C.cursorState(tab2)) });
      gBrowser.selectedTab = tab;
      await until(() => gBrowser.selectedTab === tab);
      await C.moveCursor(tab2, { x: 100, y: 100 }, { label: "Read prices", kind: "move" });
      await C.moveCursor(tab, { x: 200, y: 150 }, { label: "Click Next", kind: "click" });
      userClick();
      await waitPrompt();
      const opened = both();
      // The user goes on in p2: their click there, entering through the parent as on p1.
      gBrowser.selectedTab = tab2;
      await until(() => gBrowser.selectedTab === tab2);
      const r = browser2.getBoundingClientRect();
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      }
      await until(() => UI.takeover.promptState(rec.id)?.tab === tab2);
      const moved = both();
      UI.takeover.resolve(rec.id, "continue");
      await until(() => C.cursorState(tab2)?.inDom);
      const resumed = both();
      gBrowser.selectedTab = tab;
      await until(() => gBrowser.selectedTab === tab);
      return { opened, moved, resumed };
    `);
  } finally {
    await h.chrome(`Services.prefs.setIntPref("zenius.ux.takeover.quietMs", ${QUIET_MS});`);
    await h.call("pages.close", { space, page: p2.label }).catch(() => {});
    await h.chrome(`${P} gBrowser.selectedTab = tab; await until(() => gBrowser.selectedTab === tab);`);
  }
  // p2's tab wasn't shown, so its cursor wasn't drawn: it's kept, not hidden.
  assert.deepEqual(out.opened, { p1: { hidden: true, inDom: false }, p2: { hidden: false, inDom: false } });
  assert.deepEqual(out.moved, { p1: { hidden: true, inDom: false }, p2: { hidden: true, inDom: false } }, "hidden where the prompt went");
  assert.deepEqual(out.resumed.p2, { hidden: false, inDom: true });
  assert.equal(out.resumed.p1.hidden, false, "p1's comes back too, drawn when its tab shows");
  await sleep(3200); // the grace period after the agent goes on
});

test("the user's view ends as it started", async () => {
  await h.chrome(`
    await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)});
    await new Promise(r => win.setTimeout(r, 300));
  `);
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
