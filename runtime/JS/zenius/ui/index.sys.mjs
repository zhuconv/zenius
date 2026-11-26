// ZeniusUI: the controller behind everything the user sees of an agent. It
// installs the takeover detector and badges in every browser window, follows
// the service's space events, and keeps the badge, cursor and notices of each
// agent Space in step with its ownership.
//
// Ownership belongs to zen-core: Spaces (modules/spaces.sys.mjs) is its only
// writer. This module changes it through spaces.setPaused / setOwnership when
// the user acts, and follows its "spaceChanged" events.

import {
  applyWindow as applyBadges,
  setSpaceBadge,
  spaceBadge,
  stateWords,
} from "chrome://userscripts/content/zenius/ui/badges.sys.mjs";
import {
  cursorState,
  cursorTabs,
  forgetCursor,
  hideCursor,
  moveCursorTab,
  setCursorPolicy,
  showCursor,
} from "chrome://userscripts/content/zenius/ui/cursor.sys.mjs";
import {
  moveNotice,
  noticeElement,
  noticeText,
  removeNotice,
  showNotice,
} from "chrome://userscripts/content/zenius/ui/notices.sys.mjs";
import { landOn, onNotePage, onNotePageCall } from "chrome://userscripts/content/zenius/ui/pages.sys.mjs";
import { onStep, stepsOf } from "chrome://userscripts/content/zenius/input/steps.sys.mjs";
import { askPageCode, endPageCodeAsks } from "chrome://userscripts/content/zenius/ui/pagecode.sys.mjs";
import {
  closeTasksPanel,
  idleText,
  needsUser,
  openTasksPanel,
  showArrival,
  updateTasks,
} from "chrome://userscripts/content/zenius/ui/panel.sys.mjs";
import { watchMutedTabs } from "chrome://userscripts/content/zenius/ui/muted.sys.mjs";
import { BACK_KEY_WORDS, Watches } from "chrome://userscripts/content/zenius/ui/watch.sys.mjs";
import { setTaskTag, watchTaskTags } from "chrome://userscripts/content/zenius/ui/tasktags.sys.mjs";
import { isolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";
import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { isDevicePrompt, watchPermissionPrompts } from "chrome://userscripts/content/zenius/ui/permissions.sys.mjs";
import { isAgentInput, Takeover } from "chrome://userscripts/content/zenius/ui/takeover.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import {
  addBackgroundTab,
  copiesOf,
  copyIn,
  liveCopy,
  sameTab,
} from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  currentDialog: "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs",
  releaseDialog: "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs",
});

/** A Space with no agent call for this long shows as idle. */
const ACTIVE_MS = 15000;
/** Announcements this soon after the first of them go out with it, as one. */
export const ANNOUNCE_MS = 300;
export /** How long after the user's keystroke in an agent page a copy there is theirs. */
const USER_KEY_MS = 1000;
/** After this many automatic handoffs left unanswered, a task takes no more. */
const MAX_UNANSWERED_HANDOFFS = 3;
const CONTROL_NOTICE = "zenius-control";
/** The pill on a tab whose agent close waits for the user to leave it. */
const CLOSING_NOTICE = "zenius-task-finished";
/**
 * The card on a page a task left open that the agent made itself (data:,
 * blob:, a popup its code filled): when the user is about to type there, or
 * something they did there was refused. A reload can't clean such a page,
 * since the agent wrote all of it. Other kept pages show nothing: the
 * agent's code ran in a sandbox discarded at the task's end, and a page it
 * wrote into loads afresh, quietly, when it matters.
 */
const KEPT_NOTICE = "zenius-kept-code";
/**
 * The card on a tab that joined a task while the user held it: they opened
 * it from the agent's page, with an opener (zen-core's adoptPopup during a
 * hold), so it's the agent's.
 */
const JOINED_NOTICE = "zenius-joined";
/** A refusal counts as the user's own action's if their click or key in the page came this soon before it. */
const USER_ACTION_MS = 5000;
/**
 * When to look again for a field with the keyboard in a kept page the
 * agent made, after the user's click or key there: the page's focus
 * reaches the parent's window about 100 ms later (measured headless).
 */
const TYPING_CHECK_MS = [100, 300, 700];
/** The same, after the user switches to that page's tab. */
const SELECT_CHECK_MS = [150, 400, 1000];
/** How long after a joined tab opens its card is announced: a link opens its tab, then selects it. */
const JOINED_ANNOUNCE_MS = 100;
/** A host the own tab's notice shows whole; a longer one shows its end. */
const MAX_HOST_CHARS = 40;
/** The notice on a tab where a load the user started to the local network was refused. */
const LOCALNET_NOTICE = "zenius-localnet";
/** The notice on a tab where the user's typing stays off: its quiet reload didn't come. */
const TYPING_OFF_NOTICE = "zenius-typing-off";
/**
 * The notice on a page that loaded afresh at the user's press, without the
 * agent's changes (#showReloaded): their first press or key in a page with
 * evidence, or their Take over.
 */
const RELOADED_NOTICE = "zenius-reloaded";
/** The warning on a page on a phishing or malware list, or that the agent flagged (#updatePageWarning). */
const PAGE_WARNING_NOTICE = "zenius-page-warning";
/**
 * The evidence that a clean copy clears (#cleanable): the agent's code
 * (hooked), its own page (made), and evidence zen-ux couldn't read
 * (unknown). The rest, a list's and the agent's flag, is the page itself.
 */
const CLEANABLE = ["hooked", "made", "unknown"];
/** The notice on a page whose Take over couldn't begin: why, and what still works. */
const TAKEOVER_REFUSED_NOTICE = "zenius-takeover-refused";
/** The claim gate's prompt, one per ask: this plus zen-core's id. */
const CLAIM_NOTICE = "zenius-claim:";
/**
 * The control pill's line on a page the agent made itself (no website: a
 * data: page it loaded, a blob: page its code made). zen-core refuses a
 * hand-off there, so only the user's own Take over shows it. Typing stays
 * on there.
 */
export const AGENTS_PAGE_LINE = "The agent made this page. It might contain malicious code. Keep sensitive information out.";
/**
 * The hold card's line: Resume agent empties password, card and code fields
 * (zen-input's hand-back guard) and reloads a page where one was typed and
 * not sent, so a user who expects the agent to submit what they typed would
 * lose it. Reloads themselves are silent: a card keeps only what the user
 * acts on.
 */
export const CLEARS_LINE = clearsLine("Resume agent");

/**
 * The Resume line for the button `label` names: the hold card's Resume
 * agent, or a panel row's Resume or Resume agent, which clear and reload
 * the same way.
 *
 * @param {string} label
 */
export function clearsLine(label) {
  return `${label} clears password, card and code fields, so submit what you type there first.`;
}
/**
 * The hold card's line after a hand-off with zen-core's secret flag: the
 * user's step shows them a secret (an API key, a token, a recovery code),
 * and their Resume loads about:blank in that tab, its history gone, before
 * the agent gets control back (zen-core). So they copy what they need
 * first. It leads the card, before the Resume line it makes moot.
 */
export const SECRET_LINE = "Resume agent clears this page, so copy what you need from it first.";
/** The same under the tasks panel's Resume agent, away from that page. */
export const PANEL_SECRET_LINE = "Resume agent clears the page the agent handed you, so copy what you need from it first.";
/** How long each frame gets to say whether it asks for a secret (#asksSecrets). */
const SECRET_KINDS_MS = 2000;
/** How long a page the agent made counts as asking for no secret before it's asked again (#madeWarns). */
const MADE_RECHECK_MS = 2000;
/** How long a Resume waits for zen-input's typedSecrets before it goes on without it. */
const TYPED_SECRETS_MS = 3000;
/**
 * zen-core's switch for zenius's quiet loads (modules/handoff.sys.mjs).
 * Tests of the hand back's other layers turn it off, to keep what the agent
 * put in a page; it's never off otherwise (zen-sdk's doctor warns). Off,
 * Resume reloads nothing and hands back at once, as before the quiet loads,
 * and zen-input's clear empties what the user typed.
 */
const QUIET_RELOAD_PREF = "zenius.handoff.quietReload";
const quietLoadsOn = () => Services.prefs.getBoolPref(QUIET_RELOAD_PREF, true);
/**
 * zen-observe's list of the local-network hosts every agent tab may reach
 * (observe/localnet.sys.mjs reads it at each request): comma-separated
 * entries, spaces and case ignored, an IPv6 address without brackets.
 * zenius writes it only on the user's own click of Add to allowlist.
 */
const ALLOW_PREF = "zenius.agentTabs.allowPrivateNetworks";
/** Who can change a Space's ownership (zen-core's setOwnership). */
const SOURCES = new Set(["agent", "user", "permission"]);

/**
 * The prompts a task's pages hand to the user, by Ego's reason key: for a
 * task whose prompt's own words (PROMPT_NAMES) are gone. permission_prompt,
 * Ego's catch-all, has none.
 */
const PERMISSION_NAMES = {
  storage_access: "for storage access",
  local_network_access: "to reach your local network",
  location: "for your location",
  notifications: "to show notifications",
  midi: "for MIDI devices",
  serial: "for a serial port",
};

/** What a prompt asks for, by PopupNotifications id (permissions.sys.mjs). */
const PROMPT_NAMES = {
  "storage-access": "for storage access",
  "local-network": "to reach your local network",
  "loopback-network": "to reach your local network",
  geolocation: "for your location",
  "web-notifications": "to show notifications",
  "persistent-storage": "for persistent storage",
  midi: "for MIDI devices",
  "webSerial-choosePort": "for a serial port",
  xr: "for virtual reality devices",
  "webRTC-shareDevices": "for the camera, microphone, screen or speakers",
};

/**
 * What the agent reads when zenius cancelled a task's page's prompt: on
 * evidence of danger in the page, or the devices' while the agent drives.
 * Sites that can't have the location ask for a typed place instead.
 *
 * @param {"evidence"|"device"} why
 */
function deniedText(id, origin, why) {
  const asked = `${origin || "The page"} asked ${PROMPT_NAMES[id] ?? "for a permission"}`;
  if (why === "device") {
    return `${asked}, which the agent never gets, so the prompt was cancelled without asking the user. The user can allow it while they hold the task.`;
  }
  const typed = id === "geolocation" ? " If the site takes a typed place instead, type it." : "";
  return `${asked}, and zenius holds evidence of danger in this page, so the prompt was cancelled without asking the user.${typed}`;
}

/**
 * What the agent reads when a page's automatic handoff is refused.
 *
 * @param {"site"|"task"} why  the site left a request unanswered, or the
 *   task's pages left too many
 * @param {string|null} [what]  what the prompt asks for (PROMPT_NAMES)
 */
function refusedText(kind, reason, origin, why, what = null) {
  const site = origin || "The page";
  const asked = kind === "passkey" ? "asked for a passkey" : `asked ${what ?? PERMISSION_NAMES[reason] ?? "for a permission"}`;
  const result = kind === "passkey" ? "the page got NotAllowedError" : "the prompt was cancelled";
  const rule =
    why === "site"
      ? " after leaving an earlier request unanswered in this task"
      : `, but pages left ${MAX_UNANSWERED_HANDOFFS} requests unanswered in this task`;
  return `${site} ${asked}${rule}, so ${result} without asking the user. To let them answer it, hand them the task.`;
}

/**
 * @typedef {object} SpaceUi  ui-side state of an agent Space
 * @property {string|null} uuid  its workspace, kept for after the record goes
 * @property {Element|null} currentTab  the page the agent acted on last
 * @property {number} lastActivity
 * @property {number} idleTimer
 * @property {string|null} source  who changed ownership last
 * @property {Element|null} noticeTab  where the control notice shows
 * @property {Map<string, string>} prompts  open permission prompts,
 *   "<browserId>:<prompt id>" → reason
 */

class UiController {
  started = false;
  /** @type {object|null} the ZeniusService */
  service = null;
  /** @type {Takeover|null} */
  takeover = null;
  /** @type {Map<number, SpaceUi>} */
  #spaces = new Map();
  /** @type {Map<number, number>} spaceId → when the user paused it (epoch ms) */
  #userPaused = new Map();
  #unsubscribe = [];
  #sweepTimer = 0;
  /**
   * Each agent task's last badge, keyed by task id. Tasks in the Agents
   * Space share its workspace, so a workspace's badge can't stand for them.
   * @type {Map<number, object>}
   */
  #taskBadges = new Map();
  /**
   * Each task's automatic handoffs: a page's permission prompt or passkey
   * request while the agent drives (see #onPermissionPrompt). `open` maps a
   * request's key to its origin until it's answered or left unanswered;
   * `spent` holds the origins that left one unanswered.
   * @type {Map<number, {open: Map<string, string>, spent: Set<string>, unanswered: number}>}
   */
  #autoHandOffs = new Map();
  /**
   * Each window's Space the user was last in that no agent holds: where a
   * tab of their own opens.
   * @type {WeakMap<Window, string>}
   */
  #userWorkspaces = new WeakMap();
  /** zen-observe's agentCodeOnSite, null without it; see agentCodeOnSite. */
  #agentCode = undefined;
  /** zen-observe's agentCodeInPage, null without it; see agentCodeInPage. */
  #agentCodeInPage = undefined;
  /** zen-observe's agentMadePage, null without it; see agentMadePage. */
  #agentMadePage = undefined;
  /** zen-core's cleanLoad, or a test's stand-in; see cleanLoad. */
  #cleanLoadFn = null;
  /** Tasks whose Take over waits for zen-core's reload (#takeOver). */
  #takingOver = new Set();
  /** <browser> → the top document its RELOADED_NOTICE is for (#showReloaded). */
  #reloadedDocs = new WeakMap();
  // The steps under way, by id: the task and page each acts on (zen-input's
  // onStep). A page with one keeps its cursor when a call names another.
  #runningSteps = new Map();
  /** tab → the task that last asked the cursor policy to draw there (#cursorTabsOf). */
  #cursorTask = new WeakMap();
  /** zen-input's typedSecrets, null without it; see typedSecrets. */
  #typedSecretsFn = undefined;
  /**
   * Pages a finished task left open whose document the agent made itself
   * (agentMadePage), which a reload would only run again, by the page's
   * browserId, which moves with it between windows' copies:
   * - the task and its name, for the card;
   * - a copy of the tab;
   * - the documents (innerWindowId) the agent made; those whose card the
   *   user dismissed; and those that had the reminder card already (once
   *   per document);
   * - the card up now, for one document the agent made: the reminder
   *   (refused null) or what a refusal took from the user (REFUSED's key);
   * - how the task ended: "finished", or "stopped" by the panel's Stop
   *   (unset while it runs, for a waiting close);
   * - kept: false for a waiting close, until the user keeps it (userKept
   *   while its task goes on: its end keeps it);
   * - the timers of the reminder's pending looks for a focused field.
   *
   * @type {Map<number, {task: number, name: string, tab: Element, docs: Set<number>, dismissed: Set<number>, reminded: Set<number>, card: {doc: number, refused: string|null}|null, ended?: string, kept: boolean, userKept?: boolean, typing?: number[]}>}
   */
  #keptCode = new Map();
  /**
   * When the user last clicked or pressed a key in each page (its
   * <browser>), from real input only: a refusal follows their own action
   * only if it came just after one (USER_ACTION_MS).
   *
   * @type {WeakMap<Element, number>}
   */
  #inputAt = new WeakMap();
  /** zen-observe's evidenceOf, null without it; see evidenceOf. */
  #evidenceOf = undefined;
  /**
   * browserId → the top document whose warning the user dismissed
   * (#updatePageWarning).
   *
   * @type {Map<number, number>}
   */
  #warningDismissed = new Map();
  /**
   * <browser> → whether its page the agent made asks for a secret, for the
   * top document `doc` (#madeWarns): true, false (as of `at`), or a promise
   * while a frame is still answering.
   *
   * @type {WeakMap<Element, {doc: number, value: boolean|Promise<boolean>, at: number}>}
   */
  #madeWarned = new WeakMap();
  /**
   * Whether zen-input tells when the user types a secret (onSecretTyped):
   * then the hold's card says Resume clears such fields only once they
   * did. Tests set it.
   */
  secretLineJustInTime = false;
  /**
   * Pages that ran none of the agent's code and couldn't open a window,
   * because a kept page linked to them still runs it (openRefused), by
   * browserId: a copy of the tab, and the document the pill is for.
   *
   * @type {Map<number, {tab: Element, doc: number}>}
   */
  /**
   * Each window's announcements waiting to go out together; see #announce.
   * @type {WeakMap<Window, {texts: {text: string, still: (() => boolean)|null}[], timer: number}>}
   */
  #bursts = new WeakMap();
  /**
   * Asks of zen-core's claim gate waiting for the user, by id, with the
   * tabs that show them.
   * @type {Map<string, {id: string, space: number, name: string, client: string, until: number, tabs: Set<Element>, timer: number}>}
   */
  #claims = new Map();
  /**
   * nsIAlertsService for the opt-in handOff notification; tests replace it.
   *
   * @type {{showAlert: Function}|null}
   */
  alertsService = null;

