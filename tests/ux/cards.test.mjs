// The notice pill (runtime/JS/zenius/ui/notices.sys.mjs): one line, centered
// at the bottom of the agent's page, in chrome over that tab
// only; a live countdown; buttons that act on the first click even right
// after the window gains focus, but not on a double click's second click;
// light and dark; no slide with reduced motion.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let P;
let userView;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "zen-ux cards test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const showAgentPage = async () => {
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab);
    };
    // The pill slides in (150 ms); measure where it comes to rest, also on a
    // loaded machine where a fixed sleep can end mid-slide.
    const settled = async el => {
      win.getComputedStyle(el).animationName;
      const animations = el.getAnimations({ subtree: true });
      await Promise.all(animations.map(a => a.finished.catch(() => {})));
      return animations.length;
    };
    const geometry = el => {
      const b = browser.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        height: Math.round(r.height),
        width: Math.round(r.width),
        centerOffset: Math.round(r.x + r.width / 2 - (b.x + b.width / 2)),
        fromTop: Math.round(r.top - b.top),
        fromBottom: Math.round(b.bottom - r.bottom),
        lines: Math.round(el.querySelector(".zenius-card-title").getBoundingClientRect().height / 18),
      };
    };
  `;
});

after(async () => {
  await h?.chrome(`${P}
    Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    N.removeNotice(tab, "zenius-test");
    if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
  `).catch(() => {});
  await h?.close();
});

const PILL = `{
  title: "Agent paused",
  detail: "it resumes in {s} s",
  until: Date.now() + 9500,
  buttons: [{ label: "Take over", primary: true, onClick() {} }, { label: "Resume agent", onClick() {} }],
}`;

test("a pill is one line, centered at the bottom of the agent's page, and only there", async () => {
  const out = await h.chrome(`${P}
    await showAgentPage();
    const el = N.showNotice(tab, "zenius-test", ${PILL});
    const slides = await settled(el);
    const g = geometry(el);
    const inStack = el.closest(".browserStack") === browser.parentElement;
    const pills = win.document.querySelectorAll(".zenius-card").length;
    const text = N.noticeText(tab, "zenius-test");
    N.removeNotice(tab, "zenius-test");
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    return { g, inStack, pills, text, slides };
  `);
  assert.ok(out.slides >= 1, "measured after the pill's entrance, not before it started");
  assert.equal(out.g.height, 44);
  assert.ok(out.g.width <= 560, `width ${out.g.width}`);
  assert.ok(Math.abs(out.g.centerOffset) <= 1, `centered (${out.g.centerOffset} px off)`);
  assert.equal(out.g.fromBottom, 16);
  assert.equal(out.g.lines, 1);
  assert.equal(out.inStack, true, "in the agent tab's own stack");
  assert.equal(out.pills, 1);
  assert.equal(out.text, "Agent paused · it resumes in 10 s");
});

test("every card fits in its pill, at the page's width and on a narrow page: its title, note and every button inside it; on a narrow page, or with three buttons, its buttons go under its note", async () => {
  const out = await h.chrome(`${P}
    await showAgentPage();
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const resume = [{ label: "Resume agent", primary: true, onClick: () => {} }];
    const cards = {
      localTyped: UIM.localNetCard({ host: "192.168.1.10", typed: true }, { allow: () => {} }),
      localChosenLong: UIM.localNetCard({ host: "a-very-long-printer-name-for-the-lab.local", typed: false }),
      // The hand-off's pill as #showControlNotice draws it.
      needsYou: { ...UIM.controlCard({ name: "Book a table for four at seven", stateText: "Enter the code we sent to your phone" }, "agent"), buttons: resume },
      // Once the user typed a secret: the Resume line leads, the agent's words behind the '?'.
      needsYouTyped: {
        ...UIM.controlCard({ name: "Book a table for four at seven" }, "agent"),
        note: UIM.CLEARS_LINE,
        more: "The agent says: “Enter the code we sent to your phone”.",
        buttons: resume,
      },
      madeTakeOver: { ...UIM.controlCard({}, "user"), note: UIM.AGENTS_PAGE_LINE, buttons: resume },
      // On a task no Work chat drives: the line after the agent's words, for
      // an agent on an hc terminal, and the Take over card's, for one with a
      // long folder name (#showControlNotice, afterResume).
      needsYouAfter: {
        ...UIM.controlCard({ name: "Book a table for four at seven" }, "agent"),
        note: [UIM.controlCard({ stateText: "Enter the code we sent to your phone" }, "agent").note, UIM.tellAgentLine({ agent: "Claude Code", terminal: "laptop/t5x" })].join(" "),
        buttons: resume,
      },
      takeOverAfter: { ...UIM.controlCard({}, "user"), detail: UIM.CANT_ACT_DETAIL, note: UIM.tellAgentLine({ agent: "Claude Code", folder: "quarterly-expenses-2026" }), buttons: resume },
      // The user's own secret mark (secretToggle): its box with Resume agent
      // under the note, ticked on a hand-off's pill, not on a Take over's.
      needsYouSecret: {
        ...UIM.controlCard({ name: "Book a table for four at seven" }, "agent"),
        note: [UIM.SECRET_LINE, UIM.SECRET_HOLD_LINE, UIM.tellAgentLine({ agent: "Claude Code", folder: "quarterly-expenses-2026" })].join(" "),
        more: "The agent says: “Enter the code we sent to your phone”.",
        buttons: resume,
        toggle: { label: UIM.PILL_SECRET_TOGGLE, checked: true, onChange: () => {} },
        stacked: true,
      },
      // The agent's own mark: ticked, with its sign.
      needsYouAgentSecret: {
        ...UIM.controlCard({ name: "Book a table for four at seven" }, "agent"),
        note: [UIM.SECRET_LINE, UIM.SECRET_HOLD_LINE, UIM.tellAgentLine({ agent: "Claude Code", folder: "quarterly-expenses-2026" })].join(" "),
        more: "The agent says: “Enter the code we sent to your phone”.",
        buttons: resume,
        toggle: { label: UIM.PILL_SECRET_TOGGLE, checked: true, fixed: true, sign: UIM.SECRET_AGENT_SIGN, onChange: () => {} },
        stacked: true,
      },
      takeOverSecret: {
        ...UIM.controlCard({}, "user"),
        detail: UIM.CANT_ACT_DETAIL,
        note: UIM.CLEARS_LINE,
        buttons: resume,
        toggle: { label: UIM.PILL_SECRET_TOGGLE, checked: false, onChange: () => {} },
        stacked: true,
      },
      madeReminder: UIM.madePageCard(),
      madeRefused: UIM.madePageCard({ refused: "media" }),
      reloadFailed: UIM.reloadFailedCard(),
      takeOverRefused: UIM.takeOverRefusedCard({ reason: "reachable" }),
      takeOverOffSite: UIM.takeOverRefusedCard({ reason: "reloadFailed", offSite: true }),
      closing: UIM.closingCard(true, "Book a table for four at seven"),
      joined: UIM.joinedCard("Trip planner"),
      claim: UIM.claimCard("Trip planner", "Work", Date.now() + 600000),
    };
    const inside = (outer, inner) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
    const read = el => {
      const card = el.getBoundingClientRect();
      // What shows: the '?' only when the note is cut off.
      const parts = [...el.querySelectorAll(".zenius-card-title, .zenius-card-note, .zenius-card-more, .zenius-card-button, .zenius-card-toggle")].filter(p => p.getClientRects().length);
      const out = parts.filter(p => !inside(card, p.getBoundingClientRect())).map(p => p.textContent.slice(0, 24) || p.className);
      const note = el.querySelector(".zenius-card-note");
      // A note longer than its line is cut off with the '?', never silently.
      if (note && note.scrollWidth > note.clientWidth + 1 && !el.hasAttribute("note-cut")) out.push("the note runs over with no '?'");
      if (note && Math.round(note.getBoundingClientRect().height) !== 16) out.push("the note isn't one line");
      const box = el.querySelector(".zenius-card-buttons");
      // A card with no line has nothing to put its buttons under.
      return { out, under: note ? !!box && box.getBoundingClientRect().top >= note.getBoundingClientRect().bottom - 0.5 : null };
    };
    const res = {};
    try {
      // A narrow page: the layer the pills sit in is as wide as the page.
      for (const width of [0, 420]) {
        for (const [name, card] of Object.entries(cards)) {
          const el = N.showNotice(tab, "zenius-test", card);
          el.parentElement.style.width = width ? width + "px" : "";
          el.parentElement.style.justifySelf = width ? "center" : "";
          await settled(el);
          res[(width || "page") + " " + name] = read(el);
          N.removeNotice(tab, "zenius-test");
        }
      }
      return res;
    } finally {
      N.removeNotice(tab, "zenius-test");
      await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  for (const [key, { out: over, under }] of Object.entries(out)) {
    const [width, name] = key.split(" ");
    assert.deepEqual(over, [], `${key}: inside the pill`);
    if (under !== null) {
      // Three buttons (the local-network card's for a typed address, and a
      // refused Take over's) go under the line at any width, so the host or
      // the reason shows whole, and so does a secret box with Resume agent,
      // so the task's name does.
      assert.equal(under, width === "420" || ["localTyped", "takeOverRefused", "needsYouSecret", "needsYouAgentSecret", "takeOverSecret"].includes(name), `${key}: buttons under the note`);
    }
  }
});

