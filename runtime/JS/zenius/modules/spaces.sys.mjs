// Task spaces: a stable numeric id for every Zen workspace and every agent
// task, the ownership state machine, the control gate (invariant I3), and
// the agent metadata that survives a browser restart.
//
// Two kinds of record (SPEC §3.4):
//   workspace  a Zen workspace: the user's own, or one an agent claimed
//   task       an agent task whose tabs live in the shared Agents Space,
//              which is what spaces.create makes
//
// Ownership, as in Ego:
//   agent                 the agent drives the space
//   agentDelegatedToUser  still the agent's task, but the user is in control
//                         (handOff, a takeover in the page, a permission
//                         prompt); `reason` says why, with Ego's keys
//   user                  the user's space: never claimed, or its task ended
//                         (`ended`)
// plus `paused`, set while zen-ux's takeover prompt is open: agent actions
// that change the page wait until the user decides.
//
// This module is the only writer of ownership, reason, paused and stateText.
// zen-ux's prompt and panel call setPaused/setOwnership; the spaces.* methods
// call the same functions.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { hostWindow, tabsInWorkspace, workspaceWindows } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService: "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  SessionSaver: "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const DEFAULT_PROFILE_ID = "default";
export const OWNERSHIPS = Object.freeze(["agent", "agentDelegatedToUser", "user"]);
/** Ego's waitForControl default (page-model.ts CONTROL_WAIT_TIMEOUT_MS). */
export const CONTROL_WAIT_TIMEOUT_MS = 600000;
/**
 * An agent's takeOver of a task handed to the user, or its claim of one,
 * waits until this long after the user's last real input in the task's
 * tabs: an agent can't snatch a task while the user types (the manager's
 * decision on the method audit, item 6).
 */
export const USER_INPUT_QUIET_MS = 10_000;
/** The longest name of a client's own that the claim prompt quotes. */
const CLIENT_LABEL_MAX = 40;

/**
 * The name a client gives itself, for the claim prompt, which shows it only
 * after zenius's own words, as a quoted label: untrusted text. Format
 * characters (Unicode Cf: bidi controls, zero-width ones) go; control
 * characters, line and paragraph separators and runs of whitespace become
 * one space; it's capped at 40 code points. Null when nothing is left.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function clientLabel(text) {
  if (typeof text !== "string") {
    return null;
  }
  const clean = text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  return [...clean].slice(0, CLIENT_LABEL_MAX).join("").trim() || null;
}

/**
 * Page bookkeeping that outlives the page records (Ego's PageLedger).
 *
 * @typedef {object} Ledger
 * @property {number} nextLabel
 * @property {string[]} usedLabels      every label given out in this task; labels are never reused
 * @property {string[]} releasedLabels
 * @property {Record<string, "agent"|"unknown">} unmanaged  tab id → origin of a tab the agent doesn't manage
 * @property {string[]} retained        tab ids an earlier finish() left open for the user
 */

/**
 * @typedef {object} SpaceRecord
 * @property {number} id
 * @property {"workspace"|"task"} kind
 * @property {string} uuid           the Zen workspace its tabs live in; the Agents Space for a task
 * @property {string} name
 * @property {"agent"|"user"} createdBy
 * @property {"agent"|"agentDelegatedToUser"|"user"} ownership
 * @property {string|null} reason    why the user is in control (agentDelegatedToUser only)
 * @property {boolean} ended         an agent task ran here and ended (ownership is "user")
 * @property {boolean} paused        transient: a takeover prompt is open
 * @property {string} stateText      the agent's progress text (setAgentTaskState)
 * @property {string} profileId
 * @property {number} userContextId
 * @property {number} createdAt      epoch ms
 * @property {Ledger} ledger
 * @property {Window|null} window    transient: where its agent tabs live
 * @property {boolean} [gone]        transient: the workspace no longer exists
 */

export function newLedger() {
  return { nextLabel: 1, usedLabels: [], releasedLabels: [], unmanaged: {}, retained: [] };
}

const AGENTS_SPACE_NAME = "Agents";

/**
 * zenius's mark on its Agents Space, in the Space's own data in Zen. Zen 1.24
 * keeps a field it doesn't know through everything it does with a Space: its
 * edits (rename, icon, container) change the object in place, window sync
 * shares the objects, the session save copies each one whole
 * (getWorkspacesForSessionStore), restore takes them back, and its Spaces
 * sync merges into them. Sync's records name their own fields, so the mark
 * never leaves the device. A Space Zen restores from a session file older
 * than spaces.json still carries it: that's how a restart tells an Agents
 * Space zenius made from a Space the user named Agents (healAgentsSpace).
 */
const MARK_FIELD = "zenius";
const AGENTS_MARK = "agents-space";
/** What a start adds to the name of a marked Space it leaves (healAgentsSpace). */
const OLD_SUFFIX = " (old)";

/** Does this Zen Space carry zenius's Agents Space mark? */
export function hasAgentsMark(ws) {
  return ws?.[MARK_FIELD] === AGENTS_MARK;
}

/**
 * Zen writes its Space list only with a session save, and creating or
 * removing a Space causes none. Until something else does (a tab change,
 * say), a crash or a kill brings back the list from before: an Agents Space
 * zenius removed, without the record that says it's zenius's. So zenius
 * saves, as SessionStore's own timer would, once every window's list shows
 * the change: Zen updates each window's list a tick after a removal, or
 * after the switch away from a Space the window showed (propagateWorkspaces),
 * and a save takes the lists as they are. Zen writes its own file in that
 * save. It's rare: once when the Agents Space comes, once when it goes.
 *
 * @param {(uuids: Set<string>) => boolean} shows  whether one window's Space uuids show the change
 */
