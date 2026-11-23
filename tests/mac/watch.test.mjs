// Watch and ⌃Tab (the bundle's Mac test 3, zen-sidebar's step 6), headless,
// with the keys played through nsITextInputProcessor:
// - while the user isn't watching, ⌃Tab stays Zen's own tab switch;
// - a working task's live card shows its page, with Watch and Take over, and
//   draws only while it can be seen (#live[data-drawn] counts the pictures);
// - Watch shows the task's Space and tab. The card then hides Watch and shows
//   its hint in its place, "⌃Tab back to your tabs", which isn't a button
//   (#live[data-watching="true"], whoever began the watch, Take over too).
//   zenius says "Watching <task> [⌃Tab]" in its agents strip; where the strip
//   can't be read (a collapsed sidebar, compact mode), a chip in the page
//   area's top left corner says it instead, with no buttons, and every click
//   goes through it. ⌃Tab is the only way back: it returns to the user's own
//   Space and tab while the task works on;
// - a click on one of the task's tabs in the directory watches it too;
// - Take over hands the page to the user, and watches it.
// The task is the mock's SCENARIO:prices, which keeps a step running. It's
// started once: the mock names its tasks, so a second run would join it.
// Shots for a person to set beside zen-sidebar's go to $ZENIUS_MAC_SHOTS.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKDROP, inTheme, setup } from "./lib.mjs";

const OUT = process.env.ZENIUS_MAC_SHOTS || join(tmpdir(), "zenius-mac-look");
mkdirSync(OUT, { recursive: true });
const h = await setup("watch");
const BUILT = await h.chrome(`return typeof T.glue()?.watch === "function";`);
const skip = !BUILT && "zen-sidebar's step 6 (Watch) isn't built in this checkout";
const DONE_BUILT = BUILT && (await h.chrome(`return typeof ChromeUtils.importESModule(H.WATCH.ui).ZeniusUI?.watchingDone === "function";`));
const skipDone = skip || (!DONE_BUILT && "zen-ux's af4bc5b (the way back after a watched task's end) isn't in this checkout");
let uid = null;
// The done case's own task: finishing it ends it, so it isn't the one above.
let doneUid = null, doneSpace = null, doneFinished = false;

