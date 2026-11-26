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
 * - zen-core's feed (service.spaces.feed(), its taskFeed event) names every
 *   task, its source ({terminal, agent, folder}, each kept only in the
 *   remote labels' character set) and its end. It keeps ended tasks: the
 *   last 50, and for 24 h across a restart.
 * - zen-ux's ZeniusUI.tasks() gives a live task's state as the strip shows
 *   it (a row's `needs`), so the directory's Needs you, the strip and the
 *   Work badge count the same tasks.
 * - zen-input's ring (input/steps.sys.mjs) gives the steps: a line naming
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
/** How a Done row and the view's bar say how the task ended (zen-core's `ended`). */
export const ENDED_TEXT = { finished: "Finished", stopped: "Stopped by you", closed: "Closed" };
const LOG = "[agent-sidebar]";

/** One line of someone else's text: no control or format characters, at most `max`. */
function plain(text, max = 200) {
  return typeof text === "string" ? text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, max) : "";
}

const isolate = text => `\u2068${text}\u2069`;

/**
 * Where an external task is driven from (zen-core's source), one phrase:
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
  /** {terminal?, agent?, folder?}: zen-core's source, text to show only. */
  from = null;
  /** How it ended (zen-core's `ended`: finished, stopped, closed), or null while it runs. */
  ended = null;
  endedAt = 0;
  /** The latest step's text, a working row's status. */
  lastStep = "";
  listeners = new Set();

  /** @param {number} space  its zenius task's id */
  constructor(space) {
    this.uid = `${EXTERNAL_PREFIX}${space}`;
    this.zen = { id: space, name: "", heldBy: null };
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
 * The external tasks, kept in line with zen-core's feed (sync) and
 * zen-input's ring (its onStep). `hooks`:
 * - service(): zenius's service, or null;
 * - ui(): zen-ux's ZeniusUI, or null;
 * - own(space, source, entry): whether the sidebar drives that task, or
 *   the user removed it from the list as the feed entry has it
 *   (AgentService.wasRemoved);
 * - archived(space, entry): when the user archived that task, else null
 *   (AgentService.archivedAtOf);
 * - pinned(task), label(task): when the user pinned it, and the name they
 *   gave it in the sidebar, else null (AgentService.marks);
 * - changed(task): a task's row changed, or (null) the list did.
 */
export class ExternalTasks {
  /** @type {Map<string, ExternalTask>} uid → task, in the feed's order */
  byUid = new Map();
  /** zen-input's steps module ({stepsOf, onStep}), null without it; tests set a stand-in. */
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

  /** A stand-in for zen-input's module (tests); null restores the real one. */
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

  /** The task's steps, oldest first (zen-input's stepsOf), or none. */
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

  /** Bring the list in line with zen-core's feed and the strip's rows. */
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
      if (entry?.kind !== "task" || !Number.isSafeInteger(space) || this.hooks.own(space, entry.source ?? null, entry)) {
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
    // The strip's own word on a live task (zen-ux's needsUser), so the
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
    if (state !== task.task.state || text !== task.task.text) {
      const stateChanged = state !== task.task.state;
      task.task = { state, text, since: stateChanged ? (done ? task.endedAt : Date.now()) : task.task.since };
      task.emit({ type: "task", stateChanged });
      changed = true;
    }
    return changed;
  }

  /** Stop listening (the sidebar's shutdown). */
  destroy() {
    this.#offSteps?.();
    this.#offSteps = null;
  }
}
