// Accessibility of everything zenius shows: screen-reader names and
// announcements, the keyboard, contrast and right-to-left names. What needs
// macOS's own settings (VoiceOver, keyboard navigation, Increase contrast,
// Reduce motion) is checked by hand on the Mac.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, prelude, setup } from "./lib.mjs";

const RTL = "הזמנת שולחן 4!";
let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let name;
let userView;
let P;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  name = `zen-ux a11y ${Date.now().toString(36).slice(-5)}`;
  ({ id: space } = await h.createSpace({ name }));
  // A plain-text page: nothing in it takes the focus, so Tab leaves it.
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/api/text` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const doc = win.document;
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
    // The hold's card as it ships: the Resume line comes just in time, after
    // zen-input's onSecretTyped (handoff.test.mjs has it), so a hand-off's
    // small text is the agent's words.
    win.__zuJustInTime ??= UI.secretLineJustInTime;
    UI.secretLineJustInTime = true;
    const handOff = async text => {
      ctx.spaces.setStateText(rec, text);
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      await until(() => N.noticeElement(tab, "zenius-control"));
      return N.noticeElement(tab, "zenius-control");
    };
    // Firefox's announcer: A11yUtils.announce puts each message in a fresh
    // label of this role=alert element.
    const announcer = doc.getElementById("a11y-announcement");
    const heard = () => announcer.firstChild?.getAttribute("aria-label") ?? null;
    // Announcements go out together a moment after the first (ANNOUNCE_MS),
    // or later on a busy machine: wait them out before clearing, and before
    // reading.
    const settle = () => UIM.announcementsOut(win);
    const hush = async () => {
      await settle();
      announcer.replaceChildren();
    };
    const heardSoon = async () => {
      await settle();
      return heard();
    };
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const key = (k, code, keyCode) => {
      const ev = new win.KeyboardEvent("", { key: k, code, keyCode });
      tip.keydown(ev);
      tip.keyup(ev);
    };
    const tabKey = () => key("Tab", "Tab", 9);
    const shiftTab = () => {
      const shift = new win.KeyboardEvent("", { key: "Shift", code: "ShiftLeft", keyCode: 16 });
      tip.keydown(shift);
      tabKey();
      tip.keyup(shift);
    };
    // The window's own focus: Services.focus.focusedElement is the active
    // window's, and the OS can take the window's activation away (zen-eval's
    // throttled run, the screen locked) without anything moving its focus.
    const focused = () => Services.focus.getFocusedElementForWindow(win, true, {});
    const where = () => {
      const el = focused();
      if (!el) return "nothing";
      if (el === browser) return "page";
      if (el.id === "urlbar-input") return "urlbar";
      const card = el.closest?.(".zenius-card");
      return card ? card.dataset.value + ": " + el.textContent : el.localName + (el.id ? "#" + el.id : "");
    };
    const steps = async (n, step) => {
      const seen = [];
      for (let i = 0; i < n; i++) {
        step();
        await sleep(60);
        seen.push(where());
      }
      return seen;
    };
    const stubAlerts = () => {
      const prior = Services.prefs.prefHasUserValue("zenius.ux.handoff.systemNotification")
        ? Services.prefs.getBoolPref("zenius.ux.handoff.systemNotification") : null;
      Services.prefs.setBoolPref("zenius.ux.handoff.systemNotification", true);
      UI.alertsService = {
        shown: [], closed: [],
        showAlert(alert, listener) { this.shown.push({ name: alert.name, title: alert.title, text: alert.text, listener }); },
        closeAlert(n) { this.closed.push(n); },
      };
      return () => {
        UI.alertsService = null;
        if (prior === null) Services.prefs.clearUserPref("zenius.ux.handoff.systemNotification");
        else Services.prefs.setBoolPref("zenius.ux.handoff.systemNotification", prior);
      };
    };
    const view = () => ({ ws: gZenWorkspaces.activeWorkspace, tab: gBrowser.selectedTab, focus: focused() });
    const sameView = (a, b) => a.ws === b.ws && a.tab === b.tab && a.focus === b.focus;
  `;
});

after(async () => {
  await h?.chrome(`${P}
    Services.prefs.clearUserPref("accessibility.tabfocus");
    UI.secretLineJustInTime = win.__zuJustInTime;
    delete win.__zuJustInTime;
    await back();
  `).catch(() => {});
  await h?.close();
});

test("a pill is a group named by its text, not a live region; Agent needs you is announced instead, with no focus moved", async () => {
  const out = await h.chrome(`${P}
    await show();
    const before = view();
    await hush();
    try {
      const card = await handOff("Log in to continue");
      return {
        role: card.getAttribute("role"),
        live: card.hasAttribute("aria-live") || !!card.querySelector("[aria-live]"),
        label: card.getAttribute("aria-label"),
        heard: await heardSoon(),
        still: sameView(before, view()),
      };
    } finally {
      await back();
    }
  `);
  assert.deepEqual(out, {
    role: "group",
    live: false,
    label: `Agent needs you, ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”.`,
    heard: `Agent needs you in ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”.`,
    still: true,
  });
});