test("a note is one line of small text 7 px under the title row, cut off with a round 14 px '?' whose mark is centred; the '?' opens the rest and closes it, the keyboard's focus in the card opens it, and a short note has none", async () => {
  const out = await h.chrome(`${P}
    await showAgentPage();
    const long = "Resume agent clears password, card and code fields, so submit what you type there first. ".repeat(3).trim();
    const el = N.showNotice(tab, "zenius-test", { title: "Agent needs you", detail: "Log in", note: long, tone: "agent", buttons: [{ label: "Resume agent", primary: true, onClick() {} }] });
    try {
      await settled(el);
      await until(() => el.hasAttribute("note-cut"));
      const box = x => x.getBoundingClientRect();
      const note = el.querySelector(".zenius-card-note");
      const more = el.querySelector(".zenius-card-more");
      const row = el.querySelector(".zenius-card-noterow");
      const titleRow = Math.max(box(el.querySelector(".zenius-card-title")).bottom, box(el.querySelector(".zenius-card-buttons")).bottom);
      // The mark's ink: the hook's stroke (1.5) about its path, and the dot.
      const svg = more.querySelector("svg");
      const hook = svg.querySelector("path").getBBox();
      const dot = svg.querySelector("circle").getBBox();
      const ink = { left: Math.min(hook.x - 0.75, dot.x), right: Math.max(hook.x + hook.width + 0.75, dot.x + dot.width), top: Math.min(hook.y - 0.75, dot.y), bottom: Math.max(hook.y + hook.height + 0.75, dot.y + dot.height) };
      const style = win.getComputedStyle(more);
      const closed = {
        gap: Math.round(box(row).top - titleRow),
        lines: Math.round(box(note).height / 16),
        more: { width: box(more).width, height: box(more).height, round: style.borderTopLeftRadius === "50%" || parseFloat(style.borderTopLeftRadius) >= 7 },
        moreMiddle: Math.abs((box(more).top + box(more).bottom) / 2 - (box(note).top + box(note).bottom) / 2) <= 0.5,
        afterNote: box(more).left >= box(note).right - 0.5 && box(more).right <= box(el).right,
        inkCentre: [Math.round(((ink.left + ink.right) / 2) * 10) / 10, Math.round(((ink.top + ink.bottom) / 2) * 10) / 10],
        hidden: more.getAttribute("aria-hidden"),
        focusable: more.tabIndex >= 0,
        label: el.getAttribute("aria-label").endsWith(long),
      };
      more.click();
      await sleep(50);
      const opened = { open: el.hasAttribute("note-open"), lines: Math.round(box(note).height / 16), runsOver: note.scrollWidth > note.clientWidth + 1, more: more.getClientRects().length > 0 };
      more.click();
      await sleep(50);
      const closedAgain = { open: el.hasAttribute("note-open"), lines: Math.round(box(note).height / 16) };
      // The keyboard's focus (focus-visible), not a mouse press's.
      el.querySelector("button").focus({ focusVisible: true });
      await sleep(50);
      const focused = Math.round(box(note).height / 16);
      el.querySelector("button").blur();
      await sleep(50);
      const blurred = Math.round(box(note).height / 16);
      N.showNotice(tab, "zenius-test", { title: "Agent needs you", detail: "Log in", note: "Short.", tone: "agent", buttons: [{ label: "Resume agent", primary: true, onClick() {} }] });
      await sleep(100);
      const short = { cut: el.hasAttribute("note-cut"), more: more.isConnected ? more.getClientRects().length : el.querySelector(".zenius-card-more").getClientRects().length };
      return { closed, opened, closedAgain, focused, blurred, short };
    } finally {
      N.removeNotice(tab, "zenius-test");
      await gZenWorkspaces.changeWorkspaceWithID(userWs);
    }
  `);
  assert.deepEqual(out.closed, {
    gap: 7,
    lines: 1,
    more: { width: 14, height: 14, round: true },
    moreMiddle: true,
    afterNote: true,
    inkCentre: [7, 7],
    hidden: "true",
    focusable: false,
    label: true,
  });
  assert.equal(out.opened.open, true);
  assert.ok(out.opened.lines > 1, `open, the note wraps: ${out.opened.lines} lines`);
  assert.equal(out.opened.runsOver, false);
  assert.equal(out.opened.more, true, "the '?' stays to close it");
  assert.deepEqual(out.closedAgain, { open: false, lines: 1 });
  assert.ok(out.focused > 1, "the keyboard's focus in the card opens the note");
  assert.equal(out.blurred, 1);
  assert.deepEqual(out.short, { cut: false, more: 0 });
});

