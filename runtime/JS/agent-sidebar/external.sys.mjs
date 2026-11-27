/* Agent Sidebar: the zenius tasks the sidebar doesn't drive, so every task
 * the user has shows in one place.
 *
 * A Claude or Codex session in a terminal, or a script, drives the browser
 * through zenius's CLI, SDK or MCP. Its task shows in the directory like the
 * sidebar's own, under Working, Needs you or Done, with a line naming where
 * it's driven from. Opened, it shows a read-only view (panel.js): the
 * runtime's record of its steps, the live card, Watch, Take over and Stop.
 * The sidebar can't chat with that agent.
 *
 * - the core's feed (service.spaces.feed(), its taskFeed event) names every
 *   task, its source ({terminal, agent, folder}, each kept only in the
 *   remote labels' character set) and its end. It keeps ended tasks: the
 *   last 50, and for 24 h across a restart.
 * - the UI's ZeniusUI.tasks() gives a live task's state as the strip shows
 *   it (a row's `needs`), so the directory's Needs you, the strip and the
 *   Work badge count the same tasks.
 * - the input layer's ring (input/steps.sys.mjs) gives the steps: a line naming
 *   each call and its target, its outcome and time. Typed values never come,
 *   and a page's names come one line, capped and quoted.
 *
 * A task is the sidebar's own when one of its chats follows it (conv.zen),
 * or when its source says so (source.sidebar, the chat's uid, from the env
 * the sidebar gives its zenius server). Any local caller could claim that,
 * so it counts only for a chat the sidebar has.
 */

export const EXTERNAL_PREFIX = "ext-";
const STEPS_MODULE = "chrome://userscripts/content/zenius/input/steps.sys.mjs";
/** How a Done row and the view's bar say how the task ended (the core's `ended`). */
export const ENDED_TEXT = { finished: "Finished", stopped: "Stopped by you", closed: "Closed" };
const LOG = "[agent-sidebar]";

/** One line of someone else's text: no control or format characters, at most `max`. */
function plain(text, max = 200) {
  return typeof text === "string" ? text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, max) : "";
}

const isolate = text => `\u2068${text}\u2069`;

/** At most this many sites a task left the user's tabs on another account (the core caps its list too). */
export const ACCOUNTS_MAX = 10;
/** An account's most code points: an email address's longest. */
const ACCOUNT_MAX = 254;

// As the input layer cleans the names a step quotes (input/steps.sys.mjs),
// so an account reads as a name there and here alike.
/** Characters that change how a line reads without showing: controls, bidi and other format characters, lone surrogates, and the rest that show nothing. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
/** Quote marks, which an account turns into apostrophes so it can't close the line's quotes. */
export const QUOTES = /["\u201C\u201D\u201E\u201F\u2033\u2036\u275D\u275E\u301D\u301E\u301F\uFF02]/g;

/** An account as the line quotes it: one line, nothing invisible, no quote mark, at most ACCOUNT_MAX code points (with … where it's cut). */
function accountName(text) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .replace(QUOTES, "'");
  const chars = Array.from(line);
  return chars.length > ACCOUNT_MAX ? `${chars.slice(0, ACCOUNT_MAX - 1).join("")}…` : line;
}

/**
 * A site as the line names it: a bare host, its hostname in ASCII
 * (punycode, so a look-alike can't pass for the real one), or "" for
 * anything more, such as a path, a query, a fragment, a user, a port or a
 * sentence, which drops its entry.
 */
function siteHost(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw || /[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(raw)) {
    return "";
  }
  let url;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    return "";
  }
  const bare = !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash;
  return bare && url.hostname.length <= 253 ? url.hostname : "";
}

/**
 * The core's accountsToRestore as the sidebar keeps it: for each site where
 * the agent signed in as another of the user's accounts, the account the
 * user's tabs used there, which the agent said it would switch back to
 * (note_account) and hadn't when last told. Both are the agent's own text,
 * so the site counts only as a bare host and the account only as a name,
 * and nothing in either can close the line's quotes or add a sentence of
 * its own (accountsLeftLine).
 *
 * @param {unknown} list
 * @returns {{site: string, account: string}[]}
 */
export function keptAccounts(list) {
  return (Array.isArray(list) ? list : [])
    .map(a => ({ site: siteHost(a?.site), account: accountName(a?.account) }))
    .filter(a => a.site && a.account)
    .slice(0, ACCOUNTS_MAX);
}

