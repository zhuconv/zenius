// zenius in each of Zen's layouts (the manager's accessibility and settings
// pass, 2026-11-20): the layouts 1.24's settings offer (single toolbar,
// multiple toolbars, collapsed), the sidebar on the right, compact mode, two
// windows and split view. In each, the strip and the tasks panel stay in the
// window, the pill sits on the agent's own page, and an agent action moves
// nothing the user sees (I1). 1.24 offers no horizontal tabs.
//
// Headless, compact mode's sidebar never hides (no pointer leaves it); that
// it hides the strip and the badge there is known (docs/reports/zen-ux.md).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, SMOOTH_FRAME_MS } from "./lib.mjs";

const LAYOUT_PREFS = ["zen.tabs.vertical.right-side", "zen.view.sidebar-expanded", "zen.view.use-single-toolbar"];
let h;
let space;
let name;
let userView;
let P;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  name = `zen-ux layouts ${Date.now().toString(36).slice(-5)}`;
  ({ id: space } = await h.createSpace({ name }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const V = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/visibility.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const show = async () => {
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab);
    };
    const back = async () => {
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      ctx.spaces.setStateText(rec, "");
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
    };
    const handOff = async () => {
      ctx.spaces.setStateText(rec, "Log in to continue");
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      await until(() => N.noticeElement(tab, "zenius-control"));
      await sleep(250);
    };
    const inside = (r, w) => r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= w.innerWidth + 1 && r.bottom <= w.innerHeight + 1;
    /** The pill, on the agent's own page: inside its browser, centered. */
    const pillOn = t => {
      const card = N.noticeElement(t, "zenius-control");
      if (!card) return "no pill";
      const c = card.getBoundingClientRect();
      const b = t.linkedBrowser.getBoundingClientRect();
      const within = c.left >= b.left - 1 && c.right <= b.right + 1 && c.top >= b.top - 1 && c.bottom <= b.bottom + 1;
      const centered = Math.abs(c.left + c.width / 2 - (b.left + b.width / 2)) <= 1;
      return within && centered ? "on its page" : JSON.stringify({ card: [c.left, c.top, c.width, c.height], browser: [b.left, b.top, b.width, b.height] });
    };
    const stripIn = w => {
      const strip = w.document.getElementById("zenius-agents-strip");
      if (!strip || strip.hidden) return "no strip";
      if (inside(strip.getBoundingClientRect(), w)) return "in the window";
      // Compact mode slides the sidebar out, and the strip with it.
      const sidebar = w.gZenCompactModeManager?.preference && w.gZenCompactModeManager.sidebar;
      if (sidebar?.contains(strip) && !inside(sidebar.getBoundingClientRect(), w)) return "with the hidden sidebar";
      return JSON.stringify(strip.getBoundingClientRect());
    };
    const panelIn = async w => {
      const strip = w.document.getElementById("zenius-agents-strip");
      const panel = () => w.document.getElementById("zenius-tasks-panel");
      strip.click();
      try {
        await until(() => panel()?.state === "open");
        await sleep(100);
        return inside(panel().getBoundingClientRect(), w) ? "in the window" : JSON.stringify(panel().getBoundingClientRect());
      } finally {
        panel()?.hidePopup();
        await until(() => !panel() || panel().state === "closed");
      }
    };
    /** I1: an agent action leaves the window's Space and selected tab. */
    const agentActsUnseen = async (w = win) => {
      const before = [w.gZenWorkspaces.activeWorkspace, w.gBrowser.selectedTab];
      await C.moveCursor(tab, { x: 60, y: 60 }, { label: "Click Next", kind: "click" });
      await sleep(50);
      return w.gZenWorkspaces.activeWorkspace === before[0] && w.gBrowser.selectedTab === before[1];
    };
  `;
});

after(async () => {
  await h?.chrome(`${P} await back();`).catch(() => {});
  await h?.close();
});

test("in each sidebar layout the strip and the panel stay in the window, the pill on the agent's page, and I1 holds", async () => {
  const out = await h.chrome(`${P}
    const saved = Object.fromEntries(${JSON.stringify(LAYOUT_PREFS)}.map(p => [p, Services.prefs.prefHasUserValue(p) ? Services.prefs.getBoolPref(p) : null]));
    const compactWas = gZenCompactModeManager.preference;
    const reset = () => {
      for (const [p, v] of Object.entries(saved)) {
        if (v === null) Services.prefs.clearUserPref(p);
        else Services.prefs.setBoolPref(p, v);
      }
      if (gZenCompactModeManager.preference !== compactWas) gZenCompactModeManager.preference = compactWas;
    };
    const layouts = {
      "single toolbar": () => Services.prefs.setBoolPref("zen.view.use-single-toolbar", true),
      "multiple toolbars": () => Services.prefs.setBoolPref("zen.view.use-single-toolbar", false),
      collapsed: () => Services.prefs.setBoolPref("zen.view.sidebar-expanded", false),
      "sidebar on the right": () => Services.prefs.setBoolPref("zen.tabs.vertical.right-side", true),
      compact: () => { gZenCompactModeManager.preference = true; },
    };
    const res = {};
    try {
      for (const [layout, apply] of Object.entries(layouts)) {
        reset();
        apply();
        await sleep(500);
        await show();
        await handOff();
        const expanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
        const tc = tab.querySelector(".tab-content");
        res[layout] = {
          strip: stripIn(win),
          pill: pillOn(tab),
          panel: await panelIn(win),
          // Expanded, the tag is the chip with the task's name; collapsed,
          // the dot on the icon.
          tag: expanded
            ? win.getComputedStyle(tc, "::after").content === JSON.stringify(rec.name)
            : win.getComputedStyle(tab.querySelector(".tab-icon-stack"), "::before").content !== "none",
        };
        await back();
        res[layout].i1 = await agentActsUnseen();
      }
      return res;
    } finally {
      reset();
      await back();
    }
  `);
  for (const [layout, got] of Object.entries(out)) {
    const strip = layout === "compact" && got.strip === "with the hidden sidebar" ? got.strip : "in the window";
    assert.deepEqual(got, { strip, pill: "on its page", panel: "in the window", tag: true, i1: true }, layout);
  }
  assert.equal(Object.keys(out).length, 5);
});

test("a second window gets the strip, the panel and the claim prompt, and an agent action changes neither window's view", async () => {
  const id = `layouts-claim-${Date.now()}`;
  const out = await h.chrome(`${P}
    const w2 = win.OpenBrowserWindow();
    try {
      await until(() => w2.gBrowser && w2.gZenWorkspaces?.activeWorkspace && w2.document.readyState === "complete", 10000);
      await until(() => w2.document.getElementById("zenius-agents-strip"), 5000);
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: rec.id, name: "Work", client: "", until: Date.now() + 60000 });
      const claimIn = [win, w2].map(w => !!N.noticeElement(w.gBrowser.selectedTab, ${JSON.stringify("zenius-claim:" + id)}));
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      const claimGone = [win, w2].every(w => !N.noticeElement(w.gBrowser.selectedTab, ${JSON.stringify("zenius-claim:" + id)}));
      return {
        strip: stripIn(w2),
        panel: await panelIn(w2),
        claimIn,
        claimGone,
        i1: (await agentActsUnseen(w2)) && (await agentActsUnseen(win)),
      };
    } finally {
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      w2.close();
      await until(() => w2.closed, 5000);
    }
  `);
  assert.deepEqual(out, { strip: "in the window", panel: "in the window", claimIn: [true, true], claimGone: true, i1: true });
});

// zen-eval's Mac run (2026-11-20): a popup is a window of its own, which the
// system keeps on the screen but not in the browser's window. With the
// sidebar on the right the panel ran 62 px past the window's right edge, and
// in a second window it started at x -13, Stop and Resume agent with it. Here
// the windows don't fill the screen, as there, and a margin pushes the panel
// out as Zen's 8 px shadow margin does on a Mac (Linux has none).
//
// Only a headless window fills its screen, so only a headless run resizes
// and moves the windows. On a Mac they stay where they are: moved, the
// window can end up under the user's front window, macOS gives a covered
// window no frames, and a panel without a frame never opens (zen-eval's
// unfocused run, 2026-11-20; zen-ux's probe with a paused refresh driver).
// The margin's push makes the overflow in any window.
const HEADLESS = process.env.ZENIUS_UX_HEADED !== "1";
test("the tasks panel grows toward the window's middle and stays inside a window that doesn't fill the screen: either sidebar side, a second window, and a margin that pushes it out", async () => {
  const out = await h.chrome(`${P}
    const geo = [win.screenX, win.screenY, win.outerWidth, win.outerHeight];
    const right = on => (on ? Services.prefs.setBoolPref("zen.tabs.vertical.right-side", true) : Services.prefs.clearUserPref("zen.tabs.vertical.right-side"));
    const open = async w => {
      const strip = w.document.getElementById("zenius-agents-strip");
      await until(() => strip && !strip.hidden);
      strip.click();
      const panel = w.document.getElementById("zenius-tasks-panel");
      try {
        await until(() => panel.state === "open", 8000);
      } catch {
        // What a run that can't open it should tell.
        throw new Error("the panel didn't open: " + JSON.stringify({ state: panel.state, active: Services.focus.activeWindow === w, visibility: w.document.visibilityState, at: [w.screenX, w.screenY, w.outerWidth, w.outerHeight], screen: [w.screen.availLeft, w.screen.availTop, w.screen.availWidth, w.screen.availHeight] }));
      }
      await sleep(100);
      return { strip, panel };
    };
    const close = async panel => {
      panel.hidePopup();
      await until(() => panel.state === "closed");
    };
    const measure = async (w, side, push) => {
      right(side === "right");
      await sleep(400);
      // The panel exists once it has opened.
      const first = await open(w);
      await close(first.panel);
      first.panel.style.removeProperty("margin");
      if (push) first.panel.style.setProperty("margin", "0 -30px", "important");
      const { strip, panel } = await open(w);
      const p = panel.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      await close(panel);
      panel.style.removeProperty("margin");
      const where = { inner: [w.innerWidth, w.innerHeight], at: [w.screenX, w.screenY], strip: [s.left, s.right], panel: [p.left, p.right, p.top, p.bottom] };
      return {
        inside: inside(p, w) || JSON.stringify(where),
        // It grows from the strip's outer edge toward the window's middle.
        towardMiddle: (side === "right" ? p.left < s.left : p.right > s.right) || JSON.stringify(where),
      };
    };
    const res = {};
    let w2 = null;
    try {
      if (${HEADLESS}) {
        win.resizeTo(1000, 700);
        win.moveTo(150, 40);
        await sleep(400);
      }
      for (const side of ["left", "right"]) {
        for (const push of [false, true]) res["first window, " + side + (push ? ", pushed" : "")] = await measure(win, side, push);
      }
      right(false);
      w2 = win.OpenBrowserWindow();
      await until(() => w2.gBrowser && w2.gZenWorkspaces?.activeWorkspace && w2.document.readyState === "complete", 10000);
      if (${HEADLESS}) {
        w2.resizeTo(900, 650);
        w2.moveTo(200, 70);
      }
      await sleep(400);
      for (const side of ["left", "right"]) {
        for (const push of [false, true]) res["second window, " + side + (push ? ", pushed" : "")] = await measure(w2, side, push);
      }
      return res;
    } finally {
      right(false);
      if (w2) {
        w2.close();
        await until(() => w2.closed, 5000);
      }
      if (${HEADLESS}) {
        win.resizeTo(geo[2], geo[3]);
        win.moveTo(geo[0], geo[1]);
        await sleep(300);
      }
    }
  `);
  for (const [where, got] of Object.entries(out)) {
    assert.deepEqual(got, { inside: true, towardMiddle: true }, where);
  }
  assert.equal(Object.keys(out).length, 8);
});

test("the tasks panel still moves into its window when its screen rect says it's inside, or when a move doesn't take (Zen 1.24.3b on a Mac)", async () => {
  // zen-eval's bisect (0c25f24): on Zen 1.24.3b on a Mac, 548c848's
  // keepInWindow no longer moved the panel. These stand in for the two ways
  // that could happen, with the 30 px push that forces the overflow here.
  const out = await h.chrome(`${P}
    const strip = win.document.getElementById("zenius-agents-strip");
    const panel = () => win.document.getElementById("zenius-tasks-panel");
    const open = async () => {
      await until(() => strip && !strip.hidden);
      strip.click();
      await until(() => panel()?.state === "open", 8000);
      await sleep(400);
      return panel().getBoundingClientRect();
    };
    const close = async () => {
      panel().hidePopup();
      await until(() => panel().state === "closed");
    };
    const res = {};
    const geo = [win.screenX, win.screenY, win.outerWidth, win.outerHeight];
    try {
      if (${HEADLESS}) {
        win.resizeTo(1000, 700);
        win.moveTo(150, 40);
        await sleep(400);
      }
      // The panel exists once it has opened.
      await open();
      await close();
      panel().style.setProperty("margin", "0 -30px", "important");
      // Its screen rect says it sits well inside the window.
      panel().getOuterScreenRect = function () {
        return new win.DOMRect(win.mozInnerScreenX + 200, win.mozInnerScreenY + 200, 300, 200);
      };
      const stale = await open();
      res.staleScreen = inside(stale, win) || JSON.stringify([stale.left, stale.right]);
      await close();
      delete panel().getOuterScreenRect;
      // Its moves along its anchor don't take.
      const asked = [];
      panel().moveToAnchor = (...args) => asked.push(args.slice(1, 4));
      const stuck = await open();
      res.stuckMove = inside(stuck, win) || JSON.stringify([stuck.left, stuck.right]);
      res.asked = asked.length > 0;
      await close();
      return res;
    } finally {
      if (panel()) {
        delete panel().getOuterScreenRect;
        delete panel().moveToAnchor;
        panel().style.removeProperty("margin");
        if (panel().state !== "closed") panel().hidePopup();
      }
      if (${HEADLESS}) {
        win.resizeTo(geo[2], geo[3]);
        win.moveTo(geo[0], geo[1]);
        await sleep(300);
      }
    }
  `);
  assert.deepEqual(out, { staleScreen: true, stuckMove: true, asked: true });
});

// The agent's words at length, as a task might put them.
const LONG_MESSAGE =
  "Sign in with the account ending in 42, then open Statements, choose March 2026 and keep the page open so I can download the PDF and check the totals against the receipts";

test("in each sidebar layout every card the user can meet sits whole on the agent's page: the hand-off with a short message, a long one, the Resume line leading, and a long task with a long site (the site never cut); Network access denied, typed (a long host too) and page-chosen; the made-page card and its refusal; the Reload card, and its other-window note; and the page-code ask (a long site too)", async () => {
  const out = await h.chrome(`${P}
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const PC = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pagecode.sys.mjs");
    const UI = UIM.ZeniusUI;
    const saved = Object.fromEntries(${JSON.stringify(LAYOUT_PREFS)}.map(p => [p, Services.prefs.prefHasUserValue(p) ? Services.prefs.getBoolPref(p) : null]));
    const compactWas = gZenCompactModeManager.preference;
    const justInTime = UI.secretLineJustInTime;
    const reset = () => {
      for (const [p, v] of Object.entries(saved)) {
        if (v === null) Services.prefs.clearUserPref(p);
        else Services.prefs.setBoolPref(p, v);
      }
      if (gZenCompactModeManager.preference !== compactWas) gZenCompactModeManager.preference = compactWas;
    };
    const layouts = {
      "single toolbar": () => Services.prefs.setBoolPref("zen.view.use-single-toolbar", true),
      "multiple toolbars": () => Services.prefs.setBoolPref("zen.view.use-single-toolbar", false),
      collapsed: () => Services.prefs.setBoolPref("zen.view.sidebar-expanded", false),
      "sidebar on the right": () => Services.prefs.setBoolPref("zen.tabs.vertical.right-side", true),
      compact: () => { gZenCompactModeManager.preference = true; },
    };
    // A visible run holds each card for the eye (zen-eval's look on the Mac).
    const hold = ${HEADLESS ? 350 : 1500};
    const handOffWith = text => {
      ctx.spaces.setStateText(rec, text);
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      return "zenius-control";
    };
    const put = (id, card) => {
      N.showNotice(tab, id, card);
      return id;
    };
    const states = {
      "hand-off": () => handOffWith("Log in to continue"),
      "hand-off, a long message": () => handOffWith(${JSON.stringify(LONG_MESSAGE)}),
      "hand-off, the Resume line leading": () => {
        const id = handOffWith("Log in to continue");
        UI.secretTyped({ browser });
        return id;
      },
      // The site the user is on follows the task's name, which gives way first.
      "hand-off, a long task and a long site": () =>
        put("zenius-test-site", {
          ...UIM.controlCard({ name: "Book a table for four at the Italian place on Main Street this Friday", stateText: "Log in to continue" }, "agent"),
          site: "examplecorporation-identity-services.co.uk",
          buttons: [{ label: "Resume agent", primary: true }],
        }),
      "Network access denied, typed": () => put("zenius-localnet", UIM.localNetCard({ host: "192.168.1.10", typed: true }, { allow: () => {} })),
      "Network access denied, typed, a long host": () =>
        put("zenius-localnet", UIM.localNetCard({ host: "the-lab-printer-on-the-third-floor-by-the-window.local", typed: true }, { allow: () => {} })),
      "Network access denied, page-chosen": () => put("zenius-localnet", UIM.localNetCard({ host: "printer.local", typed: false })),
      "the agent made this page": () => put("zenius-kept-code", UIM.madePageCard()),
      "the agent made this page, a refusal": () => put("zenius-kept-code", UIM.madePageCard({ refused: "camera" })),
      "this page couldn't reload": () => put("zenius-typing-off", UIM.reloadFailedCard()),
      "this page couldn't reload, another window on the site": () => put("zenius-typing-off", UIM.reloadFailedCard({ stillEvident: true })),
      "can't take over, another tab can reach it": () => put("zenius-takeover-refused", UIM.takeOverRefusedCard({ reason: "reachable" })),
      "can't take over, off the site": () => put("zenius-takeover-refused", UIM.takeOverRefusedCard({ reason: "reloadFailed", offSite: true })),
      "page code, ask": () => put(PC.PAGE_CODE_NOTICE + "https://example.com", PC.pageCodeCard("https://example.com")),
      "page code, ask, a long site": () =>
        put(PC.PAGE_CODE_NOTICE + "https://examplecorporation-identity-services.co.uk", PC.pageCodeCard("https://examplecorporation-identity-services.co.uk")),
    };
    const clear = id => {
      if (id === "zenius-control") {
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
        ctx.spaces.setStateText(rec, "");
      } else {
        N.removeNotice(tab, id);
      }
    };
    /** What doesn't fit: off its page or off center, a part cut, the line run over or on two lines, a missing '?'. */
    const misfits = id => {
      const el = N.noticeElement(tab, id);
      if (!el) return ["no card"];
      const out = [];
      const c = el.getBoundingClientRect();
      const b = tab.linkedBrowser.getBoundingClientRect();
      if (!(c.left >= b.left - 1 && c.right <= b.right + 1 && c.top >= b.top - 1 && c.bottom <= b.bottom + 1)) out.push("off its page");
      if (Math.abs(c.left + c.width / 2 - (b.left + b.width / 2)) > 1) out.push("off center");
      const within = r => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
      for (const part of el.querySelectorAll(".zenius-card-title, .zenius-card-detail, .zenius-card-site, .zenius-card-note, .zenius-card-more, .zenius-card-button")) {
        if (part.getClientRects().length && !within(part.getBoundingClientRect())) out.push("cut: " + (part.textContent.slice(0, 24) || part.className));
      }
      const note = el.querySelector(".zenius-card-note");
      if (note && note.scrollWidth > note.clientWidth + 1 && !el.hasAttribute("note-cut")) out.push("the line runs over with no '?'");
      if (note && Math.round(note.getBoundingClientRect().height) !== 16) out.push("the line isn't one line");
      const where = el.querySelector(".zenius-card-site");
      if (where && where.scrollWidth > where.clientWidth + 1) out.push("the site is cut");
      const q = el.querySelector(".zenius-card-more");
      if ((el.hasAttribute("note-cut") || el.hasAttribute("has-more")) && !(q && q.getClientRects().length && q.getBoundingClientRect().width > 0)) out.push("no '?'");
      return out;
    };
    UI.secretLineJustInTime = true;
    const res = {};
    let shown = 0;
    try {
      for (const [layout, apply] of Object.entries(layouts)) {
        reset();
        apply();
        await sleep(500);
        await show();
        for (const [state, render] of Object.entries(states)) {
          const id = render();
          await until(() => N.noticeElement(tab, id));
          await sleep(hold);
          const bad = misfits(id);
          if (bad.length) res[layout + " / " + state] = bad;
          shown++;
          clear(id);
          await until(() => !N.noticeElement(tab, id));
        }
        await back();
      }
      return { misfits: res, shown };
    } finally {
      UI.secretLineJustInTime = justInTime;
      for (const id of ["zenius-test-site", "zenius-localnet", "zenius-kept-code", "zenius-typing-off", "zenius-takeover-refused", PC.PAGE_CODE_NOTICE + "https://example.com", PC.PAGE_CODE_NOTICE + "https://examplecorporation-identity-services.co.uk"]) N.removeNotice(tab, id);
      reset();
      await back();
    }
  `);
  assert.deepEqual(out, { misfits: {}, shown: 5 * 15 });
});

test("the hold card's site stays whole at any page width: the task's name gives way first, then the buttons go under the line, and on a very narrow page the site takes a row of its own and wraps there", async () => {
  const out = await h.chrome(`${P}
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const task = { name: "Book a table for four at the Italian place on Main Street this Friday", stateText: "Log in to continue" };
    const resume = [{ label: "Resume agent", primary: true }];
    const cards = {
      "hand-off": site => ({ ...UIM.controlCard(task, "agent"), site, buttons: resume }),
      "Take over": site => ({ ...UIM.controlCard(task, "user"), site, buttons: resume }),
      "a permission hold": site => ({ ...UIM.controlCard(task, "permission", "for a passkey"), site, buttons: [] }),
    };
    const sites = { long: "examplecorporation-identity-services.co.uk", short: "example.com" };
    // The page's width, from wider than the widest pill to a sliver.
    const widths = [592, 480, 400, 320, 240];
    const ID = "zenius-test-site";
    const misfit = el => {
      const out = [];
      const layer = el.parentElement;
      const ls = win.getComputedStyle(layer);
      const l = layer.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      if (c.left < l.left + parseFloat(ls.paddingLeft) - 0.5 || c.right > l.right - parseFloat(ls.paddingRight) + 0.5) out.push("off its page");
      const within = r => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
      for (const part of el.querySelectorAll(".zenius-card-title, .zenius-card-detail, .zenius-card-site, .zenius-card-note, .zenius-card-more, .zenius-card-button")) {
        if (part.getClientRects().length && !within(part.getBoundingClientRect())) out.push("cut: " + part.className);
      }
      const site = el.querySelector(".zenius-card-site");
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(site);
      if ([...range.getClientRects()].some(r => !within(r))) out.push("the site's text is cut");
      const oneLine = e => !e || !e.getClientRects().length || e.getBoundingClientRect().height <= 19;
      if (!oneLine(el.querySelector(".zenius-card-title"))) out.push("the title wraps");
      const detail = el.querySelector(".zenius-card-detail");
      if (!el.hasAttribute("site-alone")) {
        if (!oneLine(site)) out.push("the site wraps in the title row");
        // Right after the task's name, which gives way to it: the site's box
        // starts with its own " on " (the user's text pass), not the card's gap.
        if (detail?.getClientRects().length && Math.abs(site.getBoundingClientRect().left - detail.getBoundingClientRect().right) > 1) out.push("the site isn't right after the task");
      }
      return out;
    };
    const mode = el => (el.hasAttribute("site-alone") ? "alone" : el.hasAttribute("site-stacked") ? "stacked" : "beside");
    const misfits = {};
    const modes = {};
    // The pill's ResizeObservers settle it in a frame or two, which a
    // throttled Mac (zen-eval's background-priority run, the screen locked)
    // stretches past a fixed wait: measure once the card's mode and its
    // parts' boxes stay the same from one frame to the next.
    const twoFrames = () => Promise.race([new Promise(r => win.requestAnimationFrame(() => win.requestAnimationFrame(r))), sleep(500)]);
    const shape = el => mode(el) + JSON.stringify([...el.querySelectorAll("*")].map(e => {
      const b = e.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map(Math.round);
    }));
    const steady = async () => {
      let last = null;
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        await twoFrames();
        await sleep(30);
        const now = N.noticeElement(tab, ID) ? shape(N.noticeElement(tab, ID)) : null;
        if (now !== null && now === last) {
          return;
        }
        last = now;
      }
    };
    let layer = null;
    await show();
    try {
      for (const [kind, make] of Object.entries(cards)) {
        for (const [length, site] of Object.entries(sites)) {
          const seen = [];
          for (const w of widths) {
            N.showNotice(tab, ID, make(site));
            await until(() => N.noticeElement(tab, ID));
            layer = N.noticeElement(tab, ID).parentElement;
            layer.style.width = w + "px";
            await steady();
            const el = N.noticeElement(tab, ID);
            const bad = misfit(el);
            if (bad.length) misfits[kind + " / " + length + " / " + w] = bad;
            seen.push(mode(el));
          }
          modes[kind + " / " + length] = seen.join(" ");
          N.removeNotice(tab, ID);
          await until(() => !N.noticeElement(tab, ID));
        }
      }
      return { misfits, modes };
    } finally {
      N.removeNotice(tab, ID);
      layer?.style.removeProperty("width");
      await back();
    }
  `);
  assert.deepEqual(out.misfits, {});
  const order = ["beside", "stacked", "alone"];
  for (const [card, seen] of Object.entries(out.modes)) {
    const steps = seen.split(" ").map(m => order.indexOf(m));
    assert.ok(steps.every((m, i) => i === 0 || m >= steps[i - 1]), `${card}: a narrower page never brings the site's row back (${seen})`);
    if (card.startsWith("a permission hold")) assert.ok(!seen.includes("stacked"), `${card}: no buttons to stack (${seen})`);
  }
  assert.ok(Object.values(out.modes).some(seen => seen.includes("stacked")), `the buttons went under the line at some width: ${JSON.stringify(out.modes)}`);
  for (const card of ["hand-off", "Take over", "a permission hold"]) {
    assert.equal(out.modes[`${card} / short`].split(" ")[0], "beside", `${card}: a short site sits beside the buttons on a wide page`);
    assert.equal(out.modes[`${card} / long`].split(" ").at(-1), "alone", `${card}: a long site takes its own row on a sliver of a page`);
  }
});