  /** Each window's watch of an agent's task (ui/watch.sys.mjs). */
  #watches = new Watches({
    isTaskTab: (id, tab) => this.#isTaskTab(id, tab),
    nameOf: id => this.#peek(id)?.name ?? "",
    changed: (win, change) => this.#watchChanged(win, change),
  });

  /** What the tasks panel's buttons do, by Space id. */
  #panelActions = {
    rows: () => this.tasks(),
    open: (id, win) => this.#withRec(id, rec => this.goToTask(rec, null, win)),
    openTab: (id, tabId, win) => this.#withRec(id, rec => this.goToTask(rec, tabId, win)),
    // The auto-close's one-click close (SPEC §3.4), as finish({keep: []})
    // with §3.5's waiting closes.
    closeIdle: id => this.#withRec(id, rec => this.service.closeIdleTask(rec)),
    pause: id => this.#withRec(id, rec => this.pauseByUser(rec)),
    resume: id => this.#withRec(id, rec => this.resumeByUser(rec)),
    takeOver: (id, win) =>
      this.#withRec(id, rec => {
        this.takeOverByUser(rec);
        this.openSpace(rec, null, win);
      }),
    handBack: id => this.#withRec(id, rec => this.#handBack(rec)),
    stop: id => this.#withRec(id, rec => this.stopByUser(rec)),
    openSidebar: (uid, win) => win?.ucAgentSidebar?.openTask?.(uid),
  };
  /**
   * The agent sidebar's tasks that need the user with no zenius task saying
   * so (noteSidebarWaiting): the strip and needsCount count them too.
   *
   * @type {import("chrome://userscripts/content/zenius/ui/panel.sys.mjs").SidebarWaiting[]}
   */
  #sidebarWaiting = [];

  /** @param {object} service  ZeniusService */
  start(service) {
    if (this.started) {
      return;
    }
    this.started = true;
    this.service = service;
    this.takeover = new Takeover({
      lookup: tab => this.lookup(tab),
      // A prompt's pause and the panel's pause add up: the prompt closing
      // doesn't resume a Space the user paused. A resume waits for the quiet
      // reload of a secret the user typed meanwhile (#beforeAgentRuns).
      setPaused: (rec, paused) => {
        if (!paused && this.#takingOver.has(rec.id)) {
          return;
        }
        if (paused || this.#userPaused.has(rec.id) || rec.ownership !== "agent") {
          service.spaces.setPaused(rec, paused || this.#userPaused.has(rec.id));
          return;
        }
        this.#beforeAgentRuns(rec, now => service.spaces.setPaused(now, this.#userPaused.has(now.id) || !!this.takeover.promptState(now.id)));
      },
      setOwnership: (rec, ownership, opts) => service.spaces.setOwnership(rec, ownership, opts),
      // The prompt's Take over, pressed or at the end of its countdown.
      takeOver: (rec, tab) => this.#takeOver(rec, tab?.linkedBrowser ?? null),
      onChange: (rec, what) => {
        this.#promptCursor(rec, what);
        this.#refreshBadge(rec);
      },
      held: rec => this.#userPaused.has(rec.id),
      noteUserInput: rec => service.spaces.noteUserInput?.(rec),
    });
    // No agent cursor in a Space the user controls. On a page whose Take
    // over prompt is open, the agent's action waits: its cursor shows there
    // when the agent goes on (#promptCursor).
    setCursorPolicy(tab => {
      const rec = this.lookup(tab)?.rec;
      if (rec) {
        this.#cursorTask.set(tab, rec.id);
      }
      const ownership = rec?.ownership;
      if (ownership === "agentDelegatedToUser" || ownership === "user") {
        return false;
      }
      return rec && this.takeover.promptState(rec.id)?.tab === tab ? "hold" : true;
    });
    this.#unsubscribe.push(
      service.addEventListener((event, params) => this.#onServiceEvent(event, params)),
      onNotePage(tab => this.#onAgentPage(tab)),
      onNotePageCall((tab, method) => this.#onAgentCall(tab, method)),
      onStep(({ space, step }) => this.#onStep(space, step))
    );
    // zen-observe refuses a load the user started to the local network in
    // an agent's tab: the tab says why (observe/localnet.sys.mjs, which its
    // setup has loaded already).
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/localnet.sys.mjs").onUserLoadRefused?.(
        event => this.userLoadRefused(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      console.error("[zenius] onUserLoadRefused failed", e);
    }
    // With the user's page-code setting at "ask", zen-observe asks before the
    // agent's page code runs on a site they haven't allowed: the agent's tab
    // shows the card (ui/pagecode.sys.mjs).
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/pagecode.sys.mjs").onPageCodeAsk?.(event =>
        askPageCode(event, { announce: (text, win) => this.#announce(text, win) })
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      console.error("[zenius] onPageCodeAsk failed", e);
    }
    // A page on a phishing or malware list, or that the agent flagged,
    // warns the user while they're on it, as zen-observe's mark comes
    // (observe/evidence.sys.mjs).
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs").onEvident?.(event =>
        this.evidenceAdded(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      console.error("[zenius] onEvident failed", e);
    }
    // zen-core refuses a window that a page opens with an opener, after its
    // task, while the page's window group holds a document that ran the
    // agent's code (modules/windows.sys.mjs). The pills say why when
    // nothing opened instead.
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs").onOpenRefused?.(
        event => this.openRefused(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      console.error("[zenius] onOpenRefused failed", e);
    }
    // And what zen-observe's content guards refuse in such a page after its
    // task (the camera, the microphone, location, notifications), forwarded
    // by zen-core: its card says so when the user just asked for it.
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs").onKeptRefused?.(
        event => this.keptRefused(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      console.error("[zenius] onKeptRefused failed", e);
    }
    // zen-core's spaces.takeOver and spaces.claim give a held task back to
    // the agent without Resume agent: they await this first, as Resume does.
    const beforeHandBack = rec => this.beforeHandBack(rec);
    service.beforeHandBack = beforeHandBack;
    this.#unsubscribe.push(() => {
      if (service.beforeHandBack === beforeHandBack) {
        service.beforeHandBack = null;
      }
    });
    // The user's typing into a password, card or code field of a task's
    // page: the hold's card then says Resume clears it.
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/handback.sys.mjs").onSecretTyped?.(event =>
        this.secretTyped(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
        this.secretLineJustInTime = true;
      }
    } catch (e) {
      log("zen-input's onSecretTyped isn't there:", String(e?.message ?? e).slice(0, 120));
    }
    // The user about to type in a page the agent's sandbox wrote into:
    // zen-input's guard has zen-core reload it quietly; the UI only hears
    // whether it did.
    try {
      const off = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/typing.sys.mjs").onUserTyping?.(event =>
        this.userTyping(event)
      );
      if (typeof off === "function") {
        this.#unsubscribe.push(off);
      }
    } catch (e) {
      // Quiet while zen-input's module isn't there.
      log("zen-input's onUserTyping isn't there:", String(e?.message ?? e).slice(0, 120));
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.attachWindow(win);
    }
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    for (const rec of service.spaces.records?.() ?? []) {
      this.#refreshBadge(rec);
    }
  }

  observe(subject, topic) {
    if (topic === "browser-delayed-startup-finished") {
      this.attachWindow(subject);
    }
  }

  /** @param {Window} win */
  attachWindow(win) {
    if (!win.gBrowser || win.closed) {
      return;
    }
    this.takeover.attachWindow(win);
    // A Space the user deletes in Zen leaves its badge and the tasks panel.
    // Spaces notices only when it refreshes, without an event.
    win.addEventListener("ZenWorkspacesUIUpdate", () => this.#scheduleSweep());
    // A page the agent no longer drives shows the dialog it held once the
    // user looks at it.
    win.addEventListener("TabSelect", event => this.#releaseDialog(event.target.linkedBrowser));
    // Where a tab of the user's own opens: the tab's own Space, which Zen
    // has set by the time it selects it.
    win.addEventListener("TabSelect", event => this.#noteUserWorkspace(win, event.target.getAttribute("zen-workspace-id")));
    // A claim's prompt stays in sight: it moves with the selection.
    win.addEventListener("TabSelect", event => this.#moveClaims(event.detail?.previousTab, event.target));
    // The user's own clicks and keys in a page: a refusal right after one
    // is theirs, and in a kept page that runs the agent's code a field may
    // have the keyboard now (the reminder). Capture on the window sees the
    // input before the page does, as the takeover's listener does.
    for (const type of ["pointerdown", "keydown"]) {
      win.addEventListener(type, event => this.#onPageInput(event), { capture: true });
    }
    win.addEventListener("TabSelect", event => this.#onSelectTyping(event.target));
    // Window sync moves a docShell between windows' copies of its tab,
    // firing this on both browsers. What zen-ux shows on a tab that isn't a
    // page goes with it (a page's goes on zen-core's pageMoved), once the
    // swap is done, as zen-core waits too.
    win.addEventListener(
      "EndSwapDocShells",
      event => {
        const tab = win.gBrowser?.getTabForBrowser(event.target);
        Promise.resolve().then(() => this.#onDocShellMoved(tab));
      },
      true
    );
    // The user's own tab, closed in every window, can be opened again; a
    // kept page's closing changes its task's count.
    win.addEventListener("TabClose", event => this.#onTabClose(event.target));
    // A page's new document: what zen-ux shows for the old one follows.
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        // A same-document move (pushState, a hash) keeps the origin.
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        if (webProgress.isTopLevel) {
          this.#onKeptLocation(browser);
          this.#onHandedPageLocation(browser);
          const tab = win.gBrowser.getTabForBrowser(browser);
          if (tab) {
            removeNotice(tab, LOCALNET_NOTICE, { refocus: false });
            removeNotice(tab, TYPING_OFF_NOTICE, { refocus: false });
            this.#updatePageWarning(browser);
            // Not for the clean copy it came with, should its word come late.
            if (this.#reloadedDocs.has(browser) && this.#reloadedDocs.get(browser) !== currentDoc(browser)) {
              this.#reloadedDocs.delete(browser);
              removeNotice(tab, RELOADED_NOTICE, { refocus: false });
            }
          }
        }
      },
    });
    watchPermissionPrompts(win, {
      // The words follow the prompt, not its key: Ego's catch-all key covers several.
      onPrompt: (browser, reason, id, origin) => this.#onPermissionPrompt(win, browser, reason, id, { origin, what: PROMPT_NAMES[id] ?? null }),
      onPromptGone: (browser, reason, id, answered) => this.#onPermissionGone(win, browser, id, answered),
      denies: (browser, id, origin) => this.#deniesPrompt(win, browser, id, origin),
    });
    watchMutedTabs(win);
    watchTaskTags(win);
    const apply = () => {
      this.#noteUserWorkspace(win, win.gZenWorkspaces?.activeWorkspace);
      // Asks that came before this window.
      for (const ask of this.service.spaces.pendingClaims?.() ?? []) {
        if (!this.#claims.has(ask?.id)) {
          this.#onClaimAsked(ask);
        }
      }
      for (const claim of this.#claims.values()) {
        this.#showClaim(claim, win.gBrowser.selectedTab);
      }
      applyBadges(win);
      updateTasks(win, this.tasks(), this.#panelActions, this.#sidebarWaiting);
      // A close that waited across a restart, if zen-core deferred it before
      // this window's UI was up.
      // On the copy that holds the tab's page (window sync), not on this
      // window's copy of a tab another window shows.
      for (const tab of win.document.querySelectorAll(".tabbrowser-tab")) {
        if (liveCopy(tab) === tab) {
          this.#showClosingNotice(tab, null);
        }
      }
    };
    if (win.gZenWorkspaces?.promiseInitialized) {
      win.gZenWorkspaces.promiseInitialized.then(apply);
    } else {
      apply();
    }
  }

  // -------------------------------------------------------------------------
  // Lookup and control

  /**
   * The managed page and Space record for a tab, without refreshing
   * anything: the takeover listener calls this on every click and keypress.
   *
   * @param {Element} tab
   * @returns {{rec: object, page: object}|null}
   */
  lookup(tab) {
    return this.service?.lookup(tab) ?? null;
  }

  #peek(id) {
    return this.service.spaces.peek(id) ?? null;
  }

  // -------------------------------------------------------------------------
  // What the user can do from the tasks panel

  /**
   * Hold the agent's next action until the user resumes. The page stays
   * usable and opens no takeover prompt meanwhile.
   *
   * @param {object} rec
   */
  pauseByUser(rec) {
    if (rec.ownership !== "agent") {
      return;
    }
    if (!this.#userPaused.has(rec.id)) {
      this.#userPaused.set(rec.id, Date.now());
    }
    this.service.spaces.setPaused(rec, true);
    this.#refreshBadge(rec);
  }

  /**
   * Is the user the one using this agent page at time `at` (epoch ms)? Yes
   * while the takeover prompt is open or the user paused the Space (the agent
   * can't act then), and for a moment after their own keystroke in the page:
   * a Cmd+C opens no prompt. A Space the agent doesn't control is the user's.
   * The clipboard guard sends the page's copies to the user's clipboard then,
   * and to the Space's otherwise.
   *
   * @param {Element} browser
   * @param {number} [at]  when the page acted, by its process's clock
   */
  isUserUsing(browser, at = Date.now()) {
    const rec = this.service.controlOf(browser)?.space;
    if (!rec || rec.ownership !== "agent") {
      return true;
    }
    // The page's process reads the same wall clock: allow only for rounding,
    // so an agent copy made just before the user's click stays the agent's.
    const slack = 2;
    const since = Math.min(this.takeover.promptState(rec.id)?.openedAt ?? Infinity, this.#userPaused.get(rec.id) ?? Infinity);
    if (since <= at + slack) {
      return true;
    }
    const key = this.takeover.lastKeyAt(browser);
    return key > 0 && key <= at + slack && at - key <= USER_KEY_MS;
  }

  /**
   * The agent sidebar's hand-off card's Resume agent: the hold card's and
   * the tasks panel's own (#handBack), so the user's press gives the task
   * back the same way from every place it shows.
   *
   * @param {object} rec
   */
  handBackByUser(rec) {
    return this.#handBack(rec);
  }

  /**
   * What Resume agent clears before the agent gets the task back, in the
   * tasks panel's words (#panelClears), for the sidebar's hand-off card; null
   * when nothing.
   *
   * @param {object} rec
   * @returns {string|null}
   */
  handBackClears(rec) {
    return this.#panelClears(rec);
  }

  /**
   * The panel's Resume: the agent runs again, after the quiet reload of a
   * secret the user typed meanwhile (#beforeAgentRuns).
   *
   * @param {object} rec
   */
  resumeByUser(rec) {
    this.#userPaused.delete(rec.id);
    this.#refreshBadge(rec);
    return this.#beforeAgentRuns(rec, now => {
      this.service.spaces.setPaused(now, this.#userPaused.has(now.id) || !!this.takeover.promptState(now.id));
      this.#refreshBadge(now);
    });
  }

  /**
   * The agent sidebar's word on a task its chat drives (zen-sidebar), so the
   * strip and the sidebar say the same thing (the next update's agreement):
   * - running: the chat's agent turn runs, so the task counts as working
   *   however long since its agent last acted (the strip's ACTIVE_MS);
   * - needs: why the chat waits for the user ("permission", "question",
   *   "error", …), or null, so the task needs them in the strip too.
   * A key left out keeps what it was.
   *
   * @param {number} spaceId  the chat's zenius task
   * @param {{running?: boolean, needs?: string|null}} word
   */
  noteSidebarTask(spaceId, { running, needs } = {}) {
    const rec = this.#peek(spaceId);
    if (!rec || rec.gone || rec.kind !== "task") {
      return;
    }
    const ui = this.#ui(rec.id);
    if (running !== undefined) {
      ui.turnRunning = !!running;
    }
    if (needs !== undefined) {
      ui.sidebarNeeds = typeof needs === "string" && needs ? needs.slice(0, 40) : null;
    }
    this.#refreshBadge(rec);
  }

  /** @param {object} rec */
  takeOverByUser(rec) {
    if (rec.ownership !== "agent") {
      return null;
    }
    this.#userPaused.delete(rec.id);
    return this.#takeOver(rec, this.#noticeTabFor(rec)?.linkedBrowser ?? null);
  }


  /**
   * End the agent's task: the Space and its tabs become the user's, and the
   * agent's calls fail with ZEN_TASK_SPACE_INACTIVE until it claims the Space
   * again on the user's word (Ego's "user" ownership).
   *
   * @param {object} rec
   */
  stopByUser(rec) {
    if (rec.ownership === "user") {
      return;
    }
    this.#userPaused.delete(rec.id);
    this.service.spaces.setOwnership(rec, "user", { source: "user" });
    this.service.spaces.setPaused(rec, false);
  }

  #withRec(id, fn) {
    const rec = this.#peek(id);
    if (rec && !rec.gone) {
      fn(rec);
    }
  }

  // -------------------------------------------------------------------------
  // Events

  #ui(id) {
    let ui = this.#spaces.get(id);
    if (!ui) {
      ui = {
        uuid: null,
        currentTab: null,
        lastActivity: 0,
        idleTimer: 0,
        source: null,
        noticeTab: null,
        prompts: new Map(),
        promptWhat: new Map(),
        // A Resume waits for a quiet reload: the later press wins.
        resumeToken: 0,
        // The user typed into a password, card or code field of the task's
        // pages since the agent last ran (zen-input's onSecretTyped): the
        // hold's card then says Resume clears them.
        secretTyped: false,
        // The agent's hand-off said its step shows the user a secret
        // (spaceChanged's secret): Resume blanks the page, so the hold's
        // card says to copy what they need first.
        secretStep: false,
        // The task's "needs you" OS notification is up (#needsUser).
        notified: false,
        // Pages that joined the task during this hold, by label, with a
        // copy of the tab: their tabs carry JOINED_NOTICE until it ends.
        joined: new Map(),
      };
      this.#spaces.set(id, ui);
    }
    return ui;
  }

  /**
   * An agent's call names `tab`, a page of its task, before it runs, a read
   * too (zen-core's notePageCall): the cursor leaves the task's other pages.
   * It showed where the agent last acted there, which is stale once the
   * agent works on another page, and sitting at its last click it reads as
   * the agent still being there. It's forgotten, not hidden, so the end of
   * a hold doesn't bring it back; the agent's next action there draws it
   * afresh. Every call checks them all, whatever the call before named: a
   * cursor may have been drawn without one.
   *
   * Two kinds of call leave the other pages' cursors: closing a page (a
   * popup the agent is done with) isn't work there, and a page whose action
   * is still under way (a script's calls on two pages at once) may be about
   * to press, so its cursor stays until a later call.
   *
   * @param {Element} tab
   * @param {string} method
   */
  #onAgentCall(tab, method) {
    if (method === "pages.close") {
      return;
    }
    const hit = this.lookup(tab);
    if (!hit) {
      return;
    }
    // A step that fell out of its task's ring while it ran never tells its
    // end (steps.sys.mjs keeps a task's last 50): one counts only while the
    // ring still shows it running, and goes once it doesn't.
    const busy = new Set();
    let running = null;
    for (const [id, { space, page }] of this.#runningSteps) {
      if (space !== hit.rec.id || !page) {
        continue;
      }
      running ??= new Set(stepsOf(space).filter(s => s.outcome === "running").map(s => s.id));
      if (running.has(id)) {
        busy.add(page);
      } else {
        this.#runningSteps.delete(id);
      }
    }
    const { pages } = this.service;
    for (const page of pages.list(hit.rec.id)) {
      const other = pages.tabFor(page);
      if (other && other !== tab && !busy.has(page.label)) {
        forgetCursor(other);
      }
    }
  }

  /** A step began or ended (zen-input's onStep): which pages have an action under way. */
  #onStep(space, step) {
    if (step?.outcome === "running") {
      this.#runningSteps.set(step.id, { space, page: step.page ?? null });
    } else {
      this.#runningSteps.delete(step?.id);
    }
  }

  /**
   * Take over's prompt (takeover.sys.mjs): the cursor on the page it opened
   * on hides while it's open, as the agent waits, and comes back when the
   * agent goes on (Resume agent, or the countdown with nothing typed), at
   * the point of the action that waited, if one did (the policy's "hold").
   * A Take over hides or forgets it as every hold does, when the ownership
   * changes.
   *
   * @param {object} rec
   * @param {"opened"|"moved"|"takeover"|"continue"|"cancel"} what  moved: it
   *   followed the user's input to another of the task's pages
   */
  #promptCursor(rec, what) {
    if (what === "opened" || what === "moved") {
      const tab = this.takeover.promptState(rec.id)?.tab;
      if (tab) {
        hideCursor(tab);
      }
    } else if (what === "continue" && rec.ownership === "agent") {
      for (const tab of this.#tabsOf(rec)) {
        showCursor(tab);
      }
    }
  }

  /** The agent acted on `tab` (cursor move, or zen-core's notePage). */
  #onAgentPage(tab) {
    const hit = this.lookup(tab);
    if (!hit) {
      return;
    }
    const ui = this.#ui(hit.rec.id);
    ui.currentTab = tab;
    ui.lastActivity = Date.now();
    lazy.clearTimeout(ui.idleTimer);
    ui.idleTimer = lazy.setTimeout(() => this.#refreshBadge(hit.rec), ACTIVE_MS + 50);
    this.#refreshBadge(hit.rec);
  }

  #onServiceEvent(event, params) {
    if (event === "tabClosing") {
      this.#onTabClosing(params?.tab, params?.space);
      return;
    }
    if (event === "pageMoved") {
      this.#onPageMoved(params);
      return;
    }
    if (event === "claimAsked") {
      this.#onClaimAsked(params);
      return;
    }
    if (event === "claimSettled") {
      this.#onClaimSettled(params?.id);
      return;
    }
    const id = params?.space;
    if (typeof id !== "number") {
      return;
    }
    const rec = this.#peek(id);
    if (event === "spaceFinished" || !rec || rec.gone) {
      this.#forget(id);
      this.#releaseShownDialogs();
      endPageCodeAsks(id);
      return;
    }
    if (event === "popup") {
      this.#onJoinedTab(rec, params);
      return;
    }
    if (event !== "spaceChanged" && event !== "spaceCreated") {
      return;
    }
    const ui = this.#ui(id);
    // Who holds the task comes from the record, and the source must be one
    // zen-core sets (defence in depth: params are as good as their sender).
    if (SOURCES.has(params.source)) {
      ui.source = params.source;
    }
    if ("ownership" in params) {
      if (rec.ownership !== "agent") {
        this.#endTakeOverRefused(ui);
      }
      // Only the hand-off that said so: a Take over or a page's prompt isn't one.
      ui.secretStep = rec.ownership === "agentDelegatedToUser" && ui.source === "agent" && params.secret === true;
      if (rec.ownership === "agent" && ui.secretTyped) {
        // The agent runs again: what the user typed was cleared, or sent.
        ui.secretTyped = false;
        this.#refreshTasks();
      }
      if (rec.ownership === "agent" && ui.source !== "permission") {
        // Handed back before the page's request was answered.
        this.#leaveAutoHandOffs(rec.id);
      }
      if (event === "spaceChanged" && rec.ownership === "user") {
        // The task ended and left tabs open: finish() (source "agent"; then
        // zen-observe forgets its agent code at spaceFinished) or the
        // panel's Stop (source "user"). The user's other ends of a task
        // leave none.
        this.#noteKeptMade(rec, params.source === "agent" ? "finished" : "stopped");
        endPageCodeAsks(rec.id);
      } else if (rec.ownership === "agent") {
        // The agent has the Space again (a claim after a Stop): the pages
        // the Stop left are its own again. A hand back mid-task finds none.
        this.#forgetKept(rec.id);
      }
      this.#onOwnership(rec, { ownership: rec.ownership, source: ui.source });
      if (event === "spaceChanged" && rec.ownership === "agentDelegatedToUser" && params.source === "agent") {
        this.#showHandOffReloads(rec, params);
      }
    } else if ("stateText" in params && ui.noticeTab && ui.source === "agent" && rec.ownership === "agentDelegatedToUser") {
      // The agent updated what it needs while it waits for the user.
      this.#showControlNotice(rec, ui.noticeTab, ui.source);
    }
    if ("ownership" in params || "paused" in params) {
      // After the hold's own card, so a screen reader hears that first.
      for (const tab of this.#tabsOf(rec)) {
        this.#updatePageWarning(tab.linkedBrowser);
      }
    }
    this.#refreshBadge(rec);
  }

  /**
   * The agent closed a tab a window shows (zen-core's tabClosing, SPEC
   * §3.5): it waits for the user to leave it. Its page has ended for the
   * agent, so the cursor goes, and a pill says why the tab stays: Keep makes
   * it the user's, Close closes it now.
   *
   * @param {Element} tab
   * @param {number|null} spaceId
   */
  #onTabClosing(tab, spaceId) {
    if (!tab?.isConnected || tab.closing) {
      return;
    }
    forgetCursor(tab);
    // The name now: a finish() drops its record in the same call.
    const rec = typeof spaceId === "number" ? this.#peek(spaceId) : null;
    const name = rec?.name ?? "";
    // And whether the agent made its document, for a Keep: zen-observe
    // forgets that with the task. It was the agent's page.
    if (rec) {
      this.#noteMade(rec, tab, { kept: false, agentPage: true });
    }
    // The pill once that call is over (a microtask can run inside it).
    lazy.setTimeout(() => this.#showClosingNotice(tab, spaceId, name, true), 0);
  }

  /**
   * The pill for a waiting close. A finish() ends the task in the call that
   * closed the tab, and then the task is done rather than just this page.
   * With no task (a close that waited across a restart: zen-core's rebuild
   * sends none, and neither does a window's start), all we know is that the
   * agent closed it.
   *
   * @param {boolean} [live]  zen-core's close just now, rather than a pill
   *   shown again for a window: a finished task is announced then
   */
  #showClosingNotice(tab, spaceId, name = "", live = false) {
    if (!tab.isConnected || tab.closing || !this.service.pages.isDeferred?.(tab)) {
      return;
    }
    const known = typeof spaceId === "number";
    const rec = known ? this.#peek(spaceId) : null;
    const finished = known && (!rec || rec.gone || rec.ownership === "user");
    // Only the user's own clicks reach the buttons: they're chrome, not page.
    showNotice(
      tab,
      CLOSING_NOTICE,
      closingCard(finished, name, {
        keep: () => {
          if (this.service.keepDeferred(tab)) {
            this.#keptByUser(tab);
          }
        },
        close: () => this.service.closeDeferred(tab),
      })
    );
    // A task that finished on the tab the user is looking at. An agent's
    // close of one page is routine, and isn't announced. A window that
    // watched the task has said it's done, with the way back, just now.
    const win = tab.ownerDocument.defaultView;
    if (live && finished && isTabVisible(tab) && win === Services.wm.getMostRecentWindow("navigator:browser")) {
      const what = ["Task finished", isolate(name)].filter(Boolean).join(": ");
      const watched = this.#watches.doneOf(win) === spaceId;
      this.#announce(watched ? "This tab closes when you leave it." : `${what}. This tab closes when you leave it.`, win);
    }
  }

  /**
   * A task ended and left tabs open: the pages kept for the user, and its
   * other tabs (zen-core's pages.tabsOf). Note the pages the agent made
   * itself, while zen-observe's record of the task still exists
   * (agentMadePage reads it): their card comes when it matters. Nothing
   * shows at the task's end.
   */
  #noteKeptMade(rec, ended = "finished") {
    let noted = false;
    for (const tab of this.service.pages.tabsOf?.(rec) ?? []) {
      // Who opened it: a page's own record (a Stop keeps them), else the
      // ledger's (a finish moves them there).
      const openedBy = this.service.pages.forTab?.(tab)?.openedBy ?? rec.ledger?.unmanaged?.[this.service.pages.tabId?.(tab)];
      noted = this.#noteMade(rec, tab, { kept: true, agentPage: openedBy === "agent", ended }) || noted;
    }
    // A waiting close of the task ends with it too, and one the user kept
    // while the task went on joins its kept pages now.
    for (const k of this.#keptCode.values()) {
      if (k.task === rec.id) {
        k.ended = ended;
        if (k.userKept && !k.kept) {
          k.kept = true;
          noted = true;
        }
      }
    }
    if (noted) {
      this.#renderKept(rec.id);
    }
  }

  /**
   * The agent has a task's Space again: the pages a Stop left are its own
   * again, so their notes and cards go. A waiting close keeps its note
   * (unkept), for a Keep once the task ends.
   */
  #forgetKept(taskId) {
    for (const [bid, k] of this.#keptCode) {
      if (k.task !== taskId || !k.kept) {
        continue;
      }
      for (const t of k.typing ?? []) {
        lazy.clearTimeout(t);
      }
      for (const copy of new Set([k.tab, ...copiesOf(k.tab)])) {
        removeNotice(copy, KEPT_NOTICE, { refocus: false });
      }
      this.#keptCode.delete(bid);
    }
  }

  /**
   * Note `tab`'s page if the agent made its current document itself
   * (agentMadePage), on a site where its code ran (agentCodeInPage).
   * zen-observe counts a document with no site behind it as the agent's, as
   * it is in the agent's own pages; such a page of the user's (their data:
   * page) isn't one, so it counts only in a tab the agent opened. A waiting
   * close is noted unkept, for a Keep.
   *
   * @param {object} rec
   * @param {Element} tab
   * @param {{kept: boolean, agentPage: boolean, ended?: string|null}} how
   *   ended: how the task ended, null while it runs (a waiting close)
   * @returns {boolean} whether it did
   */
  #noteMade(rec, tab, { kept, agentPage, ended = null }) {
    const browser = tab?.linkedBrowser;
    if (!browser?.browserId) {
      return false;
    }
    const doc = currentDoc(browser);
    const site = doc ? this.#agentCodeSite(rec, browser) : null;
    if (site === null || (site === "" && !agentPage) || !this.#madeByAgent(rec, browser)) {
      return false;
    }
    const k = this.#keptCode.get(browser.browserId) ?? { docs: new Set(), dismissed: new Set(), reminded: new Set(), card: null, kept: false };
    Object.assign(k, { task: rec.id, name: rec.name ?? "", tab });
    if (ended) {
      k.ended = ended;
    }
    k.docs.add(doc);
    k.kept ||= kept;
    this.#keptCode.set(browser.browserId, k);
    return true;
  }

  /**
   * The user kept a waiting close. If the agent made its document and its
   * task is over, it joins the task's kept pages. A task still going asks
   * again when it finishes.
   */
  #keptByUser(tab) {
    const bid = (liveCopy(tab) ?? tab).linkedBrowser?.browserId;
    const k = this.#keptCode.get(bid);
    if (!k || k.kept) {
      return;
    }
    const rec = this.#peek(k.task);
    if (rec && !rec.gone && rec.ownership !== "user") {
      k.userKept = true;
      return;
    }
    k.kept = true;
    this.#renderKept(k.task);
  }

  /**
   * A task's kept pages whose current document is one the agent made, each
   * with its live copy. A page closed in every window is
   * forgotten.
   */
  #keptRunning(taskId) {
    const running = [];
    for (const [bid, k] of this.#keptCode) {
      if (k.task !== taskId || !k.kept) {
        continue;
      }
      const live = liveCopy(k.tab, bid);
      if (!live) {
        this.#keptCode.delete(bid);
        continue;
      }
      k.tab = live;
      if (k.docs.has(currentDoc(live.linkedBrowser))) {
        running.push({ bid, k, live });
      }
    }
    return running;
  }

  /**
   * Draw a task's kept pages the agent made itself: the card up for the
   * page's document, if any (the reminder or a refusal's), on its live copy
   * unless the user dismissed it. A page whose document changed, or that
   * closed, loses it. Other kept pages show nothing.
   * Nothing takes focus or moves a view (I1).
   */
  #renderKept(taskId) {
    const running = this.#keptRunning(taskId);
    for (const [bid, k] of this.#keptCode) {
      if (k.task !== taskId || !k.kept) {
        continue;
      }
      const r = running.find(x => x.bid === bid);
      const doc = r ? currentDoc(r.live.linkedBrowser) : 0;
      const card = r && k.card?.doc === doc && !k.dismissed.has(doc) ? k.card : null;
      for (const copy of new Set([k.tab, ...copiesOf(k.tab)])) {
        if (card && copy === r.live) {
          showNotice(copy, KEPT_NOTICE, this.#keptCard(bid, k, card));
        } else {
          removeNotice(copy, KEPT_NOTICE, { refocus: copy === k.tab });
        }
      }
    }
  }

  /** The card for a kept page the agent made: the reminder, or what a refusal took. */
  #keptCard(bid, k, card) {
    return madePageCard({ refused: card.refused }, { dismiss: () => this.#dismissKept(bid) });
  }

  /** Is `browser`'s current document a kept page's that the agent made itself? */
  #madeKept(browser) {
    const k = browser?.browserId ? this.#keptCode.get(browser.browserId) : null;
    return !!k?.kept && k.docs.has(currentDoc(browser));
  }

  /**
   * The user is about to type in a kept page the agent made: a field there
   * has the keyboard. The reminder shows once per document, and not after
   * the user dismissed a card there; it takes no focus, and a screen
   * reader hears it.
   *
   * @param {Element} browser
   */
  #checkTyping(browser) {
    const bid = browser?.browserId;
    const k = bid ? this.#keptCode.get(bid) : null;
    const live = k?.kept ? liveCopy(k.tab, bid) : null;
    const doc = currentDoc(browser);
    if (!live || live.linkedBrowser !== browser || !k.docs.has(doc) || k.reminded.has(doc) || !focusedField(browser)) {
      return;
    }
    // Only a page that asks for a secret, or that the agent flagged.
    if (!this.#madeWarns(browser, () => this.#checkTyping(browser))) {
      return;
    }
    k.reminded.add(doc);
    this.#stopTypingChecks(k);
    if (k.dismissed.has(doc) || k.card?.doc === doc) {
      return;
    }
    k.card = { doc, refused: null };
    this.#renderKept(k.task);
    this.#announceCard(live, KEPT_NOTICE);
  }

  /** Look for a field with the keyboard in a kept page after each of `delays`, replacing the looks pending. */
  #scheduleTypingChecks(browser, k, delays) {
    this.#stopTypingChecks(k);
    k.typing = delays.map(ms => lazy.setTimeout(() => this.#checkTyping(browser), ms));
  }

  #stopTypingChecks(k) {
    for (const t of k.typing ?? []) {
      lazy.clearTimeout(t);
    }
    k.typing = [];
  }

  /**
   * The user's own click or key in a page (the window's capture listener,
   * real input only). It's noted for refusals, and in a kept page the agent
   * made it may mean a field has the keyboard: at once for a key typed
   * there, a moment later for a click or Tab.
   */
  #onPageInput(event) {
    const browser = event.target;
    if (!event.isTrusted || browser?.localName !== "browser" || isAgentInput()) {
      return;
    }
    this.#inputAt.set(browser, Date.now());
    const k = this.#keptCode.get(browser.browserId);
    if (!this.#madeKept(browser) || k.reminded.has(currentDoc(browser))) {
      return;
    }
    if (event.type === "keydown" && event.key !== "Tab") {
      this.#checkTyping(browser);
    }
    this.#scheduleTypingChecks(browser, k, TYPING_CHECK_MS);
  }

  /** The user switched to a tab: a kept page's field may have the keyboard already. */
  #onSelectTyping(tab) {
    const browser = tab?.linkedBrowser;
    const k = browser?.browserId ? this.#keptCode.get(browser.browserId) : null;
    if (this.#madeKept(browser) && !k.reminded.has(currentDoc(browser))) {
      this.#scheduleTypingChecks(browser, k, SELECT_CHECK_MS);
    }
  }

  /** Did the user's own click or key in `browser`'s page come just now (USER_ACTION_MS)? */
  #userActed(browser) {
    const at = browser ? this.#inputAt.get(browser) : undefined;
    return at !== undefined && Date.now() - at <= USER_ACTION_MS;
  }

  /** A screen reader hears the card `id` on `tab`, if the tab is in view in the front window. */
  #announceCard(tab, id) {
    const win = tab?.ownerDocument?.defaultView;
    const el = tab ? noticeElement(tab, id) : null;
    if (el && win === Services.wm.getMostRecentWindow("navigator:browser") && isTabVisible(tab)) {
      const part = name => el.querySelector(`.zenius-card-${name}`)?.textContent ?? "";
      const detail = part("detail");
      this.#announce(`${part("title")}${detail ? `: ${detail}` : ""}. ${part("note")}`, win);
    }
  }

  /** The user dismissed a kept page's card: gone for that document, until a refusal there brings one. */
  #dismissKept(bid) {
    const k = this.#keptCode.get(bid);
    const doc = k ? currentDoc(liveCopy(k.tab, bid)?.linkedBrowser) : 0;
    if (doc) {
      k.dismissed.add(doc);
      this.#renderKept(k.task);
    }
  }

  /** A kept page showed a new document, or an old one again (Back): its card follows. */
  #onKeptLocation(browser) {
    const k = this.#keptCode.get(browser.browserId);
    if (k?.kept) {
      this.#renderKept(k.task);
    }
  }

  /**
   * Is there evidence in `browser`'s page that a clean copy clears
   * (#cleanable), for a refusal there? Its event says so with evident: true,
   * and leaves it out otherwise (zen-core's and zen-observe's, keyed on
   * hooked and made alone), so without it the page is asked.
   *
   * @param {Element} browser
   * @param {boolean} [flag]  the event's own answer
   */
  #cleanablePage(browser, flag) {
    return flag === true || this.#cleanable(browser);
  }

  /**
   * There's evidence in the page of `browser` that a clean copy clears, and
   * something the user just did there was refused for that: it loads
   * afresh, quietly, through zen-core's cleanLoad, with the form carried
   * over, and shows no card. Their next try works. Not a page of a task
   * that runs, nor one the agent made, which a reload can't clean.
   */
  #reloadCleanable(browser) {
    const rec = this.service.controlOf?.(browser)?.space;
    if ((rec && !rec.gone && rec.ownership !== "user") || this.#madeKept(browser)) {
      return;
    }
    this.#cleanLoad(browser);
  }

  /**
   * zen-core refused a window that `browser`'s page opened with an opener:
   * after its task, a page whose window group holds a document with
   * evidence of danger can't open windows its code could reach.
   *
   * - The refusal opens nothing in its place (zen-core: the parent can't
   *   tell a form's POST from a GET), so the user's click did nothing: a
   *   window.open, a link or form with an opener or a named target,
   *   about:blank, blob:, data:, a feature popup refused on the Mac.
   * - When it followed the user's own click or key there (USER_ACTION_MS),
   *   the pages with evidence a clean copy clears load afresh, quietly: this
   *   page if it has some (`evident`), else the group's other pages that
   *   do. The user's next try opens. A kept page the agent made gets its
   *   card instead.
   * - One that a plain tab opened in its place (reopened, which the refusal
   *   doesn't do today) needs nothing.
   * - While the user holds a page of the task, zen-core refuses opens from
   *   the task's other pages that may hold the agent's code (hold): no
   *   strings for it yet, so nothing shows.
   *
   * @param {{browser: Element, url?: string, reopened?: boolean, hold?: boolean, evident?: boolean}} event
   *   url: what the page tried to open ("" for about:blank); evident: the
   *   opener's own page has evidence
   */
  openRefused({ browser, reopened, hold, evident } = {}) {
    const doc = currentDoc(browser);
    if (hold || reopened || !doc || !this.#userActed(browser)) {
      return;
    }
    const k = this.#keptCode.get(browser.browserId);
    if (this.#madeKept(browser)) {
      this.#showRefused(browser, k, doc, "window");
      return;
    }
    if (this.#cleanablePage(browser, evident)) {
      this.#reloadCleanable(browser);
      return;
    }
    for (const other of this.#cleanableInGroup(browser)) {
      this.#reloadCleanable(other);
    }
  }

  /**
   * zen-observe refused something a kept page with evidence of danger
   * asked for: the camera, the microphone, the screen, location or
   * notifications (zen-core's onKeptRefused, from the content guards). If
   * the user's own click or key there came just before, the page loads
   * afresh, quietly, and their next try works; a kept page the agent made
   * gets its card, saying what and why. The speakers, the device list and
   * MIDI need nothing: the user wouldn't miss them.
   *
   * @param {{browser: Element, kind: string, asked?: string, evident?: boolean}} event
   *   kind and asked: zen-observe's (deviceAccess or notification; a word
   *   list such as "camera microphone"); evident: the page has evidence
   */
  keptRefused({ browser, kind, asked, evident } = {}) {
    const refused = refusedKind(kind, typeof asked === "string" ? asked : "");
    const doc = currentDoc(browser);
    if (!refused || !doc || !this.#userActed(browser)) {
      return;
    }
    if (this.#madeKept(browser)) {
      this.#showRefused(browser, this.#keptCode.get(browser.browserId), doc, refused);
      return;
    }
    if (this.#cleanablePage(browser, evident)) {
      this.#reloadCleanable(browser);
    }
  }

  /** A kept page's card for a refusal (REFUSED's key), heard when it comes up or changes. */
  #showRefused(browser, k, doc, refused) {
    const fresh = k.card?.doc !== doc || k.card.refused !== refused || k.dismissed.has(doc);
    k.card = { doc, refused };
    k.dismissed.delete(doc);
    this.#renderKept(k.task);
    if (fresh) {
      this.#announceCard(liveCopy(k.tab, browser.browserId), KEPT_NOTICE);
    }
  }

  /**
   * The other pages of `browser`'s window group with evidence a clean copy
   * clears: what keeps it from opening windows under zen-core's refusal.
   * Each as the <browser> that shows it.
   *
   * @param {Element} browser
   * @returns {Element[]}
   */
  #cleanableInGroup(browser) {
    let tops = [];
    try {
      tops = browser.browsingContext?.group?.getToplevels() ?? [];
    } catch {}
    const found = [];
    for (const top of tops) {
      const other = top.embedderElement;
      if (top.browserId === browser.browserId || other?.localName !== "browser" || found.includes(other)) {
        continue;
      }
      if (this.#cleanable(other)) {
        found.push(other);
      }
    }
    return found;
  }

  /**
   * The task whose agent made the document now in `target`'s page, as noted
   * when the task ended or when the agent closed a page the user viewed
   * (kept: whether it's among the task's kept pages yet), else null.
   * `target` is a <browser>, a WindowGlobalParent or any BrowsingContext in
   * the page's tree. A new top document has none, and Back to the noted one
   * brings it back. Nothing shows it: the page's card comes when the user is
   * about to type there, or when something they did there was refused.
   *
   * @param {Element|BrowsingContext|WindowGlobalParent} target
   * @returns {{task: number, kept: boolean}|null}
   */
  madePage(target) {
    let top = null;
    try {
      top = (target?.browsingContext ?? target)?.top ?? null;
    } catch {}
    const k = top?.browserId ? this.#keptCode.get(top.browserId) : null;
    const doc = top?.currentWindowGlobal?.innerWindowId;
    return k && doc && k.docs.has(doc) ? { task: k.task, kept: !!k.kept } : null;
  }

  #onOwnership(rec, { ownership, source }) {
    const ui = this.#ui(rec.id);
    if (ownership !== "agentDelegatedToUser" && ui.noticeTab) {
      removeNotice(ui.noticeTab, CONTROL_NOTICE);
      ui.noticeTab = null;
    }
    if (ownership === "agentDelegatedToUser") {
      // A hold asks its pages afresh whether they ask for a secret (#madeWarns).
      for (const tab of this.#tabsOf(rec)) {
        this.#madeWarned.delete(tab.linkedBrowser);
      }
    }
    if (ownership !== "agentDelegatedToUser") {
      this.#endHandOffNotification(rec.id, ui);
      this.#endJoined(rec, ui);
    }
    if (ownership === "agent") {
      // Handed back: the cursor returns where it was, with its label.
      for (const tab of this.#tabsOf(rec)) {
        showCursor(tab);
      }
      return;
    }
    // Control left the agent: no prompt, no cursor, no dialog held for the
    // agent, and a notice in the agent's page saying who has control and how
    // to hand it back. A task that ended forgets its cursor, in a tab its
    // finish kept too.
    this.takeover.resolve(rec.id, "cancel");
    for (const tab of this.#cursorTabsOf(rec)) {
      if (ownership === "user") {
        forgetCursor(tab);
      } else {
        hideCursor(tab);
      }
    }
    this.#releaseShownDialogs();
    if (ownership !== "agentDelegatedToUser") {
      return;
    }
    const tab = this.#noticeTabFor(rec);
    if (!tab) {
      return;
    }
    if (ui.noticeTab && ui.noticeTab !== tab) {
      removeNotice(ui.noticeTab, CONTROL_NOTICE);
    }
    ui.noticeTab = tab;
    if (source === "agent" || source === "permission") {
      this.#needsUser(rec, source);
    }
    this.#showControlNotice(rec, tab, source);
  }

  /**
   * A moment that needs the user: the agent's handOff(), or a page's
   * permission or passkey request in its tab. A screen reader hears it, and
   * the OS notification the user opted into goes up. Neither moves focus or
   * raises a window. Compact mode, whose hidden sidebar holds the strip and
   * the badge, relies on that notification.
   */
  #needsUser(rec, source) {
    const card = controlCard(rec, source, [...this.#ui(rec.id).promptWhat.values()].at(-1));
    const name = isolate(rec.name);
    // The page its card is on (#onOwnership set it just before).
    const site = heldSite(this.#ui(rec.id).noticeTab?.linkedBrowser);
    const where = `${name ? ` in ${name}` : ""}${site ? `, on ${site}` : ""}`;
    const secret = source === "agent" && this.#ui(rec.id).secretStep ? ` ${SECRET_LINE}` : "";
    // Said only while this hold lasts: not once the user or the agent ended
    // it, or the task finished, before the burst went out.
    const holds = () => rec.ownership === "agentDelegatedToUser" && rec.heldBy === source && !rec.gone;
    this.#announce(source === "permission" ? `${card.title}${where}: ${card.detail}.` : `${card.title}${where}.${secret}${card.note ? ` ${card.note}` : ""}`, undefined, holds);
    const text = source === "permission" ? `The ${card.detail}.` : rec.stateText || "It's waiting for you in its Space.";
    this.#ui(rec.id).notified ||= this.#notify(
      `zenius-handoff-${rec.id}`,
      `An agent needs you: ${rec.name}`,
      text,
      () => this.goToTask(rec),
      String(rec.id)
    );
  }

  /**
   * The pill in the agent's page while the user has control: who has it,
   * why, and Resume agent. A permission prompt has no button: answering the
   * browser's prompt gives control back.
   *
   * The user types in the agent's own tab, and zenius makes that safe by
   * itself. zen-core's hand-off reloads a page with evidence of danger
   * before the hold begins, and the page says so in a card of its own
   * (#showHandOffReloads). On a page the agent made itself, where only the
   * user's own Take over lands (zen-core refuses a hand-off there), the
   * line says not to enter a password.
   */
  #showControlNotice(rec, tab, source) {
    const ui = this.#ui(rec.id);
    // The site the user is on there, which a sign-in may change on its own:
    // the card follows the page's top document (#onHandedPageLocation).
    const card = { ...controlCard(rec, source, [...ui.promptWhat.values()].at(-1)), site: heldSite(tab.linkedBrowser) ?? undefined };
    if (source === "permission") {
      showNotice(tab, CONTROL_NOTICE, { ...card, buttons: [] });
      return;
    }
    const lines = card.note ? [card.note] : [];
    const browser = tab.linkedBrowser;
    if (this.#madeByAgent(rec, browser) && this.#madeWarns(browser, () => this.#redrawControlNotice(rec, tab))) {
      lines.push(AGENTS_PAGE_LINE);
    }
    // The Resume line, just in time: once the user typed a secret there, or
    // always when zen-input can't say. It leads then, since the user is
    // typing, and the rest waits behind the '?'. A secret step's line leads
    // instead: Resume blanks the whole page.
    const clears = ui.secretTyped || !this.secretLineJustInTime;
    const lead = ui.secretStep ? SECRET_LINE : clears ? CLEARS_LINE : null;
    showNotice(tab, CONTROL_NOTICE, {
      ...card,
      note: (lead ?? lines.join(" ")) || undefined,
      more: (lead && lines.join(" ")) || undefined,
      buttons: [{ label: "Resume agent", primary: true, onClick: () => this.#handBack(rec) }],
    });
  }

  /**
   * The agent's hand-off loaded pages afresh before the hold began (zen-core's
   * holdForUser): the page it hands the user when it had evidence of danger
   * (spaceChanged's reloaded), and any page that a popup the agent acted in
   * could reach. Each says so, as after the user's Take over, since a form
   * there may be back at its defaults while it looks filled in: a press would
   * submit the defaults (as on Cloudflare's token form). The pages are
   * those zen-core noted for this hold, by label (the record's
   * handBackReloaded, which the hold's start clears). Each says why when
   * spaceChanged carries holdForUser's evidence by label, as Take over's
   * result does (reloadReason).
   *
   * @param {object} rec
   * @param {{reloaded?: string, evidence?: Object<string, Object<string, string>>}} params
   *   the hold's spaceChanged
   */
  #showHandOffReloads(rec, params) {
    const shown = new Set();
    const why = (browser, label) => {
      if (!label) {
        try {
          label = this.service.controlOf?.(browser)?.page?.label ?? null;
        } catch {}
      }
      const all = params.evidence;
      const evidence = label && all && typeof all === "object" && Object.hasOwn(all, label) ? all[label] : null;
      return evidence && typeof evidence === "object" ? evidence : null;
    };
    const show = (browser, label = null) => {
      if (browser && !shown.has(browser)) {
        shown.add(browser);
        this.#showReloaded(browser, { evidence: why(browser, label) });
      }
    };
    for (const label of Array.isArray(rec.handBackReloaded) ? rec.handBackReloaded : []) {
      show(this.#pageBrowser(rec, label), label);
    }
    if (params.reloaded === "reload" || params.reloaded === "get") {
      let held = null;
      try {
        held = this.service.pages?.userTab?.(rec)?.linkedBrowser ?? null;
      } catch (e) {
        console.error("[zenius] couldn't find the page handed off", e);
      }
      show(held);
    }
  }

  /** The hold's card again, if it's still up on `tab` (#madeWarns learned more). */
  #redrawControlNotice(rec, tab) {
    const now = this.#peek(rec.id);
    const ui = this.#spaces.get(rec.id);
    if (now?.ownership === "agentDelegatedToUser" && ui?.noticeTab === tab && noticeElement(tab, CONTROL_NOTICE)) {
      this.#showControlNotice(now, tab, ui.source);
    }
  }

  /**
   * The user is about to act in a page the agent's sandbox wrote into
   * (zen-input's onUserTyping, for pages with evidence of danger only: their
   * first press or key anywhere in it, a paste, a drop or a composition).
   * zen-input's guard holds their presses and keys back and has zen-core
   * load the page afresh, quietly, with the form carried over
   * (cleanOnDemand), in a live task's page or a kept one; the UI does
   * neither. The takeover prompt still answers the user's input in a page
   * the agent drives. Once the new document is in, the page says it
   * reloaded, since a form there may be back at its defaults
   * (#showReloaded). If no new document comes, the user's clicks and keys
   * stay held there, and the tab says so, with Reload (#typingStaysOff).
   * The new document can come in with evidence too (zen-core's
   * stillEvident): a window on the same site, such as a popup or the page's
   * opener, shares its group and holds the agent's code. Then reloading
   * can't help until that window closes, and the card says so.
   *
   * @param {{browser: Element, trigger?: string, field?: boolean, reloaded?: Promise<{how?: string|null}>}} event
   *   trigger: "press", "key", "paste", "drop" or "composition"; field: it
   *   went for a field, whose focus and keys the clean copy gets back
   *   (zen-input's replay); reloaded: zen-core's cleanOnDemand promise, whose
   *   `how` is null when there was nothing to clean
   */
  userTyping({ browser, trigger, field, reloaded } = {}) {
    if (typeof reloaded?.then !== "function") {
      return null;
    }
    // What the page reloads on: zen-core's result says (evidence). This hook
    // runs before the new document commits, which starts clean, so a read
    // now stands in for a result without it.
    const before = this.#evidence(browser);
    return Promise.resolve(reloaded).then(
      result => {
        if (result?.how) {
          this.#showReloaded(browser, { clickLost: trigger === "press" && field !== true, evidence: result.evidence ?? before });
        }
        return true;
      },
      e => {
        const still = e?.stillEvident === true || e?.stillWritten === true;
        const what = still ? "came in with evidence too: a window on the same site holds it" : "didn't come";
        console.error(`[zenius] the quiet reload before the user's ${trigger ?? "input"} ${what}; their clicks and keys stay held there`, browser?.currentURI?.spec ?? "", e);
        this.#typingStaysOff(browser, { stillEvident: still });
        return false;
      }
    );
  }

  /**
   * The quiet reload before the user's first click or key didn't come, so
   * their clicks and keys stay out of the page (zen-input): the tab says so,
   * with Reload, which has zen-core load it afresh again (a recovery, not a
   * safety choice). The card stays up while it tries, and goes with the
   * tab's next document, which ends the drop too. It takes no focus; a
   * screen reader hears it when the tab is in view.
   *
   * @param {Element} browser
   * @param {{stillEvident?: boolean}} [why]  stillEvident: the new document
   *   came in with evidence too, so the card says to close the site's other
   *   window first
   */
  #typingStaysOff(browser, { stillEvident = false } = {}) {
    const win = browser?.ownerDocument?.defaultView;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    if (!tab || !browser.isConnected) {
      return;
    }
    const doc = currentDoc(browser);
    showNotice(
      tab,
      TYPING_OFF_NOTICE,
      reloadFailedCard({ stillEvident }, {
        reload: () => {
          if (currentDoc(browser) === doc) {
            this.#cleanLoad(browser);
          }
        },
      })
    );
    this.#announceCard(tab, TYPING_OFF_NOTICE);
  }

  /**
   * `browser`'s page loaded afresh at the user's press, without the agent's
   * changes: zen-core's clean copy at their first press or key in a page with
   * evidence (userTyping), or at their Take over (#takeOver). A form there may
   * be back at its defaults, and the page looks the same otherwise: a React
   * form's state isn't carried over. So the page says so, and that the press
   * that set it off went nowhere. It only informs: no choice, no focus; the
   * reload stays automatic. It goes with its ✕ or the tab's next document.
   * A screen reader hears it when the tab is in view.
   *
   * @param {Element} browser
   * @param {{clickLost?: boolean, evidence?: Object<string, string>|null}} [what]
   *   clickLost: the press that set it off went nowhere (not on a field,
   *   whose focus comes back); evidence: what zen-core reloaded it on
   *   ({reason: detail}), which the card says (reloadReason)
   */
  #showReloaded(browser, { clickLost = false, evidence = null } = {}) {
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser);
    if (!tab || !browser.isConnected) {
      return;
    }
    this.#reloadedDocs.set(browser, currentDoc(browser));
    showNotice(tab, RELOADED_NOTICE, reloadedCard({ clickLost, evidence }, { dismiss: () => this.#reloadedDocs.delete(browser) }));
    this.#announceCard(tab, RELOADED_NOTICE);
  }

  /**
   * The user's own input changed a password, card or code field in a page
   * of a task while no agent call ran there (zen-input's onSecretTyped,
   * once per document; autofill counts). Resume agent clears such fields,
   * so from now until the agent runs again, the hold's card says to submit
   * first.
   *
   * @param {{browser: Element}} event
   */
  secretTyped({ browser } = {}) {
    const rec = browser ? this.service.controlOf(browser)?.space : null;
    if (!rec || rec.gone || rec.ownership === "user") {
      return;
    }
    const ui = this.#ui(rec.id);
    if (ui.secretTyped) {
      return;
    }
    ui.secretTyped = true;
    if (rec.ownership === "agentDelegatedToUser" && ui.noticeTab && noticeElement(ui.noticeTab, CONTROL_NOTICE)) {
      this.#showControlNotice(rec, ui.noticeTab, ui.source);
    }
    // A panel row's Resume clears them too: its line comes now.
    this.#refreshTasks();
  }

  /**
   * The Resume line under a panel row's Resume (the panel's Pause) or Resume
   * agent (the user's hold), which clear password, card and code fields as
   * the hold card's does: just in time, as there, or always when zen-input
   * can't say. Null when the row has neither button.
   *
   * @param {object} rec
   * @returns {string|null}
   */
  #panelClears(rec) {
    const held = rec.ownership !== "agent";
    if (!held && !this.#userPaused.has(rec.id)) {
      return null;
    }
    if (held && this.#ui(rec.id).secretStep) {
      return PANEL_SECRET_LINE;
    }
    if (!this.#ui(rec.id).secretTyped && this.secretLineJustInTime) {
      return null;
    }
    return clearsLine(held ? "Resume agent" : "Resume");
  }

  /**
   * The user takes the task over: the prompt's Take over, its countdown after
   * typing, or the panel's Take over. zen-core's userTakeOver holds the page,
   * checks it, and reloads it first when the agent's code could see what the
   * user types there, with its fields filled back and the focus where it was;
   * then the hold begins. The reload is silent: the user sees the page load,
   * then the hold's card (a card keeps only what the user acts on). Meanwhile
   * the agent stays paused. A page the agent made is held as it is: its card
   * says it might contain malicious code. If the reload fails, zen-core leaves
   * the task the agent's: today's prompt comes back, the agent paused under
   * it, and its Take over tries again.
   *
   * @param {object} rec
   * @param {Element|null} browser  the page the user is taking over
   */
  async #takeOver(rec, browser) {
    if (rec.ownership !== "agent" || this.#takingOver.has(rec.id)) {
      return;
    }
    const take = this.service.userTakeOver;
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser) ?? null;
    if (typeof take !== "function" || !tab) {
      // Without zen-core's: the hold begins at once, as before.
      this.service.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
      return;
    }
    this.#takingOver.add(rec.id);
    this.service.spaces.setPaused(rec, true);
    // The prompt's countdown is moot now.
    this.takeover.resolve(rec.id, "cancel");
    this.#ui(rec.id).currentTab = tab;
    let refusal = null;
    let held = null;
    try {
      held = await take.call(this.service, rec, browser);
    } catch (e) {
      refusal = takeOverRefusal(e);
      console.error("[zenius] the Take over couldn't begin", e);
    } finally {
      this.#takingOver.delete(rec.id);
    }
    const now = this.#peek(rec.id);
    if (!now || now.gone) {
      return;
    }
    if (now.ownership === "agentDelegatedToUser") {
      this.service.spaces.setPaused(now, false);
      // What zen-core loaded afresh for the hold: the page taken over (how),
      // and every page in reloaded, by label (holdForUser's), such as a form
      // page that a popup the agent acted in last could reach. Each says so,
      // and why: holdForUser's evidence, by label (#showReloaded).
      const shown = new Set();
      const show = (b, evidence) => {
        if (b && !shown.has(b)) {
          shown.add(b);
          this.#showReloaded(b, { evidence });
        }
      };
      if (held?.how) {
        let label = null;
        try {
          label = this.service.controlOf?.(browser)?.page?.label ?? null;
        } catch {}
        show(browser, label ? held.evidence?.[label] : null);
      }
      for (const page of held?.reloaded ?? []) {
        show(this.#pageBrowser(now, page), typeof page === "string" ? held.evidence?.[page] : null);
      }
      return;
    }
    // zen-core released the hold, and zen-input keeps the user's typing out
    // of the old page until a new document commits. The page says why, and
    // offers what still works (from zen-core's reasons): the agent stays
    // paused until the user picks, so nothing loops.
    if (refusal && now.ownership === "agent" && tab.isConnected) {
      this.#showTakeOverRefused(now, tab, refusal);
      return;
    }
    this.takeover.host.setPaused(now, false);
  }

  /**
   * The <browser> of a task's page: `page` is its label (zen-core's), or
   * the <browser> itself. Null once it's gone.
   *
   * @param {object} rec
   * @param {string|Element} page
   * @returns {Element|null}
   */
  #pageBrowser(rec, page) {
    if (typeof page !== "string") {
      return page?.browsingContext ? page : null;
    }
    try {
      const record = this.service.pages?.peek?.(rec.id, page);
      return (record && this.service.pages.tabFor(record)?.linkedBrowser) ?? null;
    } catch (e) {
      console.error("[zenius] couldn't find a reloaded page", e);
      return null;
    }
  }

  /**
   * The user's Take over couldn't begin: the card on its page says why, in a
   * line, with what still works (takeOverRefusedCard). It takes no focus,
   * and goes after a button, when the task ends or changes hands, or with
   * its tab.
   *
   * @param {object} rec
   * @param {Element} tab
   * @param {{reason: string, offSite: boolean}} refusal
   */
  #showTakeOverRefused(rec, tab, refusal) {
    const ui = this.#ui(rec.id);
    ui.refusedTab = tab;
    const done = () => {
      if (ui.refusedTab === tab) {
        ui.refusedTab = null;
        this.#refreshBadge(this.#peek(rec.id));
      }
    };
    showNotice(
      tab,
      TAKEOVER_REFUSED_NOTICE,
      takeOverRefusedCard(refusal, {
        retry: () => {
          done();
          this.#withRec(rec.id, r => this.#takeOver(r, tab.linkedBrowser));
        },
        stop: () => {
          done();
          this.#withRec(rec.id, r => this.stopByUser(r));
        },
        resume: () => {
          done();
          this.#withRec(rec.id, r => this.resumeByUser(r));
        },
      })
    );
    this.#announceCard(tab, TAKEOVER_REFUSED_NOTICE);
    // The task needs them meanwhile: its badge, the strip, the directory.
    this.#refreshBadge(rec);
  }

  /** The refused Take over's card goes: its task ended or changed hands. */
  #endTakeOverRefused(ui) {
    if (ui?.refusedTab) {
      removeNotice(ui.refusedTab, TAKEOVER_REFUSED_NOTICE, { refocus: false });
      ui.refusedTab = null;
    }
  }

  /**
   * The handed page showed a new top document while the user holds the
   * task: its card follows it, with the site the user is on now (a sign-in
   * may move it to another site on its own) and its line (a page the agent
   * made, or not).
   *
   * @param {Element} browser
   */
  #onHandedPageLocation(browser) {
    for (const [id, ui] of this.#spaces) {
      if (ui.noticeTab?.linkedBrowser !== browser || !noticeElement(ui.noticeTab, CONTROL_NOTICE)) {
        continue;
      }
      const rec = this.#peek(id);
      if (rec?.ownership === "agentDelegatedToUser") {
        this.#showControlNotice(rec, ui.noticeTab, ui.source);
      }
    }
  }

  /**
   * zen-observe's agentCodeOnSite(rec, site): whether the agent ran its own
   * code in a document of the task that's open now on that site. Tests set
   * a stand-in; null restores the real one. Without it, no pill warns.
   *
   * @type {((rec: object, site: nsIPrincipal) => boolean)|null}
   */
  get agentCodeOnSite() {
    if (this.#agentCode === undefined) {
      try {
        this.#agentCode =
          ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs").agentCodeOnSite ??
          null;
      } catch {
        this.#agentCode = null;
      }
    }
    return this.#agentCode;
  }

  set agentCodeOnSite(fn) {
    this.#agentCode = typeof fn === "function" ? fn : undefined;
  }

  /**
   * zen-observe's agentCodeInPage(rec, browser): whether the page in
   * `browser`, its top document or any frame, shows a site where the task's
   * agent ran its code at any time in the task. Tests set a stand-in; null
   * restores the real one. Without it, no pill warns.
   *
   * @type {((rec: object, browser: Element) => boolean)|null}
   */
  get agentCodeInPage() {
    if (this.#agentCodeInPage === undefined) {
      try {
        this.#agentCodeInPage =
          ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs").agentCodeInPage ??
          null;
      } catch {
        this.#agentCodeInPage = null;
      }
    }
    return this.#agentCodeInPage;
  }

  set agentCodeInPage(fn) {
    this.#agentCodeInPage = typeof fn === "function" ? fn : undefined;
  }

  /**
   * zen-observe's agentMadePage(rec, browser): whether the page's top
   * document is one the agent may have made itself, not one a website
   * served: about:blank, data: or blob:, with no site behind it or on a
   * site where the agent ran its code. Tests set a stand-in; null restores
   * the real one. Without it, no page counts as the agent's own.
   *
   * @type {((rec: object, browser: Element) => boolean)|null}
   */
  get agentMadePage() {
    if (this.#agentMadePage === undefined) {
      try {
        this.#agentMadePage =
          ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs").agentMadePage ??
          null;
      } catch {
        this.#agentMadePage = null;
      }
    }
    return this.#agentMadePage;
  }

  set agentMadePage(fn) {
    this.#agentMadePage = typeof fn === "function" ? fn : undefined;
  }

  /**
   * zen-observe's evidenceOf(target) (observe/evidence.sys.mjs): the
   * evidence of phishing or danger in the page's current top document and
   * its frames, as {reason: detail}. The reasons are hooked (the agent's
   * code left something there that can still act), made (the agent made the
   * page), listed (Safe Browsing's lists) and flagged (the agent flagged
   * it); a detail is one line or "". Empty without any, and a reload or a
   * new load starts clean. Tests set a stand-in; null restores the real one.
   *
   * @type {((target: Element|BrowsingContext|WindowGlobalParent) => Object<string, string>)|null}
   */
  get evidenceOf() {
    if (this.#evidenceOf === undefined) {
      try {
        this.#evidenceOf = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs").evidenceOf ?? null;
      } catch {
        this.#evidenceOf = null;
      }
    }
    return this.#evidenceOf;
  }

  set evidenceOf(fn) {
    this.#evidenceOf = typeof fn === "function" ? fn : undefined;
  }

  /**
   * The evidence about `browser`'s page, {reason: detail}, empty without
   * any. The defenses of zen-ux's that interrupt the user or the agent act
   * only on evidence. Without zen-observe's evidenceOf, or when it fails,
   * the page counts as evident (unknown), so they act as they did before
   * rather than not at all.
   *
   * @param {Element} browser
   * @returns {Object<string, string>}
   */
  #evidence(browser) {
    try {
      const of = this.evidenceOf;
      return typeof of === "function" ? (of(browser) ?? {}) : { unknown: "" };
    } catch (e) {
      console.error("[zenius] evidenceOf failed", e);
      return { unknown: "" };
    }
  }

  /**
   * Is there evidence of danger in `browser`'s page (#evidence), of any
   * kind? Permission prompts there are cancelled (#deniesPrompt), as
   * zen-observe's backstops are: nothing reloads for that.
   */
  #evident(browser) {
    return Object.keys(this.#evidence(browser)).length > 0;
  }

  /**
   * Is there evidence in `browser`'s page that a clean copy clears
   * (CLEANABLE): the agent's code or its own page? What reloads keys on
   * these alone: on a page on a list, or that the agent flagged, the danger
   * is the page itself, which a clean copy can't remove (a listed copy is
   * marked again, a flagged one loses its flag). Such a page gets its
   * warning instead (#updatePageWarning).
   */
  #cleanable(browser) {
    const evidence = this.#evidence(browser);
    return CLEANABLE.some(reason => Object.hasOwn(evidence, reason));
  }

  /**
   * Is the user on `browser`'s page, rather than an agent driving it: in
   * the user's hold, with the agent paused, after the task, or in a page no
   * task has?
   */
  #userOn(browser) {
    let rec = null;
    try {
      rec = this.service.controlOf?.(browser)?.space ?? null;
    } catch {}
    return !rec || rec.gone || rec.ownership !== "agent" || !!rec.paused;
  }

  /**
   * zen-observe's onEvident: a document in `browser`'s page gained a
   * reason (once per document and reason). A list's mark or the agent's
   * flag brings the page's warning, if the user is on it.
   *
   * @param {{browser?: Element, innerWindowId?: number, reason?: string, detail?: string}} [event]
   *   browser: the tab's top <browser>; innerWindowId: the document, which
   *   can be a frame's
   */
  evidenceAdded({ browser, reason } = {}) {
    if ((reason === "listed" || reason === "flagged") && browser?.localName === "browser") {
      this.#updatePageWarning(browser);
    }
  }

  /**
   * The warning on `browser`'s page while the user is on it (#userOn), when
   * the page is on a phishing or malware list or the agent flagged it: such
   * a page gets no hold and no clean copy, only this (pageWarningCard). It
   * only informs: no choice but its ✕, which keeps it away for that
   * document, and no focus. A screen reader hears it as it comes up, if the
   * tab is in view. It goes as the agent drives the page again, and with
   * the document.
   *
   * @param {Element} browser
   */
  #updatePageWarning(browser) {
    const tab = browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser);
    if (!tab) {
      return;
    }
    const doc = currentDoc(browser);
    const bid = browser.browserId;
    if (this.#warningDismissed.has(bid) && this.#warningDismissed.get(bid) !== doc) {
      this.#warningDismissed.delete(bid);
    }
    const card =
      doc && browser.isConnected && !this.#warningDismissed.has(bid) && this.#userOn(browser)
        ? pageWarningCard(this.#evidence(browser), { dismiss: () => this.#warningDismissed.set(bid, doc) })
        : null;
    if (!card) {
      removeNotice(tab, PAGE_WARNING_NOTICE, { refocus: false });
      return;
    }
    const was = noticeText(tab, PAGE_WARNING_NOTICE);
    showNotice(tab, PAGE_WARNING_NOTICE, card);
    if (noticeText(tab, PAGE_WARNING_NOTICE) !== was) {
      this.#announceCard(tab, PAGE_WARNING_NOTICE);
    }
  }

  /**
   * Should the card of a page the agent made say so ("The agent made this
   * page. It might contain malicious code…")? Only when the page asks for a
   * password, a card's details or a one-time code, or the agent flagged it.
   * The frames answer asynchronously: until they have, this says no, and
   * `learned` runs once the answer is yes. A no is asked again after
   * MADE_RECHECK_MS, as a page can add a field.
   *
   * @param {Element} browser
   * @param {() => void} [learned]
   * @returns {boolean}
   */
  #madeWarns(browser, learned) {
    if ("flagged" in this.#evidence(browser)) {
      return true;
    }
    const doc = currentDoc(browser);
    const known = this.#madeWarned.get(browser);
    if (known?.doc === doc && (known.value === true || (known.value === false && Date.now() - known.at < MADE_RECHECK_MS))) {
      return known.value;
    }
    if (known?.doc === doc && known.value instanceof Promise) {
      return false;
    }
    const asking = this.#asksSecrets(browser).then(value => {
      if (this.#madeWarned.get(browser)?.value === asking) {
        this.#madeWarned.set(browser, { doc, value, at: Date.now() });
        if (value && currentDoc(browser) === doc) {
          learned?.();
        }
      }
      return value;
    });
    this.#madeWarned.set(browser, { doc, value: asking, at: Date.now() });
    return false;
  }

  /**
   * Does `browser`'s page ask for a password, a card's details or a
   * one-time code in any of its frames (content/uipage.sys.mjs)? No when
   * no frame can say.
   *
   * @param {Element} browser
   * @returns {Promise<boolean>}
   */
  async #asksSecrets(browser) {
    const top = browser?.browsingContext;
    if (!top) {
      return false;
    }
    const answers = await Promise.all(
      top.getAllBrowsingContextsInSubtree().map(bc =>
        this.service.content(bc, "uipage#secretKinds", {}, { timeout: SECRET_KINDS_MS }).catch(() => null)
      )
    );
    return answers.some(kinds => Array.isArray(kinds) && kinds.length > 0);
  }

  /** agentMadePage's answer; false if it fails. */
  #madeByAgent(rec, browser) {
    try {
      return !!browser && !!this.agentMadePage?.(rec, browser);
    } catch (e) {
      console.error("[zenius] agentMadePage failed", e);
      return false;
    }
  }

  /**
   * Did the agent run its code on a site the page in `browser` shows?
   * agentCodeInPage decides. If so, the site to name: the first document's
   * that agentCodeOnSite matches, the top's before its frames', and "" if
   * it has no name (a data: page's). Else null.
   *
   * @returns {string|null}
   */
  #agentCodeSite(rec, browser) {
    try {
      if (!browser || !this.agentCodeInPage?.(rec, browser)) {
        return null;
      }
    } catch (e) {
      console.error("[zenius] agentCodeInPage failed", e);
      return null;
    }
    let contexts = [];
    try {
      contexts = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    } catch {}
    for (const bc of contexts) {
      const principal = bc.currentWindowGlobal?.documentPrincipal;
      try {
        if (principal && this.agentCodeOnSite?.(rec, principal)) {
          return principalSite(principal);
        }
      } catch (e) {
        console.error("[zenius] agentCodeOnSite failed", e);
      }
    }
    return "";
  }

  /**
   * The user hands the task back: Resume agent, on the pill or in the panel.
   * The agent's calls stay refused until the ownership changes, so the
   * reload of what holds a secret the user typed finishes first.
   */
  #handBack(rec) {
    return this.#beforeAgentRuns(
      rec,
      now => {
        if (now.ownership === "agentDelegatedToUser") {
          this.service.spaces.setOwnership(now, "agent", { source: "user" });
        }
      },
      { handBack: true }
    );
  }

  /**
   * Before the agent gets a task back from the user's hold: a page with
   * evidence a clean copy clears (#cleanable) that still holds a password, card
   * number or code the user typed and didn't send loads afresh, so no code the
   * agent left there keeps it (on evidence only, and a list's mark or the
   * agent's flag aren't such).
   * zen-input's hand-back guard empties those fields in every page all the
   * same. zen-input's typedSecrets names the pages whose document the user
   * typed one into; zen-core's cleanLoad reloads each quietly (a new GET entry
   * in the current one's place); zen-core notes which reloaded, for the hand
   * back's report (noteReloaded). zen-input's hand-back guard then empties the
   * secret fields left.
   *
   * Resume agent runs it, and so does zen-core's spaces.takeOver, the
   * agent's own way back after the user goes quiet.
   *
   * @param {object} rec
   * @returns {Promise<Element[]>} the pages it reloaded
   */
  async beforeHandBack(rec) {
    // zen-core's glue: a secret step's tab goes blank first (its blankSecretSteps).
    try {
      await this.service?.blankSecretSteps?.(rec);
    } catch (e) {
      console.error("[zenius] blankSecretSteps failed", e);
    }
    const reloaded = await this.#reloadTyped(rec);
    if (reloaded.length) {
      try {
        this.service?.noteReloaded?.(rec, reloaded);
      } catch (e) {
        console.error("[zenius] noteReloaded failed", e);
      }
    }
    return reloaded;
  }

  /** The pages of `rec` where the user typed a secret, reloaded quietly; those that did. */
  async #reloadTyped(rec) {
    if (!quietLoadsOn()) {
      return [];
    }
    let pages = [];
    try {
      let timer = 0;
      const late = new Promise(resolve => {
        timer = lazy.setTimeout(() => resolve(null), TYPED_SECRETS_MS);
      });
      pages = (await Promise.race([this.typedSecrets?.(this.service, rec), late])) ?? [];
      lazy.clearTimeout(timer);
    } catch (e) {
      console.error("[zenius] typedSecrets failed", e);
    }
    pages = pages.filter(browser => this.#cleanable(browser));
    const done = await Promise.all(pages.map(browser => this.#cleanLoad(browser)));
    return pages.filter((_, i) => done[i]);
  }

  /**
   * Before the agent runs a task again (Resume agent, the panel's Resume,
   * the takeover prompt's): the reload of typed secrets first, then `run`
   * with the task's record, if it's still there. A later press wins over
   * one still waiting. A hand back also tells zen-core what reloaded. With
   * zen-core's quiet loads off (a test's switch), `run` comes at once.
   *
   * @param {object} rec
   * @param {(rec: object) => void} run
   * @param {{handBack?: boolean}} [how]
   */
  #beforeAgentRuns(rec, run, { handBack = false } = {}) {
    const ui = this.#ui(rec.id);
    const token = ++ui.resumeToken;
    const go = () => {
      const now = this.#peek(rec.id);
      if (ui.resumeToken === token && now && !now.gone) {
        const had = ui.secretTyped;
        ui.secretTyped = false;
        run(now);
        if (had) {
          this.#refreshTasks();
        }
      }
    };
    if (!quietLoadsOn()) {
      // Nothing to reload: the agent runs before the press returns, so
      // zen-input's clear reaches each frame ahead of anything else.
      go();
      return Promise.resolve();
    }
    return (handBack ? this.beforeHandBack(rec) : this.#reloadTyped(rec)).then(go);
  }

  /** zen-core's cleanLoad, quietly: whether the page loaded afresh. */
  async #cleanLoad(browser) {
    try {
      await this.cleanLoad(browser);
      return true;
    } catch (e) {
      console.error("[zenius] cleanLoad failed", e);
      return false;
    }
  }

  /**
   * zen-core's service.cleanLoad(browser): the page loads afresh with
   * nothing of the agent's code (a new GET entry in the current one's
   * place), its visible ordinary fields and focus carried over, the user's
   * typing held back meanwhile; it rejects when no new document came. Tests
   * set a stand-in; null restores the real one.
   *
   * @type {(browser: Element) => Promise<object>}
   */
  get cleanLoad() {
    return (
      this.#cleanLoadFn ??
      (browser =>
        typeof this.service?.cleanLoad === "function"
          ? this.service.cleanLoad(browser)
          : Promise.reject(new Error("zen-core's cleanLoad isn't there")))
    );
  }

  set cleanLoad(fn) {
    this.#cleanLoadFn = typeof fn === "function" ? fn : null;
  }

  /**
   * zen-input's typedSecrets(service, rec) (input/handback.sys.mjs): the
   * <browser> of each page of the task whose current document holds a
   * secret the user typed during the hold. Tests set a stand-in; null
   * restores the real one, and without it nothing reloads.
   *
   * @type {((service: object, rec: object) => Promise<Element[]>)|null}
   */
  get typedSecrets() {
    if (this.#typedSecretsFn === undefined) {
      try {
        this.#typedSecretsFn =
          ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/handback.sys.mjs").typedSecrets ?? null;
      } catch {
        this.#typedSecretsFn = null;
      }
    }
    return this.#typedSecretsFn;
  }

  set typedSecrets(fn) {
    this.#typedSecretsFn = typeof fn === "function" ? fn : undefined;
  }

  /**
   * zen-observe refused a load the user started to the local network, in a
   * task's tab (the user's hold included) or in a kept page with the
   * agent's writes (observe/localnet.sys.mjs, onUserLoadRefused). In a
   * task's tab, the tab says why and offers the ways out; the card goes
   * with the tab's next document. A kept page, refused only a load it
   * chose, loads afresh quietly when the user's own click or key there came
   * just before, so their next try goes through.
   * Nothing takes focus or moves a view (I1).
   *
   * @param {{browser: Element, url: string, origin: string, reason: string, typed: boolean, scope?: "task"|"agentCode", evident?: boolean}} event
   *   typed: the user chose the URL; else the page did, and only its site's
   *   home page is offered. scope: why zen-observe refused it, a task's tab
   *   (or a popup of one) or a page with the agent's code or writes
   */
  userLoadRefused({ browser, url, origin, typed, scope, evident } = {}) {
    const win = browser?.ownerDocument?.defaultView;
    const tab = win?.gBrowser?.getTabForBrowser(browser);
    let target = null;
    try {
      target = typed ? Services.io.newURI(url) : Services.io.newURI(`${Services.io.newURI(origin).prePath}/`);
    } catch {}
    if (!tab || !target?.host) {
      return;
    }
    // Without zen-observe's scope, a tab is a task's while an agent holds its
    // Space: one the user stopped is theirs, refused only for the agent's code.
    const hit = this.service.controlOf(browser);
    const inTask = scope ? scope === "task" : !!hit && !!this.service.spaces.isAgentTask?.(hit.space);
    if (!inTask) {
      if (this.#userActed(browser) && this.#cleanablePage(browser, evident)) {
        this.#reloadCleanable(browser);
      }
      return;
    }
    const card = localNetCard(
      { host: target.host, typed: !!typed },
      {
        own: () => this.#openLocalOwnTab(tab, target),
        allow: typed ? event => this.#allowLocal(tab, target, event) : null,
      }
    );
    showNotice(tab, LOCALNET_NOTICE, card);
    if (win === Services.wm.getMostRecentWindow("navigator:browser") && isTabVisible(tab)) {
      this.#announce(`${card.title}: ${card.detail}. ${[card.note, card.more].filter(Boolean).join(" ")}`, win);
    }
  }

  /**
   * "Open it yourself", from the local-network notice: the address the user
   * typed, or the home page of the site the page chose, in a new tab no
   * agent can use (I2): in the user's own Space, selected (they asked), in
   * the agent tab's container, with no opener.
   */
  async #openLocalOwnTab(from, uri) {
    const win = from.ownerDocument?.defaultView;
    const uuid = this.#userWorkspace(win);
    if (!win || !uuid) {
      return;
    }
    const userContextId = from.userContextId ?? 0;
    const tab = addBackgroundTab(win, uuid, { userContextId });
    if (!this.service.pages.markUserOwn?.(tab)) {
      win.gBrowser.removeTab(tab, { animate: false });
      console.error("[zenius] a tab of the user's own couldn't be marked; not opened");
      return;
    }
    tab.linkedBrowser.loadURI(uri, {
      triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId }),
    });
    await this.#showTab(win, tab);
  }

  /**
   * "Add to allowlist", from the local-network notice, for an address the
   * user typed (the write is zen-ux's): that exact host goes at the end of
   * zen-observe's list (ALLOW_PREF), then the address loads in this tab.
   * From then on every agent tab may reach that host, until the user
   * removes it in about:config.
   *
   * Only the user's own click writes it: a trusted click on that button,
   * in this tab's card. The card is chrome, which page code can't reach,
   * and the agent's synthesized clicks and keys never leave its content.
   * zenius writes the list nowhere else.
   *
   * @param {Element} tab  the agent's tab the card is on
   * @param {nsIURI} uri  the address the user typed
   * @param {Event} event  the button's click
   */
  #allowLocal(tab, uri, event) {
    const button = event?.target?.closest?.(".zenius-card-button");
    if (!event?.isTrusted || event.type !== "click" || !button || !noticeElement(tab, LOCALNET_NOTICE)?.contains(button)) {
      console.error("[zenius] Add to allowlist: not the user's click on its button; nothing written");
      return;
    }
    let host = "";
    try {
      host = uri.host.toLowerCase();
    } catch {}
    // As nsIURI.host gives it: an IPv6 address without brackets. One exact
    // host: never a range, nor anything that splits the list.
    if (!host || /[\s,/[\]]/.test(host)) {
      console.error("[zenius] Add to allowlist: no host to add; nothing written");
      return;
    }
    const list = Services.prefs.getStringPref(ALLOW_PREF, "");
    const same = entry => entry.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") === host.replace(/\.$/, "");
    if (!list.split(",").some(same)) {
      Services.prefs.setStringPref(ALLOW_PREF, list.trim() ? `${list}, ${host}` : host);
    }
    const browser = tab.linkedBrowser;
    if (tab.isConnected && browser) {
      browser.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: tab.userContextId ?? 0 }),
      });
    }
  }

  async #showTab(win, tab) {
    win.focus();
    const uuid = tab.getAttribute("zen-workspace-id");
    if (uuid && win.gZenWorkspaces.activeWorkspace !== uuid) {
      // The Space opens on this tab, not on its last one first (as
      // openSpace).
      landOn(tab);
      await win.gZenWorkspaces.changeWorkspaceWithID(uuid);
    }
    if (tab.isConnected && !tab.closing && win.gBrowser.selectedTab !== tab) {
      win.gBrowser.selectedTab = tab;
    }
  }

  /**
   * zen-core's claim gate: an agent claims a user's Space or an ended task,
   * and the user allows or denies it. The prompt goes on the selected tab
   * of every window and moves with the selection, but takes no focus and
   * selects nothing. Its buttons are chrome, which only real clicks reach,
   * and they arm after 400 ms. It goes when answered, when zen-core settles
   * the ask (a timeout, the client gone), or a second past its time.
   *
   * @param {{id: string, space: number, name: string, client: string, until: number}} ask
   */
  #onClaimAsked(ask) {
    if (
      !ask ||
      typeof ask.id !== "string" ||
      !ask.id ||
      ask.id.length > 200 ||
      typeof ask.space !== "number" ||
      !Number.isFinite(ask.until)
    ) {
      return;
    }
    this.#onClaimSettled(ask.id);
    const claim = {
      id: ask.id,
      space: ask.space,
      name: plainText(ask.name, 60),
      client: plainText(ask.client, 40),
      until: ask.until,
      tabs: new Set(),
      timer: lazy.setTimeout(() => this.#onClaimSettled(ask.id), Math.max(0, ask.until - Date.now()) + 1000),
    };
    this.#claims.set(claim.id, claim);
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.gBrowser) {
        this.#showClaim(claim, win.gBrowser.selectedTab);
      }
    }
    const { title, note } = claimCard(claim.client, claim.name, claim.until);
    this.#announce(`${title}. ${note}`);
    this.#notify(`zenius-claim-${claim.id}`, title, note, () =>
      Services.wm.getMostRecentWindow("navigator:browser")?.focus()
    );
  }

  #showClaim(claim, tab) {
    if (!tab || tab.closing || claim.tabs.has(tab)) {
      return;
    }
    const card = claimCard(claim.client, claim.name, claim.until, {
      allow: () => this.#answerClaim(claim.id, true),
      deny: () => this.#answerClaim(claim.id, false),
    });
    if (showNotice(tab, CLAIM_NOTICE + claim.id, card)) {
      claim.tabs.add(tab);
    }
  }

  #moveClaims(from, to) {
    for (const claim of this.#claims.values()) {
      if (from && from !== to && claim.tabs.delete(from)) {
        removeNotice(from, CLAIM_NOTICE + claim.id);
      }
      this.#showClaim(claim, to);
    }
  }

  #answerClaim(id, allow) {
    if (!this.#claims.has(id)) {
      return;
    }
    try {
      this.service.spaces.answerClaim(id, allow);
    } catch (e) {
      console.error("[zenius] answering a claim failed", e);
    }
    // Answered: every window's prompt goes, before zen-core's claimSettled.
    this.#onClaimSettled(id);
  }

  #onClaimSettled(id) {
    const claim = this.#claims.get(id);
    if (!claim) {
      return;
    }
    this.#claims.delete(id);
    lazy.clearTimeout(claim.timer);
    for (const tab of claim.tabs) {
      removeNotice(tab, CLAIM_NOTICE + id);
    }
    // A notification left behind would offer an ask that's gone.
    this.#closeNotification(`zenius-claim-${id}`);
  }

  /** A tab closed in one window. */
  #onTabClose(tab) {
    const tasks = new Set();
    for (const k of this.#keptCode.values()) {
      if (sameTab(k.tab, tab)) {
        tasks.add(k.task);
      }
    }
    if (tasks.size) {
      // Once Zen has closed its other copies.
      lazy.setTimeout(() => this.#afterTabClose(tasks), 0);
    }
  }

  /**
   * Forget the pages closed in every window, kept or not (a waiting close
   * the user left), so no tab is held; the kept ones' tasks recount.
   */
  #afterTabClose(tasks) {
    for (const [bid, k] of this.#keptCode) {
      if (!liveCopy(k.tab, bid)) {
        this.#keptCode.delete(bid);
      }
    }
    for (const task of tasks) {
      this.#renderKept(task);
    }
  }

  /**
   * zen-core's pageMoved: window sync moved a page's docShell to another
   * window's copy of its tab, the one the user selected. The cursor, the
   * takeover prompt and the pill go with it. The pill is drawn again there,
   * so its buttons act in that window; the focus stays where it was.
   */
  #onPageMoved({ space, from, to } = {}) {
    if (!from || !to || from === to) {
      return;
    }
    if (this.#cursorTask.has(from)) {
      this.#cursorTask.set(to, this.#cursorTask.get(from));
    }
    moveCursorTab(from, to);
    this.takeover.movePage(from, to);
    const ui = this.#spaces.get(space);
    if (!ui) {
      return;
    }
    if (ui.currentTab && sameTab(ui.currentTab, from)) {
      ui.currentTab = to;
    }
    if (ui.noticeTab && sameTab(ui.noticeTab, from)) {
      removeNotice(ui.noticeTab, CONTROL_NOTICE, { refocus: false });
      ui.noticeTab = to;
      const rec = this.#peek(space);
      if (rec?.ownership === "agentDelegatedToUser") {
        this.#showControlNotice(rec, to, ui.source);
      }
    }
    if (noticeElement(from, JOINED_NOTICE)) {
      removeNotice(from, JOINED_NOTICE, { refocus: false });
      const rec = this.#peek(space);
      if (rec?.ownership === "agentDelegatedToUser") {
        this.#renderJoined(rec);
      }
    }
  }

  /**
   * zen-core's popup event: a tab opened from a page of the task joined it
   * (adoptPopup). During the user's hold, they opened it themselves, from
   * the agent's page, with an opener: their link or the site's window.open,
   * or any link at all once code the agent planted catches it. It's the
   * agent's: its tab carries the task's tag from the start (zen-core tags
   * it in the same call), and a card says so, with a tab of the user's own
   * for logging in. A screen reader hears it once the tab is in view: a
   * link opens its tab, then selects it.
   */
  #onJoinedTab(rec, { page } = {}) {
    if (rec.ownership !== "agentDelegatedToUser" || typeof page !== "string") {
      return;
    }
    const tab = this.#joinedTab(rec, page);
    if (!tab) {
      return;
    }
    this.#ui(rec.id).joined.set(page, tab);
    this.#showJoinedNotice(rec, tab);
    lazy.setTimeout(() => {
      const now = this.#joinedTab(rec, page);
      if (now && this.#peek(rec.id)?.ownership === "agentDelegatedToUser") {
        this.#announceCard(now, JOINED_NOTICE);
      }
    }, JOINED_ANNOUNCE_MS);
  }

  /** The live tab of a page that joined the task, or null once it's gone. */
  #joinedTab(rec, label) {
    try {
      return this.service.pages.tabFor(this.service.pages.get(rec, label));
    } catch {
      return null;
    }
  }

  /** The joined page's card. */
  #showJoinedNotice(rec, tab) {
    showNotice(tab, JOINED_NOTICE, joinedCard(rec.name ?? "", { resume: () => this.#handBack(rec) }));
  }

  /** Draw the cards of the pages that joined the task during this hold again. */
  #renderJoined(rec) {
    const ui = this.#spaces.get(rec.id);
    for (const label of ui?.joined.keys() ?? []) {
      const tab = this.#joinedTab(rec, label);
      if (tab) {
        ui.joined.set(label, tab);
        this.#showJoinedNotice(rec, tab);
      }
    }
  }

  /** The hold ended: the joined pages are the agent's to drive, and their cards go. */
  #endJoined(rec, ui) {
    for (const [label, was] of ui.joined ?? []) {
      // A finished task's pages may be gone from its table: the copy kept
      // finds the tab then.
      const tab = this.#joinedTab(rec, label) ?? liveCopy(was) ?? was;
      for (const copy of new Set([tab, ...copiesOf(tab)])) {
        removeNotice(copy, JOINED_NOTICE, { refocus: copy === tab });
      }
    }
    ui.joined?.clear();
  }

  /**
   * Window sync moved a docShell between two copies of `tab` (Zen's swap).
   * zen-core's pageMoved covers a page's; this moves what zen-ux shows on
   * a tab that isn't a page: the user's own tab's notice, and the pill of a
   * close that waits for the user to leave the tab. A page's warning goes
   * with its document, whoever's tab it is.
   */
  #onDocShellMoved(tab) {
    if (!tab) {
      return;
    }
    const live = liveCopy(tab);
    for (const copy of copiesOf(tab)) {
      if (live && copy !== live) {
        if (this.service.pages.isDeferred?.(tab)) {
          moveNotice(copy, live, CLOSING_NOTICE);
        }
        moveNotice(copy, live, PAGE_WARNING_NOTICE);
      }
    }
    for (const k of this.#keptCode.values()) {
      if (k.kept && sameTab(k.tab, tab)) {
        this.#renderKept(k.task);
      }
    }
  }

  #noteUserWorkspace(win, uuid) {
    if (uuid && this.service && !this.#agentHolds(uuid)) {
      this.#userWorkspaces.set(win, uuid);
    }
  }

  /**
   * The user's own Space in `win`: the last one they were in, else Zen's
   * first, that no agent holds. Null if every Space is an agent's.
   */
  #userWorkspace(win) {
    const all = win?.gZenWorkspaces?.getWorkspaces?.() ?? [];
    const last = this.#userWorkspaces.get(win);
    if (last && all.some(ws => ws.uuid === last) && !this.#agentHolds(last)) {
      return last;
    }
    return all.find(ws => !this.#agentHolds(ws.uuid))?.uuid ?? null;
  }

  /**
   * The Agents Space, or a Space an agent holds now: its task's, or one it
   * claimed. Every Zen Space has a record; the user's say "user".
   */
  #agentHolds(uuid) {
    const { spaces } = this.service;
    return (
      !!spaces.isAgentsSpace?.(uuid) ||
      (spaces.records?.() ?? []).some(rec => !rec.gone && rec.uuid === uuid && rec.ownership !== "user")
    );
  }

  /**
   * A permission prompt opened for `browser`. If it belongs to an agent page,
   * the Space goes to the user with Ego's reason key until it's answered.
   *
   * While the agent drives, that is an automatic handoff, and a page can't
   * ask at will. A handoff left unanswered is spent: the user handed back
   * before answering, or the page withdrew its request (a reload removes a
   * prompt, an abort ends a passkey call), which handed the task back and
   * let it ask anew. An origin that spent one can't hand the task over
   * again, by prompt or passkey; after 3 spent in a task, no page can. A
   * refused request gets no handoff, and the agent hears of it. Answered
   * ones (allowed, blocked, a passkey completed or cancelled in the OS
   * sheet) spend nothing, and neither the agent's own handOff() nor the
   * user's requests while they hold the task are limited.
   *
   * @param {object} [opts]
   * @param {string|null} [opts.what]  the pill's wording
   * @param {string} [opts.origin]  the requesting page's
   * @param {"permission"|"passkey"} [opts.kind]
   * @returns {boolean} false when refused
   */
  #onPermissionPrompt(win, browser, reason, id, { what = null, origin = "", kind = "permission" } = {}) {
    const tab = win.gBrowser?.getTabForBrowser(browser);
    const hit = tab && this.lookup(tab);
    if (!hit) {
      return true;
    }
    const key = `${browser.browserId}:${id}`;
    if (hit.rec.ownership === "agent") {
      const auto = this.#autoHandOffsOf(hit.rec.id);
      const why = auto.spent.has(origin) ? "site" : auto.unanswered >= MAX_UNANSWERED_HANDOFFS ? "task" : null;
      if (why) {
        reportRefused(browser, kind === "passkey" ? "passkey" : "permissionPrompt", refusedText(kind, reason, origin, why, what));
        return false;
      }
      auto.open.set(key, origin);
    }
    const ui = this.#ui(hit.rec.id);
    ui.prompts.set(key, reason);
    if (what) {
      ui.promptWhat.set(key, what);
    }
    if (hit.rec.ownership === "agent") {
      // The notice belongs next to the prompt.
      ui.currentTab = tab;
      this.service.spaces.setOwnership(hit.rec, "agentDelegatedToUser", { reason, source: "permission" });
    }
    return true;
  }

  /**
   * A prompt zenius cancels showed anyway (zen-observe's backstops cancel
   * these before any prompt): any prompt on evidence of danger in the page,
   * held or not, and the devices' while the agent drives. It goes at once,
   * and the agent hears why. The user's own tabs, and a task's that ended,
   * keep theirs.
   *
   * @returns {boolean} true to cancel it
   */
  #deniesPrompt(win, browser, id, origin) {
    const tab = win.gBrowser?.getTabForBrowser(browser);
    const hit = tab && this.lookup(tab);
    if (!hit || hit.rec.gone || hit.rec.ownership === "user") {
      return false;
    }
    const why = this.#evident(browser) ? "evidence" : isDevicePrompt(id) && hit.rec.ownership === "agent" && !hit.rec.paused ? "device" : null;
    if (!why) {
      return false;
    }
    reportRefused(browser, "promptDenied", deniedText(id, origin, why));
    return true;
  }

  #autoHandOffsOf(taskId) {
    let auto = this.#autoHandOffs.get(taskId);
    if (!auto) {
      auto = { open: new Map(), spent: new Set(), unanswered: 0 };
      this.#autoHandOffs.set(taskId, auto);
    }
    return auto;
  }

  /** An automatic handoff's request ended: answered, or left unanswered. */
  #endAutoHandOff(taskId, key, answered) {
    const auto = this.#autoHandOffs.get(taskId);
    if (!auto?.open.has(key)) {
      return;
    }
    const origin = auto.open.get(key);
    auto.open.delete(key);
    if (!answered) {
      auto.spent.add(origin);
      auto.unanswered++;
    }
  }

  /** The task went back to the agent with its pages' requests still open. */
  #leaveAutoHandOffs(taskId) {
    for (const key of [...(this.#autoHandOffs.get(taskId)?.open.keys() ?? [])]) {
      this.#endAutoHandOff(taskId, key, false);
    }
  }

  /**
   * For tests: the task's pages may hand it to the user again.
   *
   * @param {object} rec
   */
  forgetHandOffs(rec) {
    this.#autoHandOffs.delete(rec.id);
  }

  /**
   * A permission prompt was answered or went away with its page.
   *
   * @param {boolean} [answered]  false: left unanswered (withdrawn)
   */
  #onPermissionGone(win, browser, id, answered = true) {
    const key = `${browser.browserId}:${id}`;
    // Before control goes back, so the hand back below finds nothing open.
    for (const taskId of [...this.#autoHandOffs.keys()]) {
      this.#endAutoHandOff(taskId, key, answered);
    }
    for (const [spaceId, ui] of this.#spaces) {
      ui.promptWhat.delete(key);
      if (!ui.prompts.delete(key) || ui.prompts.size) {
        continue;
      }
      const rec = this.#peek(spaceId);
      // Give control back only if the prompts took it; a takeover or a
      // handOff since then stays with the user.
      if (rec?.ownership === "agentDelegatedToUser" && ui.source === "permission") {
        this.service.spaces.setOwnership(rec, "agent", { source: "permission" });
      }
    }
  }

  /**
   * A zen-ux page guard holds a request for the user (a passkey). As for a
   * permission prompt, the Space goes to the user with `reason` until
   * releaseForUser(browser, key). It then returns to the agent, unless the
   * user took it meanwhile.
   *
   * @param {Element} browser
   * @param {string} reason  Ego's reason key
   * @param {string} key     unique per request
   * @param {string} [what]  the pill's wording, as in "page asks for a passkey"
   * @param {string} [origin]  the requesting document's (see
   *   #onPermissionPrompt for what a page may ask)
   * @returns {boolean} false when refused: no hold, nothing to release
   */
  holdForUser(browser, reason, key, what, origin = "") {
    // Not ownerGlobal: zenius's module scope doesn't see it.
    const win = browser.ownerDocument?.defaultView;
    return win ? this.#onPermissionPrompt(win, browser, reason, key, { what, origin, kind: "passkey" }) : true;
  }

  /**
   * The request from holdForUser() settled or went away.
   *
   * @param {boolean} [answered]  false: the page withdrew it, or the user
   *   handed back before it ran
   */
  releaseForUser(browser, key, answered = true) {
    this.#onPermissionGone(browser.ownerDocument?.defaultView, browser, key, answered);
  }

  /**
   * An OS notification for a moment that needs the user, only with their
   * opt-in (zenius.ux.handoff.systemNotification): I1 forbids notifications
   * over the user's view by default. The alerts service neither focuses nor
   * raises a window; only the user's click on the notification does.
   *
   * @param {string} name  a notification with the same name replaces it
   * @returns {boolean}  whether it went up
   */
  #notify(name, title, text, onClick, cookie = "") {
    if (!Services.prefs.getBoolPref("zenius.ux.handoff.systemNotification", false)) {
      return false;
    }
    try {
      const alerts = this.alertsService ?? Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      const alert = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
      alert.init(name, "chrome://branding/content/icon64.png", title, text, true, cookie);
      alerts.showAlert(alert, {
        observe: (_subject, topic) => {
          if (topic === "alertclickcallback") {
            onClick();
          }
        },
      });
      return true;
    } catch (e) {
      console.error("[zenius] notification failed", e);
      return false;
    }
  }

  /**
   * The task no longer waits for the user (handed back, or ended): its
   * "needs you" notification leaves the OS's list too. Left there, it sent
   * the user to a moment that was over (six stale ones after three tasks'
   * handoffs).
   */
  #endHandOffNotification(id, ui) {
    if (ui?.notified) {
      ui.notified = false;
      this.#closeNotification(`zenius-handoff-${id}`);
    }
  }

  #closeNotification(name) {
    if (!Services.prefs.getBoolPref("zenius.ux.handoff.systemNotification", false)) {
      return;
    }
    try {
      (this.alertsService ?? Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService)).closeAlert?.(name);
    } catch (e) {
      console.error("[zenius] closing a notification failed", e);
    }
  }

  /**
   * Whether an announcement waits to go out in `win` (#announce's burst):
   * for tests, which read the announcer once it has (announcementsOut).
   *
   * @param {Window} win
   */
  announcing(win) {
    return !!this.#bursts.get(win)?.timer;
  }

  /**
   * Tell a screen reader without moving focus, through Firefox's own
   * announcer: an ARIA alert in the browser window (Firefox notes that JAWS
   * ignores aria-live in its chrome). Only for the moments that need the
   * user: Agent needs you, a permission or passkey handoff, the claim
   * prompt, and a task that finished on the tab the user is viewing. Never
   * for routine agent actions.
   *
   * The announcer keeps one label, which each announcement replaces, so
   * moments that come together (four in 27 ms under load) could leave a
   * screen reader only the last. Those within ANNOUNCE_MS of the first go
   * out as one, each in the order it came, a repeat dropped.
   *
   * A moment can pass in that time: a hold the user ended at once, or whose
   * task finished (on a Mac, one test's hold was heard in the next).
   * `still` says whether it holds as the burst goes out; one that passed
   * isn't said.
   *
   * @param {string} text
   * @param {Window} [win]  default: the browser window the user was in last
   * @param {(() => boolean)|null} [still]  default: the moment stays
   */
  #announce(text, win = Services.wm.getMostRecentWindow("navigator:browser"), still = null) {
    if (!win || !text) {
      return;
    }
    let burst = this.#bursts.get(win);
    if (!burst) {
      burst = { texts: [], timer: 0 };
      this.#bursts.set(win, burst);
    }
    // A repeat keeps its place, and the latest moment decides.
    const queued = burst.texts.find(t => t.text === text);
    if (queued) {
      queued.still = still;
    } else {
      burst.texts.push({ text, still });
    }
    if (burst.timer) {
      return;
    }
    burst.timer = lazy.setTimeout(() => {
      const holds = t => {
        try {
          return !t.still || !!t.still();
        } catch (e) {
          console.error("[zenius] an announcement's check failed", e);
          return false;
        }
      };
      const said = burst.texts
        .filter(holds)
        .map(t => t.text)
        .join(" ");
      burst.texts = [];
      burst.timer = 0;
      if (!said) {
        return;
      }
      try {
        win.A11yUtils?.announce({ raw: said });
      } catch (e) {
        console.error("[zenius] announcing failed", e);
      }
    }, ANNOUNCE_MS);
  }

  /**
   * Show the user an agent Space: a watch, as every way the user goes to an
   * agent's task is (watch).
   *
   * @param {object} rec
   * @param {string|null} [tabId]  zen-core's id of the task's tab to show
   * @param {Window|null} [from]  the window the user asked in
   * @returns {Promise<boolean>} whether the window shows the task
   */
  openSpace(rec, tabId = null, from = null) {
    return this.watch(rec, from, { tabId });
  }

  /**
   * Go to an agent's task from zenius's own UI (the tasks panel's Open and
   * its tab names, a notification): its Space as openSpace shows it, and,
   * when one of the agent sidebar's Work chats drives the task, that chat in
   * the agent sidebar of the window that shows the task, opened if it was
   * closed. With several chats at work, the user then answers the one that
   * asked. A task no Work chat drives (a CLI agent's) opens no sidebar.
   *
   * @param {object} rec
   * @param {string|null} [tabId]  zen-core's id of the task's tab to show
   * @param {Window|null} [from]  the window the user asked in
   * @returns {Promise<boolean>} whether the window shows the task
   */
  async goToTask(rec, tabId = null, from = null) {
    const shown = await this.openSpace(rec, tabId, from);
    if (rec.gone) {
      return shown;
    }
    const watcher = [from, ...Services.wm.getEnumerator("navigator:browser")].find(w => w && !w.closed && this.watching(w) === rec.id);
    const win = watcher ?? (from && !from.closed ? from : Services.wm.getMostRecentWindow("navigator:browser"));
    try {
      await win?.ucAgentSidebar?.openChatOfSpace?.(rec.id, rec.source ?? null);
    } catch (e) {
      console.error("[zenius] the task's chat didn't open in the agent sidebar", e);
    }
    return shown;
  }

  /**
   * Would the agent sidebar's send in `win` give task `rec` back to its agent,
   * as Resume agent does? Only while the user holds the task by Take over
   * (not the agent's hand-off, whose secret step Resume blanks, nor a
   * permission hold), with no prompt open on its pages, and with `win`'s
   * selected tab one of its managed pages, on a site its pages had at the
   * Take over (spaces.takeoverSiteOf, which checks the page too). Any other
   * tab, site or window keeps the hold. The composer says so before the
   * press, and the press asks again (handBackBySend).
   *
   * @param {object} rec
   * @param {Window} win  the agent sidebar's window
   * @returns {{applies: boolean, page: string|null, site: string|null}}
   *   page: the selected tab's label when it's one of the task's pages;
   *   site: that page's site (siteName)
   */
  sendHandBack(rec, win) {
    const none = { applies: false, page: null, site: null };
    if (!this.service || !rec || rec.gone || rec.ownership !== "agentDelegatedToUser" || rec.heldBy !== "user") {
      return none;
    }
    const browser = win && !win.closed ? win.gBrowser?.selectedBrowser : null;
    const page = browser ? this.service.pages.forBrowser(browser) : null;
    if (!page || page.spaceId !== rec.id) {
      return none;
    }
    let site = null;
    try {
      site = siteName(browser.currentURI) || null;
    } catch {}
    // A page's permission or passkey prompt ends its own hold.
    if (this.#ui(rec.id).prompts.size) {
      return { applies: false, page: page.label, site };
    }
    // zen-core's rule decides, and its site is the one the line names.
    const recorded = this.service.spaces.takeoverSiteOf?.(rec, browser) ?? null;
    return { applies: !!recorded, page: page.label, site: recorded ?? site };
  }

  /**
   * The agent sidebar's send as Resume agent: sendHandBack, asked again at
   * the user's press, then the hold card's own path (#handBack: the quiet
   * reload of a page that holds a typed secret, zen-input's guard, then the
   * agent's ownership), awaited, so the agent's turn starts on the cleaned
   * pages. Resolves to what the turn's note tells the agent, or null when
   * the send gives nothing back.
   *
   * @param {object} rec
   * @param {Window} win  the agent sidebar's window
   * @returns {Promise<{page: string, site: string|null, notes: object}|null>}
   */
  async handBackBySend(rec, win) {
    const state = this.sendHandBack(rec, win);
    if (!state.applies) {
      return null;
    }
    await this.#handBack(rec);
    const now = this.#peek(rec.id);
    if (!now || now.gone || now.ownership !== "agent") {
      return null;
    }
    return { page: state.page, site: state.site, notes: this.service.spaces.takeHandBackNotes(now) };
  }

  /**
   * Watch an agent's task: only ever in answer to the user's own click (the
   * tasks panel's Open and Take over, a notification, the agent sidebar's
   * live card and directory). The window shows the task's Space, on `tab`
   * (or zen-core's `tabId`) if that's one of the task's, else on the page
   * that needs the user, else on the task's front tab, and shows that
   * page's permission prompts again. It remembers where the user was; the
   * strip, or a chip where the strip can't be read, says what it shows, and
   * ⌃Tab goes back (ui/watch.sys.mjs).
   *
   * @param {object} rec
   * @param {Window|null} [from]  the window the user asked in: with window
   *   sync the task opens there, on its copy of the tab, which Zen then
   *   gives the page, rather than in the window that has the page
   * @param {{tab?: Element|null, tabId?: string|null}} [options]
   * @returns {Promise<boolean>} whether the window shows the task
   */
  async watch(rec, from = null, { tab = null, tabId = null } = {}) {
    if (!rec || !this.service) {
      return false;
    }
    const tabs = this.#tabsOf(rec);
    const chosen = tab ? tabs.find(t => sameTab(t, tab)) : tabId === null ? null : tabs.find(t => this.service.pages.tabId(t) === tabId);
    const found = chosen ?? this.#tabNeedingUser(rec);
    const target = (from && found && copyIn(found, from)) || found;
    const win = target?.ownerDocument.defaultView ?? from ?? rec.window;
    if (!win?.gZenWorkspaces || win.closed) {
      return false;
    }
    return this.#watches.begin(win, rec.id, this.#placeOf(win), () => this.#showSpace(rec, win, target));
  }

  /**
   * End `win`'s watch. With `back` (as ⌃Tab), the window goes back to where
   * the user was.
   *
   * @param {Window} win
   * @param {{back?: boolean}} [options]
   * @returns {Promise<boolean>} whether a watch ended
   */
  stopWatching(win, { back = true } = {}) {
    return this.#watches.end(win, { back });
  }

  /**
   * A remote task started while the agent sidebar is closed in `win` (the
   * agent sidebar's arrival): the same small card it would show, over the
   * strip (ui/panel.sys.mjs's showArrival). It takes no focus, opens nothing
   * and selects nothing (I1).
   *
   * @param {Window} win
   * @param {{text: string, watch: () => void, stop: () => void, ms: number}} arrival
   * @returns {boolean} whether it shows
   */
  remoteArrival(win, arrival) {
    try {
      return showArrival(win, arrival);
    } catch (e) {
      console.error("[zenius] the remote task's arrival card failed", e);
      return false;
    }
  }

  /**
   * The task `win` watches: its Space id, else null.
   *
   * @param {Window} win
   * @returns {number|null}
   */
  watching(win) {
    return this.#watches.of(win);
  }

  /**
   * The task `win` watched until it ended there, while ⌃Tab still goes back
   * (until the user goes elsewhere themselves): its Space id, else null.
   *
   * @param {Window} win
   * @returns {number|null}
   */
  watchingDone(win) {
    return this.#watches.doneOf(win);
  }

  /**
   * Where ⌃Tab goes back to: the user's own tab, or, from an agent's page or
   * Space, their own Space, on the tab Zen remembers there.
   *
   * @param {Window} win
   */
  #placeOf(win) {
    const tab = win.gBrowser.selectedTab;
    const uuid = win.gZenWorkspaces.activeWorkspace ?? null;
    if (uuid && !this.lookup(tab) && !this.#agentsOwn(uuid)) {
      return { workspace: uuid, tab };
    }
    const own = this.#userWorkspace(win);
    return own ? { workspace: own, tab: null } : { workspace: uuid, tab };
  }

  /** The Agents Space, or a task's own Space: no place of the user's. */
  #agentsOwn(uuid) {
    const { spaces } = this.service;
    return !!spaces.isAgentsSpace?.(uuid) || (spaces.records?.() ?? []).some(r => !r.gone && r.uuid === uuid && r.kind === "task");
  }

  /** Is `tab` one of task `id`'s, or a window's copy of one? */
  #isTaskTab(id, tab) {
    const rec = this.#peek(id);
    if (!rec || rec.gone || !tab || tab.closing) {
      return false;
    }
    return this.lookup(tab)?.rec?.id === id || this.#tabsOf(rec).some(t => sameTab(t, tab));
  }

  /**
   * A window began, moved or ended a watch, or the task it watched ended
   * (`done`: ⌃Tab still goes back). A screen reader hears what the window
   * shows and the way back, which the strip and the chip only show. The
   * agent sidebar hears it as an event on the window: its live card and the
   * root's data-zenius-watching follow, with nothing of zenius's loading at
   * the sidebar's start.
   *
   * @param {Window} win
   * @param {{space: number|null, done: boolean, name: string}} change
   */
  #watchChanged(win, { space, done, name }) {
    const task = isolate(name);
    if (space !== null) {
      this.#announce(`Watching ${task || "an agent's task"}. ${BACK_KEY_WORDS} goes back to your tabs.`, win);
    } else if (done) {
      this.#announce(`${task ? `Task done: ${task}` : "Task done"}. ${BACK_KEY_WORDS} goes back to your tabs.`, win);
    }
    try {
      win.dispatchEvent(new win.CustomEvent("zenius-watch", { detail: { space, done } }));
    } catch (e) {
      console.error("[zenius] telling the window about its watch failed", e);
    }
  }

  /** The switch a watch makes: the Space, on `tab` if there is one. */
  async #showSpace(rec, win, tab) {
    try {
      if (tab) {
        landOn(tab);
      }
      win.focus();
      await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      if (tab && win.gBrowser.selectedTab !== tab && !tab.closing) {
        win.gBrowser.selectedTab = tab;
      }
      this.#reshowPrompts(rec, win);
    } catch (e) {
      console.error("[zenius] opening the Space failed", e);
    }
  }

  /**
   * A JS dialog the agent intercepted (zen-observe's dialogs.sys.mjs) leaves
   * its page frozen for anyone else. Once the agent no longer drives the
   * page, hand the dialog to Firefox's own prompt UI, but only on a page a
   * window shows: releasing a beforeunload dialog selects its tab, which
   * mustn't move the user's view (I1). Hidden pages get theirs when they're
   * selected; if the agent has control again by then, the dialog stays its.
   */
  #releaseShownDialogs() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.#releaseDialog(win.gBrowser?.selectedBrowser);
    }
  }

  /** @param {Element} [browser] */
  #releaseDialog(browser) {
    try {
      if (browser && lazy.currentDialog(browser) && !this.service.isAgentDriven(browser)) {
        lazy.releaseDialog(browser);
      }
    } catch (e) {
      console.error("[zenius] handing a dialog to the user failed", e);
    }
  }

  /** The page with a permission prompt, else the one with our notice. */
  #tabNeedingUser(rec) {
    const ui = this.#spaces.get(rec.id);
    const tabs = this.#tabsOf(rec);
    for (const key of ui?.prompts.keys() ?? []) {
      const [browserId] = splitPromptKey(key);
      const tab = tabs.find(t => String(t.linkedBrowser?.browserId) === browserId);
      if (tab) {
        return tab;
      }
    }
    if (ui?.noticeTab?.isConnected && !ui.noticeTab.closing) {
      return ui.noticeTab;
    }
    // Else the task's front tab (zen-core): the last the agent made current
    // or the user picked.
    return this.service.pages.frontTab?.(rec) ?? this.#noticeTabFor(rec);
  }

  /**
   * A permission prompt for a background tab waits in PopupNotifications
   * until its tab is selected. On the Mac it didn't show after Open in the
   * tasks panel: Firefox's own update on TabSelect can miss it, for example
   * while it suppresses doorhangers during the switch, and a prompt the
   * user clicked away only leaves an icon. So once the switch has settled,
   * show it again ourselves.
   */
  #reshowPrompts(rec, win, delays = [100, 600]) {
    const ui = this.#spaces.get(rec.id);
    if (!ui?.prompts.size || !delays.length) {
      return;
    }
    lazy.setTimeout(() => {
      const PN = win.PopupNotifications;
      const browser = win.gBrowser?.selectedBrowser;
      if (!PN || !browser || PN.isPanelOpen) {
        return;
      }
      for (const key of ui.prompts.keys()) {
        const [browserId, id] = splitPromptKey(key);
        const n = String(browser.browserId) === browserId && PN.getNotification(id, browser);
        if (!n) {
          continue;
        }
        // Re-checks Firefox's suppression rules, and shows the prompts that
        // are allowed now.
        PN.anchorVisibilityChange();
        if (!PN.isPanelOpen) {
          n.dismissed = false;
          n.reshow();
        }
        if (!PN.isPanelOpen) {
          this.#reshowPrompts(rec, win, delays.slice(1));
        }
        return;
      }
    }, delays[0]);
  }

  #noticeTabFor(rec) {
    const ui = this.#ui(rec.id);
    const current = ui.currentTab;
    if (current && copiesOf(current).length) {
      // The copy that holds the page now (window sync).
      const hit = this.lookup(current);
      const live = hit?.rec.id === rec.id ? this.service.pages.tabFor(hit.page) : liveCopy(current);
      if (live && !live.closing) {
        return live;
      }
    }
    return this.#tabsOf(rec)[0] ?? null;
  }

  #tabsOf(rec) {
    const { pages } = this.service;
    return pages
      .list(rec.id)
      .map(page => pages.tabFor(page))
      .filter(Boolean);
  }

  /**
   * The tabs with a cursor the task drew: its pages', and any other tab
   * where it last asked the cursor policy to draw (#cursorTask). A finish
   * keeps a tab after zen-core has released its page from the task
   * (endTask, then the ownership "user"), so #tabsOf no longer has it; its
   * cursor used to stay, and a later showing of the tab drew it again.
   *
   * @param {object} rec
   */
  #cursorTabsOf(rec) {
    const tabs = new Set(this.#tabsOf(rec));
    for (const tab of cursorTabs()) {
      if (this.#cursorTask.get(tab) === rec.id) {
        tabs.add(tab);
      }
    }
    return [...tabs];
  }

  #forget(id) {
    for (const [step, { space }] of this.#runningSteps) {
      if (space === id) {
        this.#runningSteps.delete(step);
      }
    }
    // A task that ended without saying the user has it (its last tab
    // closed) leaves no cursor either.
    for (const tab of cursorTabs()) {
      if (this.#cursorTask.get(tab) === id) {
        forgetCursor(tab);
      }
    }
    setTaskTag(id, null);
    this.#watches.forget(id);
    const ui = this.#spaces.get(id);
    if (ui) {
      lazy.clearTimeout(ui.idleTimer);
      if (ui.noticeTab) {
        removeNotice(ui.noticeTab, CONTROL_NOTICE);
      }
      this.#endTakeOverRefused(ui);
      this.#endHandOffNotification(id, ui);
      this.#endJoined(this.#peek(id) ?? { id }, ui);
      this.#spaces.delete(id);
    }
    this.#userPaused.delete(id);
    this.#taskBadges.delete(id);
    this.#autoHandOffs.delete(id);
    this.takeover.resolve(id, "cancel");
    // finish() may have dropped the record already: the uuid comes from ui.
    const uuid = ui?.uuid ?? this.#peek(id)?.uuid;
    if (uuid && this.service?.spaces.isAgentsSpace?.(uuid)) {
      // Other tasks there may still need the user.
      this.#refreshSharedBadge(uuid);
    } else if (uuid) {
      setSpaceBadge(uuid, null);
    }
    this.#refreshTasks();
  }

  // -------------------------------------------------------------------------
  // Badges

  /** @param {object} rec */
  badgeFor(rec) {
    // Any agent task: a Space the agent created, or one it claimed.
    if (!rec || rec.gone || (rec.ownership !== "agent" && rec.ownership !== "agentDelegatedToUser")) {
      return null;
    }
    const ui = this.#ui(rec.id);
    let state;
    if (rec.ownership === "agentDelegatedToUser") {
      state = ui.source === "user" ? "user" : "needs-user";
    } else if (ui.refusedTab || ui.sidebarNeeds) {
      // Their Take over couldn't begin and the agent waits for their pick,
      // or the agent sidebar's chat waits for them (noteSidebarTask).
      state = "needs-user";
    } else if (rec.paused || this.takeover.promptState(rec.id)) {
      state = "paused";
    } else {
      state = ui.turnRunning || Date.now() - ui.lastActivity < ACTIVE_MS ? "working" : "idle";
    }
    // The agent's current action, while its cursor shows: a cursor hidden
    // for the user keeps its label only to show it again on Resume agent.
    const cursor = ui.currentTab ? cursorState(ui.currentTab) : null;
    const action = cursor && !cursor.hidden ? cursor.label : "";
    return { state, text: rec.stateText ?? "", action, name: rec.name };
  }

  #refreshBadge(rec) {
    if (!rec) {
      return;
    }
    const next = this.badgeFor(rec);
    // The task's tabs show the same state as its badge and panel row.
    setTaskTag(rec.id, next ? { state: next.state, name: rec.name ?? "" } : null);
    const last = this.#taskBadges.get(rec.id);
    if (next) {
      this.#taskBadges.set(rec.id, next);
    } else {
      this.#taskBadges.delete(rec.id);
    }
    if (!rec.uuid) {
      return;
    }
    if (rec.kind === "task") {
      if (sameBadge(last, next)) {
        return;
      }
      if (last?.state !== next?.state) {
        // For the agent sidebar's directory, in this process: a task whose
        // badge now says it needs the user (or no longer does).
        this.service.emitLocal?.("taskBadge", { space: rec.id, state: next?.state ?? null });
      }
      if (next) {
        this.#ui(rec.id).uuid = rec.uuid;
      }
      this.#refreshSharedBadge(rec.uuid);
      this.#refreshTasks();
      return;
    }
    const prev = spaceBadge(rec.uuid);
    if (
      (!next && !prev) ||
      (next && prev && next.state === prev.state && next.text === prev.text && next.action === prev.action)
    ) {
      return;
    }
    if (next) {
      this.#ui(rec.id).uuid = rec.uuid;
    }
    setSpaceBadge(rec.uuid, next);
    this.#refreshTasks();
  }

  /**
   * The Agents Space's badge and header status: only while a task there
   * needs the user (SPEC §3.8). The tasks panel and each tab's tag show the
   * rest, task by task.
   *
   * @param {string} uuid
   */
  #refreshSharedBadge(uuid) {
    const waiting = [];
    for (const rec of this.service?.spaces.records?.() ?? []) {
      if (rec.kind === "task" && rec.uuid === uuid && !rec.gone) {
        const badge = this.#taskBadges.get(rec.id);
        if (badge?.state === "needs-user") {
          waiting.push({ rec, badge });
        }
      }
    }
    let info = null;
    // `text` compares badges; `label` is what shows, each name isolated.
    if (waiting.length === 1) {
      const { rec, badge } = waiting[0];
      info = {
        state: "needs-user",
        text: [rec.name, badge.text].filter(Boolean).join(", "),
        label: [isolate(rec.name), isolate(badge.text)].filter(Boolean).join(", "),
        action: "",
        name: rec.name,
      };
    } else if (waiting.length > 1) {
      info = {
        state: "needs-user",
        text: `${waiting.length} tasks: ${waiting.map(w => w.rec.name).join(", ")}`,
        label: `${waiting.length} tasks: ${waiting.map(w => isolate(w.rec.name)).join(", ")}`,
        action: "",
        name: "",
      };
    }
    const prev = spaceBadge(uuid);
    if ((!info && !prev) || (info && prev && info.state === prev.state && info.text === prev.text)) {
      return;
    }
    setSpaceBadge(uuid, info);
  }

  // -------------------------------------------------------------------------
  // Tasks panel

  /**
   * One row per agent task the user can see, in Zen's Space order.
   *
   * @returns {import("chrome://userscripts/content/zenius/ui/panel.sys.mjs").TaskRow[]}
   */
  tasks() {
    const rows = [];
    for (const rec of this.service?.spaces.records?.() ?? []) {
      // Each task's own state: tasks in the Agents Space share its badge.
      const badge = this.#taskBadges.get(rec.id);
      if (!badge || rec.gone) {
        continue;
      }
      rows.push({
        id: rec.id,
        name: rec.name,
        state: badge.state,
        detail: rowDetail(badge),
        ownership: rec.ownership,
        paused: this.#userPaused.has(rec.id),
        tabs: this.#tabsOf(rec).map(tab => ({
          id: this.service.pages.tabId(tab),
          title: tab.label || "New Tab",
        })),
        idleFor: this.service.isIdleTask?.(rec) ? idleText(this.service.autoCloseHours) : null,
        clears: this.#panelClears(rec),
      });
      rows.at(-1).needs = needsUser(rows.at(-1));
      rows.at(-1).waitsFor = rows.at(-1).needs ? this.#waitsFor(rec, badge.state) : null;
    }
    return rows;
  }

  /**
   * What a task that needs the user waits for, for the strip's line
   * (panel.sys.mjs's waitText): the agent's hand-off reason, a page's
   * permission prompt, a choice (a Take over that couldn't begin, or the
   * takeover prompt's pause), or why the agent sidebar's chat waits.
   *
   * @param {object} rec
   * @param {string} state  the task's badge state
   * @returns {string|null}
   */
  #waitsFor(rec, state) {
    const ui = this.#ui(rec.id);
    if (rec.ownership === "agentDelegatedToUser") {
      if (ui.source === "permission") {
        return "permission";
      }
      // A hand-off that gave no reason.
      return rec.reason === "manual_takeover" ? "handoff" : (rec.reason ?? null);
    }
    if (ui.refusedTab) {
      return "choice";
    }
    if (ui.sidebarNeeds) {
      return ui.sidebarNeeds;
    }
    return state === "paused" ? "choice" : null;
  }

  /**
   * How many tasks need the user: the strip's count, which the agent
   * sidebar's Work count reads too, so they agree. Every zenius task that
   * waits for the user (needsUser), whoever drives it, plus the sidebar's
   * tasks that need the user with no zenius task saying so
   * (noteSidebarWaiting).
   *
   * @returns {number}
   */
  needsCount() {
    return this.tasks().filter(row => row.needs).length + this.#sidebarWaiting.length;
  }

  /**
   * The agent sidebar's word on its tasks that need the user where no zenius
   * task says so: a chat's question, error or permission before its agent
   * opened one (AgentService.noteWaiting), and why each waits. The strip
   * counts them, and names one that waits alone; its panel has a row for
   * each, with Open, which shows that chat in the sidebar.
   *
   * @param {Array<{uid: string, name: string, why?: string|null}>} waiting
   */
  noteSidebarWaiting(waiting) {
    const list = (Array.isArray(waiting) ? waiting : [])
      .filter(item => typeof item?.uid === "string" && item.uid)
      .slice(0, 50)
      .map(item => ({
        uid: item.uid.slice(0, 64),
        name: typeof item.name === "string" ? item.name.slice(0, 80) : "",
        why: typeof item.why === "string" && /^[a-z_]{1,24}$/.test(item.why) ? item.why : null,
      }));
    if (JSON.stringify(list) === JSON.stringify(this.#sidebarWaiting)) {
      return;
    }
    this.#sidebarWaiting = list;
    this.#refreshTasks();
  }

  /** Refresh every Space's badge on the next tick (coalesced). */
  #scheduleSweep() {
    if (this.#sweepTimer) {
      return;
    }
    this.#sweepTimer = lazy.setTimeout(() => {
      this.#sweepTimer = 0;
      const spaces = this.service.spaces;
      try {
        // Marks records whose workspace the user deleted.
        spaces.refresh();
      } catch {
        return; // no browser window (shutdown)
      }
      for (const rec of spaces.records()) {
        if (!rec.gone) {
          this.#refreshBadge(rec);
        } else if (this.#spaces.has(rec.id) || this.#taskBadges.has(rec.id) || this.#autoHandOffs.has(rec.id) || spaceBadge(rec.uuid)) {
          this.#forget(rec.id);
        }
      }
    }, 0);
  }

  #refreshTasks() {
    const rows = this.tasks();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && win.gBrowser) {
        updateTasks(win, rows, this.#panelActions, this.#sidebarWaiting);
      }
    }
    // A watched task's new name.
    this.#watches.refresh();
  }

  /**
   * Open the tasks panel in `win` (the strip does this on click).
   *
   * @param {Window} win
   */
  openTasksPanel(win) {
    return openTasksPanel(win, this.#panelActions);
  }

  /** @param {Window} win */
  closeTasksPanel(win) {
    closeTasksPanel(win);
  }

  // -------------------------------------------------------------------------
  // For tests

  /** @param {object} rec */
  describe(rec) {
    const ui = this.#ui(rec.id);
    const prompt = this.takeover.promptState(rec.id);
    return {
      space: rec.id,
      ownership: rec.ownership,
      paused: !!rec.paused,
      pausedByUser: this.#userPaused.has(rec.id),
      reason: rec.reason ?? null,
      // The Space's badge: in the Agents Space it's shared, and shows only
      // a task that needs the user. The task's own state is taskBadge.
      badge: spaceBadge(rec.uuid),
      taskBadge: this.#taskBadges.has(rec.id) ? { ...this.#taskBadges.get(rec.id) } : null,
      prompt: prompt && { typed: prompt.typed, inputs: prompt.inputs },
      controlNotice: ui.noticeTab ? noticeText(ui.noticeTab, CONTROL_NOTICE) : null,
      controlNote: ui.noticeTab ? (noticeElement(ui.noticeTab, CONTROL_NOTICE)?.querySelector(".zenius-card-note")?.firstChild?.textContent ?? null) : null,
      controlMore: ui.noticeTab ? (noticeElement(ui.noticeTab, CONTROL_NOTICE)?.querySelector(".zenius-card-note-more")?.textContent ?? null) : null,
      controlButtons: ui.noticeTab
        ? [...(noticeElement(ui.noticeTab, CONTROL_NOTICE)?.querySelectorAll("button") ?? [])].map(b => b.textContent)
        : [],
    };
  }
}

