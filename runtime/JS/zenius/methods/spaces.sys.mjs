// spaces.* methods (the core): Ego's task-space lifecycle on Zen workspaces.
// Ownership changes go through modules/spaces.sys.mjs. The dispatcher's gate
// checks control before these run, by the classes declared below.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { CONTROL_WAIT_TIMEOUT_MS, profileName } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";

function describe(ctx, rec) {
  return {
    id: rec.id,
    name: rec.name,
    createdBy: rec.createdBy,
    ownership: rec.ownership,
    profileId: rec.profileId,
    profileName: profileName(rec.userContextId),
    recentTabTitles: ctx.spaces.recentTabTitles(rec),
    ...(rec.source ? { source: rec.source } : {}),
    // A waitForControl call waits on it now, any client's (zenius wait).
    ...(rec.agentWaiting ? { agentWaiting: true } : {}),
  };
}

/**
 * The agent's live Pages in a space with their tab ids, so the SDK knows
 * each page's targetId without another call (Ego keeps them in its ledger).
 */
function pageRefs(ctx, rec) {
  return ctx.pages.list(rec.id).map(page => ({
    label: page.label,
    tab: ctx.pages.tabId(ctx.pages.tabFor(page)),
    openedBy: page.openedBy,
  }));
}

/** Where new agent tabs of a claimed space go: the window that shows its current tab. */
function adoptWindow(rec, userPageTab) {
  const win = userPageTab?.ownerDocument?.defaultView;
  if (win?.gZenWorkspaces && !win.closed) {
    rec.window = win;
  }
}

// Gate classes (SPI.md, "Dispatch"): access for the control gate (I3), i5
// for the web-content gate (I5).
export const access = {
  "spaces.list": "none",
  "spaces.create": "none",
  "spaces.open": "read",
  "spaces.claim": "none",
  "spaces.takeOver": "none",
  "spaces.handOff": "task",
  "spaces.waitForControl": "none",
  "spaces.setState": "task",
  "spaces.finish": "mutate",
};

export const i5 = {
  "spaces.list": "none",
  "spaces.create": "none",
  "spaces.open": "none",
  "spaces.claim": "none",
  "spaces.takeOver": "none",
  "spaces.handOff": "none",
  "spaces.waitForControl": "none",
  "spaces.setState": "none",
  "spaces.finish": "none",
};

/**
 * The agent takes a held task back by its own call: first what the user's
 * Resume does before the agent gets control (the UI's beforeHandBack: the
 * pages the user typed a secret into load afresh). The user may act
 * meanwhile, so the state is checked again after.
 */
async function handBack(ctx, rec) {
  // A secret step's tab goes blank before anything else of the hand back.
  await ctx.service.blankSecretSteps(rec);
  await ctx.service.beforeHandBack(rec);
  if (rec.gone || rec.ownership === "user") {
    ctx.spaces.gate(rec, "task");
  }
  if (rec.ownership === "agentDelegatedToUser") {
    ctx.spaces.checkUserQuiet(rec);
  }
}

