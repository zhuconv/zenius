// ZeniusService: the per-process singleton behind every browser window. It
// owns the RPC server, the method registry and dispatcher (with the I3
// control gate), spaces, pages, events and the actor.

import { ErrorCodes, ZenError, toWireError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { RpcServer } from "chrome://userscripts/content/zenius/modules/server.sys.mjs";
import { Spaces, newLedger } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";
import {
  Pages,
  defaultPageBudget,
  heldStepOf,
  ownValue,
  readTabValue,
  secretMarkOf,
  secretSitesOf,
  secretTaskOf,
} from "chrome://userscripts/content/zenius/modules/pages.sys.mjs";
import {
  addingAgentTab,
  allTabs,
  copiesOf,
  fillCopies,
  followWindowSync,
  hostWindow,
  KEPT_REFUSAL_KINDS,
  KEPT_TEXT_MAX,
  liveCopy,
  markLiveCopy,
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
  holdPriority,
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
  KEPT_BROWSERS_KEY,
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
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  TabStateCache: "moz-src:///browser/components/sessionstore/TabStateCache.sys.mjs",
  TabStateFlusher: "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  agentCodeDocument: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
  hasAgentCodeMarks: "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs",
  holdOf: "chrome://userscripts/content/zenius/observe/hold.sys.mjs",
  markEvident: "chrome://userscripts/content/zenius/observe/evidence.sys.mjs",
  // The hold's module loads with a task's first hold, not at startup (I4).
  cleanLoad: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  RESUME_CLEANABLE: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
  TASK_END_RECORD_TIMEOUT_MS: "chrome://userscripts/content/zenius/modules/handoff.sys.mjs",
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
  // The reply after a finish's hand-back steps load with its first finish (I4).
  lastClearOf: "chrome://userscripts/content/zenius/input/handback.sys.mjs",
  snapshotKept: "chrome://userscripts/content/zenius/input/handback.sys.mjs",
  typedSecretsIn: "chrome://userscripts/content/zenius/input/handback.sys.mjs",
  capturing: "chrome://userscripts/content/zenius/observe/capture.sys.mjs",
});

/** @type {object|null|undefined} the observe layer's isolated world once loaded; null if it isn't there */
let agentWorldModule;
/** The observe layer's isolated world (observe/agentworld.sys.mjs). It loads with the first hold or the first task's end (I4). */
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
const NO_FEEDBACK = Object.freeze({ pending: () => null, cooldown: () => null });
/** zenius doctor's calls, which a report's list of calls leaves out (#noteCall). */
const STATUS_READS = new Set(["browser.version", "browser.health", "browser.methods"]);
/** The restart rebuild waits at most this long for Zen's session restore, or for a first window. */
const REBUILD_WAIT_MS = 30_000;
/** How long the hand back waits for the blanks' session save, each part. */
const SESSION_SAVE_MS = 5000;
/** How long an unloaded tab's insert waits for Zen to put its history back. */
const INSERT_WAIT_MS = 5000;
/** How long each frame of a document from before zenius started has to say what of the user's it holds. */
const USER_INPUT_WAIT_MS = 2000;
/** How long a held secret step's tab, loaded before zenius started, may load before every site's caches clear anyway. */
const EARLY_LOAD_WAIT_MS = 30_000;
/** How long a tab the agent takes waits for its documents' guards. */
const GUARD_TIMEOUT_MS = 2000;
/**
 * At most this many clean copies on demand of one tab within `windowMs`. A
 * written page needs one per document it gets written in; more means each
 * copy comes in written again (seen in probes of Take over).
 */
const CLEAN_COPY_CAP = { max: 5, windowMs: 60_000 };
/**
 * The reply after a finish waits this long at most for the finish's own
 * loads (endTaskCode) before it takes the kept pages' baselines, and for
 * the pages' answers on secret fields at the resume.
 */
