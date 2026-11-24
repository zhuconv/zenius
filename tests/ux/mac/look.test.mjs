// The look of every zen-ux surface, for a person to review (L1–L7 below).
// zen-eval runs it on the Mac in a visible dev Zen, so the screenshots show
// Retina rendering:
//
//   ZENIUS_UX_HEADED=1 tests/ux/run.sh tests/ux/mac/look.test.mjs
//
// Screenshots go to $ZENIUS_UX_SHOTS (default: $TMPDIR/zenius-ux-look), in
// light and dark. The test itself checks only that each surface rendered,
// and that the dark shots show Zen's dark theme.
//
// Each theme is Zen's own Light or Dark (zen.view.window.scheme, its
// Settings' choice), with the color scheme pages and zenius's parts read
// (ui.systemUsesDarkTheme). Both are the dev profile's prefs, never the
// Mac's appearance, and they go back as they were in a finally (inTheme).
//
// By default the shots come from drawSnapshot(), which skips popups (the
// tasks panel is then drawn inline where it opens) and paints zoomed page
// content unscaled (judge L1 at 150% by the cursor only).
// ZENIUS_UX_SCREENCAPTURE=1 takes real screen captures on the Mac instead,
// popup included. It raises the dev window first, and macOS may ask once for
// Screen Recording permission for the terminal.
//
// Zen greys out a window that isn't the frontmost one (InactiveCaption, flat
// light gray even in dark mode), and the dev window rarely is while a
// terminal runs the test. So the test turns that off for its run, and prints
// whether the window was active for each shot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { clientFacts, REPO, reportBody, reportTitle } from "../../../runtime/JS/zenius/modules/feedbacktext.sys.mjs";
import { prelude, setup } from "../lib.mjs";

