// A stand-in for the browser runtime that speaks docs/PROTOCOL.md over a Unix
// socket, so SDK and CLI tests run without Zen. It keeps just enough state
// (spaces, pages, dialogs, downloads) to exercise every SDK path, records every
// request, and lets a test override any method.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

export type MockPage = {
  label?: string;
  tab: string;
  url: string;
  title: string;
  openedBy: "agent" | "user" | "unknown";
  createdAt: number;
  opener?: string;
  dialog?: { type: string; message: string; defaultValue?: string };
};

export type MockSpace = {
  id: number;
  name: string;
  ownership: "agent" | "agentDelegatedToUser" | "user";
  createdBy: "agent" | "user";
  profileId?: string;
  pages: MockPage[];
  nextLabel: number;
  activeTab?: string;
  reason?: string;
  /** Sent as is, like the runtime's flag, so tests can send other values too. */
  handBackOpenerCut?: unknown;
  handBackReloaded?: unknown;
  handBackBlanked?: unknown;
  /** The user hands the space back when the script waits for control. */
  resumeOnWait?: boolean;
  /** The space's state text (spaces.setState), which the hold card shows. */
  stateText?: string;
  /** Who drives the task (spaces.create's source), listed as the runtime lists it. */
  source?: Record<string, unknown>;
  /** spaces.handOff refuses with ZEN_HANDOFF_REFUSED and this reason. */
  refuseHandOff?: string;
  /** The accounts to restore (spaces.noteAccount), listed when any are left. */
  accountsToRestore?: { site: string; account: string }[];
};

/** `connection`: which of the mock's connections sent it, numbered from 1 as they came. */
export type RequestRecord = { method: string; params: Record<string, any>; receivedAt: number; connection: number; pageBudget?: unknown };

type Context = {
  socket: Socket;
  mock: MockRuntime;
  /** The request frame as sent, including top-level flags such as progress. */
  frame: { id: number; method: string; params?: Record<string, any>; progress?: boolean; pageBudget?: number };
  /** Send a progress frame for this request, e.g. { held: true, reason: "paused" }. */
  progress: (body: Record<string, unknown>) => void;
};
type Handler = (params: Record<string, any>, context: Context) => unknown | Promise<unknown>;

/** The other managed Pages linked to this one by opener, either way and in chains: its window group. */
function groupMates(space: MockSpace, page: MockPage): MockPage[] {
  const managed = space.pages.filter((candidate) => candidate.label !== undefined);
  const group = new Set<MockPage>([page]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const candidate of managed) {
      if (group.has(candidate)) continue;
      if ([...group].some((member) => candidate.opener === member.label || member.opener === candidate.label)) {
        group.add(candidate);
        grew = true;
      }
    }
  }
  group.delete(page);
  return [...group];
}

export class MockError extends Error {
  code: string;
  data?: Record<string, unknown>;
  /** Sent as the error frame's `hooked`, as the runtime's for page code that hooked a page and then threw. */
  hooked?: string;
  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A handler's result whose frame says the call's page code left `detail` in the page (PROTOCOL "hooked"). */
export class Hooked {
  readonly value: unknown;
  readonly detail: string;
  constructor(value: unknown, detail: string) {
    this.value = value;
    this.detail = detail;
  }
}

export class MockRuntime {
  readonly dir: string;
  readonly socketPath: string;
  readonly requests: RequestRecord[] = [];
  /** The request ids calls.cancel named, in order. */
  readonly canceled: unknown[] = [];
  readonly spaces = new Map<number, MockSpace>();
  pageBudget = 8;
  /** The working folder finished downloads move into, as the runtime moves them. */
  readonly workingDir: string;
  /** Bytes a download's finished file holds, by its id (default "download <id>"). */
  readonly downloadBodies = new Map<string, Buffer>();
  /** Download ids whose download.path fails, as a failed transfer's does. */
  readonly failingDownloads = new Set<string>();
  /** Each finished download's file in the working folder, by its id. */
  readonly #downloadFiles = new Map<string, string>();
  /** Each connection's number, in the order they came. */
  readonly #connections = new Map<Socket, number>();
  #nextStep = 1;
  hello: Record<string, unknown> = { protocol: 1, instance: "mock", runtimeVersion: "0.0.0-mock", zenVersion: "1.24.2b" };
  #server: Server | undefined;
  #nextSpace = 1;
  #nextTab = 100;
  #nextDownload = 1;
  #nextChooser = 1;
  #overrides = new Map<string, Handler>();
  #waiters: Array<{ space: number; page: string; event: string; resolve: (value: unknown) => void }> = [];
  #sockets = new Set<Socket>();