const FINISH_LOADS_WAIT_MS = 10_000;
const KEPT_SECRETS_WAIT_MS = 3000;
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
   * exports in index order (the observe layer: pending navigation, open dialog).
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
  /** <browser> → the top document (innerWindowId) its last clean copy made (#cleanCopy). */
  #cleanDocs = new WeakMap();
  /** <browser> → when its recent clean copies on demand began (ms), for CLEAN_COPY_CAP. */
  #cleanCopyTimes = new WeakMap();
  /** Tasks whose end endTaskCode has handled, until the agent has them again. */
  #codeEnded = new WeakSet();
  /** @type {Set<object>} connections with event subscriptions */
  #subscribers = new Set();
  /** @type {JsonStore|null} */
  #store = null;
  #notePage = undefined;
  /** the UI's notePageCall (ui/pages.sys.mjs), null without it. */
  #notePageCall = undefined;
  /** the input layer's step ring (input/steps.sys.mjs), null without it. */
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
   * zenius feedback's reports, for the sidebar's card:
   * pending(), cooldown() and the actions it takes on the user's own click.
   * Until a client composes a report, the module isn't loaded and both reads
   * are null, so the sidebar's reads load nothing.
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
    this.spaces.beforeAgentControl = rec => this.#dropUnblanked(rec);
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
      this.#watchTabsIn(win);
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
   * The UI's takeover detector: the space and page of a tab, without
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
   * sync): the page is that copy now. Keep-alive goes with it, and the UI
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
    Services.ppmm.sharedData.set(KEPT_BROWSERS_KEY, this.#keptBrowserIds());
    Services.ppmm.sharedData.flush();
    // Before a new page's first load, as the guards.
    this.updateBackstops();
    // The observe layer: its observers of the user's own browsing run only from
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
   * An actor whose child guards a task's documents: the UI's ZeniusClipboard
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
   * document with the agent's code (the observe layer's marks, the UI's kept
   * ones), unless the opener is a page of a live task, whose popups join it
   * (item 2). A refused open opens nothing: the parent can't tell a form's
   * POST from a GET there, and turning a POST into a GET is never right.
   * The UI's pill tells the user the page can't open windows until it
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

  /** Task record → its hand back's blank while it runs (blankSecretSteps), for a second hand back meanwhile. */
  #blanking = new WeakMap();

  /** Task record → how many of the agent's own ways back run now (agentHandBack): blankSecretSteps skips meanwhile. */
  #agentHandBacks = new WeakMap();

  /** Task record → the clear a mark during the step started (#clearAtMark), which the hand back's blank waits for. */
  #markClears = new WeakMap();

  /**
   * Page record → its top document as the restart rebuild found it, loaded
   * by Zen before zenius started (topDocOf), with settled once the agent's
   * first call has dealt with it (#beforeStartGate).
   */
  #beforeStart = new WeakMap();

  /** Page record → the settling under way (#settleBeforeStart), which other calls on it wait for. */
  #beforeStartRuns = new WeakMap();

  /** Pages whose settling loads them again now: that page.goto goes through the gate. */
  #beforeStartLoads = new WeakSet();

  /** Holds beginning now (holdForUser): their held page's sites are noted while the task is still the agent's. */
  #holdsStarting = 0;

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
   * the UI's userTakeOver). modules/handoff.sys.mjs holds it and makes it
   * safe for their typing, then the task is the user's to hold, with the
   * reload on the spaceChanged for the UI's card. A page the agent made is
   * refused to the agent; the user's Take over holds it as it is.
   *
   * With `secret`, the agent's step will show a secret (an API key, a
   * token, recovery codes): the held tab is blanked at the hand back
   * (blankSecretSteps), and spaceChanged says secret, for the UI's card.
   *
   * @param {object} rec  the live task's SpaceRecord
   * @param {Element} browser
   * @param {{source?: "agent"|"user", reason?: string, secret?: boolean}} [opts]
   * @returns {Promise<{agentPage: boolean, how: "reload"|"get"|null, reloaded: string[], carried: boolean, openerCut: boolean, evidence: Record<string, Record<string, string>>}>}
   *   evidence: label → the evidence each reloaded page had before its load
   *   (the observe layer's {reason: detail}), for the UI's notice
   * @throws {ZenError} ZEN_HANDOFF_REFUSED
   */
  async holdForUser(rec, browser, { source = "user", reason = "manual_takeover", secret = false } = {}) {
    // The hand back tells the agent what changed since it last had control.
    if (rec.ownership === "agent") {
      this.spaces.clearHandBackNotes(rec);
    }
    this.#heldForUser = true;
    // The held page's value comes before its quiet load, so the step's sites
    // are noted from its first request: a mark made during the step covers
    // what it loaded before (markSecretByUser).
    const tab = tabOfBrowser(browser);
    const heldTab = tab && this.#ownTabIds(rec).has(this.pages.tabId(tab)) ? tab : null;
    if (heldTab) {
      this.pages.markHeld(heldTab, rec);
    }
    this.#holdsStarting++;
    let result;
    try {
      // The agent's hand-off of its own page is refused before its code is discarded.
      result = await lazy.holdFor(this, rec, browser, { refuseAgentPage: source === "agent" });
    } catch (e) {
      this.#holdNotBegun(rec, heldTab);
      throw e;
    } finally {
      this.#holdsStarting--;
    }
    const labels = result.reloaded.map(b => this.pages.forBrowser(b)?.label).filter(Boolean);
    // What each reloaded page had, for the UI's notice (Take over's result)
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
      this.#holdNotBegun(rec, heldTab);
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
      this.#holdNotBegun(rec, heldTab);
    } else if (source === "user" || rec.ownership === "agent") {
      // The popups that share its hold now are the step's too.
      this.#noteHeldWith(rec, browser);
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
    } else {
      // The user's Take over came first: their hold stays, the agent's page
      // is the step's too, and with secret the step is a secret one.
      this.#noteHeldWith(rec, browser);
      if (source === "agent" && secret) {
        this.noteSecretStep(rec, browser);
      }
    }
    return { agentPage: result.agentPage, how: result.how, reloaded: labels, carried: result.carried, openerCut: result.openerCut, evidence };
  }

  /** The ids of the task's own tabs (pages.tabsOf). */
  #ownTabIds(rec) {
    return new Set(this.pages.tabsOf(rec).map(tab => this.pages.tabId(tab)));
  }

  /** H and the popups of its hold are the held step's tabs (pages.markHeld), each with what the step loaded so far. */
  #noteHeldWith(rec, browser) {
    const own = this.#ownTabIds(rec);
    const { sites, overflow } = this.#heldSites(rec);
    for (const held of lazy.heldWith(browser)) {
      const tab = tabOfBrowser(held);
      if (tab && own.has(this.pages.tabId(tab))) {
        this.pages.markHeld(tab, rec, { sites: [...sites], overflow });
      }
    }
  }

  /**
   * A tab a held step's tab opens joins the step (noteOpenedTab,
   * adoptPopup): a held value and a mark as its opener has, each with the
   * sites the step's tabs keep already, overflow included, so every tab of
   * the step keeps every site. noteSecretRequest's early return counts on
   * it, and a mark made after the opener closed still takes what it loaded.
   *
   * @param {object} rec
   * @param {Element} tab  the new tab
   * @param {Element|null} openerTab
   */
  #joinStep(rec, tab, openerTab) {
    if (openerTab && heldStepOf(openerTab)?.task === rec.id) {
      const { sites, overflow } = this.#heldSites(rec);
      this.pages.markHeld(tab, rec, { sites: [...sites], overflow });
    }
    const mark = openerTab ? secretMarkOf(openerTab) : null;
    if (mark?.task === rec.id) {
      const { sites, overflow } = this.#markedSites(rec);
      this.pages.markSecret(tab, rec, { by: mark.by, sites: [...sites], overflow });
    }
  }

  /** A hold that didn't begin (refused, failed, the task ended): its page's held value goes, unless the task is held anyway. */
  #holdNotBegun(rec, tab) {
    if (tab && (rec.gone || rec.ownership !== "agentDelegatedToUser")) {
      this.pages.clearHeld(tab);
    }
  }

  /**
   * The observe layer's discard: the agent's sandboxes, and the workers they
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
   * The page's evidence, its top document and frames (the observe layer's
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
   * documents have what the agent's code left hooked in them (the observe layer's
   * evidence), and the agent didn't make it: a
   * page the agent made comes back the same from a reload, so the input layer's
   * guard drops the typing there instead. A listed or flagged page gets
   * the UI's warning, not a clean copy.
   *
   * @param {Element|BrowsingContext} target
   * @param {Record<string, string>} [evidence]  the page's, if already read
   */
  needsCleanCopy(target, evidence = this.evidenceOf(target)) {
    return lazy.needsCleanCopy(evidence);
  }

  /**
   * Where a clean load of the page goes, if not to its current URL:
   * the observe layer's urlBefore (the URL before the agent's code changed it in
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
   * The input layer's typing guard stopped the user's first press or key in a page
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
   *   (the UI's notice says why it reloaded)
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
   * @param {{onDemand?: boolean, recordMs?: number}} [opts]  recordMs: the
   *   form record's limit (handoff.sys.mjs cleanLoad)
   */
  #cleanCopy(browser, { onDemand = false, recordMs } = {}) {
    let running = this.#cleanLoads.get(browser);
    if (!running) {
      if (onDemand) {
        this.#countCleanCopy(browser);
      }
      running = lazy
        .cleanLoad(this, browser, { sameSite: true, evidentFails: onDemand, recordMs })
        .then(result => {
          this.#cleanDocs.set(browser, result?.doc ?? null);
          return result;
        })
        .finally(() => this.#cleanLoads.delete(browser));
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
   * (the snapshot layer's kept group, 2026-11-20).
   *
   * Each page that stays has its process held up (holdPriority) from before
   * its discard until zenius is done with it: the callers release keepAlive
   * right after this starts, and the discard and a clean load then run in a
   * page that is a background tab.
   *
   * @param {object} rec  the task
   * @param {Set<Element>} [closing]  tabs finish() closes: discarded, never reloaded
   * @returns {Promise<Element[]>} the pages that loaded afresh (a reply
   *   after the finish takes its baselines from those new documents)
   */
  endTaskCode(rec, closing = new Set()) {
    // Once per end: later events of the user's space don't run it again.
    this.#codeEnded.add(rec);
    const tabs = this.pages.tabsOf(rec);
    // The task's names for its pages, read while the tabs are still the
    // task's: the sidebar's note names those that load afresh.
    const labels = new Map(tabs.map(tab => [tab.linkedBrowser, this.pages.forBrowser(tab.linkedBrowser)?.label ?? null]));
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
    const held = new Map(stays.map(browser => [browser, holdPriority(browser)]));
    return Promise.all(discards)
      .then(() => this.reloadHookedAfterTask(stays, held))
      .then(
        reloaded => {
          this.#notePagesReloaded(rec, reloaded, labels);
          return reloaded;
        },
        e => {
          log("reloading the hooked pages at the task's end failed:", e.message);
          return [];
        }
      )
      .finally(() => {
        for (const release of held.values()) {
          release();
        }
      });
  }

  /**
   * At the task's end, after the discard: every page of it that stays open
   * and has what the agent's code left hooked in it loads afresh, its form
   * carried over (needsCleanCopy). One that doesn't load afresh keeps its
   * evidence, and what such a page keeps.
   *
   * @param {Element[]} browsers  the task's pages that stay open
   * @param {Map<Element, () => void>} [held]  their process holds
   *   (endTaskCode): each is released once its page is done with
   * @returns {Promise<Element[]>} those whose clean load went through, in
   *   the order given
   */
  async reloadHookedAfterTask(browsers, held = new Map()) {
    const done = browser => {
      held.get(browser)?.();
      held.delete(browser);
    };
    // Tests of the other layers keep what the agent put in a page (the
    // hand-off's and Resume's loads skip too; never off otherwise).
    if (!Services.prefs.getBoolPref("zenius.handoff.quietReload", true)) {
      browsers.forEach(done);
      return [];
    }
    const hooked = browsers.filter(b => b?.isConnected && b.browsingContext?.currentWindowGlobal && this.needsCleanCopy(b));
    for (const browser of browsers) {
      if (!hooked.includes(browser)) {
        done(browser);
      }
    }
    const loaded = new Set();
    await Promise.all(
      hooked.map(b =>
        this.#cleanCopy(b, { recordMs: lazy.TASK_END_RECORD_TIMEOUT_MS })
          .then(() => {
            loaded.add(b);
            log("a hooked page reloaded at its task's end");
          })
          .catch(e => log("a hooked page didn't reload at its task's end, so it keeps its evidence:", e.message))
          .finally(() => done(b))
      )
    );
    return hooked.filter(b => loaded.has(b));
  }

  /**
   * The pages of `rec` that loaded afresh at its end, for the sidebar's note
   * in the task's chat: the in-process event pagesReloaded, {space, pages:
   * [{page, url}]}, once per end and only when one did. page is the task's
   * label for it (null if it had none), url its address after the load.
   * Never to a connection (emitLocal): a client subscribed with no space
   * would read other tasks' addresses.
   *
   * @param {object} rec
   * @param {Element[]} reloaded  reloadHookedAfterTask's answer
   * @param {Map<Element, string|null>} labels  the task's labels, read at its end
   */
  #notePagesReloaded(rec, reloaded, labels) {
    if (!reloaded.length) {
      return;
    }
    const pages = reloaded.map(browser => {
      let url = null;
      try {
        url = browser.currentURI?.spec ?? null;
      } catch {}
      return { page: labels.get(browser) ?? null, url };
    });
    log(`the task's end: ${pages.length} page(s) loaded afresh`);
    this.emitLocal("pagesReloaded", { space: rec.id, pages });
  }

  /**
   * The agent says the user's step in `browser` will show a secret (its
   * hand-off with secret): the hand back blanks that tab first, with the
   * tabs opened from it during the hold. Each gets a secret step's mark in
   * Zen's session (pages.markSecret), on every copy: the hand back finds it
   * wherever window sync or a move put its docShell, and after a quit, a
   * crash or an update's restart. A popup that joins the hold later gets it
   * as it joins the task (adoptPopup), and so does a tab opened from a
   * marked one with no opener (noteOpenedTab).
   *
   * A mark made during the step (the agent's secret after the user's Take
   * over, or the user's own, markSecretByUser) marks every tab with the
   * step's held value too, after a restart as well, when the hold itself
   * is gone. The marks take the sites the step loaded before them, whose
   * caches are cleared now (#clearAtMark), and spaceChanged says so.
   *
   * @param {object} rec
   * @param {Element|null} browser  the held page, if the hold names one
   * @param {{by?: "agent"|"user"}} [opts]  whose mark it is
   * @returns {boolean} whether a tab is marked
   */
  noteSecretStep(rec, browser, { by = "agent" } = {}) {
    const own = this.#ownTabIds(rec);
    const tabs = new Map();
    // H, and any popup that joined its hold already. Without a hold in this
    // session (a restart), only the page itself.
    for (const held of browser ? (this.#heldForUser ? lazy.heldWith(browser) : [browser]) : []) {
      const tab = tabOfBrowser(held);
      if (tab && own.has(this.pages.tabId(tab))) {
        tabs.set(this.pages.tabId(tab), tab);
      }
    }
    for (const tab of this.#heldTabs(rec)) {
      tabs.set(this.pages.tabId(tab), tab);
    }
    if (!tabs.size) {
      log("a secret step's page has no tab: the hand back can't blank it");
      return false;
    }
    const during = rec.ownership === "agentDelegatedToUser";
    const before = during ? this.secretStepOf(rec) : null;
    const { sites, overflow } = this.#heldSites(rec);
    for (const tab of tabs.values()) {
      this.pages.markSecret(tab, rec, { by, sites: [...sites], overflow });
    }
    // At the hold's start too: its quiet load came before the mark, so the
    // cache wasn't held off for it.
    this.#clearAtMark(rec);
    // At the hold's start, spaceChanged's own secret says it (setOwnership).
    if (during) {
      const now = this.secretStepOf(rec);
      if (now.secret !== before.secret || now.secretBy !== before.secretBy) {
        this.spaces.secretStepChanged(rec, now);
      }
    }
    return true;
  }

  /** The task's own tabs with the held step's value (pages.markHeld). */
  #heldTabs(rec) {
    return this.pages.tabsOf(rec).filter(tab => heldStepOf(tab)?.task === rec.id);
  }

  /** The sites the held step's tabs loaded, and whether more came than they keep. */
  #heldSites(rec) {
    return this.#stepSites(rec, heldStepOf);
  }

  /** The sites the step's marks keep, and whether one says more came. */
  #markedSites(rec) {
    return this.#stepSites(rec, secretMarkOf);
  }

  /** The sites one kind of the task's step values keeps (heldStepOf, secretMarkOf), and whether one says overflow. */
  #stepSites(rec, valueOf) {
    const sites = new Set();
    let overflow = false;
    for (const tab of this.pages.tabsOf(rec)) {
      const value = valueOf(tab);
      if (value?.task === rec.id) {
        value.sites.forEach(site => sites.add(site));
        overflow ||= value.overflow;
      }
    }
    return { sites, overflow };
  }

  /**
   * A mark, at the hold's start or during the step: what the step loaded
   * before it (the hold's quiet load included) may be in the HTTP and image
   * caches, where another task's page could read it with cache
   * "only-if-cached" until the hand back clears them. They go now. The hand
   * back's blank waits for this clear, and clears the same sites again
   * after it.
   */
  #clearAtMark(rec) {
    const { sites, overflow } = this.#heldSites(rec);
    this.#queueClear(rec, sites, overflow);
  }

  /**
   * The sites whose caches may hold what marked tabs showed, as the blank
   * reads them: those their marks noted and those of their history, and
   * whether a mark says overflow. Read before the marks go.
   *
   * @param {Element[]} tabs
   */
  #unblankedSites(tabs) {
    const sites = new Set();
    let overflow = false;
    for (const tab of tabs) {
      const mark = secretMarkOf(tab);
      if (mark) {
        [...mark.sites, ...historySites(tab)].forEach(site => sites.add(site));
        overflow ||= mark.overflow;
      }
    }
    return { sites, overflow };
  }

  /**
   * Marks that go with no blank to clear their sites: a marked tab the user
   * closes, the task's end (Stop), a tab the flip's backstop takes out of
   * the task (#dropUnblanked). Their sites' caches may still hold what the
   * step showed, the images it loaded after the mark among them, so they're
   * cleared now as the blank would clear them, every site's past the cap.
   *
   * @param {object|null} rec  the marks' task
   * @param {{sites: Set<string>, overflow: boolean}} left  #unblankedSites
   * @param {string} why  for the log
   */
  #clearUnblanked(rec, { sites, overflow }, why) {
    if (sites.size || overflow) {
      log(`a secret step's ${why}: its sites' caches are cleared with no blank`);
      this.#queueClear(rec, sites, overflow);
    }
  }

  /**
   * A clear of a secret step's sites, after any its task has running, fire
   * and forget: the hand back's blank and the agent's own way back wait for
   * it (#blankSteps, agentHandBack). A task already gone keeps no queue.
   */
  #queueClear(rec, sites, overflow) {
    if (!sites.size && !overflow) {
      return;
    }
    const run = ((rec && this.#markClears.get(rec)) || Promise.resolve())
      .then(() => this.#clearSecretCaches(sites, { overflow }))
      .catch(e => log(`a secret step's cache clear failed: ${e.message}`));
    if (!rec) {
      return;
    }
    this.#markClears.set(rec, run);
    run.then(() => {
      if (this.#markClears.get(rec) === run) {
        this.#markClears.delete(rec);
      }
    });
  }

  /**
   * Whether the step the user holds is a secret one, and whose mark makes
   * it so: "agent" when any of its tabs carries the agent's, else "user".
   * The UI's cards read it at each draw, after a restart too, so it stays
   * synchronous: a look at the task's own tabs' marks.
   *
   * @param {object} rec
   * @returns {{secret: boolean, secretBy: "agent"|"user"|null}}
   */
  secretStepOf(rec) {
    let secretBy = null;
    if (rec && !rec.gone && rec.kind === "task") {
      for (const tab of this.pages.tabsOf(rec)) {
        const mark = secretMarkOf(tab);
        if (mark?.task === rec.id) {
          secretBy = mark.by;
          if (secretBy === "agent") {
            break;
          }
        }
      }
    }
    return { secret: secretBy !== null, secretBy };
  }

  /**
   * The user's own mark on the step they hold: their click on a card's
   * toggle (the UI), never an agent's or a page's. No RPC method,
   * parameter, SDK call or content message reaches it. It takes a task held
   * after the agent's hand-off or the user's own Take over, checked here.
   *
   * On marks the step's tabs as the agent's secret does (noteSecretStep),
   * with the sites they loaded before, whose caches go at once. From then
   * on what they load isn't cached, the agent's own way back is refused
   * (methods/spaces.sys.mjs), and the user's Resume blanks them. The marks
   * are written before it returns, so a Resume right after blanks too. Off
   * takes back the user's own marks only: an agent's stays.
   *
   * @param {object} rec
   * @param {boolean} on
   * @returns {{ok: boolean, why?: string, secret: boolean, secretBy: "agent"|"user"|null}}
   *   ok: the step is now as asked
   */
  markSecretByUser(rec, on) {
    const started = Date.now();
    const answer = (ok, why) => {
      const state = this.secretStepOf(rec);
      log(`the user's secret mark ${on ? "on" : "off"}: ${ok ? "done" : `not done, ${why}`}; the step is ${state.secret ? `secret by the ${state.secretBy}` : "not secret"} (${Date.now() - started} ms)`);
      return { ok, ...(ok ? {} : { why }), ...state };
    };
    if (typeof on !== "boolean") {
      return answer(false, "on must be true or false");
    }
    if (!rec || rec.gone || rec.ended || rec.kind !== "task") {
      return answer(false, "the task has ended");
    }
    if (rec.ownership !== "agentDelegatedToUser" || (rec.heldBy !== "agent" && rec.heldBy !== "user")) {
      return answer(false, "the user doesn't hold the task after a hand-off or a Take over");
    }
    if (on) {
      // A hold from before a restart into this version has no held values: its page, then.
      const browser = this.#heldTabs(rec).length ? null : (this.pages.userTab(rec)?.linkedBrowser ?? null);
      return this.noteSecretStep(rec, browser, { by: "user" }) ? answer(true) : answer(false, "the step has no page to mark");
    }
    const before = this.secretStepOf(rec);
    for (const tab of this.pages.tabsOf(rec)) {
      this.pages.unmarkByUser(tab, rec);
    }
    const now = this.secretStepOf(rec);
    if (now.secret !== before.secret || now.secretBy !== before.secretBy) {
      this.spaces.secretStepChanged(rec, now);
    }
    return now.secret ? answer(false, "the agent marked the step secret") : answer(true);
  }

  /**
   * At the hand back, before the agent has control (the user's Resume,
   * spaces.takeOver, spaces.claim): each of the task's tabs that carries a
   * secret step's mark (noteSecretStep: H, the popups of its hold, the tabs
   * opened from it) shows about:blank with its history gone, so nothing the
   * agent can reach still shows the secret, back and the back-forward cache
   * included (the Cloudflare token, 2026-11-21). The marks are in Zen's
   * session, so a quit, a crash or an update's restart during the hold
   * keeps them. Only the task's own tabs count: one the user took out of the
   * task stays as it is. The hand back's notes say which pages blanked
   * (blanked). A tab that doesn't blank leaves the task instead
   * (#dropSecretTab): the agent never gets it back, and the notes don't name
   * it. The blanks reach Zen's session file before the agent has control
   * (#saveBlanks). A second hand back that comes meanwhile (the agent's
   * takeOver during the user's Resume, or the reverse) waits for the same
   * run, so neither gives the agent control before the blank is done.
   *
   * @param {object} rec
   * @returns {Promise<string[]>} the labels of the pages blanked
   */
  blankSecretSteps(rec) {
    // The agent's own way back never blanks (agentHandBack): a marked step
    // refuses it, and a mark the user makes meanwhile stays for its check
    // right before the flip, so the page stays theirs.
    if (this.#agentHandBacks.has(rec)) {
      return Promise.resolve([]);
    }
    let run = this.#blanking.get(rec);
    if (!run) {
      run = this.#blankSteps(rec).finally(() => this.#blanking.delete(rec));
      this.#blanking.set(rec, run);
    }
    return run;
  }

  /** The user's Resume blanking the task's secret step now (blankSecretSteps), or null: the agent's own way back waits for it. */
  blanking(rec) {
    return this.#blanking.get(rec) ?? null;
  }

  async #blankSteps(rec) {
    // A clear that a mark during the step started comes first.
    await this.#markClears.get(rec);
    const labels = [];
    const tried = new Set();
    // A tab marked while a round runs (the user's mark as they press
    // Resume) gets a round of its own, and the run ends with no mark left,
    // with no turn of the event loop between its last look and its end. A
    // tab gets one round: one that neither blanks nor leaves the task keeps
    // its mark for the flip's own check (#dropUnblanked).
    for (;;) {
      const marked = this.pages.tabsOf(rec).filter(tab => secretTaskOf(tab) === rec.id && !tried.has(this.pages.tabId(tab)));
      if (!marked.length) {
        return labels;
      }
      for (const tab of marked) {
        tried.add(this.pages.tabId(tab));
      }
      labels.push(...(await this.#blankRound(rec, marked)));
    }
  }

  /** One round of the hand back's blank (#blankSteps): the marked tabs, their caches, the session. */
  async #blankRound(rec, marked) {
    // A tab Zen restored unloaded gets its browser first: a load in it is
    // then its restore, so its saved page never loads (#insertUnloaded).
    await Promise.all(
      marked
        .filter(isUnloaded)
        .map(tab => this.#insertUnloaded(tab).catch(e => log(`a secret step's unloaded tab got no browser: ${e.message}`)))
    );
    // Every tab's browserId in this one synchronous step, from the copy that
    // holds its docShell: one that moves to another window's copy while an
    // earlier tab blanks takes its browserId along, and an element would stay.
    const steps = marked.map(tab => ({
      tab,
      id: liveCopy(tab)?.linkedBrowser?.browsingContext?.browserId ?? 0,
      label: this.pages.forTab(tab)?.label ?? null,
    }));
    // The sites whose caches may hold what the step showed: those the marks
    // noted, and those of each tab's history, read before the blank purges
    // it. A mark made during a step that loaded more sites than it keeps
    // (overflow) clears every site's.
    const sites = new Set();
    let overflow = false;
    for (const step of steps) {
      for (const site of [...secretSitesOf(step.tab), ...historySites(step.tab)]) {
        sites.add(site);
      }
      overflow ||= !!secretMarkOf(step.tab)?.overflow;
    }
    const blanked = [];
    for (const step of steps) {
      const started = Date.now();
      try {
        if (!step.id) {
          throw new Error("it has no document to blank");
        }
        if (await lazy.blankTab(this, step.id)) {
          log(`a secret step's tab is blank: ${step.label ?? "a page"} (${Date.now() - started} ms)`);
          blanked.push(step);
        }
        // false: it closed meanwhile, its mark with it.
        continue;
      } catch (e) {
        log(`a secret step's tab didn't blank (${e.message}), so it leaves the task: ${step.label ?? "a page"}`);
      }
      // The copy that holds its docShell now, wherever that is.
      const holder = step.id ? BrowsingContext.getCurrentTopByBrowserId(step.id)?.embedderElement : null;
      const tab = (holder && tabOfBrowser(holder)) || (step.tab.isConnected && !step.tab.closing ? step.tab : null);
      if (tab) {
        this.#dropSecretTab(rec, tab);
      }
    }
    await this.#clearSecretCaches(sites, { overflow });
    await this.#saveBlanks(blanked);
    const labels = blanked.map(step => step.label).filter(Boolean);
    if (labels.length) {
      this.spaces.noteBlanked(rec, labels);
    }
    return labels;
  }

  /**
   * What the HTTP and image caches kept of a secret step goes, for its sites
   * only, whether its tabs blanked or not: a site that doesn't send no-store
   * (most frameworks' default) would give the step's page or its QR image
   * back to a fetch with cache "force-cache" in any of the agent's tabs
   * there. Cookies and sign-ins stay. With `overflow` (a mark made during a
   * step that loaded more sites than a held value keeps), every site's
   * caches go: it's rare, and costs only loads afresh.
   *
   * @param {Set<string>} sites  schemeless sites
   * @param {{overflow?: boolean}} [opts]
   */
  async #clearSecretCaches(sites, { overflow = false } = {}) {
    const flags = Ci.nsIClearDataService.CLEAR_NETWORK_CACHE | Ci.nsIClearDataService.CLEAR_IMAGE_CACHE;
    if (overflow) {
      try {
        await timed(
          new Promise((resolve, reject) =>
            Services.clearData.deleteData(flags, { onDataDeleted: failed => (failed ? reject(new Error(`flags ${failed} not cleared`)) : resolve()) })
          ),
          SESSION_SAVE_MS,
          "clearing every site's caches"
        );
        log("a secret step's caches: every site's cleared, since the step loaded more sites than a mark keeps");
      } catch (e) {
        log(`a secret step's caches: clearing every site's failed (${e.message})`);
      }
      return;
    }
    if (!sites.size) {
      return;
    }
    const clear = site =>
      new Promise((resolve, reject) => {
        const done = { onDataDeleted: failed => (failed ? reject(new Error(`flags ${failed} not cleared`)) : resolve()) };
        if (typeof Services.clearData.deleteDataFromSite === "function") {
          Services.clearData.deleteDataFromSite(site, {}, true, flags, done);
        } else {
          Services.clearData.deleteDataFromBaseDomain(site, true, flags, done);
        }
      });
    const results = await Promise.allSettled([...sites].map(site => timed(clear(site), SESSION_SAVE_MS, "clearing a site's caches")));
    const failed = results.filter(r => r.status === "rejected");
    // No site names: they're the user's step.
    log(`a secret step's caches: ${sites.size - failed.length} of ${sites.size} site(s) cleared${failed.length ? ` (${failed[0].reason?.message})` : ""}`);
  }

  /**
   * The blanks reach Zen's session file before the agent has control:
   * Zen saves every 15 s, and a crash before then would bring the step's
   * page back from the file at the next start, with the task the agent's.
   * Their history is collected first, and every other copy of a blank tab
   * takes its state (#copyBlankState). Then their marks go, then the
   * session saves. At a quit, SessionStore's own save takes them, and one
   * forced now could race it.
   *
   * @param {{tab: Element, id: number}[]} steps  the tabs that blanked
   */
  async #saveBlanks(steps) {
    if (!steps.length) {
      return;
    }
    const browsers = steps.map(step => BrowsingContext.getCurrentTopByBrowserId(step.id)?.embedderElement).filter(Boolean);
    try {
      await timed(
        Promise.all(browsers.map(browser => lazy.TabStateFlusher.flush(browser))),
        SESSION_SAVE_MS,
        "collecting the blank tabs' history"
      );
    } catch (e) {
      log(`the blanks' history may not be collected yet: ${e.message}`);
    }
    for (const step of steps) {
      this.#copyBlankState(step);
      this.pages.clearSecret(step.tab);
    }
    if (Services.startup.shuttingDown) {
      return;
    }
    try {
      await timed(lazy.SessionSaver.run(), SESSION_SAVE_MS, "saving the session");
    } catch (e) {
      log(`saving the session after the blanks failed: ${e.message}`);
    }
  }

  /**
   * A blank tab's state, its live copy's, on each of its other copies. Each
   * copy keeps a session key of its own (ZenWindowSync swaps them back after
   * it moves a docShell), and only the live one's state follows the page: a
   * copy that was live while the step's page was up holds that page, its
   * form text and its scroll still. Zen's session file keeps a copy that
   * isn't blank over one that is, so a restart would bring the page back.
   *
   * @param {{tab: Element, id: number}} step
   */
  #copyBlankState(step) {
    const live = BrowsingContext.getCurrentTopByBrowserId(step.id)?.embedderElement;
    const state = live?.permanentKey ? lazy.TabStateCache.get(live.permanentKey) : null;
    if (!state) {
      return;
    }
    for (const copy of copiesOf(step.tab)) {
      const key = copy.linkedBrowser?.permanentKey;
      if (!key || copy.linkedBrowser === live) {
        continue;
      }
      try {
        // The live state, and nothing else: what it lacks goes too.
        const next = JSON.parse(JSON.stringify(state));
        for (const name of Object.keys(lazy.TabStateCache.get(key) ?? {})) {
          if (!(name in next)) {
            next[name] = null;
          }
        }
        lazy.TabStateCache.update(key, next);
      } catch (e) {
        log(`a blank tab's copy kept its old state: ${e.message}`);
      }
    }
  }

  /**
   * As a held task goes to the agent (spaces.setOwnership calls it before
   * the change, in the same synchronous step): a tab still marked secret is
   * one no blank took, a mark the user made after the hand back's blank
   * last looked, or a hand back whose blank failed. It leaves the task as a
   * tab that didn't blank does, so the agent never gets a marked page.
   *
   * @param {object} rec
   */
  #dropUnblanked(rec) {
    const marked = this.pages.tabsOf(rec).filter(tab => secretTaskOf(tab) === rec.id);
    // Before leaveTask takes the marks.
    this.#clearUnblanked(rec, this.#unblankedSites(marked), "tab that no blank took");
    for (const tab of marked) {
      log("a secret step's tab that no blank took leaves the task as the agent gets it back");
      this.#dropSecretTab(rec, tab);
    }
  }

  /**
   * A secret step's tab that didn't blank leaves its task for good first
   * (pages.leaveTask, which takes its mark), so its page has ended for the
   * agent (pageClosed). As the task's last tab it leaves a blank one of the
   * agent's, as pages.close does. Then it closes as a tab of the user's
   * would, with no leave prompt: one a window shows closes once the user
   * leaves it, and the pill's Keep keeps it theirs, not the task's. One
   * that won't close stays theirs.
   *
   * @param {object} rec
   * @param {Element} tab
   */
  #dropSecretTab(rec, tab) {
    try {
      const id = this.pages.tabId(tab);
      if (this.pages.tabsOf(rec).length <= 1) {
        // Not ownerGlobal: zenius's module scope doesn't see it.
        this.pages.addUnmanaged(rec, this.pages.addTab(rec, hostWindow(tab.ownerDocument?.defaultView)), "agent");
      }
      const page = this.pages.leaveTask(rec, tab);
      if (page) {
        this.emit("pageClosed", { space: rec.id, page: page.label, tab: id });
      }
    } catch (e) {
      log("taking it out of the task failed:", e.message);
    }
    try {
      this.pages.closeTab(tab);
    } catch (e) {
      log("closing it failed, so it stays the user's:", e.message);
    }
  }

  /**
   * The tab of `browser` if it's a secret step's while its task waits for
   * the user (its mark), else null. Cheap while no task waits: the network
   * capture asks at each request's start.
   *
   * @param {Element|null} browser
   * @returns {Element|null}
   */
  secretTabOf(browser) {
    if (!browser || !this.#anyHeld()) {
      return null;
    }
    const tab = tabOfBrowser(browser);
    const task = tab ? secretTaskOf(tab) : null;
    const rec = task ? this.spaces.peek(task) : null;
    return rec && !rec.gone && rec.ownership === "agentDelegatedToUser" ? tab : null;
  }

  /** Does the user hold a task now? */
  #anyHeld() {
    return this.spaces.records().some(rec => !rec.gone && rec.ownership === "agentDelegatedToUser");
  }

  /**
   * The tab of `browser` if it's a held step's (its held value names a live
   * task), else null: the network capture follows it, and its sites are
   * noted. Cheap while no task is held and no hold begins: the capture
   * asks at each request's start.
   *
   * @param {Element|null} browser
   * @returns {Element|null}
   */
  heldStepTabOf(browser) {
    if (!browser || (this.#holdsStarting === 0 && !this.#anyHeld())) {
      return null;
    }
    const tab = tabOfBrowser(browser);
    const held = tab ? heldStepOf(tab) : null;
    const rec = held ? this.spaces.peek(held.task) : null;
    return rec && !rec.gone && !rec.ended ? tab : null;
  }

  /**
   * A request of a tab the network capture follows, at its start. One of a
   * secret step's tabs while the user holds it isn't written to the HTTP
   * cache: until the hand back clears the step's sites, another task's page
   * there could read it back with cache "only-if-cached". The tabs also keep
   * the request's site with their marks, so the hand back clears what the
   * caches kept there (#clearSecretCaches), after a restart too. Each of the
   * step's tabs keeps it: a popup that closes itself (a sign-in's) takes its
   * own mark along. A held step's tabs, marked or not, keep it in their held
   * values the same way, from the hold's start, so a mark made later covers
   * what the step loaded before it. The sites never leave the runtime: no
   * result, event or note names them.
   *
   * @param {number} browserId  the tab's top
   * @param {nsIChannel} channel
   */
  noteSecretRequest(browserId, channel) {
    if (this.#holdsStarting === 0 && !this.#anyHeld()) {
      return;
    }
    const browser = BrowsingContext.getCurrentTopByBrowserId(browserId)?.embedderElement ?? null;
    const tab = this.secretTabOf(browser);
    const heldTab = this.heldStepTabOf(browser);
    if (!tab && !heldTab) {
      return;
    }
    if (tab) {
      try {
        // At http-on-modify-request, before the channel opens its cache entry.
        channel.loadFlags |= Ci.nsIRequest.INHIBIT_CACHING;
      } catch (e) {
        log(`a secret step's request may be cached: ${e.message}`);
      }
    }
    const site = schemelessSite(channel.URI);
    if (!site) {
      return;
    }
    const mark = tab ? secretMarkOf(tab) : null;
    const held = heldTab ? heldStepOf(heldTab) : null;
    // Every tab of the step keeps every site, and every one says overflow
    // once one does, so the requesting tab's value answers for them all.
    const done = value => !value || value.overflow || value.sites.includes(site);
    if (done(mark) && done(held)) {
      return;
    }
    const task = mark?.task ?? held.task;
    const tabs = this.pages.tabsOf(this.spaces.peek(task));
    let markFull = false;
    let heldFull = false;
    for (const other of tabs) {
      if (mark && secretTaskOf(other) === task) {
        markFull = this.pages.noteSecretSite(other, site) || markFull;
      }
      if (held && heldStepOf(other)?.task === task) {
        heldFull = this.pages.noteHeldSite(other, site) || heldFull;
      }
    }
    // One tab past what a value keeps: the others say so too, so a popup
    // that closes itself takes nothing of it along.
    for (const other of markFull || heldFull ? tabs : []) {
      if (markFull && secretTaskOf(other) === task) {
        this.pages.overflowSecret(other);
      }
      if (heldFull && heldStepOf(other)?.task === task) {
        this.pages.overflowHeld(other);
      }
    }
  }

  /** The UI's Take over, in every form: the prompt, its countdown, the panel, the user's typing. */
  userTakeOver(rec, browser) {
    return this.holdForUser(rec, browser, { source: "user", reason: "manual_takeover" });
  }

  /**
   * Before the agent gets a held task back by its own call (spaces.takeOver,
   * spaces.claim), as at the user's Resume: the UI replaces this
   * (ZeniusUI.beforeHandBack) to reload the pages the user typed a secret
   * into. Resolves with the <browser>s it reloaded.
   *
   * @type {(rec: object) => Promise<Element[]>}
   */
  beforeHandBack = async () => [];

  /**
   * The agent takes a held task back by its own call (spaces.takeOver,
   * spaces.claim): what the user's Resume does first (beforeHandBack), but
   * no blank. A step marked secret refuses the agent's own way back
   * (methods/spaces.sys.mjs), so blankSecretSteps skips while this runs: a
   * mark the user makes meanwhile stays for the check right before the
   * flip, and their page stays theirs. The skip ends with it, refused or
   * not.
   *
   * @param {object} rec
   */
  async agentHandBack(rec) {
    this.#agentHandBacks.set(rec, (this.#agentHandBacks.get(rec) ?? 0) + 1);
    try {
      if (typeof this.beforeHandBack === "function") {
        await this.beforeHandBack(rec);
      }
      // A clear a mark or a closed marked tab began ends before the agent
      // can get the task back.
      await this.#markClears.get(rec);
    } finally {
      const left = (this.#agentHandBacks.get(rec) ?? 1) - 1;
      if (left > 0) {
        this.#agentHandBacks.set(rec, left);
      } else {
        this.#agentHandBacks.delete(rec);
      }
    }
  }

  /**
   * Load a page afresh, quietly (modules/handoff.sys.mjs): a new GET entry,
   * its visible ordinary fields and the focus carried over, typing dropped
   * meanwhile. The UI's Resume reload.
   *
   * @returns {Promise<{how: "reload"|"get", openerCut: boolean, carried: boolean, focused: boolean}>}
   */
  cleanLoad(browser, opts) {
    return lazy.cleanLoad(this, browser, opts);
  }

  /** The UI's Resume reloaded these pages before the agent gets control back: the hand back says so. */
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
      // One the user opens from a held step's page with no opener (a middle
      // click, a target=_blank link) never joins its hold, yet the agent
      // could adopt it after the hand back: it's the step's too, and the
      // hand back of a secret one blanks it, whoever's mark it carries.
      this.#joinStep(control.space, tab, openerTab);
    }
  }

  /**
   * The window creator's wrapper (modules/guards.sys.mjs) is in only while
   * it can matter: a task is live, or a document holds the agent's code
   * (I4). Checked as tasks start, end and change
   * hands, as a tab joins or leaves one, and as the marks change
   * (observe/setup.sys.mjs's syncHooks, which keeps the observe layer's own hooks
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
  adoptPopup(win, tab, { space, openerPage, hold = false }) {
    this.pages.moveIn(space, tab);
    // Popups get labels whatever the budget, as in Ego.
    const page = this.pages.register(space, tab, "agent", { opener: openerPage.label });
    // One a held step's page opens during the user's hold joins its hold
    // (heldWith): it's the step's too, and the hand back of a secret one
    // blanks it. Its own values keep that through a restart, which the hold
    // doesn't survive.
    this.#joinStep(space, tab, hold ? this.pages.tabFor(openerPage) : null);
    keepAlive(tab);
    this.emit("popup", { space: space.id, page: page.label, tab: this.pages.tabId(tab), opener: openerPage.label });
    return page;
  }

  /**
   * Collect the popups that page `openerLabel` opens until stop() is called.
   * The input layer wraps an action in this to fill the receipt's `popups`.
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
    // permanentKey carries over, so keep the page. What the UI shows on it
    // goes with it, once this close is done.
    if (event.detail?.adoptedBy) {
      const to = event.detail.adoptedBy;
      this.#keptTabGone(tab, "moved", to);
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
    this.#keptTabGone(tab, "closed");
    this.pages.forgetDeferred(tab);
    // A secret step's tab closing before its blank (#closedMarked), once the
    // close is the tab's own and not a tear-off's. Read first, while the tab
    // has all it had.
    const closingMark = secretMarkOf(tab);
    const left = closingMark ? this.#unblankedSites([tab]) : null;
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
    if (closingMark) {
      this.#closedMarked(closingMark, left);
    }
    if (task?.kind === "task" || inAgentsSpace) {
      // Once the close is done, and after a finish() that is closing tabs.
      Promise.resolve().then(() => this.#afterTaskTabClosed(task));
    }
  }

  /**
   * A marked tab closed before its blank: what its sites cached goes, as no
   * blank will clear it, and the cards hear when the step is no longer a
   * secret one, or no longer the agent's, since the agent's takeOver
   * follows the marks left. A closing tab is out of tabsOf already, so
   * secretStepOf says what's left.
   *
   * @param {{task: number, by: string}} mark  the closed tab's
   * @param {{sites: Set<string>, overflow: boolean}} left  #unblankedSites
   */
  #closedMarked(mark, left) {
    const rec = this.spaces.peek(mark.task) ?? null;
    this.#clearUnblanked(rec, left, "tab closed before its blank");
    if (rec && !rec.gone && rec.ownership === "agentDelegatedToUser") {
      const now = this.secretStepOf(rec);
      const was = mark.by === "agent" || now.secretBy === "agent" ? "agent" : "user";
      if (!now.secret || now.secretBy !== was) {
        this.spaces.secretStepChanged(rec, now);
      }
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

  #onInserted = event => this.#onTaskBrowser(event.target, true);

  #onDiscarded = event => this.#onTaskBrowser(event.target, false);

  /**
   * Whether each window listens for its tabs' restores, and for the browsers
   * Gecko inserts and discards by itself: from the first task value the
   * session writes on, the restart rebuild's included, as only a task's tab
   * needs them (I4).
   */
  #watchingRestores = false;

  #watchRestores() {
    if (this.#watchingRestores) {
      return;
    }
    this.#watchingRestores = true;
    for (const win of this.#windows) {
      this.#watchTabsIn(win);
    }
  }

  #watchTabsIn(win) {
    win.addEventListener("SSTabRestoring", this.#onRestoring);
    // A browser Gecko inserts by itself, as the user selects a tab Zen
    // restored unloaded or one they unloaded, has a browserId no set holds.
    // Published in the window's capture phase, ahead of SessionStore's own
    // capture listener on the tab strip, which starts the tab's restore
    // load: its documents get the guards from their first script, and its
    // requests the capture, as after an agent call's #insertUnloaded.
    win.addEventListener("TabBrowserInserted", this.#onInserted, true);
    // The browserId an unload takes leaves the sets, so the observers of the
    // user's own browsing don't stay on for a browser that's gone (I4).
    win.addEventListener("TabBrowserDiscarded", this.#onDiscarded);
  }

  /**
   * An agent close of a tab a window shows waits (SPEC §3.5): the page has
   * ended for the agent, and the UI's "Task finished" pill follows
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
      const tabs = [...uniqueTabs()];
      // A quit while Zen was closing the copies a tab moved to another
      // window left behind brings them back, blank, with the task's value:
      // they close rather than go back to the task. Putting the moved tab
      // back writes its value afresh, without the sync id that named them.
      const leftBehind = this.pages.closeLeftBehind(tabs);
      if (leftBehind.size) {
        log(`restart: closed ${leftBehind.size} tab(s) a move to another window left behind`);
      }
      for (const tab of tabs) {
        if (leftBehind.has(tab)) {
          continue;
        }
        const value = readTabValue(tab);
        if (!value) {
          // A secret step's mark or a held value on a tab no task holds is
          // stale: a session saved before the tab left its task.
          this.pages.clearSecret(tab);
          this.pages.clearHeld(tab);
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
          // the tab. The UI's pill, which says why it will close and offers
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
        const secret = secretTaskOf(tab);
        if (secret === rec.id && rec.ownership === "agent") {
          // The task is the agent's again, yet the session file has the
          // tab's mark from before its hand back: that blank's save never
          // came, and the file may still have the step's page. The tab
          // leaves the task as the user's, unloaded.
          log("restart: a secret step's tab saved before its hand back is the user's now");
          this.pages.forgetTask(tab);
          continue;
        }
        if (secret !== null && (secret !== rec.id || rec.ownership !== "agentDelegatedToUser")) {
          // A hand back or the task's end handled it after the file's save.
          this.pages.clearSecret(tab);
        }
        const held = heldStepOf(tab)?.task ?? null;
        if (held !== null && (held !== rec.id || rec.ownership !== "agentDelegatedToUser")) {
          // The hold ended after the file's save.
          this.pages.clearHeld(tab);
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
      if (restored) {
        // Their pages' copies get the pages' icons as they load (copyIcon).
        followWindowSync();
      }
      this.publishAgentBrowsers();
      // A tab a window showed at the quit is loaded already
      // (zen.workspaces.continue-where-left-off), by Zen, before zenius
      // started: its documents get their guards before any client call, but
      // its scripts ran with none, so the agent's first call on it loads it
      // again or leaves it to the user (#beforeStartGate).
      const guarded = [];
      for (const rec of this.spaces.records()) {
        if (rec.kind === "task" && !rec.gone) {
          const early = [];
          for (const tab of this.pages.tabsOf(rec)) {
            if (hasDocument(tab)) {
              guarded.push(this.installGuards(tab));
              this.#noteBeforeStart(tab);
              if (secretTaskOf(tab) === rec.id) {
                early.push(tab);
              }
            }
          }
          // A held secret step's tab among them: that load wrote to the HTTP
          // cache, and none of its sites was noted. Its mark says overflow,
          // so its hand back clears every site's caches, and every site's
          // clear once that load is done. Only after the publish above,
          // which turned the capture on: what the page loads from then on
          // writes nothing, so nothing it fetched before the clear stays.
          if (early.length) {
            for (const tab of early) {
              this.pages.overflowSecret(tab);
            }
            this.#whenLoaded(early).then(() => this.#clearUnblanked(rec, { sites: new Set(), overflow: true }, "tab loaded before zenius started"));
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
      // A page Zen restored loaded, before a window marked the copy that
      // shows it (markLiveCopy).
      markLiveCopy(tab);
      return this.#beforeStartGate(params, method, page, tab);
    }
    // Its document from before zenius started, if any, is gone with its unload.
    this.#beforeStart.delete(page);
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
   * The rebuild found the tab loaded, by Zen, before zenius started: its
   * document's scripts ran with no guard, and its URL passed no I5 check
   * (#beforeStartGate). The browser's initial blank document is no page's:
   * a restore load still to come runs after the publish, with the guards.
   */
  #noteBeforeStart(tab) {
    const page = this.pages.forTab(tab);
    const wg = tab.linkedBrowser?.browsingContext?.currentWindowGlobal;
    if (page && wg && !wg.isInitialDocument) {
      this.#beforeStart.set(page, topDocOf(tab.linkedBrowser));
    }
  }

  /**
   * The agent's first call on a page whose document is still the one Zen
   * loaded before zenius started (#noteBeforeStart), and any call when the
   * agent's own Back brings that one back. If nothing in it is the user's,
   * it loads again first, as an unloaded page's restore does (#restoreGate),
   * so the agent never acts in it; page.goto, pages.close and pages.release
   * replace it or give it up anyway. If the user navigated, clicked or typed
   * in it since the start, or the session put text back in it, a load would
   * cost them that: the page leaves the task and stays theirs, as a kept
   * page the user touched does (resumeFinishedTask), and the call fails,
   * saying why.
   *
   * @returns {null|Promise<void>}
   */
  #beforeStartGate(params, method, page = null, tab = null) {
    if (!page) {
      try {
        page = this.pages.get(this.spaces.get(params.space), params.page);
        tab = this.pages.tabFor(page);
      } catch {
        // The method's own resolvePage says what's wrong.
        return null;
      }
    }
    const running = this.#beforeStartRuns.get(page);
    if (running) {
      // The gate's own load goes through; any other call waits for it, then
      // checks again.
      if (this.#beforeStartLoads.has(page) && method === "page.goto") {
        return null;
      }
      const again = () => this.#beforeStartGate(params, method);
      return running.then(again, again);
    }
    const before = this.#beforeStart.get(page);
    if (!before || !tab?.linkedBrowser) {
      return null;
    }
    const now = topDocOf(tab.linkedBrowser);
    if (now.doc !== before.doc && before.settled) {
      // A load of the agent's since has replaced it.
      return null;
    }
    const run = this.#settleBeforeStart(params, method, page, tab, before, now);
    this.#beforeStartRuns.set(page, run);
    const done = () => {
      if (this.#beforeStartRuns.get(page) === run) {
        this.#beforeStartRuns.delete(page);
      }
    };
    run.then(done, done);
    return run;
  }

  async #settleBeforeStart(params, method, page, tab, before, now) {
    const rec = this.spaces.get(params.space);
    // Another top document at the first call: a navigation, the user's or
    // the page's own, which counts as a kept page's does (#notBackWhy).
    const why = now.doc !== before.doc ? "navigated" : await this.#userInputIn(tab.linkedBrowser);
    if (why) {
      throw this.#leaveToUser(rec, page, tab, why, before);
    }
    if (method === "page.goto" || method === "pages.close" || method === "pages.release") {
      this.#beforeStart.set(page, { ...before, settled: true });
      return;
    }
    const uri = tab.linkedBrowser.currentURI;
    try {
      checkAgentLoad(uri, "page.goto");
    } catch (e) {
      throw new ZenError(
        "ZEN_URL_NOT_ALLOWED",
        `page ${page.label} loaded before zenius started, and the page it shows, ${uri.spec}, isn't one agents can load, so zenius can't load it again for ${method}: page.goto() a web URL first, or ask the user to open the page.`,
        { ...e.data, page: page.label, reason: "before_start" }
      );
    }
    const timeout = Number.isFinite(params.options?.timeout) ? { timeout: params.options.timeout } : {};
    this.#beforeStartLoads.add(page);
    try {
      await this.dispatch("page.goto", { space: params.space, page: page.label, url: uri.spec, options: { waitUntil: "load", ...timeout } });
    } catch (e) {
      // As after a restore: a method that works whatever the page shows goes on.
      if (this.i5Of(method) !== "outside") {
        throw e;
      }
      log(`page ${page.label}: loading it again after the start failed (${e?.code ?? e?.message}); ${method} goes on`);
    } finally {
      this.#beforeStartLoads.delete(page);
    }
    // Kept settled: Back to that document brings this gate back.
    this.#beforeStart.set(page, { ...before, settled: true });
    log(`page ${page.label} loaded again: Zen loaded it before zenius started`);
  }

  /**
   * What of the user's a tab's documents hold, each frame's read in its own
   * process through Xrays (guards#userInput), as the page's own scripts ran
   * unguarded and could shadow what a waived read would see: "typed" for a
   * field changed from its default (their typing, or text the session put
   * back), "clicked" for their clicks or keys alone (user activation, which
   * a cross-origin frame's input gives the top too), else null. A frame
   * that doesn't answer counts as typed; one outside the web processes,
   * which zenius never reaches, counts by the activation it gives the top.
   */
  async #userInputIn(browser) {
    const frames = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    const answers = await Promise.all(
      frames.map(bc =>
        this.content(bc, "guards#userInput", {}, { timeout: USER_INPUT_WAIT_MS }).catch(e =>
          e?.code === "ZEN_UNSUPPORTED" || e?.data?.reason === "no_window_global" ? null : { changed: true }
        )
      )
    );
    if (answers.some(a => a?.changed)) {
      return "typed";
    }
    return answers.some(a => a?.active) ? "clicked" : null;
  }

  /**
   * A page the user touched since the start leaves the task, theirs from
   * now on, as a kept page they touched does at a reply: its label named it
   * only, so a later call hears it was released. Returns the refusal for
   * the call that found it.
   */
  #leaveToUser(rec, page, tab, why, before) {
    const label = page.label;
    this.#beforeStart.delete(page);
    this.pages.leaveTask(rec, tab);
    if (!rec.ledger.usedLabels.includes(label)) {
      rec.ledger.usedLabels.push(label);
    }
    rec.ledger.releasedLabels.push(label);
    log(`page ${label} left its task to the user: Zen loaded it before zenius started, and it was ${why} since`);
    const since = {
      navigated: "it has gone to another page",
      typed: "it holds text the user typed or the session put back",
      clicked: "the user has clicked or typed in it",
    }[why];
    return new ZenError(
      "ZEN_PAGE_NOT_FOUND",
      `page ${label} left the task and is the user's now: Zen loaded it before zenius started, and since then ${since}. Loading it again would cost the user that, so zenius leaves it to them. Open a new page for the task, or ask the user.`,
      { space: rec.id, page: label, reason: "theirs", why, url: before.url }
    );
  }

  /**
   * #beforeStartGate for a call that acts on a task's page without naming
   * it: spaces.handOff's front page.
   *
   * @returns {null|Promise<void>}
   */
  settleBeforeStart(rec, tab, method) {
    const page = tab ? this.pages.forTab(tab) : null;
    return page?.spaceId === rec.id ? this.#beforeStartGate({ space: rec.id, page: page.label }, method, page, tab) : null;
  }

  /**
   * Before the agent's finish() closes a task's pages: one still showing
   * its document from before zenius started, which the user touched, leaves
   * the task first, so the close never costs them their input. Null when no
   * page of the task has such a document, so finish() goes on at once, as
   * it always has; else a promise of the labels of those that left.
   *
   * @returns {null|Promise<string[]>}
   */
  leaveTouchedBeforeStart(rec) {
    const pages = this.pages.list(rec.id).filter(page => this.#beforeStart.has(page));
    return pages.length ? this.#leaveTouched(rec, pages) : null;
  }

  async #leaveTouched(rec, pages) {
    const left = [];
    for (const page of pages) {
      const before = this.#beforeStart.get(page);
      const tab = before ? this.pages.tabFor(page) : null;
      if (!tab?.linkedBrowser || this.#beforeStartRuns.has(page)) {
        continue;
      }
      const now = topDocOf(tab.linkedBrowser);
      if (now.doc !== before.doc && before.settled) {
        continue;
      }
      const why = now.doc !== before.doc ? "navigated" : await this.#userInputIn(tab.linkedBrowser);
      if (why && this.pages.forTab(tab) === page) {
        this.#leaveToUser(rec, page, tab, why, before);
        left.push(page.label);
      }
    }
    return left;
  }

  /**
   * The user hands the task back: a page whose document from before zenius
   * started they replaced during the hold (a navigation, the secret step's
   * blank) shows one made with the guards, the agent's again as they left
   * it. One that still shows it waits for the agent's first call.
   */
  #handedBackBeforeStart(rec) {
    for (const page of this.pages.list(rec.id)) {
      const before = this.#beforeStart.get(page);
      if (before && topDocOf(this.pages.tabFor(page)?.linkedBrowser).doc !== before.doc) {
        this.#beforeStart.delete(page);
      }
    }
  }

  /**
   * A tab got a browser (TabBrowserInserted) or lost one (an unload): if
   * it's a task's, the sets go out now, before its first document.
   */
  #onTaskBrowser(tab, inserted) {
    if (!tab || this.pages.holderOf(tab) === null) {
      return;
    }
    if (inserted) {
      // The copy the page loads in holds its docShell (markLiveCopy).
      markLiveCopy(tab);
    } else {
      // A document from before zenius started went with the browser: the
      // next one loads with the guards, so the agent's first call there
      // needn't settle it (#beforeStartGate).
      const page = this.pages.forTab(tab);
      if (page) {
        this.#beforeStart.delete(page);
      }
    }
    this.publishAgentBrowsers();
  }

  /** Resolves once none of the tabs loads its document, or after EARLY_LOAD_WAIT_MS. */
  async #whenLoaded(tabs) {
    const end = Date.now() + EARLY_LOAD_WAIT_MS;
    while (Date.now() < end && tabs.some(tab => tab.linkedBrowser?.webProgress?.isLoadingDocument)) {
      await new Promise(resolve => lazy.setTimeout(resolve, 100));
    }
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
    // The copy the page loads in holds its docShell (markLiveCopy).
    markLiveCopy(tab);
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
   * named it for zenius.autoCloseHours. The UI's panel marks the same.
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
      // takeOver, Stop, finish (the observe layer's holds end with it).
      const rec = this.spaces.peek(params.space);
      if (rec && this.#heldForUser) {
        lazy.releaseHolds(rec);
      }
      // The held step's values go with the hold, a hold from before a restart included.
      for (const tab of rec ? this.pages.tabsOf(rec) : []) {
        this.pages.clearHeld(tab);
      }
      if (rec && params.ownership === "agent") {
        this.#handedBackBeforeStart(rec);
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
        // Its tabs are the user's now: no hand back will blank them, and
        // none carries a secret step's mark into a later session. What a
        // marked one's sites cached goes as the blank would clear it.
        const tabs = this.pages.tabsOf(rec);
        this.#clearUnblanked(rec, this.#unblankedSites(tabs.filter(tab => secretTaskOf(tab) === rec.id)), "task ended before its blank");
        for (const tab of tabs) {
          this.pages.clearSecret(tab);
        }
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
  // The reply after a finish (docs/SPI.md, "The reply after a finish")

  /**
   * A finished task → the pages its finish kept for the user, which a reply
   * in its Work chat may hand back (resumeFinishedTask), until the task runs
   * again, its record goes, or Zen quits. In memory only, so a restart ends
   * the chance.
   *
   * Each kept page: its label then, who opened it and from which page, its
   * tab (any copy: the live one is found by its browserId, which moves with
   * its document), and why it can't come back once the user closed, moved,
   * clicked or typed in it. Then its top document at the finish (finished),
   * once the finish's own loads were done (base), and after a clean copy
   * zenius made at the resume (clean).
   *
   * @type {Map<object, {kept: object[], ready: Promise<void>}>}
   */
  #finished = new Map();

  /**
   * finish() kept these pages for the user: a reply in the task's Work chat
   * may hand back those the user leaves alone. Their baselines (each top
   * document, and every frame's secret fields) are taken once the finish's
   * own loads are done, so a clean copy the finish made isn't a navigation
   * of the user's. Only a Work chat's task can be replied to.
   *
   * @param {object} rec  the task, just finished
   * @param {{label: string, openedBy: string, opener: string|null, tab: Element}[]} kept
   * @param {Promise<Element[]>} loads  endTaskCode's: the pages it loaded afresh
   */
  noteFinished(rec, kept, loads) {
    this.#finished.delete(rec);
    if (!rec.source?.sidebar || !kept.length) {
      return;
    }
    const state = {
      kept: kept.map(({ label, openedBy, opener, tab }) => ({
        label,
        openedBy,
        opener: opener ?? null,
        tab,
        browserId: tab.linkedBrowser?.browserId || 0,
        why: null,
        finished: topDocOf(tab.linkedBrowser),
        base: null,
        clean: null,
      })),
      ready: null,
    };
    let timer = 0;
    const late = new Promise(resolve => {
      timer = lazy.setTimeout(() => resolve(null), FINISH_LOADS_WAIT_MS);
    });
    const done = Promise.resolve(loads).then(
      reloaded => (Array.isArray(reloaded) ? reloaded : []),
      () => []
    );
    state.ready = Promise.race([done, late]).then(reloaded => {
      lazy.clearTimeout(timer);
      this.#takeKeptBases(rec, state, reloaded);
    });
    this.#finished.set(rec, state);
    this.publishAgentBrowsers();
  }

  /**
   * The kept pages' baselines, once the finish's loads are done (reloaded:
   * the pages they loaded afresh; null when they took too long). A page
   * with another top document by now that no load of the finish's explains
   * was navigated meanwhile, by the user or by itself: it stays theirs. A
   * page loaded afresh counts only in the document its own clean copy made:
   * the user may have loaded another while a slower page's copy still ran.
   */
  #takeKeptBases(rec, state, reloaded) {
    if (this.#finished.get(rec) !== state) {
      return;
    }
    const browsers = [];
    for (const kept of state.kept) {
      const browser = this.#keptTab(kept)?.linkedBrowser;
      if (kept.why || !browser?.browsingContext) {
        continue;
      }
      const now = topDocOf(browser);
      const copied = reloaded?.find(b => b === browser || (kept.browserId && b.browserId === kept.browserId));
      if (copied ? now.doc === null || now.doc !== this.#cleanDocs.get(copied) : !sameDoc(now, kept.finished)) {
        kept.why = "navigated";
        continue;
      }
      kept.base = now;
      browsers.push(browser);
    }
    try {
      lazy.snapshotKept(this, browsers);
    } catch (e) {
      console.error("[zenius] the kept pages' snapshot failed", e);
    }
    this.publishAgentBrowsers();
  }

  /** A kept page's live tab now (window sync), or null once it's gone. */
  #keptTab(kept) {
    return kept.tab ? liveCopy(kept.tab, kept.browserId) : null;
  }

  /** Is `tab`, or the <browser> with `id`, this kept page? */
  #isKept(kept, tab, id) {
    return !!kept.tab && (kept.tab === tab || (!!id && kept.browserId === id));
  }

  /**
   * The finished task that kept this tab for a reply in its Work chat, or
   * null. A tab that moved to another window's copy is found by its
   * browserId, which moves with its document.
   *
   * @param {Element} tab  any copy
   * @returns {object|null}
   */
  finishedTaskOf(tab) {
    const id = tab?.linkedBrowser?.browserId || 0;
    for (const [rec, state] of this.#finished) {
      if (!rec.gone && rec.ownership === "user" && state.kept.some(kept => this.#isKept(kept, tab, id))) {
        return rec;
      }
    }
    return null;
  }

  /**
   * A finished task's kept pages, once their baselines are taken, and why
   * each can't come back now (null while it may), or null when a reply in
   * its Work chat can hand none back: for tests, and for the sidebar to
   * tell ahead of a reply.
   *
   * @param {number} spaceId
   * @returns {Promise<{page: string, why: string|null}[]|null>}
   */
  async keptPagesOf(spaceId) {
    const rec = this.spaces.peek(spaceId);
    const state = rec ? this.#finished.get(rec) : null;
    if (!state) {
      return null;
    }
    await state.ready;
    if (this.#finished.get(rec) !== state) {
      return null;
    }
    return state.kept.map(kept => ({ page: kept.label, why: this.#notBackWhy(kept) }));
  }

  /**
   * The user clicked or typed in a finished task's kept page (zen-ui's
   * takeover listener; the typing sense, for fills): it stays theirs at a
   * reply. The first reason stays.
   *
   * @param {object} rec  finishedTaskOf's
   * @param {Element} browser
   * @param {"clicked"|"typed"} kind
   */
  noteKeptInput(rec, browser, kind) {
    if (kind !== "clicked" && kind !== "typed") {
      return;
    }
    const id = browser?.browserId || 0;
    // Not ownerGlobal: zenius's module scope doesn't see it.
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser?.(browser) ?? null;
    const kept = this.#finished.get(rec)?.kept.find(k => this.#isKept(k, tab, id));
    if (kept && !kept.why) {
      kept.why = kind;
      log(`a finished task's kept page was ${kind} in: it stays the user's`);
      this.publishAgentBrowsers();
    }
  }

  /** A kept page closed, or moved to another window (to: its tab there). */
  #keptTabGone(tab, why, to = null) {
    const id = tab.linkedBrowser?.browserId || 0;
    for (const state of this.#finished.values()) {
      for (const kept of state.kept) {
        if (this.#isKept(kept, tab, id)) {
          kept.why ??= why;
          kept.tab = to;
          kept.browserId = to?.linkedBrowser?.browserId || kept.browserId;
        }
      }
    }
  }

  /** The kept pages the typing sense watches: those that may still come back. */
  #keptBrowserIds() {
    const ids = new Set();
    for (const [rec, state] of this.#finished) {
      // Claimed, stopped again or gone: no reply hands these back now.
      if (rec.gone || rec.ownership !== "user") {
        this.#finished.delete(rec);
        continue;
      }
      for (const kept of state.kept) {
        if (kept.tab && kept.browserId && !kept.why) {
          ids.add(kept.browserId);
        }
      }
    }
    return ids;
  }

  #canResume(rec, source) {
    return (
      !rec.gone &&
      rec.kind === "task" &&
      rec.ownership === "user" &&
      rec.ended === true &&
      rec.endedHow === "finished" &&
      typeof source?.sidebar === "string" &&
      source.sidebar !== "" &&
      rec.source?.sidebar === source.sidebar
    );
  }

  /** Why a kept page can't come back now, or null. */
  #notBackWhy(kept) {
    if (kept.why) {
      return kept.why;
    }
    const tab = this.#keptTab(kept);
    if (!tab?.linkedBrowser) {
      return "closed";
    }
    // Out of the Agents Space: into a Space of the user's, or marked their
    // own ("Use your own tab"), or a page of another task by now.
    if (!this.spaces.isAgentsSpace(tab.getAttribute("zen-workspace-id")) || this.pages.isUserOwn(tab) || this.pages.forTab(tab)) {
      return "moved";
    }
    // Another top document, or the same one at another history entry or
    // address: the user's navigation, or the page's own, which counts too.
    // So does a tab the browser unloaded meanwhile.
    if (!sameDoc(topDocOf(tab.linkedBrowser), kept.clean ?? kept.base)) {
      return "navigated";
    }
    return null;
  }

  /**
   * A reply in a finished task's Work chat: zen-ui's send, in process, never
   * over the socket. It hands the task back to its agent with the pages its
   * finish kept that the user hasn't touched since. The user's message is
   * the approval, so no claim prompt shows.
   *
   * A kept page the user closed, moved out of the Agents Space, navigated,
   * or clicked or typed in stays theirs and leaves the task, so no
   * adoption, claim or restart gives it back. The agent hears which pages,
   * and why. With none left, the task stays ended.
   *
   * Resume's clean-up runs first, on the pages that may come back: a page
   * whose secret fields changed since the finish loads afresh (reloaded).
   * Then come the check and the handover, in one step with no await
   * between. Each page is checked again and registered under its old label
   * where it's free, and the ownership flips. Its camera, microphone and
   * screen streams stop as it joins the agent's tabs (stopped, what they
   * captured), and the flip's spaceChanged runs the hand-back guard's clear
   * against the snapshot the finish took (cleared, the fields it emptied).
   *
   * @param {number} spaceId  the chat's task (conv.zen.id)
   * @param {{sidebar?: string}} source  the chat (conv.uid), which must be the task's
   * @returns {Promise<null|{space: number, name: string, pages: {page: string, url: string, reloaded: boolean, stopped: string[], cleared: number}[], notBack: {page: string, url: string, why: string}[]}>}
   *   null when this chat has no finished task to take up. A page not back
   *   gives the address it had at the finish, never where the user took it.
   */
  async resumeFinishedTask(spaceId, source = {}) {
    const t0 = now();
    const rec = this.spaces.peek(spaceId);
    const state = rec ? this.#finished.get(rec) : null;
    if (!state || !this.#canResume(rec, source)) {
      return null;
    }
    await state.ready;
    const current = () => this.#finished.get(rec) === state && this.#canResume(rec, source);
    if (!current()) {
      return null;
    }
    // Resume's clean-up first (ui/index.sys.mjs #reloadTyped): a page with a
    // secret field that changed since the finish loads afresh, so no page
    // state keeps what was put there, when its evidence says a clean copy
    // helps. Without an answer in time, the guard's clear alone runs.
    const candidates = state.kept.filter(kept => !this.#notBackWhy(kept));
    const browsers = candidates.map(kept => this.#keptTab(kept).linkedBrowser);
    let typed = [];
    let timer = 0;
    try {
      const late = new Promise(resolve => {
        timer = lazy.setTimeout(() => resolve(null), KEPT_SECRETS_WAIT_MS);
      });
      typed = (await Promise.race([lazy.typedSecretsIn(this, browsers), late])) ?? [];
    } catch (e) {
      log("the kept pages' secret fields didn't answer:", e.message);
    } finally {
      lazy.clearTimeout(timer);
    }
    const reloads = typed.filter(browser => {
      const kept = candidates[browsers.indexOf(browser)];
      const evidence = lazy.evidenceOf(browser) ?? {};
      return kept && !this.#notBackWhy(kept) && lazy.RESUME_CLEANABLE.some(reason => Object.hasOwn(evidence, reason));
    });
    await Promise.all(
      reloads.map(async browser => {
        const kept = candidates[browsers.indexOf(browser)];
        try {
          const { doc } = await this.cleanLoad(browser);
          const now = topDocOf(this.#keptTab(kept)?.linkedBrowser);
          // Only the document this load made: another by now is a load
          // since, the user's or the page's own.
          if (now.doc !== null && now.doc === doc) {
            kept.clean = now;
          } else {
            kept.why ??= "navigated";
          }
        } catch (e) {
          // A secret the page may still hold keeps it the user's.
          log("a kept page's clean load failed:", e.message);
          kept.why ??= "typed";
        }
      })
    );
    if (!current()) {
      return null;
    }
    // One step from here to the flip: no await.
    const back = [];
    const notBack = [];
    for (const kept of state.kept) {
      const why = this.#notBackWhy(kept);
      const tab = this.#keptTab(kept);
      if (why) {
        // The address the agent had at the finish: where the page is now may
        // be the user's own browsing since.
        notBack.push({ page: kept.label, url: kept.finished?.url ?? "", why });
        if (tab) {
          this.pages.leaveTask(rec, tab);
        }
        // Its label named that page only: a call naming it hears the page
        // was released, and a new page gets another.
        if (!rec.ledger.usedLabels.includes(kept.label)) {
          rec.ledger.usedLabels.push(kept.label);
        }
        rec.ledger.releasedLabels.push(kept.label);
        continue;
      }
      // Its address is still the finish's (or its clean copy's): #notBackWhy's check.
      const url = urlOf(tab);
      const label = rec.ledger.usedLabels.includes(kept.label) ? undefined : kept.label;
      const page = this.pages.register(rec, tab, kept.openedBy, { label, opener: kept.opener });
      keepAlive(tab);
      // The agent never uses the user's devices: what the page captures stops
      // as it joins the agent's tabs at the flip (observe/setup.sys.mjs).
      const stopped = lazy.capturing(tab.linkedBrowser);
      // The guard's clear at the flip replaces this, if any: an older one
      // isn't this hand back's.
      const priorClear = lazy.lastClearOf(tab.linkedBrowser);
      back.push({ kept, tab, page, url, stopped, priorClear });
    }
    this.#finished.delete(rec);
    if (!back.length) {
      this.publishAgentBrowsers();
      log(`a reply after a finish: no kept page of task ${rec.id} came back (${notBack.length}), in ${(now() - t0).toFixed(1)} ms`);
      return { space: rec.id, name: rec.name, pages: [], notBack };
    }
    this.spaces.setOwnership(rec, "agent", { source: "user" });
    // The pages' documents predate this, so they get their guards now.
    await Promise.all(back.map(({ tab }) => this.installGuards(tab).catch(e => log("a returned page's guards failed:", e.message))));
    const pages = await Promise.all(
      back.map(async ({ kept, tab, page, url, stopped, priorClear }) => {
        const clear = lazy.lastClearOf(tab.linkedBrowser);
        return {
          page: page.label,
          url,
          reloaded: kept.clean !== null,
          stopped,
          cleared: clear === priorClear ? 0 : await clear.catch(() => 0),
        };
      })
    );
    log(`a reply after a finish: task ${rec.id} is the agent's again with ${pages.length} page(s), ${notBack.length} not back, in ${(now() - t0).toFixed(1)} ms`);
    return { space: rec.id, name: rec.name, pages, notBack };
  }

  // ---------------------------------------------------------------------------
  // Methods

  /**
   * Load the method modules, once. Most of them install hooks for agent
   * tabs as they load: the input layer's picker, file chooser and autofill
   * guards, the observe layer's dialog, network and download hooks, the UI's
   * overlay. A browser with no agent work needs none of that until an agent
   * connects, so they load at the first connection or call (SPEC §5, idle
   * cost: about 4.7 MiB of the parent's memory on the Linux server, 85 ms on that first
   * call), at start when there's agent work (#agentWorkAtStart), or when
   * the restart rebuild finds a close that waits again (the UI's pill).
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
   * the user? Then the guards load before any of those tabs that Zen
   * restored unloaded does. A tab a window showed at the quit has loaded
   * before zenius started at all: the rebuild notes its document
   * (#noteBeforeStart).
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
   * module declared each (dev.registry, for the input layer's registry test).
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
    // The request while it runs: calls.cancel and the connection's close
    // stop it (#stopRequest). One its client canceled gets no answer, as an
    // MCP request canceled with notifications/cancelled gets none: the
    // client has stopped waiting for it.
    const request = this.#beginRequest(conn, id);
    this.dispatch(method, frame.params ?? {}, conn, { onHold, pageBudget, request })
      .then(
        result => request.stopped !== "canceled" && conn.send(withHooked(resultFrame(id, result), request)),
        error => request.stopped !== "canceled" && conn.send(withHooked({ id, error: toWireError(error) }, request))
      )
      .finally(() => this.#endRequest(conn, request));
  }

  /** A client's request, by its id on its connection, while it runs. */
  #beginRequest(conn, id) {
    const request = { id, stopped: null, hooks: new Set(), hooked: null };
    if (typeof id === "number" || typeof id === "string") {
      (conn.state.requests ??= new Map()).set(id, request);
    }
    return request;
  }

  #endRequest(conn, request) {
    if (conn.state.requests?.get(request.id) === request) {
      conn.state.requests.delete(request.id);
    }
  }

  /**
   * Stop a running request: its client canceled it, or its connection
   * closed. Its waits end at once, its page code stops as at a takeover
   * (observe/control.sys.mjs), a hold at the control gate ends, a call
   * waiting at any gate never starts, an action still looking for its target
   * ends without acting (methods/actions.sys.mjs), and its step reads
   * "stopped". An action already under way finishes: half a click isn't
   * safer.
   *
   * @param {object} request  #beginRequest's
   * @param {"canceled"|"closed"} reason
   * @returns {boolean} whether it was running
   */
  #stopRequest(request, reason) {
    if (request.stopped) {
      return false;
    }
    request.stopped = reason;
    for (const fn of [...request.hooks]) {
      try {
        fn();
      } catch (e) {
        log(`stopping request ${request.id} failed: ${e.message}`);
      }
    }
    request.hooks.clear();
    return true;
  }

  /**
   * calls.cancel (methods/calls.sys.mjs): the client gave up on its request
   * `id` on this connection, as zenius mcp does when its own client cancels
   * a tool call.
   *
   * @returns {boolean} whether that request was still running
   */
  cancelRequest(conn, id) {
    const request = conn?.state.requests?.get(id);
    return request ? this.#stopRequest(request, "canceled") : false;
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
  dispatch(method, params, conn = null, { onHold, pageBudget, request = null } = {}) {
    this.#ensureMethods();
    if (this.#rebuilding) {
      // In frame order: calls queue on the same promise.
      return this.#rebuilding.then(() => this.dispatch(method, params, conn, { onHold, pageBudget, request }));
    }
    const t0 = now();
    // A client's call shows in its task's steps while it runs (the input layer's
    // ring); a handler's own calls don't.
    const startedAt = Date.now();
    // A script's connection (methods/script.sys.mjs) nests its steps under
    // the script's own.
    const step = conn ? this.#noteStep("beginCall", { method, params, at: startedAt, script: conn.state.script }) : null;
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
        // A request stopped while held ends there, without running.
        return (request ? Promise.race([hold, whenStopped(request, method)]) : hold).then(() => {
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
        request,
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
      // A method that names a page but runs no page gate (a frame's, pages.close)
      // still settles a document from before zenius started.
      const gates = PAGE_GATED.has(i5)
        ? [() => this.#restoreGate(params, method), ...this.#pageGates.map(({ gate }) => () => gate(ctx, params, method))]
        : hasSpace && typeof params?.page === "string" && i5 !== "dev"
          ? [() => this.#beforeStartGate(params, method)]
          : [];
      const wait = runChain(control, gates, 0);
      // A request stopped while a gate waited (a pending navigation, an
      // unloaded tab's load) never starts: only the control gate's hold
      // ends at the stop itself.
      const run = () => {
        const stop = ctx.stopped();
        if (stop) {
          throw stop;
        }
        return entry.fn(ctx, params);
      };
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
        this.#noteStep("endCall", step, { method, params, outcome, ms, at: startedAt, found: ctx?.step, script: conn.state.script });
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
        // A request its client canceled, or whose connection closed, ended
        // because of that: the user's line reads stopped, not failed.
        const outcome = request?.stopped ? "stopped" : typeof e?.code === "string" && ErrorCodes[e.code] ? e.code : "ZEN_INTERNAL";
        if (outcome === "ZEN_INTERNAL") {
          log(`${method} internal error: ${e?.message}\n${e?.stack ?? ""}`);
        }
        finish(outcome);
        throw e;
      }
    );
  }

  /**
   * After the agent acted on a page, tell the UI (ui/pages.sys.mjs notePage):
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
   * (the input layer's keys, the UI's cursor) make it the task's front tab too.
   */
  #followNotePage() {
    const url = `${BASE_URL}ui/pages.sys.mjs`;
    if (chromeFileExists(url)) {
      ChromeUtils.importESModule(url).onNotePage?.(tab => this.pages.noteFront(tab));
    }
  }

  /**
   * The input layer's step ring (input/steps.sys.mjs): what the sidebar shows of
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
        log(`the input layer's step ring didn't load, so tasks show no steps: ${e.message}`);
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
   * listed, with the list, for the UI's warning. Gecko blocks such a page as
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

  #notePageCallFn() {
    if (this.#notePageCall === undefined) {
      const url = `${BASE_URL}ui/pages.sys.mjs`;
      this.#notePageCall = (chromeFileExists(url) && ChromeUtils.importESModule(url).notePageCall) || null;
    }
    return this.#notePageCall;
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
   * What the observe layer's i5Status needs for browser.health's `i5`: the page
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
    const request = extras.request ?? null;
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
      resolvePage: params => {
        const resolved = this.resolvePage(params);
        // The agent's call names this page of its task: the UI takes the
        // cursor off its other pages (notePageCall). Not a dev method's.
        if (i5 !== "dev" && this.spaces.isAgentTask(resolved.space)) {
          try {
            this.#notePageCallFn()?.(resolved.tab, method);
          } catch (e) {
            log(`notePageCall for ${method} failed: ${e.message}`);
          }
        }
        return resolved;
      },
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
      // A client's request stops when its client cancels it or its
      // connection closes (#stopRequest); the runtime's own calls never do.
      // stopped(): the error it then ends with, else null. onStopped(fn):
      // fn() at the stop, returning off. unlessStopped(promise, cleanup):
      // promise, or that error once it stops first, after cleanup().
      stopped: () => (request?.stopped ? stopError(request.stopped, method) : null),
      onStopped: fn => onStopped(request, fn),
      unlessStopped: (promise, cleanup) => unlessStopped(request, method, promise, cleanup),
      // The agent's code left `detail` in a page that wasn't hooked before
      // (the observe layer's evidence): the request's final frame carries the
      // first such, as `hooked`, so its client can say the page now loads
      // afresh before the user acts there and at the task's end.
      noteHooked: detail => {
        if (request && typeof detail === "string" && detail && request.hooked === null) {
          request.hooked = detail;
        }
      },
      // Nested calls keep the request's budget, and stop with it.
      call: (m, p) => this.dispatch(m, p, null, { pageBudget, request }),
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
   * In-process listeners (the UI's controller, watchPopups).
   *
   * @param {(event: string, params: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  addEventListener(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** An event for in-process listeners only (the UI), such as one that carries an element. */
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
   * spaceChanged or popup would reach the UI's UI and action receipts.
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
   * The reminders' hook (the UI's choice A): a refusal in a document no live
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
    for (const request of conn.state.requests?.values() ?? []) {
      this.#stopRequest(request, "closed");
    }
    // A copy: a hook may take itself off the list as it runs.
    [...(conn.state.onClose ?? [])].forEach(fn => {
      try {
        fn();
      } catch {}
    });
  }
}

