// Per-tab navigation state in the parent (zen-observe).
//
// One tracker per page, fed by the page's web progress, so it sees every
// top-level navigation: goto and reload, link clicks, scripts, redirects.
// A page is its browserId, not a <browser>: Zen's window sync moves a page's
// docShell, with its browserId, BrowsingContext and web progress, between
// the copies of its tab in each window.
// It answers "is a navigation pending?" (started, not yet committed), which
// the page gate needs before any content-bound call, and lets goto, reload
// and the waits follow one navigation from start to commit to load.
//
// Web progress order for a cross-document navigation:
//   STATE_START|IS_NETWORK  →  onLocationChange (new window global: commit)
//   →  STATE_STOP|IS_NETWORK (load).
// An aborted or download-type navigation ends with STOP and no commit. A
// failed load may skip START and STOP and only commit an error page
// (LOCATION_CHANGE_ERROR_PAGE). A fresh tab's first navigation may never
// report START (docs/SPI.md "Waiting for a load"), so goto marks its own
// navigation pending before calling loadURI. A load of the shown URL with
// another fragment (or the same one again) stays in the document: it reports
// only onLocationChange with LOCATION_CHANGE_SAME_DOCUMENT.

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const WPL = Ci.nsIWebProgressListener;
const NOTIFY = Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION;

/** @type {Map<number, NavTracker>} browserId → its page's tracker */
const trackers = new Map();
let pruneAt = 64;

/** Drop the trackers of pages that are gone, when the map has doubled. */
function prune() {
  for (const id of trackers.keys()) {
    if (!BrowsingContext.getCurrentTopByBrowserId(id)) {
      trackers.delete(id);
    }
  }
  pruneAt = Math.max(64, trackers.size * 2);
}

/** The tracker for the page in `browser`, created and attached on first use. */
export function trackerFor(browser) {
  const id = browser.browserId;
  let tracker = trackers.get(id);
  if (!tracker) {
    tracker = new NavTracker(browser);
    if (id) {
      trackers.set(id, tracker);
      if (trackers.size >= pruneAt) {
        prune();
      }
    }
  }
  return tracker;
}

/** The tracker if one exists; never creates one. */
export function peekTracker(browser) {
  return trackers.get(browser?.browserId) ?? null;
}

// How long a new popup may take to start its first navigation: its tab is
// created on about:blank, and the load the opener asked for starts about
// 2 ms later (both window.open(url) and target=_blank links).
const POPUP_START_GRACE_MS = 100;

/**
 * The URL an agent reads for a page. While the page has only ever shown its
 * initial about:blank and a navigation is pending, that's the URL being
 * loaded: a popup's Chromium target carries the requested URL from the start
 * (Ego's Target.getTargetInfo "may already show the pending navigation").
 * Otherwise browser.currentURI.
 */
export function displayURL(browser) {
  const current = browser.currentURI?.spec ?? "";
  if (current !== "about:blank") {
    return current;
  }
  const nav = peekTracker(browser);
  const pending = nav?.pending?.url;
  return pending && pending !== "about:blank" && !nav.shownBeyondBlank ? pending : current;
}

/**
 * A popup created moments ago whose first navigation hasn't started yet:
 * wait for its START (at most the rest of POPUP_START_GRACE_MS), so a caller
 * that just learned of the popup sees the navigation the opener asked for.
 */
export async function settleFreshPopup(browser) {
  const nav = peekTracker(browser);
  if (nav?.awaitingFirstStart()) {
    await nav.firstStart();
  }
}

/** `spec` without its fragment, for matching a request against a target URL. */
export function stripRef(spec) {
  const hash = spec.indexOf("#");
  return hash < 0 ? spec : spec.slice(0, hash);
}

/** The originalURI of a (possibly remote) request; it survives redirects. */
export function originalSpec(request) {
  try {
    return request?.QueryInterface(Ci.nsIChannel).originalURI?.spec ?? null;
  } catch {
    return null;
  }
}

function httpStatusOf(request) {
  try {
    return request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
  } catch {
    return undefined;
  }
}