/** Watch's state, in scope for the chrome calls below as `W`. */
const WATCHING = `
const W = {
  conv: uid => T.glue().AgentService.tasks.get(uid),
  rec: uid => { const c = W.conv(uid); return c ? T.glue().AgentService.zenRecord(c) : null; },
  space: () => win.gZenWorkspaces?.activeWorkspace ?? null,
  // Where a user starts a watch from: a Space of theirs, on a tab of theirs. Closing an
  // earlier test's tabs can leave the window on the Agents Space, since Zen moves on to a
  // Space that still has tabs, and a watch begun there has no Space of the user's to leave
  // or return to. Says where the window was, for the log.
  async toUser(uid) {
    const ws = win.gZenWorkspaces, gb = win.gBrowser, agents = W.rec(uid)?.uuid ?? null;
    const was = W.space() === agents ? "the task's Space" : "a Space of the user's";
    if (ws && W.space() === agents) {
      const own = ws.getWorkspaces().find(w => w.uuid !== agents);
      if (own) await ws.changeWorkspaceWithID(own.uuid);
    }
    if (gb.selectedTab.getAttribute("zen-workspace-id") === agents) {
      gb.selectedTab = gb.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    }
    await T.until(() => W.space() !== agents && gb.selectedTab.getAttribute("zen-workspace-id") !== agents, 5000, "a Space and tab of the user's");
    return was;
  },
  state(uid) {
    const g = T.glue(), doc = T.panelDoc(), $ = s => doc?.querySelector(s);
    const rec = W.rec(uid), conv = W.conv(uid), shot = $(H.PANEL.liveShot);
    return {
      attr: win.document.documentElement.getAttribute(H.WATCH.attr),
      watching: g.watching ?? null,
      pill: T.visible(win.document.querySelector(H.WATCH.pill)),
      space: W.space(),
      taskSpace: rec?.uuid ?? null,
      tabInTaskSpace: !!rec && win.gBrowser.selectedTab.getAttribute("zen-workspace-id") === rec.uuid,
      card: {
        shown: T.visible($(H.PANEL.live)),
        live: $(H.PANEL.live)?.getAttribute("data-live") ?? null,
        text: $(H.PANEL.liveText)?.textContent.trim() ?? null,
        shot: shot ? [shot.width, shot.height] : null,
        dataWatching: $(H.PANEL.live)?.getAttribute("data-watching") ?? null,
        watch: $(H.PANEL.watch)?.textContent.trim() ?? null,
        watchHidden: $(H.PANEL.watch)?.hidden ?? null,
        watchPressed: $(H.PANEL.watch)?.getAttribute("aria-pressed") ?? null,
        hintHidden: $(H.PANEL.watchHint)?.hidden ?? null,
        hintShown: T.visible($(H.PANEL.watchHint)),
        hintText: $(H.PANEL.watchHint)?.textContent.trim() ?? null,
        hintKey: $(H.PANEL.watchHint)?.querySelector("kbd")?.textContent ?? null,
        hintButton: !!$(H.PANEL.watchHint) && ($(H.PANEL.watchHint).localName === "button" || $(H.PANEL.watchHint).getAttribute("role") === "button"),
        takeOver: T.visible($(H.PANEL.takeOver)),
      },
      held: conv ? g.AgentService.isHeld(conv) : null,
      ownership: rec?.ownership ?? null,
      taskState: conv?.task?.state ?? null,
    };
  },
  // zenius's watching chip: where it sits in the page area (the tab panels),
  // its width and colors, its name and key, and what a click reaches. Hit
  // tests (elementFromPoint) skip pointer-events: none, so a click anywhere on
  // the chip reaches what's beneath.
  chip() {
    const doc = win.document, chip = doc.querySelector(H.WATCH.pill);
    if (!chip || !T.visible(chip)) return null;
    const name = chip.querySelector(H.WATCH.name), key = chip.querySelector(H.WATCH.key);
    const page = (doc.getElementById("tabbrowser-tabpanels") ?? win.gBrowser.selectedBrowser).getBoundingClientRect();
    const c = chip.getBoundingClientRect(), k = key?.getBoundingClientRect() ?? null;
    const what = el => el ? el.localName + (el.id ? "#" + el.id : "") : null;
    const hits = [[c.left + 3, c.top + c.height / 2], [c.left + c.width / 2, c.top + c.height / 2], [c.right - 3, c.top + c.height / 2]].map(p => doc.elementFromPoint(...p));
    // The page's top middle, at the chip's height: where pages put their
    // search and sign-in fields, which the chip must never cover.
    const atTop = doc.elementFromPoint(page.left + page.width / 2, c.top + c.height / 2);
    const cs = win.getComputedStyle(chip), ns = name ? win.getComputedStyle(name) : null;
    return {
      tag: chip.localName,
      left: Math.round(c.left - page.left), top: Math.round(c.top - page.top),
      width: Math.round(c.width), pageWidth: Math.round(page.width),
      pointerEvents: cs.pointerEvents, background: cs.backgroundColor, ink: cs.color,
      buttons: chip.querySelectorAll("button, [role=button], a[href]").length,
      hits: hits.map(what), hitsChip: hits.filter(el => el && chip.contains(el)).length,
      topMiddleHit: what(atTop), topMiddleHitsChip: atTop ? chip.contains(atTop) : null,
      name: name?.textContent ?? null,
      nameCut: !!name && ns.textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth + 1,
      key: key?.textContent ?? null, kbd: key?.querySelector("kbd")?.textContent ?? null,
      keyWhole: !!k && k.width > 0 && k.left >= c.left - 1 && k.right <= c.right + 1 && key.scrollWidth <= key.clientWidth + 1,
    };
  },
  // The agents strip's hint while watching: the name, cut by an ellipsis where
  // the strip is narrow, and the key, never cut.
  strip() {
    const doc = win.document, strip = doc.querySelector(H.WATCH.strip);
    if (!strip) return null;
    const name = strip.querySelector(H.WATCH.stripName), key = strip.querySelector(H.WATCH.stripKey);
    const s = strip.getBoundingClientRect(), k = key?.getBoundingClientRect() ?? null;
    const ns = name ? win.getComputedStyle(name) : null;
    return {
      shown: T.visible(strip), watching: strip.getAttribute("watching"),
      name: name?.textContent ?? null, key: key?.textContent ?? null,
      nameCut: !!name && ns.textOverflow === "ellipsis" && name.scrollWidth > name.clientWidth + 1,
      keyShown: !!key && T.visible(key),
      keyWhole: !!k && k.width > 0 && k.right <= s.right + 1 && key.scrollWidth <= key.clientWidth + 1,
    };
  },
  // Each part of a hint: its text, whether it's hidden, cut (its text wider
  // than its box) or outside the hint's box. With narrow > 0, the hint is
  // first made that many px narrower than its parts need, and put back after.
  parts(hint, box, names, narrow = 0) {
    const was = box.style.maxWidth;
    if (narrow) {
      const need = [...box.children].filter(c => !c.hidden).reduce((sum, c) => sum + c.scrollWidth, 0);
      box.style.maxWidth = Math.max(40, Math.min(need, box.getBoundingClientRect().width) - narrow) + "px";
    }
    try {
      const b = hint.getBoundingClientRect();
      return Object.fromEntries(names.map(n => {
        const p = hint.querySelector(n);
        if (!p) return [n, null];
        const r = p.getBoundingClientRect();
        return [n, { text: p.textContent, hidden: p.hidden, cut: p.scrollWidth > p.clientWidth + 1, inside: r.width > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 }];
      }));
    } finally {
      box.style.maxWidth = was;
    }
  },
  // The strip once the watched task is done: "Task done, [⌃Tab] back to your tabs".
  doneStrip(narrow = 0) {
    const strip = win.document.querySelector(H.WATCH.strip), label = strip?.querySelector(H.WATCH.stripText);
    if (!strip || !label) return null;
    return {
      shown: T.visible(strip), watching: strip.getAttribute("watching"), text: label.textContent,
      parts: W.parts(strip, label, [H.WATCH.stripLead, H.WATCH.stripKey, H.WATCH.stripRest], narrow),
    };
  },
  // The chip once the watched task is done, where the strip can't be read.
  doneChip(narrow = 0) {
    const doc = win.document, chip = doc.querySelector(H.WATCH.pill);
    if (!chip || !T.visible(chip)) return null;
    const page = (doc.getElementById("tabbrowser-tabpanels") ?? win.gBrowser.selectedBrowser).getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const hits = [[c.left + 3, c.top + c.height / 2], [c.left + c.width / 2, c.top + c.height / 2], [c.right - 3, c.top + c.height / 2]].map(p => doc.elementFromPoint(...p));
    const cs = win.getComputedStyle(chip);
    return {
      done: chip.hasAttribute("done"),
      left: Math.round(c.left - page.left), top: Math.round(c.top - page.top),
      width: Math.round(c.width), pageWidth: Math.round(page.width),
      pointerEvents: cs.pointerEvents, background: cs.backgroundColor, ink: cs.color,
      buttons: chip.querySelectorAll("button, [role=button], a[href]").length,
      hitsChip: hits.filter(el => el && chip.contains(el)).length,
      kbd: chip.querySelector(H.WATCH.key + " kbd")?.textContent ?? null,
      parts: W.parts(chip, chip, [H.WATCH.name, H.WATCH.key, H.WATCH.rest], narrow),
    };
  },
  // Zen's layout, as a person sets it: "expanded" (the strip can be read),
  // "collapsed" (the sidebar shows only the strip's dot) or "compact" (no
  // sidebar in the window). Each waits for Zen's slide to end and for zenius
  // to recheck the chip after it.
  async layout(mode) {
    const doc = win.document, compact = win.gZenCompactModeManager;
    const wantCompact = mode === "compact", wantExpanded = mode !== "collapsed";
    if (compact && compact.preference !== wantCompact) compact.preference = wantCompact;
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", wantExpanded);
    await T.until(() => (!compact || compact.preference === wantCompact) && !doc.documentElement.hasAttribute("zen-compact-animating"), 5000, "Zen's compact mode");
    if (!wantCompact) await T.until(() => (doc.documentElement.getAttribute("zen-sidebar-expanded") === "true") === wantExpanded, 5000, "Zen's sidebar");
    await T.sleep(800);
  },
  // Back to the layout the profile starts in: an expanded sidebar, not compact.
  async restoreLayout() {
    const doc = win.document, compact = win.gZenCompactModeManager;
    if (compact?.preference) compact.preference = false;
    Services.prefs.clearUserPref("zen.view.compact.enable-at-startup");
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
    await T.until(() => !doc.documentElement.hasAttribute("zen-compact-animating") && doc.documentElement.getAttribute("zen-sidebar-expanded") === "true", 5000, "Zen's layout back").catch(() => {});
    await T.sleep(500);
  },
};
`;
const watchCall = (code, arg) => h.chrome(`${WATCHING}\n${code}`, arg);
const needTask = () => assert.ok(uid, "no live task: the card test didn't start one");

