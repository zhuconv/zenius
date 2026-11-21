// Does an agent's mouse input commit the user's IME composition in another tab
// of the same content process, and what can zenius see before it presses?
// Findings: docs/research/ime-commit.md.
//
// The user's tab and an agent's task page are both on the lab page of
// tests/snapshot/tools/owntab-site.mjs (zen-snapshot's kit), in one process.
// The user composes in their field through a text input processor on the
// chrome window. Its callback logs what the parent's IME is asked
// ("request-to-commit") and leaves the composition open, so the page's own
// compositionend shows that content committed it. Each variant is one kind of
// agent input; after each, the probe reads both pages' events and the IME's
// state, then sets the composition up again.
//
//   echo 'user_pref("dom.ipc.processCount.webIsolated", 1);' > one-process.js
//   ZENIUS_DEV_PREFS=$PWD/one-process.js scripts/zen-dev.sh <name> restart
//   ZENIUS_INSTANCE=<name> node tests/core/tools/ime-commit-probe.mjs
//
// For where Gecko commits, add MOZ_LOG=IMEStateManager:5 and a MOZ_LOG_FILE to
// that restart: the content process's file shows OnMouseButtonEventInEditor,
// then NotifyIME(REQUEST_TO_COMMIT_COMPOSITION).
//
// Dev profiles only. It closes the user's tab it opened and finishes its task.
import { openKit } from "../../snapshot/tools/owntab-kit.mjs";

const kit = await openKit();
const { call, chrome, A, newTask, cleanUp } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** Chrome-side helpers: the user's tab, mouse and IME, the agent's raw input, each page's log. */
const LAB = `
  const userTab = () => win.__imeUserTab;
  const agentTab = id => ctx.resolvePage({ space: id, page: "p1" }).tab;
  const pidOf = t => t.linkedBrowser.browsingContext.currentWindowGlobal?.osPid ?? null;
  const userMouse = (type, x, y, o = {}) => {
    const r = userTab().linkedBrowser.getBoundingClientRect();
    return win.synthesizeMouseEvent(type, r.left + x, r.top + y,
      { identifier: 0, button: 0, buttons: o.buttons ?? 0, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
  };
  const userClick = async (x, y) => {
    userMouse("mousemove", x, y); await sleep(30);
    userMouse("mousedown", x, y, { buttons: 1 }); await sleep(40);
    userMouse("mouseup", x, y); await sleep(60);
  };
  // One processor and one callback for the whole run: a second callback
  // can't begin a transaction on the same processor.
  const userTip = () => {
    const tip = (win.__imeTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
    const cb = (win.__imeTipCb ??= { onNotify(t, n) { win.__imeNotes.push(n.type); return true; } });
    if (!tip.beginInputTransactionForTests(win, cb)) throw new Error("no IME transaction on the chrome window");
    return tip;
  };
  const compose = async () => {
    const tip = userTip();
    if (!tip.hasComposition) {
      tip.setPendingCompositionString("\\u306b");
      tip.appendClauseToPendingComposition(1, tip.ATTR_RAW_CLAUSE);
      tip.flushPendingComposition();
      await sleep(100);
    }
  };
  const logOf = t => inContent(t, "return __log.splice(0, __log.length)");
  const brief = log => log.filter(e => !/move|over|out|enter|leave/.test(e.type))
    .map(e => e.type + (e.data ? ' "' + e.data + '"' : "") + "@" + e.target + (e.trusted ? "" : " untrusted"));
  // Mouse input in the agent's content, flagged as zenius's is (content/input.sys.mjs).
  const raw = (t, type, x, y, o = {}) => inContent(t, \`
    const u = window.windowUtils;
    return window.synthesizeMouseEvent(\${JSON.stringify(type)}, \${x}, \${y},
      { identifier: u.DEFAULT_MOUSE_POINTER_ID, button: \${o.button ?? 0}, buttons: \${o.buttons ?? 0}, clickCount: 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: \${o.domSynth ?? true}, isWidgetEventSynthesized: false, isAsyncEnabled: false });\`, true);
`;
const lab = (code, arg) => chrome(LAB + code, arg);