  /** `socketPath`: where to listen instead of the mock's own folder, such as a self-check socket's place. */
  constructor(options: { socketPath?: string } = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "zenius-mock-"));
    this.socketPath = options.socketPath ?? join(this.dir, "mock.sock");
    this.workingDir = join(this.dir, "zenius-files");
    mkdirSync(this.workingDir, { mode: 0o700 });
  }

  /** A finished download's file in the working folder: its suggested name, or "name(1).ext" when that's taken, as the runtime names it. */
  #downloadFile(id: string): string {
    let file = this.#downloadFiles.get(id);
    if (!file) {
      for (let n = 0; !file || existsSync(file); n++) file = join(this.workingDir, n ? `report(${n}).pdf` : "report.pdf");
      writeFileSync(file, this.downloadBodies.get(id) ?? Buffer.from(`download ${id}`), { mode: 0o600 });
      this.#downloadFiles.set(id, file);
    }
    return file;
  }

  async start(): Promise<this> {
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve) => this.#server!.listen(this.socketPath, resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Replace one method's behavior for the rest of the test. */
  handle(method: string, handler: Handler): void {
    this.#overrides.set(method, handler);
  }

  /** The built-in handler for `method` again, after handle(). */
  unhandle(method: string): void {
    this.#overrides.delete(method);
  }

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  addSpace(name: string, ownership: MockSpace["ownership"], createdBy: MockSpace["createdBy"] = "agent"): MockSpace {
    const space: MockSpace = { id: this.#nextSpace++, name, ownership, createdBy, pages: [], nextLabel: 1 };
    this.spaces.set(space.id, space);
    return space;
  }

  addPage(space: MockSpace, options: Partial<MockPage> & { managed?: boolean } = {}): MockPage {
    const { managed = true, ...rest } = options;
    const page: MockPage = {
      tab: `tab-${this.#nextTab++}`,
      url: "about:blank",
      title: "",
      openedBy: "agent",
      createdAt: Date.now(),
      ...rest,
    };
    if (managed && !page.label) page.label = `p${space.nextLabel++}`;
    space.pages.push(page);
    space.activeTab ??= page.tab;
    return page;
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    this.#connections.set(socket, this.#connections.size + 1);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.write(`${JSON.stringify({ event: "hello", params: this.hello })}\n`);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.#request(socket, JSON.parse(line));
      }
    });
  }

  #request(socket: Socket, frame: Context["frame"]): void {
    const params = frame.params ?? {};
    this.requests.push({
      method: frame.method,
      params,
      receivedAt: Date.now(),
      connection: this.#connections.get(socket) ?? 0,
      ...("pageBudget" in frame ? { pageBudget: frame.pageBudget } : {}),
    });
    const handler = this.#overrides.get(frame.method) ?? this.#builtin(frame.method);
    const reply = (body: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: frame.id, ...body })}\n`);
    };
    let result: unknown;
    try {
      if (!handler) throw new MockError("ZEN_UNSUPPORTED", `mock runtime has no method ${frame.method}`);
      // As the core's dispatcher: a bad per-process field fails before dispatch.
      if ("pageBudget" in frame && !(Number.isInteger(frame.pageBudget) && frame.pageBudget! > 0)) {
        throw new MockError("ZEN_INVALID_ARGUMENT", "pageBudget must be a positive integer");
      }
      // Called synchronously, like the real runtime, so a waiter is armed
      // before the next frame on this connection is handled.
      result = handler(params, { socket, mock: this, frame, progress: reply });
    } catch (error) {
      reply({ error: wireError(error), ...hookedOf(error) });
      return;
    }
    Promise.resolve(result).then(
      (outcome) => {
        const value = outcome instanceof Hooked ? outcome.value : outcome;
        const body = value instanceof Unserializable ? { result: null, unserializable: value.text } : { result: value === undefined ? null : value };
        reply({ ...body, ...hookedOf(outcome) });
      },
      (error) => reply({ error: wireError(error), ...hookedOf(error) }),
    );
  }

  /** A space's managed Pages as the runtime lists them in spaces.* replies. */
  pageEntries(space: MockSpace): { label: string; tab: string; openedBy: string }[] {
    return space.pages.filter((page) => page.label).map((page) => ({ label: page.label!, tab: page.tab, openedBy: page.openedBy }));
  }

  /** The runtime's checkBudget: Ego's error once a space holds `budget` managed Pages. */
  checkBudget(space: MockSpace, budget: number): void {
    const labels = space.pages.filter((page) => page.label).map((page) => page.label!);
    if (labels.length < budget) return;
    throw new MockError("ZEN_PAGE_BUDGET_REACHED", `Page budget reached (${labels.length}/${budget}) in space ${JSON.stringify(space.name)}.`, {
      space: space.id,
      budget,
      pages: labels,
    });
  }

  space(params: Record<string, any>): MockSpace {
    const space = this.spaces.get(params.space);
    if (!space) throw new MockError("ZEN_TASK_SPACE_NOT_FOUND", `task space not found: ${params.space}`);
    return space;
  }

  /** Resolve a managed page and enforce who is in control, as the runtime does. */
  page(params: Record<string, any>, { control = true } = {}): { space: MockSpace; page: MockPage } {
    const space = this.space(params);
    if (control) this.assertControl(space);
    const page = space.pages.find((candidate) => candidate.label === params.page);
    if (!page) {
      const labels = space.pages.filter((candidate) => candidate.label).map((candidate) => candidate.label);
      throw new MockError(
        "ZEN_PAGE_NOT_FOUND",
        `page label not found: ${params.page}. Managed Pages in task space ${space.id}: ${labels.join(", ") || "none"}`,
      );
    }
    return { space, page };
  }

  assertControl(space: MockSpace): void {
    if (space.ownership === "agentDelegatedToUser") {
      throw new MockError("ZEN_TASK_SPACE_USER_IN_CONTROL", "the user controls this space", {
        reason: space.reason ?? "manual_takeover",
      });
    }
    if (space.ownership === "user") {
      throw new MockError("ZEN_TASK_SPACE_INACTIVE", "this space is not assigned to the agent");
    }
  }

  openPopup(space: MockSpace, opener: MockPage, url: string): MockPage {
    const popup = this.addPage(space, { url, title: url, opener: opener.label, openedBy: "agent" });
    this.#fire(space.id, opener.label!, "popup", { label: popup.label, tab: popup.tab });
    return popup;
  }

  /** An event frame to every connection, as the runtime sends one to its subscribers. */
  emit(event: string, params: Record<string, unknown>): void {
    for (const socket of this.#sockets) {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ event, params })}\n`);
    }
  }

  #fire(space: number, page: string, event: string, value: unknown): boolean {
    const index = this.#waiters.findIndex((waiter) => waiter.space === space && waiter.page === page && waiter.event === event);
    if (index < 0) return false;
    const [waiter] = this.#waiters.splice(index, 1);
    waiter!.resolve(value);
    return true;
  }

  #builtin(method: string): Handler | undefined {
    const mock = this;
    const receiptFor = (params: Record<string, any>, context?: Context): unknown => {
      const { space, page } = mock.page(params);
      const target = String(params.target ?? "");
      // "held": the user pauses the Space while the call waits at the gate.
      if (target.includes("held") && context) {
        if (context.frame.progress) context.progress({ held: true, reason: "paused" });
        return new Promise((resolve) =>
          setTimeout(() => {
            if (context.frame.progress) context.progress({ held: false });
            resolve({});
          }, 120),
        );
      }
      if (target.includes("missing")) {
        throw new MockError("ZEN_SELECTOR_NOT_FOUND", `selector ${JSON.stringify(target)} matched 0 elements`);
      }
      if (target.includes("ambiguous")) {
        throw new MockError("ZEN_SELECTOR_AMBIGUOUS", `selector ${JSON.stringify(target)} matched 3 elements`, { matches: 3 });
      }
      if (target.includes("late-popup")) {
        setTimeout(() => mock.openPopup(space, page, "https://example.com/late"), 20);
        return {};
      }
      if (target.includes("popup")) {
        const popup = mock.openPopup(space, page, "https://example.com/popup");
        return { popups: [{ label: popup.label, targetId: popup.tab }] };
      }
      if (target.includes("alert")) {
        page.dialog = { type: "alert", message: "hello" };
        return { dialog: page.dialog };
      }
      if (target.includes("download")) {
        mock.#fire(space.id, page.label!, "download", {
          download: `d${mock.#nextDownload++}`,
          url: "https://example.com/report.pdf",
          suggestedFilename: "report.pdf",
        });
        return {};
      }
      if (target.includes("upload")) {
        mock.#fire(space.id, page.label!, "filechooser", { chooser: `c${mock.#nextChooser++}`, multiple: true });
        return {};
      }
      return {};
    };
    const handlers: Record<string, Handler> = {
      "browser.version": () => ({ zenVersion: "1.24.2b", runtimeVersion: "0.0.0-mock", updateAvailable: false }),
      // A test's handler that waits ends itself when it sees the id here.
      "calls.cancel": (params) => {
        mock.canceled.push(params.id);
        return { canceled: true };
      },
      "script.begin": () => ({ step: mock.#nextStep++ }),
      "script.end": () => ({ ended: true }),
      "feedback.compose": () => ({ id: "{00000000-0000-4000-8000-000000000000}", title: "zenius 0.0.0-mock: a problem report", body: "From `zenius feedback`.\n" }),
      "feedback.propose": () => ({ outcome: "pending" }),
      "browser.health": () => ({
        ok: true,
        windows: 1,
        spaces: mock.spaces.size,
        pid: process.pid,
        i5: { loads: ["about:blank", "blob:", "data:", "http:", "https:"], pageGate: true, contentGate: true, refuses: true },
      }),
      "profiles.list": () => ({
        profiles: [
          { id: "default", name: "Default", isDefault: true },
          { id: "container-2", name: "Work", isDefault: false },
        ],
      }),
      "spaces.list": () => ({
        taskSpaces: [...mock.spaces.values()].map((space) => ({
          id: space.id,
          name: space.name,
          createdBy: space.createdBy,
          ownership: space.ownership,
          profileId: space.profileId ?? "default",
          profileName: space.profileId ? "Work" : "Default",
          recentTabTitles: space.pages.map((page) => page.title).filter(Boolean).slice(0, 3),
          source: space.source ?? null,
          ...(space.accountsToRestore?.length ? { accountsToRestore: space.accountsToRestore.map((entry) => ({ ...entry })) } : {}),
          // I3: only a space the agent controls lists its Pages.
          ...(space.ownership === "agent" ? { pages: mock.pageEntries(space) } : {}),
        })),
      }),
      "spaces.create": (params) => {
        if (typeof params.name !== "string" || !params.name) throw new MockError("ZEN_INVALID_ARGUMENT", "name required");
        if (params.profileId !== undefined && params.profileId !== "default" && params.profileId !== "container-2") {
          throw new MockError("ZEN_PROFILE_NOT_FOUND", `profile not found: ${params.profileId}`);
        }
        // As the runtime does: names are unique among tasks and the user's Spaces.
        const clash = [...mock.spaces.values()].find((space) => space.name === params.name);
        if (clash) throw new MockError("ZEN_TASK_SPACE_NAME_IN_USE", `A task space named ${JSON.stringify(params.name)} already exists (id ${clash.id}).`, { spaceId: clash.id });
        const space = mock.addSpace(params.name, "agent");
        space.profileId = params.profileId;
        if (params.source && typeof params.source === "object") space.source = params.source;
        mock.addPage(space);
        return { id: space.id, name: space.name, ownership: "agent", createdBy: "agent", pages: mock.pageEntries(space) };
      },
      "spaces.open": (params) => {
        const space = mock.space(params);
        mock.assertControl(space);
        return { id: space.id, name: space.name, ownership: space.ownership };
      },
      "spaces.claim": (params) => {
        const space = mock.space(params);
        space.ownership = "agent";
        for (const page of space.pages) page.label = undefined;
        space.nextLabel = 1;
        const active = space.pages.find((page) => page.tab === space.activeTab);
        return {
          id: space.id,
          name: params.name ?? space.name,
          userPage: active ? { tab: active.tab, openedBy: active.openedBy } : null,
          pages: mock.pageEntries(space),
        };
      },
      "spaces.takeOver": (params) => {
        const space = mock.space(params);
        if (space.ownership === "user") throw new MockError("ZEN_TASK_SPACE_INACTIVE", "ended task");
        space.ownership = "agent";
        const active = space.pages.find((page) => page.tab === space.activeTab);
        // The runtime reports a hand back's openerCut and reloaded once (PROTOCOL).
        const { handBackOpenerCut: openerCut, handBackReloaded: reloaded, handBackBlanked: blanked } = space;
        delete space.handBackOpenerCut;
        delete space.handBackReloaded;
        delete space.handBackBlanked;
        return {
          id: space.id,
          ownership: "agent",
          userPage: active ? { label: active.label, tab: active.tab, openedBy: active.openedBy } : null,
          pages: mock.pageEntries(space),
          ...(openerCut !== undefined ? { openerCut } : {}),
          ...(reloaded !== undefined ? { reloaded } : {}),
          ...(blanked !== undefined ? { blanked } : {}),
        };
      },
      "spaces.handOff": (params) => {
        const space = mock.space(params);
        mock.assertControl(space);
        if (space.refuseHandOff) throw new MockError("ZEN_HANDOFF_REFUSED", `p1 can't be handed off (${space.refuseHandOff}).`, { page: "p1", reason: space.refuseHandOff });
        space.ownership = "agentDelegatedToUser";
        return { id: space.id, ownership: "agentDelegatedToUser" };
      },
      "spaces.waitForControl": (params) => {
        const space = mock.space(params);
        if (space.resumeOnWait) space.ownership = "agent";
        // As the runtime: keepNotes (zenius wait) leaves the hand back's notes for the next takeOver.
        if (params.keepNotes === true) return { space: space.id, ownership: space.ownership };
        const { handBackOpenerCut: openerCut, handBackReloaded: reloaded, handBackBlanked: blanked } = space;
        delete space.handBackOpenerCut;
        delete space.handBackReloaded;
        delete space.handBackBlanked;
        return {
          ownership: space.ownership,
          ...(openerCut !== undefined ? { openerCut } : {}),
          ...(reloaded !== undefined ? { reloaded } : {}),
          ...(blanked !== undefined ? { blanked } : {}),
        };
      },
      // As the runtime's: a task the agent drives, even one handed to the
      // user; the first account noted for a site stays until it's restored.
      "spaces.noteAccount": (params) => {
        const space = mock.space(params);
        if (space.ownership === "user") throw new MockError("ZEN_TASK_SPACE_INACTIVE", "ended task");
        // The runtime keeps a site as the URL parser's bare host.
        let site = "";
        try {
          const url = new URL(`https://${params.site}`);
          if (typeof params.site === "string" && !/\s/.test(params.site) && url.pathname === "/" && !url.port && !url.username && !url.search && !url.hash) site = url.hostname;
        } catch {}
        if (!site) throw new MockError("ZEN_INVALID_ARGUMENT", "noteAccount site must be the site's bare host");
        const list = space.accountsToRestore ?? [];
        if (params.restored === true) {
          space.accountsToRestore = list.filter((entry) => entry.site !== site);
        } else {
          if (typeof params.account !== "string" || !params.account || params.account.length > 254) throw new MockError("ZEN_INVALID_ARGUMENT", "noteAccount account must be one line");
          if (!list.some((entry) => entry.site === site)) space.accountsToRestore = [...list, { site, account: params.account }];
        }
        return { site, accountsToRestore: (space.accountsToRestore ?? []).map((entry) => ({ ...entry })) };
      },
      "spaces.setState": (params) => {
        const space = mock.space(params);
        mock.assertControl(space);
        space.stateText = String(params.text ?? "");
        return { ok: true };
      },
      "spaces.finish": (params) => {
        const space = mock.space(params);
        mock.assertControl(space);
        const keep: string[] =
          params.keep === "all" ? space.pages.filter((page) => page.label).map((page) => page.label!) : params.keep;
        for (const label of keep) {
          if (!space.pages.some((page) => page.label === label)) {
            throw new MockError("ZEN_PAGE_NOT_FOUND", `page label not found: ${label}`);
          }
        }
        const closing = space.pages.filter((page) => page.label && page.openedBy === "agent" && !keep.includes(page.label));
        const protectedTabs = space.pages.filter((page) => !page.label || page.openedBy !== "agent");
        const closedSpace = keep.length === 0 && protectedTabs.length === 0;
        space.pages = space.pages.filter((page) => !closing.includes(page));
        if (closedSpace) mock.spaces.delete(space.id);
        else {
          space.ownership = "user";
          for (const page of space.pages) page.label = undefined;
        }
        return {
          spaceId: space.id,
          closedSpace,
          keptManagedLabels: closedSpace ? [] : keep,
          closedManagedLabels: closing.map((page) => page.label),
          preservedUnmanagedCount: protectedTabs.filter((page) => !page.label).length,
          protectedTabCount: protectedTabs.length,
          ...(space.accountsToRestore?.length ? { accountsToRestore: space.accountsToRestore.map((entry) => ({ ...entry })) } : {}),
        };
      },
      "pages.list": (params) => {
        const space = mock.space(params);
        return space.pages
          .filter((page) => page.label)
          .map((page) => ({
            label: page.label,
            tab: page.tab,
            openedBy: page.openedBy,
            url: page.url,
            title: page.title,
            active: page.tab === space.activeTab,
            createdAt: page.createdAt,
            opener: page.opener ?? null,
          }));
      },
      "tabs.list": (params) => {
        const space = mock.space(params);
        return space.pages.map((page) => ({
          ...(page.label ? { label: page.label } : {}),
          tab: page.tab,
          title: page.title,
          url: page.url,
          active: page.tab === space.activeTab,
          openedBy: page.openedBy,
        }));
      },
      "pages.new": (params, { frame }) => {
        const space = mock.space(params);
        mock.assertControl(space);
        mock.checkBudget(space, frame.pageBudget ?? mock.pageBudget);
        const page = mock.addPage(space);
        return { label: page.label, tab: page.tab };
      },
      "pages.adopt": (params, { frame }) => {
        const space = mock.space(params);
        mock.assertControl(space);
        const page = space.pages.find((candidate) => candidate.tab === params.tab);
        if (!page) throw new MockError("ZEN_PAGE_NOT_FOUND", `untracked page ${params.tab} is no longer open`);
        if (page.label) throw new MockError("ZEN_INVALID_ARGUMENT", `target ${params.tab} is already page ${page.label}`);
        mock.checkBudget(space, frame.pageBudget ?? mock.pageBudget);
        page.label = params.as ?? `p${space.nextLabel++}`;
        return { label: page.label, tab: page.tab };
      },
      "pages.release": (params) => {
        const { space, page } = mock.page(params);
        if (params.group !== undefined && typeof params.group !== "boolean") {
          throw new MockError("ZEN_INVALID_ARGUMENT", "pages.release group must be a boolean");
        }
        // Closed groups, as the runtime keeps them: an opener and its popups
        // share a window group, and go to the user together or not at all.
        const mates = groupMates(space, page);
        if (mates.length && params.group !== true) {
          const labels = mates.map((mate) => mate.label!);
          throw new MockError(
            "ZEN_PAGE_GROUP_SHARED",
            `pages.release: page ${page.label} shares a window group with ${labels.join(", ")} of this task. Release them together with group: true, or close them first.`,
            { space: space.id, page: page.label, pages: labels },
          );
        }
        if (!mates.length) {
          if (page.openedBy === "agent") {
            throw new MockError("ZEN_INVALID_ARGUMENT", `page ${page.label} was created by the agent; close it instead of releasing it`);
          }
          page.label = undefined;
          return { tab: page.tab, openedBy: page.openedBy };
        }
        const released = [page, ...mates].map((each) => {
          const label = each.label;
          each.label = undefined;
          return { page: label, tab: each.tab, openedBy: each.openedBy };
        });
        return { ...released[0], released };
      },
      "pages.close": (params) => {
        const { space, page } = mock.page(params);
        space.pages = space.pages.filter((candidate) => candidate !== page);
        return { ok: true };
      },
      "pages.userPage": (params) => {
        const space = mock.space(params);
        const active = space.pages.find((page) => page.tab === space.activeTab);
        return active ? { label: active.label, tab: active.tab, openedBy: active.openedBy } : null;
      },
      "page.goto": (params) => {
        const { page } = mock.page(params);
        if (String(params.url).includes("slow")) {
          throw new MockError("ZEN_TIMEOUT", `page.goto timed out after ${params.options?.timeout ?? 15000}ms`, {
            committed: false,
            stopped: true,
            url: page.url,
          });
        }
        page.url = params.url;
        page.title = `Title of ${params.url}`;
        // Ego's goto and reload return action receipts.
        return {};
      },
      "page.reload": (params) => {
        mock.page(params);
        return {};
      },
      "page.info": (params) => {
        const { page } = mock.page(params);
        if (page.dialog) return { dialog: page.dialog };
        return { url: page.url, title: page.title, w: 1280, h: 720, sx: 0, sy: 0, pw: 1280, ph: 2000, loading: false };
      },
      "page.url": (params) => mock.page(params).page.url,
      "page.title": (params) => mock.page(params).page.title,
      "page.waitForURL": (params) => {
        const { page } = mock.page(params);
        const matcher = params.matcher;
        const pattern = matcher.type === "glob" ? new RegExp(matcher.regex) : new RegExp(matcher.value, matcher.flags);
        if (!pattern.test(page.url)) {
          throw new MockError(
            "ZEN_TIMEOUT",
            `page.waitForURL timed out after ${params.options?.timeout ?? 10000}ms: expected ${matcher.type === "glob" ? JSON.stringify(matcher.value) : `/${matcher.value}/${matcher.flags}`}; last URL was ${JSON.stringify(page.url)}`,
          );
        }
        return { url: page.url };
      },
      "page.waitForLoadState": (params) => ({ state: params.state }),
      "page.waitForSelector": (params) => {
        mock.page(params);
        if (String(params.target).includes("missing")) {
          throw new MockError("ZEN_TIMEOUT", `page.waitForSelector timed out after ${params.options?.timeout ?? 10000}ms`);
        }
        return { state: params.options?.state ?? "visible" };
      },
      "page.waitForFunction": async (params) => {
        if (await evaluateInMock(params, mock.page(params).page)) return true;
        throw new MockError("ZEN_TIMEOUT", "page.waitForFunction timed out");
      },
      "page.waitForEvent": (params) => {
        const { space, page } = mock.page(params);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new MockError("ZEN_TIMEOUT", `page.waitForEvent("${params.event}") timed out after ${params.options?.timeout ?? 10000}ms`)),
            params.options?.timeout ?? 10_000,
          );
          mock.#waiters.push({
            space: space.id,
            page: page.label!,
            event: params.event,
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          });
        });
      },
      "page.evaluate": (params) => evaluateInMock(params, mock.page(params).page),
      // SPEC I5, as the runtime: no path reaches it; bytes come back.
      "page.fetch": (params) => {
        mock.page(params);
        if (params.options?.saveAs !== undefined) throw new MockError("ZEN_INVALID_ARGUMENT", "page.fetch takes no saveAs: send binary: true and write the body");
        const body = `fetched ${params.url}`;
        const metadata = { ok: true, status: 200, statusText: "OK", url: params.url, headers: { "content-type": "text/plain" } };
        if (params.options?.binary === true) return { ...metadata, bodyBase64: Buffer.from(body).toString("base64") };
        return { ...metadata, body };
      },
      "page.screenshot": (params) => {
        mock.page(params);
        if (params.options?.path !== undefined) throw new MockError("ZEN_INVALID_ARGUMENT", "page.screenshot takes no path: the client writes the PNG");
        return { mimeType: "image/png", base64: MOCK_PNG.toString("base64") };
      },
      "page.snapshot": (params) => {
        const { space, page } = mock.page(params);
        const header = `[${page.label} ${JSON.stringify(page.title || page.url)} | space ${JSON.stringify(space.name)}(${space.id}): ${space.pages.filter((p) => p.label).length} managed, ${space.pages.filter((p) => !p.label).length} untracked]`;
        return {
          text: `${header}\n- document [ref=1]\n  - button "Sign in" [ref=2, loc=role:button[name='Sign in']]\n`,
          refs: [
            { ref: 1, role: "document", name: "" },
            { ref: 2, role: "button", name: "Sign in", loc: "role:button[name='Sign in']" },
          ],
        };
      },
      "page.acceptDialog": (params) => {
        const { page } = mock.page(params);
        if (!page.dialog) return { ok: false };
        page.dialog = undefined;
        return { ok: true };
      },
      "page.dismissDialog": (params) => {
        const { page } = mock.page(params);
        if (!page.dialog) throw new MockError("ZEN_DIALOG_NOT_FOUND", "no dialog is open");
        page.dialog = undefined;
        return { ok: true };
      },
      "page.events": (params) => {
        mock.page(params);
        return [{ type: "console", text: "hi" }];
      },
      "page.click": receiptFor,
      "page.dblclick": receiptFor,
      "page.hover": receiptFor,
      "page.focus": receiptFor,
      "page.press": receiptFor,
      "page.fill": receiptFor,
      "page.setInputFiles": receiptFor,
      "page.dragAndDrop": (params) => receiptFor({ ...params, target: `${params.source} ${params.target}` }),
      "page.selectOption": (params) => {
        mock.page(params);
        return {
          selected: params.values.map((value: any) => (typeof value === "string" ? value : value.value ?? value.label ?? `#${value.index}`)),
        };
      },
      "page.mouse": (params) => {
        mock.page(params);
        return {};
      },
      "page.keyboard": (params) => {
        mock.page(params);
        return {};
      },
      "filechooser.setFiles": () => ({}),
      "download.saveAs": () => {
        throw new MockError("ZEN_INVALID_ARGUMENT", "download.saveAs takes no path here: the client copies the file that download.path names");
      },
      "download.path": (params) => {
        if (mock.failingDownloads.has(params.download)) throw new MockError("ZEN_DOWNLOAD_FAILED", `download failed: NETWORK_FAILED`);
        return { path: mock.#downloadFile(params.download) };
      },
      "download.failure": () => null,
      "download.cancel": () => ({ ok: true }),
      "download.delete": (params) => {
        const file = mock.#downloadFiles.get(params.download);
        if (file) rmSync(file, { force: true });
        mock.#downloadFiles.delete(params.download);
        return { ok: true };
      },
      "events.subscribe": () => ({ ok: true }),
    };
    return handlers[method];
  }
}

