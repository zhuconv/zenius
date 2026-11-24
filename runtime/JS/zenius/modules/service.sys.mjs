// ZeniusService: the per-process singleton behind every browser window. It
// owns the RPC server, the method registry and dispatcher (with the I3
// control gate), spaces, pages, events and the actor.

import { ErrorCodes, ZenError, toWireError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { RpcServer } from "chrome://userscripts/content/zenius/modules/server.sys.mjs";
import { Spaces, newLedger } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";
import { Pages, defaultPageBudget, ownValue, readTabValue } from "chrome://userscripts/content/zenius/modules/pages.sys.mjs";
import {
  addingAgentTab,
  allTabs,
  copiesOf,
  fillCopies,
  KEPT_REFUSAL_KINDS,
  KEPT_TEXT_MAX,
  noteKeptRefused,
  stopFollowingWindowSync,
  stripTabs,
  syncedSoon,
  syncId,
  uniqueTabs,
  withoutZenContainerRouting,
  workspaceWindows,
} from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";
import { JsonStore } from "chrome://userscripts/content/zenius/modules/store.sys.mjs";
import { Unserializable } from "chrome://userscripts/content/zenius/modules/serialize.sys.mjs";
import {
  installWindowGuards,
  keepAlive,
  releaseKeepAlive,
  setPopupWindowGuard,
} from "chrome://userscripts/content/zenius/modules/guards.sys.mjs";
// The keys alone, from the leaf: the guards' modules load only in a task's documents.
import {
  AGENT_BROWSERS_KEY,
  AGENT_CODE_DOCS_KEY,
  GUARD_ACTORS_KEY,
  TASK_BROWSERS_KEY,
} from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
import {
  checkAgentLoad,
  checkContentCall,
  notWebContent,
} from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
import {
  BASE_URL,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  deadline,
  ensurePrivateDir,
  log,
  now,
  plainInstance,
  readSettings,
  selfCheckDir,
  writePrivateJSON,
  zenVersion,
  zeniusHome,
} from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  agentCodeDocument: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
  hasAgentCodeMarks: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
  holdOf: "chrome://userscripts/content/zenius/observe/hold.sys.mjs",
  markEvident: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
  // The hold's module loads with a task's first hold, not at startup (I4).
  cleanLoad: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  cleanable: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  evidenceOf: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  needsCleanCopy: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  blankTab: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  heldWith: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  holdFor: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  holdingInTask: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  releaseHold: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  releaseHolds: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  // The parent backstops load with a task's first page, not at startup (I4).
  setBackstops: "chrome://userscripts/content/zenius/modules/backstops.sys.mjs",
  noteGuardFailure: "chrome://userscripts/content/zenius/observe/refusals.sys.mjs",
  // The sign-in rules' parent side loads with the first connection (I4).
  checkSignInCall: "chrome://userscripts/content/zenius/observe/signin.sys.mjs",
  publishTestPages: "chrome://userscripts/content/zenius/observe/signin.sys.mjs",
  signInGateFor: "chrome://userscripts/content/zenius/content/signin.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** @type {object|null|undefined} zen-observe's isolated world once loaded; null if it isn't there */
let agentWorldModule;
/** zen-observe's isolated world (observe/agentworld.sys.mjs). It loads with the first hold or the first task's end (I4). */
function agentWorld() {
  if (agentWorldModule === undefined) {
    try {
      agentWorldModule = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentworld.sys.mjs");
    } catch (e) {
      log("the isolated world's module didn't load:", e.message);
      agentWorldModule = null;
    }
  }
  return agentWorldModule;
}

const ACTOR_NAME = "Zenius";
const STATS_WINDOW = 512;
/** How many of the last client calls a zenius feedback report lists. */
const RECENT_CALLS = 20;
const FEEDBACK_MODULE = "chrome://userscripts/content/zenius/modules/feedback.sys.mjs";
const NO_FEEDBACK = Object.freeze({ pending: () => null });
/** zenius doctor's calls, which a report's list of calls leaves out (#noteCall). */
const STATUS_READS = new Set(["browser.version", "browser.health", "browser.methods"]);
/** The restart rebuild waits at most this long for Zen's session restore, or for a first window. */
const REBUILD_WAIT_MS = 30_000;
/** How long an unloaded tab's insert waits for Zen to put its history back. */
const INSERT_WAIT_MS = 5000;
/** How long a tab the agent takes waits for its documents' guards. */
const GUARD_TIMEOUT_MS = 2000;
/**
 * At most this many clean copies on demand of one tab within `windowMs`. A
 * written page needs one per document it gets written in; more means each
 * copy comes in written again (seen in probes of Take over).
 */
const CLEAN_COPY_CAP = { max: 5, windowMs: 60_000 };
/**
 * What a Safe Browsing list says of a page, for its listed evidence: the
 * classifier's result codes.
 */
const LISTED_KINDS = [
  ["NS_ERROR_PHISHING_URI", "phishing"],
  ["NS_ERROR_MALWARE_URI", "malware"],
  ["NS_ERROR_UNWANTED_URI", "unwanted software"],
  ["NS_ERROR_HARMFUL_URI", "harmful"],
];

/**
 * How the dispatcher gates a call that names a `space` (invariant I3).
 *   mutate  the agent must control the space, and the call waits while a
 *           takeover prompt is open (the default for any method not listed)
 *   read    the agent must control the space; doesn't wait for the prompt
 *   task    an agent task must be in progress, even one handed to the user
 *   none    no gate: the method checks ownership itself, or is a dev tool
 * Each method module declares its methods' classes with
 * `export const access = {…}`; a method left out gets mutate (none for dev.*).
 */
const ACCESS_LEVELS = new Set(["mutate", "read", "task", "none"]);
/**
 * How a method may reach page documents (I5), declared with `export const
 * i5 = {…}` (SPI.md, "Dispatch"):
 * document (acts in or reads them: the page gate and ctx.content check
 * them), outside (what the parent knows, or a load whose URL is checked),
 * frames (content calls checked, no page gate), none (no content call),
 * dev.
 */
const I5_CLASSES = new Set(["document", "outside", "frames", "none", "dev"]);
/** The classes the page gates (readiness, then I5's web-content check) run for. */
const PAGE_GATED = new Set(["document", "outside"]);
/** The classes whose handlers may make content calls (ctx.content). */
const CONTENT_CALLERS = new Set(["document", "outside", "frames", "dev"]);

/**
 * Empty a tab's back-forward cache, so Back and Forward load its other
 * pages afresh. Its current document stays as it is. A tab that's gone has
 * nothing to empty.
 *
 * @param {number} browserId
 */
function evictBFCache(browserId) {
  try {
    BrowsingContext.getCurrentTopByBrowserId(browserId)?.sessionHistory?.evictAllDocumentViewers();
  } catch (e) {
    log("evicting a tab's back-forward cache failed:", e.message);
  }
}

class Service {
  #startPromise = null;
  #windows = new Set();
  /** @type {Map<string, {fn: Function, module: string}>} */
  #methods = new Map();
  /** Have the method modules loaded (#ensureMethods)? */
  #methodsLoaded = false;
  /** @type {Map<string, string>} method → access level */
  #access = new Map();
  /**
   * Readiness checks for page.* methods, from method modules' `pageGates`
   * exports in index order (zen-observe: pending navigation, open dialog).
   *
   * @type {{gate: (ctx: object, params: object, method: string) => void|Promise<void>, module: string}[]}
   */
  #pageGates = [];
  /** @type {Map<string, number[]>} method → recent durations (ms) */
  #stats = new Map();
  /** @type {{method: string, ms: number, code: string, at: number}[]} the last client calls, oldest first (#noteCall) */
  #calls = [];
  /** @type {{method: string, ms: number, code: string, at: number}|null} */
  #lastFailure = null;
  #eventListeners = new Set();
  /** The clean load running for a hooked page, by <browser> (#cleanCopy). */
  #cleanLoads = new WeakMap();
  /** <browser> → when its recent clean copies on demand began (ms), for CLEAN_COPY_CAP. */
  #cleanCopyTimes = new WeakMap();
  /** Tasks whose end endTaskCode has handled, until the agent has them again. */
  #codeEnded = new WeakSet();
  /** @type {Set<object>} connections with event subscriptions */
  #subscribers = new Set();
  /** @type {JsonStore|null} */
  #store = null;
  #notePage = undefined;
  /** zen-input's step ring (input/steps.sys.mjs), null without it. */
  #steps = undefined;
  /** browserIds last published as agent task pages (publishAgentBrowsers). */
  #taskBrowserIds = new Set();
  /** Have the parent backstops loaded (modules/backstops.sys.mjs)? */
  #backstopsLoaded = false;
  /** Actors whose children guard documents (installGuards). */
  #guardActors = new Set([ACTOR_NAME]);

  settings = readSettings();
  spaces = new Spaces();
  pages = new Pages();
  /** @type {RpcServer|null} */
  server = null;
  startedAt = null;

  get instance() {
    return this.settings.instance;
  }

  get dev() {
    return this.settings.dev;
  }

  /**
   * zenius feedback's reports, for the sidebar's card (zen-sidebar): pending()
   * and the actions it takes on the user's own click. Until a client
   * composes a report, the module isn't loaded and pending() is null, so the
   * sidebar's reads load nothing.
   */
  get feedback() {
    return Cu.isESModuleLoaded(FEEDBACK_MODULE) ? ChromeUtils.importESModule(FEEDBACK_MODULE).feedback : NO_FEEDBACK;
  }

  get paths() {
    const home = zeniusHome();
    return {
      home,
      runDir: PathUtils.join(home, "run"),
      socket: PathUtils.join(home, "run", `${this.instance}.sock`),
      instancesDir: PathUtils.join(home, "instances"),
      registry: PathUtils.join(home, "instances", `${this.instance}.json`),
      stateDir: PathUtils.join(home, "state", this.instance),
      selfCheckDir: selfCheckDir(home),
      selfCheckSocket: PathUtils.join(selfCheckDir(home), `${this.instance}.sock`),
    };
  }

  /** The first frame on a new connection, on either socket. */
  #hello() {
    return {
      event: "hello",
      params: {
        protocol: PROTOCOL_VERSION,
        instance: this.instance,
        runtimeVersion: RUNTIME_VERSION,
        zenVersion: zenVersion(),
      },
    };
  }

  /** Start once per process; every window awaits the same promise. */
  start() {
    this.#startPromise ??= this.#start().catch(e => {
      log("startup failed:", e.message, e.stack);
      throw e;
    });
    return this.#startPromise;
  }

  async #start() {
    const t0 = now();
    const paths = this.paths;
    this.pages.onChange = () => this.publishAgentBrowsers();
    this.spaces.tabsOf = rec => this.pages.tabsOf(rec);
    this.spaces.pageBrowsersOf = rec => this.pages.list(rec.id).map(page => this.pages.tabFor(page)?.linkedBrowser).filter(Boolean);
    this.spaces.pageOfBrowser = browser => this.pages.forBrowser(browser);
    this.pages.spaces = this.spaces;
    this.pages.onDeferred = (tab, info) => this.#onDeferredClose(tab, info);
    this.pages.onMoved = (page, from, to) => this.#onPageMoved(page, from, to);
    this.pages.onTaskValue = () => this.#watchRestores();
    this.spaces.onEvent = (name, params) => this.#onSpaceEvent(name, params);
    this.spaces.onLocalEvent = (name, params) => this.emitLocal(name, params);
    this.#store = new JsonStore(paths.stateDir, "spaces.json", () => this.spaces.serialize());
    this.spaces.restore(await this.#store.load());
    // Calls wait for the restart rebuild, which the first window starts.
    this.#rebuilding = new Promise(resolve => (this.#endRebuild = resolve));
    lazy.setTimeout(() => this.#startRebuild(), REBUILD_WAIT_MS);
    this.spaces.onPersist = () => this.#store.save();
    this.install = await readInstall();
    if (this.#agentWorkAtStart()) {
      // A restored agent tab must not load before its guards.
      this.#ensureMethods("agent work at the start");
    }
    this.#followNotePage();
    this.#registerActor();
    await ensurePrivateDir(paths.runDir);
    await ensurePrivateDir(paths.instancesDir);
    await this.#checkStaleInstance(paths);
    this.server = new RpcServer({
      socketPath: paths.socket,
      hello: () => this.#hello(),
      onOpen: () => {
        this.#ensureMethods("a connection");
        this.autoCloseIdleTasks();
      },
      onFrame: (conn, frame) => this.#onFrame(conn, frame),
      onClose: conn => this.#onConnectionClosed(conn),
    });
    this.server.listen();
    this.startedAt = new Date().toISOString();
    await writePrivateJSON(paths.registry, {
      instance: this.instance,
      pid: Services.appinfo.processID,
      socket: paths.socket,
      profileDir: PathUtils.profileDir,
      zenVersion: zenVersion(),
      runtimeVersion: RUNTIME_VERSION,
      install: this.install,
      startedAt: this.startedAt,
    });
    Services.obs.addObserver(this, "quit-application");
    // The self-check's own socket waits for an idle moment: only step 6 of
    // an install uses it.
    Services.tm.idleDispatchToMainThread(() => this.#startSelfCheck(), 10000);
    const methods = this.#methodsLoaded ? `${this.#methods.size} methods` : "methods at the first connection";
    log(`listening on ${paths.socket} (${methods}, dev=${this.dev}) in ${(now() - t0).toFixed(1)}ms`);
  }

  async #checkStaleInstance(paths) {
    try {
      const prev = await IOUtils.readJSON(paths.registry);
      if (prev.pid !== Services.appinfo.processID && prev.profileDir !== PathUtils.profileDir) {
        log(`warning: instance "${this.instance}" was registered by pid ${prev.pid} (${prev.profileDir}); taking it over`);
      }
    } catch {}
  }

  observe(_subject, topic) {
    if (topic === "quit-application") {
      this.shutdown();
    }
  }

  /** Write spaces.json now (tests, before a restart). */
  async flushState() {
    await this.#store?.flush();
  }

  // --- The self-check's socket (PROTOCOL.md, "Self-check") ---
  //
  // It serves selfcheck.run and nothing else, on a dev Zen too, and shares
  // nothing with the agents' socket: its own connections, no method
  // registry, no gates. The sandbox can't reach it. Its module,
  // modules/selfcheck.sys.mjs, loads at the first
  // call, so the socket holds nothing else at startup (I4).

  /** @type {RpcServer|null} */
  selfCheckServer = null;
  /** The run each of its connections started: only that connection's close stops it. */
  #selfCheckRuns = new Map();

  async #startSelfCheck() {
    if (this.selfCheckServer || !this.server) {
      return;
    }
    if (!plainInstance(this.instance)) {
      log("self-check: no socket, since this instance's name isn't a plain one");
      return;
    }
    const { selfCheckDir: dir, selfCheckSocket } = this.paths;
    try {
      await ensurePrivateDir(dir);
      if (!this.server) {
        return;
      }
      const server = new RpcServer({
        socketPath: selfCheckSocket,
        hello: () => this.#hello(),
        onFrame: (conn, frame) => this.#onSelfCheckFrame(conn, frame),
        onClose: conn => {
          this.#selfCheckRuns.get(conn)?.abort("caller-left");
          this.#selfCheckRuns.delete(conn);
        },
      });
      server.listen();
      this.selfCheckServer = server;
      log("self-check: listening");
    } catch (e) {
      log("self-check: no socket:", e.message);
    }
  }

  // The SDK's request frame, as on the agents' socket: {id, method, params},
  // plus progress and pageBudget, which mean nothing here.
  #onSelfCheckFrame(conn, frame) {
    const { id, method } = frame;
    if (typeof method !== "string") {
      conn.send({ id: id ?? null, error: { code: "ZEN_INVALID_ARGUMENT", message: "frame has no method" } });
      return;
    }
    const t0 = now();
    let promise;
    try {
      if (method !== "selfcheck.run") {
        throw new ZenError("ZEN_UNSUPPORTED", `unknown method ${method}`);
      }
      const { params } = frame;
      if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length)) {
        throw new ZenError("ZEN_INVALID_ARGUMENT", "selfcheck.run takes no params");
      }
      const { SelfCheck } = ChromeUtils.importESModule(`${BASE_URL}modules/selfcheck.sys.mjs`);
      // While the run waits for Zen to be in the background, a caller that
      // asked for progress hears that its call is held (PROTOCOL "Held calls").
      const onHeld = (held, reason) => {
        try {
          conn.send(held ? { id, held: true, reason } : { id, held: false });
        } catch {}
      };
      const run = SelfCheck.start(frame.progress === true ? { onHeld } : {});
      this.#selfCheckRuns.set(conn, run);
      promise = run.done.finally(() => {
        if (this.#selfCheckRuns.get(conn) === run) {
          this.#selfCheckRuns.delete(conn);
        }
      });
    } catch (e) {
      promise = Promise.reject(e);
    }
    const timed = outcome => log(`rpc ${method} ${(now() - t0).toFixed(1)}ms ${outcome} (self-check socket)`);
    promise.then(
      result => {
        timed("ok");
        conn.send({ id, result });
      },
      e => {
        timed(typeof e?.code === "string" && ErrorCodes[e.code] ? e.code : "ZEN_INTERNAL");
        conn.send({ id, error: toWireError(e) });
      }
    );
  }

  shutdown() {
    stopFollowingWindowSync();
    this.selfCheckServer?.close();
    this.selfCheckServer = null;
    this.server?.close();
    this.server = null;
    this.#store?.flush();
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(this.paths.registry);
      if (file.exists()) {
        file.remove(false);
      }
    } catch {}
  }

  /**
   * Called by zenius.uc.js for each browser window.
   *
   * @param {Window} win
   */
  async registerWindow(win) {
    await this.start();
    if (win.gZenWorkspaces?.workspaceEnabled) {
      await win.gZenWorkspaces.promiseInitialized;
    }
    // A task's popup window has gone into its task by now (joinPopupWindow).
    if (win.closed) {
      return;
    }
    this.#windows.add(win);
    if (win.gBrowser) {
      installWindowGuards(win);
    }
    if (this.#windows.size === 1) {
      this.spaces.refresh();
      this.#startRebuild();
    }
    win.addEventListener("unload", () => this.#windows.delete(win), { once: true });
    win.addEventListener("TabClose", e => this.#onTabClose(e));
    if (this.#watchingRestores) {
      win.addEventListener("SSTabRestoring", this.#onRestoring);
    }
    // Window sync: Zen moves a page's docShell between windows' copies of
    // its tab, firing this on both browsers. The page follows once the swap
    // is done (Zen puts the permanentKeys back after Firefox's swap).
    win.addEventListener(
      "EndSwapDocShells",
      e => {
        const browser = e.target;
        Promise.resolve().then(() => this.pages.followMove(browser));
      },
      true
    );
    // Copies Zen opens in this window for a tab: the tab's marks go on them
    // (Zen gives a copy its sync id right after opening it).
    win.addEventListener("TabOpen", e => {
      const tab = e.target;
      Promise.resolve().then(() => this.pages.markCopies([tab]));
    });
    if (this.#windows.size > 1 && win.gZenWorkspaces?.workspaceEnabled) {
      // A window opened later: Zen gave it a copy of every tab, nearly (see
      // the end).
      this.pages.markCopies(win.gZenWorkspaces.allStoredTabs);
    }
    // A workspace switch selects that Space's tab: tabs placed at the bottom
    // of the Agents Space while it showed can join their task. After Zen's
    // own handlers, which finish the switch.
    win.addEventListener("TabSelect", () => {
      // The user's selection of a task tab makes it the task's front tab.
      this.pages.noteFront(win.gBrowser.selectedTab);
      if (this.pages.unsettled) {
        win.setTimeout(() => this.pages.settle(), 0);
      }
      // The user left a "Task finished" tab, an empty Agents Space, or an
      // ended task's workspace.
      if (this.pages.hasDeferred || this.spaces.removalWaits) {
        win.setTimeout(() => {
          this.pages.closeLeft();
          if (this.spaces.removalWaits) {
            this.spaces.retryRemovals();
          }
        }, 0);
      }
    });
    // scripts/zen-dev.sh waits for this exact line.
    dump(`[zenius] window loaded, instance=${this.instance}\n`);
    if (this.#windows.size > 1 && win.gZenWorkspaces?.workspaceEnabled) {
      // The agent pages' copies window sync left out of this window, once
      // its window sync is ready.
      await win.gZenStartup?.promiseInitialized;
      if (!win.closed) {
        this.#fillCopiesIn(win);
      }
    }
  }

  /**
   * Make the copies of agent pages that window sync left out of a window
   * it opened (windows.sys.mjs fillCopies says when): the user then finds
   * every agent page in this window too, and window sync can place the
   * next ones in its Agents Space. Each Space's copies come from the other
   * window with the most of them, in that strip's order.
   *
   * @param {Window} win
   */
  #fillCopiesIn(win) {
    const uuids = new Set();
    for (const rec of this.spaces.records()) {
      if (!rec.gone && rec.uuid && (rec.kind === "task" || rec.ownership !== "user")) {
        uuids.add(rec.uuid);
      }
    }
    for (const uuid of uuids) {
      let from = [];
      for (const other of workspaceWindows()) {
        const tabs = other === win ? [] : stripTabs(other, uuid);
        if (tabs.length > from.length) {
          from = tabs;
        }
      }
      try {
        const made = fillCopies(from, win);
        if (made.length) {
          log(`window sync left ${made.length} agent page cop${made.length === 1 ? "y" : "ies"} out of a new window; made them`);
          this.pages.markCopies(made);
        }
      } catch (e) {
        log("filling a new window's copies failed", e.message, e.stack);
      }
    }
  }

  get windowCount() {
    return this.#windows.size;
  }

  // ---------------------------------------------------------------------------
  // Agent-driven tabs: keep-alive, popups, focus

  /** The managed page and its space for a <browser>, or null. */
  controlOf(browser) {
    const page = this.pages.forBrowser(browser);
    if (!page) {
      return null;
    }
    const space = this.spaces.peek(page.spaceId);
    if (!space || space.gone) {
      return null;
    }
    return { page, space };
  }

  /**
   * zen-ux's takeover detector: the space and page of a tab, without
   * refreshing anything (it runs on every click and keypress).
   *
   * @param {Element} tab
   * @returns {{rec: object, page: object}|null}
   */
  lookup(tab) {
    const hit = this.controlOf(tab?.linkedBrowser);
    return hit ? { rec: hit.space, page: hit.page } : null;
  }

  /**
   * Is this browserId a live task's page, whoever holds it? The parent
   * backstops ask (modules/backstops.sys.mjs); a frame asks with its tab's.
   *
   * @param {number} id
   */
  isTaskBrowserId(id) {
    return this.#taskBrowserIds.has(id);
  }

  /**
   * The parent backstops are in only while a task has pages (I4). Their
   * module loads with the first one, not at startup.
   */
  updateBackstops() {
    const on = this.#taskBrowserIds.size > 0;
    if (!on && !this.#backstopsLoaded) {
      return;
    }
    this.#backstopsLoaded = true;
    try {
      lazy.setBackstops(this, on);
    } catch (e) {
      console.error("[zenius] the parent backstops failed to change", e);
      log("the parent backstops failed to change", e.message);
    }
  }

  /** True while the agent itself drives this tab (not the user). */
  isAgentDriven(browser) {
    return this.controlOf(browser)?.space.ownership === "agent";
  }

  /**
   * True while this tab belongs to an agent task, even one handed to the
   * user: its live copy's browser, not another window's copy (window sync).
   */
  wantsKeepAlive(browser) {
    const hit = this.controlOf(browser);
    if (!hit || !this.spaces.isAgentTask(hit.space)) {
      return false;
    }
    return this.pages.tabFor(hit.page)?.linkedBrowser === browser;
  }

  /**
   * Zen moved a page's docShell to another window's copy of its tab (window
   * sync): the page is that copy now. Keep-alive goes with it, and zen-ux
   * moves the pill and the cursor on pageMoved, an in-process event (it
   * carries the elements).
   */
  #onPageMoved(page, from, to) {
    log(`page ${page.label} of space ${page.spaceId} moved to another window's copy of its tab`);
    const space = this.spaces.peek(page.spaceId);
    if (space && !space.gone && this.spaces.isAgentTask(space)) {
      releaseKeepAlive(from);
      keepAlive(to);
    }
    this.publishAgentBrowsers();
    this.emitLocal("pageMoved", { space: page.spaceId, page: page.label, from, to });
  }

  /**
   * Tell content processes which tabs the agent drives (by browserId), so
   * content guards can act before page scripts run. Cheap; call after any
   * change to pages or ownership.
   */
  publishAgentBrowsers() {
    const ids = new Set();
    const taskIds = new Set();
    const joined = [];
    for (const space of this.spaces.records()) {
      if (space.gone || !this.spaces.isAgentTask(space)) {
        continue;
      }
      for (const page of this.pages.list(space.id)) {
        const tab = this.pages.tabFor(page);
        const id = tab?.linkedBrowser?.browserId;
        if (id) {
          taskIds.add(id);
          if (space.ownership === "agent") {
            ids.add(id);
          }
          if (!this.#taskBrowserIds.has(id)) {
            joined.push(tab);
          }
        }
      }
    }
    // A browserId moves with the page's docShell when Zen's window sync
    // moves it to another window's copy, so the set changes only when a tab
    // joins a task or leaves one (finish, Stop, release, a close).
    const left = [...this.#taskBrowserIds].filter(id => !taskIds.has(id));
    this.#taskBrowserIds = taskIds;
    this.#syncListedCheck();
    Services.ppmm.sharedData.set(AGENT_BROWSERS_KEY, ids);
    Services.ppmm.sharedData.set(TASK_BROWSERS_KEY, taskIds);
    Services.ppmm.sharedData.flush();
    // Before a new page's first load, as the guards.
    this.updateBackstops();
    // zen-observe: its observers of the user's own browsing run only from
    // the first task page to the last (I4), so they hear of each change.
    this.emitLocal("taskBrowsers", { count: taskIds.size });
    // Guards go into a document at DOMWindowCreated only if its tab is a
    // task's page by then. A tab that just became one has documents from
    // before: an adopted tab, a task claimed again after the user's Stop, a
    // new page's first document. Its back-forward cache holds more, which
    // Back would bring back with no guards (they come back at pageshow, not
    // DOMWindowCreated): those go.
    for (const tab of joined) {
      evictBFCache(tab.linkedBrowser.browserId);
      this.installGuards(tab);
    }
    // A tab that leaves keeps the documents it had in the task, guards and
    // the agent's code included, in its back-forward cache: Back loads them
    // afresh, as the user's.
    for (const id of left) {
      evictBFCache(id);
    }
    this.updatePopupWindowGuard();
  }

  /**
   * An actor whose child guards a task's documents: zen-ux's ZeniusClipboard
   * and ZeniusSystemUi. The Zenius actor makes it in a task's new documents,
   * at its own DOMWindowCreated, and calls its installGuards(); it answers
   * "installGuards" for the documents a tab already has. Published before
   * any page of a task can make a document that needs it, since both travel
   * the same IPC channels in order.
   * @param {string} name
   */
  addGuardActor(name) {
    this.#guardActors.add(name);
    Services.ppmm.sharedData.set(GUARD_ACTORS_KEY, [...this.#guardActors].filter(n => n !== ACTOR_NAME));
    Services.ppmm.sharedData.flush();
  }

  /**
   * Have every guard actor guard the documents this tab has now, the top one
   * and its frames. The publish before it has reached their processes, since
   * both travel the same IPC channel in order. A child guards each document
   * once, so a second call costs one message per frame and changes nothing.
   * Never throws: a frame that's gone or can't answer is skipped, and its
   * next document gets the guards at DOMWindowCreated.
   * @param {MozTabbrowserTab} tab
   * @returns {Promise<number>} how many documents got guards now
   */
  async installGuards(tab) {
    const top = tab?.linkedBrowser?.browsingContext;
    if (!top) {
      return 0;
    }
    const queries = [];
    let contexts = [];
    try {
      contexts = top.getAllBrowsingContextsInSubtree();
    } catch {
      // The tab is closing.
    }
    for (const bc of contexts) {
      const wg = bc.currentWindowGlobal;
      if (!wg || wg.isClosed) {
        continue;
      }
      for (const name of this.#guardActors) {
        try {
          queries.push(wg.getActor(name).sendQuery("installGuards"));
        } catch {
          // Not registered (yet), or a document the actor doesn't cover.
        }
      }
    }
    const timer = deadline(GUARD_TIMEOUT_MS, () => new Error(`no answer in ${GUARD_TIMEOUT_MS} ms`));
    try {
      const results = await Promise.race([Promise.allSettled(queries), timer.promise]);
      return results.filter(r => r.status === "fulfilled" && r.value === true).length;
    } catch (e) {
      log("guards for a taken tab:", e.message);
      return 0;
    } finally {
      timer.clear();
    }
  }

  /** Re-assert keep-alive on every page of every agent task. */
  refreshKeepAlive() {
    for (const space of this.spaces.records()) {
      if (space.gone || !this.spaces.isAgentTask(space)) {
        continue;
      }
      for (const page of this.pages.list(space.id)) {
        keepAlive(this.pages.tabFor(page));
      }
    }
  }

  /**
   * Called from the wrapped gBrowser.addTab: is this new tab a popup of a
   * task? Returns where it belongs, or null.
   * - An open with an opener (window.open, a named target, a rel=opener
   *   link, a feature popup) from a page of a task that hasn't ended joins
   *   it, whoever opened it: the agent, the site's own code, or the user
   *   during a hold (`hold`). It shares the page's browsing context group,
   *   so it can't be the user's (closed groups, item 2).
   * - An open with no opener (noopener, a plain target=_blank link, a
   *   middle click) has a group of its own: it's the agent's while the
   *   agent drives the page, else the user's (noteOpenedTab).
   */
  popupRoute(options) {
    const opener = options?.openerBrowser ?? options?.openWindowInfo?.parent?.top?.embedderElement ?? null;
    if (!opener) {
      return null;
    }
    const control = this.controlOf(opener);
    if (!control) {
      return null;
    }
    const linked = !!options?.openWindowInfo && !options.openWindowInfo.forceNoOpener;
    if (linked && this.spaces.isAgentTask(control.space)) {
      return { space: control.space, openerPage: control.page, hold: control.space.ownership !== "agent" };
    }
    if (control.space.ownership !== "agent") {
      return null;
    }
    return { space: control.space, openerPage: control.page };
  }

  /**
   * Closed groups, item 3: should the parent refuse this open? Yes for an
   * opener-linked one whose opener's browsing context group holds a
   * document with the agent's code (zen-observe's marks, zen-ux's kept
   * ones), unless the opener is a page of a live task, whose popups join it
   * (item 2). A refused open opens nothing: the parent can't tell a form's
   * POST from a GET there, and turning a POST into a GET is never right.
   * zen-ux's pill tells the user the page can't open windows until it
   * reloads.
   *
   * @param {nsIOpenURIInFrameParams} params  createContentWindowInFrame's
   * @returns {{browser: Element|null}|null}  the opener's top <browser>
   */
  openRefusal(params) {
    const owi = params?.openWindowInfo;
    if (!owi) {
      return null;
    }
    const holding = this.#holdOpenRefusal(owi.parent?.top?.embedderElement ?? null);
    if (holding) {
      return holding;
    }
    if (owi.forceNoOpener) {
      return null;
    }
    const opener = owi.parent;
    const group = opener?.group;
    // No document anywhere has the agent's code: nothing to look at, and
    // agentcode.sys.mjs needn't load for the user's own popups (I4).
    if (!group || !Services.ppmm.sharedData.get(AGENT_CODE_DOCS_KEY)?.size) {
      return null;
    }
    const browser = opener.top?.embedderElement ?? null;
    const control = browser ? this.controlOf(browser) : null;
    if (control && this.spaces.isAgentTask(control.space)) {
      return null;
    }
    return group.getToplevels().some(top => lazy.agentCodeDocument(top)) ? { browser } : null;
  }

  /** Has any page been held for the user since startup? Until then the hold's module stays unloaded (I4). */
  #heldForUser = false;

  /** Task record → the held tabs of its secret step (an agent's hand-off with secret), blanked at the hand back. */
  #secretSteps = new WeakMap();

  /**
   * While the user holds a page of a task, a page of that task with
   * evidence a clean copy clears (what the agent's code left there, or a
   * page the agent made) opens nothing,
   * with an opener or without: a look-alike of the held page could take
   * what the user types. The held page and the popups that joined its hold open as
   * usual, and so does a page where the agent's code only ran, since the
   * hand-off discarded it.
   *
   * @returns {{browser: Element, hold: true}|null}
   */
  #holdOpenRefusal(browser) {
    const control = browser ? this.controlOf(browser) : null;
    if (!this.#heldForUser || !control || control.space.gone || !lazy.holdingInTask(control.space.id) || lazy.holdOf(browser) !== undefined) {
      return null;
    }
    return lazy.cleanable(lazy.evidenceOf(browser)) ? { browser, hold: true } : null;
  }

  /**
   * The user is about to hold `browser`'s page: an agent's hand-off
   * (source "agent", spaces.handOff) or the user's Take over (source "user",
   * zen-ux's userTakeOver). modules/handoff.sys.mjs holds it and makes it
   * safe for their typing, then the task is the user's to hold, with the
   * reload on the spaceChanged for zen-ux's card. A page the agent made is
   * refused to the agent; the user's Take over holds it as it is.
   *
   * With `secret`, the agent's step will show a secret (an API key, a
   * token, recovery codes): the held tab is blanked at the hand back
   * (blankSecretSteps), and spaceChanged says secret, for zen-ux's card.
   *
   * @param {object} rec  the live task's SpaceRecord
   * @param {Element} browser
   * @param {{source?: "agent"|"user", reason?: string, secret?: boolean}} [opts]
   * @returns {Promise<{agentPage: boolean, how: "reload"|"get"|null, reloaded: string[], carried: boolean, openerCut: boolean, evidence: Record<string, Record<string, string>>}>}
   *   evidence: label → the evidence each reloaded page had before its load
   *   (zen-observe's {reason: detail}), for zen-ux's notice
   * @throws {ZenError} ZEN_HANDOFF_REFUSED
   */
  async holdForUser(rec, browser, { source = "user", reason = "manual_takeover", secret = false } = {}) {
    // The hand back tells the agent what changed since it last had control.
    if (rec.ownership === "agent") {
      this.spaces.clearHandBackNotes(rec);
    }
    this.#heldForUser = true;
    // The agent's hand-off of its own page is refused before its code is discarded.
    const result = await lazy.holdFor(this, rec, browser, { refuseAgentPage: source === "agent" });
    const labels = result.reloaded.map(b => this.pages.forBrowser(b)?.label).filter(Boolean);
    // What each reloaded page had, for zen-ux's notice (Take over's result)
    // and its hand-off card (spaceChanged).
    const evidence = {};
    for (const b of result.reloaded) {
      const label = this.pages.forBrowser(b)?.label;
      if (label) {
        evidence[label] = result.evidence?.get(b) ?? {};
      }
    }
    this.spaces.noteReloaded(rec, labels);
    if (result.openerCut) {
      this.spaces.noteOpenerCut(rec);
    }
    if (result.agentPage && source === "agent") {
      lazy.releaseHold(rec, browser);
      const page = this.pages.forBrowser(browser)?.label ?? null;
      throw new ZenError(
        "ZEN_HANDOFF_REFUSED",
        `${page ?? "The page"} is a page the agent made (a data: or blob: URL it opened), where nothing the user types is safe. Load the site's own page with page.goto() and hand that off.`,
        { page, reason: "agentPage" }
      );
    }
    if (rec.gone || !this.spaces.isAgentTask(rec)) {
      // The task ended while the page loaded.
      lazy.releaseHolds(rec);
    } else if (source === "user" || rec.ownership === "agent") {
      const secretStep = source === "agent" && secret;
      if (secretStep) {
        this.noteSecretStep(rec, browser);
      }
      // An agent's hand-off that the user's Take over overtook keeps theirs.
      this.spaces.setOwnership(rec, "agentDelegatedToUser", {
        reason,
        source,
        reloaded: result.how,
        carried: result.carried,
        secret: secretStep,
        evidence,
      });
    } else if (source === "agent" && secret) {
      // The user's Take over came first: their hold stays, and the step is still a secret one.
      this.noteSecretStep(rec, browser);
    }
    return { agentPage: result.agentPage, how: result.how, reloaded: labels, carried: result.carried, openerCut: result.openerCut, evidence };
  }

  /**
   * zen-observe's discard: the agent's sandboxes, and the workers they
   * started, in every process, at a hand-off, Take over and the task's end.
   * Resolves once every process has done it.
   *
   * @param {Element|BrowsingContext|{task: number}} target
   * @returns {Promise<void>}
   */
  async discardAgentCode(target) {
    const world = agentWorld();
    if (typeof world?.discard === "function") {
      await world.discard(target);
    }
  }

  /**
   * The page's evidence, its top document and frames (zen-observe's
   * evidenceOf): reason → detail. Unreadable, it counts as hooked.
   *
   * @param {Element|BrowsingContext} target
   * @returns {Record<string, string>}
   */
  evidenceOf(target) {
    return lazy.evidenceOf(target);
  }

  /**
   * Does the page get a clean copy before the user types there? Its
   * documents have what the agent's code left hooked in them (zen-observe's
   * evidence), and the agent didn't make it: a
   * page the agent made comes back the same from a reload, so zen-input's
   * guard drops the typing there instead. A listed or flagged page gets
   * zen-ux's warning, not a clean copy.
   *
   * @param {Element|BrowsingContext} target
   * @param {Record<string, string>} [evidence]  the page's, if already read
   */
  needsCleanCopy(target, evidence = this.evidenceOf(target)) {
    return lazy.needsCleanCopy(evidence);
  }

  /**
   * Where a clean load of the page goes, if not to its current URL:
   * zen-observe's urlBefore (the URL before the agent's code changed it in
   * place). Null on an error: the current URL then.
   *
   * @param {Element|BrowsingContext} target
   * @returns {string|null}
   */
  urlBefore(target) {
    try {
      const url = agentWorld()?.urlBefore?.(target);
      return typeof url === "string" ? url : null;
    } catch (e) {
      log("urlBefore failed, so the clean load goes to the current URL:", e.message);
      return null;
    }
  }

  /**
   * zen-input's typing guard stopped the user's first press or key in a page
   * the agent's code left something hooked in, and holds their keys there:
   * the page loads afresh (needsCleanCopy), its form and the focus carried
   * over (modules/handoff.sys.mjs cleanLoad), and the task's hand back names
   * it. Resolves at once when there was nothing to clean. Rejects, the
   * user's typing there held and nothing replayed, when no new document
   * came, when the new one came in with evidence too (`stillEvident`: the
   * agent's code reached it from a window of its group), and past
   * CLEAN_COPY_CAP: a page isn't loaded afresh without end.
   *
   * @param {Element} browser
   * @returns {Promise<{how: "reload"|"get"|null, carried: boolean, focused: boolean, urlBefore?: string|null, evidence: Record<string, string>}>}
   *   evidence: the page's as the user's press came, before any load
   *   (zen-ux's notice says why it reloaded)
   */
  async cleanOnDemand(browser) {
    const evidence = this.evidenceOf(browser);
    let result = { how: null, carried: false, focused: false, evidence };
    if (this.#cleanLoads.has(browser) || this.needsCleanCopy(browser, evidence)) {
      const { how, carried, focused, urlBefore } = await this.#cleanCopy(browser, { onDemand: true });
      result = { how, carried, focused, urlBefore, evidence };
    }
    const rec = result.how ? this.controlOf(browser)?.space : null;
    if (rec && !rec.gone && this.spaces.isAgentTask(rec)) {
      this.noteReloaded(rec, [browser]);
    }
    log(`clean copy on demand: ${result.how ?? "nothing to clean"}${result.how ? ` (carried ${result.carried}, focused ${result.focused})` : ""}`);
    return result;
  }

  /**
   * The clean load of a hooked page, one per page at a time: an ask while
   * one runs (the user's press during the task's-end reload) shares it. One
   * on demand fails when its copy comes in with evidence, and counts toward
   * CLEAN_COPY_CAP: past it, it throws before any load.
   *
   * @param {Element} browser
   * @param {{onDemand?: boolean}} [opts]
   */
  #cleanCopy(browser, { onDemand = false } = {}) {
    let running = this.#cleanLoads.get(browser);
    if (!running) {
      if (onDemand) {
        this.#countCleanCopy(browser);
      }
      running = lazy.cleanLoad(this, browser, { sameSite: true, evidentFails: onDemand }).finally(() => this.#cleanLoads.delete(browser));
      this.#cleanLoads.set(browser, running);
    }
    return running;
  }

  /** Note a clean copy on demand of `browser`'s tab, or throw past CLEAN_COPY_CAP (tests set cleanCopyCap). */
  #countCleanCopy(browser) {
    const { max, windowMs } = this.cleanCopyCap ?? CLEAN_COPY_CAP;
    const now = Date.now();
    const times = (this.#cleanCopyTimes.get(browser) ?? []).filter(t => now - t < windowMs);
    this.#cleanCopyTimes.set(browser, times);
    if (times.length >= max) {
      log(`clean copy on demand: refused, the tab loaded afresh ${times.length} times in ${windowMs / 1000} s`);
      throw new Error(
        `the page was loaded afresh ${times.length} times in ${windowMs / 1000} s and had what the agent's code left in it again each time; it isn't loaded again, and the user's typing there stays held`
      );
    }
    times.push(now);
  }

  /**
   * A task ends (finish, Stop, its last tab closed). The agent's code goes
   * from the group of each of its tabs, kept pages included, then each
   * hooked page that stays open loads afresh (landing (2), on evidence:
   * reloadHookedAfterTask). finish() calls
   * this before endTask: the tabs are taken while they are still the
   * task's, and every discard goes out now (discard() sends before its
   * first await), before endTask's publish drops the tabs from
   * zenius:taskSpaces, where a {task} discard looks. Without that, the
   * world kept running in a kept page and heard the user's clicks and keys
   * (zen-snapshot's kept group, 2026-11-20).
   *
   * @param {object} rec  the task
   * @param {Set<Element>} [closing]  tabs finish() closes: discarded, never reloaded
   * @returns {Promise<void>}
   */
  endTaskCode(rec, closing = new Set()) {
    // Once per end: later events of the user's space don't run it again.
    this.#codeEnded.add(rec);
    const tabs = this.pages.tabsOf(rec);
    const groups = new Map();
    for (const tab of tabs) {
      let id = null;
      try {
        id = tab.linkedBrowser?.browsingContext?.group?.id ?? null;
      } catch {}
      if (id !== null && !groups.has(id)) {
        groups.set(id, tab.linkedBrowser);
      }
    }
    const failed = e => log("discarding the agent's code at the task's end failed:", e.message);
    const discards = [{ task: rec.id }, ...groups.values()].map(target => this.discardAgentCode(target).catch(failed));
    const stays = tabs.filter(tab => !closing.has(tab)).map(tab => tab.linkedBrowser);
    return Promise.all(discards)
      .then(() => this.reloadHookedAfterTask(stays))
      .then(
        () => {},
        e => log("reloading the hooked pages at the task's end failed:", e.message)
      );
  }

  /**
   * At the task's end, after the discard: every page of it that stays open
   * and has what the agent's code left hooked in it loads afresh, its form
   * carried over (needsCleanCopy). One that doesn't load afresh keeps its
   * evidence, and what such a page keeps.
   *
   * @param {Element[]} browsers  the task's pages that stay open
   * @returns {Promise<number>} how many were to load afresh
   */
  async reloadHookedAfterTask(browsers) {
    // Tests of the other layers keep what the agent put in a page (the
    // hand-off's and Resume's loads skip too; never off otherwise).
    if (!Services.prefs.getBoolPref("zenius.handoff.quietReload", true)) {
      return 0;
    }
    const hooked = browsers.filter(b => b?.isConnected && b.browsingContext?.currentWindowGlobal && this.needsCleanCopy(b));
    await Promise.all(
      hooked.map(b =>
        this.#cleanCopy(b)
          .then(() => log("a hooked page reloaded at its task's end"))
          .catch(e => log("a hooked page didn't reload at its task's end, so it keeps its evidence:", e.message))
      )
    );
    return hooked.length;
  }

  /**
   * The agent says the user's step in `browser` will show a secret (its
   * hand-off with secret): the hand back blanks that tab first.
   *
   * @param {object} rec
   * @param {Element} browser
   */
  noteSecretStep(rec, browser) {
    let tabs = this.#secretSteps.get(rec);
    if (!tabs) {
      this.#secretSteps.set(rec, (tabs = new Set()));
    }
    tabs.add(browser);
  }

  /**
   * At the hand back, before the agent has control (the user's Resume,
   * spaces.takeOver, spaces.claim): each secret step's tab, and the popups
   * it opened in its hold, show about:blank with their history gone, so
   * nothing the agent can reach still shows the secret, back and the
   * back-forward cache included (the Cloudflare token, 2026-11-21). The hand
   * back's notes say which (blanked). A tab that doesn't blank is closed
   * instead: the agent never gets it back with the secret.
   *
   * @param {object} rec
   * @returns {Promise<string[]>} the labels of the pages blanked or closed
   */
  async blankSecretSteps(rec) {
    const steps = this.#secretSteps.get(rec);
    this.#secretSteps.delete(rec);
    if (!steps?.size) {
      return [];
    }
    const tabs = new Set();
    for (const browser of steps) {
      if (browser.isConnected) {
        for (const tab of lazy.heldWith(browser)) {
          tabs.add(tab);
        }
      }
    }
    const labels = [];
    for (const browser of tabs) {
      const label = this.pages.forBrowser?.(browser)?.label ?? null;
      const started = Date.now();
      try {
        await lazy.blankTab(browser);
        log(`a secret step's tab is blank: ${label ?? "a page"} (${Date.now() - started} ms)`);
      } catch (e) {
        log(`a secret step's tab didn't blank (${e.message}), so it closes: ${label ?? "a page"}`);
        try {
          browser.ownerGlobal?.gBrowser?.removeTab(browser.ownerGlobal.gBrowser.getTabForBrowser(browser));
        } catch (closing) {
          log("closing it failed too:", closing.message);
        }
      }
      if (label) {
        labels.push(label);
      }
    }
    if (labels.length) {
      this.spaces.noteBlanked(rec, labels);
    }
    return labels;
  }

  /** zen-ux's Take over, in every form: the prompt, its countdown, the panel, the user's typing. */
  userTakeOver(rec, browser) {
    return this.holdForUser(rec, browser, { source: "user", reason: "manual_takeover" });
  }

  /**
   * Before the agent gets a held task back by its own call (spaces.takeOver,
   * spaces.claim), as at the user's Resume: zen-ux replaces this
   * (ZeniusUI.beforeHandBack) to reload the pages the user typed a secret
   * into. Resolves with the <browser>s it reloaded.
   *
   * @type {(rec: object) => Promise<Element[]>}
   */
  beforeHandBack = async () => [];

  /**
   * Load a page afresh, quietly (modules/handoff.sys.mjs): a new GET entry,
   * its visible ordinary fields and the focus carried over, typing dropped
   * meanwhile. zen-ux's Resume reload.
   *
   * @returns {Promise<{how: "reload"|"get", openerCut: boolean, carried: boolean, focused: boolean}>}
   */
  cleanLoad(browser, opts) {
    return lazy.cleanLoad(this, browser, opts);
  }

  /** zen-ux's Resume reloaded these pages before the agent gets control back: the hand back says so. */
  noteReloaded(rec, browsers) {
    this.spaces.noteReloaded(
      rec,
      browsers.map(b => this.pages.forBrowser(b)?.label).filter(Boolean)
    );
  }

  /**
   * Called from the wrapped gBrowser.addTab for a tab that isn't an agent
   * popup. Opened from a page of a task that hasn't ended, such as the
   * user's middle-click while they hold it, it joins the task as a tab of
   * user origin: never a page by its opener alone (SPEC §3.5).
   */
  noteOpenedTab(tab, options) {
    const opener = options?.openerBrowser ?? options?.openWindowInfo?.parent?.top?.embedderElement ?? null;
    // A tab the user's own tab opens is theirs too: its page can reach the
    // own tab's through window.opener (I2).
    const openerTab = opener?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(opener);
    if (openerTab && this.pages.isUserOwn(openerTab)) {
      this.pages.markUserOwn(tab);
      return;
    }
    const control = opener ? this.controlOf(opener) : null;
    if (control?.space.kind === "task" && !control.space.ended && tab.linkedBrowser) {
      this.pages.addUnmanaged(control.space, tab, "user");
    }
  }

  /**
   * The window creator's wrapper (modules/guards.sys.mjs) is in only while
   * it can matter: a task is live, or a document holds the agent's code
   * (I4). Checked as tasks start, end and change
   * hands, as a tab joins or leaves one, and as the marks change
   * (observe/setup.sys.mjs's syncHooks, which keeps zen-observe's own hooks
   * on the same terms).
   */
  updatePopupWindowGuard() {
    try {
      const live = !!this.spaces?.records().some(rec => !rec.gone && this.spaces.isAgentTask(rec));
      // hasAgentCodeMarks drops marks of closed tabs, but loading its module
      // with no mark published would cost every user an import (I4).
      const marked = !!Services.ppmm.sharedData.get(AGENT_CODE_DOCS_KEY)?.size && lazy.hasAgentCodeMarks();
      setPopupWindowGuard(this, live || marked);
    } catch (e) {
      log("updating the popup window guard failed", e.message);
    }
  }

  /**
   * A task's popup that opened as a window (a feature popup the page's
   * wrapped window.open didn't see) joins the task as its tab popup would
   * (closed groups, item 2): its tab moves next to its opener page's, with
   * the same browsing context, and the window closes. The window creator's
   * wrapper calls this at the window's delayed startup.
   *
   * @param {Window} popupWin
   * @param {{space: object, openerPage: object, hold?: boolean}} route  popupRoute's
   * @returns {object|null}  the new page
   */
  joinPopupWindow(popupWin, route) {
    const popupTab = popupWin.closed ? null : popupWin.gBrowser?.selectedTab;
    const win = this.pages.tabFor(route.openerPage)?.ownerDocument?.defaultView;
    const why = !popupTab
      ? `its window has no tab (closed: ${popupWin.closed})`
      : !win?.gBrowser
        ? "its opener page is gone"
        : route.space.gone || !this.spaces.isAgentTask(route.space)
          ? "its task ended"
          : null;
    if (why) {
      log(`a task's popup window stays a window: ${why}`);
      return null;
    }
    if (route.hold) {
      // The user's own open, or the site's, while they hold the task: it
      // shows as a tab popup would, in front unless the user's Firefox
      // keeps a window.open turned tab in the background.
      const selectTab = !Services.prefs.getBoolPref("browser.tabs.loadDivertedInBackground", false);
      const tab = win.gBrowser.adoptTab(popupTab, { selectTab });
      return tab ? this.adoptPopup(win, tab, route) : null;
    }
    let page = null;
    this.pages.keepView(() => {
      const tab = addingAgentTab(win.gBrowser, () =>
        withoutZenContainerRouting(win, route.space.userContextId ?? 0, () => win.gBrowser.adoptTab(popupTab, { selectTab: false }))
      );
      if (!tab) {
        return null;
      }
      page = this.adoptPopup(win, tab, route);
      return syncId(tab) ? null : syncedSoon(tab);
    });
    return page;
  }

  /** Label a popup tab that popupRoute claimed and put it in its space. */
  adoptPopup(win, tab, { space, openerPage }) {
    this.pages.moveIn(space, tab);
    // Popups get labels whatever the budget, as in Ego.
    const page = this.pages.register(space, tab, "agent", { opener: openerPage.label });
    keepAlive(tab);
    this.emit("popup", { space: space.id, page: page.label, tab: this.pages.tabId(tab), opener: openerPage.label });
    return page;
  }

  /**
   * Collect the popups that page `openerLabel` opens until stop() is called.
   * zen-input wraps an action in this to fill the receipt's `popups`.
   *
   * @returns {{popups: {label: string, targetId: string}[], labels: string[], stop(): {label: string, targetId: string}[]}}
   */
  watchPopups(spaceId, openerLabel) {
    const popups = [];
    const off = this.addEventListener((event, params) => {
      if (event === "popup" && params.space === spaceId && params.opener === openerLabel) {
        popups.push({ label: params.page, targetId: params.tab });
      }
    });
    return {
      popups,
      get labels() {
        return popups.map(p => p.label);
      },
      stop() {
        off();
        return popups;
      },
    };
  }

  #onTabClose(event) {
    const tab = event.target;
    // A tab moving to another window closes here but lives on there; its
    // permanentKey carries over, so keep the page. What zen-ux shows on it
    // goes with it, once this close is done.
    if (event.detail?.adoptedBy) {
      const to = event.detail.adoptedBy;
      const page = this.pages.carryOver(tab, to);
      if (page) {
        Promise.resolve().then(() => this.emitLocal("pageMoved", { space: page.spaceId, page: page.label, from: tab, to }));
      }
      return;
    }
    // One window's copy closing while another's stays open isn't the tab
    // closing (window sync). Zen closes every copy when the tab closes, and
    // the last one's close is the tab's.
    if (copiesOf(tab).length) {
      return;
    }
    this.pages.forgetDeferred(tab);
    const id = this.pages.tabId(tab);
    const page = this.pages.forTab(tab);
    const inAgentsSpace = this.spaces.isAgentsSpace(tab.getAttribute("zen-workspace-id"));
    let task = null;
    if (page) {
      // Its document went on in another tab: Zen closes the copies a
      // tear-off into a new window leaves behind. The page is that tab now.
      if (this.pages.tabFor(page)) {
        return;
      }
      this.pages.remove(page);
      this.emit("pageClosed", { space: page.spaceId, page: page.label, tab: id });
      task = this.spaces.peek(page.spaceId);
    } else {
      const space = this.spaces.peekUuid(tab.getAttribute("zen-workspace-id")) ?? this.#taskHolding(id);
      if (space && id in space.ledger.unmanaged) {
        // As for a page: the tab went on in another, the one a tear-off made.
        if (this.pages.movedTab(tab)) {
          return;
        }
        delete space.ledger.unmanaged[id];
        space.ledger.retained = space.ledger.retained.filter(t => t !== id);
        task = space;
      }
    }
    if (task?.kind === "task" || inAgentsSpace) {
      // Once the close is done, and after a finish() that is closing tabs.
      Promise.resolve().then(() => this.#afterTaskTabClosed(task));
    }
  }

  /**
   * Firefox puts a tab's session values back when it restores the tab: at a
   * restart, and when the user makes a tab from another's state (Duplicate
   * Tab, Reopen Closed Tab or Window). A tab that comes back with a task's
   * value that no task holds is one the user made: it's theirs, and keeps
   * no task's value for a later restart to find. The restart rebuild reads
   * the values it restores itself.
   */
  #onTabRestoring(tab) {
    if (this.#rebuilding || !readTabValue(tab) || this.pages.holderOf(tab) !== null) {
      return;
    }
    this.pages.forgetTask(tab);
  }

  #onRestoring = event => this.#onTabRestoring(event.target);

  /**
   * Whether each window listens for its tabs' restores: from the first
   * task value the session writes on, the restart rebuild's included (I4).
   */
  #watchingRestores = false;

  #watchRestores() {
    if (this.#watchingRestores) {
      return;
    }
    this.#watchingRestores = true;
    for (const win of this.#windows) {
      win.addEventListener("SSTabRestoring", this.#onRestoring);
    }
  }

  /**
   * An agent close of a tab a window shows waits (SPEC §3.5): the page has
   * ended for the agent, and zen-ux's "Task finished" pill follows
   * `tabClosing {space, tab}`, an in-process event (it carries the element).
   */
  #onDeferredClose(tab, { space, page, tabId }) {
    if (page) {
      this.emit("pageClosed", { space: page.spaceId, page: page.label, tab: tabId });
    }
    this.emitLocal("tabClosing", { space: space?.id ?? null, tab });
  }

  /** The pill's Close: the waiting tab closes now. */
  closeDeferred(tab) {
    return this.pages.closeDeferred(tab);
  }

  /** The pill's Keep: the waiting tab stays, as the user's (openedBy "user", no tag). */
  keepDeferred(tab) {
    return this.pages.keepDeferred(tab);
  }

  // ---------------------------------------------------------------------------
  // The restart rebuild (SPEC §3.4 "Restarts", SPI "Restart")

  /** @type {Promise<void>|null} until the rebuild ends; null after */
  #rebuilding = null;
  #endRebuild = null;
  #rebuildStarted = false;

  #startRebuild() {
    if (!this.#rebuildStarted) {
      this.#rebuildStarted = true;
      this.#rebuild();
    }
  }

  /**
   * After a restart or a crash: each restored tab goes back to its task by
   * its session value, tabs marked closing close (or wait, if a window shows
   * them), tasks none of whose tabs came back are removed (a call naming one
   * fails at once with not_restored), and documents restored tabs already
   * have get their guards. Calls wait until it ends. It reads no network and
   * no page: restored pages stay unloaded until a page method uses them.
   */
  async #rebuild() {
    const t0 = now();
    let restored = 0;
    let notOwn = 0;
    try {
      await Promise.race([
        lazy.SessionStore.promiseAllWindowsRestored.then(() =>
          // Until a window's tab strip is set up, Zen's allStoredTabs lists
          // only part of its tabs; Zen itself waits for this before reading
          // a restored window's tabs.
          Promise.all(
            [...Services.wm.getEnumerator("navigator:browser")].map(win => win.gZenWorkspaces?.promiseInitialized)
          )
        ),
        new Promise(resolve => lazy.setTimeout(resolve, REBUILD_WAIT_MS)),
      ]);
      // An Agents Space Zen brought back from an older session file than
      // spaces.json: zenius's by its mark (SPI, "The Agents Space's mark").
      const healed = this.spaces.healAgentsSpace();
      if (healed.adopted || healed.removed.length || healed.left.length) {
        log(
          `restart: Agents Space ${healed.adopted ? `adopted ${healed.adopted}` : "not adopted"}; ` +
            `removed ${healed.removed.length} empty marked Space(s); left ${healed.left.length} with tabs`
        );
      }
      const found = new Set();
      // Each tab once, as its live copy: window sync restores a copy in each
      // window, and readTabValue reads any copy's value.
      for (const tab of [...uniqueTabs()]) {
        const value = readTabValue(tab);
        if (!value) {
          continue;
        }
        if (!ownValue(tab, value)) {
          // Firefox copied it from a task's tab into one the user made, or
          // an older runtime wrote it: the tab is the user's.
          this.pages.forgetTask(tab);
          notOwn++;
          continue;
        }
        if (value.closing) {
          // A close that waited when Zen quit waits again if a window shows
          // the tab. zen-ux's pill, which says why it will close and offers
          // Keep, comes with the method modules. Its task is usually gone (a
          // finish that kept nothing), so the start had no agent work to
          // load them for. ZeniusUI draws the pill on a waiting tab when it
          // starts.
          if (this.pages.closeTab(tab)) {
            this.#ensureMethods("a close waits");
          }
          continue;
        }
        const rec = this.spaces.peek(value.task);
        if (!rec || rec.gone || rec.kind !== "task") {
          this.pages.forgetTask(tab);
          continue;
        }
        this.pages.reattach(rec, tab, value);
        found.add(rec.id);
        restored++;
      }
      for (const rec of this.spaces.records()) {
        if (rec.kind === "task" && !rec.gone && !found.has(rec.id)) {
          this.spaces.removeNotRestored(rec);
        }
      }
      // Zen restores one state per tab into every window's copy: whatever
      // marks any copy has, every copy gets (the user's own tab above all).
      this.pages.markCopies([...allTabs()]);
      this.publishAgentBrowsers();
      // A tab a window showed at the quit can be loaded already
      // (zen.workspaces.continue-where-left-off): its documents get their
      // guards before any client call.
      const guarded = [];
      for (const rec of this.spaces.records()) {
        if (rec.kind === "task" && !rec.gone) {
          for (const tab of this.pages.tabsOf(rec)) {
            if (hasDocument(tab)) {
              guarded.push(this.installGuards(tab));
            }
          }
        }
      }
      await Promise.all(guarded);
      this.spaces.maybeRemoveAgentsSpace();
    } catch (e) {
      log("restart rebuild failed:", e.message, e.stack);
    } finally {
      const end = this.#endRebuild;
      this.#rebuilding = null;
      this.#endRebuild = null;
      end?.();
    }
    const users = notOwn ? `; ${notOwn} carrying a value that isn't theirs are the user's` : "";
    log(`restart rebuild: ${restored} task tabs back${users} in ${(now() - t0).toFixed(0)}ms`);
    this.autoCloseIdleTasks();
  }

  /**
   * I5 for a tab Zen restored unloaded, or the user unloaded. The URL it
   * would show is checked as an agent load first: if agents can't load it,
   * the call fails and the tab stays unloaded. If they can, the tab loads it
   * through page.goto, as the agent's own load (never the principal of the
   * user's load, never a URL the user only typed), and the call goes on once
   * it has loaded. page.goto's own URL replaces the old one. pages.close
   * isn't a page.* method: the tab closes unloaded.
   *
   * @returns {null|Promise<void>}
   */
  #restoreGate(params, method) {
    let page;
    let tab;
    try {
      page = this.pages.get(this.spaces.get(params.space), params.page);
      tab = this.pages.tabFor(page);
    } catch {
      // The method's own resolvePage says what's wrong.
      return null;
    }
    if (!isUnloaded(tab)) {
      return null;
    }
    if (method === "page.goto") {
      return this.#insertUnloaded(tab);
    }
    const uri = restoredURI(tab);
    try {
      checkAgentLoad(uri, "page.goto");
    } catch (e) {
      throw new ZenError(
        "ZEN_URL_NOT_ALLOWED",
        `page ${page.label} is unloaded (Zen restores tabs so), and the page it shows, ${uri.spec}, isn't one agents can load, so it stays unloaded. ${method} needs it loaded: page.goto() a web URL first, or ask the user to open the page.`,
        { ...e.data, page: page.label, reason: "unloaded" }
      );
    }
    const timeout = Number.isFinite(params.options?.timeout) ? { timeout: params.options.timeout } : {};
    return this.#insertUnloaded(tab)
      .then(() =>
        this.dispatch("page.goto", {
          space: params.space,
          page: page.label,
          url: uri.spec,
          options: { waitUntil: "load", ...timeout },
        })
      )
      .then(
        () => undefined,
        e => {
          // A method that works whatever the page shows goes on; one that
          // acts in the document fails as its load did.
          if (this.i5Of(method) !== "outside") {
            throw e;
          }
          log(`page ${page.label}: loading it after a restore failed (${e?.code ?? e?.message}); ${method} goes on`);
        }
      );
  }

  /**
   * Insert an unloaded tab's browser, then wait until Zen's session restore
   * has put the tab's history back: only then does it take a load in the tab
   * as the tab's restore, and not restore its saved page over it later.
   */
  async #insertUnloaded(tab) {
    if (!tab.linkedPanel) {
      let onRestoring;
      const restoring = new Promise(resolve => {
        onRestoring = () => resolve(true);
        tab.addEventListener("SSTabRestoring", onRestoring, { once: true });
      });
      let timer;
      const late = new Promise(resolve => (timer = lazy.setTimeout(() => resolve(false), INSERT_WAIT_MS)));
      tab.ownerDocument.defaultView.gBrowser.insertBrowser(tab);
      const restored = await Promise.race([restoring, late]);
      lazy.clearTimeout(timer);
      tab.removeEventListener("SSTabRestoring", onRestoring);
      if (!restored) {
        log(`an unloaded tab's history wasn't back ${INSERT_WAIT_MS}ms after its insert`);
      }
    }
    // Its browser has a browserId now: its documents get the guards.
    this.publishAgentBrowsers();
  }

  // ---------------------------------------------------------------------------
  // The auto-close (SPEC §3.4)

  /** zenius.autoCloseHours: 72 by default, 0 turns the auto-close off. */
  get autoCloseHours() {
    return Services.prefs.getIntPref("zenius.autoCloseHours", 72);
  }

  /**
   * Would the auto-close take this task? The agent still owns it and never
   * handed it to the user, the agent opened every tab in it, and no client
   * named it for zenius.autoCloseHours. zen-ux's panel marks the same.
   */
  isIdleTask(rec, now = Date.now()) {
    const hours = this.autoCloseHours;
    return (
      hours > 0 &&
      rec.kind === "task" &&
      !rec.gone &&
      rec.ownership === "agent" &&
      !rec.paused &&
      !rec.handedToUser &&
      now - (rec.lastNamedAt ?? rec.createdAt ?? now) >= hours * 3_600_000 &&
      this.pages.members(rec).every(m => m.openedBy === "agent")
    );
  }

  /**
   * Close a task as finish({keep: []}) would, with §3.5's waiting closes:
   * the auto-close, and the panel's close of an idle task.
   *
   * @returns {object} finish's receipt
   */
  closeIdleTask(rec) {
    const { finishTask } = ChromeUtils.importESModule(`${BASE_URL}methods/spaces.sys.mjs`);
    return finishTask(this.#makeCtx("spaces.finish", null), rec, []);
  }

  /** At Zen start and when a client connects. No timer: an idle Zen stays idle (I4). */
  autoCloseIdleTasks(now = Date.now()) {
    const closed = [];
    if (this.#rebuilding) {
      // Before the rebuild a task has no tabs yet; the rebuild runs this.
      return closed;
    }
    for (const rec of this.spaces.records()) {
      if (this.isIdleTask(rec, now)) {
        try {
          this.closeIdleTask(rec);
          closed.push(rec.id);
        } catch (e) {
          log("auto-close failed", rec.id, e.message);
        }
      }
    }
    if (closed.length) {
      log(`auto-closed idle tasks ${closed.join(", ")}`);
    }
    return closed;
  }

  /** The task whose ledger keeps this unmanaged tab, if any. */
  #taskHolding(tabId) {
    for (const rec of this.spaces.records()) {
      if (rec.kind === "task" && !rec.gone && tabId in rec.ledger.unmanaged) {
        return rec;
      }
    }
    return null;
  }

  /**
   * A task tab closed (SPEC §3.4). The user closing the last tab of a task
   * in progress ends it, as the panel's Stop does. The agent's own closes
   * never empty a task: pages.close leaves a blank tab, and finish() removes
   * the record itself. An ended task goes with its last tab. And the Agents
   * Space goes once it's empty and no window shows it.
   */
  #afterTaskTabClosed(rec) {
    if (rec?.kind === "task" && !rec.gone && this.pages.tabsOf(rec).length === 0) {
      if (this.spaces.isAgentTask(rec)) {
        this.spaces.setOwnership(rec, "user", rec.finishing ? { source: "agent" } : { source: "user", endedHow: "closed" });
      } else {
        this.pages.dropSpace(rec.id);
        this.emit("spaceFinished", { space: rec.id, closedSpace: true });
        this.spaces.remove(rec);
      }
    }
    this.spaces.maybeRemoveAgentsSpace();
  }

  // ---------------------------------------------------------------------------
  // Ownership side effects

  #onSpaceEvent(name, params) {
    if (name === "spaceChanged" && "ownership" in params && params.ownership !== "agentDelegatedToUser") {
      // Every end of the user's hold comes here: Resume, the agent's
      // takeOver, Stop, finish (zen-observe's holds end with it).
      const rec = this.spaces.peek(params.space);
      if (rec && this.#heldForUser) {
        lazy.releaseHolds(rec);
      }
    }
    if (name === "spaceChanged" && "ownership" in params) {
      const rec = this.spaces.peek(params.space);
      if (rec?.ownership === "user") {
        // The task ended (Stop, its last tab closed; finish() did this
        // before endTask): the agent's code goes from its tabs, and the
        // written ones load afresh. Before publishAgentBrowsers below, while
        // the tabs are still the task's.
        if (!this.#codeEnded.has(rec)) {
          this.endTaskCode(rec);
        }
        // Its tabs are the user's now: no hand back will blank them.
        this.#secretSteps.delete(rec);
        // The user's now (Stop, or finish): pages stop running as agent tabs.
        // Their labels stay for a later claim unless finish() ended them.
        for (const page of this.pages.list(rec.id)) {
          releaseKeepAlive(this.pages.tabFor(page));
        }
      } else if (rec) {
        this.#codeEnded.delete(rec);
      }
      this.publishAgentBrowsers();
      this.refreshKeepAlive();
    }
    this.emit(name, params);
  }

  /**
   * finish() ends the task's labels, as Ego discards its ledger: the next
   * task starts with a fresh one. Tabs this finish left open for the user
   * (rec.ledger.retained) stay known as the agent's.
   */
  endTask(rec) {
    // A task's tabs are the ones its ledger names: the pages it keeps for
    // the user, and its other tabs, stay the task's, unmanaged, until they
    // close. A workspace keeps them by holding them.
    const members = rec.kind === "task" ? this.pages.members(rec) : null;
    for (const page of this.pages.list(rec.id)) {
      releaseKeepAlive(this.pages.tabFor(page));
    }
    this.pages.dropSpace(rec.id);
    const retained = rec.ledger.retained;
    rec.ledger = newLedger();
    rec.ledger.retained = retained;
    for (const id of retained) {
      rec.ledger.unmanaged[id] = "agent";
    }
    for (const { tab, openedBy } of members ?? []) {
      this.pages.addUnmanaged(rec, tab, openedBy);
    }
  }

  // ---------------------------------------------------------------------------
  // Methods

  /**
   * Load the method modules, once. Most of them install hooks for agent
   * tabs as they load: zen-input's picker, file chooser and autofill
   * guards, zen-observe's dialog, network and download hooks, zen-ux's
   * overlay. A browser with no agent work needs none of that until an agent
   * connects, so they load at the first connection or call (SPEC §5, idle
   * cost: about 4.7 MiB of the parent's memory on the Linux server, 85 ms on that first
   * call), at start when there's agent work (#agentWorkAtStart), or when
   * the restart rebuild finds a close that waits again (zen-ux's pill).
   * Each module's setup also covers the windows already open.
   *
   * @param {string} [why]  for the log: what needed them
   */
  #ensureMethods(why = "a call") {
    if (this.#methodsLoaded) {
      return;
    }
    this.#methodsLoaded = true;
    const t0 = now();
    // The tests' sign-in pages (device-login and consent), on a dev
    // profile, before any document of a task is assessed
    // (observe/signin.sys.mjs).
    try {
      lazy.publishTestPages();
    } catch (e) {
      log("the sign-in rules' test pages:", e.message);
    }
    this.#loadMethods();
    log(`loaded ${this.#methods.size} methods in ${(now() - t0).toFixed(1)}ms (${why})`);
  }

  /**
   * Does spaces.json list agent work, whose tabs may come back with this
   * session: a task in any state, or a Space an agent controls or handed to
   * the user? Then the guards load before any of those tabs does.
   */
  #agentWorkAtStart() {
    return this.spaces.records().some(rec => !rec.gone && (rec.kind === "task" || rec.ownership !== "user"));
  }

  #loadMethods() {
    const { methodModules } = ChromeUtils.importESModule(`${BASE_URL}methods/index.sys.mjs`);
    for (const name of methodModules) {
      const url = `${BASE_URL}methods/${name}.sys.mjs`;
      if (!chromeFileExists(url)) {
        log(`methods/${name}.sys.mjs not present yet; skipped`);
        continue;
      }
      let mod;
      try {
        mod = ChromeUtils.importESModule(url);
      } catch (e) {
        log(`ERROR loading methods/${name}.sys.mjs: ${e.message}\n${e.stack ?? ""}`);
        continue;
      }
      for (const [method, fn] of Object.entries(mod.methods ?? {})) {
        this.registerMethod(method, fn, name, mod.access?.[method], mod.i5?.[method]);
      }
      for (const gate of mod.pageGates ?? []) {
        if (typeof gate === "function") {
          this.#pageGates.push({ gate, module: name });
        }
      }
    }
  }

  /**
   * Add or replace a method. Later modules in index.sys.mjs replace earlier
   * ones.
   *
   * @param {string} method
   * @param {Function} fn  (ctx, params) => result
   * @param {string} [module]
   * @param {"mutate"|"read"|"task"|"none"} [access]  see ACCESS_LEVELS
   * @param {"document"|"outside"|"frames"|"none"|"dev"} [i5]  see I5_CLASSES
   */
  registerMethod(method, fn, module = "?", access = undefined, i5 = undefined) {
    // Dev methods exist only in dev profiles, by name or by class: a method
    // declared dev skips the content check (I5), so the user's Zen has none.
    if ((method.startsWith("dev.") || i5 === "dev") && !this.dev) {
      return;
    }
    const prev = this.#methods.get(method);
    if (prev) {
      log(`method ${method} from ${prev.module} replaced by ${module}`);
    }
    this.#methods.set(method, { fn, module });
    let accessDeclared = false;
    if (access !== undefined) {
      if (ACCESS_LEVELS.has(access)) {
        accessDeclared = true;
      } else {
        log(`method ${method}: unknown access ${access}; using mutate`);
        access = "mutate";
      }
      this.#access.set(method, access);
    }
    const i5Declared = i5 !== undefined && I5_CLASSES.has(i5);
    if (i5 !== undefined && !i5Declared) {
      log(`method ${method}: unknown i5 class ${i5}`);
    }
    this.#registry.set(method, { module, accessDeclared, i5: i5Declared ? i5 : null, i5Declared });
  }

  /** @type {Map<string, {module: string, accessDeclared: boolean, i5: string|null, i5Declared: boolean}>} */
  #registry = new Map();

  /**
   * Every method with its module, access and I5 class, and whether its
   * module declared each (dev.registry, for zen-input's registry test).
   *
   * @returns {{method: string, module: string, access: string, accessDeclared: boolean, i5: string|null, i5Declared: boolean}[]}
   */
  registry() {
    this.#ensureMethods();
    return [...this.#registry.keys()].sort().map(method => {
      const entry = this.#registry.get(method);
      return { method, ...entry, access: this.accessOf(method) };
    });
  }

  /** Remove a method, its access and its registry entry (tests' probes). */
  unregisterMethod(method) {
    this.#methods.delete(method);
    this.#access.delete(method);
    this.#registry.delete(method);
  }

  /** The method's declared I5 class, or null. */
  i5Of(method) {
    return this.#registry.get(method)?.i5 ?? null;
  }

  get methodNames() {
    this.#ensureMethods();
    return [...this.#methods.keys()].sort();
  }

  /** @returns {"mutate"|"read"|"task"|"none"} */
  accessOf(method) {
    return this.#access.get(method) ?? (method.startsWith("dev.") ? "none" : "mutate");
  }

  #onFrame(conn, frame) {
    const { id, method } = frame;
    if (typeof method !== "string") {
      conn.send({ id: id ?? null, error: { code: "ZEN_INVALID_ARGUMENT", message: "frame has no method" } });
      return;
    }
    // While the control gate holds the call (a takeover prompt is open), the
    // client hears about it, so it can stop its own timer meanwhile. Only
    // clients that ask: an older one would take the first frame with its id
    // as the answer.
    const onHold =
      frame.progress === true ? (held, reason) => conn.send(held ? { id, held: true, reason } : { id, held: false }) : undefined;
    // Ego's EGO_BROWSER_PAGE_BUDGET is per process, so the SDK sends it with
    // each request rather than storing it per space: two processes may differ.
    const { pageBudget } = frame;
    if (pageBudget !== undefined && !(Number.isInteger(pageBudget) && pageBudget > 0)) {
      conn.send({
        id,
        error: toWireError(new ZenError("ZEN_INVALID_ARGUMENT", "pageBudget must be a positive integer")),
      });
      return;
    }
    this.dispatch(method, frame.params ?? {}, conn, { onHold, pageBudget }).then(
      result => conn.send(resultFrame(id, result)),
      error => conn.send({ id, error: toWireError(error) })
    );
  }

  /**
   * Run a method: the pre-dispatch chain, the handler, timing. Also used for
   * internal calls (ctx.call).
   *
   * The chain is the ownership gate (I3) for any call that names a space,
   * then, for methods declared document or outside (I5), each module's page
   * gate. A step passes by returning nothing, fails by throwing, or returns a
   * promise when it must wait; after any wait, I3 is checked again (the user
   * may have taken over meanwhile).
   *
   * When no step waits, the handler starts synchronously, before the server
   * reads the next frame on this connection. So a handler that registers a
   * waiter before its first await (the SDK's waitForEvent, sent before the
   * action that triggers the event) has it in place when the next frame's
   * action runs.
   *
   * A call the gate holds isn't running yet: its handler, and every timeout
   * the handler applies, start at release. If the connection closes during
   * the hold, the call is dropped without running.
   *
   * @param {string} method
   * @param {object} params
   * @param {object|null} conn
   * @param {{onHold?: (held: boolean, reason?: string) => void}} [opts]
   * @returns {Promise<any>}
   */
  dispatch(method, params, conn = null, { onHold, pageBudget } = {}) {
    this.#ensureMethods();
    if (this.#rebuilding) {
      // In frame order: calls queue on the same promise.
      return this.#rebuilding.then(() => this.dispatch(method, params, conn, { onHold, pageBudget }));
    }
    const t0 = now();
    // A client's call shows in its task's steps while it runs (zen-input's
    // ring); a handler's own calls don't.
    const startedAt = Date.now();
    const step = conn ? this.#noteStep("beginCall", { method, params, at: startedAt }) : null;
    let heldMs = 0;
    let promise;
    let ctx = null;
    try {
      const entry = this.#methods.get(method);
      if (!entry) {
        throw new ZenError("ZEN_UNSUPPORTED", `unknown method ${method}`);
      }
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        throw new ZenError("ZEN_INVALID_ARGUMENT", `params of ${method} must be an object`);
      }
      // I5 fails closed: the declared class, not the method's name, picks
      // the gates below and what ctx.content allows, so a method without
      // one doesn't run.
      const i5 = this.i5Of(method);
      if (!i5) {
        throw new ZenError("ZEN_INTERNAL", `${method} doesn't run: its module declares no I5 class for it`);
      }
      // The I3 check with this call's held frames: null when it may go on
      // now, a promise of the ms held, or a throw.
      const check = (space, access) => {
        const hold = this.spaces.gate(this.spaces.get(space), access);
        if (!hold) {
          return null;
        }
        const heldAt = now();
        onHold?.(true, "paused");
        return hold.then(() => {
          const ms = now() - heldAt;
          heldMs += ms;
          if (conn?.closed) {
            throw new ZenError("ZEN_BROWSER_UNAVAILABLE", `${method} dropped: its connection closed while it was held`);
          }
          onHold?.(false);
          return ms;
        });
      };
      const access = this.accessOf(method);
      const hasSpace = params.space !== undefined && params.space !== null;
      ctx = this.#makeCtx(method, conn, {
        pageBudget: pageBudget ?? defaultPageBudget(),
        // For a handler about to act after a long step (a pointer action
        // after moveCursor): I3 again, with held frames. Resolves to the ms
        // held, which the handler's own timeouts shouldn't count.
        gate: async (space = params.space) => {
          if (space === undefined || space === null) {
            return 0;
          }
          return (await check(space, "mutate")) ?? 0;
        },
      });
      const control = () => (hasSpace && access !== "none" ? check(params.space, access) : null);
      const gates = PAGE_GATED.has(i5)
        ? [() => this.#restoreGate(params, method), ...this.#pageGates.map(({ gate }) => () => gate(ctx, params, method))]
        : [];
      const wait = runChain(control, gates, 0);
      const run = () => entry.fn(ctx, params);
      promise = wait ? wait.then(run) : Promise.resolve(run());
    } catch (e) {
      promise = Promise.reject(e);
    }
    const finish = outcome => {
      // Time held at a takeover prompt isn't the method's: it's logged apart.
      const ms = now() - t0 - heldMs;
      this.#record(method, ms);
      const held = heldMs ? ` (held ${heldMs.toFixed(0)}ms)` : "";
      log(`rpc ${method} ${ms.toFixed(1)}ms ${outcome}${held}${conn ? "" : " (internal)"}`);
      if (conn) {
        this.#noteStep("endCall", step, { method, params, outcome, ms, at: startedAt, found: ctx?.step });
        this.#noteCall(method, ms, outcome);
      }
    };
    return promise.then(
      result => {
        this.#afterCall(method, params, result);
        finish("ok");
        return result;
      },
      e => {
        const outcome = typeof e?.code === "string" && ErrorCodes[e.code] ? e.code : "ZEN_INTERNAL";
        if (outcome === "ZEN_INTERNAL") {
          log(`${method} internal error: ${e?.message}\n${e?.stack ?? ""}`);
        }
        finish(outcome);
        throw e;
      }
    );
  }

  /**
   * After the agent acted on a page, tell zen-ux (ui/pages.sys.mjs notePage):
   * the user who opens the space lands on that page, and its badge shows
   * activity. Pointer actions also do this through moveCursor.
   */
  #afterCall(method, params, result) {
    let label = null;
    if (ACTIVATING_PAGE_METHODS.has(method) && typeof params.page === "string") {
      label = params.page;
    } else if (method === "pages.new" && typeof result?.label === "string") {
      // Ego's newPage opens its tab active; adopt leaves the current Page be.
      label = result.label;
    }
    if (!label) {
      return;
    }
    try {
      const space = this.spaces.get(params.space);
      const page = this.pages.peek(space.id, label);
      const tab = page && this.pages.tabFor(page);
      if (tab) {
        this.pages.noteFront(tab);
        this.#notePageFn()?.(tab);
      }
    } catch (e) {
      log(`notePage after ${method} failed: ${e.message}`);
    }
  }

  /**
   * Agent actions that note their page without a call of their own here
   * (zen-input's keys, zen-ux's cursor) make it the task's front tab too.
   */
  #followNotePage() {
    const url = `${BASE_URL}ui/pages.sys.mjs`;
    if (chromeFileExists(url)) {
      ChromeUtils.importESModule(url).onNotePage?.(tab => this.pages.noteFront(tab));
    }
  }

  /**
   * zen-input's step ring (input/steps.sys.mjs): what the sidebar shows of
   * each task. A ring that fails to load costs only the steps: every call
   * still runs.
   */
  #noteStep(fn, ...args) {
    if (this.#steps === undefined) {
      this.#steps = null;
      try {
        const url = `${BASE_URL}input/steps.sys.mjs`;
        if (chromeFileExists(url)) {
          this.#steps = ChromeUtils.importESModule(url);
        }
      } catch (e) {
        log(`zen-input's step ring didn't load, so tasks show no steps: ${e.message}`);
      }
    }
    try {
      return this.#steps?.[fn]?.(...args) ?? null;
    } catch (e) {
      log(`the step of ${args.at(-1)?.method} failed: ${e.message}`);
      return null;
    }
  }

  /** Is the listed check's observer on (from the first task page to the last, I4)? */
  #listedOn = false;
  #listedObserver = { observe: subject => this.#checkListed(subject) };

  #syncListedCheck() {
    const want = this.#taskBrowserIds.size > 0;
    if (want === this.#listedOn) {
      return;
    }
    this.#listedOn = want;
    if (want) {
      Services.obs.addObserver(this.#listedObserver, "window-global-created");
    } else {
      Services.obs.removeObserver(this.#listedObserver, "window-global-created");
    }
  }

  /**
   * The listed evidence: a new document of
   * a task page whose site Gecko's phishing or malware lists name is marked
   * listed, with the list, for zen-ux's warning. Gecko blocks such a page as
   * it loads, so this finds the one someone clicked through its warning to.
   * The classifier asks the network only for a prefix that matched the
   * lists on disk.
   */
  #checkListed(windowGlobal) {
    try {
      const browserId = windowGlobal?.browsingContext?.top?.browserId;
      if (!browserId || !this.#taskBrowserIds.has(browserId)) {
        return;
      }
      const principal = windowGlobal.documentPrincipal;
      if (!principal?.isContentPrincipal || !(principal.schemeIs("http") || principal.schemeIs("https"))) {
        return;
      }
      const classifier = Cc["@mozilla.org/url-classifier/dbservice;1"].getService(Ci.nsIURIClassifier);
      classifier.classify(principal, {
        onClassifyComplete: (code, list) => {
          const kind = LISTED_KINDS.find(([name]) => Cr[name] === code)?.[1];
          if (kind) {
            log(`a task page is on a Safe Browsing list (${kind}), so it's marked listed`);
            lazy.markEvident(windowGlobal, "listed", `${kind}: ${list}`);
          }
        },
      });
    } catch (e) {
      log("the listed check of a task document failed:", e.message);
    }
  }

  #notePageFn() {
    if (this.#notePage === undefined) {
      const url = `${BASE_URL}ui/pages.sys.mjs`;
      this.#notePage = chromeFileExists(url) ? ChromeUtils.importESModule(url).notePage : null;
    }
    return this.#notePage;
  }

  #record(method, ms) {
    let samples = this.#stats.get(method);
    if (!samples) {
      samples = [];
      this.#stats.set(method, samples);
    }
    samples.push(ms);
    if (samples.length > STATS_WINDOW) {
      samples.shift();
    }
  }

  /**
   * What zen-observe's i5Status needs for browser.health's `i5`: the page
   * gates, and ctx.content as a method that acts in documents gets it.
   */
  i5Hooks() {
    this.#ensureMethods();
    return {
      pageGates: this.#pageGates.map(({ gate }) => gate),
      content: this.#makeCtx("page.click", null).content,
    };
  }

  /**
   * Keep a client's call for zenius feedback's report: its method's name,
   * how long it took and its outcome ("ok" or the error's code). Never its
   * parameters, result or message, which can quote a page or what the agent
   * typed: a report holds only zenius's own data. A name the runtime doesn't
   * know is the client's text, so it's kept as "unknown". The feedback.*
   * calls stay out, and so do the status reads zenius doctor makes just
   * before a report, so a report lists the agent's own calls.
   */
  #noteCall(method, ms, outcome) {
    if (method.startsWith("feedback.") || STATUS_READS.has(method)) {
      return;
    }
    const call = { method: this.#methods.has(method) ? method : "unknown", ms: Math.round(ms), code: outcome, at: now() };
    this.#calls.push(call);
    if (this.#calls.length > RECENT_CALLS) {
      this.#calls.shift();
    }
    if (outcome !== "ok") {
      this.#lastFailure = call;
    }
  }

  /**
   * The last client calls, oldest first, and the last that failed since Zen
   * started, with how many seconds ago it ended: feedback.compose puts them
   * in a report.
   */
  recentCalls() {
    const shown = ({ method, ms, code }) => ({ method, ms, code });
    const failure = this.#lastFailure;
    return {
      calls: this.#calls.map(shown),
      lastFailure: failure ? { ...shown(failure), ago: Math.round((now() - failure.at) / 1000) } : null,
    };
  }

  /** Per-method count and latency percentiles over the recent window. */
  stats() {
    const out = {};
    for (const [method, samples] of this.#stats) {
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      out[method] = { n: sorted.length, p50: round(pct(0.5)), p95: round(pct(0.95)), max: round(sorted.at(-1)) };
    }
    return out;
  }

  #makeCtx(method, conn, extras = {}) {
    const service = this;
    const pageBudget = extras.pageBudget ?? defaultPageBudget();
    const i5 = this.i5Of(method);
    return {
      method,
      conn,
      service,
      spaces: this.spaces,
      pages: this.pages,
      ZenError,
      log,
      gate: async () => 0,
      ...extras,
      pageBudget,
      resolveSpace: params => this.resolveSpace(params),
      resolvePage: params => this.resolvePage(params),
      watchPopups: (spaceId, openerLabel) => this.watchPopups(spaceId, openerLabel),
      // The method's declared I5 class: what its gates and content calls do.
      i5,
      // I5: a method declared to make no content call makes none (fails
      // closed), and one that acts in documents reaches only web content,
      // frames included. Async, so a refusal is a
      // rejection.
      content: async (bc, spec, args, opts) => {
        if (!CONTENT_CALLERS.has(i5)) {
          throw new ZenError("ZEN_INTERNAL", `${method} made a content call (${spec}) that its I5 class, ${i5 ?? "none declared"}, doesn't allow`);
        }
        checkContentCall(method, bc, i5);
        // The sign-in rules (content/signin.sys.mjs): the parent's own check
        // first, then the page's process checks at the call's entry and
        // before its result.
        const kind = lazy.signInGateFor(i5, this.accessOf(method));
        if (!kind) {
          return this.content(bc, spec, args, opts);
        }
        lazy.checkSignInCall(method, bc, kind);
        return this.content(bc, spec, args, { ...opts, gate: { kind, method } });
      },
      // Nested calls keep the request's budget.
      call: (m, p) => this.dispatch(m, p, null, { pageBudget }),
      emit: (event, params) => this.emit(event, params),
    };
  }

  // ---------------------------------------------------------------------------
  // Resolution helpers for handlers

  /** @param {{space: number}} params */
  resolveSpace(params) {
    if (params?.space === undefined || params.space === null) {
      throw new ZenError("ZEN_TASK_SPACE_NOT_SELECTED", "params.space is required");
    }
    const rec = this.spaces.get(params.space);
    this.spaces.noteNamed(rec);
    return rec;
  }

  /**
   * @param {{space: number, page: string}} params
   * @returns {{space: object, page: object, tab: Element, browser: Element, browsingContext: BrowsingContext}}
   */
  resolvePage(params) {
    const space = this.resolveSpace(params);
    if (typeof params.page !== "string" || !params.page) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "params.page must be a page label such as \"p1\"");
    }
    const page = this.pages.get(space, params.page);
    const tab = this.pages.tabFor(page);
    const browser = tab.linkedBrowser;
    if (this.spaces.isAgentTask(space)) {
      keepAlive(tab);
    }
    const browsingContext = browser.browsingContext;
    if (!browsingContext) {
      throw new ZenError("ZEN_PAGE_UNRESPONSIVE", `page ${page.label} has no browsing context (unloaded?)`);
    }
    return { space, page, tab, browser, browsingContext };
  }

  /**
   * Call `fn` in content/<module>.sys.mjs in the process of `bc`.
   *
   * @param {BrowsingContext} bc
   * @param {string} spec  "module#fn"
   * @param {any} args
   * @param {{timeout?: number, gate?: {kind: "read"|"act", method: string}}} [opts]
   *   gate: an agent method's call, which the sign-in rules check in the page
   */
  async content(bc, spec, args, opts = {}) {
    const hash = spec.indexOf("#");
    if (hash <= 0) {
      throw new ZenError("ZEN_INTERNAL", `content spec must be "module#fn", got ${spec}`);
    }
    const module = spec.slice(0, hash);
    const fn = spec.slice(hash + 1);
    const wg = bc.currentWindowGlobal;
    if (!wg || wg.isClosed) {
      throw new ZenError("ZEN_PAGE_UNRESPONSIVE", "the page has no live document", { reason: "no_window_global" });
    }
    let actor;
    try {
      actor = wg.getActor(ACTOR_NAME);
    } catch (e) {
      throw new ZenError("ZEN_UNSUPPORTED", `cannot reach this document (${wg.documentURI?.spec}): ${e.message}`);
    }
    const call = actor.call(module, fn, args, opts.gate);
    if (!opts.timeout) {
      return call;
    }
    const timer = deadline(
      opts.timeout,
      () => new ZenError("ZEN_PAGE_UNRESPONSIVE", `content call ${spec} timed out after ${opts.timeout}ms`)
    );
    try {
      return await Promise.race([call, timer.promise]);
    } finally {
      timer.clear();
    }
  }

  #registerActor() {
    const def = {
      parent: { esModuleURI: `${BASE_URL}actors/ZeniusParent.sys.mjs` },
      child: {
        esModuleURI: `${BASE_URL}actors/ZeniusChild.sys.mjs`,
        events: { DOMWindowCreated: {} },
      },
      allFrames: true,
      // Gecko 160 refuses getActor() in web content processes unless the
      // actor opts in.
      safeForUntrustedWebProcess: true,
      // Tabs only: not sidebars, devtools or other embedded browsers.
      messageManagerGroups: ["browsers"],
      // Web content processes only (I5, defense in depth). Without this
      // the child, and the content modules it
      // loads, ran in file, privilegedabout and extension processes, and in
      // the parent's own tab documents (about:preferences). There a content
      // call fails with ZEN_UNSUPPORTED, after checkContentCall has already
      // refused every method that acts in documents.
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP"],
    };
    try {
      ChromeUtils.registerWindowActor(ACTOR_NAME, def);
    } catch (e) {
      log("actor already registered; re-registering", e.message);
      ChromeUtils.unregisterWindowActor(ACTOR_NAME);
      ChromeUtils.registerWindowActor(ACTOR_NAME, def);
    }
  }

  // ---------------------------------------------------------------------------
  // Events

  /**
   * In-process listeners (zen-ux's controller, watchPopups).
   *
   * @param {(event: string, params: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  addEventListener(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** An event for in-process listeners only (zen-ux), such as one that carries an element. */
  emitLocal(event, params) {
    for (const listener of this.#eventListeners) {
      try {
        listener(event, params);
      } catch (e) {
        log("event listener failed", e.message);
      }
    }
  }

  emit(event, params) {
    for (const listener of this.#eventListeners) {
      try {
        listener(event, params);
      } catch (e) {
        log("event listener failed", e.message);
      }
    }
    for (const conn of this.#subscribers) {
      if (conn.closed) {
        this.#subscribers.delete(conn);
        continue;
      }
      if (conn.state.subscriptions?.some(filter => matches(filter, event, params))) {
        conn.send({ event, params });
      }
    }
  }

  /**
   * events.subscribe: send matching events to this connection as event frames.
   *
   * @param {object} conn
   * @param {{names?: string[], space?: number, page?: string}} filter
   */
  subscribe(conn, filter) {
    conn.state.subscriptions ??= [];
    conn.state.subscriptions.push(filter);
    this.#subscribers.add(conn);
  }

  /**
   * An event a content module sent through the Zenius actor. The content
   * process is the untrusted side, so only the names content modules send
   * (CONTENT_EVENTS), only from a document of an agent task's page, with
   * the space and page set here; anything else is dropped. A forged
   * spaceChanged or popup would reach zen-ux's UI and action receipts.
   */
  onContentEvent(actor, msg) {
    const name = msg?.name;
    if (!CONTENT_EVENTS.has(name)) {
      log(`dropped a content event named ${JSON.stringify(String(name).slice(0, 64))}`);
      return;
    }
    // I5: an agent reads nothing from a document that isn't web content, such
    // as the console of a local file or of an add-on's frame in its page
    // (method-boundary.md, item 3). Checked here, on the parent's own record
    // of the document, for every content event and process alike.
    const wgp = actor.manager;
    if (!wgp || notWebContent(wgp)) {
      return;
    }
    if (name === "observe.guardFailed") {
      // Logged for any tab's document: it goes to no agent.
      lazy.noteGuardFailure(msg.params);
      return;
    }
    const browser = actor.browsingContext?.top?.embedderElement;
    const page = browser ? this.pages.forBrowser(browser) : null;
    const space = page ? this.spaces.peek(page.spaceId) : null;
    if (!space || space.gone || !this.spaces.isAgentTask(space)) {
      if (name === "observe.refused" && browser) {
        this.#keptRefusal(browser, msg.params);
      }
      return;
    }
    const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};
    this.emit(name, { ...params, space: page.spaceId, page: page.label });
  }

  /**
   * The reminders' hook (zen-ux's choice A): a refusal in a document no live
   * task holds, in a tab whose top document holds the agent's code and so
   * keeps the task's refusals (content/refusals.sys.mjs). The event comes
   * from the page's own process: only a kind the guards report passes, with
   * api and asked cut short.
   *
   * @param {Element} browser  the tab's top <browser>
   * @param {any} params  the event's
   */
  #keptRefusal(browser, params) {
    const kind = params?.kind;
    if (typeof kind !== "string" || !KEPT_REFUSAL_KINDS.has(kind)) {
      return;
    }
    // No document has the agent's code: agentcode.sys.mjs needn't load (I4).
    if (!Services.ppmm.sharedData.get(AGENT_CODE_DOCS_KEY)?.size || !lazy.agentCodeDocument(browser)) {
      return;
    }
    const text = value => (typeof value === "string" ? value.slice(0, KEPT_TEXT_MAX) : "");
    noteKeptRefused({ browser, kind, api: text(params.api), asked: text(params.asked) });
  }

  #onConnectionClosed(conn) {
    this.#subscribers.delete(conn);
    conn.state.onClose?.forEach(fn => {
      try {
        fn();
      } catch {}
    });
  }
}

