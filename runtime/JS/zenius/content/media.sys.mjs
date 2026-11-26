// Media in agent tabs the user can't see (the observe layer; SPEC §3.5).
// (The import below: the agent's worlds get these shims too.)
//
// keepAlive keeps an agent tab's document visible, so its timers and rAF run
// at full speed. In Gecko the same flag (BrowsingContext.isActive) makes a
// playing video's wake lock "locked-foreground", so the user's display
// couldn't sleep. So while the user can't see an agent tab (zenius has muted
// it: observe/audio.sys.mjs publishes those tabs under MEDIA_HIDDEN_KEY), what
// holds that lock pauses. Gecko's rule (HTMLVideoElement's screen wake lock)
// is a playing video with a video track and either an audio track or a
// MediaStream source, muted or not. <audio>, Web Audio and other videos hold
// no lock in a muted tab, and play on silently. zenius resumes what it paused
// when the user looks, or when the tab stops being the agent's, never what
// the page or the agent paused, and tells the agent both ways
// (Zenius.mediaPaused and Zenius.mediaResumed, reason "hidden").
//
// Gecko keeps the Mac's audio lock (audio-playing) for 10 s after a media
// element's sound stops (media.wakelock.audio.delay-releasing.ms), as in any
// tab: what played while the user watched holds it that long after they leave.

// Loaded with a task's first guarded document, never in the user's own tabs (I4).
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  mirrorMethod: "chrome://userscripts/content/zenius/content/agentworld.sys.mjs",
});

/** sharedData key: browserIds of agent tabs whose media pause. */
export const MEDIA_HIDDEN_KEY = "zenius:observe:mediaHidden";

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
// Pauses of media that starts while the tab is hidden are told in one event
// per window: the first after this long, the next at least two seconds on.
const GATHER_MS = 300;
const SPACING_MS = 2000;
const EVENTS = ["playing", "pause", "ended", "emptied"];

/** One per guarded document in this process. */
const states = new Set();
let listening = false;

function hiddenIds() {
  try {
    return Services.cpmm.sharedData.get(MEDIA_HIDDEN_KEY) ?? [];
  } catch {
    return [];
  }
}

/**
 * Forget documents that are gone. No unload listener does it: in Gecko one
 * keeps a page out of the bfcache.
 */
function prune() {
  for (const state of states) {
    if (state.wgc.isClosed) {
      states.delete(state);
    }
  }
}

function listen() {
  if (listening) {
    return;
  }
  listening = true;
  Services.cpmm.sharedData.addEventListener("change", event => {
    if (!event.changedKeys.includes(MEDIA_HIDDEN_KEY)) {
      return;
    }
    prune();
    const ids = hiddenIds();
    for (const state of states) {
      try {
        state.sync(ids);
      } catch (e) {
        console.error("[zenius] media sync failed", e);
      }
    }
  });
}

/**
 * Pause and resume this document's media with its tab's visibility. Called by
 * the refusal guards (content/refusals.sys.mjs) for each document of an agent
 * tab, frames included.
 *
 * @param {JSWindowActorChild} actor
 * @param {object} opts
 * @param {() => boolean} opts.agent  whether the agent drives the tab now
 * @param {(action: string, count: number) => void} opts.emit  tell the parent
 * @param {(el: HTMLMediaElement) => void} [opts.onPlaying]  each start of
 *   playback, wherever the element is (the refusal guards' sound notice)
 */