/** The `e=` code of an error page URL, such as "connectionFailure". */
export function errorPageCode(browser) {
  const spec = browser.documentURI?.spec ?? "";
  if (!spec.startsWith("about:neterror") && !spec.startsWith("about:certerror") && !spec.startsWith("about:blocked")) {
    return null;
  }
  return /[?&]e=([^&]+)/.exec(spec)?.[1] ?? "unknown";
}

export class NavTracker {
  /** @type {{url: string|null, startedAt: number, ours: boolean}|null} */
  pending = null;
  /** Bumped at every cross-document commit. */
  commits = 0;
  /** Whether the page has committed anything but about:blank (see displayURL). */
  shownBeyondBlank = false;
  /** When the tab was adopted as a popup (ChromeUtils.now()), else null. */
  popupAt = null;
  /** Whether any top-level START was seen. */
  sawStart = false;
  /** @type {Set<(event: object) => void>} */
  #listeners = new Set();
  #listener;
  #element;

  constructor(browser) {
    this.#element = browser;
    this.browserId = browser.browserId;
    this.#listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onStateChange: (webProgress, request, flags, status) => this.#onState(webProgress, request, flags, status),
      onLocationChange: (webProgress, request, location, flags) =>
        this.#onLocation(webProgress, request, location, flags),
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    // The tracker holds the listener strongly; web progress holds it weakly.
    // It is the page's BrowsingContext's web progress, which goes where the
    // docShell goes.
    browser.addProgressListener(this.#listener, NOTIFY);
    // A tab opened with a URL (a popup) may be loading its first document
    // already, its START reported before we listened.
    try {
      if (browser.browsingContext?.webProgress?.isLoadingDocument && browser.currentURI?.spec === "about:blank") {
        this.pending = { url: null, startedAt: ChromeUtils.now(), ours: false };
      }
    } catch {}
  }

  /** The <browser> that holds the page now: in a second window, another copy of its tab. */
  get browser() {
    try {
      return BrowsingContext.getCurrentTopByBrowserId(this.browserId)?.embedderElement ?? this.#element;
    } catch {
      return this.#element;
    }
  }

  /** The tab is a new popup: its first navigation is about to start. */
  markPopup() {
    this.popupAt = ChromeUtils.now();
  }

  /** A popup within its grace period, on about:blank, with no navigation started. */
  awaitingFirstStart() {
    return (
      this.popupAt !== null &&
      !this.sawStart &&
      !this.pending &&
      ChromeUtils.now() - this.popupAt < POPUP_START_GRACE_MS &&
      this.browser.currentURI?.spec === "about:blank"
    );
  }

  /** Resolves at the first START, or when the popup's grace period ends. */
  firstStart() {
    if (!this.awaitingFirstStart()) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let off = () => {};
      const timer = setTimeout(done, Math.max(0, this.popupAt + POPUP_START_GRACE_MS - ChromeUtils.now()));
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
      // The popup's initial about:blank can report its commit 1-2 ms before
      // the START of the load the opener asked for (sooner when content
      // guards run at DOMWindowCreated): that commit is no navigation.
      off = this.listen(event => {
        if (event.type === "start" || (event.type === "commit" && event.url !== "about:blank")) {
          done();
        }
      });
    });
  }

  /** Called with every top-level event until the returned function is called. */
  listen(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Mark a navigation we are about to start, in case its START never comes.
   * `reload`: Firefox's reload, which always loads a new document.
   */
  markPending(url, { reload = false } = {}) {
    this.pending = { url, startedAt: ChromeUtils.now(), ours: true };
    this.#expected = stripRef(url);
    this.#expectedStarted = false;
    // nsDocShell::IsSameDocumentNavigation: the shown URL but for its
    // fragment, with one (even an empty one), and no POST.
    this.#fragmentOnly = !reload && url.includes("#") && this.#expected === stripRef(this.currentURL);
  }

  /** The URL of the navigation we started last, until it commits or ends. */
  #expected = null;
  /** Whether its START came: only a STOP after that ends it (a reload's old load stops first). */
  #expectedStarted = false;
  /** Whether it may stay in the document: a new fragment of the shown URL. */
  #fragmentOnly = false;

  /** The URL the tab shows (committed document, or same-document change). */
  get currentURL() {
    return this.browser.currentURI?.spec ?? "";
  }

  /**
   * Resolve true once no navigation is pending (it committed or ended), or
   * false after `timeoutMs` with it still pending.
   */
  waitUntilSettled(timeoutMs) {
    if (!this.pending) {
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      let timer = null;
      const off = this.listen(() => {
        if (!this.pending) {
          finish(true);
        }
      });
      const finish = value => {
        off();
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(!this.pending), Math.max(0, timeoutMs));
    });
  }

  /** Stop the tab's loading, as the stop button does. Ends a pending navigation. */
  stop() {
    try {
      this.browser.stop();
    } catch {}
    // STOP arrives about 2 ms later; don't let callers race it.
    this.pending = null;
    this.#expected = null;
  }

  /** The last top-level events, for diagnosing a navigation that went astray. */
  history = [];

  #emit(event) {
    this.history.push({ at: Math.round(ChromeUtils.now()), pending: this.pending?.url ?? null, ...event });
    if (this.history.length > 40) {
      this.history.shift();
    }
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch (e) {
        console.error("[zenius] navigation listener failed", e);
      }
    }
  }

  #onState(webProgress, request, flags, status) {
    if (!webProgress?.isTopLevel || !(flags & WPL.STATE_IS_NETWORK)) {
      return;
    }
    const original = originalSpec(request);
    if (flags & WPL.STATE_START) {
      // Our own goto marked it already; keep that record's `ours`. A fresh
      // tab's initial about:blank may report its START after our goto began:
      // it doesn't replace the navigation we wait for.
      const lateBlank = original === "about:blank" && this.#expected && this.#expected !== "about:blank";
      if (
        !lateBlank &&
        (!this.pending || (this.pending.url && original && stripRef(this.pending.url) !== stripRef(original)))
      ) {
        this.pending = { url: original, startedAt: ChromeUtils.now(), ours: false };
      }
      if (this.#expected && original && stripRef(original) === this.#expected) {
        this.#expectedStarted = true;
      }
      this.sawStart = true;
      this.#emit({ type: "start", original });
    } else if (flags & WPL.STATE_STOP) {
      // A late STOP from an earlier load (the initial about:blank, or a load
      // this navigation replaced) must not end the pending one.
      if (this.pending && (!this.pending.url || !original || stripRef(this.pending.url) === stripRef(original))) {
        this.pending = null;
      }
      // Our navigation ended without a commit (a download, an abort).
      if (this.#expectedStarted && original && stripRef(original) === this.#expected) {
        this.#expected = null;
      }
      this.#emit({ type: "stop", original, status, httpStatus: httpStatusOf(request) });
    }
  }

  #onLocation(webProgress, request, location, flags) {
    if (!webProgress?.isTopLevel) {
      return;
    }
    const url = location?.spec ?? "";
    if (flags & WPL.LOCATION_CHANGE_SAME_DOCUMENT) {
      // Our fragment navigation arrived: nothing more will come for it, so
      // it ends here, before the listeners hear of it (the page gate's wait
      // among them). A page's own pushState to that URL can't end it once a
      // network load has started.
      if (this.pending?.ours && this.#fragmentOnly && !this.#expectedStarted && url === this.pending.url) {
        this.pending = null;
        this.#expected = null;
        this.#fragmentOnly = false;
      }
      this.#emit({ type: "sameDocument", url, flags });
      return;
    }
    const original = originalSpec(request);
    const errorPage = !!(flags & WPL.LOCATION_CHANGE_ERROR_PAGE);
    // A commit that belongs to another load (a fresh tab's initial
    // about:blank reporting late) leaves the pending navigation pending.
    const want = this.pending?.url ? stripRef(this.pending.url) : null;
    // The navigation we started is never stale, whatever reported since.
    const expected = !!this.#expected && !!original && stripRef(original) === this.#expected;
    const stale =
      !expected &&
      !!want &&
      !errorPage &&
      (original ? stripRef(original) !== want : url === "about:blank" && want !== "about:blank");
    if (!stale) {
      this.pending = null;
      this.#expected = null;
      if (url !== "about:blank") {
        this.shownBeyondBlank = true;
      }
    }
    this.commits++;
    this.#emit({ type: "commit", url, original, errorPage, stale, httpStatus: httpStatusOf(request) });
  }
}