// A 200-character name, so the strip and the chip have to cut it themselves.
// Both take the name of zenius's record of the task (not the chat's title),
// so the looks rename the record through zenius's own spaces.rename, and
// rename it back.
const LONG = "Compare the price of the blue kettle in every shop, with delivery, pickup, warranty and this week's loyalty discounts, then ".repeat(2).slice(0, 196) + " END";
const LAYOUTS = ["collapsed", "compact"];

/** Watches the task in Zen's Light and then Dark, with the task named LONG:
 * the strip where it can be read, then the chip with the sidebar collapsed
 * and in compact mode, held or not, and a shot of the window for each. The
 * name and the layout are put back however the look ends. */
async function hintLooks(prefix) {
  const looks = {};
  for (const theme of ["light", "dark"]) {
    looks[theme] = await inTheme(h, theme, () => watchCall(`
      const g = T.glue(), conv = W.conv(arg.uid), spaces = g.AgentService.zenius().spaces;
      const rec = W.rec(arg.uid), name = rec.name;
      const look = {};
      try {
        await spaces.rename(rec, arg.name);
        await W.layout("expanded");
        look.shown = await g.watch(arg.uid);
        look.held = g.AgentService.isHeld(conv) || null;
        await T.sleep(600);
        look.strip = W.strip();
        look.stripChip = W.chip();
        look.shots = [await T.shot(arg.path + "-strip.png", "white")];
        for (const mode of arg.layouts) {
          await W.layout(mode);
          look[mode] = W.chip();
          look.shots.push(await T.shot(arg.path + "-" + mode + ".png", "white"));
        }
        look.stillWatching = g.watching === arg.uid;
        return look;
      } finally {
        await spaces.rename(rec, name);
        await W.restoreLayout();
        await g.stopWatching({ back: true });
        await T.sleep(300);
      }
    `, { uid, name: LONG, layouts: LAYOUTS, path: join(OUT, `${prefix}-${theme}`) }));
  }
  return looks;
}

function assertLongHint(look, where) {
  const all = JSON.stringify(look);
  console.log(`# strip ${where}: ${JSON.stringify(look.strip)}`);
  for (const mode of LAYOUTS) console.log(`# chip ${where}, ${mode}: ${JSON.stringify(look[mode])}`);
  console.log(`# shots: ${(look.shots ?? []).join(", ")}`);
  assert.equal(look.shown, true, `watch() didn't show the task ${where}: ${all}`);
  assert.equal(look.stillWatching, true, `a change of Zen's layout ended the watch ${where}: ${all}`);
  // Where the strip can be read, it carries the hint, and the chip stays away.
  const s = look.strip;
  assert.equal(s?.watching, "true", `the strip doesn't say Watching ${where}: ${all}`);
  assert.ok(s.name?.includes(LONG), `the strip doesn't hold the long name ${where}: ${all}`);
  assert.ok(s.nameCut, `the strip doesn't cut the long name with an ellipsis ${where}: ${all}`);
  assert.equal(s.key, " ⌃Tab", `the strip's key ${where}: ${all}`);
  assert.ok(s.keyShown && s.keyWhole, `the strip cuts its key ${where}: ${all}`);
  assert.equal(look.stripChip, null, `the chip shows where the strip can be read ${where}: ${all}`);
  // Where it can't, the chip says the same, small, in the page area's top
  // left corner, and every click goes through it.
  for (const mode of LAYOUTS) {
    const c = look[mode], at = `${where}, ${mode}`;
    assert.ok(c, `no chip ${at}: ${all}`);
    assert.ok(c.left >= -1 && c.left <= 40 && c.top >= -1 && c.top <= 40, `the chip isn't in the page area's top left corner ${at}: ${all}`);
    assert.ok(c.width <= Math.min(280, 0.4 * c.pageWidth) + 1, `the chip is wider than 280 px or 40% of the page ${at}: ${all}`);
    assert.ok(c.name?.includes(LONG) && c.nameCut, `the chip doesn't cut the long name with an ellipsis ${at}: ${all}`);
    assert.equal(c.key, "⌃Tab", `the chip's key ${at}: ${all}`);
    assert.equal(c.kbd, "⌃Tab", `the chip's key isn't in a <kbd> ${at}: ${all}`);
    assert.ok(c.keyWhole, `the chip cuts its key ${at}: ${all}`);
    assert.equal(c.buttons, 0, `the chip has a button, but ⌃Tab is the only way back ${at}: ${all}`);
    assert.equal(c.pointerEvents, "none", `the chip takes clicks ${at}: ${all}`);
    assert.equal(c.hitsChip, 0, `a click on the chip lands on it, not beneath ${at}: ${all}`);
    assert.equal(c.topMiddleHitsChip, false, `a click at the page's top middle lands on the chip ${at}: ${all}`);
    assert.equal(c.topMiddleHit, "browser", `a click at the page's top middle doesn't reach the page ${at}: ${all}`);
    assert.notEqual(c.background, c.ink, `the chip's ink is its background ${at}: ${all}`);
  }
}