/** "<browserId>:<prompt id>"; prompt ids may contain colons. */
function splitPromptKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

// The agent's words end a sentence of their own: . ! ? or an ellipsis, or
// Chinese 。！？, before any closing quotes or brackets and isolate()'s
// closing mark. The note then adds no period after its quote.
const ENDS_SENTENCE = /[.!?…。！？][\s"'”’»)\]）」』\u2069]*$/u;

/**
 * The control pill's text: who has control, and why (also the card tests').
 *
 * @param {{stateText?: string, reason?: string}} rec  the task's
 * @param {"agent"|"user"|"permission"} source  who handed control over
 * @param {string} [promptWhat]  what a permission prompt asks for
 */
export function controlCard(rec, source, promptWhat) {
  if (source === "user") {
    return { title: "You're in control", detail: "the agent waits until you resume it", tone: "user" };
  }
  if (source === "permission") {
    const what = promptWhat ?? PERMISSION_NAMES[rec.reason] ?? "for a permission";
    return { title: "Agent paused", detail: `page asks ${what}`, tone: "attention" };
  }
  // The state text is the agent's own words, and the card says so: a bare
  // "Log in to continue" doesn't say who asks. They go in the small
  // text, uncapped, which the '?' opens; the title row names the task.
  return { title: "Agent needs you", detail: isolate(rec.name), note: agentSays(rec.stateText) || undefined, tone: "attention" };
}

/**
 * The agent's own words, said to be theirs, as the hold card and the tasks
 * panel put them: 'The agent says: "Log in to continue".' Empty for none.
 *
 * @param {string|undefined} text
 */
function agentSays(text) {
  const said = isolate(text);
  return said ? `The agent says: “${said}”${ENDS_SENTENCE.test(said) ? "" : "."}` : "";
}

/**
 * A tasks panel row's line: the state's words, then the rest after a dot,
 * "Agent working · Finding a table for 2 · Click Submit". A task that
 * waits for the user quotes its agent as the hold card does, 'Agent needs
 * you. The agent says: "Sign in to Accounts."', with no action: beside that
 * state, the agent's last action would read as the user's to do.
 *
 * @param {{state: string, text?: string, action?: string}} badge
 */
function rowDetail(badge) {
  const words = stateWords(badge.state);
  if (badge.state === "needs-user") {
    const said = agentSays(badge.text);
    return said ? `${words}. ${said}` : words;
  }
  return [words, badge.state === "paused" ? "waiting for you" : "", isolate(badge.text), isolate(badge.action)].filter(Boolean).join(" · ");
}

/**
 * The claim gate's prompt (also the Mac look test's). zenius's own words
 * come first; the client's name is only a quoted label after them, in the
 * same plain text, so a steered agent can't pose as zenius or the browser.
 * The line wraps rather than hide a name. No answer denies it.
 *
 * @param {string} client  the label the client gave, as plainText() leaves it
 * @param {string} name  the Space's, likewise
 * @param {number} until  epoch ms of zen-core's timeout
 * @param {{allow?: () => void, deny?: () => void}} [actions]
 */
export function claimCard(client, name, until, actions = {}) {
  const asks = `An agent asks to work in your Space “${isolate(name)}”.`;
  return {
    title: "Agent request",
    detail: "denied in {t}",
    until,
    note: client ? `${asks} It calls itself “${isolate(client)}”.` : asks,
    tone: "attention",
    buttons: [
      { label: "Allow", primary: true, onClick: actions.allow ?? (() => {}) },
      { label: "Deny", onClick: actions.deny ?? (() => {}) },
    ],
  };
}

/**
 * Text a client chose, for a sentence of ours, as zen-core's runtime also
 * leaves it: no control or format characters (Unicode Cc and Cf: an RLO
 * would reverse the rest of the line, a zero-width one hides), no line or
 * paragraph separators, whitespace collapsed, at most `max` code points.
 *
 * @param {unknown} value
 * @param {number} max
 */
export function plainText(value, max) {
  const text = (typeof value === "string" ? value : "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

/** @param {nsIPrincipal|null} principal */
function isWebPrincipal(principal) {
  try {
    return !!principal?.isContentPrincipal && (principal.schemeIs("https") || principal.schemeIs("http"));
  } catch {
    return false;
  }
}

/** siteName for a document's principal, "" unless it's an http(s) site's. */
function principalSite(principal) {
  if (!isWebPrincipal(principal)) {
    return "";
  }
  try {
    return siteName(Services.io.newURI(principal.originNoSuffix));
  } catch {
    return "";
  }
}

/**
 * The site the user is on in a held page, for its card: Zen's compact mode
 * often hides the URL bar, and a sign-in may take the page to another site
 * on its own (a SAML post, an SSO redirect). Its registrable domain as
 * Firefox shows it, isolated as the card's other texts are; null for a page
 * with no site (data:, blob:, about:).
 *
 * @param {Element|null|undefined} browser
 * @returns {string|null}
 */
export function heldSite(browser) {
  const uri = browser?.currentURI;
  if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
    return null;
  }
  try {
    return isolate(siteName(uri)) || null;
  } catch {
    return null;
  }
}

/**
 * The site of a URL, which zen-observe's record of the agent's code goes
 * by: its registrable domain ("accounts.google.com.evil.co" is evil.co;
 * an IP address or a one-label host is itself), shown as Firefox's address
 * bar shows it. An IDN is Unicode when it's safe, and punycode when its
 * letters could spoof another name, as for a Latin and Cyrillic mix.
 *
 * @param {nsIURI} uri  http(s)
 * @returns {string}
 */
export function siteName(uri) {
  let host;
  try {
    host = Services.eTLD.getBaseDomain(uri);
  } catch {
    host = uri.asciiHost;
  }
  try {
    return Services.io.newURI(`${uri.scheme}://${host.includes(":") ? `[${host}]` : host}/`).displayHost;
  } catch {
    return host;
  }
}

/**
 * The local-network notice's card, in a task's tab: access denied, with the
 * host, and why, as policy, naming the address; that it's on the local
 * network, and what the buttons do, wait behind the '?'. For an address the
 * user typed, their two ways on: open it themselves, in a tab of their own
 * outside the task, or add that exact host to
 * zenius.agentTabs.allowPrivateNetworks and load it here (ZeniusUI's
 * #allowLocal, only on this button's trusted click). An address the page
 * chose (a link, a subresource) gets only the first: the page picked it, so
 * allowing it from there would let a page reach a device. Three buttons go
 * under the line, so the host shows whole.
 *
 * @param {{host: string, typed: boolean}} what
 * @param {{own?: () => void, allow?: ((event: Event) => void)|null, dismiss?: () => void}} [actions]
 */
export function localNetCard({ host, typed }, actions = {}) {
  const allow = typed && actions.allow ? actions.allow : null;
  let more;
  if (!typed) {
    more = "It's on your local network, and this page tried to reach it; opening it yourself opens its home page in a tab of yours.";
  } else if (allow) {
    more = "It's on your local network; Add to allowlist lets every agent tab reach it, until you remove it.";
  } else {
    more = "It's on your local network.";
  }
  return {
    title: "Network access denied",
    detail: isolate(host.length > MAX_HOST_CHARS ? `…${host.slice(1 - MAX_HOST_CHARS)}` : host),
    note: `The current network policy doesn't allow agents to access ${isolate(host)}.`,
    more,
    tone: "attention",
    buttons: [
      { label: "Open it yourself", primary: true, onClick: actions.own ?? (() => {}) },
      ...(allow ? [{ label: "Add to allowlist", onClick: allow }] : []),
      { label: "Dismiss", icon: "close", onClick: actions.dismiss ?? (() => {}) },
    ],
  };
}

/**
 * Why the user's Take over couldn't begin, from zen-core's error (holdFor):
 * its reason ("discardFailed", "reloadFailed" or "reachable"), "noDocument"
 * for a page with no document to hold, or "unknown"; and whether loading the
 * page afresh would leave its site (data.offSite, the other site's URL), when
 * Try again fails the same way.
 *
 * @param {Error & {code?: string, data?: object}} error
 * @returns {{reason: string, offSite: boolean}}
 */
export function takeOverRefusal(error) {
  if (error?.code === "ZEN_PAGE_NOT_FOUND") {
    return { reason: "noDocument", offSite: false };
  }
  const reason = error?.code === "ZEN_HANDOFF_REFUSED" && typeof error.data?.reason === "string" ? error.data.reason : "unknown";
  const offSite = reason === "reloadFailed" && typeof error.data?.offSite === "string" && error.data.offSite !== "";
  return { reason, offSite };
}

/**
 * The card on a page whose Take over couldn't begin (also the Mac look
 * test's): why, in a line, and what still works (from zen-core's reasons).
 * Stop task is safe in every case: the task's end discards the agent's
 * code. Try again isn't offered when loading the page afresh would leave
 * its site, which it would again.
 *
 * @param {{reason: string, offSite?: boolean}} refusal  takeOverRefusal's
 * @param {{retry?: () => void, stop?: () => void, resume?: () => void}} [actions]
 */
export function takeOverRefusedCard({ reason, offSite = false } = {}, actions = {}) {
  const why = {
    discardFailed: { note: "The agent's scripts in this task didn't stop in time." },
    reloadFailed: offSite
      ? { note: "Loading it afresh would take you to another site.", more: "zenius stopped that load. Stop task ends the task, and the page is yours." }
      : { note: "The page didn't load afresh in time." },
    reachable: { note: "Another of the task's tabs on this site can still reach it.", more: "Close the task's other tabs on this site, then try again." },
    noDocument: { note: "The page has nothing to take over yet." },
  }[reason] ?? { note: "zenius couldn't make this page safe for you to use." };
  const retry = !(reason === "reloadFailed" && offSite);
  return {
    title: "Can't take over this page",
    ...why,
    tone: "attention",
    buttons: [
      ...(retry ? [{ label: "Try again", primary: true, onClick: actions.retry ?? (() => {}) }] : []),
      { label: "Stop task", primary: !retry, onClick: actions.stop ?? (() => {}) },
      { label: "Resume agent", onClick: actions.resume ?? (() => {}) },
    ],
  };
}

/**
 * The card on a tab where the quiet reload before the user's first click or
 * key didn't come, so their clicks and keys stay out of it. Reload tries
 * again; the card stays up meanwhile. When the new document came in with
 * evidence too (`stillEvident`: another window on the site holds the
 * agent's code, zen-core's stillEvident), Reload alone can't help, so the
 * note gives the way out first (zen-core's: close the popup on the site,
 * then reload).
 *
 * @param {{stillEvident?: boolean}} [why]
 * @param {{reload?: () => void, dismiss?: () => void}} [actions]
 */
export function reloadFailedCard({ stillEvident = false } = {}, actions = {}) {
  return {
    title: "This page couldn't reload",
    note: stillEvident
      ? "Clicks and typing here stay off. Close the popup or other window on this site, then reload."
      : "Clicks and typing here stay off until it does.",
    tone: "attention",
    buttons: [
      { label: "Reload", primary: true, stays: true, onClick: actions.reload ?? (() => {}) },
      { label: "Dismiss", icon: "close", onClick: actions.dismiss ?? (() => {}) },
    ],
  };
}

/**
 * Why a page loaded afresh, in the reload notice's words, from the evidence
 * zen-core acted on (zen-observe's reasons), the strongest first. Each says
 * its detail behind the '?', if it has one worth reading. Only what a clean
 * copy clears: a page on a list, or that the agent flagged, doesn't reload
 * for that, and gets its warning.
 */
const RELOAD_WHY = [
  ["hooked", () => "the agent's code had changed it", left => `What its code left: ${left}.`],
  ["made", () => "the agent made it", () => ""],
];

/**
 * A detail of zen-observe's or the agent's as one line of text: no control
 * or format characters (bidi controls among them, which isolate() adds
 * back around it), no line breaks, at most 200 characters. It stays text:
 * the cards set it as text, and their details count down only with a
 * deadline (notices.sys.mjs).
 *
 * @param {unknown} text
 */
function detailLine(text) {
  return typeof text === "string" ? text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 200) : "";
}

/**
 * The reload notice's reason for `evidence` ({reason: detail}), or null
 * for none it knows. A detail is zen-observe's one line, isolated
 * (detailLine).
 *
 * @param {Object<string, string>|null|undefined} evidence
 * @returns {{why: string, more: string}|null}
 */
export function reloadReason(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return null;
  }
  for (const [reason, why, more] of RELOAD_WHY) {
    if (Object.hasOwn(evidence, reason)) {
      const detail = detailLine(evidence[reason]);
      return { why: why(detail), more: detail ? more(isolate(detail)) : "" };
    }
  }
  return null;
}