test("a passkey or permission handoff is announced and raises the opted-in OS notification, which moves nothing", async () => {
  const out = await h.chrome(`${P}
    const restore = stubAlerts();
    const before = view();
    await hush();
    try {
      UI.holdForUser(browser, "permission_prompt", "a11y-passkey", "for a passkey", "https://a11y-passkey.example");
      await until(() => rec.ownership === "agentDelegatedToUser");
      const shown = UI.alertsService.shown.map(({ name, title, text }) => ({ name, title, text }));
      return { heard: await heardSoon(), shown, still: sameView(before, view()) };
    } finally {
      UI.releaseForUser(browser, "a11y-passkey", false);
      restore();
      await back();
    }
  `);
  assert.deepEqual(out, {
    heard: `Agent paused in ${iso(name)}, on ${site()}: page asks for a passkey.`,
    shown: [{ name: `zenius-handoff-${space}`, title: `An agent needs you: ${name}`, text: "The page asks for a passkey." }],
    still: true,
  });
});

test("a handoff's OS notification goes when the task stops waiting: handed back, or stopped; a hand back with none up closes nothing", async () => {
  const { id: other } = await h.createSpace({ name: `zen-ux a11y stop ${Date.now().toString(36).slice(-5)}` });
  await h.call("page.goto", { space: other, page: "p1", url: `${h.base}/api/text` });
  const out = await h.chrome(`${P}
    const restore = stubAlerts();
    const names = () => UI.alertsService.shown.map(a => a.name);
    const rec2 = ctx.spaces.peek(${other});
    try {
      await handOff("Log in to continue");
      const shown = names();
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      const backClosed = UI.alertsService.closed.slice();
      // The user takes over and hands back: no notification went up.
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "user" });
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      const quietClosed = UI.alertsService.closed.slice();
      // Another task needs the user, who stops it from the panel instead.
      ctx.spaces.setStateText(rec2, "Approve the payment");
      ctx.spaces.setOwnership(rec2, "agentDelegatedToUser", { source: "agent" });
      await until(() => names().includes("zenius-handoff-${other}"));
      UI.stopByUser(rec2);
      await until(() => rec2.ownership === "user");
      return { shown, backClosed, quietClosed, stoppedClosed: UI.alertsService.closed.slice() };
    } finally {
      restore();
      if (rec2.ownership === "agentDelegatedToUser") UI.stopByUser(rec2);
      await back();
    }
  `);
  assert.deepEqual(out, {
    shown: [`zenius-handoff-${space}`],
    backClosed: [`zenius-handoff-${space}`],
    quietClosed: [`zenius-handoff-${space}`],
    stoppedClosed: [`zenius-handoff-${space}`, `zenius-handoff-${other}`],
  });
});

test("the claim prompt is announced and raises the opted-in OS notification, which goes when the ask settles", async () => {
  const id = `a11y-claim-${Date.now()}`;
  const out = await h.chrome(`${P}
    const mine = ctx.service.spaces.records().find(r => r.uuid === gZenWorkspaces.activeWorkspace);
    const restore = stubAlerts();
    const before = view();
    await hush();
    try {
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: mine.id, name: mine.name, client: "Trip planner", until: Date.now() + 60000 });
      const res = {
        heard: await heardSoon(),
        shown: UI.alertsService.shown.map(({ name, title, text }) => ({ name, title, text })),
        still: sameView(before, view()),
        name: mine.name,
      };
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      res.closed = UI.alertsService.closed;
      return res;
    } finally {
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      restore();
    }
  `);
  const note = `An agent asks to work in your Space “${iso(out.name)}”. It calls itself “${iso("Trip planner")}”.`;
  assert.equal(out.heard, `Agent request. ${note}`);
  assert.deepEqual(out.shown, [{ name: `zenius-claim-${id}`, title: "Agent request", text: note }]);
  assert.equal(out.still, true);
  assert.deepEqual(out.closed, [`zenius-claim-${id}`]);
});