const OUT = process.env.ZENIUS_UX_SHOTS || join(tmpdir(), "zenius-ux-look");
const SCREEN = process.env.ZENIUS_UX_SCREENCAPTURE === "1" && process.platform === "darwin";
let h;
let space;
let other;
let P;
let userView;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "Book a table" }));
  ({ id: other } = await h.createSpace({ name: "Renew passport" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  await h.call("page.goto", { space: other, page: "p1", url: `${h.base}/` });
  await h.chrome(`Services.prefs.setBoolPref("zen.view.grey-out-inactive-windows", false);`);
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const doc = win.document;
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const two = ctx.resolvePage({ space: ${other}, page: "p1" });
    const showSpace = async (uuid, pageTab) => {
      if (pageTab) Pages.landOn(pageTab);
      await gZenWorkspaces.changeWorkspaceWithID(uuid);
      await until(() => gZenWorkspaces.activeWorkspace === uuid);
      // Tasks share the Agents Space: when it is already shown, the switch
      // lands nowhere, so select the page as the user's click on its tab would.
      if (pageTab && gBrowser.selectedTab !== pageTab) gBrowser.selectedTab = pageTab;
      if (pageTab) await until(() => gBrowser.selectedTab === pageTab);
      await sleep(400);
    };
    const userClick = () => {
      const r = browser.getBoundingClientRect();
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, r.x + r.width - 120, r.y + r.height - 220,
          { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      }
    };
    const panelCopy = () => doc.getElementById("zenius-look-panel-copy");
  `;
});

after(async () => {
  if (h) {
    await restoreTheme().catch(() => {});
  }
  await h?.chrome(`${P}
    Services.prefs.clearUserPref("zen.view.sidebar-expanded");
    Services.prefs.clearUserPref("zen.view.grey-out-inactive-windows");
    UI.takeover.reset();
    UI.closeTasksPanel(win);
    panelCopy()?.remove();
    for (const r of [rec, two.space]) if (r.ownership !== "agent") ctx.spaces.setOwnership(r, "agent", { source: "user" });
    C.hideCursor(tab);
    browser.fullZoom = 1;
    if (gZenWorkspaces.activeWorkspace !== userWs) await showSpace(userWs);
  `).catch(() => {});
  await h?.close();
});

const inactive = [];

/** The prefs a theme sets, in the dev profile only. */
const THEME_PREFS = ["zen.view.window.scheme", "ui.systemUsesDarkTheme"];
/**
 * What drawSnapshot paints under Zen's window. On a Mac the window is
 * transparent over the system's own material, which a snapshot can't draw. Over
 * white, Zen's dark chrome came out as grey: 153 in the sidebar, about 160 in
 * the content. A probe on Linux reproduced both numbers with Zen's
 * transparent window, and got 18 and 40 over a dark backdrop. So a dark theme's
 * shots get a dark stand-in for that material.
 */
let backdrop = "white";

/** The theme prefs' values from before a theme's test, while it runs. */
let themeWas = null;

/** Put the theme prefs back as they were: inTheme's finally, or after() if a body hung. */
async function restoreTheme() {
  if (!themeWas) {
    return;
  }
  await h.chrome(`
    for (const [p, v] of Object.entries(${JSON.stringify(themeWas)})) {
      if (v === null) Services.prefs.clearUserPref(p);
      else Services.prefs.setIntPref(p, v);
    }
    return true;
  `);
  themeWas = null;
}

/** Run `body` in Zen's `theme`; the theme's prefs go back as they were in a finally. */
async function inTheme(theme, body) {
  themeWas = await h.chrome(`
    const was = {};
    for (const p of ${JSON.stringify(THEME_PREFS)}) {
      was[p] = Services.prefs.prefHasUserValue(p) ? Services.prefs.getIntPref(p) : null;
    }
    Services.prefs.setIntPref("zen.view.window.scheme", ${theme === "dark" ? 0 : 1});
    Services.prefs.setIntPref("ui.systemUsesDarkTheme", ${theme === "dark" ? 1 : 0});
    await new Promise(r => win.setTimeout(r, 500));
    return was;
  `);
  backdrop = theme === "dark" ? "#1e1e20" : "white";
  try {
    return await body();
  } finally {
    backdrop = "white";
    await restoreTheme();
  }
}

/** The sidebar's lightness (0–255) in a snapshot, where the shots show Zen's own background. */
function sidebarInk() {
  return h.chrome(`
    const sb = win.document.getElementById("navigator-toolbox").getBoundingClientRect();
    const rect = new win.DOMRect(Math.round(sb.left + 4), Math.round(sb.top + sb.height * 0.55), 1, 1);
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(rect, 1, ${JSON.stringify(backdrop)});
    const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    c.width = 1;
    c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(bitmap, 0, 0);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    return Math.round(0.2126 * r + 0.7152 * gr + 0.0722 * b);
  `);
}

/** The window as it looks now, at the screen's pixel ratio. */
async function shot(name) {
  const path = join(OUT, `${name}.png`);
  if (!(await h.chrome(`return Services.focus.activeWindow === win;`))) {
    inactive.push(name);
  }
  if (SCREEN) {
    const r = await h.chrome(`
      win.focus();
      await new Promise(res => win.setTimeout(res, 300));
      return [win.mozInnerScreenX, win.mozInnerScreenY, win.innerWidth, win.innerHeight].map(Math.round);
    `);
    execFileSync("screencapture", ["-x", "-o", `-R${r.join(",")}`, path]);
  } else {
    await h.chrome(`
      const scale = win.devicePixelRatio || 1;
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(
        new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), scale, ${JSON.stringify(backdrop)});
      const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, "image/png"));
      await IOUtils.write(${JSON.stringify(path)}, new Uint8Array(await blob.arrayBuffer()));
    `);
  }
  assert.ok(statSync(path).size > 10_000, `${path} looks empty`);
  return path;
}

for (const theme of ["light", "dark"]) {
  test(`${theme}: every zen-ux surface renders`, () =>
    inTheme(theme, async () => {
      const shots = [];
      const run = code => h.chrome(`${P}${code}`);
      const scheme = await run(`
        ctx.spaces.setStateText(rec, "Finding a table for 4 at 7 pm");
        ctx.spaces.setStateText(two.space, "Log in to continue");
        await showSpace(rec.uuid, tab);
        return {
          chrome: win.matchMedia("(prefers-color-scheme: dark)").matches,
          zen: win.gZenThemePicker?.isDarkMode ?? null,
          root: win.getComputedStyle(win.document.documentElement).colorScheme,
        };
      `);
      // The dark shots must show Zen's dark theme, not just our parts.
      assert.equal(scheme.chrome, theme === "dark", "the chrome's color scheme");
      assert.equal(scheme.zen, theme === "dark", "Zen's own dark mode");
      assert.equal(scheme.root, theme, "the color scheme Zen's chrome is drawn in");
      const ink = await sidebarInk();
      assert.ok(theme === "dark" ? ink < 80 : ink > 180, `the sidebar in the ${theme} shots is ${theme} (${ink} of 255)`);

      // L1: the cursor and its label, at 100% and 150% zoom.
      const cursor = await run(`
        await C.moveCursor(tab, { x: 330, y: 160 }, { label: "Pick a time", kind: "click" });
        await sleep(500);
        return !!browser.parentElement.querySelector(".zenius-cursor-layer .zenius-cursor");
      `);
      assert.equal(cursor, true, "the cursor rendered");
      shots.push(await shot(`L1-cursor-100-${theme}`));
      await run(`
        browser.fullZoom = 1.5;
        await sleep(300);
        await C.moveCursor(tab, { x: 330, y: 160 }, { label: "Pick a time", kind: "move" });
        await sleep(300);
      `);
      shots.push(await shot(`L1-cursor-150-${theme}`));

      // L2: the takeover prompt in the agent's page.
      const prompt = await run(`
        browser.fullZoom = 1;
        await sleep(3200); // past the grace period after an earlier prompt
        userClick();
        await until(() => UI.takeover.promptState(rec.id));
        await sleep(600);
        return !!UI.describe(rec).prompt;
      `);
      assert.equal(prompt, true, "the takeover prompt opened");
      shots.push(await shot(`L2-takeover-prompt-${theme}`));

      // L3: "You're in control" after Take over.
      const inControl = await run(`
        UI.takeover.resolve(rec.id, "continue");
        await UI.takeOverByUser(rec);
        await sleep(600);
        return UI.describe(rec).controlNotice;
      `);
      assert.match(inControl, /^You're in control/);
      shots.push(await shot(`L3-user-in-control-${theme}`));

      // L4: handOff in the other Space: its notice, badge and the strip.
      const needsYou = await run(`
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
        ctx.spaces.setOwnership(two.space, "agentDelegatedToUser", { source: "agent" });
        await showSpace(two.space.uuid, two.tab);
        const d = UI.describe(two.space);
        return { notice: d.controlNotice, said: [d.controlNote, d.controlMore].join(" ") };
      `);
      // The detail comes in Unicode isolates (for right-to-left names).
      assert.match(needsYou.notice.replace(/[\u2066-\u2069]/g, ""), /^Agent needs you · /);
      assert.ok(needsYou.said.replace(/[\u2066-\u2069]/g, "").includes("The agent says: “Log in to continue”."), needsYou.said);
      shots.push(await shot(`L4-agent-needs-you-${theme}`));

      // L5: the user's Space, with the strip and the switcher badges.
      const strip = await run(`
        await showSpace(userWs);
        return doc.getElementById("zenius-agents-strip")?.textContent;
      `);
      // One task waits: the strip names it and what it waits for.
      assert.match(strip, /needs |handed you its tab/);
      shots.push(await shot(`L5-sidebar-strip-${theme}`));

      // L6: the tasks panel: the real popup on a screen capture, else drawn
      // inline where it opens.
      const rows = await run(`
        const panel = UI.openTasksPanel(win);
        await new Promise(r => panel.state === "open" ? r() : panel.addEventListener("popupshown", r, { once: true }));
        const rows = panel.querySelectorAll(".zenius-task").length;
        if (!${SCREEN}) {
          const pr = panel.getBoundingClientRect();
          const copy = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
          copy.id = "zenius-look-panel-copy";
          copy.style.cssText = "position: fixed; z-index: 1000; left: " + pr.x + "px; top: " + pr.y + "px;" +
            "background: var(--arrowpanel-background); color: var(--arrowpanel-color);" +
            "border-radius: var(--arrowpanel-border-radius, 8px); border: 1px solid var(--arrowpanel-border-color, rgba(128,128,128,.25));" +
            "box-shadow: 0 2px 14px rgba(0,0,0,.3);";
          copy.append(panel.querySelector(".zenius-tasks").cloneNode(true));
          panel.hidePopup();
          doc.documentElement.append(copy);
        }
        await sleep(400);
        return rows;
      `);
      assert.ok(rows >= 2, "the panel lists both tasks");
      shots.push(await shot(`L6-tasks-panel-${theme}`));

      // L7: a collapsed sidebar.
      await run(`
        UI.closeTasksPanel(win);
        panelCopy()?.remove();
        Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
        await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") !== "true");
        await sleep(400);
      `);
      shots.push(await shot(`L7-sidebar-collapsed-${theme}`));
      const dpr = await run(`
        Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
        await until(() => doc.documentElement.getAttribute("zen-sidebar-expanded") === "true");
        ctx.spaces.setOwnership(two.space, "agent", { source: "user" });
        C.hideCursor(tab);
        return win.devicePixelRatio;
      `);
      console.log(`# ${shots.length} ${SCREEN ? "screen captures" : "snapshots"} at ${dpr}x in ${OUT}`);
      if (inactive.length) {
        console.log(`# taken while the window wasn't the active one (Firefox may dim some text): ${inactive.join(", ")}`);
        inactive.length = 0;
      }
  }));
}