/**
 * The warning on a page that's on a phishing or malware list (zen-observe's
 * listed, from Safe Browsing) or that the agent flagged (its flagged, with
 * the agent's reason), while the user is on it. Null for evidence with
 * neither. It only informs: its one button is the ✕. The agent's reason is
 * one line, isolated (detailLine): it can't add a line or a button, and it
 * reads as the agent's, between zenius's title and note.
 *
 * @param {Object<string, string>|null|undefined} evidence
 * @param {{dismiss?: () => void}} [actions]
 */
export function pageWarningCard(evidence, actions = {}) {
  const has = reason => !!evidence && typeof evidence === "object" && Object.hasOwn(evidence, reason);
  if (!has("listed") && !has("flagged")) {
    return null;
  }
  const said = has("flagged") ? detailLine(evidence.flagged) : "";
  const flag = said ? isolate(said) : "";
  return {
    title: has("listed") ? "This page is on a phishing or malware list" : "The agent flagged this page",
    detail: !has("listed") && flag ? flag : undefined,
    note: "Be careful what you enter here.",
    more: has("listed") && has("flagged") ? (flag ? `The agent flagged it too: ${flag}.` : "The agent flagged it too.") : undefined,
    tone: "attention",
    buttons: [{ label: "Dismiss", icon: "close", onClick: actions.dismiss ?? (() => {}) }],
  };
}

