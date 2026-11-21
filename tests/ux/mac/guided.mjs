// Guided check with real input (UX checklist G1–G10 in docs/ux/checklist.md):
// a person at the Mac clicks, types and swipes in a visible dev Zen, and this
// script watches what zenius does. Real OS input is the one thing the
// headless suite can't produce.
//
//   node tests/ux/mac/guided.mjs [--instance uxguided] [--notification]
//
// It starts a visible dev Zen (instance "uxguided" by default) and closes it
// on every way out: at the end, after an error, on Ctrl+C, and after 25 min
// at most, so a stuck run can't hold a window open on the user's Mac.
// --notification adds the opt-in macOS notification for handOff (G9).
// --keep leaves the Space and the window as they are when a step failed, for
// inspection; the next run removes the Space. --attach uses an instance that
// is already running and leaves it running (a headless stand-in on Linux).
// Each step waits up to 90 s. A failed step prints what zenius and Firefox
// saw. The exit code is the number of steps that failed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prelude, setup } from "../lib.mjs";

const NAME = "zen-ux guided check";
const { values: args } = parseArgs({
  options: {
    instance: { type: "string" },
    notification: { type: "boolean" },
    keep: { type: "boolean" },
    attach: { type: "boolean" },
  },
});
const INSTANCE = args.instance ?? process.env.ZENIUS_INSTANCE ?? "uxguided";
process.env.ZENIUS_INSTANCE = INSTANCE;
// ZENIUS_UX_STEP_MS shortens the wait, for checking this script itself.
const STEP_MS = Number(process.env.ZENIUS_UX_STEP_MS) || 90_000;
// Every step's wait, plus a margin.
const TOTAL_MS = STEP_MS * 14 + 120_000;
const DEV = fileURLToPath(new URL("../../../scripts/zen-dev.sh", import.meta.url));

