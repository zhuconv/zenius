// The observe layer's sidebar.* methods (PROTOCOL.md, "Remote tasks: the sidebar")
// on the mock runtime: enough of the states, limits and codes for the tests of
// `zenius sidebar` and the bridge. Tests move a task along with answer(),
// needUser() and end().

import type { SidebarTask } from "../src/sidebar.ts";
import { MockError, type MockRuntime } from "./mock-runtime.ts";

/** The characters a label may hold, as the runtime checks them, once trimmed; empty means none. */
const LABEL = /^[A-Za-z0-9 _.\/:@#-]{0,80}$/;

export class FakeSidebar {
  readonly tasks = new Map<string, SidebarTask>();
  /** Every text the sidebar's agent got: starts and follow-ups. */
  readonly texts: string[] = [];
  maxRunning = 2;
  off = false;
  #next = 1;

  constructor(mock: MockRuntime) {
    mock.handle("sidebar.start", (params) => this.#start(params));
    mock.handle("sidebar.send", (params) => this.#send(params));
    mock.handle("sidebar.status", (params) => ({ ...this.#task(params.taskId) }));
    mock.handle("sidebar.list", () => ({
      tasks: [...this.tasks.values()].reverse().map(({ answer: _answer, answerTruncated: _cut, ...rest }) => rest),
    }));
    mock.handle("sidebar.stop", (params) => {
      const task = this.#task(params.taskId);
      if (task.state !== "stopped" && task.state !== "failed") this.end(task.taskId, "stopped", "caller");
      return { taskId: task.taskId, state: task.state };
    });
  }

  /** The agent ends its turn, with an answer. */
  answer(taskId: string, text: string, state: "idle" | "needs_user" = "idle"): void {
    const task = this.#task(taskId);
    Object.assign(task, { state, turn: task.turn + 1, answer: text, updatedAt: Date.now() });
    if (state === "needs_user") task.needs = { reason: "sign_in", message: "Sign in to example.com", kind: "handoff" };
    else delete task.needs;
  }

  end(taskId: string, state: "stopped" | "failed", reason: string): void {
    const task = this.#task(taskId);
    Object.assign(task, { state, updatedAt: Date.now(), endedAt: Date.now() });
    if (state === "stopped") task.stopReason = reason;
    else task.error = { code: reason, message: `the turn failed (${reason})` };
  }

  running(): number {
    return [...this.tasks.values()].filter((task) => task.state === "running").length;
  }

  #start(params: Record<string, any>): { taskId: string; state: string } {
    const label = params.source?.label;
    if (label !== undefined && (typeof label !== "string" || !LABEL.test(label.trim()))) {
      throw new MockError("ZEN_INVALID_ARGUMENT", "source.label: at most 80 ASCII letters, digits, spaces and - _ . / : @ #", { field: "source.label" });
    }
    if (this.off) throw new MockError("ZEN_REMOTE_OFF", "remote tasks are off", { pref: "zenius.agentSidebar.allowRemoteTasks" });
    const known = params.requestId ? [...this.tasks.values()].find((task) => task.requestId === params.requestId) : undefined;
    if (known) return { taskId: known.taskId, state: known.state };
    if (this.running() >= this.maxRunning) {
      throw new MockError("ZEN_REMOTE_LIMIT", `${this.maxRunning} remote tasks are running`, { limit: "running", max: this.maxRunning });
    }
    const taskId = `rt-${this.#next++}`;
    const now = Date.now();
    this.tasks.set(taskId, {
      taskId,
      ...(params.requestId ? { requestId: params.requestId } : {}),
      state: "running",
      source: params.source,
      turn: 0,
      startedAt: now,
      updatedAt: now,
      endsAt: now + 3_600_000,
    });
    this.texts.push(params.text);
    return { taskId, state: "running" };
  }

  #send(params: Record<string, any>): { taskId: string; state: string } {
    const task = this.#task(params.taskId);
    if (task.state === "stopped" || task.state === "failed") {
      throw new MockError("ZEN_REMOTE_TASK_ENDED", "the task has ended", { state: task.state, stopReason: task.stopReason });
    }
    if (task.state === "running") throw new MockError("ZEN_REMOTE_TASK_BUSY", "a turn is running", { state: task.state });
    if (this.off) throw new MockError("ZEN_REMOTE_OFF", "remote tasks are off", { pref: "zenius.agentSidebar.allowRemoteTasks" });
    Object.assign(task, { state: "running", updatedAt: Date.now() });
    delete task.needs;
    this.texts.push(params.text);
    return { taskId: task.taskId, state: "running" };
  }

  #task(taskId: unknown): SidebarTask {
    const task = this.tasks.get(String(taskId));
    if (!task) throw new MockError("ZEN_REMOTE_TASK_NOT_FOUND", `no remote task ${taskId}`, { taskId });
    return task;
  }
}