/**
 * The card on a page that loaded afresh at the user's press, without the
 * agent's changes: a form there may be back at its defaults, so the user
 * checks it before submitting. It only informs: its one button is the ✕.
 * `clickLost`: the press that set the reload off went nowhere, which the
 * title says first. `evidence`: what zen-core reloaded it on ({reason:
 * detail}, zen-observe's), which it names: the notice says why.
 *
 * @param {{clickLost?: boolean, evidence?: Object<string, string>|null}} [what]
 * @param {{dismiss?: () => void}} [actions]
 */
export function reloadedCard({ clickLost = false, evidence = null } = {}, actions = {}) {
  const reason = reloadReason(evidence);
  return {
    title: clickLost ? "Your click didn't go through" : "This page reloaded",
    detail: clickLost ? (reason ? `the page reloaded, as ${reason.why}` : "the page reloaded") : reason?.why,
    note: "A form here may be back to its defaults: check it before you submit.",
    more: ["It reloaded without the agent's changes.", reason?.more].filter(Boolean).join(" "),
    tone: "attention",
    buttons: [{ label: "Dismiss", icon: "close", onClick: actions.dismiss ?? (() => {}) }],
  };
}

/**
 * The waiting-close pill's card (also the Mac look test's). It says nothing
 * of the agent's code in the pages the task left open.
 *
 * @param {boolean} finished  the task ended, rather than just this page
 * @param {string} name  the task's
 * @param {{keep?: () => void, close?: () => void}} [actions]
 */