test("the countdown counts down", async () => {
  const out = await h.chrome(`${P}
    const el = N.showNotice(tab, "zenius-test", ${PILL});
    const first = N.noticeText(tab, "zenius-test");
    await sleep(1100);
    const shown = el.querySelector(".zenius-card-detail").textContent;
    N.removeNotice(tab, "zenius-test");
    return { first, shown };
  `);
  assert.equal(out.first, "Agent paused · it resumes in 10 s");
  assert.equal(out.shown, "it resumes in 9 s");
});

// On the Mac "Hand back" (now Resume agent) needed two clicks: Firefox's notification bar
// restarts its click-jacking delay whenever the window gains focus, and the
// click that activates a background window comes right after that focus.
test("a pill's button acts on the first click right after the window gains focus", async () => {
  const out = await h.chrome(`${P}
    await showAgentPage();
    await UI.takeOverByUser(rec);
    await sleep(450);
    win.dispatchEvent(new win.FocusEvent("focus"));
    const hand = [...N.noticeElement(tab, "zenius-control").querySelectorAll("button")].find(b => b.textContent === "Resume agent");
    hand.click();
    // The hand back first asks zen-input which pages hold a typed secret.
    await until(() => rec.ownership === "agent", 3000).catch(() => {});
    const ownership = rec.ownership;
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    return { ownership, notice: !!N.noticeElement(tab, "zenius-control") };
  `);
  assert.deepEqual(out, { ownership: "agent", notice: false });
});

