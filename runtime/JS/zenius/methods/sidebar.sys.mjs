// sidebar.* methods (zen-observe): remote tasks, which another of the user's
// agents sends to the sidebar's agent (docs/briefs/remote-tasks.md; PROTOCOL
// "Remote tasks: the sidebar"). zen-sdk's bridge calls them for the requests
// it takes from zen-core's gate. This is cross-owner work by the manager's
// assignment: the sidebar is zen-ux's, and zen-ux reviews it.
//
// The sidebar keeps each task's remote state (agent-sidebar/remote.sys.mjs).
// This module checks the params, holds the limits, and stops tasks: at their
// time limit, when the caller asks, and when the user turns remote tasks off.
//
// A request's text reaches only the sidebar's agent. The service logs each
// call's method, time and outcome, and no message here quotes the text.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const SIDEBAR = "chrome://userscripts/content/agent-sidebar/";
const PREF_REMOTE = "zenius.agentSidebar.allowRemoteTasks";
const HOUR = 3600000;
const MAX_TEXT_BYTES = 8192;
// The limits, and the prefs that may lower them for tests (never raise).
const LIMITS = {
  maxRunning: { pref: "zenius.agentSidebar.remote.maxRunning", value: 2 },
  maxPerHour: { pref: "zenius.agentSidebar.remote.maxPerHour", value: 20 },
  maxTaskSeconds: { pref: "zenius.agentSidebar.remote.maxTaskSeconds", value: 3600 },
};
// The span the hourly limit counts, which only a dev profile shortens.
const PREF_WINDOW = "zenius.agentSidebar.remote.windowSeconds";

const ADDRESS = /^[A-Za-z0-9._:@/-]{1,64}$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
// A label is a short tag: ASCII letters and digits, spaces and - _ . / : @ #.
// Nothing in it can close the quotes the agent's rules put it in
// (zen-snapshot's T1), make markup, or reorder the card's text as a bidi
// override would. zen-core's gate allows the same set, so the gate never
// passes a label that start refuses.
const LABEL = /^[A-Za-z0-9 _.:@#/-]{0,80}$/;

const METHODS = ["sidebar.start", "sidebar.send", "sidebar.status", "sidebar.list", "sidebar.stop"];

// Gate classes (docs/research/method-boundary.md). They name no space, so
// the control gate never meets them, and they touch no page.
export const access = Object.fromEntries(METHODS.map(m => [m, "none"]));
export const i5 = Object.fromEntries(METHODS.map(m => [m, "none"]));

// --- Params -----------------------------------------------------------------

const invalid = message => new ZenError("ZEN_INVALID_ARGUMENT", message);

function textOf(params) {
  const { text } = params;
  if (typeof text !== "string" || !text.trim()) {
    throw invalid("text must be a non-empty string");
  }
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw invalid(`text must be at most ${MAX_TEXT_BYTES} bytes of UTF-8`);
  }
  return text;
}

function sourceOf(params) {
  const source = params.source;
  if (!source || typeof source !== "object") {
    throw invalid("source must be {address, label?}");
  }
  if (typeof source.address !== "string" || !ADDRESS.test(source.address)) {
    throw invalid("source.address must be 1 to 64 characters of A-Z a-z 0-9 . _ : @ / -");
  }
  let label = "";
  if (source.label !== undefined && source.label !== null) {
    if (typeof source.label !== "string") {
      throw invalid("source.label must be a string");
    }
    label = source.label.trim();
    if (!LABEL.test(label)) {
      throw invalid("source.label must be at most 80 characters of A-Z a-z 0-9, space and - _ . / : @ #");
    }
  }
  return { address: source.address, label };
}

function optionalId(value, name, pattern = ID) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalid(`${name} must be at most 64 characters of A-Z a-z 0-9 . _ -`);
  }
  return value;
}

function taskIdOf(params) {
  if (typeof params.taskId !== "string" || !params.taskId) {
    throw invalid("taskId must be a string");
  }
  return params.taskId;
}

// --- The sidebar --------------------------------------------------------------

function unavailable(reason, message, data = {}) {
  return new ZenError("ZEN_SIDEBAR_UNAVAILABLE", message, { reason, ...data });
}

/** The sidebar's service and its remote half, once a window has started the sidebar. */
function sidebar() {
  let A;
  let R;
  try {
    ({ AgentService: A } = ChromeUtils.importESModule(`${SIDEBAR}AgentService.sys.mjs`));
    R = ChromeUtils.importESModule(`${SIDEBAR}remote.sys.mjs`);
  } catch {
    throw unavailable("no_sidebar", "this profile has no zenius agent sidebar");
  }
  if (!A.base) {
    throw unavailable("no_sidebar", "no window has started zenius's agent sidebar");
  }
  if (!endsWatched) {
    endsWatched = true;
    R.onRemoteEnded(conv => afterEnd(A, R, conv));
  }
  return { A, R };
}