/** Did Zen restore the tab unloaded, or the user unload it? */
function isUnloaded(tab) {
  return !tab.linkedPanel || tab.hasAttribute("pending");
}

/** The URL an unloaded tab would show: its current history entry's. */
function restoredURI(tab) {
  let url = "about:blank";
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    const entries = state.entries ?? [];
    url = entries[(state.index ?? entries.length) - 1]?.url || url;
  } catch {}
  try {
    return Services.io.newURI(url);
  } catch {
    return Services.io.newURI("about:blank");
  }
}

/** Does the tab have documents now: inserted, restored, with a window global? */
function hasDocument(tab) {
  return (
    !!tab.linkedPanel && !tab.hasAttribute("pending") && !!tab.linkedBrowser?.browsingContext?.currentWindowGlobal
  );
}

/**
 * The events content modules send: content/refusals.sys.mjs (refused,
 * sound, guardFailed), content/media.sys.mjs (media) and
 * content/console.sys.mjs (console).
 */
const CONTENT_EVENTS = new Set(["observe.console", "observe.refused", "observe.sound", "observe.media", "observe.guardFailed"]);

/**
 * Run the control check, then `gates[i…]`, synchronously until one returns a
 * promise; then wait for it, check control again, and go on with the rest.
 *
 * @returns {null|Promise<void>} null when every step passed without waiting
 */