/** A tab's top document now: its id, address and history entry. */
function topDocOf(browser) {
  const bc = browser?.browsingContext;
  let doc = null;
  let index = null;
  let url = "";
  try {
    doc = bc?.currentWindowGlobal?.innerWindowId ?? null;
  } catch {}
  try {
    index = bc?.sessionHistory?.index ?? null;
  } catch {}
  try {
    url = browser.currentURI?.spec ?? "";
  } catch {}
  return { doc, url, index };
}

/** The same top document at the same entry and address, both known. */
function sameDoc(a, b) {
  return !!a && !!b && a.doc !== null && a.doc === b.doc && a.url === b.url && a.index === b.index;
}

/** A tab's address, "" when it has none to read. */
function urlOf(tab) {
  try {
    return tab?.linkedBrowser?.currentURI?.spec ?? "";
  } catch {
    return "";
  }
}

function isUnloaded(tab) {
  return !tab.linkedPanel || tab.hasAttribute("pending");
}

/** The schemeless site (Services.clearData's) of an http(s) URI, or null. */
function schemelessSite(uri) {
  if (!uri || !(uri.schemeIs("http") || uri.schemeIs("https"))) {
    return null;
  }
  try {
    return Services.eTLD.getSchemelessSite(uri);
  } catch {}
  try {
    return uri.host || null;
  } catch {
    return null;
  }
}

