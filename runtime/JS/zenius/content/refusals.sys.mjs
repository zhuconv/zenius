// Content side of the refusals (zen-observe): page APIs whose effect would
// reach past an agent tab fail with the denial a page already handles, and
// the parent is told (a Zenius.refused event). zen-core's page guards
// install them in every new document of a tab the agent drives, before the
// page's scripts. Each call checks again, so a tab handed to the user
// behaves normally.
//
// - fullscreen: fullscreenerror, and a TypeError for the promise (Gecko's
//   own denial); the window never goes fullscreen.
// - pointer lock: pointerlockerror, and a NotAllowedError; the user's cursor
//   is never captured.
// - screen wake lock: NotAllowedError; the user's display may sleep.
// - speech synthesis: an error event on the utterance; nothing is spoken.
// - navigator.share: AbortError, as when the user cancels; no share sheet.
// - the site's storage that outlives the task: serviceWorker.register() and
//   Cache's put, add and addAll reject with SecurityError, as when the user's
//   settings block site data. A service worker or a cached script would stay
//   in the user's profile and run in their own tabs on the site. These
//   hold for the task's whole life, the user's hold included, and in the
//   workers the task's pages start (workerguard.js).
// - the user's devices: while the agent
//   drives the page, the camera, microphone and screen (getUserMedia,
//   mozGetUserMedia, getDisplayMedia, selectAudioOutput) and speech
//   recognition get the denial a page gets
//   when the user says no, and enumerateDevices() lists none: the agent never
//   uses the user's devices. So does a popup an agent-driven page opens,
//   from its first document. A refused request never leaves the page: none
//   reaches MediaManager. Workers have none of these APIs.
// - WebRTC, by the same rule: new RTCPeerConnection() throws
//   NotAllowedError. ICE gathering can raise macOS's Local Network prompt;
//   the parent refuses the pages' requests to the local network
//   (observe/localnet.sys.mjs).
// - on evidence of danger (content/evidence.sys.mjs), all of those and the
//   prompts' APIs: location and MIDI get the user's no, new Notification()
//   gives one that only errs and showNotification() rejects, as where
//   notifications are blocked. That holds during the user's hold too.
//   Otherwise location, MIDI and notifications go on to the prompt layer as
//   on any site (a stored grant applies), and during the hold the devices
//   ask the user. The task's workers refuse notifications for the task's
//   whole life: a worker can't read the hold or the evidence.

// The checks a user's document needs (needsRefusals and the rest) are in the
// leaf content/taskset.sys.mjs, zen-core's, which this module re-exports: a
// user's document never loads this one (I4).
import {
  HELD_PAGES_KEY,
  isAgentCodeDocument,
  isAgentDriven,
  isAgentTaskPage,
  isTaskPopup,
} from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
export {
  AGENT_CODE_DOCS_KEY,
  HELD_PAGES_KEY,
  isAgentCodeDocument,
  isTaskPopup,
  needsRefusals,
} from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";

import { EVIDENCE_REASONS, evidenceOf, isEvident } from "chrome://userscripts/content/zenius/content/evidence.sys.mjs";

// Only a task's pages (and pages that keep the agent's code) use these.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  cut: "chrome://userscripts/content/zenius/observe/textcap.sys.mjs",
  STRING_TEXT: "chrome://userscripts/content/zenius/observe/textcap.sys.mjs",
  installMediaGuard: "chrome://userscripts/content/zenius/content/media.sys.mjs",
  mirrorMethod: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  mirrorGetter: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  mirrorGetterTrap: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  mirrorRefusal: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  mirrorTrap: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  noteWorkerStart: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
  worldSandboxOf: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
});

/** The geolocation refusal's error, made in the agent's world (guardDevices). */
const WORLD_GEOLOCATION_DENIED = `Object.create(
  typeof GeolocationPositionError === "function" ? GeolocationPositionError.prototype : Object.prototype,
  { code: { value: 1 }, message: { value: "User denied geolocation prompt" } }
)`;

/** Documents (WindowGlobalChild) that have the guards. */
const guarded = new WeakSet();

/**
 * Install the guards in the actor's document, once. zen-core's page guards
 * call it for each new document of an agent tab, and for the documents a
 * tab already has when it becomes the agent's (ZeniusService.installGuards).
 * The caller hands the document to the agent's worlds afterwards
 * (adoptIntoWorlds), once all its page-side guards are in.
 *
 * @param {JSWindowActorChild} actor  the Zenius actor of the document
 */
export function installRefusalGuards(actor) {
  const win = actor.contentWindow;
  const doc = actor.manager;
  if (!win || !doc || guarded.has(doc)) {
    return;
  }
  guarded.add(doc);
  // Each constructor guard ends with its wrapper or, if that failed, with
  // the refusing constructor failClosed puts in (`done`). An exception before
  // one of them (the page's stack can run out anywhere here) leaves it to
  // the catch, so none keeps the native.
  const done = new Set();
  /** Guards whose refusing constructor couldn't go in either (failClosed). */
  const missed = [];
  const closed = (name, error) => {
    done.add(name);
    failClosed(actor, win, name, error, missed);
  };
  try {
    installAll(actor, win, doc, { done, closed });
  } catch (e) {
    for (const name of Object.keys(FAILED_CLOSED)) {
      if (!done.has(name)) {
        closed(name, e);
      }
    }
    throw e;
  } finally {
    // Still inside the call that made the document: the page that made it
    // gets control back only after this.
    if (missed.length) {
      takeOutOfReach(actor, missed);
    }
  }
}