/** Whether two keptAccounts lists say the same. */
export function sameAccounts(a, b) {
  return a.length === b.length && a.every((x, i) => x.site === b[i].site && x.account === b[i].account);
}

/**
 * Where an external task is driven from (the core's source), one phrase:
 * "Claude Code on laptop/t5x" when its caller runs in an hc terminal, else
 * "Claude Code in zenius-eval" (its agent and its folder's name). Each part
 * is a first-strong isolate, as remoteSource's. `terminal` says whether the
 * last part is the terminal, which the look sets apart as a chip. Null
 * without a source it can name.
 *
 * @param {{terminal?: string, agent?: string, folder?: string}|null} source
 * @returns {{text: string, terminal: boolean}|null}
 */
export function sourceParts(source) {
  const part = key => plain(source?.[key], 64);
  const [terminal, agent, folder] = [part("terminal"), part("agent"), part("folder")];
  if (terminal) {
    return { text: agent ? `${isolate(agent)} on ${isolate(terminal)}` : isolate(terminal), terminal: true };
  }
  const text = agent && folder ? `${isolate(agent)} in ${isolate(folder)}` : agent || folder ? isolate(agent || folder) : "";
  return text ? { text, terminal: false } : null;
}

/**
 * The row's and the tooltip's source line: "From Claude Code on laptop/t5x",
 * or "Codex in zenius-eval" without a terminal; "Driven from elsewhere" when
 * the caller said nothing.
 *
 * @param {object} conv  an ExternalTask
 * @returns {string}
 */
export function externalSource(conv) {
  const parts = sourceParts(conv?.from);
  return !parts ? "Driven from elsewhere" : parts.terminal ? `From ${parts.text}` : parts.text;
}

/**
 * The line in the question box's place while a task another agent drives
 * runs: the sidebar can't send to that agent, so the user replies where it
 * runs. Its source can't tell a terminal from an IDE or a script, hence
 * "where it runs"; an hc terminal it names is that place.
 *
 * @param {object} conv  an ExternalTask
 * @returns {string}
 */
export function replyLine(conv) {
  const parts = sourceParts(conv?.from);
  const where = !parts ? "Reply to the agent where it runs." : parts.terminal ? `Reply to ${parts.text}.` : `Reply to ${parts.text}, where it runs.`;
  return `${where} The sidebar can't chat with it.`;
}

/**
 * A task of the feed's that the sidebar lists, read-only: a stand-in for a
 * work chat (AgentService's Conversation) with the fields the directory,
 * the panel and the live card read.
 */
export class ExternalTask {
  kind = "work";
  source = "external";
  external = true;
  remote = null;
  harness = null;
  messages = [];
  draft = null;
  busy = false;
  status = "";
  stopped = false;
  zenBadge = null;
  zenNoted = null;
  /** {terminal?, agent?, folder?}: the core's source, text to show only. */
  from = null;
  /** zenius's last line on the view's hand-off card, as its row last said (ZeniusUI.afterResume). */
  afterResume = null;
  /** How it ended (the core's `ended`: finished, stopped, closed), or null while it runs. */
  ended = null;
  endedAt = 0;
  /** The latest step's text, a working row's status. */
  lastStep = "";
  /** The hand-off card's secret box as last drawn (#secretBoxOf), or null without one. */
  secretBox = null;
  listeners = new Set();

  /** @param {number} space  its zenius task's id */
  constructor(space) {
    this.uid = `${EXTERNAL_PREFIX}${space}`;
    // accountsLeft: keptAccounts of the feed's entry, as a chat's task keeps it.
    this.zen = { id: space, name: "", heldBy: null, accountsLeft: [] };
    this.title = "";
    // When the user archived it (AgentService.archiveTask), from the hooks' archived().
    this.archivedAt = null;
    // When the user pinned it in All tasks, and the name they gave it there
    // (pins.sys.mjs), from the hooks' pinned() and label(). Its program's
    // name stays the title, its zenius task's.
    this.pinnedAt = null;
    this.userTitle = null;
    this.createdAt = Date.now();
    this.task = { state: "working", since: Date.now(), text: "" };
  }

  get space() {
    return this.zen.id;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (e) {
        console.error(LOG, e);
      }
    }
  }
}

