// The parent's backstops for a task's pages (zen-observe; built by zen-core,
// 2026-11-20, and acting on a page's evidence since 2026-11-21).
//
// zen-observe's page refusals (content/refusals.sys.mjs) and the agent
// world's mirror of them refuse in the page. These refuse the same requests
// again in the parent process, which the agent's code can't reach, for when
// the page's line is bypassed: a mirror that failed, or a native API reached
// through Xrays.
// - Devices: WebRTCParent's "webrtc:Request" (getUserMedia, getDisplayMedia,
//   selectAudioOutput, speech recognition) is denied before prompt(). That
//   is before the doorhanger, which grants a stored permission as it shows,
//   and before macOS's own check (checkOSPermission).
// - Peer connections: a webrtcUI blocker denies the offer before ICE
//   gathers. Gecko lets an offer through when a blocker throws, so ours
//   catches everything and denies.
// - Content permission prompts: an Integration.contentPermission override
//   cancels a prompt before PermissionUI shows anything.
// Devices and peer connections are refused while the agent drives the page,
// since the agent never uses the user's devices, and when the page shows
// evidence of danger (observe/evidence.sys.mjs); prompts only on evidence.
// Otherwise a prompt goes on to Firefox's own: to zen-ux's hand-off while the
// agent drives (ui/permissions.sys.mjs), to the user during their hold or
// Take over, when the devices ask the user too. A stream started then stops
// when the agent has the page again (observe/capture.sys.mjs). Frames count
// as their tab, and a stored grant changes nothing. They're in only while a
// task has pages (I4), and an error in them refuses. docs/SPI.md ("Parent
// backstops") lists what has no parent hook.