export function installMediaGuard(actor, { agent, emit, onPlaying }) {
  const win = actor.contentWindow;
  const page = Cu.waiveXrays(win);
  const proto = page.HTMLMediaElement?.prototype;
  const nativePlay = proto?.play;
  const nativePause = proto?.pause;
  if (typeof nativePlay !== "function" || typeof nativePause !== "function") {
    return;
  }
  const wgc = actor.manager;
  const bc = actor.browsingContext;
  /** Elements zenius paused, to resume. */
  const ours = new Set();
  /** Playing elements seen, detached ones included (a playing element keeps itself alive). */
  const playing = new Set();
  /** Elements given their own listeners. */
  const watched = new WeakSet();
  let hidden = false;
  let lastPausedEvent = -Infinity;
  let pendingPaused = 0;
  let pendingTimer = null;

  const stream = el => {
    try {
      const s = el.srcObject;
      return s && win.MediaStream.isInstance(s) ? s : null;
    } catch {
      return null;
    }
  };
  /** Whether `el` holds the display's wake lock, by Gecko's rule for a video. */
  const shouldPause = el => {
    if (!win.HTMLVideoElement.isInstance(el) || el.paused || el.ended) {
      return false;
    }
    const s = stream(el);
    if (s) {
      return s.getVideoTracks().length > 0;
    }
    return el.videoWidth > 0 && !!el.mozHasAudio;
  };

  /** Pause `el` through its Xray, which calls Gecko's pause, not the page's. */
  const pauseOne = el => {
    try {
      el.pause();
      ours.add(el);
      playing.delete(el);
      return true;
    } catch {
      return false;
    }
  };
  const flushPaused = () => {
    pendingTimer = null;
    if (pendingPaused) {
      lastPausedEvent = ChromeUtils.now();
      emit("paused", pendingPaused);
      pendingPaused = 0;
    }
  };
  /** Tell the agent: at once when the tab just went out of sight, else gathered. */
  const pausedSome = (count, transition) => {
    if (!count) {
      return;
    }
    pendingPaused += count;
    if (transition) {
      flushPaused();
      return;
    }
    if (!pendingTimer) {
      const wait = Math.max(GATHER_MS, SPACING_MS - (ChromeUtils.now() - lastPausedEvent));
      pendingTimer = setTimeout(flushPaused, wait);
    }
  };

  const pauseAll = () => {
    const candidates = new Set(playing);
    try {
      for (const el of win.document.querySelectorAll("video")) {
        candidates.add(el);
      }
    } catch {}
    let count = 0;
    for (const el of candidates) {
      if (shouldPause(el) && pauseOne(el)) {
        count++;
      }
    }
    pausedSome(count, true);
  };
  const resumeOurs = () => {
    let count = 0;
    for (const el of ours) {
      try {
        if (el.paused) {
          el.play()?.then?.(null, () => {});
          count++;
        }
      } catch {}
    }
    ours.clear();
    if (count) {
      emit("resumed", count);
    }
  };

  const onEvent = event => {
    try {
      const el = event.target;
      if (!win.HTMLMediaElement.isInstance(el)) {
        return;
      }
      switch (event.type) {
        case "playing":
          try {
            onPlaying?.(el);
          } catch {}
          // A page (or the agent) playing what zenius paused makes it its own again.
          ours.delete(el);
          playing.add(el);
          if (hidden && agent() && shouldPause(el)) {
            // After this task: Gecko resolves the page's play() promise after
            // "playing", and a pause now would reject it (AbortError).
            Services.tm.dispatchToMainThread(() => {
              if (hidden && agent() && shouldPause(el) && pauseOne(el)) {
                pausedSome(1, false);
              }
            });
          }
          break;
        case "pause":
        case "ended":
          playing.delete(el);
          break;
        case "emptied":
          // A new source (load()): whatever zenius paused is gone.
          ours.delete(el);
          playing.delete(el);
          break;
      }
    } catch {}
  };
  const listenOn = (target, capture) => {
    for (const type of EVENTS) {
      target.addEventListener(type, onEvent, { capture, mozSystemGroup: true });
    }
  };
  // Media events don't bubble, and don't leave a shadow tree: the window
  // hears the document's own media, each shadow root the page makes hears
  // its tree's, and an element outside both (new Audio(), or a shadow tree
  // the parser made) gets listeners of its own when the page plays it.
  listenOn(win, true);
  const watch = el => {
    if (watched.has(el) || el.getRootNode() === win.document) {
      return;
    }
    watched.add(el);
    listenOn(el, false);
  };

  // play() finds media the listeners above can't; pause() says the page or
  // the agent wants it paused, so zenius won't resume it. Both, and
  // attachShadow(), call through unchanged.
  const play = {
    play() {
      try {
        watch(this);
      } catch {}
      return Reflect.apply(nativePlay, this, arguments);
    },
  }.play;
  const pause = {
    pause() {
      try {
        ours.delete(this);
      } catch {}
      return Reflect.apply(nativePause, this, arguments);
    },
  }.pause;
  Cu.exportFunction(play, proto, { defineAs: "play" });
  Cu.exportFunction(pause, proto, { defineAs: "pause" });
  // The agent's worlds see the natives through Xrays: they get these too.
  lazy.mirrorMethod(win, "HTMLMediaElement.prototype", "play", play);
  lazy.mirrorMethod(win, "HTMLMediaElement.prototype", "pause", pause);
  const nativeAttachShadow = page.Element?.prototype.attachShadow;
  if (typeof nativeAttachShadow === "function") {
    const attachShadow = {
      attachShadow() {
        const root = Reflect.apply(nativeAttachShadow, this, arguments);
        try {
          // The call went through the page's (waived) function, so `root` is
          // waived too: through it, addEventListener would run as the page,
          // which can't read our options. Its Xray calls Gecko's as us.
          listenOn(Cu.unwaiveXrays(root), true);
        } catch (e) {
          console.error("[zenius] media guard: shadow root", e);
        }
        return root;
      },
    }.attachShadow;
    Cu.exportFunction(attachShadow, page.Element.prototype, { defineAs: "attachShadow" });
    lazy.mirrorMethod(win, "Element.prototype", "attachShadow", attachShadow);
  }

  const state = {
    wgc,
    sync(ids) {
      // A document in the bfcache catches up at its pageshow.
      if (bc.isInBFCache) {
        return;
      }
      const now = agent() && ids.includes(bc.top.browserId);
      if (now === hidden) {
        return;
      }
      hidden = now;
      if (hidden) {
        pauseAll();
      } else {
        resumeOurs();
      }
    },
  };
  prune();
  states.add(state);
  win.addEventListener(
    "pageshow",
    event => {
      if (event.persisted) {
        state.sync(hiddenIds());
      }
    },
    { mozSystemGroup: true }
  );
  listen();
  state.sync(hiddenIds());
}