// The notice pills: the takeover pill at the bottom center of the agent's
// page, and a 2x sheet of every pill (takeover after a click and after
// typing, You're in control, Agent needs you with and without zen-core's
// reload, a permission prompt, a close waiting for the user, the claim gate's
// prompt, the local-address cards, a tab that joined a held task, and the
// cards of a kept page that runs the agent's code), in light and dark.
for (const theme of ["light", "dark"]) {
  test(`${theme}: the notice pills, for review`, () =>
    inTheme(theme, async () => {
      const run = code => h.chrome(`${P}${code}`);
      await run(`
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
        ctx.spaces.setStateText(rec, "Finding a table for 4 at 7 pm");
        await showSpace(rec.uuid, tab);
        await C.moveCursor(tab, { x: 330, y: 160 }, { label: "Pick a time", kind: "move" });
      `);
      const N = `const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");`;
      // Each state: how to show it, which pill, how to clear it.
      const states = {
        clicked: [`UI.takeover.handleInput(rec, tab, "pointer");`, "zenius-takeover", `UI.takeover.reset();`],
        typed: [`UI.takeover.handleInput(rec, tab, "key");`, "zenius-takeover", `UI.takeover.reset();`],
        inControl: [`await UI.takeOverByUser(rec);`, "zenius-control", `ctx.spaces.setOwnership(rec, "agent", { source: "user" });`],
        needsYou: [
          `ctx.spaces.setStateText(rec, "Log in to continue"); ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });`,
          "zenius-control",
          `ctx.spaces.setOwnership(rec, "agent", { source: "user" }); ctx.spaces.setStateText(rec, "Finding a table for 4 at 7 pm");`,
        ],
        // The agent's words at length: one line, cut, the rest behind the '?'.
        needsYouLong: [
          `ctx.spaces.setStateText(rec, "Sign in with the account ending in 42, then open Statements, choose March 2026 and keep the page open so I can download the PDF and check the totals against the receipts"); ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });`,
          "zenius-control",
          `ctx.spaces.setOwnership(rec, "agent", { source: "user" }); ctx.spaces.setStateText(rec, "Finding a table for 4 at 7 pm");`,
        ],
        // A long task and a long site: the task's name gives way, the site stays whole.
        needsYouLongSite: [
          `N.showNotice(tab, "zenius-test-site", { ...ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").controlCard({ name: "Book a table for four at the Italian place on Main Street this Friday", stateText: "Log in to continue" }, "agent"), site: "examplecorporation-identity-services.co.uk", buttons: [{ label: "Resume agent", primary: true }] });`,
          "zenius-test-site",
          `N.removeNotice(tab, "zenius-test-site");`,
        ],
        // Once the user typed a secret: the Resume line leads, the agent's words behind the '?'.
        needsYouTyped: [
          `ctx.spaces.setStateText(rec, "Log in to continue"); ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" }); UI.secretTyped({ browser });`,
          "zenius-control",
          `ctx.spaces.setOwnership(rec, "agent", { source: "user" }); ctx.spaces.setStateText(rec, "Finding a table for 4 at 7 pm");`,
        ],
        permission: [
          `ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "storage_access", source: "permission" });`,
          "zenius-control",
          `ctx.spaces.setOwnership(rec, "agent", { source: "user" });`,
        ],
        // The card a waiting close shows (ZeniusUI shows it on tabClosing).
        closing: [
          `N.showNotice(tab, "zenius-task-finished", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").closingCard(true, rec.name));`,
          "zenius-task-finished",
          `N.removeNotice(tab, "zenius-task-finished");`,
        ],
        // A tab the user opened from the agent's page while holding the task.
        joined: [
          `N.showNotice(tab, "zenius-joined", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").joinedCard("Trip planner"));`,
          "zenius-joined",
          `N.removeNotice(tab, "zenius-joined");`,
        ],
        // zen-core's claim gate: an agent asks to work in the user's Space.
        claim: [
          `N.showNotice(tab, "zenius-claim:look", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").claimCard("Trip planner", "Work", Date.now() + 600000));`,
          "zenius-claim:look",
          `N.removeNotice(tab, "zenius-claim:look");`,
        ],
        // zen-observe refused a load the user started to the local network:
        // an address they typed (with Add to allowlist), and one the page chose.
        localTyped: [
          `N.showNotice(tab, "zenius-localnet", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").localNetCard({ host: "192.168.1.10", typed: true }, { allow: () => {} }));`,
          "zenius-localnet",
          `N.removeNotice(tab, "zenius-localnet");`,
        ],
        // The same, its line opened by the '?'.
        localTypedOpen: [
          `N.showNotice(tab, "zenius-localnet", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").localNetCard({ host: "192.168.1.10", typed: true }, { allow: () => {} }));
           await until(() => N.noticeElement(tab, "zenius-localnet")?.hasAttribute("has-more"));
           N.noticeElement(tab, "zenius-localnet").querySelector(".zenius-card-more").click();`,
          "zenius-localnet",
          `N.removeNotice(tab, "zenius-localnet");`,
        ],
        localChosen: [
          `N.showNotice(tab, "zenius-localnet", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").localNetCard({ host: "printer.local", typed: false }));`,
          "zenius-localnet",
          `N.removeNotice(tab, "zenius-localnet");`,
        ],
        // A kept page the agent made (it keeps its card, whose form waits
        // on the user's answer): the reminder as the user
        // is about to type, and a refusal of what they just did there.
        madeReminder: [
          `N.showNotice(tab, "zenius-kept-code", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").madePageCard());`,
          "zenius-kept-code",
          `N.removeNotice(tab, "zenius-kept-code");`,
        ],
        madeRefused: [
          `N.showNotice(tab, "zenius-kept-code", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").madePageCard({ refused: "camera" }));`,
          "zenius-kept-code",
          `N.removeNotice(tab, "zenius-kept-code");`,
        ],
        // The quiet reload before the user's input in a written page didn't come.
        reloadFailed: [
          `N.showNotice(tab, "zenius-typing-off", ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").reloadFailedCard());`,
          "zenius-typing-off",
          `N.removeNotice(tab, "zenius-typing-off");`,
        ],
      };
      {
        const [show, , clear] = states.clicked;
        await run(`
          ${show}
          await sleep(400);
        `);
        await shot(`pill-bottom-${theme}`);
        await run(clear);
      }
      // The close-ups sit on an empty page in the theme's usual page color, so
      // the fixture's boxes don't show at their edges.
      await h.call("dev.evalContent", {
        space,
        page: "p1",
        code: `document.body.replaceChildren(); document.documentElement.style.background = "${theme === "dark" ? "#1c1c1e" : "#ffffff"}"; return true;`,
      });
      const sheet = join(OUT, `pills-${theme}.png`);
      // Chrome code can't eval, so each state's steps are spliced in here.
      const tileSteps = Object.entries(states)
        .map(([name, [show, value, clear]]) => `
          ${show}
          await sleep(400); // past the entrance
          {
            const el = N.noticeElement(tab, ${JSON.stringify(value)});
            if (!el) throw new Error("no pill for ${name}");
            // The pill with some of the page around it, inside the content area.
            const r = el.getBoundingClientRect();
            const b = browser.getBoundingClientRect();
            const x = Math.max(b.left, r.left - 18);
            const y = Math.max(b.top, r.top - 18);
            const right = Math.min(b.right, r.right + 18);
            const bottom = Math.min(b.bottom, r.bottom + 14);
            tiles.push(await win.browsingContext.currentWindowGlobal.drawSnapshot(
              new win.DOMRect(x, y, right - x, bottom - y), 2, "white"));
          }
          ${clear}
          await sleep(100);
        `)
        .join("\n");
      const tiles = await run(`
        ${N}
        const tiles = [];
        ${tileSteps}
        const gap = 24;
        const c = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        c.width = Math.max(...tiles.map(t => t.width)) + 2 * gap;
        c.height = tiles.reduce((h, t) => h + t.height + gap, gap);
        const g = c.getContext("2d");
        g.fillStyle = ${theme === "dark" ? '"#161618"' : '"#f2f2f4"'};
        g.fillRect(0, 0, c.width, c.height);
        let y = gap;
        for (const t of tiles) {
          g.drawImage(t, (c.width - t.width) / 2, y);
          y += t.height + gap;
        }
        const blob = await new Promise(r => c.toBlob(r, "image/png"));
        await IOUtils.write(${JSON.stringify(sheet)}, new Uint8Array(await blob.arrayBuffer()));
        return tiles.length;
      `);
      assert.equal(tiles, Object.keys(states).length);
      assert.ok(statSync(sheet).size > 10_000);
      await run(`C.hideCursor(tab); ctx.spaces.setStateText(rec, ""); await showSpace(userWs);`);
      await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
      console.log(`# pills (${theme}): pill-bottom-${theme}.png, pills-${theme}.png in ${OUT}`);
  }));
}