test("moments that come together are heard together: one announcement, each named in the order it came", async () => {
  const otherName = `zen-ux a11y burst ${Date.now().toString(36).slice(-5)}`;
  const { id: other } = await h.createSpace({ name: otherName });
  await h.call("page.goto", { space: other, page: "p1", url: `${h.base}/api/text` });
  const id = `a11y-burst-${Date.now()}`;
  const out = await h.chrome(`${P}
    await hush();
    const rec2 = ctx.spaces.peek(${other});
    const mine = ctx.service.spaces.records().find(r => r.uuid === gZenWorkspaces.activeWorkspace);
    let alerts = 0;
    const count = new win.MutationObserver(recs => {
      for (const r of recs) alerts += r.addedNodes.length;
    });
    count.observe(announcer, { childList: true });
    try {
      // Two tasks hand off and an agent asks for the user's Space, at once.
      ctx.spaces.setStateText(rec, "Log in to continue");
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      ctx.spaces.setStateText(rec2, "Approve the payment");
      ctx.spaces.setOwnership(rec2, "agentDelegatedToUser", { source: "agent" });
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: mine.id, name: mine.name, client: "Trip planner", until: Date.now() + 60000 });
      const said = await heardSoon();
      return { said, alerts, mine: mine.name };
    } finally {
      count.disconnect();
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      if (rec2.ownership !== "agent") ctx.spaces.setOwnership(rec2, "agent", { source: "user" });
      await back();
    }
  `);
  assert.equal(out.alerts, 1, "one announcement");
  assert.equal(
    out.said,
    [
      `Agent needs you in ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”.`,
      `Agent needs you in ${iso(otherName)}, on ${site()}. The agent says: “${iso("Approve the payment")}”.`,
      `Agent request. An agent asks to work in your Space “${iso(out.mine)}”. It calls itself “${iso("Trip planner")}”.`,
    ].join(" ")
  );
});

test("routine agent actions announce nothing", async () => {
  const out = await h.chrome(`${P}
    await show();
    await hush();
    try {
      await C.moveCursor(tab, { x: 40, y: 40 }, { label: "Click Search", kind: "click" });
      await C.moveCursor(tab, { x: 80, y: 60 }, { label: "Type", kind: "move" });
      ctx.spaces.setStateText(rec, "Searching for flights");
      return await heardSoon();
    } finally {
      await back();
    }
  `);
  assert.equal(out, null);
});

test("Tab from the page and Shift+Tab from the address bar reach every pill button, in order", async () => {
  const id = `a11y-keys-${Date.now()}`;
  const out = await h.chrome(`${P}
    await show();
    try {
      await handOff("Log in to continue");
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: rec.id, name: "Work", client: "", until: Date.now() + 60000 });
      await until(() => N.noticeElement(tab, ${JSON.stringify("zenius-claim:" + id)}));
      browser.focus();
      await sleep(100);
      const forward = await steps(4, tabKey);
      gURLBar.focus();
      await sleep(100);
      const backward = await steps(4, shiftTab);
      // macOS without "Keyboard navigation": Tab goes to text fields only,
      // but the pills' HTML buttons are still in the order.
      Services.prefs.setIntPref("accessibility.tabfocus", 1);
      browser.focus();
      await sleep(100);
      const macDefault = await steps(1, tabKey);
      return { forward, backward, macDefault };
    } finally {
      Services.prefs.clearUserPref("accessibility.tabfocus");
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      await back();
    }
  `);
  const claim = `zenius-claim:${id}`;
  assert.deepEqual(out.forward, ["zenius-control: Resume agent", `${claim}: Allow`, `${claim}: Deny`, "urlbar"]);
  assert.deepEqual(out.backward, [`${claim}: Deny`, `${claim}: Allow`, "zenius-control: Resume agent", "page"]);
  assert.deepEqual(out.macDefault, ["zenius-control: Resume agent"]);
});

test("Enter and Space press a pill's button; the focus goes back where it came from, and an update keeps it", async () => {
  const out = await h.chrome(`${P}
    await show();
    // Each step waits for what it needs (the focus where it went, the agent
    // back) rather than a fixed pause, which a throttled Mac (zen-eval's
    // background-priority run, the screen locked) outran; a wait that ends
    // without it leaves the assertion to say what was there.
    const waitFor = (fn, ms) => until(fn, ms).catch(() => {});
    const pill = () => N.noticeElement(tab, "zenius-control");
    try {
      // From the page: Enter on Resume agent. The card's buttons arm 400 ms
      // after it shows.
      await handOff("Log in to continue");
      await sleep(450);
      browser.focus();
      await waitFor(() => where() === "page", 5000);
      tabKey();
      await waitFor(() => where() !== "page", 3000);
      const onButton = where();
      key("Enter", "Enter", 13);
      await waitFor(() => rec.ownership === "agent" && !pill() && where() === "page", 10000);
      const afterEnter = { pill: !!pill(), focus: where() };
      // An update under the focus keeps it on its button.
      await handOff("Log in to continue");
      await sleep(450);
      browser.focus();
      await waitFor(() => where() === "page", 5000);
      tabKey();
      await waitFor(() => where() !== "page", 3000);
      ctx.spaces.setStateText(rec, "Enter the code sent to your phone");
      await until(() => pill()?.querySelector(".zenius-card-note")?.textContent.includes("phone"), 10000);
      const afterUpdate = where();
      // From the address bar: Space on Resume agent.
      gURLBar.focus();
      await waitFor(() => where() === "urlbar", 5000);
      shiftTab();
      await waitFor(() => where() !== "urlbar", 3000);
      key(" ", "Space", 32);
      await waitFor(() => rec.ownership === "agent" && !pill() && where() === "urlbar", 10000);
      return { onButton, afterEnter, afterUpdate, afterSpace: where() };
    } finally {
      await back();
    }
  `);
  assert.deepEqual(out, {
    onButton: "zenius-control: Resume agent",
    afterEnter: { pill: false, focus: "page" },
    afterUpdate: "zenius-control: Resume agent",
    afterSpace: "urlbar",
  });
});