/** The sites of the pages a tab's history holds: its live history's, and those the session saved. */
function historySites(tab) {
  const sites = new Set();
  const add = spec => {
    try {
      const site = spec ? schemelessSite(Services.io.newURI(spec)) : null;
      if (site) {
        sites.add(site);
      }
    } catch {}
  };
  // A tab's last copy, as it closes, is no copy any more (copiesOf): its own
  // browser holds the history then.
  const history = (liveCopy(tab) ?? tab).linkedBrowser?.browsingContext?.sessionHistory;
  for (let i = 0; i < (history?.count ?? 0); i++) {
    add(history.getEntryAtIndex(i)?.URI?.spec);
  }
  try {
    for (const entry of JSON.parse(lazy.SessionStore.getTabState(tab)).entries ?? []) {
      add(entry.url);
    }
  } catch {}
  return sites;
}

/** A <browser>'s tab, found by its own window: zenius's module scope has no ownerGlobal. */
function tabOfBrowser(browser) {
  try {
    return browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? null;
  } catch {
    return null;
  }
}

/** `promise`, or a rejection once `ms` pass first. */
function timed(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = lazy.setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => lazy.clearTimeout(timer));
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

/**
 * The error a stopped request ends with. Its client never reads it: it
 * canceled the request, which gets no answer, or its connection is gone.
 */
