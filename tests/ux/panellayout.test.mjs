// The tasks panel with many tasks, and long or right-to-left names (found in
// a load test, 2026-11-20). The rows here are stand-ins that panel.sys.mjs
// draws itself, so the test needs no 30 real tasks; ZeniusUI's own rows come
// back the next time the user opens it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const HE_LONG = "הזמנת שולחן לארבעה אנשים בשעה שבע בערב במסעדה האיטלקית ברחוב הראשי";
const AR_LONG = "حجز طاولة لأربعة أشخاص في الساعة السابعة مساء في المطعم الإيطالي";
const EN_LONG = "Book a table for 4 at 7 pm at the Italian place on Main Street, then send the confirmation to the family chat";
// Long enough to overflow the panel with any font at any of its widths: the
// Mac's Hebrew font fit HE_LONG whole in its wider panel.
const HE_LONGER = `${HE_LONG}, ואחר כך שליחת האישור לקבוצה של המשפחה ותזכורת לכולם יום לפני`;
const AR_LONGER = `${AR_LONG}، ثم إرسال التأكيد إلى مجموعة العائلة وتذكير الجميع قبل يوم`;
const HE_TITLE = "תשלום — אישור ההזמנה והחיוב בכרטיס האשראי של המשפחה, ושליחת הקבלה לכל בני המשפחה בקבוצה";

let h;

before(async () => {
  h = await setup();
});

after(async () => {
  await h
    ?.chrome(`ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs").closeTasksPanel(win); return true;`)
    .catch(() => {});
  await h?.close();
});

const P = `
  const Panel = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/panel.sys.mjs");
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const { isolate } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/text.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const doc = win.document;
  const noop = () => {};
  const rowsOf = names =>
    names.map((name, i) => ({
      id: 990000 + i,
      name,
      state: "working",
      detail: "Agent working · Step 2 of 5",
      ownership: "agent",
      paused: false,
      tabs: [{ id: "zu-layout-" + i, title: i === 1 ? ${JSON.stringify(HE_TITLE)} : "Checkout" }],
      idleFor: null,
    }));
  const open = async rows => {
    Panel.closeTasksPanel(win);
    await sleep(50);
    // With no real task the strip is hidden, and a panel anchored to a
    // hidden element closes at once: anchor it to the sidebar's foot.
    const anchor = doc.getElementById("zen-sidebar-foot-buttons");
    const panel = Panel.openTasksPanel(win, { rows: () => rows, open: noop, openTab: noop, pause: noop, resume: noop, takeOver: noop, handBack: noop, stop: noop }, anchor);
    await new Promise(r => (panel.state === "open" ? r() : panel.addEventListener("popupshown", r, { once: true })));
    await sleep(100);
    if (panel.state !== "open") throw new Error("the panel closed by itself: " + panel.state);
    return panel;
  };
  // Are the first and last letters of el's isolated text inside el's box?
  const ends = el => {
    const node = el.firstChild;
    const box = el.getBoundingClientRect();
    const inside = i => {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      const c = r.getBoundingClientRect();
      return c.left >= box.left - 0.5 && c.right <= box.right + 0.5;
    };
    return { clipped: el.scrollWidth > el.clientWidth + 1, first: inside(1), last: inside(node.data.length - 2) };
  };
`;