import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { AGENT_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EVIDENCE_REASONS: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
  evidenceOf: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
  isEvident: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
  Integration: "resource://gre/modules/Integration.sys.mjs",
  reportRefused: "chrome://userscripts/content/zenius/observe/refusals.sys.mjs",
  WebRTCParent: "resource:///actors/WebRTCParent.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

/** A cancelled prompt's API and what it asked for, in the agent's words. */
const PROMPTS = {
  "desktop-notification": ["Notification.requestPermission", "notifications"],
  geolocation: ["navigator.geolocation", "location"],
  "persistent-storage": ["navigator.storage.persist", "persistent storage"],
  midi: ["navigator.requestMIDIAccess", "midi"],
  serial: ["navigator.serial", "a serial port"],
  xr: ["navigator.xr", "virtual reality"],
  "speech-recognition-model-download": ["SpeechRecognition", "a speech recognition model"],
};

/** The device process actor, in when the WebRTCParent patch can't be. */
const DEVICE_FALLBACK_ACTOR = "ZeniusDeviceBackstop";
const DEVICE_FALLBACK_URI = "chrome://userscripts/content/zenius/content/devicebackstop.sys.mjs";

const state = {
  on: false,
  /** "parent": WebRTCParent's gate; "content": the fallback actor; "off" */
  devices: "off",
  /** Why the WebRTCParent patch isn't in, if it isn't. */
  devicesProblem: null,
  /** "blocker": webrtcUI's blocker; "parent": WebRTCParent's gate; "off" */
  peers: "off",
  prompts: false,
  refused: { devices: 0, peers: 0, prompts: 0 },
  /** Prompts of a task's page that went on to Firefox's own (PermissionUI). */
  kept: 0,
  /** Checks that threw (each one refused). */
  errors: 0,
};

/** @type {(browserId: number) => boolean} */
let isTaskBrowserId = () => true;
/** WebRTCParent.prototype's own receiveMessage, while ours wraps it. */
let gecko = null;
/** Our wrapper, kept for a later install if something else wrapped over it. */
let gate = null;
let promptOverride = null;
let peerBlocker = null;
let fallbackActor = false;
/** Tests: make the WebRTCParent patch's startup check fail. */
let patchRefusedForTest = false;
/** What the agent already heard of, per document (pages retry). */
const told = new WeakMap();

/** A browsing context's tab is a live task's page; a frame's counts as its tab's. */
function inTask(bc) {
  const id = bc?.top?.browserId;
  if (!id) {
    // No tab to tell by: refuse, as for an error.
    throw new Error("the request names no tab");
  }
  return isTaskBrowserId(id);
}

/** The agent drives the tab right now: not the user, in a hold or after Take over. */
function agentDriven(bc) {
  return !!Services.ppmm.sharedData.get(AGENT_BROWSERS_KEY)?.has(bc.top.browserId);
}

/**
 * Why a request of a task's page for a device or a peer connection is
 * refused: "evidence" when the page shows evidence of danger, the user's hold
 * included; "agent" while the agent drives it; else null, as for a tab that
 * isn't a live task's page.
 */
function deviceRule(bc) {
  if (!inTask(bc)) {
    return null;
  }
  if (lazy.isEvident(bc)) {
    return "evidence";
  }
  return agentDriven(bc) ? "agent" : null;
}

/** Run a check; if it throws, the answer is "error": a refusal. */
function refusalOf(what, check) {
  try {
    return check();
  } catch (e) {
    state.errors++;
    log(`backstops: checking ${what} failed, so it is refused:`, e.message);
    return "error";
  }
}

/** The page's evidence in a few words for the agent: its first reason, with that reason's detail. */
function evidenceWords(target) {
  try {
    const ev = lazy.evidenceOf(target);
    const reason = lazy.EVIDENCE_REASONS.find(r => r in ev);
    if (reason) {
      return ev[reason] ? `${reason}: ${ev[reason]}` : reason;
    }
  } catch {}
  return "evidence";
}

/** What the agent hears of a refused request: `head` says what the page asked; `outcome`, what it got. */
function refusalText(why, head, outcome, target) {
  if (why === "evidence") {
    return `${head} The page shows evidence of danger (${evidenceWords(target)}), so zenius refused it ${outcome}, during the user's hold too.`;
  }
  if (why === "agent") {
    return `${head} The agent never uses the user's devices, so zenius refused it ${outcome}. If the task needs it, hand the task to the user: while they hold the page, it can ask them.`;
  }
  return `${head} zenius couldn't check who has the page, so it refused it ${outcome}.`;
}

/** Tell the agent once per document and API: pages retry. */
function tell(browser, windowGlobal, key, kind, message, url, what) {
  try {
    if (!browser || !windowGlobal) {
      return;
    }
    let keys = told.get(windowGlobal);
    if (!keys) {
      told.set(windowGlobal, (keys = new Set()));
    }
    if (keys.has(key)) {
      return;
    }
    keys.add(key);
    lazy.reportRefused(browser, kind, message, url, what);
  } catch (e) {
    log("backstops: telling the agent failed", e.message);
  }
}

const DEVICE_WORDS = { Camera: "camera", Microphone: "microphone", Screen: "screen", AudioCapture: "screen audio", Speaker: "speakers" };

function tellDevices(actor, data, why) {
  const types = Array.isArray(data?.requestTypes) ? data.requestTypes : [];
  const words = types.map(t => DEVICE_WORDS[t] ?? String(t).toLowerCase()).join(" ") || "a device";
  const api = types.includes("Screen") ? "getDisplayMedia" : types.includes("Speaker") && types.length === 1 ? "selectAudioOutput" : "getUserMedia";
  const wg = actor.manager;
  tell(
    actor.browsingContext?.top?.embedderElement,
    wg,
    `devices:${api}`,
    "deviceAccess",
    refusalText(why, `The page asked for ${words} (${api}).`, "before any prompt (NotAllowedError)", actor.browsingContext),
    wg?.documentURI?.spec,
    { api, asked: words }
  );
}

function tellPeers(wg, why, url) {
  try {
    tell(
      wg?.browsingContext?.top?.embedderElement,
      wg,
      "peers",
      "localNetwork",
      refusalText(
        why,
        "The page tried to open a WebRTC connection (RTCPeerConnection).",
        "before it gathered any network address (NotAllowedError)",
        wg?.browsingContext
      ),
      url ?? wg?.documentURI?.spec,
      { api: "RTCPeerConnection" }
    );
  } catch {}
}

/**
 * WebRTCParent.prototype.receiveMessage, gated: a task page's device request
 * is denied there, before prompt(), while the agent drives it or on evidence.
 * Peer requests too when webrtcUI has no blocker API (state.peers "parent").
 */
function makeGate(original) {
  return function receiveMessage(message) {
    if (state.on && message?.name === "webrtc:Request") {
      const why = refusalOf("a device request", () => deviceRule(this.browsingContext));
      if (why) {
        state.refused.devices++;
        try {
          this.denyRequest(message.data);
        } catch (e) {
          // Unanswered, the request still reaches no device.
          state.errors++;
          log("backstops: denying a device request failed; it stays unanswered", e.message);
        }
        tellDevices(this, message.data, why);
        return undefined;
      }
    }
    if (state.on && state.peers === "parent" && message?.name === "rtcpeer:Request") {
      const why = refusalOf("a peer connection", () => deviceRule(this.browsingContext));
      if (why) {
        state.refused.peers++;
        try {
          this.sendAsyncMessage("rtcpeer:Deny", { callID: message.data?.callID, windowID: message.data?.windowID });
        } catch (e) {
          state.errors++;
          log("backstops: denying a peer connection failed; it stays unanswered", e.message);
        }
        tellPeers(this.manager, why);
        return undefined;
      }
    }
    return original.call(this, message);
  };
}

/**
 * The startup check of the WebRTCParent patch: null if it can go in, else
 * why not. It reads Gecko's source, so a new Zen that moves the request or
 * its deny fails here, loudly, instead of letting requests by.
 */
function patchProblem(proto) {
  if (patchRefusedForTest) {
    return "refused for a test";
  }
  const own = proto && Object.getOwnPropertyDescriptor(proto, "receiveMessage");
  if (typeof own?.value !== "function" || !(own.writable || own.configurable)) {
    return "WebRTCParent has no receiveMessage of its own to wrap";
  }
  if (own.value !== gate && !String(own.value).includes('"webrtc:Request"')) {
    return "WebRTCParent.receiveMessage no longer handles webrtc:Request";
  }
  if (typeof proto.denyRequest !== "function" || !String(proto.denyRequest).includes('"webrtc:Deny"')) {
    return "WebRTCParent.denyRequest no longer sends webrtc:Deny";
  }
  return null;
}

function devicesOn() {
  let proto = null;
  let problem;
  try {
    proto = lazy.WebRTCParent?.prototype;
    problem = patchProblem(proto);
  } catch (e) {
    problem = `WebRTCParent didn't load: ${e.message}`;
  }
  if (!problem) {
    if (proto.receiveMessage !== gate) {
      gecko = proto.receiveMessage;
      gate = makeGate(gecko);
      proto.receiveMessage = gate;
    }
    state.devices = "parent";
    state.devicesProblem = null;
    return;
  }
  // Fail closed: the content processes refuse a task page's device requests
  // as MediaManager makes them (content/devicebackstop.sys.mjs).
  state.devicesProblem = problem;
  console.error(`[zenius] backstops: the WebRTCParent patch can't go in (${problem}); a task's pages refuse devices in their content processes instead`);
  log(`backstops: the WebRTCParent patch can't go in (${problem}); devices fall back to the content processes`);
  try {
    ChromeUtils.registerProcessActor(DEVICE_FALLBACK_ACTOR, {
      child: { esModuleURI: DEVICE_FALLBACK_URI, observers: ["getUserMedia:request"] },
      // Web pages' processes load a process actor only with this, as for
      // Firefox's own BrowserProcess. The child sends the parent nothing.
      safeForUntrustedWebProcess: true,
    });
    fallbackActor = true;
    state.devices = "content";
  } catch (e) {
    state.devices = "off";
    console.error("[zenius] backstops: the device fallback didn't register either", e);
    log("backstops: the device fallback didn't register either", e.message);
  }
}

function devicesOff() {
  if (gate) {
    const proto = lazy.WebRTCParent.prototype;
    if (proto.receiveMessage === gate) {
      proto.receiveMessage = gecko;
      gate = null;
      gecko = null;
    }
    // Else something wrapped over ours: it stays in the chain, inert while
    // state.on is false, and the next install turns it back on.
  }
  if (fallbackActor) {
    try {
      ChromeUtils.unregisterProcessActor(DEVICE_FALLBACK_ACTOR);
    } catch (e) {
      log("backstops: removing the device fallback failed", e.message);
    }
    fallbackActor = false;
  }
  state.devices = "off";
}

function peersOn() {
  const ui = lazy.webrtcUI;
  if (typeof ui?.addPeerConnectionBlocker !== "function") {
    // WebRTCParent's gate refuses rtcpeer:Request itself then.
    state.peers = state.devices === "parent" ? "parent" : "off";
    log(`backstops: webrtcUI has no peer connection blocker; peers: ${state.peers}`);
    return;
  }
  peerBlocker = params => {
    let wg = null;
    const why = refusalOf("a peer connection", () => {
      wg = WindowGlobalParent.getByInnerWindowId(params?.innerWindowID);
      if (!wg) {
        throw new Error(`no window ${params?.innerWindowID}`);
      }
      return deviceRule(wg.browsingContext);
    });
    if (why) {
      state.refused.peers++;
      tellPeers(wg, why, params?.documentURI);
    }
    return why ? "deny" : "allow";
  };
  ui.addPeerConnectionBlocker(peerBlocker);
  state.peers = "blocker";
}

function peersOff() {
  if (peerBlocker) {
    try {
      lazy.webrtcUI.removePeerConnectionBlocker(peerBlocker);
    } catch (e) {
      log("backstops: removing the peer connection blocker failed", e.message);
    }
    peerBlocker = null;
  }
  state.peers = "off";
}

/** The page's words for what a cancelled prompt asked, and a hint. */
function promptMessage(type, origin, why, browser) {
  const asked = PROMPTS[type]?.[1] ?? `the "${type}" permission`;
  const who = origin || "The page";
  const hint =
    type === "geolocation"
      ? " If the task needs a place, type it into the site (a city, an address or a postcode) instead."
      : "";
  const what = `${who} asked for ${asked === "location" ? "your location" : asked}.`;
  if (why === "evidence") {
    return `${what} The page shows evidence of danger (${evidenceWords(browser)}), so zenius cancelled the prompt without asking the user.${hint}`;
  }
  return `${what} zenius couldn't check the page, so it cancelled the prompt without asking the user.${hint}`;
}

/** Why a prompt from this tab is cancelled: "evidence" in a live task's page with evidence, "error" when the check fails, else null. */
function promptWhy(browser) {
  // A request with no tab isn't a page's (PermissionUI couldn't show it).
  if (!browser) {
    return null;
  }
  return refusalOf("a permission prompt", () => (inTask(browser.browsingContext) && lazy.isEvident(browser) ? "evidence" : null));
}

/**
 * What the override does with a prompt from this tab: "cancel" it, on
 * evidence of danger in a live task's page, or "pass" it on to Firefox's
 * own. Every type alike: while the agent drives, zen-ux hands the task to
 * the user with the prompt; during the hold, the user answers it. Exported
 * for tests.
 *
 * @param {string} type
 * @param {Element|null} browser  the request's element, its tab's <browser>
 */
export function promptRule(type, browser) {
  return promptWhy(browser) ? "cancel" : "pass";
}

function promptsOn() {
  promptOverride = base => ({
    createPermissionPrompt(type, request) {
      const browser = request?.element;
      const why = promptWhy(browser);
      if (!why) {
        try {
          if (browser && isTaskBrowserId(browser.browserId)) {
            state.kept++;
          }
        } catch {}
        return base.createPermissionPrompt(type, request);
      }
      state.refused.prompts++;
      let origin = "";
      try {
        origin = request.principal?.originNoSuffix ?? "";
      } catch {}
      log(`backstops: cancelled a ${type} prompt of a task's page (${origin}): ${why}`);
      tell(
        browser,
        browser.browsingContext?.currentWindowGlobal,
        `prompt:${type}`,
        "promptDenied",
        promptMessage(type, origin, why, browser),
        browser.currentURI?.spec,
        { api: PROMPTS[type]?.[0] ?? type, asked: PROMPTS[type]?.[1] ?? type }
      );
      // ContentPermissionPrompt calls prompt() at once; cancelling there
      // keeps createPermissionPrompt's contract (it only makes the prompt).
      return {
        prompt() {
          request.cancel();
        },
      };
    },
  });
  lazy.Integration.contentPermission.register(promptOverride);
  state.prompts = true;
}

function promptsOff() {
  if (promptOverride) {
    try {
      lazy.Integration.contentPermission.unregister(promptOverride);
    } catch (e) {
      log("backstops: removing the prompt override failed", e.message);
    }
    promptOverride = null;
  }
  state.prompts = false;
}

/**
 * Put the backstops in, or take them out. The service calls this as a
 * task's pages change (publishAgentBrowsers): in from the first page of a
 * live task, out after the last (I4).
 *
 * @param {{isTaskBrowserId(id: number): boolean}} service
 * @param {boolean} on
 */
export function setBackstops(service, on) {
  if (on === state.on) {
    return;
  }
  const start = ChromeUtils.now();
  if (on) {
    isTaskBrowserId = id => service.isTaskBrowserId(id);
    state.on = true;
    for (const [what, fn] of [
      ["the prompt override", promptsOn],
      ["the device gate", devicesOn],
      ["the peer connection blocker", peersOn],
    ]) {
      try {
        fn();
      } catch (e) {
        state.errors++;
        console.error(`[zenius] backstops: ${what} didn't go in`, e);
        log(`backstops: ${what} didn't go in:`, e.message);
      }
    }
  } else {
    state.on = false;
    promptsOff();
    peersOff();
    devicesOff();
    isTaskBrowserId = () => true;
  }
  log(
    `backstops: ${on ? "on" : "off"} in ${(ChromeUtils.now() - start).toFixed(1)} ms` +
      (on ? ` (devices: ${state.devices}, peers: ${state.peers}, prompts: ${state.prompts ? "on" : "off"})` : "")
  );
}

/** For tests and doctor: what's in, and what it refused. */
export function backstopState() {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Tests: make the WebRTCParent patch's startup check fail (or pass again),
 * then reinstall, as a new Zen whose WebRTCParent changed would.
 *
 * @param {object} service
 * @param {boolean} refuse
 */
export function refusePatchForTest(service, refuse) {
  const was = state.on;
  setBackstops(service, false);
  patchRefusedForTest = refuse;
  if (was) {
    setBackstops(service, true);
  }
}