after(async () => {
  // The done case's task, if that case failed before the agent finished it.
  if (doneSpace !== null && !doneFinished) {
    await h.call("spaces.finish", { space: doneSpace, keep: [] }).catch(e => console.log(`# cleanup: ${e.message}`));
  }
  await h.chrome(`
    const g = T.glue();
    const UI = ChromeUtils.importESModule(H.WATCH.ui).ZeniusUI;
    // A watch, or the way back after a watched task's end.
    if (g?.watching || UI.watchingDone?.(win) != null) await g.stopWatching({ back: true });
    if (g?.directoryOpen) g.closeDirectory();
    // A look that failed midway may have left the sidebar collapsed or Zen compact.
    if (win.gZenCompactModeManager?.preference) win.gZenCompactModeManager.preference = false;
    Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
    for (const id of [arg.uid, arg.doneUid]) {
      const c = id && g?.AgentService.tasks.get(id);
      if (c) g.AgentService.removeTask(c);
    }
    delete win.__zeDone;
    return true;
  `, { uid, doneUid }).catch(e => console.log(`# cleanup: ${e.message}`));
  await h.close();
});

test("Not watching: ⌃Tab is Zen's own tab switch", async () => {
  const r = await h.chrome(`
    const gb = win.gBrowser;
    const add = url => gb.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    const a = add(arg.a), b = add(arg.b);
    try {
      await T.until(() => [a, b].every(t => t.linkedBrowser.currentURI.spec.startsWith("http") && !t.hasAttribute("busy")), 15000, "the two test tabs");
      // Zen places new tabs where its settings say, so put b right after a.
      if (gb.moveTabAfter) gb.moveTabAfter(b, a);
      else gb.moveTabTo(b, { tabIndex: a._tPos + 1 });
      const order = gb.visibleTabs;
      const adjacent = order[order.indexOf(a) + 1] === b;
      // b, then a: b is both the next tab and the last one used, so Zen's
      // switch lands on b whether it goes by order or by recent use.
      gb.selectedTab = b;
      await T.sleep(200);
      gb.selectedTab = a;
      await T.sleep(200);
      gb.selectedBrowser.focus();
      const space = win.gZenWorkspaces?.activeWorkspace ?? null;
      T.press("Tab", ["Control"]);
      try {
        await T.until(() => gb.selectedTab !== a, 3000, "a tab switch");
      } catch {}
      await T.sleep(200);
      return {
        adjacent,
        landed: gb.selectedTab === b ? "the next tab" : gb.selectedTab === a ? "nowhere" : gb.selectedTab.label,
        spaceKept: (win.gZenWorkspaces?.activeWorkspace ?? null) === space,
        watching: win.document.documentElement.getAttribute(H.WATCH.attr),
        recentFirst: Services.prefs.getBoolPref("browser.ctrlTab.sortByRecentlyUsed", false),
      };
    } finally {
      win.ctrlTab?.panel?.hidePopup?.();
      gb.removeTab(a);
      gb.removeTab(b);
      await T.sleep(300);
      win.__zeAfterTabs = { space: win.gZenWorkspaces?.activeWorkspace ?? null, tabs: gb.visibleTabs.length };
    }
  `, { a: `${h.base}/zoo/semantics.html`, b: `${h.base}/zoo/long.html` });
  console.log(`# after its tabs closed: ${JSON.stringify(await h.chrome("return win.__zeAfterTabs;"))}`);
  assert.ok(r.adjacent, `couldn't put the second test tab right after the first: ${JSON.stringify(r)}`);
  assert.equal(r.landed, "the next tab", `⌃Tab: ${JSON.stringify(r)}`);
  assert.ok(r.spaceKept, "⌃Tab changed the Space");
  assert.equal(r.watching, null, "the window says the user is watching");
});

test("A working task's live card shows its page, with Watch and Take over", { skip }, async () => {
  const r = await watchCall(`
    const { startWorkChat } = ChromeUtils.importESModule(H.MODULE);
    await T.openPanel();
    const spaceBefore = W.space(), tabBefore = win.gBrowser.selectedTab;
    const uid = await startWorkChat(win, { text: arg.text, source: "new" });
    await T.until(() => {
      const c = W.conv(uid);
      return c?.task?.state === "working" && c.messages.some(m => m.role === "tool" && m.status === "in_progress") && !!W.rec(uid);
    }, 60000, "the task's running step");
    try {
      await T.until(() => W.state(uid).card.shown && W.state(uid).card.live === "true", 15000, "the live card");
    } catch {}
    await T.sleep(500);
    const kept = { spaceBefore, spaceAfter: W.space(), taskSpace: W.rec(uid)?.uuid ?? null, sameTab: win.gBrowser.selectedTab === tabBefore };
    return { uid, kept, ...W.state(uid), shot: await T.shot(arg.path, "white") };
  `, { text: "Track the price of the blue kettle SCENARIO:prices", path: join(OUT, "watch-card.png") });
  uid = r.uid;
  const all = JSON.stringify(r);
  console.log(`# shot: ${r.shot}`);
  assert.ok(r.card.shown, `the live card isn't shown: ${all}`);
  assert.equal(r.card.live, "true", `the card doesn't say the agent is on the page: ${all}`);
  assert.match(r.card.text ?? "", /^Live on \S/, `the card's line: ${all}`);
  assert.ok(r.card.shot && r.card.shot[0] > 0 && r.card.shot[1] > 0, `the card has no picture: ${all}`);
  assert.equal(r.card.dataWatching, "false", `#live[data-watching] isn't "false" before any watch: ${all}`);
  assert.ok(r.card.watchHidden === false && r.card.watch === "Watch", `the card's Watch doesn't show, reading "Watch", before any watch: ${all}`);
  assert.equal(r.card.watchPressed, null, `the card's Watch carries aria-pressed: ${all}`);
  assert.equal(r.card.hintHidden, true, `the card's hint shows before any watch: ${all}`);
  assert.ok(r.card.takeOver, `Take over isn't shown while the agent has the page: ${all}`);
  assert.equal(r.ownership, "agent", `the agent doesn't have the page: ${all}`);
  assert.equal(r.watching, null, `the window watches already: ${all}`);
  assert.equal(r.pill, false, `the pill shows while not watching: ${all}`);
  console.log(`# the task's start: ${JSON.stringify(r.kept)}`);
  // I1: the agent's start doesn't move the user's window, wherever it was.
  assert.equal(r.kept.spaceAfter, r.kept.spaceBefore, `the task's start moved the window to another Space: ${all}`);
  assert.ok(r.kept.sameTab, `the task's start changed the selected tab: ${all}`);
});