const PAD = [100, 140];
const variants = [
  ["nothing (control)", `return null;`],
  ["raw mousemove", `await raw(agentTab(arg), "mousemove", ${PAD}); return null;`],
  // page.mouse down presses where the mouse is, as Playwright's does.
  ["zenius page.mouse move and down", () =>
    call("page.mouse", { space: S, page: "p1", action: "move", x: PAD[0], y: PAD[1] }).then(() =>
      call("page.mouse", { space: S, page: "p1", action: "down" })
    )],
  ["zenius page.mouse up", () => call("page.mouse", { space: S, page: "p1", action: "up" })],
  ["raw mousedown", `await raw(agentTab(arg), "mousedown", ${PAD}, { buttons: 1 }); return null;`],
  ["raw mouseup", `await raw(agentTab(arg), "mouseup", ${PAD}); return null;`],
  ["raw right button down and up", `await raw(agentTab(arg), "mousedown", ${PAD}, { button: 2, buttons: 2 }); await raw(agentTab(arg), "mouseup", ${PAD}, { button: 2 }); return null;`],
  ["raw mousedown the page cancels", `
    await inContent(agentTab(arg), "window.__no = e => e.preventDefault(); addEventListener('mousedown', window.__no, true); return 1;");
    await raw(agentTab(arg), "mousedown", ${PAD}, { buttons: 1 }); await raw(agentTab(arg), "mouseup", ${PAD});
    await inContent(agentTab(arg), "removeEventListener('mousedown', window.__no, true); return 1;");
    return null;`],
  ["raw down and up outside the viewport", `await raw(agentTab(arg), "mousedown", -50, -50, { buttons: 1 }); await raw(agentTab(arg), "mouseup", -50, -50); return null;`],
  ["raw down and up, isDOMEventSynthesized false", `await raw(agentTab(arg), "mousedown", ${PAD}, { buttons: 1, domSynth: false }); await raw(agentTab(arg), "mouseup", ${PAD}, { domSynth: false }); return null;`],
  ["zenius page.click", () => call("page.click", { space: S, page: "p1", target: "#pad", options: {} })],
];

let S = null;
await chrome(`try { if (win.__imeTip?.hasComposition) win.__imeTip.cancelComposition(); } catch {} win.__imeNotes = []; return true;`);
try {
  S = await newTask("ime commit probe", `${A.base}/lab`);
  const pids = await lab(
    `const a = agentTab(arg); await until(() => loaded(a), 10000);
     const agents = ctx.spaces.agentsSpace.uuid;
     const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
     if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
     const url = arg2;
     const t = gBrowser.addTrustedTab(url, { inBackground: false });
     gBrowser.selectedTab = t;
     await until(() => t.linkedBrowser.currentURI.spec === url && loaded(t), 10000);
     win.__imeUserTab = t;
     win.focus(); t.linkedBrowser.focus(); await sleep(300);
     await userClick(100, 312); await sleep(100);
     return { agent: pidOf(a), user: pidOf(t) };`.replace("arg2", JSON.stringify(`${A.base}/lab`)),
    S
  );
  step("pids", JSON.stringify(pids), pids.agent === pids.user ? "one process" : "two processes: set the pref (see the header)");

  // What zenius's code in the agent's process can see while the user composes.
  await lab(`await compose(); return true;`);
  step(
    "seen from the agent's process",
    JSON.stringify(
      await lab(
        `return inContent(agentTab(arg), \`
           const el = Services.focus.focusedElement;
           return { focused: el ? el.localName + "#" + el.id : null, inThisTab: el?.ownerDocument === document,
                    composing: el?.editor?.composing ?? null };\`, true);`,
        S
      )
    )
  );

  for (const [name, act] of variants) {
    await lab(`await compose(); win.__imeNotes.length = 0; await logOf(userTab()); await logOf(agentTab(arg)); return true;`, S);
    const result = typeof act === "function" ? await act().then(() => "ok", e => `${e.code}: ${e.message}`.slice(0, 120)) : await lab(act, S);
    const r = await lab(
      `await sleep(250);
       const tip = userTip();
       const r = { result: arg.result, imeAsked: win.__imeNotes.splice(0), userPage: brief(await logOf(userTab())),
                   agentPage: brief(await logOf(agentTab(arg.s))), userHasFocus: await inContent(userTab(), "return document.hasFocus()") };
       if (tip.hasComposition) tip.commitComposition();
       await sleep(50);
       if ((await inContent(userTab(), "return __state().active")) !== "field") { await userClick(100, 312); await sleep(100); }
       await logOf(userTab());
       return r;`,
      { s: S, result }
    );
    r.committed = r.userPage.some(e => e.startsWith("compositionend"));
    step(name, JSON.stringify(r));
  }
} finally {
  await lab(`const t = userTab(); if (t?.isConnected) gBrowser.removeTab(t, { animate: false }); delete win.__imeUserTab; return true;`).catch(() => {});
  if (S) {
    await cleanUp([S]).catch(() => {});
  }
  kit.close?.();
}
