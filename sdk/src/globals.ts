// Portions adapted from citrolabs/ego-lite (MIT License).
//
// The globals every script starts with: profiles, listTaskSpaces, taskSpace,
// claimTaskSpace, takeOverTaskSpace and help.

import { validateOptions } from "./api-schema.ts";
import { ZeniusError } from "./errors.ts";
import { NOTE_ENTRY, SEED_PAGES } from "./internal.ts";
import { round } from "./round.ts";
import { clearHandOffMessage, createTaskSpace, TaskSpace, type TaskSpaceDescriptor, type UserPageEntry } from "./task-space.ts";

const SAFETY_TIMEOUT_MS = 25_000;
/** How long the runtime waits for the user's answer to a claim (zen-core's claim gate). */
const CLAIM_WAIT_MS = 600_000;
const GRACE_MS = 10_000;

/**
 * Who asks, for the claim prompt. The prompt opens with zenius's own words
 * and shows this only as a quoted label ('calls itself "…"'), since any
 * script can send any label: the runtime strips and caps it. The sandboxed
 * launcher works it out the same way and passes only ZENIUS_CLIENT.
 */
export function clientLabel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.ZENIUS_CLIENT?.trim();
  if (named) return named;
  if (env.CLAUDECODE === "1") return "Claude Code";
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return "Codex";
  return undefined;
}

export type Profile = { id: string; name: string; isDefault: boolean };

/** List browser profiles (the default plus Zen containers) for new task spaces. */
export async function profiles(): Promise<Profile[]> {
  const result = await round().call<Record<string, unknown>>("profiles.list", {}, { op: "profiles", safetyTimeoutMs: SAFETY_TIMEOUT_MS });
  const list = Array.isArray(result) ? result : result?.profiles;
  if (
    !Array.isArray(list) ||
    !list.every(
      (profile) =>
        profile &&
        typeof profile.id === "string" &&
        profile.id.length > 0 &&
        typeof profile.name === "string" &&
        typeof profile.isDefault === "boolean",
    )
  ) {
    throw new ZeniusError("ZEN_INTERNAL", "profiles expected entries with id, name, and isDefault");
  }
  return list;
}

/** List agent task spaces and the user's own Spaces. */
export async function listTaskSpaces(): Promise<TaskSpaceDescriptor[]> {
  // A space's Pages are the SDK's to know (task.page(label).targetId), not
  // part of Ego's listing.
  return (await fetchTaskSpaces("listTaskSpaces")).map(({ pages: _pages, ...space }) => space as TaskSpaceDescriptor);
}

async function fetchTaskSpaces(op: string): Promise<TaskSpaceDescriptor[]> {
  const result = await round().call<Record<string, unknown>>("spaces.list", {}, { op, safetyTimeoutMs: SAFETY_TIMEOUT_MS });
  const list = Array.isArray(result) ? result : result?.taskSpaces;
  if (!Array.isArray(list)) throw new ZeniusError("ZEN_INTERNAL", `${op} expected { taskSpaces: [...] }`);
  return list.map(normalizeTaskSpace).filter((space): space is TaskSpaceDescriptor => Boolean(space));
}

/**
 * Reuse an agent-owned task space or create one. A name held by a user-owned
 * space fails with ZEN_TASK_SPACE_NAME_IN_USE; a user-owned space addressed by
 * id is returned unclaimed, so its first command reports who is in control.
 */
export async function taskSpace(nameOrId: string | number, options: { profileId?: string } = {}): Promise<TaskSpace> {
  assertTaskSpaceLocator("taskSpace", nameOrId);
  validateOptions("taskSpace", options);
  const { profileId } = options;
  const spaces = await fetchTaskSpaces("taskSpace");
  const existing = findMatchingTaskSpace(spaces, nameOrId);
  if (profileId !== undefined) {
    if (typeof nameOrId !== "string") {
      throw new TypeError("taskSpace profileId can only be used with a new task-space name");
    }
    if (existing) {
      throw new Error(
        `taskSpace profileId only applies when creating a new task space; ${JSON.stringify(nameOrId)} already exists`,
      );
    }
    return createSpace(nameOrId, profileId);
  }
  if (!existing) {
    if (typeof nameOrId === "number") throw spaceNotFound(nameOrId);
    return createSpace(nameOrId, undefined);
  }
  if (isAgentOwned(existing.ownership)) return withPageEntries(createTaskSpace(existing), existing.pages, "taskSpace");
  if (existing.ownership === "user") {
    // A user Space with the same name is a name collision, not this agent's task.
    if (typeof nameOrId === "string" && existing.name === nameOrId) {
      throw new ZeniusError(
        "ZEN_TASK_SPACE_NAME_IN_USE",
        [
          `taskSpace: A task space named ${JSON.stringify(nameOrId)} already exists and belongs to the user (id ${existing.id}).`,
          `Do not take it over on your own. Ask the user whether to work in it; only if they agree, call claimTaskSpace(${existing.id}).`,
          "Otherwise use a different task space name.",
        ].join("\n"),
        { spaceId: existing.id },
      );
    }
    return createTaskSpace(existing);
  }
  throw new Error(
    `taskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`,
  );
}