test("many tasks: the rows scroll within the window under a title that stays, and focus brings a row into view", async () => {
  const out = await h.chrome(`${P}
    const panel = await open(rowsOf([...Array(30)].map((_, i) => "Task " + (i + 1) + " · compare prices")));
    try {
      const body = panel.querySelector(".zenius-tasks");
      const title = body.querySelector(".zenius-tasks-title");
      // Inside what the popup shows: the rows' box, cut to the panel's.
      const inView = el => {
        const r = el.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        return r.top >= Math.max(b.top, p.top) - 0.5 && r.bottom <= Math.min(b.bottom, p.bottom) + 0.5;
      };
      const stop = [...body.querySelectorAll("button[data-action=stop]")].at(-1);
      const res = {
        fits: panel.getBoundingClientRect().height <= win.innerHeight,
        scrolls: body.scrollHeight > body.clientHeight + 1,
        lastStopShownAtFirst: inView(stop),
      };
      stop.focus();
      await sleep(100);
      const titleTop = title.getBoundingClientRect().top - body.getBoundingClientRect().top;
      Object.assign(res, {
        focused: doc.activeElement === stop,
        lastStopShownOnFocus: inView(stop),
        scrolled: body.scrollTop > 0,
        titleStays: Math.abs(titleTop) <= 1,
        titleOpaque: win.getComputedStyle(title).backgroundColor !== "rgba(0, 0, 0, 0)",
      });
      return res;
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, {
    fits: true,
    scrolls: true,
    lastStopShownAtFirst: false,
    focused: true,
    lastStopShownOnFocus: true,
    scrolled: true,
    titleStays: true,
    titleOpaque: true,
  });
});

test("a long right-to-left name or tab title keeps its start, and the ellipsis takes its end; a short one lines up with the rest", async () => {
  const out = await h.chrome(`${P}
    const panel = await open(rowsOf([${JSON.stringify(EN_LONG)}, ${JSON.stringify(HE_LONGER)}, ${JSON.stringify(AR_LONGER)}, "שלום", "Short"]));
    try {
      const names = [...panel.querySelectorAll(".zenius-task-name")];
      const textLeft = el => {
        const r = doc.createRange();
        r.selectNodeContents(el);
        return Math.round(r.getBoundingClientRect().left);
      };
      return {
        en: ends(names[0]),
        he: ends(names[1]),
        ar: ends(names[2]),
        shortLinesUp: Math.abs(textLeft(names[3]) - textLeft(names[4])) <= 1,
        heTab: ends(panel.querySelectorAll(".zenius-task-tab")[1]),
      };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  const cut = { clipped: true, first: true, last: false };
  assert.deepEqual(out.en, cut, "English: the start shows, the end goes");
  assert.deepEqual(out.he, cut, "Hebrew: the start shows, the end goes");
  assert.deepEqual(out.ar, cut, "Arabic: the start shows, the end goes");
  assert.deepEqual(out.heTab, cut, "a Hebrew tab title: the start shows");
  assert.equal(out.shortLinesUp, true, "a short Hebrew name starts where an English one does");
});

test("a row's tabs stay on one line, whatever their titles: a loading tab's URL can't move the rows below", async () => {
  const out = await h.chrome(`${P}
    const rows = rowsOf(["Task 1", "Task 2"]);
    rows[0].tabs = [1, 2, 3, 4, 5].map(n => ({ id: "zu-long-" + n, title: "https://shop.example.com/checkout/step-" + n + "?session=" + "x".repeat(40) }));
    const panel = await open(rows);
    try {
      const list = panel.querySelector(".zenius-task-tabs");
      const tab = list.querySelector(".zenius-task-tab");
      return {
        oneLine: Math.round(list.getBoundingClientRect().height) <= Math.round(tab.getBoundingClientRect().height) + 1,
        fourShown: list.querySelectorAll(".zenius-task-tab").length,
        more: list.querySelector(".zenius-task-tabs-more")?.textContent ?? null,
        clipped: tab.scrollWidth > tab.clientWidth + 1,
      };
    } finally {
      Panel.closeTasksPanel(win);
    }
  `);
  assert.deepEqual(out, { oneLine: true, fourShown: 4, more: "+1 more", clipped: true });
});

test("a pill's long right-to-left detail keeps its start", async () => {
  const out = await h.chrome(`${P}
    const tab = gBrowser.selectedTab;
    N.showNotice(tab, "zenius-layout-test", { title: "Agent needs you", detail: isolate(${JSON.stringify(`${HE_LONG} ${HE_LONG}`)}), buttons: [{ label: "Resume agent", onClick: noop }] });
    try {
      await sleep(100);
      return ends(N.noticeElement(tab, "zenius-layout-test").querySelector(".zenius-card-detail"));
    } finally {
      N.removeNotice(tab, "zenius-layout-test");
    }
  `);
  assert.deepEqual(out, { clipped: true, first: true, last: false });
});

test("a pill's note, opened by its '?', wraps a long site name inside the card", async () => {
  const out = await h.chrome(`${P}
    const tab = gBrowser.selectedTab;
    // A registrable domain with a 63-letter label, the longest DNS allows,
    // of wide letters and no hyphen to break at, in a local-address line.
    const site = "w".repeat(63) + ".com";
    N.showNotice(tab, "zenius-layout-test", { title: "Agent needs you", detail: "Log in", note: \`This page tried to reach \${site}, a device on your network, which agent tabs can't.\`, buttons: [{ label: "Resume agent", onClick: noop }] });
    try {
      await sleep(100);
      const card = N.noticeElement(tab, "zenius-layout-test");
      const note = card.querySelector(".zenius-card-note");
      for (const end = Date.now() + 3000; !card.hasAttribute("note-cut") && Date.now() < end; ) await sleep(25);
      card.querySelector(".zenius-card-more").click();
      await sleep(50);
      const c = card.getBoundingClientRect();
      const r = doc.createRange();
      r.selectNodeContents(note);
      const t = r.getBoundingClientRect();
      return { inside: t.left >= c.left - 0.5 && t.right <= c.right + 0.5, overflows: note.scrollWidth > note.clientWidth + 1 };
    } finally {
      N.removeNotice(tab, "zenius-layout-test");
    }
  `);
  assert.deepEqual(out, { inside: true, overflows: false });
});
