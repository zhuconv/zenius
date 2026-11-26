// Per-process input state between tabs.
//
// Gecko keeps some input state once per content process, not per tab:
// - mouse capture;
// - pointer capture and the active pointers;
// - the element held :active;
// - the last pointer position, from which movementX/Y is computed;
// - the wheel transaction, which the input layer's tests found.
// Can zenius's input in one tab change how another tab of the same process
// handles input, or reach it?
//
// Each probe puts tabs of one site in one process, either an agent's tab and
// a tab of the user's, or two tasks' tabs. One side sends input:
// - an agent, through zenius;
// - the user, through the parent, as a real mouse or keyboard does: an event
//   at the chrome window, which Gecko hit-tests and sends to the tab's
//   process (BrowserParent's SendRealMouseEvent), or keys from a text input
//   processor on the chrome window.
// The probe then reads what each page saw, from the lab page's log (/lab on
// owntab-site.mjs), through dev#evalContent, which records no agent code.
//
// Same-site tabs share a process once the site has more tabs than
// dom.ipc.processCount.webIsolated (4 by default). These probes force one
// process per site:
//
//   echo 'user_pref("dom.ipc.processCount.webIsolated", 1);' > one-process.js
//   ZENIUS_DEV_PREFS=$PWD/one-process.js scripts/zen-dev.sh zen-snapshot restart
//   node tests/snapshot/tools/process-input-probe.mjs env heldPress userHolds \
//     pointerSteal heldCapture activeState movement focusKeys ime clickCount \
//     drag selectionClipboard tasks
//
// Dev profiles only. Each probe closes the user's tab it opened and finishes
// its tasks.
import { openKit, runProbes } from "./owntab-kit.mjs";

const kit = await openKit();
const { call, chrome, ev, A, B, sleep, newTask, cleanUp } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** Chrome helpers: the user's tab and its input, and each page's log. */
const LAB = `
  const userTab = () => win.__userTab;
  const agentTab = id => ctx.resolvePage({ space: id, page: "p1" }).tab;
  const pidOf = t => t.linkedBrowser.browsingContext.currentWindowGlobal?.osPid ?? null;
  const userMouse = (type, x, y, o = {}) => {
    const r = userTab().linkedBrowser.getBoundingClientRect();
    return win.synthesizeMouseEvent(
      type, r.left + x, r.top + y,
      { identifier: 0, button: o.button ?? 0, buttons: o.buttons ?? 0, clickCount: o.clickCount ?? 1, modifiers: 0, inputSource: 1 },
      { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false }
    );
  };
  const userClick = async (x, y, clickCount = 1) => {
    userMouse("mousemove", x, y);
    await sleep(30);
    userMouse("mousedown", x, y, { buttons: 1, clickCount });
    await sleep(40);
    userMouse("mouseup", x, y, { clickCount });
    await sleep(60);
  };
  const userTip = () => {
    const tip = (win.__tip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
    if (!tip.beginInputTransactionForTests(win)) throw new Error("no keyboard transaction on the chrome window");
    return tip;
  };
  const userKeys = async text => {
    const tip = userTip();
    for (const ch of text) {
      const up = ch.toUpperCase();
      const ev = new win.KeyboardEvent("", { key: ch, code: "Key" + up, keyCode: up.charCodeAt(0) });
      tip.keydown(ev);
      tip.keyup(ev);
      await sleep(15);
    }
  };
  const userWheel = async (x, y, n = 1, gapMs = 8, lines = 7) => {
    const r = userTab().linkedBrowser.getBoundingClientRect();
    const sx = Math.round((win.mozInnerScreenX + r.left + x) * win.devicePixelRatio);
    const sy = Math.round((win.mozInnerScreenY + r.top + y) * win.devicePixelRatio);
    for (let i = 0; i < n; i++) {
      win.windowUtils.sendNativeMouseScrollEvent(sx, sy, 0, 0, -lines, 0, 0, 0, null);
      await sleep(gapMs);
    }
    return Date.now();
  };
  const logOf = t => inContent(t, "return __log.splice(0, __log.length)");
  const stateOf = t => inContent(t, "return __state()");
  const both = async id => ({
    user: await logOf(userTab()),
    agent: await logOf(agentTab(id)),
    userState: await stateOf(userTab()),
    agentState: await stateOf(agentTab(id)),
  });
`;
const lab = (code, arg) => chrome(LAB + code, arg);

const MOVES = new Set(["mousemove", "pointermove", "mouseover", "mouseout"]);

/** A page's log, short: counts by type, every non-move event, and the mouse moves. */
function brief(log) {
  const counts = {};
  const events = [];
  for (const e of log ?? []) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (MOVES.has(e.type)) {
      continue;
    }
    let s = `${e.type}@${e.target}`;
    if (!e.trusted) s += " untrusted";
    if (e.x !== undefined && e.x !== null) s += ` (${e.x},${e.y})`;
    if (e.detail) s += ` d${e.detail}`;
    if (e.key) s += ` ${e.key}`;
    if (e.data) s += ` "${e.data}"`;
    events.push(s);
  }
  const moves = (log ?? [])
    .filter(e => e.type === "mousemove")
    .map(e => `(${e.x},${e.y}) m(${e.mx},${e.my})${e.trusted ? "" : " untrusted"}`);
  return { counts, events, moves };
}
const view = r => ({ user: brief(r.user), agent: brief(r.agent), userState: r.userState, agentState: r.agentState });
const outcome = p => p.then(r => r ?? {}, e => `${e.code}${e.data?.reason ? ` [${e.data.reason}]` : ""}: ${e.message}`.slice(0, 200));
const mouse = (s, action, x, y, options = {}) => call("page.mouse", { space: s, page: "p1", action, x, y, options });
const mouse2 = (s, page, action, x, y, options = {}) => call("page.mouse", { space: s, page, action, x, y, options });

/** The user's tab on `url`, selected in a Space of the user's, in the focused window. */
function openUserTab(url) {
  return lab(
    `
    const agents = ctx.spaces.agentsSpace.uuid;
    const mine = gZenWorkspaces.getWorkspaces().find(ws => ws.uuid !== agents);
    if (gZenWorkspaces.activeWorkspace !== mine.uuid) await gZenWorkspaces.changeWorkspaceWithID(mine.uuid);
    const t = gBrowser.addTrustedTab(arg, { inBackground: false });
    gBrowser.selectedTab = t;
    await until(() => t.linkedBrowser.currentURI.spec === arg && loaded(t), 10000);
    win.__userTab = t;
    win.focus();
    t.linkedBrowser.focus();
    await sleep(300);
    return { pid: pidOf(t), remoteType: t.linkedBrowser.remoteType, selected: gBrowser.selectedTab === t };
  `,
    url
  );
}

function closeUserTab() {
  return lab(`const t = userTab(); if (t?.isConnected) gBrowser.removeTab(t, { animate: false }); delete win.__userTab; return true;`);
}

function agentPage(s) {
  return lab(
    `
    const t = agentTab(arg);
    await until(() => loaded(t), 10000);
    return { pid: pidOf(t), remoteType: t.linkedBrowser.remoteType, hidden: await inContent(t, "return document.hidden") };
  `,
    s
  );
}

/** An agent's task and a user's tab, on `agentUrl` and `userUrl`, with both logs cleared. */
async function pair(name, { userUrl = `${A.base}/lab`, agentUrl = `${A.base}/lab` } = {}) {
  const s = await newTask(name, agentUrl);
  const agent = await agentPage(s);
  const user = await openUserTab(userUrl);
  await lab(`await logOf(userTab()); await logOf(agentTab(arg)); return true;`, s);
  step(name, "agent pid", agent.pid, "user pid", user.pid);
  return { s, agent, user, oneProcess: agent.pid === user.pid, pids: { agent: agent.pid, user: user.pid } };
}

async function unpair(p) {
  await closeUserTab().catch(() => {});
  if (p?.s) {
    await cleanUp([p.s]);
  }
}

/** The agent's code: try to capture pointer 0 every 3 ms, on a message loop (timers are throttled in a hidden tab). */
const STEAL = `() => {
  const pad = document.getElementById("pad");
  window.__tries = 0;
  window.__errors = {};
  window.__stop = false;
  const ch = new MessageChannel();
  let last = 0;
  ch.port1.onmessage = () => {
    if (window.__stop) return;
    const now = performance.now();
    if (now - last > 3) {
      last = now;
      window.__tries++;
      try { pad.setPointerCapture(0); } catch (e) { window.__errors[e.name] = (window.__errors[e.name] ?? 0) + 1; }
    }
    ch.port2.postMessage(0);
  };
  ch.port2.postMessage(0);
  return true;
}`;
const STOP_STEAL = "() => { window.__stop = true; return { tries: window.__tries, errors: window.__errors }; }";