export function closingCard(finished, name, actions = {}) {
  return {
    title: finished ? "Task finished" : "Agent closed this page",
    // One phrase after the task's name.
    detail: [isolate(name), "closes when you leave this tab"].filter(Boolean).join(", "),
    tone: "agent",
    buttons: [
      { label: "Keep tab", primary: true, onClick: actions.keep ?? (() => {}) },
      { label: "Close now", onClick: actions.close ?? (() => {}) },
    ],
  };
}

/**
 * What a refusal in a kept page the agent made took from the user: the
 * card's title, and what the page can't do.
 */
export const REFUSED = {
  camera: { title: "Camera blocked", what: "use your camera" },
  microphone: { title: "Microphone blocked", what: "use your microphone" },
  media: { title: "Camera and microphone blocked", what: "use your camera or microphone" },
  screen: { title: "Screen sharing blocked", what: "share your screen" },
  location: { title: "Location blocked", what: "see your location" },
  notifications: { title: "Notifications blocked", what: "show notifications" },
  window: { title: "Window not opened", what: "open windows" },
};

/** zen-observe's words for what a page asked for (observe.refused's `asked`), as REFUSED's keys. */
const ASKED = {
  camera: "camera",
  microphone: "microphone",
  "camera microphone": "media",
  screen: "screen",
  location: "location",
  notifications: "notifications",
};