export const methods = {
  "spaces.list": async ctx => ({
    // Only the agent's own spaces list their Pages: under the user's control
    // the agent doesn't read a space (I3).
    taskSpaces: ctx.spaces
      .live()
      .map(rec => (rec.ownership === "agent" ? { ...describe(ctx, rec), pages: pageRefs(ctx, rec) } : describe(ctx, rec))),
  }),

  // Ego's taskSpace() for a new name: the space starts with managed page p1.
  "spaces.create": async (ctx, params) => {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.create needs a non-empty name");
    }
    const name = params.name.trim();
    const clash = ctx.spaces.findByName(name)[0];
    if (clash) {
      throw new ZenError(
        "ZEN_TASK_SPACE_NAME_IN_USE",
        `A task space named ${JSON.stringify(name)} already exists (id ${clash.id}).`,
        { spaceId: clash.id, ownership: clash.ownership }
      );
    }
    // source: who drives the task, which the sidebar's list of tasks shows.
    const rec = await ctx.spaces.create({ name, profileId: params.profileId, source: params.source });
    ctx.pages.open(rec);
    return {
      id: rec.id,
      name: rec.name,
      ownership: rec.ownership,
      profileId: rec.profileId,
      pages: pageRefs(ctx, rec),
    };
  },

  "spaces.open": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    return { id: rec.id, name: rec.name, ownership: rec.ownership };
  },

  // After the user approved: a user Space, or one whose task ended, becomes
  // the agent's. Its existing tabs stay unmanaged until adopted.
  "spaces.claim": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    if (params.name !== undefined && typeof params.name !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.claim name must be a string");
    }
    // The name the client gives itself, for the claim prompt (the SDK fills it).
    if (params.client !== undefined && params.client !== null && typeof params.client !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.claim client must be a string");
    }
    const timeout = params.timeout ?? CONTROL_WAIT_TIMEOUT_MS;
    if (typeof timeout !== "number" || !(timeout >= 0)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.claim timeout must be a number of ms");
    }
    if (rec.ownership === "agentDelegatedToUser") {
      // The agent's own task, handed to the user: as takeOver.
      ctx.spaces.checkUserQuiet(rec);
      await handBack(ctx, rec);
    } else if (rec.ownership === "user") {
      // A workspace of the user's, or an ended task: the user says yes in
      // the browser first (SPEC §3.4).
      await ctx.spaces.askClaim(rec, { client: params.client ?? null, timeout, conn: ctx.conn });
      ctx.resolveSpace(params);
    }
    // The boundary and the ownership change happen in one synchronous step:
    // the user's next click can't land between them.
    const userPage = ctx.pages.userPage(rec);
    if (rec.ownership !== "agent") {
      ctx.pages.markBoundary(rec);
    }
    if (params.source !== undefined) {
      ctx.spaces.setSource(rec, params.source);
    }
    ctx.spaces.setOwnership(rec, "agent", { source: "agent" });
    adoptWindow(rec, userPage && ctx.pages.findTab(rec, userPage.tab));
    const name = params.name?.trim();
    if (name) {
      await ctx.spaces.rename(rec, name);
    }
    return { id: rec.id, name: rec.name, ownership: rec.ownership, userPage, pages: pageRefs(ctx, rec) };
  },

  // After the user approved: control of a delegated agent task comes back.
  "spaces.takeOver": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    if (rec.ownership === "user") {
      throw new ZenError(
        "ZEN_TASK_SPACE_INACTIVE",
        rec.ended
          ? `Task space ${rec.id}'s task ended; takeOver can't resume it. Claim it only when the user asks you to continue there.`
          : `Task space ${rec.id} belongs to the user; takeOver can't take it. Claim it only when the user asks you to work there.`,
        { space: rec.id }
      );
    }
    if (rec.ownership === "agentDelegatedToUser") {
      // Not while the user types there (SPEC §3.4).
      ctx.spaces.checkUserQuiet(rec);
      await handBack(ctx, rec);
    }
    const userPage = ctx.pages.userPage(rec);
    if (rec.ownership === "agentDelegatedToUser") {
      // Tabs the user opened meanwhile stay unmanaged ("unknown").
      ctx.pages.markBoundary(rec);
    }
    ctx.spaces.setOwnership(rec, "agent", { source: "agent" });
    const via = ctx.spaces.takeHandBackVia(rec);
    return {
      id: rec.id,
      name: rec.name,
      ownership: rec.ownership,
      userPage,
      pages: pageRefs(ctx, rec),
      ...(via ? { via } : {}),
      ...ctx.spaces.takeHandBackNotes(rec),
    };
  },

  "spaces.handOff": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    if (params.reason !== undefined && typeof params.reason !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.handOff reason must be a string");
    }
    // The user's step will show a secret (an API key, a token, recovery
    // codes): the hand back blanks the tab before the agent has control.
    if (params.secret !== undefined && typeof params.secret !== "boolean") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.handOff secret must be true or false");
    }
    const secret = params.secret === true;
    // Already with the user (a takeover, or an earlier handOff): keep their reason.
    if (rec.ownership === "agent") {
      const reason = params.reason ?? "manual_takeover";
      const browser = ctx.pages.userTab(rec)?.linkedBrowser ?? null;
      if (browser) {
        // The page the user will hold is made safe for their typing before
        // the card shows (SPI.md, "The hand-off").
        const { reloaded } = await ctx.service.holdForUser(rec, browser, { source: "agent", reason, secret });
        return { id: rec.id, ownership: rec.ownership, ...(reloaded.length ? { reloaded } : {}) };
      }
      ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason, source: "agent" });
    } else if (secret && rec.ownership === "agentDelegatedToUser") {
      const browser = ctx.pages.userTab(rec)?.linkedBrowser ?? null;
      if (browser) {
        ctx.service.noteSecretStep(rec, browser);
      }
    }
    return { id: rec.id, ownership: rec.ownership };
  },

  // Event-driven: `interval` (Ego's polling period) is accepted and unused.
  "spaces.waitForControl": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    const timeout = params.timeout ?? CONTROL_WAIT_TIMEOUT_MS;
    if (typeof timeout !== "number" || !(timeout >= 0)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.waitForControl timeout must be a number of ms");
    }
    if (params.keepNotes !== undefined && typeof params.keepNotes !== "boolean") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.waitForControl keepNotes must be true or false");
    }
    // A wait its client canceled, or whose connection closed, ends at once,
    // and leaves the hand back's notes to the next one.
    const off = ctx.onStopped(() => ctx.spaces.wake(rec));
    try {
      await ctx.spaces.waitForControl(rec, { timeout, stopped: ctx.stopped });
    } finally {
      off();
    }
    // keepNotes: a wait that only tells when control is back (zenius wait).
    // The hand back's notes stay for the task's next takeOver or wait, so
    // another client's wait never takes them from the task's own agent.
    if (params.keepNotes) {
      return { space: rec.id, ownership: rec.ownership };
    }
    const via = ctx.spaces.takeHandBackVia(rec);
    return { ownership: rec.ownership, ...(via ? { via } : {}), ...ctx.spaces.takeHandBackNotes(rec) };
  },

  "spaces.setState": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    if (params.text !== undefined && params.text !== null && typeof params.text !== "string") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "spaces.setState text must be a string");
    }
    ctx.spaces.setStateText(rec, params.text ?? "");
    return { ok: true };
  },

  // Ego's task.finish({keep}): finishTask below.
  "spaces.finish": async (ctx, params) => {
    const rec = ctx.resolveSpace(params);
    const keep = params.keep;
    if (keep !== "all" && !(Array.isArray(keep) && keep.every(label => typeof label === "string"))) {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        "task.finish requires the keep option: \"all\" or a list of page labels. Expected: await task.finish({ keep })"
      );
    }
    return finishTask(ctx, rec, keep);
  },
};