/** How many names startTaskSpace finds taken after its listing before it gives up. */
const START_RETRIES = 20;

/**
 * Start a new task, never one that exists: `name`, or "<name> 2", "<name> 3"
 * and on while those are taken. For the MCP server, whose chats must not end
 * up in one task by naming theirs alike (scripts keep Ego's taskSpace(), which
 * finds a task again by its name). Not a script global.
 *
 * `maxLength` caps the whole name in code points, number included: the name
 * is cut before the number, so a client that shows names up to that length
 * shows each task's whole name.
 */
export async function startTaskSpace(name: string, options: { maxLength?: number } = {}): Promise<TaskSpace> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`startTaskSpace expects a task name (non-empty string), got ${describeLocator(name)}`);
  }
  const max = options.maxLength ?? Infinity;
  const fit = (text: string, room: number) => {
    const chars = Array.from(text);
    if (chars.length <= room) return text;
    const kept = chars.slice(0, Math.max(1, room));
    // End at a word's end where the cut would split a word.
    const end = kept.at(-1) !== " " && chars[kept.length] !== " " ? kept.lastIndexOf(" ") : -1;
    return (end > 0 ? kept.slice(0, end) : kept).join("").trimEnd();
  };
  const base = name.trim();
  const taken = new Set((await fetchTaskSpaces("taskSpace")).map((space) => space.name));
  let retries = 0;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = `${fit(base, max - suffix.length)}${suffix}`;
    if (taken.has(candidate)) continue;
    try {
      return await createSpace(candidate, undefined);
    } catch (error) {
      // The runtime refuses a name in use atomically: another client took it since the listing.
      if (!(error instanceof ZeniusError && error.code === "ZEN_TASK_SPACE_NAME_IN_USE") || ++retries > START_RETRIES) throw error;
    }
  }
}

async function createSpace(name: string, profileId: string | undefined): Promise<TaskSpace> {
  const params: Record<string, unknown> = { name };
  if (profileId !== undefined) params.profileId = profileId;
  const created = normalizeTaskSpace(
    await round().call("spaces.create", params, { op: "taskSpace", safetyTimeoutMs: SAFETY_TIMEOUT_MS }),
  );
  if (!created || !Number.isInteger(created.id)) {
    throw new ZeniusError("ZEN_INTERNAL", "taskSpace: the runtime returned an invalid task space");
  }
  // A new space starts with p1, which the script knows about by definition.
  round().observe(created.id, "p1");
  const task = createTaskSpace({ ...created, name: created.name || name, ownership: created.ownership || "agent" });
  return withPageEntries(task, created.pages, "taskSpace");
}

/**
 * Ego answers task.page(label).targetId and openedBy at once, from its
 * ledger. Learn them before the script gets the TaskSpace: from the runtime's
 * reply when it names every Page's tab, else with one pages.list. Best
 * effort and quiet: a space the user controls fails reads, and that is for
 * the script's first own call to report.
 */
async function withPageEntries(task: TaskSpace, pages: unknown, op: string): Promise<TaskSpace> {
  if (task[SEED_PAGES](pages)) return task;
  try {
    const result = await round().client.call<unknown>("pages.list", { space: task.id }, { op, safetyTimeoutMs: SAFETY_TIMEOUT_MS, quiet: true });
    task[SEED_PAGES](Array.isArray(result) ? result : (result as { pages?: unknown } | null)?.pages);
  } catch {
    // The labels stay unknown until a listing, as before.
  }
  return task;
}