/** What the mock's screenshots hold: a PNG signature, so tests can check what was written. */
export const MOCK_PNG = Buffer.from("89504e470d0a1a0a6d6f636b", "hex");

/** The frame's `hooked`, for a Hooked result or a MockError that carries one. */
function hookedOf(outcome: unknown): { hooked?: string } {
  if (outcome instanceof Hooked) return { hooked: outcome.detail };
  if (outcome instanceof MockError && outcome.hooked) return { hooked: outcome.hooked };
  return {};
}

/** A result JSON can't carry; sent as the frame-level `unserializable` string. */
export class Unserializable {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function unserializable(value: unknown): Unserializable | undefined {
  if (typeof value === "bigint") return new Unserializable(`${value}n`);
  if (typeof value !== "number") return undefined;
  if (Number.isNaN(value)) return new Unserializable("NaN");
  if (Object.is(value, -0)) return new Unserializable("-0");
  if (!Number.isFinite(value)) return new Unserializable(value > 0 ? "Infinity" : "-Infinity");
  return undefined;
}

// Like the runtime, awaits a promise result before serializing it.
async function evaluateInMock(params: Record<string, any>, page: MockPage): Promise<unknown> {
  const sandbox = {
    location: { href: page.url },
    document: { title: page.title },
    window: {} as Record<string, unknown>,
  };
  sandbox.window = sandbox;
  try {
    const source = params.isFunction
      ? `(${params.fn})(${"arg" in params ? `JSON.parse(${JSON.stringify(JSON.stringify(params.arg))})` : ""})`
      : params.fn;
    const value = await vm.runInNewContext(source, sandbox, { timeout: 1000 });
    return unserializable(value) ?? (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  } catch (error) {
    const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new MockError("ZEN_INTERNAL", `JavaScript evaluation failed: ${description}`);
  }
}

function wireError(error: unknown): Record<string, unknown> {
  if (error instanceof MockError) return { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
  return { code: "ZEN_INTERNAL", message: error instanceof Error ? error.message : String(error) };
}