test("split view: the agent's half shows its pill and its cursor, and the user's tab stays selected", async () => {
  const out = await h.chrome(`${P}
    await show();
    const mine = gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    try {
      gZenViewSplitter.splitTabs([mine, tab], "vsep", 0);
      await sleep(500);
      gBrowser.selectedTab = mine;
      await until(() => gBrowser.selectedTab === mine);
      await sleep(200);
      const visible = V.isTabVisible(tab);
      const { value: move, gap } = await withFrames(() => C.moveCursor(tab, { x: 50, y: 50 }, { label: "Click Save", kind: "click" }));
      await handOff();
      return {
        visible,
        animated: move.animated,
        gap,
        pill: pillOn(tab),
        userTabStays: gBrowser.selectedTab === mine,
      };
    } finally {
      try { gZenViewSplitter.unsplitCurrentView(); } catch {}
      await sleep(300);
      gBrowser.removeTab(mine, { animate: false });
      await back();
    }
  `);
  const { animated, gap, ...rest } = out;
  assert.deepEqual(rest, { visible: true, pill: "on its page", userTabStays: true });
  // As in cursor.test.mjs: a window that paints too seldom (zen-eval's
  // throttled Mac) may end the move before its animation does.
  if (gap > SMOOTH_FRAME_MS) {
    console.log(`# frames up to ${gap} ms apart: the cursor's move may resolve before its animation ends (animated ${animated}); not checked here`);
  } else {
    assert.equal(animated, true, `the cursor's move animates in the agent's half (frames at most ${gap} ms apart)`);
  }
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