test("The live card draws only while it can be seen", { skip }, async () => {
  needTask();
  const r = await watchCall(`
    const g = T.glue();
    await T.openPanel();
    const live = () => T.panelDoc()?.querySelector(H.PANEL.live);
    const drawn = () => Number(live()?.getAttribute("data-drawn") ?? 0);
    const wait = async (what, from) => {
      try {
        await T.until(() => drawn() > from, arg.wait, what);
      } catch {}
      return drawn();
    };
    g.showTask(arg.uid);
    live()?.scrollIntoView({ block: "end" });
    await T.sleep(500);
    const seen = drawn();
    const seenLater = await wait("a picture while the card is seen", seen);
    // Chat shows the tab's own chat, so the task's card is out of sight.
    g.setMode("chat");
    await T.sleep(800);
    const hidden = drawn();
    await T.sleep(arg.wait);
    const hiddenLater = drawn();
    g.showTask(arg.uid);
    live()?.scrollIntoView({ block: "end" });
    await T.sleep(300);
    const back = drawn();
    const backLater = await wait("a picture once the card is back", back);
    return { seen, seenLater, hidden, hiddenLater, back, backLater, live: live()?.getAttribute("data-live") ?? null, mode: g.mode };
  `, { uid, wait: 6000 });
  const all = JSON.stringify(r);
  assert.ok(r.seenLater > r.seen, `no new picture in 6 s while the card was seen and the agent worked: ${all}`);
  assert.equal(r.hiddenLater, r.hidden, `the card drew while out of sight, in Chat: ${all}`);
  assert.ok(r.backLater > r.back, `no new picture in 6 s once the card was back in sight: ${all}`);
});

test("Watch shows the task's Space and tab; ⌃Tab returns to the user's own", { skip }, async () => {
  needTask();
  const r = await watchCall(`
    const g = T.glue(), gb = win.gBrowser;
    await W.layout("expanded");
    const startedOn = await W.toUser(arg.uid);
    const userTab = gb.selectedTab, userSpace = W.space(), taskName = W.rec(arg.uid)?.name ?? null;
    const shown = await g.watch(arg.uid);
    await T.sleep(600);
    const during = W.state(arg.uid);
    const strip = W.strip(), chip = W.chip();
    const shot = await T.shot(arg.path, "white");
    gb.selectedBrowser.focus();
    T.press("Tab", ["Control"]);
    try {
      await T.until(() => !win.document.documentElement.hasAttribute(H.WATCH.attr), 5000, "the end of Watch");
    } catch {}
    await T.sleep(300);
    return { startedOn, shown, userSpace, taskName, during, strip, chip, shot, back: { ...W.state(arg.uid), strip: W.strip(), onUserTab: gb.selectedTab === userTab } };
  `, { uid, path: join(OUT, "watching.png") });
  const all = JSON.stringify(r);
  console.log(`# started on ${r.startedOn}`);
  console.log(`# shot: ${r.shot}`);
  console.log(`# strip: ${JSON.stringify(r.strip)}`);
  const { shown, dataWatching, watchHidden, hintShown, hintText } = r.during.card;
  console.log(`# card while watching: ${JSON.stringify({ shown, dataWatching, watchHidden, hintShown, hintText })}`);
  // With the sidebar expanded, zenius's strip says it, and the chip stays away.
  assert.equal(r.strip?.watching, "true", `the strip doesn't say Watching while watching: ${all}`);
  assert.ok(r.strip.shown && r.strip.keyShown, `the strip's hint can't be seen: ${all}`);
  assert.ok(r.taskName && r.strip.name?.includes(r.taskName), `the strip doesn't name the watched task: ${all}`);
  assert.equal(r.strip.key, " ⌃Tab", `the strip's key: ${all}`);
  assert.equal(r.chip, null, `the chip shows where the strip can be read: ${all}`);
  assert.equal(r.shown, true, `watch() says the window doesn't show the task: ${all}`);
  assert.equal(r.during.attr, uid, `#main-window doesn't name the watched task: ${all}`);
  assert.equal(r.during.watching, uid, `the watching getter: ${all}`);
  assert.equal(r.during.pill, false, `the chip shows while the strip can be read: ${all}`);
  assert.notEqual(r.during.space, r.userSpace, `Watch didn't leave the user's Space: ${all}`);
  assert.equal(r.during.space, r.during.taskSpace, `Watch isn't on the task's Space: ${all}`);
  assert.ok(r.during.tabInTaskSpace, `the shown tab isn't the task's: ${all}`);
  assert.equal(r.during.card.dataWatching, "true", `#live[data-watching] isn't "true" while watching: ${all}`);
  assert.equal(r.during.card.watchHidden, true, `the card's Watch isn't hidden while watching: ${all}`);
  assert.equal(r.during.card.hintHidden, false, `the card's hint is hidden while watching: ${all}`);
  assert.ok(!r.during.card.shown || r.during.card.hintShown, `the card shows, but its hint can't be seen: ${all}`);
  assert.equal(r.during.card.hintText, "⌃Tab back to your tabs", `the card's hint: ${all}`);
  assert.equal(r.during.card.hintKey, "⌃Tab", `the hint's key isn't in a <kbd>: ${all}`);
  assert.equal(r.during.card.hintButton, false, `the card's hint is a button, but ⌃Tab is the way back: ${all}`);
  assert.equal(r.back.attr, null, `⌃Tab didn't end Watch: ${all}`);
  assert.equal(r.back.watching, null, `the watching getter after ⌃Tab: ${all}`);
  assert.equal(r.back.pill, false, `the chip stays after ⌃Tab: ${all}`);
  assert.equal(r.back.strip?.watching ?? null, null, `the strip still says Watching after ⌃Tab: ${all}`);
  assert.equal(r.back.space, r.userSpace, `⌃Tab didn't return to the user's Space: ${all}`);
  assert.ok(r.back.onUserTab, `⌃Tab didn't return to the user's tab: ${all}`);
  assert.equal(r.back.taskState, "working", `the task stopped when the user stopped watching: ${all}`);
  assert.equal(r.back.card.dataWatching, "false", `#live[data-watching] stays "true" after ⌃Tab: ${all}`);
  assert.ok(r.back.card.watchHidden === false && r.back.card.hintHidden === true, `the card doesn't give Watch its place back after ⌃Tab: ${all}`);
});