/** installRefusalGuards' work; `done` and `closed` are its constructor guards' (failClosed). */
function installAll(actor, win, doc, { done, closed }) {
  simulateFailure("install");
  const page = Cu.waiveXrays(win);
  const bc = actor.browsingContext;
  const agent = () => isAgentDriven(bc);
  /** Kinds, or kind:key pairs, this document reports only once (`once`). */
  const reportedOnce = new Set();
  /** `once`: true for once per kind, or a key for once per kind and key. */
  // `what`, for the devices and notifications: the API (the once-key) and
  // what it asked for in a few words, so zen-ux's card for a page kept with
  // the agent's code needn't read the agent's message.
  const report = (kind, message, once = false, what = null) => {
    if (once) {
      const key = once === true ? kind : `${kind}:${once}`;
      if (reportedOnce.has(key)) {
        return;
      }
      reportedOnce.add(key);
    }
    try {
      actor.emit("observe.refused", { kind, message, url: lazy.cut(String(win.location.href), lazy.STRING_TEXT), ...what });
    } catch {}
  };
  const later = fn =>
    win.setTimeout(() => {
      try {
        fn();
      } catch {}
    }, 0);
  /**
   * Replace `<iface>.prototype[name]` with a function of the same name that
   * runs `refuse` while `applies()`. The agent's worlds that reach this
   * document get the same function (content/agentworld.sys.mjs): their
   * Xrays see only the native. With `worldRefuse`, theirs runs that
   * instead, every time: a world's copy can't be replaced once it's in.
   */
  const guard = (iface, name, refuse, applies = agent, worldRefuse = null) => {
    const proto = page[iface]?.prototype;
    const native = proto?.[name];
    if (typeof native !== "function") {
      return;
    }
    // A named function, so the page sees "function requestFullscreen() { [native code] }".
    const fn = {
      [name]() {
        if (!applies()) {
          return Reflect.apply(native, this, arguments);
        }
        return refuse(this, arguments);
      },
    }[name];
    Cu.exportFunction(fn, proto, { defineAs: name });
    const inWorld = worldRefuse
      ? {
          [name]() {
            return worldRefuse(this, arguments);
          },
        }[name]
      : fn;
    lazy.mirrorMethod(win, `${iface}.prototype`, name, inWorld);
  };
  /**
   * `<iface>.prototype[name]` for the agent's worlds alone: the page keeps
   * what it has (another guard's, or the native).
   */
  const worldGuard = (iface, name, refuse) => {
    if (typeof win[iface]?.prototype?.[name] !== "function") {
      return;
    }
    const fn = {
      [name]() {
        return refuse(this, arguments);
      },
    }[name];
    lazy.mirrorMethod(win, `${iface}.prototype`, name, fn);
  };
  /**
   * The same for the getter `<iface>.prototype[name]`: the page sees
   * "function get <name>() { [native code] }", and the agent's worlds get
   * the same getter, as they do a guard's method.
   */
  const guardGetter = (iface, name, refuse, applies = agent) => {
    const proto = page[iface]?.prototype;
    let desc = null;
    try {
      desc = proto ? Object.getOwnPropertyDescriptor(proto, name) : null;
    } catch {}
    const native = desc?.get;
    if (typeof native !== "function") {
      return;
    }
    const getter = {
      [`get ${name}`]() {
        if (!applies()) {
          return Reflect.apply(native, this, arguments);
        }
        return refuse(this);
      },
    }[`get ${name}`];
    Object.defineProperty(proto, name, {
      get: Cu.exportFunction(getter, proto),
      set: desc.set,
      enumerable: desc.enumerable,
      configurable: true,
    });
    lazy.mirrorGetter(win, `${iface}.prototype`, name, getter);
  };

  const fullscreen = el => {
    report(
      "fullscreen",
      "The page asked for fullscreen. Agent pages never go fullscreen, which would take over the user's screen, so the request was denied (fullscreenerror, and a TypeError for its promise)."
    );
    later(() => el.dispatchEvent(new win.Event("fullscreenerror", { bubbles: true, composed: true })));
    return page.Promise.reject(new page.TypeError("Fullscreen request denied."));
  };
  guard("Element", "requestFullscreen", fullscreen);
  guard("Element", "mozRequestFullScreen", fullscreen);

  guard("Element", "requestPointerLock", el => {
    report(
      "pointerLock",
      "The page asked to lock the pointer. Agent pages never capture the user's cursor, so the request was denied (pointerlockerror, and a NotAllowedError for its promise)."
    );
    const doc = el.ownerDocument;
    later(() => doc.dispatchEvent(new win.Event("pointerlockerror", { bubbles: true })));
    return page.Promise.reject(new page.DOMException("Pointer lock is not allowed in this page.", "NotAllowedError"));
  });

  guard("WakeLock", "request", () => {
    report(
      "wakeLock",
      "The page asked to keep the screen awake. Agent pages may not keep the user's display from sleeping, so the request was denied (NotAllowedError)."
    );
    return page.Promise.reject(new page.DOMException("A screen wake lock is not allowed in this page.", "NotAllowedError"));
  });

  guard("SpeechSynthesis", "speak", (_synth, args) => {
    const utterance = args[0];
    let isUtterance = false;
    try {
      isUtterance = win.SpeechSynthesisUtterance.isInstance(utterance);
    } catch {}
    if (!isUtterance) {
      throw new page.TypeError("SpeechSynthesis.speak: Argument 1 does not implement interface SpeechSynthesisUtterance.");
    }
    report(
      "speech",
      "The page asked to speak aloud (speech synthesis). Agent pages never speak, so the utterance ended with an error event (synthesis-unavailable) and nothing was said."
    );
    // Gecko's SpeechSynthesisErrorCode has no "not-allowed".
    later(() => utterance.dispatchEvent(new win.SpeechSynthesisErrorEvent("error", { utterance, error: "synthesis-unavailable" })));
    return undefined;
  });

  // Starts of playback, for observe/audio.sys.mjs: a muted agent tab tells
  // the agent its sound is off. Gecko calls a muted tab silent, so the
  // parent can't tell by itself. At most one message every two seconds.
  let lastSound = -Infinity;
  // Never throws: it runs inside the page's own calls.
  const sound = () => {
    try {
      const now = ChromeUtils.now();
      if (now - lastSound < 2000 || !agent()) {
        return;
      }
      lastSound = now;
      actor.emit("observe.sound", { url: lazy.cut(String(win.location.href), lazy.STRING_TEXT) });
    } catch {}
  };
  // Media's starts come from the media guard below, which hears them in the
  // document, in shadow trees, and on elements never put in the document
  // (new Audio()). Web Audio has no event to listen to: note the start of every source
  // node (oscillators, buffers) and call through unchanged.
  const nativeStart = page.AudioScheduledSourceNode?.prototype.start;
  if (typeof nativeStart === "function") {
    const start = function start() {
      sound();
      return Reflect.apply(nativeStart, this, arguments);
    };
    Cu.exportFunction(start, page.AudioScheduledSourceNode.prototype, { defineAs: "start" });
    lazy.mirrorMethod(win, "AudioScheduledSourceNode.prototype", "start", start);
  }

  // Audible media pauses while the user can't see the tab (wake locks).
  try {
    lazy.installMediaGuard(actor, {
      agent,
      onPlaying: el => {
        if (!el.muted && el.volume > 0) {
          sound();
        }
      },
      emit: (action, count) => {
        try {
          actor.emit("observe.media", { action, count, url: lazy.cut(String(win.location.href), lazy.STRING_TEXT) });
        } catch {}
      },
    });
  } catch (e) {
    console.error("[zenius] media guard failed", e);
  }

  guard("Navigator", "share", (_nav, args) => {
    let url = "";
    try {
      url = typeof args[0]?.url === "string" ? args[0].url : "";
    } catch {}
    report(
      "share",
      `The page asked to share${url ? ` ${url}` : ""}. Agent pages never open the system share sheet, so the share was cancelled (AbortError).`
    );
    return page.Promise.reject(new page.DOMException("Share canceled.", "AbortError"));
  });

  // The site's storage that outlives the task, for its whole life: the user's
  // hold too, when code the agent left in the page still runs. Once per
  // document and kind: a precache writes dozens of entries.
  const taskPage = () => isTaskDocument(bc);
  const insecure = () => page.Promise.reject(new page.DOMException("The operation is insecure.", "SecurityError"));
  guard(
    "ServiceWorkerContainer",
    "register",
    (_container, args) => {
      let script = "";
      try {
        script = lazy.cut(String(args[0]), lazy.STRING_TEXT);
      } catch {}
      report(
        "serviceWorker",
        `The page tried to register a service worker${script ? ` (${script})` : ""}. It would stay in the user's profile after the task and run in their own tabs on this site, so zenius refused it, and refuses the page's later tries (SecurityError, as when the user's settings block site data).`,
        true
      );
      return insecure();
    },
    taskPage
  );
  for (const name of ["put", "add", "addAll"]) {
    guard(
      "Cache",
      name,
      () => {
        report(
          "cacheStorage",
          `The page tried to write to the site's Cache Storage (Cache.${name}). What it stores there stays after the task and can reach the user's own tabs on this site, so zenius refused the write, and refuses the page's later ones (SecurityError, as when the user's settings block site data).`,
          true
        );
        return insecure();
      },
      taskPage
    );
  }
  guardServiceWorkerAccess(win, page, { report, guard, guardGetter, applies: taskPage });
  // The user's devices and the prompts' APIs: the devices while the
  // agent drives the page, or a popup an agent-driven page opened before the
  // parent makes it the task's; everything on evidence of danger, the user's
  // hold included.
  const opener = taskPopupOpener(bc);
  const agentNow = () => isAgentDriven(bc) || (!!opener && !isAgentTaskPage(bc) && isAgentDriven(opener));
  const evident = () => isEvident(bc);
  const devices = () => evident() || agentNow();
  const why = () => (evident() ? { evidence: evidenceWords(bc) } : { agent: true });
  guardDevices(page, win, { report, later, guard, worldGuard, devices, prompts: evident, why });
  guardNotifications(win, page, { report, guard, applies: evident, why, done, closed });
  guardPeerConnections(win, page, { report, applies: devices, why, done, closed });
  watchWorkers();
  guardSharedWorkers(
    win,
    () => (taskPage() ? { actor, url: () => String(win.location.href), scope: () => channelScope(bc) } : null),
    worker => noteChannel(doc, "worker", worker),
    () =>
      report(
        "localNetwork",
        "The page tried to start a shared worker from a data: URL. Its requests would name neither a page nor a site, so zenius couldn't keep them from the local network: a task's pages start shared workers from the site's scripts or from blob: URLs. zenius refused it (SecurityError).",
        "dataSharedWorker"
      ),
    { done, closed }
  );
  guardBroadcastChannels(
    win,
    () => channelScope(bc),
    channel => noteChannel(doc, "channel", channel),
    { done, closed }
  );
}

/**
 * The page's own BroadcastChannels and shared workers, per document (its
 * WindowGlobalChild), held weakly: muteChannels closes them as the user is
 * about to hold the page. Glue by zen-core.
 *
 * @type {WeakMap<object, Array<{kind: "channel"|"worker", ref: WeakRef<object>}>>}
 */
const pageChannels = new WeakMap();