test("a click right after a pill appears does nothing (a double click's second click)", async () => {
  const out = await h.chrome(`${P}
    await UI.takeOverByUser(rec);
    const hand = [...N.noticeElement(tab, "zenius-control").querySelectorAll("button")].find(b => b.textContent === "Resume agent");
    hand.click();
    // A press closes the pill at once, and hands back once zen-input has
    // said which pages hold a typed secret: look at both.
    const pill = !!N.noticeElement(tab, "zenius-control");
    await sleep(300);
    const early = rec.ownership;
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return { pill, early };
  `);
  assert.deepEqual(out, { pill: true, early: "agentDelegatedToUser" });
});

test("the Agent needs you pill names the task, and its small text follows the agent's state text", async () => {
  const out = await h.chrome(`${P}
    const justInTime = UI.secretLineJustInTime;
    UI.secretLineJustInTime = true;
    try {
      ctx.spaces.setStateText(rec, "Log in to continue");
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      const said = () => ({ notice: UI.describe(rec).controlNotice, note: UI.describe(rec).controlNote });
      const first = said();
      ctx.spaces.setStateText(rec, "Enter the code sent to your phone");
      await until(() => UI.describe(rec).controlNote !== first.note);
      const later = said();
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      ctx.spaces.setStateText(rec, "");
      return { name: rec.name, first, later, after: UI.describe(rec).controlNotice };
    } finally {
      UI.secretLineJustInTime = justInTime;
    }
  `);
  assert.deepEqual(out, {
    name: out.name,
    first: { notice: `Agent needs you · ${iso(out.name)} on ${site()}`, note: `The agent says: “${iso("Log in to continue")}”. If it doesn't go on after Resume, tell the agent.` },
    later: { notice: `Agent needs you · ${iso(out.name)} on ${site()}`, note: `The agent says: “${iso("Enter the code sent to your phone")}”. If it doesn't go on after Resume, tell the agent.` },
    after: null,
  });
});

test("the note quotes the agent's words as a sentence: no period of its own after words that end one, English or Chinese", async () => {
  const cases = [
    ["Log in to continue", "."],
    ["Sign in, then press Authorize or Cancel.", ""],
    ["Is the code on your phone?", ""],
    ["Approve it now!", ""],
    ["Wait for the code...", ""],
    ["Wait for the code\u2026", ""],
    ['Then press "Done."', ""],
    ["Then press Done. ", ""],
    ["Use version 1.2", "."],
    ["\u8bf7\u5728\u9875\u9762\u4e0a\u767b\u5f55\u3002", ""],
    ["\u9a8c\u8bc1\u7801\u6536\u5230\u4e86\u5417\uff1f", ""],
    ["\u70b9\u51fb\u5141\u8bb8\uff01", ""],
    ["\u8bf7\u5728\u9875\u9762\u4e0a\u767b\u5f55", "."],
  ];
  const notes = await h.chrome(`
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    return ${JSON.stringify(cases.map(([words]) => words))}.map(stateText => UIM.controlCard({ name: "t", stateText }, "agent").note);
  `);
  assert.deepEqual(
    notes,
    cases.map(([words, end]) => `The agent says: \u201c${iso(words)}\u201d${end}`)
  );
});