const remoteTasks = A => [...A.tasks.values()].filter(conv => conv.remote);

/** A remote task by id; a task the user removed reads as its last status. */
function find(A, R, taskId) {
  const conv = A.tasks.get(taskId);
  if (conv?.remote) {
    return { conv };
  }
  const gone = R.removedStatus(taskId);
  if (gone) {
    return { gone };
  }
  throw new ZenError("ZEN_REMOTE_TASK_NOT_FOUND", "no remote task has that id", { taskId });
}

function mustBeOn() {
  if (!Services.prefs.getBoolPref(PREF_REMOTE, true)) {
    throw new ZenError("ZEN_REMOTE_OFF", "the user turned remote tasks off", { pref: PREF_REMOTE });
  }
}

/** A limit, which a test pref may lower but never raise. */
function limit(key) {
  const { pref, value } = LIMITS[key];
  let v = value;
  try {
    v = Services.prefs.getIntPref(pref, value);
  } catch {}
  return Number.isInteger(v) && v > 0 && v < value ? v : value;
}

function windowMs() {
  if (!Services.prefs.getBoolPref("zenius.dev", false)) {
    return HOUR;
  }
  let s = 3600;
  try {
    s = Services.prefs.getIntPref(PREF_WINDOW, 3600);
  } catch {}
  return Number.isInteger(s) && s > 0 ? s * 1000 : HOUR;
}

/** The running limit, for a start or a follow-up. */
function checkRunning(A, R) {
  const max = limit("maxRunning");
  const running = remoteTasks(A).filter(conv => R.remoteActive(conv) && R.remoteStatus(conv, { answer: false }).state === "running");
  if (running.length >= max) {
    throw new ZenError("ZEN_REMOTE_LIMIT", `${max} remote tasks are running already`, { limit: "running", max });
  }
}

/** The hourly limit: starts in the window, removed tasks' included. */
function checkHourly(A, R) {
  const max = limit("maxPerHour");
  const span = windowMs();
  const now = Date.now();
  const starts = [...remoteTasks(A).map(conv => conv.remote.startedAt), ...R.removedStatuses().map(s => s.startedAt)]
    .filter(t => t > now - span)
    .sort((a, b) => a - b);
  if (starts.length >= max) {
    const retryAfterMs = Math.max(1, starts[starts.length - max] + span - now);
    throw new ZenError("ZEN_REMOTE_LIMIT", `${max} remote tasks started in the last ${Math.round(span / 60000)} minutes`, {
      limit: "hourly",
      max,
      retryAfterMs,
    });
  }
}

// --- Ends: the time limit, the caller, the off pref ----------------------------------

const timers = new Map(); // task id -> its time limit's timer
let endsWatched = false;
let offWatched = false;
let current = null; // {A, R} for the pref observer

function end(A, R, conv, stopReason) {
  const wasBusy = conv.busy;
  if (R.endRemote(conv, { state: "stopped", stopReason }) && wasBusy) {
    A.cancel(conv);
  }
}

/** The task's time limit: a timer, and a check at each call in case Zen slept past it. */
function arm(A, R, conv) {
  clearTimeout(timers.get(conv.uid));
  const uid = conv.uid;
  timers.set(
    uid,
    setTimeout(() => {
      timers.delete(uid);
      const now = A.tasks.get(uid);
      if (now && R.remoteActive(now)) {
        end(A, R, now, "limit");
      }
    }, Math.max(0, conv.remote.endsAt - Date.now()))
  );
}

/** Before each call: end the tasks past their time, arm the rest, and watch the pref while any is active. */
function sweep(A, R) {
  const now = Date.now();
  for (const conv of remoteTasks(A)) {
    if (!R.remoteActive(conv)) {
      continue;
    }
    if (now >= conv.remote.endsAt) {
      end(A, R, conv, "limit");
    } else if (!timers.has(conv.uid)) {
      arm(A, R, conv);
    }
  }
  watchOff(A, R);
}

const offObserver = {
  observe() {
    if (Services.prefs.getBoolPref(PREF_REMOTE, true) || !current) {
      return;
    }
    const { A, R } = current;
    for (const conv of remoteTasks(A)) {
      if (R.remoteActive(conv)) {
        end(A, R, conv, "off");
      }
    }
  },
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
};

/** The off pref's observer, only while a remote task is active (I4). */
function watchOff(A, R) {
  const active = remoteTasks(A).some(conv => R.remoteActive(conv));
  if (active && !offWatched) {
    current = { A, R };
    Services.prefs.addObserver(PREF_REMOTE, offObserver);
    offWatched = true;
  } else if (!active && offWatched) {
    Services.prefs.removeObserver(PREF_REMOTE, offObserver);
    offWatched = false;
    current = null;
  }
}

function afterEnd(A, R, conv) {
  clearTimeout(timers.get(conv.uid));
  timers.delete(conv.uid);
  watchOff(A, R);
  // Its chat, row and title say why it stopped (zen-ux's remoteEnd), at
  // once, even when no turn ran to end.
  A.refreshTask(conv);
}