function noteChannel(owner, kind, obj) {
  let list = pageChannels.get(owner);
  if (!list) {
    pageChannels.set(owner, (list = []));
  }
  // A page may make a channel per message and drop it: forget the ones
  // already collected, so the list stays short.
  if (list.length >= 64) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].ref.deref()) {
        list.splice(i, 1);
      }
    }
  }
  list.push({ kind, ref: new WeakRef(obj) });
}

/**
 * Close the BroadcastChannels and shared-worker ports this document opened.
 * The parent calls it in each document of the page the user is about to hold:
 * opened before the hold, they're in the task's scope (channelScope), so the
 * held page would hear the task's pages, and they it, both ways. What the
 * page opens from then on gets the held scope, and the channels the agent's
 * world opened go with its discard. The site's code keeps working:
 * postMessage on a closed channel would throw (the spec's InvalidStateError),
 * so each closed channel gets an own postMessage that does nothing, and a
 * closed port drops its messages as it is. Glue by zen-core.
 *
 * @returns {{channels: number, workers: number}}
 */
export function muteChannels(actor) {
  const owner = actor.manager;
  const list = pageChannels.get(owner) ?? [];
  pageChannels.delete(owner);
  const win = actor.contentWindow;
  const muted = { channels: 0, workers: 0 };
  for (const { kind, ref } of list) {
    const obj = ref.deref();
    if (!obj) {
      continue;
    }
    try {
      if (kind === "worker") {
        obj.port.close();
        muted.workers++;
        continue;
      }
      obj.close();
      if (win) {
        Object.defineProperty(Cu.waiveXrays(obj), "postMessage", {
          value: Cu.exportFunction(function postMessage() {}, win),
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
      muted.channels++;
    } catch (e) {
      console.error("[zenius] muting a held page's channel failed", e);
    }
  }
  return muted;
}

/**
 * The site's service worker, registered from the user's own tabs, runs for
 * them, outside the task. A task's pages don't use it: the parent keeps
 * their requests from it (observe/swbypass.sys.mjs), and here the page
 * can't reach it either, since a worker can fetch what the page's own
 * requests can't (it has no tab, so the local-network refusal can't place
 * its requests). zenius answers as if the site had none: no registration,
 * a `ready` that never settles, no controller, and a dropped postMessage.
 * Once per document. The workers the page starts get the same answers
 * (workerguard.js).
 *
 * Nor can the site's worker reach the page first. Its
 * `clients.matchAll({ includeUncontrolled: true })` lists a task's documents
 * and workers, and a message it posts them can carry a MessagePort that
 * works both ways. Its messages never arrive: zenius's listener, added
 * before the page's code runs and capturing, so it runs before the page's
 * listeners, `onmessage` and the agent's worlds' (capturing listeners run
 * first at the target), stops each one and closes the ports it carries.
 * Once per document too.
 */
function guardServiceWorkerAccess(win, page, { report, guard, guardGetter, applies }) {
  const said = api =>
    report(
      "serviceWorker",
      `The page tried to reach the site's service worker (${api}). It runs for the user's own tabs on this site, outside the task, so a task's pages don't use it: zenius answered as if the site had none.`,
      "access"
    );
  guard(
    "ServiceWorkerContainer",
    "getRegistration",
    () => {
      said("getRegistration");
      return page.Promise.resolve(undefined);
    },
    applies
  );
  guard(
    "ServiceWorkerContainer",
    "getRegistrations",
    () => {
      said("getRegistrations");
      return page.Promise.resolve(new page.Array());
    },
    applies
  );
  // With no registration, ready never settles.
  guardGetter(
    "ServiceWorkerContainer",
    "ready",
    () => {
      said("ready");
      return page.Promise.race(new page.Array());
    },
    applies
  );
  guardGetter(
    "ServiceWorkerContainer",
    "controller",
    () => {
      said("controller");
      return null;
    },
    applies
  );
  guard(
    "ServiceWorker",
    "postMessage",
    () => {
      said("postMessage");
      return undefined;
    },
    applies
  );
  let container = null;
  try {
    // Through Xrays: the native container, whatever the page does to navigator later.
    container = win.navigator.serviceWorker;
  } catch {}
  if (!container) {
    // Not a secure context: the page has no service workers to hear from.
    return;
  }
  const drop = event => {
    // The page's own dispatched events aren't the site's worker's.
    if (!event.isTrusted || !applies()) {
      return;
    }
    event.stopImmediatePropagation();
    try {
      for (const port of event.ports) {
        port.close();
      }
    } catch {}
    report(
      "serviceWorker",
      "The site's service worker sent the page a message. It runs for the user's own tabs on this site, outside the task, so a task's pages don't use it: zenius dropped the message and closed the ports it carried, as if the site had none.",
      "message"
    );
  };
  try {
    container.addEventListener("message", drop, true);
    container.addEventListener("messageerror", drop, true);
  } catch (e) {
    console.error("[zenius] dropping the site's service worker's messages failed", e);
  }
}

/** What a getUserMedia() call asks for, read through Xrays, so no page getter runs. */
/** What a getUserMedia() call asks for: words for zen-ux ("camera microphone", "screen") and text for the agent. */
function askedOf(constraints) {
  let video = false;
  let audio = false;
  let screen = false;
  try {
    video = !!constraints?.video;
    audio = !!constraints?.audio;
    screen = ["screen", "window", "browser"].includes(constraints?.video?.mediaSource);
  } catch {}
  if (screen) {
    return { words: "screen", text: "the screen" };
  }
  if (video && audio) {
    return { words: "camera microphone", text: "the camera and microphone" };
  }
  if (video || audio) {
    return { words: video ? "camera" : "microphone", text: video ? "the camera" : "the microphone" };
  }
  return { words: "camera microphone", text: "the camera or microphone" };
}

/** The opener of a task's popup (taskset's isTaskPopup), read at the document's start, or null. */
function taskPopupOpener(bc) {
  try {
    return isTaskPopup(bc) ? (bc.top.opener ?? null) : null;
  } catch {
    return null;
  }
}

/** The page's evidence in a few words for the agent: its first reason, with that reason's detail. */
function evidenceWords(bc) {
  const ev = evidenceOf(bc);
  const reason = EVIDENCE_REASONS.find(r => r in ev);
  return !reason ? "evidence" : ev[reason] ? `${reason}: ${ev[reason]}` : reason;
}

/**
 * The user's devices, refused while `devices()`, and location and MIDI
 * while `prompts()`; `why()` says why, for the agent: {evidence: words} or
 * {agent: true}. Each refusal is reported once per document and API, since
 * pages retry.
 */
function guardDevices(page, win, { report, later, guard, worldGuard, devices, prompts, why }) {
  // Gecko's own words for a denied request.
  const notAllowed = () =>
    new page.DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");
  const refused = (api, asked, outcome, words) => {
    const { evidence } = why();
    const head = `The page asked for ${asked} (${api}).`;
    report(
      "deviceAccess",
      evidence !== undefined
        ? `${head} The page shows evidence of danger (${evidence}), so zenius refused it before any prompt (${outcome}), during the user's hold too.`
        : `${head} The agent never uses the user's devices, so zenius refused it before any prompt (${outcome}). If the task needs it, hand the task to the user: while they hold the page, it can ask them.`,
      api,
      { api, asked: words }
    );
  };
  guard(
    "MediaDevices",
    "getUserMedia",
    (_devices, args) => {
      const asked = askedOf(args[0]);
      refused("getUserMedia", asked.text, "NotAllowedError", asked.words);
      return page.Promise.reject(notAllowed());
    },
    devices
  );
  guard(
    "MediaDevices",
    "getDisplayMedia",
    () => {
      refused("getDisplayMedia", "the screen, to record or share it", "NotAllowedError", "screen");
      return page.Promise.reject(notAllowed());
    },
    devices
  );
  guard(
    "MediaDevices",
    "selectAudioOutput",
    () => {
      refused("selectAudioOutput", "a choice of speakers", "NotAllowedError", "speakers");
      return page.Promise.reject(notAllowed());
    },
    devices
  );
  // Answered here, as on a machine without devices: the browser's list
  // would name the user's devices where the site has a grant.
  guard(
    "MediaDevices",
    "enumerateDevices",
    () => {
      const { evidence } = why();
      const head = "The page asked which cameras, microphones and speakers there are (enumerateDevices).";
      report(
        "deviceAccess",
        evidence !== undefined
          ? `${head} The page shows evidence of danger (${evidence}), so zenius answered with an empty list without asking the browser.`
          : `${head} The agent never uses the user's devices, so zenius answered with an empty list without asking the browser.`,
        "enumerateDevices",
        { api: "enumerateDevices", asked: "device list" }
      );
      return page.Promise.resolve(new page.Array());
    },
    devices
  );
  // The legacy callback form.
  guard(
    "Navigator",
    "mozGetUserMedia",
    (_nav, args) => {
      const asked = askedOf(args[0]);
      refused("mozGetUserMedia", asked.text, "its error callback got NotAllowedError", asked.words);
      const onError = args[2];
      if (typeof onError === "function") {
        later(() => onError(notAllowed()));
      }
      return undefined;
    },
    devices
  );

  // A PERMISSION_DENIED error, as when the user blocks location: own,
  // non-enumerable code and message over the interface's prototype, which
  // has no constructor. For the agent's world, made in the world: a page
  // object reaches it through an Xray, which hides that prototype's
  // constants, and a waived prototype would let the page's getters run on
  // the world's reads.
  const denied = onError => {
    const sandbox = lazy.worldSandboxOf(onError);
    if (sandbox) {
      return Cu.evalInSandbox(WORLD_GEOLOCATION_DENIED, sandbox);
    }
    return page.Object.create(
      page.GeolocationPositionError?.prototype ?? page.Object.prototype,
      Cu.cloneInto({ code: { value: 1 }, message: { value: "User denied geolocation prompt" } }, win)
    );
  };
  let watches = 0;
  for (const name of ["getCurrentPosition", "watchPosition"]) {
    guard(
      "Geolocation",
      name,
      (_geolocation, args) => {
        refused(`geolocation.${name}`, "the user's location", "PERMISSION_DENIED", "location");
        const onError = args[1];
        if (typeof onError === "function") {
          later(() => onError(denied(onError)));
        }
        return name === "watchPosition" ? ++watches : undefined;
      },
      prompts
    );
  }

  guard(
    "Navigator",
    "requestMIDIAccess",
    () => {
      refused("requestMIDIAccess", "MIDI devices", "NotAllowedError", "midi");
      return page.Promise.reject(notAllowed());
    },
    prompts
  );

  // A page's own passkey request waits for the user (zen-ux,
  // ui/systemui/ZeniusSystemUiChild.sys.mjs), whose prototype the world's
  // Xrays don't see. The agent's own code gets a no: a passkey is the
  // user's, and the hand-off that wait starts would end the very world that
  // asked.
  for (const name of ["create", "get"]) {
    worldGuard("CredentialsContainer", name, () => {
      report(
        "deviceAccess",
        `The agent's code asked for a passkey (credentials.${name}). A passkey is the user's, so zenius refused it before any prompt (NotAllowedError). If the site's sign-in needs one, click its own button: the page's request then waits for the user.`,
        `credentials.${name}`,
        { api: `credentials.${name}`, asked: "passkey" }
      );
      return page.Promise.reject(notAllowed());
    });
  }

  // Zen turns speech recognition on; it listens through the microphone.
  guard(
    "SpeechRecognition",
    "start",
    recognition => {
      refused("SpeechRecognition.start", "speech recognition, which listens through the microphone", "an error event, not-allowed, then end", "microphone");
      later(() => {
        recognition.dispatchEvent(new win.SpeechRecognitionErrorEvent("error", { error: "not-allowed", message: "" }));
        recognition.dispatchEvent(new win.Event("end"));
      });
      return undefined;
    },
    devices
  );
}

/**
 * A Notification that only errs, as where the user blocks notifications: an
 * EventTarget over Notification.prototype (or newTarget's), with the options
 * as own properties, its own on* handlers and a no-op close(). Made in
 * chrome: the EventTarget, its methods and the event come through the Xray,
 * from the original constructors, and the page's own functions run only as
 * the handlers it sets. workerguard.js has the same in text, for workers.
 */
function fakeNotification(win, Native, title, options, newTarget) {
  const xn = new win.EventTarget();
  const n = Cu.waiveXrays(xn);
  Object.setPrototypeOf(n, newTarget?.prototype || Native.prototype);
  const o = options !== null && typeof options === "object" ? options : {};
  const fields = {
    title,
    dir: o.dir ?? "auto",
    lang: String(o.lang ?? ""),
    body: String(o.body ?? ""),
    tag: String(o.tag ?? ""),
    icon: String(o.icon ?? ""),
    image: String(o.image ?? ""),
    badge: String(o.badge ?? ""),
    data: o.data ?? null,
    silent: o.silent ?? null,
    requireInteraction: !!o.requireInteraction,
    renotify: !!o.renotify,
    timestamp: Date.now(),
    vibrate: Cu.cloneInto([], win),
    actions: Cu.cloneInto([], win),
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(n, key, { value, configurable: true });
  }
  Object.defineProperty(n, "close", { value: Cu.exportFunction(function close() {}, win), writable: true, configurable: true });
  for (const type of ["click", "show", "error", "close"]) {
    let handler = null;
    xn.addEventListener(
      type,
      Cu.exportFunction(e => {
        if (handler) {
          Reflect.apply(handler, n, [e]);
        }
      }, win)
    );
    Object.defineProperty(n, `on${type}`, {
      get: Cu.exportFunction(() => handler, win),
      set: Cu.exportFunction(v => {
        handler = typeof v === "function" ? v : null;
      }, win),
      configurable: true,
    });
  }
  win.setTimeout(() => xn.dispatchEvent(new win.Event("error")), 0);
  return n;
}

// ---------------------------------------------------------------------------
// Failing closed. The four constructor guards below are made in chrome as the
// document is created (wrapInPage). A page that spends its stack and then
// makes a same-origin frame runs the frame's install inside its appendChild
// with little of the stack left; chrome gets more of it than the page's own
// code, so where the page can still make a frame, the install goes in
// (tests/observe/guardfailclosed.test.mjs). An install can still fail, with
// an error, or when Gecko stops the script in a content process that is
// shutting down. A failed guard must not leave the native: the page gets a
// constructor that refuses, made the same way, the agent's worlds get one
// too, and the parent is told. If even that can't go in, a frame is taken out
// of the page that made it.

/** Per constructor: its guard's words, and what its refusing constructor throws. */
const FAILED_CLOSED = {
  Notification: { guard: "notification", error: "TypeError", message: "Permission to show Notification denied." },
  RTCPeerConnection: {
    guard: "WebRTC",
    error: "NotAllowedError",
    message: "The request is not allowed by the user agent or the platform in the current context.",
  },
  SharedWorker: { guard: "shared worker", error: "SecurityError", message: "The operation is insecure." },
  BroadcastChannel: { guard: "broadcast channel", error: "SecurityError", message: "The operation is insecure." },
};

/**
 * Why a guard's install threw. NS_ERROR_OUT_OF_MEMORY with no exception of a
 * script's: Gecko stopped the script, as it does in a content process that is
 * shutting down (the navigation cancel never stops chrome's). Or the page's
 * stack ran out, or another error.
 *
 * @returns {{kind: "stopped"|"stack"|"error", words: string}}
 */
function failureCause(e) {
  if (e?.result === Cr.NS_ERROR_OUT_OF_MEMORY) {
    return { kind: "stopped", words: "Gecko stopped its script, as it does in a content process that is shutting down" };
  }
  let name = "";
  let message = "";
  try {
    name = String(e?.name ?? "");
    message = String(e?.message ?? e);
  } catch {}
  if (name === "InternalError" && message.includes("too much recursion")) {
    return { kind: "stack", words: "the page's stack was nearly spent (too much recursion)" };
  }
  return { kind: "error", words: message.slice(0, 200) || "an error" };
}

/**
 * The guard of constructor `name` failed with `error`. The page gets a `name`
 * that refuses, and the agent's worlds too, and the parent hears of it. Those
 * steps enter the page's realm, which has the page's stack limit too. If even
 * they fail, the guard joins `missed`, and the install's end takes the
 * document out of reach (takeOutOfReach).
 */
function failClosed(actor, win, name, error, missed) {
  const what = FAILED_CLOSED[name];
  const cause = failureCause(error);
  let outcome;
  try {
    if (simulated(name)?.fallback) {
      throw new Error("zenius.test.failPageGuard");
    }
    outcome = refuseInPage(win, name, refusal(win, what)) ? "refusing" : "absent";
    lazy.mirrorRefusal(win, name, worldRefusal(win, what));
  } catch (e) {
    missed.push({ name, cause, error, why: failureCause(e).words });
    return;
  }
  const words = outcome === "refusing" ? `The page's ${name} refuses.` : `The page has no ${name}.`;
  console.error(`[zenius] the ${what.guard} guard failed: ${cause.words}. ${words}`, error);
  tellGuardFailed(actor, name, cause.kind, outcome);
}

/**
 * The guards in `missed` couldn't even put a refusing constructor in: take
 * the document out of reach (outOfReach), once, after its whole install.
 * The parent hears first, since a frame taken out takes its actor along.
 */
function takeOutOfReach(actor, missed) {
  const last = outOfReach(actor);
  const words = {
    removed: "the frame is taken out of its page",
    closed: "the window is closed",
    native: "the document keeps the native",
  }[last.outcome];
  for (const { name, cause, error, why } of missed) {
    console.error(
      `[zenius] the ${FAILED_CLOSED[name].guard} guard failed: ${cause.words}. Its refusing ${name} couldn't go in either (${why}), so ${words}.`,
      error
    );
    tellGuardFailed(actor, name, cause.kind, last.outcome);
  }
  try {
    last.act?.();
  } catch (e) {
    console.error("[zenius] a document whose guard failed couldn't be taken out", e);
    for (const { name, cause } of missed) {
      tellGuardFailed(actor, name, cause.kind, "native");
    }
  }
}

/** Tell the parent (observe.guardFailed) how the guard of `name` failed and what the document has now. */
function tellGuardFailed(actor, name, cause, outcome) {
  try {
    // The URL through the document's Xray, which runs in chrome's realm: the
    // page's location would enter the page's, on its spent stack.
    const url = lazy.cut(String(actor.document?.documentURIObject?.spec ?? ""), lazy.STRING_TEXT);
    actor.emit("observe.guardFailed", { guard: name, cause, outcome, url });
  } catch (e) {
    console.error("[zenius] the parent couldn't be told that a guard failed", e);
  }
}

/** A refusing constructor's construct trap: it throws `what`'s error, made in the page's realm. */
function refusal(win, what) {
  return () => {
    const page = Cu.waiveXrays(win);
    throw what.error === "TypeError" ? new page.TypeError(what.message) : new page.DOMException(what.message, what.error);
  };
}

/**
 * The worlds' refusal of a constructor whose guard failed: `what`'s error,
 * made where the agent's code reads it. A TypeError made in the page's realm
 * reaches a world through an Xray that can't read its message, so it's the
 * world's own (`caller`, callerIn). A DOMException's message reads through
 * the Xray, which makes it without running the page's DOMException.
 */
function worldRefusal(win, what) {
  return caller => {
    throw what.error === "TypeError" ? new caller.TypeError(what.message) : new win.DOMException(what.message, what.error);
  };
}

/**
 * Put a `name` that refuses (`refuse`, its trap) in the page, over the one it
 * has (wrapInPage). Returns false when the page has no `name`.
 */
function refuseInPage(win, name, refuse) {
  return !!wrapInPage(win, name, () => refuse());
}

/**
 * Wrap the page's constructor `name`, made in chrome with no script, as
 * zen-ux's notification guard builds its own: the page's Proxy, with a
 * handler that has no prototype and `trap` (chrome's) as its construct trap,
 * so its statics, prototype and instanceof stay, and its prototype's
 * constructor is the Proxy too. No realm the page can reach holds anything
 * the trap looks up: it runs in chrome, with chrome's built-ins.
 * `trap(target, args, newTarget, caller)` gets the arguments waived, the
 * target as newTarget when the page constructs the Proxy itself, and
 * `caller`, what it makes in the page's realm: `TypeError`, through the
 * Xray, so the original constructor runs, and `construct`, chrome's
 * Reflect.construct, which calls the waived native in the page's realm.
 * The agent's worlds give their traps their own (agentworld's callerIn).
 * Returns the Proxy, or null when the page has no `name`.
 */
function wrapInPage(win, name, trap) {
  const page = Cu.waiveXrays(win);
  const Native = page[name];
  if (typeof Native !== "function") {
    return null;
  }
  const caller = { TypeError: win.TypeError, construct: Reflect.construct };
  const handler = page.Object.create(null);
  let wrapped = null;
  handler.construct = Cu.exportFunction((target, args, newTarget) => {
    const own = Cu.waiveXrays(target);
    const nt = Cu.waiveXrays(newTarget);
    return trap(own, Cu.waiveXrays(args), nt === wrapped ? own : nt, caller);
  }, win);
  wrapped = new page.Proxy(Native, handler);
  Object.defineProperty(page, name, { value: wrapped, writable: true, enumerable: false, configurable: true });
  // Nor through the prototype: X.prototype.constructor would be the native.
  Object.defineProperty(Native.prototype, "constructor", { value: wrapped, writable: true, enumerable: false, configurable: true });
  return wrapped;
}

/**
 * `${value}` in a trap, as the native's own conversion goes: the caller's
 * toString runs, and what it throws goes back as it is. A symbol's
 * TypeError, made here in chrome, is made again in the caller's realm
 * (`caller`, wrapInPage's): an error made in chrome reaches the page or the
 * agent's world as an InvalidStateError.
 */
function asString(value, caller) {
  try {
    return `${value}`;
  } catch (e) {
    if (e instanceof TypeError) {
      throw new caller.TypeError(e.message);
    }
    throw e;
  }
}

/**
 * The last step, when not even a refusing constructor could go in: take the
 * document out of reach of the page that made it. A frame's element leaves
 * its parent through an Xray, a call that runs in chrome's realm and so on
 * chrome's stack limit; the frame's window is made inside the page's
 * appendChild, so the page finds none when that returns. A popup, which the
 * page that opened it can reach, is closed; that takes effect only when the
 * parent closes its tab, after the opener's script yields. Any other
 * top-level document, a tab's own, keeps the native: closing a tab the user
 * or the task opened would cost more than it saves. Returns the outcome, and
 * the act that takeOutOfReach runs once the parent is told.
 *
 * @returns {{outcome: "removed"|"closed"|"native", act?: () => void}}
 */
function outOfReach(actor) {
  try {
    const bc = actor.browsingContext;
    const frame = bc?.embedderElement;
    if (frame) {
      return { outcome: "removed", act: () => frame.remove() };
    }
    if (bc && !bc.parent && bc.opener) {
      return { outcome: "closed", act: () => actor.contentWindow?.close() };
    }
  } catch (e) {
    console.error("[zenius] a document whose guard failed couldn't be taken out", e);
  }
  return { outcome: "native" };
}

/**
 * Tests only: integer preference zenius.test.failPageGuard.<name> makes the
 * guard of constructor <name> fail as if its script had: 1 with an error, 2
 * as when Gecko stops the script, 3 with too much recursion, plus 8 when the
 * refusing constructor can't go in either. <name> "install" fails the whole
 * install before any guard. Integers, since Gecko blanks a string preference
 * of no default in a web content process. zenius never sets these.
 *
 * @returns {{kind: "error"|"stopped"|"stack", fallback: boolean}|null}
 */
function simulated(name) {
  let n = 0;
  try {
    n = Services.prefs.getIntPref(`zenius.test.failPageGuard.${name}`, 0);
  } catch {}
  if (!n) {
    return null;
  }
  return { kind: { 2: "stopped", 3: "stack" }[n & 3] ?? "error", fallback: (n & 8) !== 0 };
}

/** Throw as constructor `name`'s guard script would have, when the tests ask (simulated). */
function simulateFailure(name) {
  const how = simulated(name);
  if (!how) {
    return;
  }
  if (how.kind === "stopped") {
    throw Components.Exception("zenius.test.failPageGuard", Cr.NS_ERROR_OUT_OF_MEMORY);
  }
  throw how.kind === "stack" ? new InternalError("too much recursion") : new Error("zenius.test.failPageGuard");
}

/**
 * Notifications, refused while `applies()` (on evidence of danger), even
 * where the site has the user's grant: one would show on the user's desktop.
 * While the agent drives, zen-ux's guard keeps a granted site's quiet
 * (ui/systemui/ZeniusSystemUiChild.sys.mjs).
 *
 * The agent's own code gets a no every time, as for a passkey: the world's
 * Xrays don't see zen-ux's quiet one, so it would reach the native, and the
 * agent has nothing of its own to show on the user's desktop.
 */
function guardNotifications(win, page, { report, guard, applies, why, done, closed }) {
  const refused = api =>
    `The page tried to show a notification (${api}). The page shows evidence of danger (${why().evidence ?? "evidence"}), so zenius refused it (${api === "showNotification" ? "a TypeError" : "an error event"}, as where notifications are blocked), during the user's hold too.`;
  /**
   * The agent's no: NotAllowedError, as for its passkeys, and not the
   * page's TypeError. A JS error made in the page's realm reaches the world
   * through an Xray that can't read its message; a DOMException's it can.
   * Made through the Xray, so the page's own DOMException never runs.
   */
  const agentRefused = api => {
    report(
      "notification",
      `The agent's code tried to show a notification (${api}). A notification shows on the user's desktop, so zenius refused it (NotAllowedError).`,
      `agent ${api}`,
      { api: api === "showNotification" ? "showNotification" : "Notification", asked: "notifications" }
    );
    return new win.DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");
  };
  guard(
    "ServiceWorkerRegistration",
    "showNotification",
    () => {
      report("notification", refused("showNotification"), "showNotification", { api: "showNotification", asked: "notifications" });
      return page.Promise.reject(new page.TypeError("Permission to show Notification denied."));
    },
    applies,
    () => page.Promise.reject(agentRefused("showNotification"))
  );
  if (typeof page.Notification !== "function") {
    return;
  }
  try {
    simulateFailure("Notification");
    const refusedNow = () => {
      if (!applies()) {
        return false;
      }
      report("notification", refused("new Notification"), "Notification", { api: "Notification", asked: "notifications" });
      return true;
    };
    wrapInPage(win, "Notification", (target, args, newTarget, caller) => {
      // Without a title the native throws its TypeError, as it should.
      if (args.length < 1 || !refusedNow()) {
        return caller.construct(target, args, newTarget);
      }
      return fakeNotification(win, target, asString(args[0], caller), args[1], newTarget);
    });
    // The worlds' one refuses outright (agentRefused).
    lazy.mirrorRefusal(win, "Notification", () => {
      throw agentRefused("new Notification");
    });
    done.add("Notification");
  } catch (e) {
    closed("Notification", e);
  }
}

/**
 * WebRTC, refused while `applies()` (the agent drives, or evidence): ICE
 * gathering reads the machine's local network addresses and can raise
 * macOS's Local Network prompt, whose answer covers the user's whole
 * browser. Fingerprinting scripts make one on many sites.
 */
function guardPeerConnections(win, page, { report, applies, why, done, closed }) {
  if (typeof page.RTCPeerConnection !== "function") {
    return;
  }
  try {
    simulateFailure("RTCPeerConnection");
    const refused = () => {
      if (!applies()) {
        return false;
      }
      const { evidence } = why();
      const head = "The page tried to open a WebRTC connection (new RTCPeerConnection).";
      report(
        "localNetwork",
        evidence !== undefined
          ? `${head} The page shows evidence of danger (${evidence}), so zenius refused it (NotAllowedError), during the user's hold too.`
          : `${head} WebRTC gathers the machine's local network addresses, which can make macOS ask the user about the local network for their whole browser, so the agent's pages can't use it (NotAllowedError). If the task needs a call, hand the task to the user: while they hold the page, it can connect.`,
        "RTCPeerConnection"
      );
      return true;
    };
    // In the page and in the agent's worlds alike. The DOMException through
    // the Xray: the original constructor, never one the page put there.
    const trap = (target, args, newTarget, caller) => {
      if (refused()) {
        throw new win.DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");
      }
      return caller.construct(target, args, newTarget);
    };
    wrapInPage(win, "RTCPeerConnection", trap);
    lazy.mirrorTrap(win, "RTCPeerConnection", trap);
    done.add("RTCPeerConnection");
  } catch (e) {
    closed("RTCPeerConnection", e);
  }
}

/**
 * A document of an agent task's page, whoever holds it, of a popup one
 * opened, or of a tab whose top document ran the agent's code, until that
 * document is replaced.
 */
function isTaskDocument(bc) {
  return isAgentTaskPage(bc) || isTaskPopup(bc) || isAgentCodeDocument(bc);
}

/** The fragment that gives a task's page a shared worker of its own. */
const SHARED_MARK = "zenius-agent";
/**
 * The marks of the shared workers a task's documents start: "zenius-" and
 * the document's channel scope (channelScope), so each task, each hold, and
 * the pages kept with the agent's code after their tasks have workers of
 * their own.
 */
const SCOPED_MARKS = ["zenius-task-", "zenius-held-"];

/**
 * A shared worker is shared with every tab of the site, the user's too. A
 * page of an agent task that connects to one the user's tab started could ask
 * it to write for it. So in such a page, `new SharedWorker()` gets a worker
 * of the task's own: zenius adds a fragment to the script URL, so Gecko
 * starts a separate worker, and the worker watcher puts the refusals in it.
 * The page's code works as before; only the sharing with the user's tabs is
 * gone, and the worker sees the fragment in `self.location`.
 *
 * The wrapper is made in chrome (wrapInPage), so the page constructs through
 * it as usual, and SharedWorker.prototype.constructor is the wrapper too. It
 * converts the URL to a string once, in chrome (asString), and hands that
 * string to both the check and the native.
 *
 * A data: shared worker is refused (SecurityError, `refusedData`): it has an
 * opaque origin, so its requests name neither a tab, a mark nor a site, and
 * the local-network refusal couldn't place them. A blob: one's name its
 * site (observe/localnet.sys.mjs, blobWorkerSite).
 */
function guardSharedWorkers(win, ownerNow, noted, refusedData, { done, closed }) {
  const page = Cu.waiveXrays(win);
  if (typeof page.SharedWorker !== "function") {
    return;
  }
  try {
    simulateFailure("SharedWorker");
    /**
     * The script URL to start the worker with: the task's own, null for the
     * page's own as given (not a task's page now, or not a URL), or false
     * for a refused one (data:).
     */
    const ownURL = scriptURL => {
      const owner = ownerNow();
      if (!owner) {
        return null;
      }
      try {
        const uri = Services.io.newURI(scriptURL, null, win.document.baseURIObject);
        if (uri.schemeIs("data")) {
          try {
            refusedData?.();
          } catch {}
          return false;
        }
        // The task's own worker, or the hold's, as its channels are.
        const scope = owner.scope?.() || "agent";
        const mark = `zenius-${scope}`;
        const marked = uri
          .mutate()
          .setRef(uri.hasRef ? `${uri.ref}&${mark}` : mark)
          .finalize().spec;
        noteSharedWorker(marked, owner);
        return marked;
      } catch {
        return null;
      }
    };
    // In the page and in the agent's worlds alike (wrapInPage, mirrorTrap).
    const trap = (target, args, newTarget, caller) => {
      if (args.length === 0) {
        return caller.construct(target, args, newTarget);
      }
      // Read once, here: chrome's check and the native get the same string.
      const url = asString(args[0], caller);
      const own = ownURL(url);
      if (own === false) {
        throw new win.DOMException("The operation is insecure.", "SecurityError");
      }
      // The native reads its options itself; it ignores what comes after.
      const list = [own === null ? url : own];
      if (args.length > 1) {
        list.push(args[1]);
      }
      const worker = caller.construct(target, list, newTarget);
      try {
        noted?.(Cu.unwaiveXrays(worker));
      } catch {}
      return worker;
    };
    wrapInPage(win, "SharedWorker", trap);
    lazy.mirrorTrap(win, "SharedWorker", trap);
    done.add("SharedWorker");
  } catch (e) {
    closed("SharedWorker", e);
  }
}

/**
 * Which task each task tab is a page of (browserId → space id), published
 * by observe/setup.sys.mjs as tabs join and leave tasks.
 */
export const TASK_SPACES_KEY = "zenius:taskSpaces";

/**
 * The scope a document's BroadcastChannel names get, or null for the page's
 * own names. A task's page, or a popup on its way to be one: its task's. A
 * document that keeps the agent's code after its task: the agents' own, which
 * no tab of the user's joins either.
 */
function channelScope(bc) {
  if (!isTaskDocument(bc)) {
    return null;
  }
  let top = null;
  try {
    top = bc.top;
  } catch {}
  // A page the user holds talks only to itself: the site's own cross-tab
  // sync would carry what the user types to the task's other pages.
  const hold = Services.cpmm.sharedData.get(HELD_PAGES_KEY)?.get?.(top?.browserId);
  if (hold !== undefined) {
    return `held-${hold}`;
  }
  const spaces = Services.cpmm.sharedData.get(TASK_SPACES_KEY);
  for (let depth = 0; top && depth < 8; depth++) {
    const space = spaces?.get?.(top.browserId);
    if (space !== undefined) {
      return `task-${space}`;
    }
    let opener = null;
    try {
      opener = top.opener;
    } catch {}
    top = opener?.top ?? null;
  }
  return "agent";
}

/**
 * The BroadcastChannel wrapper, for pages (guardBroadcastChannels) and the
 * workers they start (workerguard.js gets it with the scope): given the
 * native constructor and a function that answers the scope, it returns the
 * constructor the realm gets. A channel's name carries the scope after a NUL
 * and "zenius-"; the name getter gives the page back its own name. Its
 * handlers have no prototype: code in the realm (a worker's own, or the
 * agent's in its world) could give Object.prototype the traps they lack,
 * and a trap gets the native.
 * `noted`, in pages only, gets each channel for the channel mute.
 */
const CHANNEL_GUARD = `function zeniusChannelGuard(Native, scopeOf, noted) {
  if (typeof Native !== "function") {
    return null;
  }
  const construct = Reflect.construct;
  const apply = Reflect.apply;
  const slice = Array.prototype.slice;
  const lastIndexOf = String.prototype.lastIndexOf;
  const cut = String.prototype.slice;
  const MARK = "\\u0000zenius-";
  const wrapped = new Proxy(Native, {
    __proto__: null,
    construct(target, args, newTarget) {
      const as = newTarget === wrapped ? target : newTarget;
      if (args.length === 0) {
        return construct(target, args, as);
      }
      const name = \`\${args[0]}\`;
      const scope = scopeOf();
      const channel = construct(target, [scope ? name + MARK + scope : name, ...apply(slice, args, [1])], as);
      if (noted) {
        try {
          noted(channel);
        } catch {}
      }
      return channel;
    },
  });
  const desc = Object.getOwnPropertyDescriptor(Native.prototype, "name");
  if (desc && typeof desc.get === "function") {
    const getter = new Proxy(desc.get, {
      __proto__: null,
      apply(target, self, args) {
        const name = apply(target, self, args);
        const at = apply(lastIndexOf, name, [MARK]);
        return at < 0 ? name : apply(cut, name, [0, at]);
      },
    });
    Object.defineProperty(Native.prototype, "name", { get: getter, set: undefined, enumerable: desc.enumerable, configurable: true });
  }
  Object.defineProperty(Native.prototype, "constructor", { value: wrapped, writable: true, enumerable: false, configurable: true });
  return wrapped;
}`;

/** What a channel's name carries before its scope: a NUL, then "zenius-", as CHANNEL_GUARD's MARK. */
const CHANNEL_MARK = `${String.fromCharCode(0)}zenius-`;

/**
 * A task shares the user's container (SPEC §3.4), so a BroadcastChannel joins
 * every same-site document of the profile, the user's open tabs too, both
 * ways: data, but data the site's code in the user's tab acts on, with that
 * tab's grants (tests/snapshot/tools/channels-probe.mjs). In a task's
 * documents a channel's name gets the task's scope (channelScope), so task
 * pages hear only each other. As for the peer connection, the wrapper is
 * made in chrome (wrapInPage), and so is the getter that gives the page and
 * the agent's worlds their own names back.
 */
function guardBroadcastChannels(win, scopeNow, noted, { done, closed }) {
  const page = Cu.waiveXrays(win);
  if (typeof page.BroadcastChannel !== "function") {
    return;
  }
  try {
    simulateFailure("BroadcastChannel");
    const proto = page.BroadcastChannel.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "name");
    const trap = (target, args, newTarget, caller) => {
      if (args.length === 0) {
        return caller.construct(target, args, newTarget);
      }
      const name = asString(args[0], caller);
      const scope = scopeNow();
      // The native takes one argument and ignores the rest.
      const channel = caller.construct(target, [scope ? name + CHANNEL_MARK + scope : name], newTarget);
      try {
        noted?.(Cu.unwaiveXrays(channel));
      } catch {}
      return channel;
    };
    wrapInPage(win, "BroadcastChannel", trap);
    lazy.mirrorTrap(win, "BroadcastChannel", trap);
    if (typeof desc?.get === "function") {
      const ownName = (get, self, args) => {
        const name = Reflect.apply(get, self, args);
        const at = typeof name === "string" ? name.lastIndexOf(CHANNEL_MARK) : -1;
        return at < 0 ? name : name.slice(0, at);
      };
      const native = desc.get;
      // A named function, as the native is, for the page.
      const getter = {
        "get name"() {
          return ownName(native, this, arguments);
        },
      }["get name"];
      Object.defineProperty(proto, "name", {
        get: Cu.exportFunction(getter, proto),
        set: desc.set,
        enumerable: desc.enumerable,
        configurable: true,
      });
      // Each world's wraps its own native, whose errors are the world's.
      lazy.mirrorGetterTrap(win, "BroadcastChannel.prototype", "name", ownName);
    }
    done.add("BroadcastChannel");
  } catch (e) {
    closed("BroadcastChannel", e);
  }
}

// ---------------------------------------------------------------------------
// Workers: Cache Storage is exposed in them, and Gecko lets a dedicated worker
// register a service worker too. A worker a page of an agent task starts gets
// the same refusals in its own realm, through Gecko's worker debugger API:
// the worker is held at its start, workerguard.js puts the refusals in, and
// then it runs. Dedicated workers (nested ones too) and shared workers count;
// the site's own service workers don't, since the page can't register one.
// A worker keeps its refusals for its whole life, even past the task.

const WORKER_GUARD_URL = "chrome://userscripts/content/zenius/content/workerguard.js";

/** What a worker tried, by the kind workerguard.js reports. */
const WORKER_REFUSALS = {
  serviceWorker:
    "register a service worker. It would stay in the user's profile after the task and run in their own tabs on this site, so zenius refused it, and refuses the worker's later tries (SecurityError, as when the user's settings block site data).",
  cacheStorage:
    "write to the site's Cache Storage. What it stores there stays after the task and can reach the user's own tabs on this site, so zenius refused it, and refuses the worker's later tries (SecurityError, as when the user's settings block site data).",
  notification:
    "show a notification. A task's pages and their workers never show notifications on the user's desktop, even where the site may, so zenius refused it (an error event, or a TypeError from showNotification, as where notifications are blocked).",
};

/** The notification APIs a worker's refusal may name (workerguard.js). */
const WORKER_NOTIFICATION_APIS = new Set(["Notification", "showNotification"]);

/**
 * The calls a worker's reach for the site's own service worker may name
 * (workerguard.js, "serviceWorkerAccess"). It's reported as serviceWorker,
 * apart from a refused registration, as in the page.
 */
const WORKER_SERVICE_WORKER_APIS = new Set(["getRegistration", "getRegistrations", "ready", "controller", "postMessage"]);
/** The site's service worker's message that a worker's guard dropped (workerguard.js), reported once per worker as serviceWorker. */
const workerServiceWorkerMessage = workerURL =>
  `The site's service worker sent a worker the page started (${workerURL}) a message. It runs for the user's own tabs on this site, outside the task, so a task's pages and their workers don't use it: zenius dropped the message and closed the ports it carried, as if the site had none.`;
const workerServiceWorkerAccess = api =>
  `reach the site's service worker (${api}). It runs for the user's own tabs on this site, outside the task, so a task's pages and their workers don't use it: zenius answered as if the site had none.`;

/** Guarded workers (nsIWorkerDebugger.id) → where their refusals are reported, their URL, and the mark of one with no tab (workerMark). */
const guardedWorkers = new Map();
let watchingWorkers = false;

/** Shared worker scripts that pages of agent tasks just started → where to report, until when. */
const pendingShared = new Map();
const PENDING_SHARED_MS = 10000;

/** The marks in a shared worker's script URL's fragment. */
function sharedMarks(url) {
  const hash = url.indexOf("#");
  return hash < 0 ? [] : url.slice(hash + 1).split("&").filter(part => part === SHARED_MARK || SCOPED_MARKS.some(m => part.startsWith(m)));
}

function isMarkedShared(url) {
  return sharedMarks(url).length > 0;
}

/** The channel scope of a marked shared worker, from its mark: a task's, a hold's, or the agents'. */
function sharedScope(url) {
  const mark = sharedMarks(url).find(part => part !== SHARED_MARK);
  return mark ? mark.slice("zenius-".length) : "agent";
}

function noteSharedWorker(url, owner) {
  const now = Date.now();
  for (const [key, entry] of pendingShared) {
    if (entry.until < now) {
      pendingShared.delete(key);
    }
  }
  pendingShared.set(url, { owner, until: now + PENDING_SHARED_MS });
}

/** The Zenius actor of a page of an agent task (or of its popup), by its window global, or null. */
function taskActorOf(windowGlobal) {
  try {
    return windowGlobal && isTaskDocument(windowGlobal.browsingContext) ? windowGlobal.getActor("Zenius") : null;
  } catch {
    return null;
  }
}

/** Where a new worker's refusals go: null if no page of an agent task started it. */
function workerOwner(dbg) {
  const { TYPE_DEDICATED, TYPE_SHARED } = Ci.nsIWorkerDebugger;
  if (dbg.type === TYPE_DEDICATED) {
    let parent = null;
    try {
      parent = dbg.parent;
    } catch {}
    if (parent) {
      // A nested worker: guarded if the worker that started it is.
      return guardedWorkers.get(parent.id)?.owner ?? null;
    }
    let windowGlobal = null;
    try {
      windowGlobal = dbg.window?.windowGlobalChild ?? null;
    } catch {}
    const actor = taskActorOf(windowGlobal);
    // The page that started it (a WindowGlobalChild has no documentURI).
    const url = () => {
      try {
        return String(dbg.window?.document?.documentURI ?? "");
      } catch {
        return "";
      }
    };
    return actor ? { actor, url, scope: () => channelScope(windowGlobal.browsingContext) } : null;
  }
  if (dbg.type === TYPE_SHARED) {
    // A shared worker is the agent's when a task's page started it: its
    // script URL carries the task's mark (guardSharedWorkers), so the user's
    // tabs never share it. The debugger's url is the string the page's
    // constructor passed.
    const url = String(dbg.url ?? "");
    const pending = pendingShared.get(url);
    if (pending && pending.until >= Date.now()) {
      pendingShared.delete(url);
      return pending.owner;
    }
    if (isMarkedShared(url)) {
      // Started for a page of another process, or noted too long ago:
      // refused all the same, with no page to tell.
      return { actor: null, url: () => "", scope: () => sharedScope(url) };
    }
  }
  return null;
}

/**
 * The mark of a worker with no tab: a task's shared worker's, from its
 * script URL (guardSharedWorkers), or for a worker one started, the mark of
 * the worker that started it. Its requests name no tab; the mark in their
 * loading principal is what shows whose they are (observe/swbypass.sys.mjs),
 * so workerguard.js puts it in the URL of each worker this one starts. Null
 * for a page's own workers, whose requests name the page's tab.
 */
function workerMark(dbg) {
  if (dbg.type === Ci.nsIWorkerDebugger.TYPE_SHARED) {
    return sharedMarks(String(dbg.url ?? ""))[0] ?? null;
  }
  let parent = null;
  try {
    parent = dbg.parent;
  } catch {}
  return parent ? (guardedWorkers.get(parent.id)?.mark ?? null) : null;
}

/**
 * A worker's URL, whole: the debugger's url is the string the page or the
 * worker passed to the constructor, so a relative one is resolved against
 * the URL of the worker that started it, or the page's (zen-snapshot's
 * note: reports named some workers relative).
 */
function absoluteWorkerURL(dbg, owner) {
  const url = String(dbg.url ?? "");
  let base = null;
  try {
    base = dbg.parent ? (guardedWorkers.get(dbg.parent.id)?.url ?? null) : null;
  } catch {}
  try {
    base ??= owner.url?.() || null;
  } catch {}
  try {
    return base ? new URL(url, base).href : url;
  } catch {
    return url;
  }
}

function guardWorker(dbg, owner) {
  if (dbg.isInitialized) {
    // Devtools got there first (the user is debugging it): theirs, unguarded.
    return;
  }
  const id = dbg.id;
  const reportedKinds = new Set();
  const mark = workerMark(dbg);
  const url = absoluteWorkerURL(dbg, owner);
  guardedWorkers.set(id, { owner, mark, url });
  const workerURL = lazy.cut(url, lazy.STRING_TEXT);
  dbg.setDebuggerReady(false);
  dbg.addListener({
    onMessage(text) {
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {}
      if (message?.ready === true) {
        dbg.setDebuggerReady(true);
      } else if (message && "ready" in message) {
        // Never run a worker the refusals aren't in: it stays held.
        console.error(`[zenius] a worker of an agent task stays held, its storage guard failed: ${message.error}`);
      } else if (message?.refused === "serviceWorkerAccess" && !reportedKinds.has(message.refused)) {
        reportedKinds.add(message.refused);
        const api = WORKER_SERVICE_WORKER_APIS.has(message.api) ? message.api : "navigator.serviceWorker";
        try {
          owner.actor?.emit("observe.refused", {
            kind: "serviceWorker",
            message: `A worker the page started (${workerURL}) tried to ${workerServiceWorkerAccess(api)}`,
            url: lazy.cut(owner.url(), lazy.STRING_TEXT),
          });
        } catch {}
      } else if (message?.refused === "serviceWorkerMessage" && !reportedKinds.has(message.refused)) {
        reportedKinds.add(message.refused);
        try {
          owner.actor?.emit("observe.refused", {
            kind: "serviceWorker",
            message: workerServiceWorkerMessage(workerURL),
            url: lazy.cut(owner.url(), lazy.STRING_TEXT),
          });
        } catch {}
      } else if (typeof message?.refused === "string" && Object.hasOwn(WORKER_REFUSALS, message.refused) && !reportedKinds.has(message.refused)) {
        reportedKinds.add(message.refused);
        try {
          owner.actor?.emit("observe.refused", {
            kind: message.refused,
            message: `A worker the page started (${workerURL}) tried to ${WORKER_REFUSALS[message.refused]}`,
            url: lazy.cut(owner.url(), lazy.STRING_TEXT),
            // As the page's own notification refusals carry them.
            ...(message.refused === "notification" && WORKER_NOTIFICATION_APIS.has(message.api) ? { api: message.api, asked: "notifications" } : null),
          });
        } catch {}
      }
    },
    onClose() {
      guardedWorkers.delete(id);
    },
    onError(filename, lineno, message) {
      console.error(`[zenius] the storage guard of a worker of an agent task: ${message} (${filename}:${lineno})`);
    },
  });
  dbg.initialize(WORKER_GUARD_URL);
  // workerguard.js reports ready only once it has these: the worker stays
  // held until its channels are scoped, and a worker with no tab marks the
  // workers it starts, too.
  let scope = "agent";
  try {
    scope = owner.scope?.() ?? scope;
  } catch {}
  dbg.postMessage(JSON.stringify({ channelScope: scope, channelGuard: CHANNEL_GUARD, workerMark: mark }));
}

/**
 * A dedicated worker a page's window starts from the agent's world makes the
 * page written (agentworld's noteWorkerStart). Its registration comes while
 * its constructor runs. A nested worker's comes later, from its parent's
 * thread, and the parent counted already.
 */
function noteWorldWorker(dbg) {
  try {
    if (dbg.type !== Ci.nsIWorkerDebugger.TYPE_DEDICATED || dbg.parent) {
      return;
    }
    const win = dbg.window;
    if (win) {
      lazy.noteWorkerStart(win);
    }
  } catch (e) {
    console.error("[zenius] counting a worker of the agent's world", e);
  }
}

/** Once per content process: guard the workers that pages of agent tasks start. */
function watchWorkers() {
  if (watchingWorkers) {
    return;
  }
  watchingWorkers = true;
  try {
    const manager = Cc["@mozilla.org/dom/workers/workerdebuggermanager;1"].getService(Ci.nsIWorkerDebuggerManager);
    manager.addListener({
      onRegister(dbg) {
        try {
          const owner = workerOwner(dbg);
          if (owner) {
            guardWorker(dbg, owner);
            noteWorldWorker(dbg);
          }
        } catch (e) {
          console.error("[zenius] guarding a worker failed", e);
        }
      },
      onUnregister(dbg) {
        try {
          guardedWorkers.delete(dbg.id);
        } catch {}
      },
    });
  } catch (e) {
    console.error("[zenius] the worker storage guard failed to start", e);
  }
}

/** Leave fullscreen and pointer lock (the parent's backstop, when a page got past the guards). */
export function exitFullscreenAndPointerLock(actor) {
  const doc = actor.document;
  try {
    actor.contentWindow?.windowUtils?.exitFullscreen();
  } catch {}
  try {
    doc?.exitPointerLock();
  } catch {}
  return true;
}