test("A click on one of the task's tabs in the directory watches it, and ⌃Tab goes back", { skip }, async () => {
  needTask();
  const r = await watchCall(`
    const g = T.glue(), gb = win.gBrowser;
    const startedOn = await W.toUser(arg.uid);
    const userTab = gb.selectedTab, userSpace = W.space();
    g.showTask(arg.uid);
    if (!g.directoryOpen) g.toggleDirectory();
    const root = win.document.querySelector(H.DRAWER.root);
    const sel = H.DRAWER.row + '[data-task="' + arg.uid + '"]';
    await T.until(() => root && !root.hidden && root.querySelector(sel), 5000, "the task's row in the directory");
    const row = root.querySelector(sel);
    await T.until(() => row.querySelector(H.DRAWER.tab) ?? root.querySelector(H.DRAWER.tab), 5000, "the task's tabs in the directory");
    const current = row.getAttribute("data-current");
    (row.querySelector(H.DRAWER.tab) ?? root.querySelector(H.DRAWER.tab)).click();
    try {
      await T.until(() => g.watching === arg.uid, 5000, "a watch from the directory");
    } catch {}
    await T.sleep(300);
    const fromDir = W.state(arg.uid);
    // ⌃Tab is the only way back: the chip has no buttons.
    gb.selectedBrowser.focus();
    T.press("Tab", ["Control"]);
    try {
      await T.until(() => !g.watching, 5000, "⌃Tab to end the directory's watch");
    } catch {}
    await T.sleep(300);
    const back = { watching: g.watching ?? null, space: W.space(), onUserTab: gb.selectedTab === userTab };
    if (g.directoryOpen) g.closeDirectory();
    return { startedOn, userSpace, current, fromDir, back };
  `, { uid });
  const all = JSON.stringify(r);
  console.log(`# started on ${r.startedOn}`);
  assert.equal(r.current, "true", `the shown task's row isn't current: ${all}`);
  assert.equal(r.fromDir.watching, uid, `the directory's tab didn't start a watch: ${all}`);
  assert.ok(r.fromDir.tabInTaskSpace, `the directory's watch isn't on the task's tab: ${all}`);
  assert.equal(r.back.watching, null, `⌃Tab didn't end the directory's watch: ${all}`);
  assert.equal(r.back.space, r.userSpace, `⌃Tab didn't return to the user's Space: ${all}`);
  assert.ok(r.back.onUserTab, `⌃Tab didn't return to the user's tab: ${all}`);
});

test("With a 200-character name, in Light and Dark, the strip cuts the name, never its key; with the sidebar collapsed or in compact mode, the chip says the same, at most 280 px or 40% of the page, and every click goes through it", { skip }, async () => {
  needTask();
  const looks = await hintLooks("hint-watching");
  for (const [theme, look] of Object.entries(looks)) {
    assertLongHint(look, `while watching, in ${theme}`);
    assert.equal(look.held, null, `the task is held before any Take over, in ${theme}: ${JSON.stringify(look)}`);
  }
});

test("Take over hands the page to the user, and watches it", { skip }, async () => {
  needTask();
  const r = await watchCall(`
    const g = T.glue(), gb = win.gBrowser;
    const startedOn = await W.toUser(arg.uid);
    const userTab = gb.selectedTab, userSpace = W.space();
    const before = W.rec(arg.uid)?.ownership ?? null;
    const took = await g.takeOver(arg.uid);
    try {
      await T.until(() => /^You have control/.test(W.state(arg.uid).card.text ?? ""), 5000, "the card's line");
    } catch {}
    await T.sleep(300);
    const during = W.state(arg.uid);
    await g.stopWatching({ back: true });
    await T.sleep(300);
    return { startedOn, before, took, userSpace, during, back: { watching: g.watching ?? null, space: W.space(), onUserTab: gb.selectedTab === userTab } };
  `, { uid });
  const all = JSON.stringify(r);
  console.log(`# started on ${r.startedOn}`);
  assert.equal(r.before, "agent", `the agent didn't have the page before Take over: ${all}`);
  assert.equal(r.took, true, `takeOver() says the user doesn't have the task: ${all}`);
  assert.equal(r.during.held, "takeover", `the task isn't held by a Take over: ${all}`);
  assert.equal(r.during.watching, uid, `Take over doesn't watch the task: ${all}`);
  assert.match(r.during.card.text ?? "", /^You have control on \S/, `the card's line: ${all}`);
  assert.equal(r.during.card.takeOver, false, `Take over still shows after the user took the page: ${all}`);
  assert.equal(r.during.card.dataWatching, "true", `#live[data-watching] isn't "true" while Take over watches: ${all}`);
  assert.ok(r.during.card.watchHidden === true && r.during.card.hintHidden === false, `the card doesn't show its hint in Watch's place after Take over: ${all}`);
  assert.equal(r.back.watching, null, `stopWatching left a watch: ${all}`);
  assert.equal(r.back.space, r.userSpace, `the way back after Take over: ${all}`);
  assert.ok(r.back.onUserTab, `the way back after Take over: ${all}`);
});