/** The user's gestures for userDrag, in their page's coordinates: a press, moves with the button down, a release. */
const USER_GESTURES = {
  html5: [[440, 40], [446, 42], [470, 40], [520, 40], [560, 40]],
  selection: [[30, 230], [100, 232], [200, 232], [300, 232]],
  pad: [[100, 140], [150, 150], [200, 160], [250, 170]],
};

/** A page's presses and releases, and the rest of what it saw, for one phase. */
function presses(log) {
  const b = brief(log);
  const n = t => b.counts[t] ?? 0;
  return {
    down: n("mousedown"),
    up: n("mouseup"),
    pdown: n("pointerdown"),
    pup: n("pointerup"),
    click: n("click"),
    drag: ["dragstart", "drop", "dragend"].filter(t => n(t)).map(t => `${t}:${n(t)}`).join(" ") || null,
    events: b.events,
    moves: b.moves.length,
  };
}

const res = r => (typeof r === "string" ? r : "ok");

async function oneUserDrag(procs, agentDoes, gesture) {
  const p = await pair(`user drag ${procs} ${agentDoes} ${gesture}`, procs === "two" ? { userUrl: `${B.base}/lab` } : {});
  let held = false;
  try {
    if ((procs === "one") !== p.oneProcess) return { skipped: `not ${procs} process(es)`, pids: p.pids };
    if (agentDoes === "heldPress") {
      await mouse(p.s, "move", 30, 230);
      await mouse(p.s, "down");
      held = true;
    } else if (agentDoes === "heldDrag") {
      await mouse(p.s, "move", 440, 40);
      await mouse(p.s, "down");
      held = true;
      await mouse(p.s, "move", 500, 40);
      await mouse(p.s, "move", 560, 40);
    }
    const setup = await lab(`await sleep(150); await logOf(userTab()); return await logOf(agentTab(arg));`, p.s).catch(() => null);
    // The user's gesture, from the widget, then 0.7 s from its last move.
    const path = USER_GESTURES[gesture];
    const gestureLog = await lab(
      `
      const path = arg.path;
      userMouse("mousemove", path[0][0], path[0][1]);
      await sleep(60);
      userMouse("mousedown", path[0][0], path[0][1], { buttons: 1 });
      await sleep(60);
      for (const [x, y] of path.slice(1)) { userMouse("mousemove", x, y, { buttons: 1 }); await sleep(40); }
      const [lx, ly] = path.at(-1);
      userMouse("mouseup", lx, ly);
      const last = Date.now();
      await sleep(300);
      return { last, user: await logOf(userTab()), agent: await logOf(agentTab(arg.s)), userState: await stateOf(userTab()) };
    `,
      { path, s: p.s }
    );
    const wait = gestureLog.last + 700 - Date.now();
    if (wait > 0) await sleep(wait);
    const agentActs = {};
    const t = Date.now();
    if (held) {
      agentActs.up = res(await outcome(mouse(p.s, "up")));
      held = false;
    }
    agentActs.click = res(await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: 3000 } })));
    agentActs.ms = Date.now() - t;
    const agentPhase = await lab(`await sleep(200); return both(arg);`, p.s);
    // The user goes on: a move, a click on their button, a move.
    const after = await lab(
      `
      userMouse("mousemove", 120, 45);
      await sleep(80);
      await userClick(100, 40);
      userMouse("mousemove", 150, 150);
      await sleep(300);
      return both(arg);
    `,
      p.s
    );
    const userAll = [gestureLog.user, agentPhase.user, after.user].map(presses);
    return {
      pids: p.pids,
      agentSetup: setup && brief(setup).events,
      gesture: { user: presses(gestureLog.user), agent: presses(gestureLog.agent), userSelection: gestureLog.userState.selection },
      agentActs,
      agentPhase: { user: presses(agentPhase.user), agent: presses(agentPhase.agent), agentActive: agentPhase.agentState.active, userActive: agentPhase.userState.active },
      after: { user: presses(after.user), agent: presses(after.agent), userActive: after.userState.active, userBtnActive: after.userState.btnActive },
      userUnreleased: userAll.reduce((n, x) => n + x.down - x.up, 0),
    };
  } finally {
    if (held) await outcome(mouse(p.s, "up")).catch(() => {});
    await unpair(p);
  }
}

/**
 * The eval harness's two press-without-release sequences (Mac hands stretch):
 * - holdAfterDrop: the user's HTML5 drag, then a long selection hold with
 *   moves; the agent's click starts mid-hold (20:15:12). holdNoDrop is the
 *   same without the drag.
 * - pressWhileAgentHolds: the user's pointer already rests on their text,
 *   the agent presses and holds on its own, then the user's first event is
 *   their press (20:19:43). clickWhileAgentHolds releases with no moves.
 */
async function oneUserPress(procs, variant) {
  const p = await pair(`user press ${procs} ${variant}`, procs === "two" ? { userUrl: `${B.base}/lab` } : {});
  let held = false;
  try {
    if ((procs === "one") !== p.oneProcess) return { skipped: `not ${procs} process(es)`, pids: p.pids };
    const t0 = await lab(`return { user: await inContent(userTab(), "return window.__t0"), agent: await inContent(agentTab(arg), "return window.__t0") };`, p.s);
    const at = (log, base, type) => (log ?? []).filter(e => e.type === type).map(e => Math.round(base + e.t));
    const out = { pids: p.pids };
    let phase1;
    if (variant === "holdAfterDrop" || variant === "holdNoDrop") {
      if (variant === "holdAfterDrop") {
        await lab(
          `
          userMouse("mousemove", 440, 40); await sleep(60);
          userMouse("mousedown", 440, 40, { buttons: 1 }); await sleep(60);
          for (const [x, y] of [[446, 42], [470, 40], [520, 40], [560, 40]]) { userMouse("mousemove", x, y, { buttons: 1 }); await sleep(40); }
          userMouse("mouseup", 560, 40);
          await sleep(1000);
          return true;`
        );
      }
      // The user's hold, from a loop in the parent: 2 s of moves, 0.8 s still, then the release.
      await lab(
        `
        win.__u = {};
        win.__uhold = (async () => {
          userMouse("mousemove", 30, 230); await sleep(60);
          userMouse("mousedown", 30, 230, { buttons: 1 });
          win.__u.down = Date.now();
          let x = 30;
          while (Date.now() - win.__u.down < 2000) { x = x >= 300 ? 40 : x + 6; userMouse("mousemove", x, 232, { buttons: 1 }); await sleep(25); }
          win.__u.lastMove = Date.now();
          await sleep(800);
          userMouse("mouseup", x, 232);
          win.__u.up = Date.now();
        })();
        return true;`
      );
      await sleep(1000);
      const t = Date.now();
      out.agentClick = res(await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: 6000 } })));
      out.agentClickMs = Date.now() - t;
      phase1 = await lab(`await win.__uhold; await sleep(200); return { u: win.__u, ...(await both(arg)) };`, p.s);
      const agentDown = at(phase1.agent, t0.agent, "mousedown")[0];
      out.user = { down: phase1.u.down, lastMove: phase1.u.lastMove, up: phase1.u.up };
      out.agentPressedDuringUserHold = agentDown !== undefined ? agentDown < phase1.u.up : null;
      out.agentDownVsUserUp = agentDown !== undefined ? agentDown - phase1.u.up : null;
    } else if (variant === "agentPressesDuringUserPress") {
      // The user presses on their text and holds still; the agent's press comes meanwhile.
      await lab(`userMouse("mousemove", 30, 230); await sleep(300); userMouse("mousedown", 30, 230, { buttons: 1 }); await sleep(200); return true;`);
      out.agentMove = res(await outcome(mouse(p.s, "move", 30, 230, { timeout: 1500 })));
      out.agentDown = out.agentMove === "ok" ? res(await outcome(mouse(p.s, "down", undefined, undefined, { timeout: 1500 }))) : "not sent";
      held = out.agentDown === "ok";
      phase1 = await lab(`await sleep(200); userMouse("mouseup", 30, 230); await sleep(300); return both(arg);`, p.s);
      if (held) {
        out.agentUp = res(await outcome(mouse(p.s, "up")));
        held = false;
      }
    } else {
      await lab(`userMouse("mousemove", 30, 230); await sleep(300); await logOf(userTab()); return true;`);
      const [ax, ay] = variant === "pressWhileAgentHoldsBtn" ? [100, 40] : [30, 230];
      await mouse(p.s, "move", ax, ay);
      await mouse(p.s, "down");
      held = true;
      await sleep(300);
      phase1 = await lab(
        `
        userMouse("mousedown", 30, 230, { buttons: 1 });
        let x = 30;
        if (arg.moves) {
          for (let i = 0; i < 10; i++) { await sleep(40); x += 27; userMouse("mousemove", x, 232, { buttons: 1 }); }
        }
        await sleep(300);
        userMouse("mouseup", x, 232);
        await sleep(300);
        return both(arg.s);`,
        { s: p.s, moves: variant !== "clickWhileAgentHolds" }
      );
      out.agentUp = res(await outcome(mouse(p.s, "up")));
      held = false;
    }
    const phase2 = await lab(`await sleep(200); return both(arg);`, p.s);
    const after = await lab(
      `
      userMouse("mousemove", 120, 45);
      await sleep(80);
      await userClick(100, 40);
      userMouse("mousemove", 150, 150);
      await sleep(300);
      return both(arg);`,
      p.s
    );
    out.press = { user: presses(phase1.user), agent: presses(phase1.agent), userSelection: phase1.userState.selection };
    out.agentDone = { user: presses(phase2.user), agent: presses(phase2.agent) };
    out.after = { user: presses(after.user), agent: presses(after.agent), userActive: after.userState.active };
    out.userUnreleased = [phase1.user, phase2.user, after.user].map(presses).reduce((n, x) => n + x.down - x.up, 0);
    return out;
  } finally {
    if (held) await outcome(mouse(p.s, "up")).catch(() => {});
    await unpair(p);
  }
}