/**
 * The REFUSED key for one of zen-observe's refusals, or null for one the
 * user wouldn't miss: the speakers, the device list and MIDI have no card.
 *
 * @param {string} kind  deviceAccess, notification, …
 * @param {string} [asked]  zen-observe's word list
 */
export function refusedKind(kind, asked = "") {
  if (kind === "notification") {
    return "notifications";
  }
  return kind === "deviceAccess" ? (ASKED[asked] ?? null) : null;
}

/**
 * The card on a kept page the agent made itself (data:, blob:, a popup its
 * code filled), only when it matters: as the user is about to type there,
 * or, with `refused` (REFUSED's key), when something they just did there
 * was refused. A reload can't clean such a page, since the agent wrote all
 * of it. It says the page might contain malicious code; typing stays on.
 *
 * @param {{refused?: string|null}} [page]
 * @param {{dismiss?: () => void}} [actions]
 */
export function madePageCard({ refused = null } = {}, actions = {}) {
  const r = refused ? REFUSED[refused] : null;
  return {
    title: r ? r.title : "The agent made this page",
    note: r ? `The agent made this page, and it might contain malicious code, so it can't ${r.what}.` : "It might contain malicious code. Keep sensitive information out.",
    tone: "attention",
    buttons: [{ label: "Dismiss", icon: "close", onClick: actions.dismiss ?? (() => {}) }],
  };
}