/**
 * The external tasks, kept in line with the core's feed (sync) and
 * the input layer's ring (its onStep). `hooks`:
 * - service(): zenius's service, or null;
 * - ui(): the UI's ZeniusUI, or null;
 * - own(space, source, entry): whether the sidebar drives that task, or
 *   the user removed it from the list as the feed entry has it
 *   (AgentService.wasRemoved);
 * - ownEntry(space, entry): the feed's entry of such a task, for the chat
 *   that drives it (AgentService.noteOwnEntry);
 * - archived(space, entry): when the user archived that task, else null
 *   (AgentService.archivedAtOf);
 * - pinned(task), label(task): when the user pinned it, and the name they
 *   gave it in the sidebar, else null (AgentService.marks);
 * - changed(task): a task's row changed, or (null) the list did.
 */
export class ExternalTasks {
  /** @type {Map<string, ExternalTask>} uid → task, in the feed's order */
  byUid = new Map();
  /** The input layer's steps module ({stepsOf, onStep}), null without it; tests set a stand-in. */
  #steps = undefined;
  #offSteps = null;

  constructor(hooks) {
    this.hooks = hooks;
  }

  list() {
    return [...this.byUid.values()];
  }

  get(uid) {
    return this.byUid.get(uid) ?? null;
  }

  ofSpace(space) {
    return this.byUid.get(`${EXTERNAL_PREFIX}${space}`) ?? null;
  }

  get stepsModule() {
    if (this.#steps === undefined) {
      try {
        this.#steps = ChromeUtils.importESModule(STEPS_MODULE);
      } catch {
        this.#steps = null;
      }
      this.#listenToSteps();
    }
    return this.#steps;
  }

  /** A stand-in for the input layer's module (tests); null restores the real one. */
  set stepsModule(module) {
    this.#offSteps?.();
    this.#offSteps = null;
    this.#steps = module ?? undefined;
    if (module) {
      this.#listenToSteps();
    }
  }