async function saveSessionWhen(shows) {
  const ready = () =>
    workspaceWindows().every(w => shows(new Set(w.gZenWorkspaces.getWorkspaces().map(ws => ws.uuid))));
  for (const end = Date.now() + 10000; !ready() && Date.now() < end; ) {
    await new Promise(r => lazy.setTimeout(r, 50));
  }
  if (Services.startup.shuttingDown) {
    // SessionStore's own save at the quit takes the lists; one forced now
    // could race it. A Space it missed is the next start's to sort out.
    return;
  }
  try {
    await lazy.SessionSaver.run();
  } catch (e) {
    log("a session save for the Agents Space failed:", e.message);
  }
}
/** How many not-restored task ids spaces.json keeps. */
const NOT_RESTORED_KEPT = 64;

// -----------------------------------------------------------------------------
// Profiles: the default profile plus Zen's containers.

/** @param {number} userContextId */
export function profileIdFor(userContextId) {
  return userContextId ? `container-${userContextId}` : DEFAULT_PROFILE_ID;
}

/** @param {number} userContextId */
export function profileName(userContextId) {
  if (!userContextId) {
    return "Default";
  }
  try {
    return lazy.ContextualIdentityService.getUserContextLabel(userContextId) || `Container ${userContextId}`;
  } catch {
    return `Container ${userContextId}`;
  }
}

/** Ego's profiles(): `[{id, name, isDefault}]`. */
export function listProfiles() {
  const profiles = [{ id: DEFAULT_PROFILE_ID, name: "Default", isDefault: true }];
  for (const identity of lazy.ContextualIdentityService.getPublicIdentities()) {
    profiles.push({
      id: profileIdFor(identity.userContextId),
      name: profileName(identity.userContextId),
      isDefault: false,
    });
  }
  return profiles;
}

/**
 * @param {string|undefined|null} profileId
 * @returns {number} the container's userContextId (0 for the default profile)
 */
export function userContextIdFor(profileId) {
  if (profileId === undefined || profileId === null || profileId === DEFAULT_PROFILE_ID) {
    return 0;
  }
  const m = /^container-(\d+)$/.exec(String(profileId));
  const id = m ? Number(m[1]) : NaN;
  if (!m || !lazy.ContextualIdentityService.getPublicIdentityFromId(id)) {
    throw new ZenError("ZEN_PROFILE_NOT_FOUND", `Profile not found: ${profileId}`, { profileId });
  }
  return id;
}

// -----------------------------------------------------------------------------

export class Spaces {
  /** @type {Map<number, SpaceRecord>} */
  #byId = new Map();
  /** @type {Map<string, SpaceRecord>} */
  #byUuid = new Map();
  #nextId = 1;
  /** @type {Map<number, Set<() => void>>} space id → callbacks to run on any control change */
  #waiters = new Map();
  /**
   * The shared Agents Space: its workspace while it exists, and the name and
   * icon it gets back when it's created again (a rename by the user sticks).
   */
  #agents = { uuid: null, name: AGENTS_SPACE_NAME, icon: null };
  /** @type {Promise<string>|null} the Agents Space being created */
  #agentsCreating = null;
  /** The empty Agents Space waits for its window to show another Space. */
  #removalWaits = false;
  /** Ids of tasks none of whose tabs came back after a restart, newest last. */
  #notRestored = [];
  /** @type {Map<number, object>} space id → the claim waiting for the user's answer */
  #asks = new Map();
  #askCount = 0;

  get removalWaits() {
    return this.#removalWaits;
  }

  /** At a TabSelect: the Agents Space's removal, if it waited for its window to show another Space. */
  retryRemovals() {
    if (this.#removalWaits) {
      this.maybeRemoveAgentsSpace();
    }
  }
  /** (rec) => tabs: a task's tabs, from the service (Pages.tabsOf). */
  tabsOf = null;

  /** (event, params) => void; the service forwards to listeners and subscribers. */
  onEvent = null;
  /** Called after persistent state changed; the service schedules a save. */
  onPersist = null;
  /** (event, params) => void: in-process listeners only (the service's emitLocal). */
  onLocalEvent = null;