function stopError(reason, method) {
  return new ZenError(
    "ZEN_BROWSER_UNAVAILABLE",
    reason === "closed" ? `${method} stopped: its connection closed` : `${method} stopped: its client canceled it`,
    { stopped: method, reason }
  );
}

/** `fn()` when the request stops, at once if it has; returns off. No request (the runtime's own call): never. */
function onStopped(request, fn) {
  if (!request) {
    return () => {};
  }
  if (request.stopped) {
    let on = true;
    Promise.resolve().then(() => on && fn());
    return () => (on = false);
  }
  request.hooks.add(fn);
  return () => request.hooks.delete(fn);
}

/** A promise that fails with the request's stopError once it stops. */
function whenStopped(request, method) {
  const stopped = new Promise((_, reject) => onStopped(request, () => reject(stopError(request.stopped, method))));
  stopped.catch(() => {});
  return stopped;
}

/** `promise`, or the request's stopError once it stops first, after `cleanup()` ends what the wait holds. */
function unlessStopped(request, method, promise, cleanup) {
  if (!request) {
    return promise;
  }
  let off = () => {};
  const stopped = new Promise((_, reject) => {
    off = onStopped(request, () => {
      try {
        cleanup?.();
      } finally {
        reject(stopError(request.stopped, method));
      }
    });
  });
  stopped.catch(() => {});
  return Promise.race([promise, stopped]).finally(() => off());
}

function isThenable(value) {
  return !!value && typeof value.then === "function";
}

/** A response frame. NaN, ±Infinity, -0 and BigInt results go in `unserializable`. */
/** A request's final frame, with what its page code left that loads a page afresh (ctx.noteHooked), if anything. */
function withHooked(frame, request) {
  return request.hooked === null ? frame : { ...frame, hooked: request.hooked };
}

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