/**
 * The card on a tab that joined a task while the user held it
 * (JOINED_NOTICE): they opened it from the agent's page, so it's the
 * agent's, though they may take it for their own. They can type there as
 * in the page they came from: the hold covers it (zen-observe's holdPage).
 *
 * @param {string} name  the task's
 * @param {{resume?: () => void}} [actions]
 */
export function joinedCard(name, actions = {}) {
  return {
    title: "Agent's tab",
    detail: isolate(name),
    note: "You opened it from the agent's page, so it's part of the task: the agent can use it once you resume it.",
    tone: "attention",
    buttons: [{ label: "Resume agent", primary: true, onClick: actions.resume ?? (() => {}) }],
  };
}

/**
 * Has a field of `browser`'s page the keyboard: "password", "text", or
 * null? From the parent's window alone, whose input context the page's
 * focus sets (IME state), so nothing of zenius runs in the user's page.
 * The address bar's context comes from the main process, and doesn't count.
 *
 * @param {Element} browser
 * @returns {"password"|"text"|null}
 */
function focusedField(browser) {
  const win = browser?.ownerDocument?.defaultView;
  try {
    if (!win || Services.focus.focusedElement !== browser) {
      return null;
    }
    const wu = win.windowUtils;
    if (wu.inputContextOrigin !== Ci.nsIDOMWindowUtils.INPUT_CONTEXT_ORIGIN_CONTENT) {
      return null;
    }
    const ime = wu.IMEStatus;
    return ime === Ci.nsIDOMWindowUtils.IME_STATUS_PASSWORD ? "password" : ime === Ci.nsIDOMWindowUtils.IME_STATUS_ENABLED ? "text" : null;
  } catch {
    return null;
  }
}

/** The innerWindowId of the page's top document, or 0. */
function currentDoc(browser) {
  try {
    return browser?.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
  } catch {
    return 0;
  }
}

/** Whether two badges look the same (state, text and action). */
// A renamed task's badge isn't the same one either: the strip, Watch's hint
// and the shared badge show its name (the sidebar's Rename task, glue from
// zen-sidebar).
function sameBadge(a, b) {
  return (!a && !b) || (!!a && !!b && a.state === b.state && a.text === b.text && a.action === b.action && a.name === b.name);
}

export const ZeniusUI = new UiController();

/**
 * For tests: resolves once the announcements made so far in `win` have gone
 * out, ANNOUNCE_MS after the first, or later when a busy machine runs the
 * timer late (a full parallel test-all). A fixed wait read the announcer
 * too soon there.
 *
 * @param {Window} win
 * @param {number} [ms]  the longest it waits for a late one
 */
export async function announcementsOut(win, ms = 5000) {
  await new Promise(resolve => lazy.setTimeout(resolve, ANNOUNCE_MS + 150));
  for (const end = Date.now() + ms; ZeniusUI.announcing(win) && Date.now() < end; ) {
    await new Promise(resolve => lazy.setTimeout(resolve, 25));
  }
}