test("After Take over, the hint with a 200-character name is the same, in Light and Dark", { skip }, async () => {
  needTask();
  const looks = await hintLooks("hint-takeover");
  for (const [theme, look] of Object.entries(looks)) {
    assertLongHint(look, `after Take over, in ${theme}`);
    assert.equal(look.held, "takeover", `the task isn't the user's after Take over, in ${theme}: ${JSON.stringify(look)}`);
  }
});

// zen-manager's case for zen-ux's af4bc5b: a watched task's end keeps ⌃Tab's
// way back. It watches a task of its own (the mock's SCENARIO:flights, which
// holds a step), since finishing ends it, and the agent finishes it through
// zenius, keeping nothing, as task.finish({ keep: [] }) does. The window then
// stays on the task's page, which waits until the user leaves it, and says
// "Task done, [⌃Tab] back to your tabs": in the strip, whole at the profile's
// sidebar width, and where it's narrower only "back to your tabs" is cut; in
// Light and Dark. With the sidebar collapsed the chip says the same and cuts
// the same way. ⌃Tab goes back to the user's tab and Space, and the page closes.
const DONE_LAYOUTS = ["collapsed"];

function assertDoneHint(look, where) {
  const all = JSON.stringify(look);
  console.log(`# done ${where}: strip ${JSON.stringify(look.strip)}; narrow ${JSON.stringify(look.stripNarrow?.parts)}`);
  for (const mode of DONE_LAYOUTS) console.log(`# done ${where}, chip ${mode}: ${JSON.stringify(look[mode])}; narrow ${JSON.stringify(look[mode + "Narrow"]?.parts)}`);
  console.log(`# shots: ${(look.shots ?? []).join(", ")}`);
  assert.equal(look.live, null, `the task's end left a live watch ${where}: ${all}`);
  assert.ok(look.stayed && look.waits, `the window moved, or the task's page closed before the user left it, ${where}: ${all}`);
  assert.ok(look.stillDone, `a change of theme or layout ended the way back ${where}: ${all}`);
  const s = look.strip, lead = s?.parts?.[".zenius-strip-lead"], key = s?.parts?.[".zenius-strip-key"], rest = s?.parts?.[".zenius-strip-rest"];
  assert.equal(s?.watching, "done", `the strip isn't [watching="done"] ${where}: ${all}`);
  assert.ok(s.shown, `the strip can't be seen ${where}: ${all}`);
  assert.equal(s.text, "Task done, ⌃Tab back to your tabs", `the strip's words ${where}: ${all}`);
  assert.ok(lead?.text === "Task done," && !lead.cut && lead.inside, `the strip cuts "Task done" ${where}: ${all}`);
  assert.ok(key?.text === " ⌃Tab" && !key.cut && key.inside, `the strip cuts its key ${where}: ${all}`);
  assert.equal(rest?.text, " back to your tabs", `the strip doesn't say where ⌃Tab goes ${where}: ${all}`);
  assert.equal(look.stripChip, null, `the chip shows where the strip can be read ${where}: ${all}`);
  const n = look.stripNarrow?.parts ?? {};
  assert.ok(n[".zenius-strip-lead"] && !n[".zenius-strip-lead"].cut, `a narrow strip cuts "Task done" ${where}: ${all}`);
  assert.ok(n[".zenius-strip-key"] && !n[".zenius-strip-key"].cut, `a narrow strip cuts its key ${where}: ${all}`);
  assert.equal(n[".zenius-strip-rest"]?.cut, true, `a narrow strip doesn't cut "back to your tabs" first ${where}: ${all}`);
  for (const mode of DONE_LAYOUTS) {
    const c = look[mode], at = `${where}, ${mode}`;
    assert.ok(c, `no chip ${at}: ${all}`);
    const p = c.parts;
    assert.equal(c.done, true, `the chip isn't [done] ${at}: ${all}`);
    assert.ok(p[".zenius-watch-name"]?.text === "Task done," && !p[".zenius-watch-name"].cut && p[".zenius-watch-name"].inside, `the chip cuts "Task done" ${at}: ${all}`);
    assert.ok(p[".zenius-watch-key"]?.text === "⌃Tab" && !p[".zenius-watch-key"].cut && p[".zenius-watch-key"].inside, `the chip cuts its key ${at}: ${all}`);
    assert.equal(c.kbd, "⌃Tab", `the chip's key isn't in a <kbd> ${at}: ${all}`);
    assert.ok(p[".zenius-watch-rest"]?.text === "back to your tabs" && !p[".zenius-watch-rest"].hidden, `the chip doesn't say where ⌃Tab goes ${at}: ${all}`);
    assert.ok(c.left >= -1 && c.left <= 40 && c.top >= -1 && c.top <= 40, `the chip isn't in the page area's top left corner ${at}: ${all}`);
    assert.ok(c.width <= Math.min(280, 0.4 * c.pageWidth) + 1, `the chip is wider than 280 px or 40% of the page ${at}: ${all}`);
    assert.equal(c.buttons, 0, `the chip has a button, but ⌃Tab is the way back ${at}: ${all}`);
    assert.equal(c.pointerEvents, "none", `the chip takes clicks ${at}: ${all}`);
    assert.equal(c.hitsChip, 0, `a click on the chip lands on it, not beneath ${at}: ${all}`);
    assert.notEqual(c.background, c.ink, `the chip's ink is its background ${at}: ${all}`);
    const cn = look[mode + "Narrow"]?.parts ?? {};
    assert.ok(cn[".zenius-watch-name"] && !cn[".zenius-watch-name"].cut, `a narrow chip cuts "Task done" ${at}: ${all}`);
    assert.ok(cn[".zenius-watch-key"] && !cn[".zenius-watch-key"].cut, `a narrow chip cuts its key ${at}: ${all}`);
    assert.equal(cn[".zenius-watch-rest"]?.cut, true, `a narrow chip doesn't cut "back to your tabs" first ${at}: ${all}`);
  }
}