// The muted badge (zen-observe's mute, ui/muted.sys.mjs): the agent's tab in
// the sidebar, cropped at 2x, in light and dark.
for (const theme of ["light", "dark"]) {
  test(`${theme}: the muted badge on an agent tab, for review`, () =>
    inTheme(theme, async () => {
      const path = join(OUT, `muted-badge-${theme}.png`);
      await h.chrome(`${P}
        await showSpace(rec.uuid, tab);
        // zen-observe clears the attribute once the user sees the tab: set it after.
        tab.setAttribute("zenius-muted-sound", "");
        await sleep(300);
        try {
          const r = tab.getBoundingClientRect();
          const pad = 6;
          const rect = new win.DOMRect(Math.max(0, r.x - pad), Math.max(0, r.y - pad), r.width + 2 * pad, r.height + 2 * pad);
          const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(rect, 2, ${JSON.stringify(backdrop)});
          const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          c.width = bitmap.width;
          c.height = bitmap.height;
          c.getContext("2d").drawImage(bitmap, 0, 0);
          const blob = await new Promise(res => c.toBlob(res, "image/png"));
          await IOUtils.write(${JSON.stringify(path)}, new Uint8Array(await blob.arrayBuffer()));
        } finally {
          tab.removeAttribute("zenius-muted-sound");
          await showSpace(userWs);
        }
      `);
      assert.ok(statSync(path).size > 1000, `${path} looks empty`);
      console.log(`# muted badge (${theme}): ${path}`);
  }));
}