test("the tasks panel names each row after its task, so its buttons say which task they're for", async () => {
  const out = await h.chrome(`${P}
    const strip = doc.getElementById("zenius-agents-strip");
    const panel = () => doc.getElementById("zenius-tasks-panel");
    strip.click();
    await until(() => panel()?.state === "open");
    try {
      const row = panel().querySelector('.zenius-task[data-space="' + rec.id + '"]');
      const buttons = [...row.querySelectorAll(".zenius-task-actions button, .zenius-task-tab")];
      return {
        role: row.getAttribute("role"),
        label: row.getAttribute("aria-label"),
        buttons: [...row.querySelectorAll(".zenius-task-actions button")].map(b => b.textContent),
        // VoiceOver reads a focused button's own name, not its row's: each
        // is described by the row.
        described: buttons.length > 2 && buttons.every(b => b.getAttribute("aria-describedby") === row.id) && doc.getElementById(row.id) === row,
      };
    } finally {
      panel().hidePopup();
      await until(() => panel().state === "closed");
    }
  `);
  assert.equal(out.role, "group");
  assert.equal(out.label, iso(name));
  assert.ok(out.buttons.length > 0, JSON.stringify(out.buttons));
  assert.equal(out.described, true, "each button and tab is described by its row");
});

test("right-to-left names keep their own order and their place, in every text that shows them", async () => {
  const { id: rtlSpace } = await h.createSpace({ name: RTL });
  await h.call("page.goto", { space: rtlSpace, page: "p1", url: `${h.base}/api/text` });
  const out = await h.chrome(`${prelude(rtlSpace)}
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const { isolate } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/text.sys.mjs");
    const doc = win.document;
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const RTL = ${JSON.stringify(RTL)};
    // Where a character of a text node is drawn.
    const xOf = (node, i) => {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      return r.getBoundingClientRect().x;
    };
    try {
      ctx.spaces.setStateText(rec, "שלב 2!");
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab && N.noticeElement(tab, "zenius-control"));
      // The closing pill draws its detail as one text node.
      N.showNotice(tab, "zenius-a11y-rtl", UIM.closingCard(true, RTL));
      const detail = N.noticeElement(tab, "zenius-a11y-rtl").querySelector(".zenius-card-detail").firstChild;
      const text = detail.data;
      const bang = xOf(detail, text.indexOf("!"));
      const first = xOf(detail, text.indexOf("ה"));
      const closes = xOf(detail, text.indexOf("closes"));
      const nameChars = [...RTL].map((_, i) => xOf(detail, text.indexOf(RTL) + i));
      N.removeNotice(tab, "zenius-a11y-rtl");
      const status = doc.querySelector('zen-workspace[zenius-agent] .zenius-space-status-text')?.textContent ?? null;
      const tooltip = gBrowser.getTabTooltip(tab);
      const chip = win.getComputedStyle(tab.querySelector(".tab-content"), "::after");
      return {
        bangLeftOfName: bang < first,
        closesRightOfName: closes > Math.max(...nameChars),
        control: N.noticeText(tab, "zenius-control"),
        said: N.noticeElement(tab, "zenius-control").querySelector(".zenius-card-note")?.textContent ?? null,
        claimNote: UIM.claimCard("לקוח", RTL, 0).note,
        status,
        tooltipLine: tooltip.split("\\n").at(-1),
        chip: { content: chip.content, bidi: chip.unicodeBidi, overflow: chip.textOverflow },
        isolate: {
          override: isolate("a\\u202Eb"),
          early: isolate("a\\u2069b\\u2066c"),
          lines: isolate("a\\nb\\u0007c"),
          empty: isolate(""),
          none: isolate(undefined),
        },
      };
    } finally {
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  await h.call("spaces.finish", { space: rtlSpace, keep: [] }).catch(() => {});
  assert.equal(out.bangLeftOfName, true, "the name's '!' is at its left end, as in a right-to-left paragraph");
  assert.equal(out.closesRightOfName, true, "zenius's words after the name stay after it");
  assert.equal(out.control, `Agent needs you · ${iso(RTL)} on ${site()}`);
  assert.equal(out.said, `The agent says: “${iso("שלב 2!")}”.`);
  assert.equal(out.claimNote, `An agent asks to work in your Space “${iso(RTL)}”. It calls itself “${iso("לקוח")}”.`);
  assert.equal(out.status, `Agent needs you ${iso(RTL)}, ${iso("שלב 2!")}`);
  assert.equal(out.tooltipLine, `Task: ${iso(RTL)} · Agent needs you`);
  assert.equal(out.chip.content, `"${RTL}"`);
  assert.equal(out.chip.bidi, "plaintext");
  assert.match(out.chip.overflow, /^ellipsis( ellipsis)?$/);
  assert.deepEqual(out.isolate, { override: iso("ab"), early: iso("abc"), lines: iso("a b c"), empty: "", none: "" });
});

test("muted text is AA; with increased contrast the pill turns solid, with full-ink text and visible edges", async () => {
  const out = await h.chrome(`${P}
    await show();
    const prior = Services.prefs.prefHasUserValue("ui.useAccessibilityTheme") ? Services.prefs.getIntPref("ui.useAccessibilityTheme") : null;
    const style = card => {
      const s = win.getComputedStyle(card);
      const plain = card.querySelector("button:not([primary])");
      return {
        bg: s.backgroundColor,
        border: s.borderTopColor,
        blur: s.backdropFilter,
        ink: s.color,
        detail: win.getComputedStyle(card.querySelector(".zenius-card-detail")).color,
        plainEdge: plain ? win.getComputedStyle(plain).boxShadow : null,
      };
    };
    try {
      const dark = win.matchMedia("(prefers-color-scheme: dark)").matches;
      N.showNotice(tab, "zenius-a11y-contrast", UIM.closingCard(true, "Contrast"));
      const card = () => N.noticeElement(tab, "zenius-a11y-contrast");
      const normal = style(card());
      Services.prefs.setIntPref("ui.useAccessibilityTheme", 1);
      await until(() => win.matchMedia("(prefers-contrast: more)").matches);
      await sleep(50);
      const more = style(card());
      return { dark, normal, more };
    } finally {
      if (prior === null) Services.prefs.clearUserPref("ui.useAccessibilityTheme");
      else Services.prefs.setIntPref("ui.useAccessibilityTheme", prior);
      N.removeNotice(tab, "zenius-a11y-contrast");
      await back();
    }
  `);
  const ink = out.dark ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)";
  assert.equal(out.normal.detail, out.dark ? "rgba(245, 245, 247, 0.7)" : "rgba(29, 29, 31, 0.7)");
  assert.equal(out.more.bg, out.dark ? "rgb(28, 28, 30)" : "rgb(255, 255, 255)", "an opaque card");
  assert.equal(out.more.border, ink, "a solid edge");
  assert.equal(out.more.blur, "none");
  assert.equal(out.more.detail, ink, "full-ink detail");
  assert.match(out.more.plainEdge, /inset/, "an edge on the plain button");
});

// The cards added on 2026-11-20: the local-network notice, the pills a Stop
// and a finish leave on pages that ran the agent's code, the closing pill's
// line about them, and the claim prompt beside them. Their addresses are the
// fixture's, so no button reaches a real local host.
const agentCode = () => h.call("page.evaluate", { space, page: "p1", fn: "() => document.title", isFunction: true });

test("today's cards are groups named by all they show, not live regions, their buttons real buttons with the main one first and filled", async () => {
  await agentCode();
  const id = `a11y-today-${Date.now()}`;
  const out = await h.chrome(`${P}
    await show();
    const read = value => {
      const el = N.noticeElement(tab, value);
      if (!el) return null;
      const text = sel => el.querySelector(sel)?.textContent ?? "";
      const [title, detail, note] = [text(".zenius-card-title"), text(".zenius-card-detail"), text(".zenius-card-note")];
      return {
        role: el.getAttribute("role"),
        named: el.getAttribute("aria-label") === (detail ? title + ", " + detail : title) + (note ? ". " + note : ""),
        live: el.hasAttribute("aria-live") || !!el.querySelector("[aria-live]"),
        // Each button is described by its pill (VoiceOver reads a focused
        // button's own name, not its group's).
        described: (() => {
          const desc = el.querySelector(":scope > .zenius-card-desc");
          return !!desc && desc.textContent === el.getAttribute("aria-label") && [...el.querySelectorAll(".zenius-card-buttons > button")].every(b => b.getAttribute("aria-describedby") === desc.id && el.ownerDocument.getElementById(desc.id) === desc);
        })(),
        buttons: [...el.querySelectorAll(".zenius-card-buttons > *")].map(b => (b.localName === "button" ? "" : b.localName + ":") + (b.getAttribute("primary") === "true" ? "*" : "") + b.textContent),
      };
    };
    const refused = typed => UI.userLoadRefused({ browser, url: ${JSON.stringify(`${h.base}/api/text?x`)}, origin: ${JSON.stringify(h.base)}, typed, scope: "task" });
    const res = {};
    try {
      refused(true);
      res.typed = read("zenius-localnet");
      refused(false);
      res.chosen = read("zenius-localnet");
      N.removeNotice(tab, "zenius-localnet");
      // As a kept page the agent made shows them (keptcode.test.mjs has their
      // real paths): its reminder and a refusal; then the closing pill and a
      // tab that joined the task.
      N.showNotice(tab, "zenius-a11y-made", UIM.madePageCard());
      res.made = read("zenius-a11y-made");
      N.removeNotice(tab, "zenius-a11y-made");
      N.showNotice(tab, "zenius-a11y-refused", UIM.madePageCard({ refused: "window" }));
      res.refused = read("zenius-a11y-refused");
      N.removeNotice(tab, "zenius-a11y-refused");
      N.showNotice(tab, "zenius-a11y-closing", UIM.closingCard(true, rec.name));
      res.closing = read("zenius-a11y-closing");
      N.removeNotice(tab, "zenius-a11y-closing");
      N.showNotice(tab, "zenius-a11y-joined", UIM.joinedCard(rec.name));
      res.joined = read("zenius-a11y-joined");
      N.removeNotice(tab, "zenius-a11y-joined");
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: rec.id, name: "Work", client: "Trip planner", until: Date.now() + 60000 });
      await until(() => N.noticeElement(tab, ${JSON.stringify(`zenius-claim:${id}`)}));
      res.claim = read(${JSON.stringify(`zenius-claim:${id}`)});
      return res;
    } finally {
      N.removeNotice(tab, "zenius-localnet");
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      await back();
    }
  `);
  const ok = buttons => ({ role: "group", named: true, live: false, described: true, buttons });
  assert.deepEqual(out, {
    typed: ok(["*Open it yourself", "Add to allowlist", "Dismiss"]),
    chosen: ok(["*Open it yourself", "Dismiss"]),
    made: ok(["Dismiss"]),
    refused: ok(["Dismiss"]),
    closing: ok(["*Keep tab", "Close now"]),
    joined: ok(["*Resume agent"]),
    claim: ok(["*Allow", "Deny"]),
  });
});

test("each pill's buttons are described by the pill, and each panel row's by the row, as Gecko's accessibility service computes it: VoiceOver reads a focused button's own name, then its description", async () => {
  // The user's VoiceOver check (2026-11-20): a focused button was read by
  // its own name alone, without its pill's text. The accessibility service
  // runs only for this test, and is let go after it. It stops once nothing
  // holds it, after a collection: at once alone, but in one loaded test-all
  // not within 20 s. The rest of the suite then passed with it on, so a
  // service that lingers is logged, not failed.
  const id = `a11y-desc-${Date.now()}`;
  const out = await h.chrome(`${P}
    await show();
    const probe = async () => {
      const svc = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
      const read = async value => {
        const el = N.noticeElement(tab, value);
        const buttons = [...el.querySelectorAll(".zenius-card-buttons > button")];
        await until(() => buttons.every(b => svc.getAccessibleFor(b)?.description === el.getAttribute("aria-label")), 5000).catch(() => {});
        return {
          label: el.getAttribute("aria-label"),
          buttons: buttons.map(b => {
            const acc = svc.getAccessibleFor(b);
            return { text: b.textContent, name: acc?.name ?? null, description: acc?.description ?? null };
          }),
        };
      };
      const res = {};
      try {
        ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "user" });
        await until(() => N.noticeElement(tab, "zenius-control"));
        res.control = await read("zenius-control");
        await back();
        await show();
        await handOff("Log in to continue");
        res.needs = await read("zenius-control");
        await back();
        // The claim prompt shows on the tab in view.
        await show();
        // A countdown's: the description follows it, as the name does.
        ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: rec.id, name: "Work", client: "Trip planner", until: Date.now() + 61500 });
        await until(() => N.noticeElement(tab, ${JSON.stringify(`zenius-claim:${id}`)}));
        res.claim = await read(${JSON.stringify(`zenius-claim:${id}`)});
        await until(() => N.noticeElement(tab, ${JSON.stringify(`zenius-claim:${id}`)}).getAttribute("aria-label") !== res.claim.label, 5000);
        res.claimLater = await read(${JSON.stringify(`zenius-claim:${id}`)});
        ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
        const cards = {
          localTyped: UIM.localNetCard({ host: "192.168.1.10", typed: true }, { allow: () => {} }),
          kept: UIM.madePageCard(),
          closing: UIM.closingCard(true, rec.name),
          joined: UIM.joinedCard(rec.name),
        };
        for (const [key, card] of Object.entries(cards)) {
          N.showNotice(tab, "zenius-a11y-desc", card);
          res[key] = await read("zenius-a11y-desc");
          N.removeNotice(tab, "zenius-a11y-desc");
        }
        // Under the user's focus a seconds countdown, as the takeover
        // prompt's, doesn't change the button's description each second:
        // it's current when the focus comes, and catches up when it goes.
        {
          const el = N.showNotice(tab, "zenius-a11y-desc", { title: "Agent paused", detail: "it resumes in {s} s", until: Date.now() + 9000, tone: "agent", buttons: [{ label: "Take over", primary: true, onClick() {} }, { label: "Resume agent", onClick() {} }] });
          const b = el.querySelector("button");
          const now = () => ({ label: el.getAttribute("aria-label"), description: svc.getAccessibleFor(b)?.description ?? null });
          await until(() => now().description === now().label, 5000);
          await sleep(1100);
          b.focus();
          const atFocus = now();
          // Gecko signals each change of the focused button's description
          // (probed 2026-11-20): no change, no signal.
          await sleep(2600);
          const held = now();
          browser.focus();
          await sleep(150);
          res.focused = { atFocus, held, left: now(), focusedThen: Services.focus.focusedElement === browser };
          N.removeNotice(tab, "zenius-a11y-desc");
        }
        // The tasks panel's row: its buttons and tabs, described by the row.
        const panel = () => doc.getElementById("zenius-tasks-panel");
        doc.getElementById("zenius-agents-strip").click();
        await until(() => panel()?.state === "open");
        try {
          const row = panel().querySelector('.zenius-task[data-space="' + rec.id + '"]');
          const buttons = [...row.querySelectorAll(".zenius-task-actions > button, .zenius-task-tab")];
          await until(() => buttons.every(b => svc.getAccessibleFor(b)?.description === row.getAttribute("aria-label")), 5000).catch(() => {});
          res.panelRow = {
            label: row.getAttribute("aria-label"),
            buttons: buttons.map(b => {
              const acc = svc.getAccessibleFor(b);
              return { text: b.textContent, name: acc?.name ?? null, description: acc?.description ?? null };
            }),
          };
        } finally {
          panel().hidePopup();
          await until(() => panel().state === "closed");
        }
        return res;
      } finally {
        N.removeNotice(tab, "zenius-a11y-desc");
        ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
        await back();
      }
    };
    const res = await probe();
    // Let go of the service: it stops once nothing holds it, after a
    // collection (under load it took seconds, or more).
    const start = Date.now();
    while (Services.appinfo.accessibilityEnabled && Date.now() - start < 10000) {
      Cu.forceGC();
      Cu.forceCC();
      await sleep(200);
    }
    res.serviceStopped = !Services.appinfo.accessibilityEnabled;
    res.stopMs = Date.now() - start;
    return res;
  `);
  const { serviceStopped, stopMs, focused, ...cards } = out;
  assert.equal(focused.atFocus.description, focused.atFocus.label, "current when the focus comes");
  assert.notEqual(focused.held.label, focused.atFocus.label, "the countdown moved on under the focus");
  assert.equal(focused.held.description, focused.atFocus.description, "the description held under the focus");
  assert.equal(focused.focusedThen, true);
  assert.equal(focused.left.description, focused.left.label, "caught up once the focus left");
  assert.deepEqual(Object.keys(cards), ["control", "needs", "claim", "claimLater", "localTyped", "kept", "closing", "joined", "panelRow"]);
  assert.equal(cards.panelRow.label, iso(name));
  for (const [key, card] of Object.entries(cards)) {
    assert.ok(card.label, `${key}: named`);
    assert.ok(card.buttons.length > 0, `${key}: has buttons`);
    for (const b of card.buttons) {
      // Gecko leaves an isolated title's isolate marks out of its name.
      assert.equal(b.name, b.text.replace(/[\u2066-\u2069]/g, ""), `${key}: ${b.text} keeps its own name`);
      assert.equal(b.description, card.label, `${key}: ${b.text} is described by its pill`);
    }
  }
  assert.ok(cards.control.buttons.some(b => b.text === "Resume agent"), "control: Resume agent");
  assert.ok(cards.control.label.startsWith("You're in control"), cards.control.label);
  assert.ok(cards.needs.label.startsWith("Agent needs you"), cards.needs.label);
  assert.notEqual(cards.claimLater.label, cards.claim.label, "the countdown moved on");
  if (!serviceStopped) {
    console.log(`# a11y: the accessibility service was still on ${stopMs} ms after the test; the suite goes on with it`);
  }
});