test("A watched task's end: 'Task done, [⌃Tab]' stays whole in the strip, in Light and Dark, and in the chip with the sidebar collapsed; ⌃Tab goes back, and the page closes", { skip: skipDone }, async () => {
  const started = await watchCall(`
    const { startWorkChat } = ChromeUtils.importESModule(H.MODULE);
    const g = T.glue(), gb = win.gBrowser;
    await T.openPanel();
    const uid = await startWorkChat(win, { text: arg.text, source: "new" });
    await T.until(() => {
      const c = W.conv(uid);
      return c?.task?.state === "working" && c.messages.some(m => m.role === "tool" && m.status === "in_progress") && !!W.rec(uid);
    }, 60000, "the second task's running step");
    await W.layout("expanded");
    const startedOn = await W.toUser(uid);
    const user = { tab: gb.selectedTab, space: W.space() };
    const shown = await g.watch(uid);
    await T.sleep(600);
    win.__zeDone = { user, taskTab: gb.selectedTab };
    return { uid, startedOn, space: W.rec(uid)?.id ?? null, shown, watching: g.watching ?? null, tabInTaskSpace: W.state(uid).tabInTaskSpace };
  `, { text: "Find nonstop flights from SFO to Tokyo SCENARIO:flights" });
  console.log(`# started on ${started.startedOn}`);
  doneUid = started.uid;
  doneSpace = started.space;
  assert.equal(started.shown, true, `watch() didn't show the second task: ${JSON.stringify(started)}`);
  assert.ok(Number.isSafeInteger(started.space) && started.tabInTaskSpace, `the second task has no page to watch: ${JSON.stringify(started)}`);
  // The agent finishes the task, keeping nothing.
  const receipt = await h.call("spaces.finish", { space: started.space, keep: [] });
  doneFinished = true;
  console.log(`# finish: ${JSON.stringify(receipt)}`);
  const looks = {};
  for (const theme of ["light", "dark"]) {
    looks[theme] = await inTheme(h, theme, () => watchCall(`
      const UI = ChromeUtils.importESModule(H.WATCH.ui).ZeniusUI, gb = win.gBrowser, t = win.__zeDone.taskTab;
      await T.until(() => UI.watchingDone(win) === arg.space, 5000, "the way back after the task's end");
      await T.sleep(400);
      const look = { live: UI.watching(win), stayed: gb.selectedTab === t, waits: t.isConnected && !t.closing };
      try {
        await W.layout("expanded");
        look.strip = W.doneStrip();
        look.stripChip = W.doneChip();
        look.stripNarrow = W.doneStrip(40);
        look.shots = [await T.shot(arg.path + "-strip.png", arg.backdrop)];
        for (const mode of arg.layouts) {
          await W.layout(mode);
          look[mode] = W.doneChip();
          look[mode + "Narrow"] = W.doneChip(40);
          look.shots.push(await T.shot(arg.path + "-" + mode + ".png", arg.backdrop));
        }
      } finally {
        await W.restoreLayout();
      }
      look.stillDone = UI.watchingDone(win) === arg.space && gb.selectedTab === t;
      return look;
    `, { space: started.space, layouts: DONE_LAYOUTS, path: join(OUT, `hint-done-${theme}`), backdrop: BACKDROP[theme] }));
  }
  const back = await watchCall(`
    const UI = ChromeUtils.importESModule(H.WATCH.ui).ZeniusUI, gb = win.gBrowser;
    const { user, taskTab: t } = win.__zeDone;
    gb.selectedBrowser.focus();
    T.press("Tab", ["Control"]);
    try {
      await T.until(() => UI.watchingDone(win) === null, 5000, "⌃Tab's way back");
    } catch {}
    await T.sleep(300);
    const r = {
      done: UI.watchingDone(win), onUserTab: gb.selectedTab === user.tab, spaceBack: W.space() === user.space,
      strip: W.doneStrip()?.watching ?? null, chip: !!W.doneChip(), attr: win.document.documentElement.getAttribute(H.WATCH.attr),
    };
    try {
      await T.until(() => !t.isConnected || t.closing, 5000, "the task's page to close");
      r.closed = true;
    } catch {
      r.closed = false;
    }
    delete win.__zeDone;
    return r;
  `);
  for (const [theme, look] of Object.entries(looks)) assertDoneHint(look, `after the task's end, in ${theme}`);
  const all = JSON.stringify(back);
  assert.equal(back.done, null, `⌃Tab didn't end the way back: ${all}`);
  assert.ok(back.onUserTab && back.spaceBack, `⌃Tab didn't return to the user's tab and Space: ${all}`);
  assert.equal(back.strip, null, `the strip still says Task done after ⌃Tab: ${all}`);
  assert.equal(back.chip, false, `the chip stays after ⌃Tab: ${all}`);
  assert.equal(back.attr, null, `#main-window still names a watched task: ${all}`);
  assert.equal(back.closed, true, `the task's page didn't close once the user left it: ${all}`);
});