// Closing the dev Zen closes its window. The "exit" event comes on every way
// out, also after an uncaught error; signals and the time limit go through
// process.exit().
let leaveRunning = !!args.attach;
process.on("exit", () => {
  if (!leaveRunning) {
    spawnSync(DEV, [INSTANCE, "stop"], { stdio: "ignore" });
  }
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: closing the dev Zen.`);
    process.exit(130);
  });
}
setTimeout(() => {
  console.log(`\nThe check ran over ${Math.round(TOTAL_MS / 60_000)} min; closing the dev Zen.`);
  process.exit(1);
}, TOTAL_MS).unref();
if (!args.attach) {
  const started = spawnSync(DEV, [INSTANCE, "start", "--headed"], { stdio: "inherit" });
  if (started.status !== 0) {
    process.exit(1);
  }
}
const h = await setup();
const results = [];
// The Space of an earlier run: kept with --keep, or left by a run that was
// stopped. After a restart it's a plain workspace, no longer an agent task.
// The window may still show it.
await h.chrome(`
  const name = ${JSON.stringify(NAME)};
  const left = gZenWorkspaces.getWorkspaces().filter(ws => ws.name === name);
  if (left.some(ws => ws.uuid === gZenWorkspaces.activeWorkspace)) {
    const other = gZenWorkspaces.getWorkspaces().find(ws => ws.name !== name);
    if (other) await gZenWorkspaces.changeWorkspaceWithID(other.uuid);
  }
  for (const ws of left) {
    if (ws.uuid !== gZenWorkspaces.activeWorkspace) await gZenWorkspaces.removeWorkspace(ws.uuid);
  }
`);
const { id: space } = await h.createSpace({ name: NAME });
await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
const P = `${prelude(space)}
  const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
`;
const state = () => h.call("ui.state", { space });
/** The agent's cursor is on the page, with its label showing. */
const cursorShown = () =>
  chrome(`
    const c = C.cursorState(tab);
    return !!c && c.inDom && !c.hidden && !c.idle && c.label === "Waiting for you";
  `);
const chrome = code => h.chrome(`${P}${code}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Print the instruction, then wait until `done(state)` holds. */
async function step(id, instruction, done, { ms = STEP_MS } = {}) {
  console.log(`\n${id}. ${instruction}`);
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await state();
    const extra = await done(s);
    if (extra) {
      console.log(`   PASS`);
      results.push({ id, ok: true });
      return true;
    }
    await sleep(200);
  }
  console.log(`   FAIL: timed out. Last state: ${JSON.stringify(s)}`);
  await diagnose();
  results.push({ id, ok: false });
  return false;
}

/** What zenius and Firefox saw, for a failed step. */
async function diagnose() {
  const d = await chrome(`
    const PN = win.PopupNotifications;
    const describeEl = el => el ? el.localName + (el.id ? "#" + el.id : "") : null;
    return {
      takeoverDetector: UI.takeover.stats,
      view: {
        agentSpaceShown: gZenWorkspaces.activeWorkspace === rec.uuid,
        agentPageSelected: gBrowser.selectedBrowser === browser,
        windowActive: Services.focus.activeWindow === win,
        focused: describeEl(Services.focus.focusedElement),
        urlbar: { focused: gURLBar.focused, floating: gURLBar.getAttribute("zen-floating-urlbar") },
      },
      cursor: C.cursorState(tab),
      permissionPrompts: PN.getNotificationsForBrowser(browser).map(n => ({
        id: n.id,
        dismissed: n.dismissed,
        persistent: !!n.options.persistent,
        anchor: describeEl(n.anchorElement),
        anchorVisible: n.anchorElement?.checkVisibility(PN.CHECK_VISIBILITY_OPTIONS) ?? null,
      })),
      doorhanger: {
        state: PN.panel.state,
        showing: [...PN.panel.children].map(c => c.notification?.id),
        suppressed: PN._suppress,
        wouldSuppress: PN._shouldSuppress(),
      },
      openPopups: [...win.document.querySelectorAll("panel, menupopup")].filter(p => p.state !== "closed").map(p => (p.id || p.localName) + ":" + p.state),
    };
  `).catch(e => ({ error: e.message }));
  console.log(`   Diagnostics: ${JSON.stringify(d)}`);
}

const userWs = await chrome(`return gZenWorkspaces.activeWorkspace;`);
try {
  await chrome(`
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs").landOn(tab);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await sleep(400);
    await C.moveCursor(tab, { x: 260, y: 160 }, { label: "Waiting for you", kind: "move" });
  `);
  console.log(`The dev Zen window shows the Space "zen-ux guided check" with the agent's
cursor ("Waiting for you"). Bring that window to the front, then follow each step.`);

  await step("G1", "Click anywhere in the page (not the sidebar). A pill should appear at the bottom center: \"Agent paused · it resumes in 10 s\", counting down.",
    s => s.prompt && s.paused);
  await step("G2", "Click \"Resume agent\" on that pill.",
    s => !s.prompt && !s.paused && s.ownership === "agent");
  await sleep(3200); // the grace period after "Resume agent"
  await step("G3", "Click the \"Text input\" field and type one letter. The pill should now say \"You're taking over · in … s\".",
    s => s.prompt?.typed);
  await step("G4", "Now leave the window alone for 10 s. You should keep control: \"You're in control\", and the agent's cursor disappears.",
    s => s.ownership === "agentDelegatedToUser" && s.reason === "manual_takeover" && s.badge?.state === "user", { ms: 20_000 });
  // The user once had to click Hand back (now Resume agent) twice: Firefox's notification bar
  // swallowed the click that brought the window forward. G5b measures that
  // first click on the pill.
  await chrome(`
    const ac = new win.AbortController();
    const probe = (win.__zeniusFirstClick = { wasInactive: Services.focus.activeWindow !== win, activatedAt: 0, downs: [], stop: () => ac.abort() });
    win.addEventListener("deactivate", () => { probe.wasInactive = true; }, { signal: ac.signal });
    win.addEventListener("activate", () => { probe.activatedAt = Date.now(); }, { signal: ac.signal });
    win.addEventListener("pointerdown", e => {
      if (e.target.closest?.(".zenius-card")) {
        probe.downs.push({ active: Services.focus.activeWindow === win, sinceActivate: probe.activatedAt ? Date.now() - probe.activatedAt : null });
      }
    }, { signal: ac.signal, capture: true });
  `);
  await step("G5", "Click \"Resume agent\" once, straight from this terminal: don't click elsewhere in the dev window first. The agent's cursor should come back, with \"Waiting for you\".",
    async s => s.ownership === "agent" && !s.controlNotice && (await cursorShown()));
  {
    const p = await chrome(`
      const p = win.__zeniusFirstClick;
      p.stop();
      delete win.__zeniusFirstClick;
      return { wasInactive: p.wasInactive, downs: p.downs };
    `);
    const first = p.downs[0];
    if (!p.wasInactive || !first) {
      console.log(`   G5b SKIP: ${!first ? "no click on the pill was seen" : "the dev window was already in front"}, so the first click on a background window wasn't tried.`);
    } else {
      // The click that activates the window reaches the pill either before the
      // window counts as active or within moments of it.
      const ok = !first.active || (first.sinceActivate !== null && first.sinceActivate <= 300);
      console.log(ok
        ? `   G5b PASS: the click that brought the window forward acted (${p.downs.length} click${p.downs.length === 1 ? "" : "s"} on the pill).`
        : `   G5b FAIL: the window came forward ${first.sinceActivate} ms before the first click on the pill, so the click that brought it forward didn't reach the pill.`);
      results.push({ id: "G5b", ok });
    }
  }
  await sleep(3200);
  await chrome(`UI.takeover.stats = { seen: 0, counted: 0, skipped: {}, last: null };`);
  console.log(`\nG6. First click an empty part of the dev window's sidebar, so that window is the active one. Then press Cmd+L (the address bar), then Escape. Browser shortcuts must not count as using the page.`);
  {
    const sawUrlbar = await chrome(`
      const end = Date.now() + ${STEP_MS};
      // Keys go to the active window only; the daily Zen looks the same.
      while (Date.now() < end && Services.focus.activeWindow !== win) await sleep(100);
      while (Date.now() < end && !gURLBar.focused) await sleep(100);
      if (!gURLBar.focused) return false;
      while (Date.now() < end && gURLBar.focused) await sleep(100);
      await sleep(500);
      return true;
    `);
    const s = await state();
    const ok = sawUrlbar && !s.prompt && s.ownership === "agent";
    console.log(ok ? "   PASS" : `   FAIL: urlbar used ${sawUrlbar}, state ${JSON.stringify(s)}`);
    if (!ok) await diagnose();
    results.push({ id: "G6", ok });
  }
  console.log(`\nG7. Swipe to another Space with the trackpad (or Ctrl+→), then come back here. The cursor should still be there, with "Waiting for you".`);
  {
    const ok = await chrome(`
      const end = Date.now() + ${STEP_MS};
      while (Date.now() < end && gZenWorkspaces.activeWorkspace === rec.uuid) await sleep(100);
      while (Date.now() < end && gZenWorkspaces.activeWorkspace !== rec.uuid) await sleep(100);
      await sleep(600);
      const c = C.cursorState(tab);
      return !!c && !!c.rendered && c.inDom && !c.hidden && !c.idle && c.label === "Waiting for you";
    `);
    console.log(ok ? "   PASS" : "   FAIL: the cursor or its label isn't shown after coming back");
    if (!ok) await diagnose();
    results.push({ id: "G7", ok });
  }
  await step("G8a", "Click the strip at the bottom of the sidebar (\"1 agent working\" or similar), then \"Pause\" in the panel.",
    s => s.pausedByUser && s.badge?.state === "paused");
  await step("G8b", "Open the panel again and click \"Resume\".", s => !s.pausedByUser && !s.paused);
  // A permission prompt while the user is elsewhere, in Firefox's own
  // doorhanger: a storage access prompt, one of the two kinds a task's pages
  // may still hand to the user (the manager, 2026-11-20). A cross-site
  // sign-in frame raises it for real; here chrome raises it, as PermissionUI
  // does, so no frame or cookie is involved.
  await chrome(`
    await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userWs)});
    await sleep(400);
    win.PopupNotifications.show(browser, "storage-access", "Allow the sign-in frame to use its cookies here?", "storage-access-notification-icon",
      { label: "Allow", accessKey: "A", callback() {} }, [{ label: "Block", accessKey: "B", callback() {} }], {});
  `);
  await step("G10a", "The sidebar strip should now say \"An agent needs you\". Open the panel and click \"Open\" on \"zen-ux guided check\". The browser's prompt asks to let a sign-in frame use its cookies, and the card says why the agent stopped.",
    s => s.ownership === "agentDelegatedToUser" && s.reason === "storage_access" && /asks for storage access/.test(s.controlNotice ?? ""));
  await step("G10b", "Click \"Block\" in the browser's prompt (not Allow). Control goes back to the agent.",
    s => s.ownership === "agent" && !s.controlNotice);
  if (args.notification) {
    await chrome(`
      Services.prefs.setBoolPref("zenius.ux.handoff.systemNotification", true);
      await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userWs)});
      await sleep(400);
      ctx.spaces.setStateText(rec, "Log in to continue");
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
    `);
    console.log(`\nG9. A macOS notification "An agent needs you: zen-ux guided check" should appear. Click it: the dev window should open the agent's Space.`);
    const ok = await chrome(`
      const end = Date.now() + ${STEP_MS};
      while (Date.now() < end && gZenWorkspaces.activeWorkspace !== rec.uuid) await sleep(100);
      return gZenWorkspaces.activeWorkspace === rec.uuid;
    `);
    console.log(ok ? "   PASS" : "   FAIL: the Space didn't open");
    if (!ok) await diagnose();
    results.push({ id: "G9", ok });
  }
} finally {
  const keep = args.keep && results.some(r => !r.ok);
  await chrome(`
    Services.prefs.clearUserPref("zenius.ux.handoff.systemNotification");
    if (!${keep}) {
      UI.takeover.reset();
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      if (UI.describe(rec).pausedByUser) UI.resumeByUser(rec);
      C.hideCursor(tab);
      await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userWs)});
    }
  `).catch(e => console.error("cleanup failed:", e.message));
  await h.close({ keep: keep ? [space] : [] });
  if (keep) {
    leaveRunning = true;
    console.log(`\nKept Space ${space} ("${NAME}") as it was, and the dev Zen open. Inspect it with
  node scripts/zen-rpc.mjs -i ${INSTANCE} -c ui.state '{"space":${space}}'
and dev.evalChrome. Close it with scripts/zen-dev.sh ${INSTANCE} stop. The next run of this script removes the Space.`);
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? `; failed: ${failed.map(r => r.id).join(", ")}` : ""}.`);
process.exit(failed.length);