test("a countdown's pill is named by the countdown it shows now", async () => {
  const id = `a11y-count-${Date.now()}`;
  const out = await h.chrome(`${P}
    await show();
    try {
      // 61.5 s left: "2 min", then "1 min" at a minute.
      ctx.service.emitLocal("claimAsked", { id: ${JSON.stringify(id)}, space: rec.id, name: "Work", client: "", until: Date.now() + 61500 });
      const el = () => N.noticeElement(tab, ${JSON.stringify(`zenius-claim:${id}`)});
      await until(() => el());
      const shown = () => el().querySelector(".zenius-card-detail").textContent;
      const first = { detail: shown(), label: el().getAttribute("aria-label") };
      await until(() => shown() !== first.detail, 5000);
      return { first, then: { detail: shown(), label: el().getAttribute("aria-label") } };
    } finally {
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      await back();
    }
  `);
  assert.equal(out.first.detail, "denied in 2 min");
  assert.equal(out.then.detail, "denied in 1 min");
  assert.ok(out.first.label.startsWith("Agent request, denied in 2 min. "), out.first.label);
  assert.ok(out.then.label.startsWith("Agent request, denied in 1 min. "), out.then.label);
});

test("the keyboard reaches today's cards from the page and the address bar, main button first; Enter on it opens the user's own tab", async () => {
  await agentCode();
  const out = await h.chrome(`${P}
    await show();
    const res = {};
    let own = null;
    try {
      // zen-observe tells of a load the user started while the agent doesn't
      // drive: here, in the user's hold, after the hold's own card.
      await handOff("Log in to continue");
      UI.userLoadRefused({ browser, url: ${JSON.stringify(`${h.base}/api/text?own`)}, origin: ${JSON.stringify(h.base)}, typed: true, scope: "task" });
      await sleep(450);
      browser.focus();
      await sleep(100);
      res.forward = await steps(5, tabKey);
      gURLBar.focus();
      await sleep(100);
      res.backward = await steps(5, shiftTab);
      // macOS without "Keyboard navigation": the main button still comes first.
      Services.prefs.setIntPref("accessibility.tabfocus", 1);
      browser.focus();
      await sleep(100);
      res.macDefault = await steps(1, tabKey);
      Services.prefs.clearUserPref("accessibility.tabfocus");
      browser.focus();
      await sleep(100);
      await steps(2, tabKey);
      res.onMain = where();
      // Every Space's tabs: Zen's gBrowser.tabs has only the active Space's.
      const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
      const tabs = new Set(Win.uniqueTabs());
      key("Enter", "Enter", 13);
      await until(() => (own = [...Win.uniqueTabs()].find(t => !tabs.has(t))) && gBrowser.selectedTab === own);
      // Its page commits a moment after the tab is selected: about:blank
      // until then, longer under a loaded test-all.
      await until(() => own.linkedBrowser.currentURI.spec !== "about:blank", 10000).catch(() => {});
      res.enter = { own: own.linkedBrowser.currentURI.spec, notice: !!N.noticeElement(tab, "zenius-localnet") };
      gBrowser.removeTab(own, { animate: false });
      own = null;
      return res;
    } finally {
      Services.prefs.clearUserPref("accessibility.tabfocus");
      if (own) gBrowser.removeTab(own, { animate: false });
      N.removeNotice(tab, "zenius-localnet");
      await back();
    }
  `);
  const ln = label => `zenius-localnet: ${label}`;
  const hold = "zenius-control: Resume agent";
  assert.deepEqual(out.forward, [hold, ln("Open it yourself"), ln("Add to allowlist"), ln("Dismiss"), "urlbar"]);
  assert.deepEqual(out.backward, [ln("Dismiss"), ln("Add to allowlist"), ln("Open it yourself"), hold, "page"]);
  assert.deepEqual(out.macDefault, [hold]);
  assert.equal(out.onMain, ln("Open it yourself"));
  assert.deepEqual(out.enter, { own: `${h.base}/api/text?own`, notice: false });
});