/** Claim a user-owned or inactive space after the user approved it. */
export async function claimTaskSpace(nameOrId: string | number): Promise<TaskSpace> {
  const space = await findTaskSpace(nameOrId, "claimTaskSpace");
  const params: Record<string, unknown> = { space: space.id };
  // An empty name would rename the Space; omit it so an unnamed user Space keeps its placeholder.
  if (space.name) params.name = space.name;
  const client = clientLabel();
  if (client) params.client = client;
  // A claim of the user's Space or of an ended task waits for their answer in the browser.
  const claimed = await round().call<Record<string, unknown>>("spaces.claim", params, {
    op: "claimTaskSpace",
    safetyTimeoutMs: CLAIM_WAIT_MS + GRACE_MS,
  });
  const task = createTaskSpace({
    ...space,
    ...(normalizeTaskSpace(claimed) ?? {}),
    id: space.id,
    ownership: "agent",
  });
  await captureUserPage(task, claimed, "claimTaskSpace");
  return withPageEntries(task, claimed?.pages, "claimTaskSpace");
}

/** Take control of an agent-owned space back from the user, after their approval. */
export async function takeOverTaskSpace(nameOrId: string | number): Promise<TaskSpace> {
  const space = await findTaskSpace(nameOrId, "takeOverTaskSpace");
  const result = await round().call<Record<string, unknown>>(
    "spaces.takeOver",
    { space: space.id },
    { op: "takeOverTaskSpace", safetyTimeoutMs: SAFETY_TIMEOUT_MS },
  );
  const task = createTaskSpace({ ...space, ownership: "agent", openerCut: result?.openerCut, reloaded: result?.reloaded });
  // Re-taking an agent-controlled space is a no-op, not a user boundary: only a
  // delegated space can have gained tabs through the user's activity, or show
  // a hand-off message.
  if (space.ownership === "agentDelegatedToUser") {
    await clearHandOffMessage(space.id, "takeOverTaskSpace");
    await captureUserPage(task, result, "takeOverTaskSpace");
  }
  return withPageEntries(task, result?.pages, "takeOverTaskSpace");
}

/**
 * Prefer the tab the runtime captured atomically with the claim; fall back to
 * asking for it, which can race with the user's next click.
 */
async function captureUserPage(task: TaskSpace, result: Record<string, unknown> | null | undefined, op: string) {
  let entry: UserPageEntry;
  if (result && typeof result === "object" && "userPage" in result) {
    entry = result.userPage as UserPageEntry;
  } else {
    entry = await round().call<UserPageEntry>("pages.userPage", { space: task.id }, { op, safetyTimeoutMs: SAFETY_TIMEOUT_MS });
  }
  task[NOTE_ENTRY](entry);
}

function isAgentOwned(ownership: unknown): boolean {
  return ownership === "agent" || ownership === "agentDelegatedToUser";
}

// `id` is the locator; `name` and `taskId` are display values and may be empty
// for a user Space that was never renamed.
function normalizeTaskSpace(space: any): TaskSpaceDescriptor | null {
  if (!space || typeof space !== "object" || space.id === undefined || space.id === null) return null;
  const name = space.name ?? space.taskId ?? "";
  return { ...space, taskId: space.taskId ?? name, name };
}

async function findTaskSpace(nameOrId: unknown, op: string): Promise<TaskSpaceDescriptor> {
  assertTaskSpaceLocator(op, nameOrId);
  const match = findMatchingTaskSpace(await fetchTaskSpaces(op), nameOrId as string | number);
  if (!match) throw spaceNotFound(nameOrId as string | number);
  return match;
}

function spaceNotFound(nameOrId: string | number): ZeniusError {
  return new ZeniusError("ZEN_TASK_SPACE_NOT_FOUND", `task space not found: ${nameOrId}`);
}

// Reject bad locators before any request: an unmatched string name creates a
// space, so undefined must never reach that branch.
function assertTaskSpaceLocator(op: string, nameOrId: unknown): void {
  if (typeof nameOrId === "number" && Number.isSafeInteger(nameOrId)) return;
  if (typeof nameOrId === "string" && nameOrId.trim() !== "") return;
  throw new TypeError(
    `${op} expects a task-space name (non-empty string) or numeric id, got ${describeLocator(nameOrId)}. ` +
      'listTaskSpaces() entries expose the numeric id as "id"; pass entry.id.',
  );
}

function describeLocator(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || value == null) return String(value);
  return typeof value;
}

function findMatchingTaskSpace(spaces: TaskSpaceDescriptor[], nameOrId: string | number): TaskSpaceDescriptor | undefined {
  if (typeof nameOrId === "number") return spaces.find((space) => space.id === nameOrId);
  const byName = spaces.find((space) => space.name === nameOrId || space.taskId === nameOrId);
  if (byName) return byName;
  if (/^\d+$/.test(nameOrId)) {
    const id = Number(nameOrId);
    return spaces.find((space) => space.id === id);
  }
  return undefined;
}