test("pills come in light and dark", async () => {
  const out = await h.chrome(`${P}
    // A pill takes the color scheme of the page area, #browser's, as Zen's
    // own UI there does. Zen sets it from the Space's gradient when the
    // Space has one (zen-should-be-dark-mode), else it follows the system,
    // so the test sets it on #browser itself, whatever the Space's theme
    // (on the Mac, the system's flip didn't reach the pill).
    const browserEl = win.document.getElementById("browser");
    const schemeWas = browserEl.style.colorScheme;
    const look = async dark => {
      browserEl.style.colorScheme = dark ? "dark" : "light";
      const el = N.showNotice(tab, "zenius-test", ${PILL});
      const cs = win.getComputedStyle(el);
      await until(() => cs.color === (dark ? "rgb(245, 245, 247)" : "rgb(29, 29, 31)"));
      const primary = win.getComputedStyle(el.querySelector("[primary]"));
      const r = { bg: cs.backgroundColor, ink: cs.color, primary: primary.backgroundColor, blur: cs.backdropFilter, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, font: cs.fontSize };
      N.removeNotice(tab, "zenius-test");
      return r;
    };
    let light, dark;
    try {
      light = await look(false);
      dark = await look(true);
    } finally {
      browserEl.style.colorScheme = schemeWas;
    }
    return { light, dark };
  `);
  assert.notEqual(out.light.bg, out.dark.bg);
  assert.notEqual(out.light.ink, out.dark.ink);
  assert.notEqual(out.light.primary, out.dark.primary, "the filled button follows the theme");
  for (const look of [out.light, out.dark]) {
    assert.match(look.bg, /^rgba\(/, "translucent");
    assert.match(look.blur, /blur/);
    assert.equal(look.radius, "14px");
    assert.equal(look.border, "1px");
    assert.equal(look.font, "13px");
  }
});

test("with reduced motion, pills fade in without sliding", async () => {
  const out = await h.chrome(`${P}
    // matchMedia flips at once; chrome style sheets take the change a moment
    // later. The pill must follow within that.
    const name = async expected => {
      const el = N.showNotice(tab, "zenius-test", ${PILL});
      const cs = win.getComputedStyle(el);
      await until(() => cs.animationName === expected).catch(() => {});
      const n = cs.animationName;
      N.removeNotice(tab, "zenius-test");
      return n;
    };
    const normal = await name("zenius-card-in");
    Services.prefs.setIntPref("ui.prefersReducedMotion", 1);
    const reduced = await name("zenius-card-fade");
    Services.prefs.clearUserPref("ui.prefersReducedMotion");
    await until(() => !win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    return { normal, reduced };
  `);
  assert.deepEqual(out, { normal: "zenius-card-in", reduced: "zenius-card-fade" });
});

test("what comes after Resume agent on a task no Work chat drives: to tell the agent where it runs, by its folder or its hc terminal, each part isolated, or the agent alone; that something waits, with a wait attached; and the Take over card's detail", async () => {
  const out = await h.chrome(`
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    return {
      folder: UIM.tellAgentLine({ agent: "Claude Code", folder: "zenius-eval" }),
      terminal: UIM.tellAgentLine({ agent: "Codex", terminal: "laptop/t5x", folder: "zenius-eval" }),
      terminalOnly: UIM.tellAgentLine({ terminal: "laptop/t5x" }),
      folderOnly: UIM.tellAgentLine({ folder: "zenius-eval" }),
      agentOnly: UIM.tellAgentLine({ agent: "Claude Code" }),
      none: UIM.tellAgentLine(null),
      waits: UIM.AGENT_WAITS_LINE,
      detail: UIM.CANT_ACT_DETAIL,
    };
  `);
  const tell = who => `If it doesn't go on after Resume, tell ${who}.`;
  assert.deepEqual(out, {
    folder: tell(`${iso("Claude Code")} in ${iso("zenius-eval")}`),
    terminal: tell(`${iso("Codex")} on ${iso("laptop/t5x")}`),
    terminalOnly: tell(`the agent on ${iso("laptop/t5x")}`),
    folderOnly: tell(`the agent in ${iso("zenius-eval")}`),
    agentOnly: tell(iso("Claude Code")),
    none: tell("the agent"),
    waits: "The agent is waiting for Resume agent.",
    detail: "the agent can't act",
  });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