/** A page's wheel log, from now on; the page gets tall enough to scroll. */
const LOG_WHEELS = `document.body.style.minHeight = "6000px";
  window.__wheels = [];
  addEventListener("wheel", e => window.__wheels.push(Math.round(e.deltaY)), true);
  return true;`;
const WHEELS = "return { wheels: window.__wheels.splice(0), scrollY: Math.round(scrollY) };";

/** The agent's raw wheel at its pointer (page.mouse wheel). */
const agentWheel = (s, dy, options = {}) => call("page.mouse", { space: s, page: "p1", action: "wheel", dx: 0, dy, options });

/** The wheel cases with a frame in the agent's page: the frame's site, its place, and the agent's pointer. */
const FRAMES = {
  oopFrame: { site: "B", style: "position:absolute;left:400px;top:80px;width:320px;height:260px;border:0", at: [560, 200] },
  sameSiteFrame: { site: "A", style: "position:absolute;left:400px;top:80px;width:320px;height:260px;border:0", at: [560, 200] },
  latchFrame: { site: "A", style: "position:absolute;left:0;top:400px;width:400px;height:300px;border:0", at: [100, 100] },
};

/**
 * One wheel case (from the input layer):
 * - together: the user wheels 12 notches 15 ms into an agent's 900 px motion;
 * - waits: the agent's wheel while the user scrolls for 1.5 s, then for 4 s
 *   (past page.mouse's 3 s deadline);
 * - heldButton: the agent holds a press, wheels, and the user wheels at once
 *   (the input layer's documented limit: there their wheel reaches neither page);
 * - oopFrame: the agent's motion over a frame of the other site, whose
 *   process is the user's tab's (the input layer: not checked yet);
 * - sameSiteFrame: the same over a frame of its own site, in one process
 *   with the user's tab;
 * - latchFrame: the agent's motion scrolls its page until a same-site frame
 *   comes under the pointer (the input layer's tests found that each step after
 *   that stalled 1.6 s, and the motion stopped halfway).
 */
async function oneWheel(procs, kind) {
  const other = procs === "two" || kind === "oopFrame";
  const p = await pair(`wheel ${procs} ${kind}`, other ? { userUrl: `${B.base}/lab` } : {});
  let held = false;
  try {
    if (kind !== "oopFrame" && (procs === "one") !== p.oneProcess) return { skipped: `not ${procs} process(es)`, pids: p.pids };
    const out = { pids: p.pids };
    await lab(`await inContent(userTab(), arg.code); await inContent(agentTab(arg.s), arg.code); return true;`, { s: p.s, code: LOG_WHEELS });
    let frame = null;
    if (FRAMES[kind]) {
      frame = await lab(
        `
        const t = agentTab(arg.s);
        await inContent(t, "const f = document.createElement('iframe'); f.id = 'oop'; f.src = " + JSON.stringify(arg.src) + "; f.style = " + JSON.stringify(arg.style) + "; document.body.append(f); scrollTo(0, 0); return true;");
        await until(() => t.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec === arg.src, 10000);
        const bc = t.linkedBrowser.browsingContext.children[0];
        await sleep(300);
        await ctx.content(bc, "dev#evalContent", { code: arg.code });
        return { pid: bc.currentWindowGlobal.osPid };
      `,
        { s: p.s, src: `${FRAMES[kind].site === "B" ? B.base : A.base}/lab`, style: FRAMES[kind].style, code: LOG_WHEELS }
      );
      out.framePid = frame.pid;
      out.frameInUserProcess = frame.pid === p.pids.user;
    }
    const read = () =>
      lab(
        `
        const t = agentTab(arg.s);
        const r = { user: await inContent(userTab(), arg.code), agent: await inContent(t, arg.code) };
        const bc = t.linkedBrowser.browsingContext.children[0];
        if (bc) r.frame = await ctx.content(bc, "dev#evalContent", { code: arg.code });
        return r;
      `,
        { s: p.s, code: WHEELS }
      );
    // The user's own wheel alone: one notch's delta in their page.
    await lab(`await userWheel(150, 150); await sleep(400); return true;`);
    const alone = await read();
    out.userNotch = alone.user.wheels[0] ?? null;
    out.userScrollBefore = alone.user.scrollY;
    if (kind === "together" || FRAMES[kind]) {
      const at = FRAMES[kind]?.at ?? [150, 150];
      await mouse(p.s, "move", at[0], at[1]);
      const t = Date.now();
      const [agent] = await Promise.all([
        outcome(agentWheel(p.s, 900)).then(r => ({ r: res(r), ms: Date.now() - t })),
        sleep(15).then(() => lab(`return userWheel(150, 150, 12);`)),
      ]);
      await sleep(600);
      out.agentWheel = agent;
      out.heard = await read();
      if (FRAMES[kind]) {
        // A second motion from where the first ended, alone.
        const t2 = Date.now();
        out.again = { r: res(await outcome(agentWheel(p.s, 300))), ms: Date.now() - t2 };
        await sleep(400);
        out.again.heard = await read();
      }
    } else if (kind === "waits") {
      await mouse(p.s, "move", 150, 150);
      for (const [label, notches] of [["1.5 s", 60], ["4 s", 160]]) {
        const t = Date.now();
        const userDone = lab(`return userWheel(150, 150, arg, 25);`, notches);
        await sleep(100);
        const r = res(await outcome(agentWheel(p.s, 300)));
        const ms = Date.now() - t;
        const userEnd = (await userDone) - t;
        await sleep(400);
        out[label] = { agentWheel: r, agentMs: ms, userScrolledMs: userEnd, heard: await read() };
      }
    } else if (kind === "heldNoWheel") {
      // The agent holds a press on its button and sends no wheel; the user wheels.
      await mouse(p.s, "move", 100, 40);
      await mouse(p.s, "down");
      held = true;
      await lab(`await userWheel(150, 150, 5); await sleep(400); return true;`);
      out.heard = await read();
      out.agentUp = res(await outcome(mouse(p.s, "up")));
      held = false;
      await lab(`await userWheel(150, 150, 3); await sleep(400); return true;`);
      out.afterRelease = await read();
    } else if (kind === "heldButton" || kind === "heldButtonBtn") {
      // On its text (a selection capture), or on its button (no capture).
      if (kind === "heldButton") await mouse(p.s, "move", 30, 230);
      else await mouse(p.s, "move", 100, 40);
      await mouse(p.s, "down");
      held = true;
      const t = Date.now();
      const [agent] = await Promise.all([
        outcome(agentWheel(p.s, 300)).then(r => ({ r: res(r), ms: Date.now() - t })),
        sleep(15).then(() => lab(`return userWheel(150, 150, 5);`)),
      ]);
      await sleep(400);
      out.agentWheel = agent;
      out.heard = await read();
      out.agentUp = res(await outcome(mouse(p.s, "up")));
      held = false;
      // After the release: the user's wheel again.
      await lab(`await userWheel(150, 150, 3); await sleep(400); return true;`);
      out.afterRelease = await read();
    }
    return out;
  } finally {
    if (held) await outcome(mouse(p.s, "up")).catch(() => {});
    await unpair(p);
  }
}