// The task tag (ui/tasktags.sys.mjs): the agent's tab row with its tag,
// working and needing the user, at 2x, in light and dark. zen-core sets
// zenius-task on task pages; here the test sets it.
for (const theme of ["light", "dark"]) {
  test(`${theme}: the task tag on an agent tab, for review`, () =>
    inTheme(theme, async () => {
      const paths = ["working", "needs-user"].map(state => join(OUT, `tag-${state}-${theme}.png`));
      await h.chrome(`${P}
        // Still frames: the needs-user tag pulses.
        Services.prefs.setIntPref("ui.prefersReducedMotion", 1);
        tab.setAttribute("zenius-task", String(rec.id));
        await showSpace(rec.uuid, tab);
        const shoot = async path => {
          await sleep(300);
          const r = tab.getBoundingClientRect();
          const pad = 6;
          const rect = new win.DOMRect(Math.max(0, r.x - pad), Math.max(0, r.y - pad), r.width + 2 * pad, r.height + 2 * pad);
          const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(rect, 2, ${JSON.stringify(backdrop)});
          const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          c.width = bitmap.width;
          c.height = bitmap.height;
          c.getContext("2d").drawImage(bitmap, 0, 0);
          const blob = await new Promise(res => c.toBlob(res, "image/png"));
          await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
        };
        try {
          // Working: the agent acts (its activity keeps the state a moment).
          await C.moveCursor(tab, { x: 40, y: 40 }, { label: "Click Search", kind: "click" });
          await shoot(${JSON.stringify(paths[0])});
          ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
          await shoot(${JSON.stringify(paths[1])});
        } finally {
          if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
          tab.removeAttribute("zenius-task");
          Services.prefs.clearUserPref("ui.prefersReducedMotion");
          C.hideCursor(tab);
          await showSpace(userWs);
        }
      `);
      for (const path of paths) {
        assert.ok(statSync(path).size > 1000, `${path} looks empty`);
        console.log(`# task tag (${theme}): ${path}`);
      }
  }));
}