  #emit(name, params) {
    this.onEvent?.(name, params);
  }

  #persist() {
    this.onPersist?.();
  }

  // ---------------------------------------------------------------------------
  // Persistence (~/.zenius/state/<instance>/spaces.json). Workspace uuids are
  // stable across restarts, and so are the numeric ids. Version 1 kept
  // records by uuid, which tasks can't be: they share the Agents Space.

  serialize() {
    const records = [];
    for (const rec of this.#byId.values()) {
      if (rec.gone) {
        continue;
      }
      records.push({
        id: rec.id,
        kind: rec.kind,
        uuid: rec.uuid,
        name: rec.name,
        createdBy: rec.createdBy,
        ownership: rec.ownership,
        reason: rec.reason,
        ended: rec.ended,
        stateText: rec.stateText,
        profileId: rec.profileId,
        userContextId: rec.userContextId,
        createdAt: rec.createdAt,
        lastNamedAt: rec.lastNamedAt ?? null,
        handedToUser: !!rec.handedToUser,
        handBackVia: rec.handBackVia ?? null,
        openerCut: !!rec.openerCut,
        handBackReloaded: rec.handBackReloaded ?? [],
        ledger: { nextLabel: rec.ledger.nextLabel, usedLabels: rec.ledger.usedLabels, releasedLabels: rec.ledger.releasedLabels },
      });
    }
    return {
      version: 2,
      nextId: this.#nextId,
      agentsSpace: { ...this.#agents },
      notRestored: this.#notRestored,
      records,
    };
  }

  /**
   * Load saved records before the first refresh(). Tab ids don't survive a
   * restart, so a ledger keeps only its labels: pages come back unmanaged,
   * as after an Ego browser restart.
   */
  restore(data) {
    let saved = [];
    if (data?.version === 1) {
      saved = Object.entries(data.spaces ?? {}).map(([uuid, rec]) => ({ ...rec, uuid, kind: "workspace" }));
    } else if (data?.version === 2) {
      saved = Array.isArray(data.records) ? data.records : [];
      this.#notRestored = (Array.isArray(data.notRestored) ? data.notRestored : [])
        .filter(Number.isInteger)
        .slice(-NOT_RESTORED_KEPT);
      const agents = data.agentsSpace ?? {};
      this.#agents = {
        uuid: typeof agents.uuid === "string" ? agents.uuid : null,
        name: typeof agents.name === "string" && agents.name ? agents.name : AGENTS_SPACE_NAME,
        icon: typeof agents.icon === "string" ? agents.icon : null,
      };
    } else {
      return;
    }
    for (const entry of saved) {
      this.#restoreRecord(entry);
    }
    this.#nextId = Math.max(this.#nextId, Number.isInteger(data.nextId) ? data.nextId : 1);
  }

  #restoreRecord(saved) {
    const kind = saved?.kind === "task" ? "task" : "workspace";
    const uuid = saved?.uuid;
    if (!Number.isInteger(saved?.id) || typeof uuid !== "string" || this.#byId.has(saved.id)) {
      return;
    }
    if (kind === "workspace" && this.#byUuid.has(uuid)) {
      return;
    }
    const ownership = OWNERSHIPS.includes(saved.ownership) ? saved.ownership : "user";
    const rec = {
      id: saved.id,
      kind,
      uuid,
      name: String(saved.name ?? ""),
      createdBy: saved.createdBy === "agent" ? "agent" : "user",
      ownership,
      reason: ownership === "agentDelegatedToUser" ? (saved.reason ?? "manual_takeover") : null,
      ended: ownership === "user" && !!saved.ended,
      paused: false,
      stateText: String(saved.stateText ?? ""),
      profileId: saved.profileId ?? DEFAULT_PROFILE_ID,
      userContextId: saved.userContextId ?? 0,
      createdAt: saved.createdAt ?? Date.now(),
      lastNamedAt: Number.isFinite(saved.lastNamedAt) ? saved.lastNamedAt : null,
      handedToUser: !!saved.handedToUser,
      handBackVia: typeof saved.handBackVia === "string" && saved.handBackVia ? saved.handBackVia : null,
      openerCut: !!saved.openerCut,
      handBackReloaded: Array.isArray(saved.handBackReloaded) ? saved.handBackReloaded.filter(l => typeof l === "string") : [],
      ledger: { ...newLedger(), ...pick(saved.ledger, ["nextLabel", "usedLabels", "releasedLabels"]) },
      window: null,
    };
    this.#byId.set(rec.id, rec);
    if (kind === "workspace") {
      this.#byUuid.set(uuid, rec);
    }
    this.#nextId = Math.max(this.#nextId, rec.id + 1);
  }

  // ---------------------------------------------------------------------------
  // Records

  /** Zen's workspace list (identical in every synced window). */
  #workspaces() {
    const win = hostWindow();
    if (!win) {
      throw new ZenError("ZEN_BROWSER_UNAVAILABLE", "no browser window with workspaces is open");
    }
    return win.gZenWorkspaces.getWorkspaces();
  }

  #recordFor(ws) {
    let rec = this.#byUuid.get(ws.uuid);
    if (!rec) {
      const userContextId = ws.containerTabId ?? 0;
      rec = {
        id: this.#nextId++,
        kind: "workspace",
        uuid: ws.uuid,
        name: ws.name,
        createdBy: "user",
        ownership: "user",
        reason: null,
        ended: false,
        paused: false,
        stateText: "",
        profileId: profileIdFor(userContextId),
        userContextId,
        createdAt: Date.now(),
        ledger: newLedger(),
        window: null,
      };
      this.#byId.set(rec.id, rec);
      this.#byUuid.set(rec.uuid, rec);
      this.#persist();
    }
    rec.gone = false;
    if (rec.name !== ws.name) {
      rec.name = ws.name;
      this.#persist();
    }
    return rec;
  }

  /**
   * Sync records with Zen's workspace list; returns the live workspace
   * records in Zen's order. The Agents Space has no record of its own.
   */
  refresh() {
    const live = [];
    const seen = new Set();
    for (const ws of this.#workspaces()) {
      seen.add(ws.uuid);
      if (ws.uuid === this.#agents.uuid) {
        this.#noteAgentsSpace(ws);
        continue;
      }
      if (hasAgentsMark(ws)) {
        // An Agents Space zenius made, back from an older session file
        // (healAgentsSpace): never the user's.
        continue;
      }
      live.push(this.#recordFor(ws));
    }
    if (this.#agents.uuid && !seen.has(this.#agents.uuid)) {
      // The user deleted the Agents Space, and its tabs with it: its tasks
      // end, as after the panel's Stop.
      this.#agents.uuid = null;
      this.#persist();
      for (const rec of this.#byId.values()) {
        if (rec.kind === "task" && this.isAgentTask(rec)) {
          this.setOwnership(rec, "user", { source: "user" });
        }
      }
    }
    for (const rec of this.#byId.values()) {
      if (rec.kind === "task") {
        continue;
      }
      if (!seen.has(rec.uuid) && !rec.gone) {
        // The user deleted the workspace: waiters fail with NOT_FOUND.
        rec.gone = true;
        rec.paused = false;
        this.#wake(rec);
        this.#persist();
      }
    }
    return live;
  }

  /**
   * Create a task in the Agents Space, and the Space itself if needed,
   * without switching any window.
   *
   * @param {{name: string, profileId?: string}} opts
   */
  async create({ name, profileId }) {
    const userContextId = userContextIdFor(profileId);
    const win = hostWindow();
    if (!win) {
      throw new ZenError("ZEN_BROWSER_UNAVAILABLE", "no browser window with workspaces is open");
    }
    await win.gZenWorkspaces.promiseInitialized;
    // Number the existing workspaces first, so ids follow Zen's order.
    this.refresh();
    return this.#createTask(win, name, userContextId);
  }

  /** A task in the Agents Space, which is created first if needed. */
  async #createTask(win, name, userContextId) {
    const uuid = await this.#ensureAgentsSpace(win);
    const rec = {
      id: this.#nextId++,
      kind: "task",
      uuid,
      name,
      createdBy: "agent",
      ownership: "agent",
      reason: null,
      ended: false,
      paused: false,
      stateText: "",
      profileId: profileIdFor(userContextId),
      userContextId,
      createdAt: Date.now(),
      lastNamedAt: Date.now(),
      handedToUser: false,
      handBackVia: null,
      openerCut: false,
      handBackReloaded: [],
      ledger: newLedger(),
      window: win,
    };
    this.#byId.set(rec.id, rec);
    this.#persist();
    this.#emit("spaceCreated", {
      space: rec.id,
      name: rec.name,
      createdBy: rec.createdBy,
      ownership: rec.ownership,
      profileId: rec.profileId,
    });
    return rec;
  }

  /** The Agents Space's uuid, creating it, unswitched, with its saved name and icon. */
  #ensureAgentsSpace(win) {
    const known = this.#agents.uuid && win.gZenWorkspaces.getWorkspaceFromId(this.#agents.uuid);
    if (known) {
      return Promise.resolve(known.uuid);
    }
    this.#agentsCreating ??= (async () => {
      // dontChange=true, as for any agent workspace: no window switches.
      const ws = await win.gZenWorkspaces.createAndSaveWorkspace(this.#agents.name, this.#agents.icon ?? undefined, true, 0);
      if (!ws) {
        throw new ZenError("ZEN_BROWSER_UNAVAILABLE", "Zen refused to create a workspace (workspaces disabled?)");
      }
      // ws is Zen's own object for the Space: the mark goes where Zen saves it.
      ws[MARK_FIELD] = AGENTS_MARK;
      win.gZenWorkspaces.saveWorkspace(ws);
      this.#agents.uuid = ws.uuid;
      // A refresh() while Zen created it took it for a user's workspace.
      const stray = this.#byUuid.get(ws.uuid);
      if (stray) {
        this.#byUuid.delete(ws.uuid);
        this.#byId.delete(stray.id);
      }
      this.#persist();
      saveSessionWhen(uuids => uuids.has(ws.uuid));
      return ws.uuid;
    })().finally(() => {
      this.#agentsCreating = null;
    });
    return this.#agentsCreating;
  }

  /** Keep the name and icon the user gave the Agents Space. */
  #noteAgentsSpace(ws) {
    const icon = typeof ws.icon === "string" && ws.icon ? ws.icon : null;
    if (ws.name !== this.#agents.name || icon !== this.#agents.icon) {
      this.#agents.name = ws.name || AGENTS_SPACE_NAME;
      this.#agents.icon = icon;
      this.#persist();
    }
  }

  /** The Agents Space: `{uuid, name, icon}`, `uuid` null while it doesn't exist. */
  get agentsSpace() {
    return { ...this.#agents };
  }

  /**
   * A client named this record (any method with `space`): the auto-close's
   * clock. Saved at most once a minute per task, which a 72-hour rule
   * doesn't feel.
   */
  noteNamed(rec, now = Date.now()) {
    const saved = rec.lastNamedAt ?? 0;
    rec.lastNamedAt = now;
    if (rec.kind === "task" && now - saved > 60_000) {
      this.#persist();
    }
  }

  /** Is this the Agents Space's workspace? */
  isAgentsSpace(uuid) {
    return !!uuid && uuid === this.#agents.uuid;
  }

  /**
   * Remove the Agents Space once it holds no tab and no window shows it
   * (SPEC §3.4). Its name and icon stay for next time.
   *
   * @returns {boolean} whether it was removed
   */
  maybeRemoveAgentsSpace() {
    const uuid = this.#agents.uuid;
    this.#removalWaits = false;
    if (!uuid || tabsInWorkspace(uuid).length) {
      return false;
    }
    if (workspaceWindows().some(win => win.gZenWorkspaces.activeWorkspace === uuid)) {
      // Empty and shown (the user closed its last tab there): it goes when
      // that window shows another Space (the service's TabSelect).
      this.#removalWaits = true;
      return false;
    }
    const win = hostWindow();
    const ws = win?.gZenWorkspaces.getWorkspaceFromId(uuid);
    if (ws) {
      this.#noteAgentsSpace(ws);
    }
    // Before Zen's removal, so refresh() doesn't take it for the user's.
    this.#agents.uuid = null;
    this.#persist();
    if (ws) {
      win.gZenWorkspaces.removeWorkspace(uuid);
      saveSessionWhen(uuids => !uuids.has(uuid));
    }
    return true;
  }

  /**
   * At a start, before restored tabs go back to their tasks. Zen restores
   * its Space list from its own session file, which can be older than
   * spaces.json (saveSessionWhen): an Agents Space zenius removed can come
   * back, unrecorded, holding the tabs it had then. By the mark:
   * - the recorded Agents Space gets the mark if it lacks it (made before
   *   there was one);
   * - with no Agents Space, a marked Space that holds tabs, or that a window
   *   shows, becomes it, as restored tabs come back to their tasks;
   * - any other marked Space that's empty, and that no window shows, goes;
   * - one with tabs stays, renamed "<name> (old)" once so the user can tell
   *   it from the Agents Space; zenius doctor lists it (strayAgentsSpaces).
   * A Space without the mark is never touched, whatever its name.
   *
   * @returns {{adopted: string|null, removed: string[], left: string[], renamed?: boolean}}
   */
  healAgentsSpace() {
    const out = { adopted: null, removed: [], left: [] };
    const win = hostWindow();
    if (!win?.gZenWorkspaces) {
      return out;
    }
    const all = win.gZenWorkspaces.getWorkspaces();
    let current = (this.#agents.uuid && all.find(ws => ws.uuid === this.#agents.uuid)) || null;
    if (current && !hasAgentsMark(current)) {
      current[MARK_FIELD] = AGENTS_MARK;
      win.gZenWorkspaces.saveWorkspace(current);
    }
    const shown = uuid => workspaceWindows().some(w => w.gZenWorkspaces.activeWorkspace === uuid);
    const others = all.filter(ws => ws !== current && hasAgentsMark(ws));
    if (!current) {
      const pick = others.find(ws => tabsInWorkspace(ws.uuid).length) ?? others.find(ws => shown(ws.uuid));
      if (pick) {
        current = pick;
        this.#agents.uuid = pick.uuid;
        this.#noteAgentsSpace(pick);
        this.#persist();
        out.adopted = pick.uuid;
      }
    }
    for (const ws of others) {
      if (ws === current) {
        continue;
      }
      if (!tabsInWorkspace(ws.uuid).length && !shown(ws.uuid)) {
        win.gZenWorkspaces.removeWorkspace(ws.uuid);
        out.removed.push(ws.uuid);
      } else {
        // The user decides what goes. A name that tells it from the Agents
        // Space, which likely has the same one (the manager's call: it's
        // zenius's own Space).
        if (!(ws.name ?? "").endsWith(OLD_SUFFIX)) {
          ws.name = `${ws.name || this.#agents.name}${OLD_SUFFIX}`;
          win.gZenWorkspaces.saveWorkspace(ws);
          out.renamed = true;
        }
        out.left.push(ws.uuid);
      }
    }
    if (out.removed.length || out.renamed) {
      saveSessionWhen(uuids => out.removed.every(uuid => !uuids.has(uuid)));
    }
    return out;
  }

  /**
   * Marked Spaces other than the Agents Space: ones a start left as they
   * were, since they hold tabs (healAgentsSpace). zenius doctor lists them,
   * so the user can look and remove them. `position` is the Space's place in
   * Zen's list, 1 first, as the Space switcher shows them: two Spaces can
   * both be named Agents, and removing the wrong one would close the pages
   * the user kept. No tab titles: agents run doctor.
   *
   * @returns {{uuid: string, name: string, tabs: number, position: number}[]}
   */
  strayAgentsSpaces() {
    const win = hostWindow();
    const all = win?.gZenWorkspaces?.getWorkspaces() ?? [];
    return all
      .map((ws, i) => ({ ws, position: i + 1 }))
      .filter(({ ws }) => hasAgentsMark(ws) && ws.uuid !== this.#agents.uuid)
      .map(({ ws, position }) => ({ uuid: ws.uuid, name: ws.name ?? "", tabs: tabsInWorkspace(ws.uuid).length, position }));
  }

  /**
   * Forget a task's record once finish, or the auto-close, closed its tabs
   * (Pages.closeTab): the Agents Space goes once nothing is left in it.
   * finish never removes the user's workspace (SPEC 3.4). Only test cleanup
   * passes a workspace record: its workspace goes too, unless a window
   * shows it (Zen would move that window, I1). Close its tabs first: Zen's
   * removal runs beforeunload handlers, and an agent page's prompt would
   * hold it up.
   */
  remove(rec) {
    const win = hostWindow(rec.window);
    rec.gone = true;
    rec.paused = false;
    this.#wake(rec);
    this.#byId.delete(rec.id);
    if (rec.kind === "task") {
      this.#persist();
      this.maybeRemoveAgentsSpace();
      return;
    }
    this.#byUuid.delete(rec.uuid);
    this.#persist();
    const shown = workspaceWindows().some(w => w.gZenWorkspaces.activeWorkspace === rec.uuid);
    if (!shown && win?.gZenWorkspaces.getWorkspaceFromId(rec.uuid)) {
      // Synchronous apart from its promise, which waits for a UI update
      // event that a headless window may never send.
      win.gZenWorkspaces.removeWorkspace(rec.uuid);
    }
  }

  /**
   * @param {number|string} id
   * @returns {SpaceRecord}
   */
  get(id) {
    const numeric = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
    if (!Number.isInteger(numeric)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `space must be a numeric task-space id, got ${JSON.stringify(id)}`);
    }
    let rec = this.#byId.get(numeric);
    if (!rec || rec.gone) {
      this.refresh();
      rec = this.#byId.get(numeric);
    }
    if (!rec || rec.gone) {
      if (this.#notRestored.includes(numeric)) {
        throw new ZenError(
          "ZEN_TASK_SPACE_NOT_FOUND",
          `Task space ${numeric} didn't come back when Zen restarted: none of its tabs was restored. Start a new task.`,
          { space: numeric, reason: "not_restored" }
        );
      }
      throw new ZenError("ZEN_TASK_SPACE_NOT_FOUND", `Task space not found: ${numeric}`, { space: numeric });
    }
    return rec;
  }

  /**
   * The restart rebuild found none of this task's tabs: remove it, which
   * frees its name, and remember its id so a call naming it fails at once.
   */
  removeNotRestored(rec) {
    this.#notRestored = [...this.#notRestored.filter(id => id !== rec.id), rec.id].slice(-NOT_RESTORED_KEPT);
    this.remove(rec);
  }

  /** The record for an id without refreshing or throwing; null if unknown. */
  peek(id) {
    return this.#byId.get(id) ?? null;
  }

  /** The record for a workspace uuid, without refreshing. */
  peekUuid(uuid) {
    return this.#byUuid.get(uuid) ?? null;
  }

  /** Every record we know, including ones whose workspace is gone. */
  records() {
    return [...this.#byId.values()];
  }

  /** Live records: the tasks, then the workspaces in Zen's order. */
  live() {
    const workspaces = this.refresh();
    const tasks = [...this.#byId.values()].filter(rec => rec.kind === "task" && !rec.gone);
    return [...tasks, ...workspaces];
  }

  /** Live records with this exact name. */
  findByName(name) {
    return this.live().filter(rec => rec.name === name);
  }

  /** Rename the workspace (claim with a name); Zen propagates it to every window. */
  async rename(rec, name) {
    if (rec.name === name) {
      return;
    }
    if (rec.kind === "task") {
      rec.name = name;
      this.#persist();
      this.#emit("spaceChanged", { space: rec.id, name });
      return;
    }
    const win = hostWindow(rec.window);
    const ws = win?.gZenWorkspaces.getWorkspaceFromId(rec.uuid);
    if (ws) {
      await win.gZenWorkspaces.saveWorkspace({ ...ws, name });
    }
    rec.name = name;
    this.#persist();
    this.#emit("spaceChanged", { space: rec.id, name });
  }

  /**
   * Titles of the most recently used tabs in a space, for listings. None for
   * a workspace of the user's that no agent claimed: the titles of the
   * user's own tabs (mail, bank, health) would reach the agent's model
   * provider (I2; the manager's decision on the method audit, item 5).
   * Tasks, and workspaces claimed now or before, keep them.
   */
  recentTabTitles(rec, limit = 5) {
    if (rec.kind === "workspace" && rec.ownership === "user" && !rec.ended) {
      return [];
    }
    // The service's Pages.tabsOf, which leaves out the user's own tab.
    const tabs = this.tabsOf ? this.tabsOf(rec) : rec.kind === "task" ? [] : tabsInWorkspace(rec.uuid);
    return tabs
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .slice(0, limit)
      .map(tab => tab.label);
  }

  get windowCount() {
    return workspaceWindows().length;
  }

  // ---------------------------------------------------------------------------
  // Ownership state machine

  /** An agent task is in progress here (the agent drives it, or handed it to the user). */
  isAgentTask(rec) {
    return rec.ownership === "agent" || rec.ownership === "agentDelegatedToUser";
  }

  /**
   * Hold or release agent actions while a takeover prompt is open.
   * Emits `spaceChanged {space, paused}`.
   *
   * @param {SpaceRecord} rec
   * @param {boolean} paused
   */
  setPaused(rec, paused) {
    paused = !!paused;
    if (rec.paused === paused) {
      return;
    }
    rec.paused = paused;
    this.#emit("spaceChanged", { space: rec.id, paused });
    this.#wake(rec);
  }

  /**
   * Emits `spaceChanged {space, ownership, reason, source, via?}`.
   *
   * @param {SpaceRecord} rec
   * @param {"agent"|"agentDelegatedToUser"|"user"} ownership
   * @param {{reason?: string|null, source?: "agent"|"user"|"permission"}} [opts]
   *   reason: Ego's key ("manual_takeover", "location", …); only kept for
   *     agentDelegatedToUser, where it defaults to "manual_takeover"
   *   source: who decided: "agent" (an RPC), "user" (prompt or panel),
   *     "permission" (a permission prompt)
   *   via: where the user decided, when the agent should know. No caller
   *     sets it since zen-ux dropped its own-tab notice ("ownTab",
   *     f740de1); the reports stay until the SDK drops the field
   *   reloaded, carried: for agentDelegatedToUser, what the hold's quiet
   *     load did to the page the user holds (modules/handoff.sys.mjs):
   *     "reload" or "get" when it loaded afresh, and whether a field came
   *     back filled; zen-ux's card says so
   */
  setOwnership(rec, ownership, { reason = null, source = "agent", via = null, reloaded = null, carried = false } = {}) {
    if (!OWNERSHIPS.includes(ownership)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `unknown ownership ${JSON.stringify(ownership)}`);
    }
    const nextReason = ownership === "agentDelegatedToUser" ? reason || "manual_takeover" : null;
    // A task that leaves the agent for "user" has ended (Ego's INACTIVE);
    // claiming starts a new one.
    const ended = ownership === "user" ? rec.ended || this.isAgentTask(rec) : false;
    if (rec.ownership === ownership && rec.reason === nextReason && rec.ended === ended) {
      return;
    }
    rec.ownership = ownership;
    rec.reason = nextReason;
    rec.ended = ended;
    if (ownership === "agentDelegatedToUser") {
      // The auto-close spares a task the user ever held (SPEC §3.4).
      rec.handedToUser = true;
      // A new handoff: the last hand back's via is spent.
      rec.handBackVia = null;
    } else if (ownership === "agent" && source === "user") {
      // The agent learns it from its next takeOver or waitForControl.
      rec.handBackVia = typeof via === "string" && via ? via : null;
    }
    this.#persist();
    const held = ownership === "agentDelegatedToUser";
    this.#emit("spaceChanged", {
      space: rec.id,
      ownership,
      reason: nextReason,
      source,
      ...(typeof via === "string" && via ? { via } : {}),
      ...(held && (reloaded === "reload" || reloaded === "get") ? { reloaded } : {}),
      ...(held && carried ? { carried: true } : {}),
    });
    this.#wake(rec);
  }

  /**
   * What the agent learns at the hand back besides via: the task's pages
   * zenius loaded afresh since the agent last had control (labels), and
   * whether the page the user held lost its opener meanwhile (openerCut).
   * The hold's start clears both (modules/service.sys.mjs holdForUser).
   */
  noteReloaded(rec, labels) {
    const add = labels.filter(label => typeof label === "string" && !rec.handBackReloaded?.includes(label));
    if (add.length) {
      rec.handBackReloaded = [...(rec.handBackReloaded ?? []), ...add];
      this.#persist();
    }
  }

  noteOpenerCut(rec) {
    if (!rec.openerCut) {
      rec.openerCut = true;
      this.#persist();
    }
  }

  clearHandBackNotes(rec) {
    if (rec.openerCut || rec.handBackReloaded?.length) {
      rec.openerCut = false;
      rec.handBackReloaded = [];
      this.#persist();
    }
  }

  /**
   * The hand back's notes, once, as spaces.takeOver and
   * spaces.waitForControl report them: {openerCut: true} and {reloaded}
   * only when there's something to say.
   *
   * @returns {{openerCut?: true, reloaded?: string[]}}
   */
  takeHandBackNotes(rec) {
    const notes = {
      ...(rec.openerCut ? { openerCut: true } : {}),
      ...(rec.handBackReloaded?.length ? { reloaded: [...rec.handBackReloaded] } : {}),
    };
    this.clearHandBackNotes(rec);
    return notes;
  }

  /**
   * The last hand back's via, once (none since zen-ux dropped "ownTab"): spaces.takeOver and
   * spaces.waitForControl report it with the control it gave back.
   *
   * @returns {string|null}
   */
  takeHandBackVia(rec) {
    const via = rec.handBackVia ?? null;
    if (via) {
      rec.handBackVia = null;
      this.#persist();
    }
    return via;
  }

  /**
   * The agent's progress text (Ego's setAgentTaskState). Emits
   * `spaceChanged {space, stateText}`.
   */
  setStateText(rec, text) {
    text = String(text ?? "");
    if (rec.stateText === text) {
      return;
    }
    rec.stateText = text;
    this.#persist();
    this.#emit("spaceChanged", { space: rec.id, stateText: text });
  }

  /**
   * The control gate (I3). Synchronous when nothing has to wait, so a handler
   * still runs in frame order.
   *
   * @param {SpaceRecord} rec
   * @param {"mutate"|"read"|"task"} [access]
   *   mutate: the agent must control the space; waits while a takeover
   *     prompt is open
   *   read: the agent must control the space; doesn't wait for the prompt
   *   task: an agent task must be in progress, even one handed to the user
   *     (handOff, setState)
   * @returns {null|Promise<void>} null when the call may go ahead now; a
   *   promise that settles when the prompt closes (resolves if the agent
   *   keeps control, rejects otherwise). No timeout of its own.
   * @throws {ZenError} ZEN_TASK_SPACE_USER_IN_CONTROL with data.reason,
   *   ZEN_TASK_SPACE_INACTIVE when the task ended, ZEN_TASK_SPACE_NOT_FOUND
   */
  gate(rec, access = "mutate") {
    if (rec.gone) {
      throw new ZenError("ZEN_TASK_SPACE_NOT_FOUND", `Task space not found: ${rec.id}`, { space: rec.id });
    }
    if (rec.ownership !== "agent" && !(access === "task" && rec.ownership === "agentDelegatedToUser")) {
      throw controlError(rec);
    }
    if (rec.paused && access === "mutate") {
      return this.#nextChange(rec).then(() => this.gate(rec, access) ?? undefined);
    }
    return null;
  }

  /**
   * Resolve once the agent controls the space (ownership `agent`, no prompt
   * open), without taking control. A space whose task ended fails at once
   * with INACTIVE, as Ego's probe does.
   *
   * @param {SpaceRecord} rec
   * @param {{timeout?: number}} [opts]
   */
  async waitForControl(rec, { timeout = CONTROL_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeout;
    while (true) {
      if (rec.gone) {
        throw new ZenError("ZEN_TASK_SPACE_NOT_FOUND", `Task space not found: ${rec.id}`, { space: rec.id });
      }
      if (rec.ownership === "user" && rec.ended) {
        throw controlError(rec);
      }
      if (rec.ownership === "agent" && !rec.paused) {
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new ZenError("ZEN_TIMEOUT", `task.waitForControl timed out after ${timeout}ms`, {
          space: rec.id,
          ownership: rec.ownership,
          reason: rec.reason,
        });
      }
      await this.#nextChange(rec, left);
    }
  }

  /** Resolves on the next ownership/paused change of `rec` (or after `timeout` ms). */
  #nextChange(rec, timeout = 0) {
    return new Promise(resolve => {
      let set = this.#waiters.get(rec.id);
      if (!set) {
        set = new Set();
        this.#waiters.set(rec.id, set);
      }
      let timer = 0;
      const wake = () => {
        set.delete(wake);
        if (set.size === 0 && this.#waiters.get(rec.id) === set) {
          this.#waiters.delete(rec.id);
        }
        lazy.clearTimeout(timer);
        resolve();
      };
      set.add(wake);
      if (timeout > 0) {
        timer = lazy.setTimeout(wake, timeout);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // The user's say over claims and takeovers (the manager's decisions on the
  // method audit, item 6; SPEC §3.4)

  /**
   * The user's real input reached one of the record's tabs, whoever controls
   * it (zen-ux's takeover detector). Kept in memory only.
   *
   * @param {SpaceRecord} rec
   */
  noteUserInput(rec) {
    if (rec && !rec.gone) {
      rec.lastUserInputAt = Date.now();
    }
  }

  /**
   * Refuse an agent's takeOver of a task handed to the user, or its claim of
   * one, until USER_INPUT_QUIET_MS after the user's last real input there.
   *
   * @param {SpaceRecord} rec
   * @throws {ZenError} ZEN_TASK_SPACE_USER_IN_CONTROL
   */
  checkUserQuiet(rec, now = Date.now()) {
    const ago = now - (rec.lastUserInputAt ?? -Infinity);
    if (ago >= USER_INPUT_QUIET_MS) {
      return;
    }
    const retryAfterMs = Math.ceil(USER_INPUT_QUIET_MS - ago);
    // What happened only: zen-sdk's error guide says what to do next.
    throw new ZenError(
      "ZEN_TASK_SPACE_USER_IN_CONTROL",
      `The user is working in task space ${rec.id}: their last input there was ${(ago / 1000).toFixed(1)} s ago, ` +
        `and it stays theirs until ${USER_INPUT_QUIET_MS / 1000} s after it.`,
      { space: rec.id, reason: rec.reason || "manual_takeover", userInputMsAgo: Math.round(ago), retryAfterMs }
    );
  }

  /** Claims waiting for the user's answer, oldest first, for a window that opens meanwhile (zen-ux). */
  pendingClaims() {
    return [...this.#asks.values()].map(({ id, space, name, client, until }) => ({ id, space, name, client, until }));
  }

  /**
   * The user answered a claim's prompt (zen-ux: a real click on Allow or Deny).
   *
   * @param {string} id  from claimAsked
   * @param {boolean} allow
   * @returns {boolean} whether it settled a pending ask
   */
  answerClaim(id, allow) {
    for (const ask of this.#asks.values()) {
      if (ask.id === id) {
        this.#settleClaim(ask, allow === true ? "allow" : "deny");
        return true;
      }
    }
    return false;
  }

  /**
   * Wait for the user to let an agent claim `rec`, a workspace of theirs or
   * an ended task (SPEC §3.4). zen-ux shows its prompt at claimAsked and
   * calls answerClaim; claimSettled ends it. One ask per space: a later
   * claim of it joins the first, and its deadline.
   *
   * @param {SpaceRecord} rec
   * @param {{client?: unknown, timeout?: number, conn?: object|null}} [opts]
   *   client: the name the client gives itself; conn: the claim's
   *   connection, whose closing withdraws the claim
   * @returns {Promise<void>} resolves on Allow
   * @throws {ZenError} ZEN_TASK_SPACE_CLAIM_DENIED on Deny or at the
   *   deadline; ZEN_TASK_SPACE_NOT_FOUND if the space goes meanwhile
   */
  askClaim(rec, { client = null, timeout = CONTROL_WAIT_TIMEOUT_MS, conn = null } = {}) {
    let ask = this.#asks.get(rec.id);
    if (!ask) {
      ask = {
        id: `claim-${rec.id}-${++this.#askCount}`,
        space: rec.id,
        name: rec.name,
        client: clientLabel(client),
        until: Date.now() + timeout,
        waiters: new Set(),
        timer: 0,
      };
      this.#asks.set(rec.id, ask);
      ask.timer = lazy.setTimeout(() => this.#settleClaim(ask, "timeout"), timeout);
      const { id, space, name, client: label, until } = ask;
      this.onLocalEvent?.("claimAsked", { id, space, name, client: label, until });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, conn, onClose: null };
      if (conn?.state) {
        // The client went away: its claim goes, and the ask once nobody waits.
        waiter.onClose = () => {
          ask.waiters.delete(waiter);
          reject(claimError(ask, "gone", this.#byId.get(ask.space)));
          if (ask.waiters.size === 0) {
            this.#settleClaim(ask, "gone");
          }
        };
        (conn.state.onClose ??= []).push(waiter.onClose);
      }
      ask.waiters.add(waiter);
    });
  }

  /** @param {"allow"|"deny"|"timeout"|"gone"} verdict */
  #settleClaim(ask, verdict) {
    if (this.#asks.get(ask.space) !== ask) {
      return;
    }
    this.#asks.delete(ask.space);
    lazy.clearTimeout(ask.timer);
    const rec = this.#byId.get(ask.space);
    for (const waiter of ask.waiters) {
      const hooks = waiter.conn?.state?.onClose;
      const i = hooks && waiter.onClose ? hooks.indexOf(waiter.onClose) : -1;
      if (i >= 0) {
        hooks.splice(i, 1);
      }
      if (verdict === "allow") {
        waiter.resolve();
      } else {
        waiter.reject(claimError(ask, verdict, rec));
      }
    }
    ask.waiters.clear();
    this.onLocalEvent?.("claimSettled", { id: ask.id, verdict });
  }

  #wake(rec) {
    if (rec.gone && this.#asks.has(rec.id)) {
      this.#settleClaim(this.#asks.get(rec.id), "gone");
    }
    const set = this.#waiters.get(rec.id);
    if (set) {
      for (const wake of [...set]) {
        wake();
      }
    }
  }
}

/** Why a claim that waited for the user failed. */
function claimError(ask, verdict, rec) {
  if (verdict === "gone" && (!rec || rec.gone)) {
    return new ZenError("ZEN_TASK_SPACE_NOT_FOUND", `Task space not found: ${ask.space}`, { space: ask.space });
  }
  // What happened only: zen-sdk's error guide says what to do next.
  const messages = {
    deny: `The user said no, in the browser, to an agent working in their Space "${ask.name}".`,
    timeout: `Nobody answered, in the browser, the request to work in Space "${ask.name}".`,
    gone: "The claim's connection closed.",
  };
  return new ZenError("ZEN_TASK_SPACE_CLAIM_DENIED", messages[verdict] ?? messages.deny, {
    space: ask.space,
    verdict,
  });
}

/** The error an agent call gets when it doesn't control `rec`. */
export function controlError(rec) {
  if (rec.ownership === "agentDelegatedToUser") {
    const reason = rec.reason || "manual_takeover";
    return new ZenError("ZEN_TASK_SPACE_USER_IN_CONTROL", `Task space ${rec.id} is under user control (${reason})`, {
      space: rec.id,
      reason,
    });
  }
  if (rec.ended) {
    return new ZenError(
      "ZEN_TASK_SPACE_INACTIVE",
      `Task space ${rec.id} is no longer assigned to the agent: its task ended. Claim it only when the user asks you to continue there.`,
      { space: rec.id }
    );
  }
  // A user Space the agent never claimed: Ego reports the user in control.
  return new ZenError(
    "ZEN_TASK_SPACE_USER_IN_CONTROL",
    `Task space ${rec.id} belongs to the user. Claim it only when the user asks you to work there.`,
    { space: rec.id }
  );
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}