const experiments = {
  /** What decides whether same-site tabs share a process here. */
  async env() {
    return lab(`
      const p = name => { try { return Services.prefs.getIntPref(name); } catch { return null; } };
      return {
        webIsolated: p("dom.ipc.processCount.webIsolated"),
        web: p("dom.ipc.processCount"),
        fission: Services.appinfo.fissionAutostart,
        autocopy: Services.prefs.getBoolPref("clipboard.autocopy", false),
        middlePaste: Services.prefs.getBoolPref("middlemouse.paste", false),
        coalesce: Services.prefs.getBoolPref("dom.events.coalesce.mousemove", false),
      };
    `);
  },

  /**
   * Mouse capture: the agent presses on its page's text and holds (a raw
   * page.mouse down), which starts a selection drag, so Gecko captures the
   * mouse. Then the user moves over their pad and clicks their button.
   */
  async heldPress() {
    const p = await pair("held press");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      await mouse(p.s, "move", 30, 230);
      await mouse(p.s, "down");
      const pressed = await lab(`await sleep(150); return { agent: await logOf(agentTab(arg)), agentState: await stateOf(agentTab(arg)) };`, p.s);
      const during = await lab(
        `
        for (const [x, y] of [[100, 140], [150, 150], [200, 160]]) { userMouse("mousemove", x, y); await sleep(80); }
        await userClick(100, 40);
        await sleep(300);
        return both(arg);
      `,
        p.s
      );
      await mouse(p.s, "up");
      const released = await lab(`await sleep(200); await userClick(100, 40); await sleep(300); return both(arg);`, p.s);
      return { pids: p.pids, pressed: { agent: brief(pressed.agent), agentState: pressed.agentState }, during: view(during), released: view(released) };
    } finally {
      await unpair(p);
    }
  },

  /**
   * The same held press across a handoff. The agent's code runs on the site,
   * so the pill offers the user's own tab. The agent presses and holds in a
   * second, hidden page of the task, then hands off. The user clicks in
   * their own tab (moved on to the lab page), then in the handed page.
   */
  async heldThroughHandoff() {
    const s = await newTask("held handoff", `${A.base}/lab`);
    try {
      await ev(s, "p1", "() => document.title");
      const p2 = (await call("pages.new", { space: s })).label;
      await call("page.goto", { space: s, page: p2, url: `${A.base}/lab` });
      await mouse2(s, p2, "move", 30, 230);
      await mouse2(s, p2, "down");
      await call("spaces.handOff", { space: s });
      const opened = await kit.pillAndOwnTab(s);
      const pids = await lab(
        `
        const own = win.__own;
        if (!own) return { error: "no own tab" };
        const u = Services.io.newURI(arg.url);
        own.linkedBrowser.loadURI(u, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(u, {}) });
        await until(() => own.linkedBrowser.currentURI.spec === arg.url && loaded(own), 10000);
        win.__userTab = own;
        await sleep(300);
        const held = ctx.resolvePage({ space: arg.s, page: arg.p2 }).tab;
        await logOf(own); await logOf(held); await logOf(agentTab(arg.s));
        return { own: pidOf(own), handed: pidOf(agentTab(arg.s)), held: pidOf(held), ownContainer: own.userContextId, heldContainer: held.userContextId };
      `,
        { s, p2, url: `${A.base}/lab` }
      );
      const inOwnTab = await lab(
        `
        const held = ctx.resolvePage({ space: arg.s, page: arg.p2 }).tab;
        for (const [x, y] of [[100, 140], [150, 150]]) { userMouse("mousemove", x, y); await sleep(80); }
        await userClick(100, 40);
        await sleep(300);
        return { own: await logOf(userTab()), held: await logOf(held), ownState: await stateOf(userTab()), heldState: await stateOf(held) };
      `,
        { s, p2 }
      );
      const inHandedPage = await lab(
        `
        const handed = agentTab(arg.s);
        const held = ctx.resolvePage({ space: arg.s, page: arg.p2 }).tab;
        Pages.landOn(handed);
        await gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.peek(arg.s).uuid);
        await until(() => gBrowser.selectedTab === handed);
        await sleep(300);
        win.__userTab = handed;
        await logOf(handed);
        await userClick(100, 40);
        await sleep(300);
        return { handed: await logOf(handed), held: await logOf(held), handedState: await stateOf(handed) };
      `,
        { s, p2 }
      );
      await kit.handBack(s).catch(e => step("heldThroughHandoff: hand back failed:", e.message));
      await mouse2(s, p2, "up");
      return {
        pill: opened.pill,
        pids,
        inOwnTab: { own: brief(inOwnTab.own), held: brief(inOwnTab.held), ownState: inOwnTab.ownState, heldState: inOwnTab.heldState },
        inHandedPage: { handed: brief(inHandedPage.handed), held: brief(inHandedPage.held), handedState: inHandedPage.handedState },
      };
    } finally {
      await closeUserTab().catch(() => {});
      await cleanUp([s]);
    }
  },

  /**
   * The reverse: the user starts selecting their page's text and holds the
   * button; meanwhile the agent clicks its button. Against a control run
   * without the agent's click.
   */
  async userHolds() {
    const p = await pair("user holds");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const out = {};
      for (const run of ["control", "agentClicks"]) {
        await lab(`
          userMouse("mousemove", 30, 230); await sleep(30);
          userMouse("mousedown", 30, 230, { buttons: 1 }); await sleep(60);
          userMouse("mousemove", 200, 230, { buttons: 1 }); await sleep(100);
          return true;
        `);
        const agentClick = run === "agentClicks" ? await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: 5000 } })) : null;
        const held = await lab(`await sleep(200); return both(arg);`, p.s);
        const done = await lab(
          `
          userMouse("mousemove", 420, 262, { buttons: 1 }); await sleep(80);
          userMouse("mousemove", 520, 232, { buttons: 1 }); await sleep(80);
          userMouse("mouseup", 520, 232); await sleep(300);
          return both(arg);
        `,
          p.s
        );
        out[run] = { agentClick, held: view(held), done: view(done) };
        await lab(`await inContent(userTab(), "getSelection().removeAllRanges(); return true"); await sleep(100); await logOf(userTab()); return true;`);
      }
      return { pids: p.pids, ...out };
    } finally {
      await unpair(p);
    }
  },

  /**
   * userHolds, with the user's hold lasting through the agent's whole click.
   * zenius stops counting a press the mouse has held still for 5 s
   * (USER_PRESS_STALE_MS in content/capture.sys.mjs), so:
   * - "moving": the user's mouse moves a little every 400 ms, as in a slow
   *   selection drag, and the agent's click (8 s timeout) should wait it out;
   * - "still": the mouse stays still, and the click (9 s timeout) shows what
   *   happens once zenius stops counting the press.
   * The user's selection is read while they hold, against the control's.
   */
  async userHoldsLong() {
    const p = await pair("user holds long");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const out = { pids: p.pids };
      for (const run of ["control", "moving", "still"]) {
        await lab(
          `
          userMouse("mousemove", 30, 230); await sleep(30);
          userMouse("mousedown", 30, 230, { buttons: 1 }); await sleep(60);
          userMouse("mousemove", 200, 230, { buttons: 1 }); await sleep(100);
          if (arg === "moving") {
            let i = 0;
            win.__jiggle = win.setInterval(() => { i++; try { userMouse("mousemove", 200 + (i % 2) * 4, 230, { buttons: 1 }); } catch {} }, 400);
          }
          return true;
        `,
          run
        );
        const t0 = Date.now();
        const agentClick =
          run === "control" ? null : await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: run === "moving" ? 8000 : 9000 } }));
        const clickMs = Date.now() - t0;
        const held = await lab(`await sleep(200); if (win.__jiggle) { win.clearInterval(win.__jiggle); delete win.__jiggle; } return both(arg);`, p.s);
        const done = await lab(
          `
          userMouse("mousemove", 420, 262, { buttons: 1 }); await sleep(80);
          userMouse("mousemove", 520, 232, { buttons: 1 }); await sleep(80);
          userMouse("mouseup", 520, 232); await sleep(300);
          return both(arg);
        `,
          p.s
        );
        out[run] = { agentClick, clickMs, held: view(held), done: view(done) };
        await lab(`await inContent(userTab(), "getSelection().removeAllRanges(); return true"); await sleep(100); await logOf(userTab()); return true;`);
      }
      // Once the user has let go, the same click goes through.
      out.afterRelease = await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: 5000 } }));
      out.afterReleaseLogs = view(await lab(`await sleep(200); return both(arg);`, p.s));
      return out;
    } finally {
      await lab(`if (win.__jiggle) { win.clearInterval(win.__jiggle); delete win.__jiggle; } return true;`).catch(() => {});
      await unpair(p);
    }
  },

  /**
   * Pointer capture, by the agent's code alone: it tries to capture pointer 0
   * every few ms, while the user presses on their pad, drags and lets go.
   */
  async pointerSteal() {
    const p = await pair("pointer steal");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      await ev(p.s, "p1", STEAL);
      await sleep(300);
      const before = await ev(p.s, "p1", "() => ({ tries: window.__tries, errors: window.__errors })");
      const r = await lab(
        `
        userMouse("mousemove", 60, 120); await sleep(50);
        userMouse("mousedown", 60, 120, { buttons: 1 }); await sleep(400);
        for (const [x, y] of [[90, 130], [140, 150], [190, 170]]) { userMouse("mousemove", x, y, { buttons: 1 }); await sleep(120); }
        userMouse("mouseup", 190, 170); await sleep(300);
        return both(arg);
      `,
        p.s
      );
      const agentSide = await ev(p.s, "p1", STOP_STEAL);
      return { pids: p.pids, before, ...view(r), agentSide };
    } finally {
      await unpair(p);
    }
  },

  /**
   * Pointer capture during zenius's held press: the agent's page captures
   * the pointer on pointerdown (as a slider does), and the agent presses
   * there and holds. Then the user moves and clicks in their tab, on the
   * same site (one process) and on another site (another process).
   */
  async heldCapture() {
    const out = {};
    for (const where of ["sameSite", "otherSite"]) {
      const p = await pair(`held capture ${where}`, { userUrl: where === "sameSite" ? `${A.base}/lab` : `${B.base}/lab` });
      try {
        await ev(p.s, "p1", `() => { const pad = document.getElementById("pad"); pad.addEventListener("pointerdown", e => pad.setPointerCapture(e.pointerId)); return true; }`);
        await mouse(p.s, "move", 60, 120);
        await mouse(p.s, "down");
        const pressed = await lab(`await sleep(150); return { agent: await logOf(agentTab(arg)), agentState: await stateOf(agentTab(arg)) };`, p.s);
        const during = await lab(
          `
          for (const [x, y] of [[100, 140], [150, 150], [200, 160]]) { userMouse("mousemove", x, y); await sleep(80); }
          await userClick(100, 40);
          await sleep(300);
          return both(arg);
        `,
          p.s
        );
        await mouse(p.s, "up");
        const released = await lab(`await sleep(200); await userClick(100, 40); await sleep(300); return both(arg);`, p.s);
        out[where] = { pids: p.pids, pressed: { agent: brief(pressed.agent), agentState: pressed.agentState }, during: view(during), released: view(released) };
      } finally {
        await unpair(p);
      }
    }
    return out;
  },

  /** :active: the user holds their button while the agent clicks its own; then the agent holds while the user clicks. */
  async activeState() {
    const p = await pair("active state");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const userPressed = await lab(`userMouse("mousemove", 100, 40); await sleep(30); userMouse("mousedown", 100, 40, { buttons: 1 }); await sleep(150); return stateOf(userTab());`);
      const agentClick = await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: { timeout: 5000 } }));
      const afterAgent = await lab(`await sleep(100); return { userState: await stateOf(userTab()), agentState: await stateOf(agentTab(arg)) };`, p.s);
      const userReleased = await lab(`userMouse("mouseup", 100, 40); await sleep(300); return both(arg);`, p.s);
      await mouse(p.s, "move", 100, 40);
      await mouse(p.s, "down");
      const agentHeld = await lab(`await sleep(100); return stateOf(agentTab(arg));`, p.s);
      await lab(`await userClick(150, 150); return true;`);
      const agentAfterUser = await lab(`await sleep(100); return stateOf(agentTab(arg));`, p.s);
      await mouse(p.s, "up");
      const end = await lab(`await sleep(200); return both(arg);`, p.s);
      return { pids: p.pids, userPressed, agentClick, afterAgent, userReleased: view(userReleased), agentHeld, agentAfterUser, end: view(end) };
    } finally {
      await unpair(p);
    }
  },

  /** movementX/Y: from where the last mouse event of the process was, in whichever tab. */
  async movement() {
    const p = await pair("movement");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const user1 = await lab(`userMouse("mousemove", 100, 100); await sleep(80); userMouse("mousemove", 110, 105); await sleep(150); return logOf(userTab());`);
      await mouse(p.s, "move", 300, 300);
      const agent1 = await lab(`await sleep(100); return logOf(agentTab(arg));`, p.s);
      const user2 = await lab(`userMouse("mousemove", 112, 106); await sleep(150); return logOf(userTab());`);
      return {
        pids: p.pids,
        user: brief(user1).moves,
        agentMovesTo300: brief(agent1).moves,
        userMovesTo112: brief(user2).moves,
        note: "the agent's move reads the user's last point if its movement is (300-110, 300-105); the user's next move jumps if it reads (112-300, 106-300)",
      };
    } finally {
      await unpair(p);
    }
  },

  /**
   * movement, longer, with the sides taking turns: what each page reads for
   * each of its moves, so a movement that counts from the other side's point
   * shows as a jump.
   */
  async movementLong() {
    const p = await pair("movement long");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const user = (x, y) => lab(`userMouse("mousemove", ${x}, ${y}); await sleep(120); return true;`);
      await user(100, 100);
      await user(110, 105);
      await mouse(p.s, "move", 300, 300);
      await mouse(p.s, "move", 305, 302);
      await user(112, 106);
      await user(114, 107);
      await mouse(p.s, "move", 320, 310);
      await user(116, 108);
      const logs = await lab(`await sleep(150); return { user: await logOf(userTab()), agent: await logOf(agentTab(arg)) };`, p.s);
      return {
        pids: p.pids,
        user: brief(logs.user).moves,
        agent: brief(logs.agent).moves,
        note: "user moves: (100,100) (110,105) | agent (300,300) (305,302) | user (112,106) (114,107) | agent (320,310) | user (116,108)",
      };
    } finally {
      await unpair(p);
    }
  },

  /** Focus and keys: the user types in their field while the agent clicks, fills, types, tabs and focuses in its tab. */
  async focusKeys() {
    const p = await pair("focus keys");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const start = await lab(`
        await userClick(100, 312);
        await userKeys("ab");
        await sleep(200);
        return { log: await logOf(userTab()), state: await stateOf(userTab()), chromeFocus: Services.focus.focusedElement?.localName ?? null };
      `);
      const target = { space: p.s, page: "p1" };
      const agent = {};
      agent.click = await outcome(call("page.click", { ...target, target: "#field", options: {} }));
      agent.fill = await outcome(call("page.fill", { ...target, target: "#field", value: "agent", options: {} }));
      agent.type = await outcome(call("page.keyboard", { ...target, action: "type", text: "xyz" }));
      agent.press = await outcome(call("page.press", { ...target, target: "#field", chord: "Tab", options: {} }));
      agent.focus = await outcome(call("page.focus", { ...target, target: "#field", options: {} }));
      const mid = await lab(`await sleep(200); return both(arg);`, p.s);
      const end = await lab(`await userKeys("cd"); await sleep(200); return both(arg);`, p.s);
      return { pids: p.pids, start: { ...brief(start.log), state: start.state, chromeFocus: start.chromeFocus }, agent, mid: view(mid), end: view(end) };
    } finally {
      await unpair(p);
    }
  },

  /**
   * Keys from both sides at once, in one process. The user types in their
   * tab from a loop in the parent while the agent fills, types and presses
   * a chord in its own. Tasks, and so the user's keys, can come between the
   * agent's keys only during a delay. Then each side holds Shift
   * while the other types. The user types a to m and the agent n to z, so a
   * letter in the wrong page shows whose it was.
   */
  async keysTogether() {
    const p = await pair("keys together");
    let userShift = false;
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const target = { space: p.s, page: "p1" };
      const timed = async (name, pr) => {
        const start = Date.now();
        const r = await outcome(pr);
        return { name, start, end: Date.now(), r: typeof r === "string" ? r : "ok" };
      };
      await lab(`await userClick(100, 312); return true;`);
      const agentFocus = await outcome(call("page.click", { ...target, target: "#field", options: {} }));
      const t0 = await lab(
        `await logOf(userTab()); await logOf(agentTab(arg)); return { user: await inContent(userTab(), "return window.__t0"), agent: await inContent(agentTab(arg), "return window.__t0") };`,
        p.s
      );
      const keysOf = (log, base) => (log ?? []).filter(e => e.type === "keydown").map(e => ({ key: e.key, at: Math.round(base + e.t), mods: e.mods ?? "" }));
      const show = ks => ks.map(k => k.key + (k.mods ? `[${k.mods}]` : "")).join(" ");
      // Which of the user's keys reached their page between a call's first
      // and last key in the agent's page. The agent's keydowns are split by
      // each call's own count, in order.
      const spans = (calls, counts, uk, ak) => {
        let i = 0;
        const out = calls.map((c, n) => {
          const mine = ak.slice(i, i + counts[n]);
          i += counts[n];
          return {
            call: c.name,
            r: c.r,
            ms: c.end - c.start,
            agentKeys: show(mine),
            userKeysBetween: mine.length > 1 ? show(uk.filter(k => k.at > mine[0].at && k.at < mine.at(-1).at)) : null,
          };
        });
        if (i !== ak.length) out.push({ mismatch: `the agent's page got ${ak.length} keydowns, the calls send ${i}` });
        return out;
      };

      // 1. The user types 52 keys, 12 ms apart, while the agent's calls go out.
      const USER = "abcdefghijklm".repeat(4);
      await lab(
        `
        const tip = userTip();
        win.__utyping = (async () => {
          for (const ch of arg) {
            const up = ch.toUpperCase();
            const ev = new win.KeyboardEvent("", { key: ch, code: "Key" + up, keyCode: up.charCodeAt(0) });
            tip.keydown(ev);
            tip.keyup(ev);
            await sleep(12);
          }
        })();
        return true;`,
        USER
      );
      const calls = [];
      calls.push(await timed("fill nop", call("page.fill", { ...target, target: "#field", value: "nop", options: {} })));
      calls.push(await timed("type qrstuv", call("page.keyboard", { ...target, action: "type", text: "qrstuv", options: {} })));
      calls.push(await timed("type wxyz, delay 25", call("page.keyboard", { ...target, action: "type", text: "wxyz", options: { delay: 25 } })));
      calls.push(await timed("press Shift+KeyN", call("page.press", { ...target, target: "#field", chord: "Shift+KeyN", options: {} })));
      calls.push(await timed("type nopq, delay 25", call("page.keyboard", { ...target, action: "type", text: "nopq", options: { delay: 25 } })));
      const userDone = Date.now();
      await lab(`await win.__utyping; return true;`);
      const userEnd = Date.now();
      await sleep(200);
      const a = await lab(`return both(arg);`, p.s);
      const aUser = keysOf(a.user, t0.user);
      const aAgent = keysOf(a.agent, t0.agent);

      // 2. The user holds Shift and types; the agent types meanwhile.
      await lab(`const tip = userTip(); win.__shift = new win.KeyboardEvent("", { key: "Shift", code: "ShiftLeft", keyCode: 16 }); tip.keydown(win.__shift); await sleep(50); await userKeys("abc"); return true;`);
      userShift = true;
      const b = [];
      b.push(await timed("type qrs", call("page.keyboard", { ...target, action: "type", text: "qrs", options: {} })));
      b.push(await timed("type tuv, delay 25", call("page.keyboard", { ...target, action: "type", text: "tuv", options: { delay: 25 } })));
      await lab(`await userKeys("def"); userTip().keyup(win.__shift); return true;`);
      userShift = false;
      await sleep(200);
      const bLog = await lab(`return both(arg);`, p.s);

      // 3. The agent holds Shift; the user types meanwhile.
      const c = [];
      c.push(await timed("down Shift", call("page.keyboard", { ...target, action: "down", key: "Shift", options: {} })));
      await lab(`await userKeys("ghi"); return true;`);
      c.push(await timed("type w", call("page.keyboard", { ...target, action: "type", text: "w", options: {} })));
      await lab(`await userKeys("jkl"); return true;`);
      c.push(await timed("up Shift", call("page.keyboard", { ...target, action: "up", key: "Shift", options: {} })));
      await sleep(200);
      const cLog = await lab(`return both(arg);`, p.s);

      const stage = (log, calls) => ({
        calls: calls.map(x => `${x.name}: ${x.r}`),
        user: { keys: show(keysOf(log.user, t0.user)), field: log.userState.field, active: log.userState.active },
        agent: { keys: show(keysOf(log.agent, t0.agent)), field: log.agentState.field, active: log.agentState.active },
      });
      return {
        pids: p.pids,
        agentFocus,
        together: {
          userTyping: `${USER.length} keys, the agent's calls ended ${userDone - calls[0].start} ms in, the user's ${userEnd - calls[0].start} ms in`,
          spans: spans(calls, [0, 6, 4, 2, 4], aUser, aAgent),
          user: { field: a.userState.field, expected: USER, wrongKeys: show(aUser.filter(k => !/^[a-m]$/.test(k.key))), active: a.userState.active },
          agent: { field: a.agentState.field, expected: "nopqrstuvwxyzNnopq", wrongKeys: show(aAgent.filter(k => !/^([n-z]|N|Shift)$/.test(k.key))), active: a.agentState.active },
          mods: { user: show(aUser.filter(k => k.mods)), agent: show(aAgent.filter(k => k.mods)) },
        },
        userHoldsShift: stage(bLog, b),
        agentHoldsShift: stage(cLog, c),
      };
    } finally {
      if (userShift) await lab(`userTip().keyup(win.__shift); return true;`).catch(() => {});
      await unpair(p);
    }
  },

  /**
   * Which agent action moves the user's focus: after each one, the user's
   * focus, the chrome's focused element and the user's focus events. The
   * agent's field is its page's last focusable element, so its Tab leaves
   * the page. The user's tab is on the same site, or on another (another
   * process).
   */
  async focusSteps() {
    const out = {};
    for (const where of ["sameSite", "otherSite"]) {
      const p = await pair(`focus steps ${where}`, { userUrl: where === "sameSite" ? `${A.base}/lab` : `${B.base}/lab` });
      try {
        await lab(`await userClick(100, 312); await sleep(100); await logOf(userTab()); return true;`);
        const target = { space: p.s, page: "p1" };
        const steps = [
          ["click", () => call("page.click", { ...target, target: "#field", options: {} })],
          ["fill", () => call("page.fill", { ...target, target: "#field", value: "agent", options: {} })],
          ["type", () => call("page.keyboard", { ...target, action: "type", text: "xy" })],
          ["focusBtn", () => call("page.focus", { ...target, target: "#btn", options: {} })],
          ["tabInside", () => call("page.press", { ...target, target: "#btn", chord: "Tab", options: {} })],
          ["tabOut", () => call("page.press", { ...target, target: "#field", chord: "Tab", options: {} })],
          ["shiftTabOut", () => call("page.press", { ...target, target: "#btn", chord: "Shift+Tab", options: {} })],
          ["keyboardTab", () => call("page.keyboard", { ...target, action: "press", key: "Tab" })],
          ["f6", () => call("page.press", { ...target, target: "#field", chord: "F6", options: {} })],
          ["shiftF6", () => call("page.press", { ...target, target: "#field", chord: "Shift+F6", options: {} })],
          // Tab cycling: the window's selected tab must stay the user's.
          ["ctrlTab", () => call("page.press", { ...target, target: "#field", chord: "Control+Tab", options: {} })],
          ["ctrlShiftTab", () => call("page.press", { ...target, target: "#field", chord: "Control+Shift+Tab", options: {} })],
          ["keyboardCtrlTab", () => call("page.keyboard", { ...target, action: "press", key: "Control+Tab" })],
        ];
        out[where] = { pids: p.pids };
        for (const [name, run] of steps) {
          const r = await outcome(run());
          out[where][name] = await lab(`
            await sleep(250);
            const st = await stateOf(userTab());
            const ev = (await logOf(userTab())).filter(e => /^(focus|blur)/.test(e.type)).map(e => e.type + "@" + e.target);
            const chrome = Services.focus.focusedElement;
            const selected = gBrowser.selectedTab === userTab();
            const agentActive = await inContent(agentTab(arg.s), "return document.activeElement?.id || document.activeElement?.localName || null").catch(() => "unreadable");
            const back = st.active !== "field" || !selected;
            if (!selected) { gBrowser.selectedTab = userTab(); await sleep(150); }
            if (back) { await userClick(100, 312); await sleep(100); await logOf(userTab()); }
            return { result: arg.r, userActive: st.active, userHasFocus: st.hasFocus, userFocusEvents: ev, chromeFocus: chrome ? (chrome.id || chrome.localName) : null, userTabSelected: selected, agentActive, refocused: back };
          `, { r: typeof r === "string" ? r : "ok", s: p.s });
        }
      } finally {
        await unpair(p);
      }
    }
    return out;
  },

  /** Which agent action ends the user's composition: after each one, whether it is still open, and the user's events. */
  async imeSteps() {
    const p = await pair("ime steps");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const compose = `
        const ctip = userTip();
        if (!ctip.hasComposition) {
          ctip.setPendingCompositionString("\\u306b");
          ctip.appendClauseToPendingComposition(1, ctip.ATTR_RAW_CLAUSE);
          ctip.flushPendingComposition();
          await sleep(100);
        }
      `;
      await lab(`await userClick(100, 312); await sleep(100); ${compose} await logOf(userTab()); return true;`);
      const target = { space: p.s, page: "p1" };
      const steps = [
        ["mouseMove", () => call("page.mouse", { ...target, action: "move", x: 300, y: 300 })],
        ["hover", () => call("page.hover", { ...target, target: "#btn", options: {} })],
        ["clickPad", () => call("page.click", { ...target, target: "#pad", options: {} })],
        ["clickBtn", () => call("page.click", { ...target, target: "#btn", options: {} })],
        ["clickField", () => call("page.click", { ...target, target: "#field", options: {} })],
        ["focus", () => call("page.focus", { ...target, target: "#field", options: {} })],
        ["type", () => call("page.keyboard", { ...target, action: "type", text: "hi" })],
        ["insertText", () => call("page.keyboard", { ...target, action: "insertText", text: "ok" })],
        ["fill", () => call("page.fill", { ...target, target: "#field", value: "filled", options: {} })],
        ["pressEnter", () => call("page.press", { ...target, target: "#field", chord: "Enter", options: {} })],
      ];
      const out = { pids: p.pids };
      for (const [name, run] of steps) {
        const r = await outcome(run());
        out[name] = await lab(`
          await sleep(250);
          const tip = userTip();
          const open = tip.hasComposition;
          const ev = (await logOf(userTab())).filter(e => /^composition|^input|^blur|^focus/.test(e.type)).map(e => e.type + (e.data ? ' "' + e.data + '"' : "") + "@" + e.target);
          const field = (await stateOf(userTab())).field;
          ${compose}
          await logOf(userTab());
          return { result: arg.r, stillComposing: open, userEvents: ev, userField: field };
        `, { r: typeof r === "string" ? r : "ok" });
      }
      return out;
    } finally {
      await unpair(p);
    }
  },

  /** Whether an agent's press ends the user's composition when the user's tab is on another site (another process). */
  async imeOtherSite() {
    const out = {};
    for (const where of ["sameSite", "otherSite"]) {
      const p = await pair(`ime ${where}`, { userUrl: where === "sameSite" ? `${A.base}/lab` : `${B.base}/lab` });
      try {
        out[where] = await lab(`
          await userClick(100, 312);
          await sleep(100);
          const tip = userTip();
          tip.setPendingCompositionString("\\u306b");
          tip.appendClauseToPendingComposition(1, tip.ATTR_RAW_CLAUSE);
          tip.flushPendingComposition();
          await sleep(150);
          await logOf(userTab());
          return { pids: arg.pids, composing: tip.hasComposition };
        `, { pids: p.pids });
        await outcome(call("page.click", { space: p.s, page: "p1", target: "#btn", options: {} }));
        out[where].afterAgentClick = await lab(`
          await sleep(250);
          const tip = userTip();
          const open = tip.hasComposition;
          if (open) tip.commitComposition();
          return { stillComposing: open, userEvents: (await logOf(userTab())).filter(e => /^composition/.test(e.type)).map(e => e.type + ' "' + (e.data ?? "") + '"') };
        `);
      } finally {
        await unpair(p);
      }
    }
    return out;
  },

  /**
   * What a guard at a tab's chrome event handler can tell apart: Gecko's
   * chrome-only Event.isSynthesized on zenius's events, on the user's, and
   * on the user's events that a held press sends to the agent's page.
   */
  async synthFlag() {
    const p = await pair("synth flag");
    try {
      const SPY = `
        const root = window.docShell.chromeEventHandler;
        window.wrappedJSObject.__flags = [];
        root.addEventListener("mousedown", e => window.wrappedJSObject.__flags.push({ type: e.type, isSynthesized: e.isSynthesized, trusted: e.isTrusted }), { capture: true, mozSystemGroup: true });
        return "isSynthesized" in Event.prototype;
      `;
      const flags = t => `JSON.parse(JSON.stringify(window.wrappedJSObject.__flags.splice(0)))`;
      const has = await lab(`return { agent: await inContent(agentTab(arg.s), arg.spy, true), user: await inContent(userTab(), arg.spy, true) };`, { s: p.s, spy: SPY });
      await call("page.click", { space: p.s, page: "p1", target: "#btn", options: {} });
      const zeniusClick = await lab(`await sleep(100); return { agent: await inContent(agentTab(arg.s), "return " + arg.f, true), user: await inContent(userTab(), "return " + arg.f, true) };`, { s: p.s, f: flags() });
      await lab(`await userClick(100, 40); return true;`);
      const userClick = await lab(`await sleep(100); return { agent: await inContent(agentTab(arg.s), "return " + arg.f, true), user: await inContent(userTab(), "return " + arg.f, true) };`, { s: p.s, f: flags() });
      await mouse(p.s, "move", 30, 230);
      await mouse(p.s, "down");
      await lab(`await sleep(100); await inContent(agentTab(arg.s), "return " + arg.f, true); await userClick(100, 40); return true;`, { s: p.s, f: flags() });
      const retargeted = await lab(`await sleep(100); return { agent: await inContent(agentTab(arg.s), "return " + arg.f, true), user: await inContent(userTab(), "return " + arg.f, true) };`, { s: p.s, f: flags() });
      await mouse(p.s, "up");
      return { pids: p.pids, has, zeniusClick, userClick, userPressWhileAgentHolds: retargeted };
    } finally {
      await unpair(p);
    }
  },

  /** IME: the user composes in their field while the agent types, fills and inserts text in its tab. */
  async ime() {
    const p = await pair("ime");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const start = await lab(`
        await userClick(100, 312);
        await sleep(100);
        const tip = userTip();
        tip.setPendingCompositionString("\\u306b");
        tip.appendClauseToPendingComposition(1, tip.ATTR_RAW_CLAUSE);
        tip.flushPendingComposition();
        await sleep(150);
        return { log: await logOf(userTab()), state: await stateOf(userTab()), composing: tip.hasComposition };
      `);
      const target = { space: p.s, page: "p1" };
      const agent = {};
      agent.click = await outcome(call("page.click", { ...target, target: "#field", options: {} }));
      agent.type = await outcome(call("page.keyboard", { ...target, action: "type", text: "hello" }));
      agent.insertText = await outcome(call("page.keyboard", { ...target, action: "insertText", text: "\u65e5\u672c" }));
      agent.fill = await outcome(call("page.fill", { ...target, target: "#field", value: "filled", options: {} }));
      agent.press = await outcome(call("page.press", { ...target, target: "#field", chord: "Enter", options: {} }));
      const mid = await lab(`await sleep(200); const tip = userTip(); return { ...(await both(arg)), composing: tip.hasComposition };`, p.s);
      const end = await lab(
        `
        const tip = userTip();
        tip.setPendingCompositionString("\\u306b\\u307b");
        tip.appendClauseToPendingComposition(2, tip.ATTR_RAW_CLAUSE);
        tip.flushPendingComposition();
        await sleep(100);
        tip.commitComposition();
        await sleep(200);
        return both(arg);
      `,
        p.s
      );
      return { pids: p.pids, start: { ...brief(start.log), state: start.state, composing: start.composing }, agent, mid: { ...view(mid), composing: mid.composing }, end: view(end) };
    } finally {
      await unpair(p);
    }
  },

  /** Click counting: two tasks and the user click the same point, one right after another. */
  async clickCount() {
    const p = await pair("click count");
    const s2 = await newTask("click count two", `${A.base}/lab`);
    try {
      const two = await agentPage(s2);
      if (!p.oneProcess || two.pid !== p.user.pid) return { skipped: "not one process", pids: { ...p.pids, two: two.pid } };
      const click = s => outcome(call("page.click", { space: s, page: "p1", target: "#btn", options: {} }));
      await lab(`await logOf(agentTab(arg)); return true;`, s2);
      await click(p.s);
      await lab(`await userClick(100, 40); return true;`);
      await click(s2);
      await outcome(call("page.dblclick", { space: p.s, page: "p1", target: "#btn", options: {} }));
      await lab(`await userClick(100, 40); return true;`);
      await click(s2);
      const logs = await lab(`await sleep(200); return { one: await logOf(agentTab(arg.one)), user: await logOf(userTab()), two: await logOf(agentTab(arg.two)) };`, { one: p.s, two: s2 });
      const clicks = log => brief(log).events.filter(e => /^(click|dblclick)@/.test(e));
      return { pids: { ...p.pids, two: two.pid }, taskOne: clicks(logs.one), user: clicks(logs.user), taskTwo: clicks(logs.two) };
    } finally {
      await cleanUp([s2]);
      await unpair(p);
    }
  },

  /**
   * The user's own drag next to the agent's input (the eval harness's Mac session,
   * 20:15:12 and 20:19:43 UTC: the user's page got a press with no release).
   * In one process and in two, the agent is idle, holds a press on its text,
   * or holds its emulated drag mid-way, while the user drags in their tab:
   * an HTML5 drag of #src onto #dst, a selection drag over #text, or a press
   * moved across #pad. 0.7 s after the user's last move the agent lets go
   * and clicks its button; then the user moves and clicks theirs. Headless,
   * the parent has no drag service, so the user's HTML5 drag gets no native
   * session: compare it with its idle control.
   */
  async userDrag() {
    const out = {};
    const only = process.env.USER_DRAG_ONLY?.split(",");
    for (const procs of ["one", "two"]) {
      for (const agentDoes of ["idle", "heldPress", "heldDrag"]) {
        for (const gesture of Object.keys(USER_GESTURES)) {
          const key = `${procs} ${agentDoes} ${gesture}`;
          if (only && !only.some(o => key.includes(o))) continue;
          step("user drag", key);
          out[key] = await oneUserDrag(procs, agentDoes, gesture).catch(e => ({ error: String(e?.message ?? e) }));
        }
      }
    }
    return out;
  },

  /** The eval harness's press-without-release sequences, in one process and in two (oneUserPress). */
  async userPress() {
    const out = {};
    const only = process.env.USER_PRESS_ONLY?.split(",");
    for (const procs of ["one", "two"]) {
      for (const variant of ["holdAfterDrop", "holdNoDrop", "pressWhileAgentHolds", "clickWhileAgentHolds", "pressWhileAgentHoldsBtn", "agentPressesDuringUserPress"]) {
        const key = `${procs} ${variant}`;
        if (only && !only.some(o => key.includes(o))) continue;
        step("user press", key);
        out[key] = await oneUserPress(procs, variant).catch(e => ({ error: String(e?.message ?? e) }));
      }
    }
    return out;
  },

  /** The wheel next to the user's (oneWheel), in one process and in two. */
  async wheel() {
    const out = {};
    const only = process.env.WHEEL_ONLY?.split(",");
    for (const [procs, kind] of [["one", "together"], ["two", "together"], ["one", "waits"], ["one", "heldButton"], ["one", "heldButtonBtn"], ["one", "heldNoWheel"], ["two", "oopFrame"], ["one", "sameSiteFrame"], ["one", "latchFrame"]]) {
      const key = `${procs} ${kind}`;
      if (only && !only.some(o => key.includes(o))) continue;
      step("wheel", key);
      out[key] = await oneWheel(procs, kind).catch(e => ({ error: String(e?.message ?? e) }));
    }
    return out;
  },

  /** zenius's emulated drag, held mid-way, while the user moves and clicks in their tab. */
  async drag() {
    const p = await pair("drag");
    try {
      if (!p.oneProcess) return { skipped: "two processes", pids: p.pids };
      const where = () => lab(`return agentTab(arg).linkedBrowser.currentURI.spec.slice(0, 60);`, p.s);
      const trail = [];
      await mouse(p.s, "move", 440, 40);
      trail.push(["move", await where()]);
      await mouse(p.s, "down");
      trail.push(["down", await where()]);
      await mouse(p.s, "move", 500, 40);
      trail.push(["move 500", await where()]);
      await mouse(p.s, "move", 560, 40);
      trail.push(["move 560", await where()]);
      step("drag trail", JSON.stringify(trail));
      const sessions = await lab(
        `
        let parent;
        try {
          const ds = Cc["@mozilla.org/widget/dragservice;1"].getService(Ci.nsIDragService);
          parent = !!ds.getCurrentSession(win);
        } catch (e) {
          parent = "no drag service: " + e.name;
        }
        const child = await inContent(agentTab(arg), "try { const ds = Components.classes['@mozilla.org/widget/dragservice;1'].getService(Components.interfaces.nsIDragService); return !!ds.getCurrentSession(window); } catch (e) { return 'no drag service: ' + e.name; }", true);
        return { parent, child, agent: await logOf(agentTab(arg)) };
      `,
        p.s
      );
      const during = await lab(
        `
        for (const [x, y] of [[100, 140], [200, 160]]) { userMouse("mousemove", x, y); await sleep(80); }
        await userClick(100, 40);
        await sleep(200);
        return both(arg);
      `,
        p.s
      );
      const tabsBefore = await lab(`return all().length;`);
      await mouse(p.s, "up");
      await sleep(300);
      trail.push(["up", await where()]);
      const tabsAfter = await lab(`return all().map(t => t.linkedBrowser.currentURI.spec.slice(0, 60));`);
      step("drag trail", JSON.stringify(trail), "tabs", tabsBefore, JSON.stringify(tabsAfter));
      const end = await lab(`await sleep(200); return { agent: await logOf(agentTab(arg)).catch(e => String(e)), user: await logOf(userTab()) };`, p.s);
      return { pids: p.pids, trail, tabsBefore, tabsAfter, end: { agent: Array.isArray(end.agent) ? brief(end.agent) : end.agent, user: brief(end.user) }, sessions: { parent: sessions.parent, child: sessions.child, agent: brief(sessions.agent) }, during: view(during) };
    } finally {
      await unpair(p);
    }
  },

  /**
   * The selection clipboard (X11 PRIMARY on Linux): does a selection the
   * agent's input makes reach it, and can the agent's middle click paste the
   * user's?
   */
  async selectionClipboard() {
    const p = await pair("selection clipboard");
    try {
      const READ = `
        const readSel = () => {
          const cb = Services.clipboard;
          try {
            const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
            t.init(null);
            t.addDataFlavor("text/plain");
            cb.getData(t, cb.kSelectionClipboard, win.browsingContext.currentWindowContext);
            const o = {};
            t.getTransferData("text/plain", o);
            return o.value?.QueryInterface(Ci.nsISupportsString).data ?? null;
          } catch (e) {
            return "unreadable: " + (e.name || e.message).slice(0, 60);
          }
        };
      `;
      const support = await lab(`${READ} return { supported: Services.clipboard.isClipboardTypeSupported(Services.clipboard.kSelectionClipboard), before: readSel() };`);
      const dbl = await outcome(call("page.dblclick", { space: p.s, page: "p1", target: "#text", options: { position: { x: 150, y: 10 } } }));
      const afterAgent = await lab(`${READ} await sleep(300); return { selection: (await stateOf(agentTab(arg))).selection, clip: readSel() };`, p.s);
      const selectAll = await outcome(call("page.press", { space: p.s, page: "p1", target: "#field", chord: "ControlOrMeta+A", options: {} }));
      await outcome(call("page.fill", { space: p.s, page: "p1", target: "#field", value: "agent field text", options: {} }));
      await outcome(call("page.press", { space: p.s, page: "p1", target: "#field", chord: "ControlOrMeta+A", options: {} }));
      const afterSelectAll = await lab(`${READ} await sleep(300); return { clip: readSel() };`, p.s);
      const user = await lab(`${READ}
        userMouse("mousemove", 70, 230); await sleep(30);
        userMouse("mousedown", 70, 230, { buttons: 1, clickCount: 1 }); await sleep(30);
        userMouse("mouseup", 70, 230, { clickCount: 1 }); await sleep(30);
        userMouse("mousedown", 70, 230, { buttons: 1, clickCount: 2 }); await sleep(30);
        userMouse("mouseup", 70, 230, { clickCount: 2 }); await sleep(300);
        return { selection: (await stateOf(userTab())).selection, clip: readSel() };
      `);
      await outcome(call("page.fill", { space: p.s, page: "p1", target: "#field", value: "", options: {} }));
      const middle = await outcome(call("page.click", { space: p.s, page: "p1", target: "#field", options: { button: "middle" } }));
      const pasted = await lab(`await sleep(300); return (await stateOf(agentTab(arg))).field;`, p.s);
      return { support, agentDblclick: dbl, afterAgent, selectAll, afterSelectAll, user, middle, agentFieldAfterMiddleClick: pasted };
    } finally {
      await unpair(p);
    }
  },

  /** Two tasks in one process: a held press against a click, pointer capture against a drag, and movement. */
  async tasks() {
    const s1 = await newTask("tasks one", `${A.base}/lab`);
    const s2 = await newTask("tasks two", `${A.base}/lab`);
    try {
      const one = await agentPage(s1);
      const two = await agentPage(s2);
      if (one.pid !== two.pid) return { skipped: "two processes", pids: [one.pid, two.pid] };
      const logs = () => lab(`await sleep(200); return { one: await logOf(agentTab(arg.one)), two: await logOf(agentTab(arg.two)), oneState: await stateOf(agentTab(arg.one)), twoState: await stateOf(agentTab(arg.two)) };`, { one: s1, two: s2 });
      const brief2 = r => ({ one: brief(r.one), two: brief(r.two), oneState: r.oneState, twoState: r.twoState });
      await logs();
      // Task one holds a press on its text; task two clicks its button.
      await mouse(s1, "move", 30, 230);
      await mouse(s1, "down");
      const twoClick = await outcome(call("page.click", { space: s2, page: "p1", target: "#btn", options: { timeout: 5000 } }));
      const held = brief2(await logs());
      await mouse(s1, "up");
      await logs();
      // Task one's code tries to capture pointer 0; task two drags on its pad.
      await ev(s1, "p1", STEAL);
      await sleep(200);
      await mouse(s2, "move", 60, 120);
      await mouse(s2, "down");
      await sleep(300);
      await mouse(s2, "move", 120, 150);
      await mouse(s2, "move", 180, 170);
      await mouse(s2, "up");
      const stolen = brief2(await logs());
      const steal = await ev(s1, "p1", STOP_STEAL);
      // Movement: task one moves to (50, 50), then task two to (60, 70).
      await mouse(s1, "move", 50, 50);
      await mouse(s2, "move", 60, 70);
      const moved = brief2(await logs());
      return { pids: [one.pid, two.pid], twoClick, held, steal, stolen, moves: { one: moved.one.moves, two: moved.two.moves } };
    } finally {
      await cleanUp([s1, s2]);
    }
  },
};

await runProbes(experiments, process.argv.slice(2), kit);