// The problem report card (zenius feedback), as the user first sees it: with
// gh (Send) and without (Copy and open GitHub). The runtime's side is a
// stand-in that only has the report waiting. Nothing is pressed: on the Mac,
// Send and Copy belong to the user. The report's text comes from the
// runtime's own builder, as feedback.compose makes it, with an agent's calls
// in place of this test's.
const SAMPLE_FACTS = {
  ...clientFacts({
    line: "page.click on the sign-up form's Submit button failed twice with the same error",
    cli: { version: "0.1.4", protocol: 1, commit: null, sandboxed: false },
    node: "v24.11.0",
    doctor: ["cli", "zen", "autoconfig", "profile", "loader", "runtime", "instance", "sidebar", "mcp", "daily", "boundary", "dns", "pagecode"].map(id => ({ id, status: "ok" })),
  }),
  runtime: { version: "0.1.4", commit: null },
  zen: "1.24.2b",
  os: "Darwin 24.6.0, aarch64",
  defaultInstance: true,
  calls: [
    { method: "spaces.create", ms: 212, code: "ok" },
    { method: "page.goto", ms: 431, code: "ok" },
    { method: "page.snapshot", ms: 58, code: "ok" },
    { method: "page.fill", ms: 96, code: "ok" },
    { method: "page.click", ms: 812, code: "ZEN_INTERNAL" },
    { method: "page.snapshot", ms: 61, code: "ok" },
    { method: "page.click", ms: 798, code: "ZEN_INTERNAL" },
  ],
  lastFailure: { method: "page.click", ms: 798, code: "ZEN_INTERNAL", ago: 4 },
};
const SAMPLE_REPORT = { title: reportTitle(SAMPLE_FACTS), body: reportBody(SAMPLE_FACTS), repo: REPO };