  #listenToSteps() {
    try {
      const off = this.#steps?.onStep?.(event => this.#onStep(event));
      this.#offSteps = typeof off === "function" ? off : null;
    } catch (e) {
      console.error(LOG, "onStep failed", e);
    }
  }

  /** The task's steps, oldest first (the input layer's stepsOf), or none. */
  steps(task) {
    try {
      const list = this.stepsModule?.stepsOf?.(task.space);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.error(LOG, "stepsOf failed", e);
      return [];
    }
  }

  /** A step began or ended: the view updates it by id, and a working row shows the latest. */
  #onStep({ space, step } = {}) {
    const task = this.ofSpace(space);
    if (!task || !step) {
      return;
    }
    task.emit({ type: "steps", step });
    const text = plain(step.text);
    if (text && text !== task.lastStep) {
      task.lastStep = text;
      if (task.task.state === "working") {
        task.task = { ...task.task, text };
        task.emit({ type: "task", stateChanged: false });
        this.hooks.changed(task);
      }
    }
  }

  /**
   * Remove an ended task from the list (the ⋯ menu's Remove); the feed keeps
   * it, and own() leaves it out from then on (AgentService.removeTask).
   */
  dismiss(task) {
    if (task?.external && task.task.state === "done") {
      this.byUid.delete(task.uid);
      this.hooks.changed(null);
    }
  }

  /** Bring the list in line with the core's feed and the strip's rows. */
  sync() {
    let entries = [];
    try {
      entries = this.hooks.service()?.spaces.feed?.() ?? [];
    } catch (e) {
      console.error(LOG, "the task feed failed", e);
    }
    const rows = new Map();
    try {
      for (const row of this.hooks.ui()?.tasks?.() ?? []) {
        rows.set(row.id, row);
      }
    } catch (e) {
      console.error(LOG, "zenius's rows failed", e);
    }
    const seen = new Set();
    let listChanged = false;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const space = entry?.space;
      if (entry?.kind !== "task" || !Number.isSafeInteger(space)) {
        continue;
      }
      if (this.hooks.own(space, entry.source ?? null, entry)) {
        this.hooks.ownEntry?.(space, entry);
        continue;
      }
      const uid = `${EXTERNAL_PREFIX}${space}`;
      seen.add(uid);
      let task = this.byUid.get(uid);
      if (!task) {
        task = new ExternalTask(space);
        this.byUid.set(uid, task);
        listChanged = true;
      }
      if (this.#update(task, entry, rows.get(space) ?? null)) {
        this.hooks.changed(task);
      }
      const archivedAt = this.hooks.archived?.(space, entry) ?? null;
      if (task.archivedAt !== archivedAt) {
        // Into Archived or out of it: another group of the directory.
        task.archivedAt = archivedAt;
        task.emit({ type: "task", stateChanged: false });
        listChanged = true;
      }
      // An archived task is never pinned (Archive unpins).
      const pinnedAt = archivedAt ? null : (this.hooks.pinned?.(task) ?? null);
      const userTitle = this.hooks.label?.(task) ?? null;
      if (task.pinnedAt !== pinnedAt || task.userTitle !== userTitle) {
        // Into Pinned or out of it, or another name.
        task.pinnedAt = pinnedAt;
        task.userTitle = userTitle;
        task.emit({ type: "task", stateChanged: false });
        listChanged = true;
      }
    }
    for (const uid of [...this.byUid.keys()]) {
      if (!seen.has(uid)) {
        this.byUid.delete(uid);
        listChanged = true;
      }
    }
    if (listChanged) {
      this.hooks.changed(null);
    }
  }

  /** One feed entry and its row into `task`; whether its row changed. */
  #update(task, entry, row) {
    const done = entry.state === "done";
    task.title = plain(entry.name, 120);
    task.zen.name = task.title;
    task.from = entry.source && typeof entry.source === "object" ? entry.source : null;
    task.createdAt = Number(entry.createdAt) || task.createdAt;
    task.ended = done ? (ENDED_TEXT[entry.ended] ? entry.ended : "finished") : null;
    task.endedAt = done ? Number(entry.endedAt) || task.endedAt || Date.now() : 0;
    if (!done) {
      // The ring's latest step, should one have come before the task was seen.
      task.lastStep = plain(this.steps(task).at(-1)?.text) || task.lastStep;
    }
    // The strip's own word on a live task (the UI's needsUser), so the
    // counts agree; the agent's hand-off text says why.
    const needs = !done && !!row?.needs;
    const state = done ? "done" : needs ? "needs" : "working";
    const text = done ? ENDED_TEXT[task.ended] : needs ? plain(entry.message, 100) || "Needs you" : task.lastStep;
    let changed = false;
    const heldBy = !done && entry.state === "held" ? "user" : null;
    const badge = done ? null : (row?.state ?? null);
    if (task.zen.heldBy !== heldBy || task.zenBadge !== badge) {
      task.zen.heldBy = heldBy;
      task.zenBadge = badge;
      task.emit({ type: "zen" });
      changed = true;
    }
    const busy = !done && row?.state === "working";
    if (task.busy !== busy) {
      task.busy = busy;
      task.emit({ type: "busy" });
      changed = true;
    }
    // zenius's last line on the view's hand-off card (ZeniusUI.afterResume),
    // which a wait that comes or goes changes: the view redraws for it, and
    // the directory's row, which doesn't show it, stays.
    const after = !done && typeof row?.afterResume === "string" ? row.afterResume : null;
    if (task.afterResume !== after) {
      task.afterResume = after;
      task.emit({ type: "task", stateChanged: false });
    }
    // The sites the task leaves the user's tabs on another account, which
    // the view says once it has ended (AgentService.accountsLeft). The
    // entry has them while any are left, so none there means none.
    const left = keptAccounts(entry.accountsToRestore);
    if (!sameAccounts(task.zen.accountsLeft, left)) {
      task.zen.accountsLeft = left;
      task.emit({ type: "task", stateChanged: false });
    }
    // The card's secret box too, which a mark that comes or goes changes
    // (the agent's, the user's on zenius's pill, a marked tab's close),
    // with no other change here.
    const box = done ? null : this.#secretBoxOf(task);
    if (task.secretBox !== box) {
      task.secretBox = box;
      task.emit({ type: "task", stateChanged: false });
    }
    if (state !== task.task.state || text !== task.task.text) {
      const stateChanged = state !== task.task.state;
      task.task = { state, text, since: stateChanged ? (done ? task.endedAt : Date.now()) : task.task.since };
      task.emit({ type: "task", stateChanged });
      changed = true;
    }
    return changed;
  }

  /** The task's secret box (ZeniusUI.secretToggle) as a key to compare, or null without one. */
  #secretBoxOf(task) {
    try {
      const rec = this.hooks.service()?.spaces.peek?.(task.space);
      const box = rec ? this.hooks.ui()?.secretToggle?.(rec) : null;
      return box ? `${box.checked}:${box.fixed}:${box.by}` : null;
    } catch (e) {
      console.error(LOG, "secretToggle failed", e);
      return null;
    }
  }

  /** Stop listening (the sidebar's shutdown). */
  destroy() {
    this.#offSteps?.();
    this.#offSteps = null;
  }
}