test("the local-network notice is heard when its tab is in view, and not when it isn't; the Stop says nothing; neither moves the focus", async () => {
  await agentCode();
  const out = await h.chrome(`${P}
    const refused = () => UI.userLoadRefused({ browser, url: ${JSON.stringify(`${h.base}/api/text?heard`)}, origin: ${JSON.stringify(h.base)}, typed: true, scope: "task" });
    const res = {};
    try {
      await show();
      await handOff("Log in to continue");
      await hush();
      const before = view();
      refused();
      res.notice = await heardSoon();
      res.still = sameView(before, view());
      N.removeNotice(tab, "zenius-localnet");
      // The user went back to their own Space: the agent's tab isn't in view.
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
      await hush();
      refused();
      res.unseen = await heardSoon();
      N.removeNotice(tab, "zenius-localnet");
      await back();
      await show();
      await hush();
      const was = view();
      UI.stopByUser(rec);
      res.stopped = await heardSoon();
      res.stillAfterStop = sameView(was, view());
      return res;
    } finally {
      N.removeNotice(tab, "zenius-localnet");
      await back();
    }
  `);
  const host = new URL(h.base).hostname;
  assert.deepEqual(out, {
    notice: `Network access denied: ${iso(host)}. The current network policy doesn't allow agents to access ${iso(host)}. It's on your local network; Add to allowlist lets every agent tab reach it, until you remove it.`,
    still: true,
    unseen: null,
    stopped: null,
    stillAfterStop: true,
  });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