/**
 * Ego's task.finish({keep}) (page-model.ts): close the agent's pages that
 * aren't kept, and close the whole task when nothing is kept and no tab of
 * user or unknown origin would be lost. Otherwise the space goes to the user
 * with the kept pages. A claimed workspace of the user's always goes to the
 * user: finish never removes it (SPEC 3.4). Blank tabs the agent left (page.close() of the last
 * page) are the agent's: they never keep a space open. A tab a window shows
 * closes once the user leaves it (SPEC §3.5): it counts in
 * `pendingCloseCount`. The auto-close calls this too (service.closeIdleTask).
 *
 * @param {object} ctx  a method context
 * @param {object} rec  SpaceRecord
 * @param {"all"|string[]} keep
 */
export function finishTask(ctx, rec, keep) {
  const pages = ctx.pages.list(rec.id);
  const byLabel = new Map(pages.map(page => [page.label, page]));
  const keepLabels = keep === "all" ? new Set(byLabel.keys()) : new Set(keep);
  for (const label of keepLabels) {
    if (!byLabel.has(label)) {
      // Ego's ledger diagnostics ("page p3 was closed"), before closing anything.
      ctx.pages.get(rec, label);
    }
  }
  const toClose = pages.filter(page => page.openedBy === "agent" && !keepLabels.has(page.label));
  const closedManagedLabels = toClose.map(page => page.label);
  const closing = new Set(closedManagedLabels);
  const keptManagedLabels = pages.filter(page => !closing.has(page.label)).map(page => page.label);

  const inventory = ctx.pages.inventory(rec);
  const agentUnmanaged = inventory.filter(item => !item.page && item.openedBy === "agent");
  const agentUnmanagedIds = new Set(agentUnmanaged.map(item => item.id));
  const preservedUnmanagedCount = inventory.filter(item => !item.page && !agentUnmanagedIds.has(item.id)).length;
  const protectedTabCount = inventory.filter(item =>
    item.page ? item.page.openedBy === "unknown" : !agentUnmanagedIds.has(item.id)
  ).length;
  const keepsNothing = keep !== "all" && keep.length === 0;

  let pendingCloseCount = 0;
  // What finish() closes: the agent's code goes from those tabs too, but
  // none of them reloads (endTaskCode).
  const closed = new Set();
  const close = tab => {
    closed.add(tab);
    if (ctx.pages.closeTab(tab)) {
      pendingCloseCount++;
    }
  };

  if (keepsNothing && protectedTabCount === 0 && rec.kind === "task") {
    // Its last tab's close ends the task on the way (service
    // #afterTaskTabClosed): as finished, since the agent decided.
    rec.finishing = true;
    for (const { tab } of inventory) {
      close(tab);
    }
    ctx.pages.dropSpace(rec.id);
    // Before the record goes, so listeners (the UI's badge) still find it.
    ctx.emit("spaceFinished", { space: rec.id, closedSpace: true });
    ctx.spaces.remove(rec, { endedHow: "finished" });
    return {
      spaceId: rec.id,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels,
      preservedUnmanagedCount,
      protectedTabCount,
      pendingCloseCount,
    };
  }

  for (const page of toClose) {
    close(ctx.pages.tabFor(page));
  }
  // Tabs an earlier finish() left for the user go only when this finish
  // keeps nothing. A blank tab that is the last one in the space stays:
  // closing it would delete the space the user keeps.
  const retainedEarlier = new Set(keepsNothing ? [] : rec.ledger.retained);
  let liveCount = ctx.pages.inventory(rec).length;
  const anchorsLeftOpen = [];
  for (const item of agentUnmanaged) {
    if (retainedEarlier.has(item.id)) {
      continue;
    }
    // A task has no workspace of its own to keep alive.
    if (rec.kind !== "task" && liveCount <= 1) {
      anchorsLeftOpen.push(item.id);
      continue;
    }
    close(item.tab);
    liveCount--;
  }
  rec.ledger.retained = [
    ...keptManagedLabels
      .map(label => byLabel.get(label))
      .filter(page => page.openedBy === "agent")
      .map(page => ctx.pages.tabId(ctx.pages.tabFor(page))),
    ...agentUnmanaged.filter(item => retainedEarlier.has(item.id)).map(item => item.id),
    ...anchorsLeftOpen,
  ];
  // The pages it keeps, read while they're still pages: a reply in the
  // task's Work chat may hand back those the user leaves alone.
  const keptPages = keptManagedLabels
    .map(label => byLabel.get(label))
    .filter(Boolean)
    .map(page => ({ label: page.label, openedBy: page.openedBy, opener: page.opener ?? null, tab: ctx.pages.tabFor(page) }))
    .filter(kept => kept.tab);
  // Before endTask drops the tabs from the task: the agent's code goes from
  // every one, kept pages included, and the written ones load afresh.
  const loads = ctx.service.endTaskCode(rec, closed);
  // The task ends: labels end, keep-alive stops, the space is the user's.
  ctx.service.endTask(rec);
  ctx.spaces.setOwnership(rec, "user", { source: "agent" });
  // Once the Space is the user's: the kept set holds only finished tasks.
  ctx.service.noteFinished?.(rec, keptPages, loads);
  ctx.emit("spaceFinished", { space: rec.id, closedSpace: false });
  return {
    spaceId: rec.id,
    closedSpace: false,
    keptManagedLabels,
    closedManagedLabels,
    preservedUnmanagedCount,
    protectedTabCount,
    pendingCloseCount,
  };
}