/** The turn runs in the background; send() handles its own errors, into the chat. */
function runTurn(A, conv, text) {
  A.send(conv, { question: text, source: "remote" }).catch(e => console.error("[zenius] a remote task's turn:", e?.name ?? "error"));
}

// --- The methods -------------------------------------------------------------------

export const methods = {
  // {text, source: {address, label?}, requestId?, harness?} → {taskId, state}
  "sidebar.start": async (ctx, params) => {
    const text = textOf(params);
    const source = sourceOf(params);
    const requestId = optionalId(params.requestId, "requestId");
    const wanted = optionalId(params.harness, "harness");
    const { A, R } = sidebar();
    // The only wait, before anything is looked up: from here to the new
    // task nothing yields, so two retries can't both open a chat.
    if (!A.config) {
      await A.loadConfig();
    }
    if (requestId) {
      // A retry of a start that went through: that task, and nothing new.
      const known = remoteTasks(A).find(conv => conv.remote.requestId === requestId);
      if (known) {
        return { taskId: known.uid, state: R.remoteStatus(known, { answer: false }).state };
      }
      const gone = R.removedStatuses().find(s => s.requestId === requestId);
      if (gone) {
        return { taskId: gone.taskId, state: gone.state };
      }
    }
    mustBeOn();
    const agents = A.config?.agents ?? {};
    if (!Object.keys(agents).length) {
      throw unavailable("no_agents", "the sidebar has no agents (its config.json)");
    }
    const harness = wanted ?? A.preferredHarness();
    const can = agents[harness] ? A.harnessAvailable(harness) : { ok: false, reason: "config.json has no such agent" };
    if (!can.ok) {
      throw unavailable("agent_unavailable", `the sidebar can't run ${harness}: ${can.reason}`, { harness });
    }
    sweep(A, R);
    // The hourly limit first: its retryAfterMs is a wait the bridge can keep.
    checkHourly(A, R);
    checkRunning(A, R);
    const now = Date.now();
    const conv = A.createTask({ source: "remote", harness });
    conv.remote = {
      address: source.address,
      label: source.label,
      requestId,
      startedAt: now,
      endsAt: now + limit("maxTaskSeconds") * 1000,
      endedAt: null,
      final: null,
    };
    runTurn(A, conv, text);
    arm(A, R, conv);
    watchOff(A, R);
    return { taskId: conv.uid, state: "running" };
  },

  // {taskId, text} → {taskId, state}
  "sidebar.send": async (ctx, params) => {
    const taskId = taskIdOf(params);
    const text = textOf(params);
    const { A, R } = sidebar();
    mustBeOn();
    sweep(A, R);
    const { conv, gone } = find(A, R, taskId);
    const s = gone ?? R.remoteStatus(conv, { answer: false });
    if (s.state === "stopped" || s.state === "failed") {
      throw new ZenError("ZEN_REMOTE_TASK_ENDED", `the remote task has ${s.state === "failed" ? "failed" : "stopped"}`, {
        state: s.state,
        ...(s.stopReason ? { stopReason: s.stopReason } : {}),
      });
    }
    if (conv.busy || s.state === "running") {
      throw new ZenError("ZEN_REMOTE_TASK_BUSY", "the remote task's turn hasn't ended", { state: s.state });
    }
    const can = A.harnessAvailable(conv.harness);
    if (!can.ok) {
      throw unavailable("agent_unavailable", `the sidebar can't run ${conv.harness}: ${can.reason}`, { harness: conv.harness });
    }
    checkRunning(A, R);
    runTurn(A, conv, text);
    return { taskId, state: "running" };
  },

  // {taskId} → status
  "sidebar.status": async (ctx, params) => {
    const taskId = taskIdOf(params);
    const { A, R } = sidebar();
    sweep(A, R);
    const { conv, gone } = find(A, R, taskId);
    return gone ?? R.remoteStatus(conv);
  },

  // {} → {tasks}: newest first, without answers
  "sidebar.list": async () => {
    const { A, R } = sidebar();
    sweep(A, R);
    const tasks = [...remoteTasks(A).map(conv => R.remoteStatus(conv, { answer: false })), ...R.removedStatuses()];
    tasks.sort((a, b) => b.startedAt - a.startedAt);
    return { tasks };
  },

  // {taskId} → {taskId, state}
  "sidebar.stop": async (ctx, params) => {
    const taskId = taskIdOf(params);
    const { A, R } = sidebar();
    sweep(A, R);
    const { conv, gone } = find(A, R, taskId);
    if (gone) {
      return { taskId, state: gone.state };
    }
    if (R.remoteActive(conv)) {
      end(A, R, conv, "caller");
    }
    return { taskId, state: R.remoteStatus(conv, { answer: false }).state };
  },
};