function runChain(control, gates, i) {
  const wait = control();
  if (isThenable(wait)) {
    return Promise.resolve(wait).then(() => runGates(control, gates, i) ?? undefined);
  }
  return runGates(control, gates, i);
}

function runGates(control, gates, i) {
  for (; i < gates.length; i++) {
    const wait = gates[i]();
    if (isThenable(wait)) {
      const next = i + 1;
      return Promise.resolve(wait).then(() => runChain(control, gates, next) ?? undefined);
    }
  }
  return null;
}

function isThenable(value) {
  return !!value && typeof value.then === "function";
}

/** A response frame. NaN, ±Infinity, -0 and BigInt results go in `unserializable`. */
function resultFrame(id, result) {
  if (result === undefined) {
    return { id, result: null };
  }
  if (result instanceof Unserializable) {
    return { id, result: null, unserializable: result.text };
  }
  if (typeof result === "bigint") {
    return { id, result: null, unserializable: `${result}n` };
  }
  if (typeof result === "number" && (!Number.isFinite(result) || Object.is(result, -0))) {
    return { id, result: null, unserializable: Object.is(result, -0) ? "-0" : String(result) };
  }
  return { id, result };
}

function matches(filter, event, params) {
  if (filter.names?.length && !filter.names.includes(event)) {
    return false;
  }
  if (filter.space !== undefined && params?.space !== filter.space) {
    return false;
  }
  if (filter.page !== undefined && params?.page !== filter.page) {
    return false;
  }
  return true;
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

function chromeFileExists(url) {
  try {
    const reg = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
    const resolved = reg.convertChromeURL(Services.io.newURI(url));
    if (resolved instanceof Ci.nsIFileURL) {
      return resolved.file.exists();
    }
    return true;
  } catch {
    return false;
  }
}

export const ZeniusService = new Service();

/**
 * page.* methods after which their Page becomes its space's current one (the
 * tab the user lands on), as Ego Lite's page model activates the target for
 * them: evaluate, snapshot and screenshot, page-side waits, navigation, and
 * every action. Metadata reads (url, title, info), waitForURL, waitForEvent,
 * events and dialog handling leave the current Page alone, as in Ego. A new
 * action method belongs here.
 */
const ACTIVATING_PAGE_METHODS = new Set([
  "page.goto",
  "page.reload",
  "page.evaluate",
  "page.snapshot",
  "page.screenshot",
  "page.fetch",
  "page.cdp",
  "page.waitForFunction",
  "page.waitForSelector",
  "page.waitForLoadState",
  "page.waitForFileChooser",
  "page.click",
  "page.dblclick",
  "page.dragAndDrop",
  "page.fill",
  "page.focus",
  "page.hover",
  "page.press",
  "page.selectOption",
  "page.setInputFiles",
  "page.keyboard",
  "page.mouse",
]);

/**
 * The install this runtime was loaded from: scripts/install.sh writes
 * chrome/JS/zenius/install.json next to the modules. Read once at startup,
 * because a later install changes the files but not the code already
 * running; zenius doctor compares the two to tell whether Zen still runs an
 * earlier install. Null on dev profiles, which zen-dev.sh fills by copying.
 *
 * @returns {Promise<{commit: string, installedAt: string}|null>}
 */
async function readInstall() {
  try {
    const path = PathUtils.join(PathUtils.profileDir, "chrome", "JS", "zenius", "install.json");
    const { commit, installedAt } = await IOUtils.readJSON(path);
    return { commit: String(commit ?? ""), installedAt: String(installedAt ?? "") };
  } catch {
    return null;
  }
}