for (const theme of ["light", "dark"]) {
  test(`${theme}: the problem report card in the agent sidebar, for review (it presses nothing)`, () =>
    inTheme(theme, async () => {
      const paths = [];
      for (const canPost of [true, false]) {
        const ok = await h.call("dev.evalChrome", {
          code: `
          const svc = win.ucAgentSidebar.AgentService.zenius();
          const until = async (fn, ms = 10000) => {
            const end = Date.now() + ms;
            while (!fn()) {
              if (Date.now() > end) return false;
              await new Promise(r => win.setTimeout(r, 25));
            }
            return true;
          };
          arg.wasOpen = win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar";
          const old = Object.getOwnPropertyDescriptor(svc, "feedback");
          const report = arg.report;
          Object.defineProperty(svc, "feedback", { value: { pending: () => report, old, wasOpen: arg.wasOpen }, configurable: true, writable: true });
          Services.obs.notifyObservers(null, "zenius-feedback", "asked");
          if (!arg.wasOpen) await win.SidebarController.show("viewAgentSidebar");
          const card = () => win.document.getElementById("sidebar")?.contentDocument?.getElementById("feedback");
          // Armed, as the user would find it.
          return await until(() => card() && !card().hidden && [...card().querySelectorAll("button")].every(b => !b.disabled));
        `,
          arg: { report: { ...SAMPLE_REPORT, id: `look-${theme}-${canPost}`, canPost } },
        });
        assert.ok(ok, "the card showed");
        paths.push(await shot(`fb-${canPost ? "send" : "copy"}-${theme}`));
        if (theme === "light") {
          // At the sidebar's narrowest, as tests/mac/look.test.mjs narrows it:
          // the words and buttons wrap, and nothing runs past the card.
          const narrow = await h.chrome(`
            const sidebar = win.document.getElementById("sidebar-box") ?? win.document.getElementById("sidebar");
            const min = parseFloat(win.getComputedStyle(sidebar).minWidth) || 0;
            sidebar.dataset.lookWas = sidebar.style.width;
            sidebar.style.width = (min >= 120 ? min : 200) + "px";
            await new Promise(r => win.setTimeout(r, 500));
            const card = win.document.getElementById("sidebar").contentDocument.getElementById("feedback");
            const box = card.getBoundingClientRect();
            const past = [...card.querySelectorAll("button, input, textarea, .fb-lead")].filter(el => el.getBoundingClientRect().right > box.right + 0.5).map(el => el.id || el.textContent);
            const t = card.querySelector("#fb-issue-title");
            return { width: Math.round(sidebar.getBoundingClientRect().width), past, titleCut: t.scrollHeight > t.clientHeight + 1 || t.scrollWidth > t.clientWidth + 1 };
          `);
          assert.deepEqual(narrow.past, [], `at ${narrow.width} px, past the card's edge`);
          assert.equal(narrow.titleCut, false, `at ${narrow.width} px, the title box hid part of the title`);
          paths.push(await shot(`fb-${canPost ? "send" : "copy"}-narrowest-${theme}`));
          await h.chrome(`
            const sidebar = win.document.getElementById("sidebar-box") ?? win.document.getElementById("sidebar");
            sidebar.style.width = sidebar.dataset.lookWas ?? "";
            delete sidebar.dataset.lookWas;
            await new Promise(r => win.setTimeout(r, 300));
            return true;
          `);
        }
        await h.chrome(`
          const svc = win.ucAgentSidebar.AgentService.zenius();
          const stand = svc.feedback;
          if (stand.old) Object.defineProperty(svc, "feedback", stand.old);
          else delete svc.feedback;
          Services.obs.notifyObservers(null, "zenius-feedback", "settled");
          if (!stand.wasOpen) win.SidebarController.hide();
          return true;
        `);
      }
      for (const path of paths) {
        console.log(`# problem report card (${theme}): ${path}`);
      }
    }));
}

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
