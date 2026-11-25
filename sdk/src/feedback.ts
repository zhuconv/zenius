// `zenius feedback "<one line>"`: a problem report about zenius itself, for
// the user to send. The runtime composes it from the agent's line and
// zenius's own data (feedback.compose), and Zen's agent sidebar shows it in a
// card (feedback.propose). There the user reads it, may edit it, and sends it
// with their own gh, copies it to GitHub's form, or discards it. The agent
// gets only that outcome. Nothing goes out before the user's click.
//
// When no card can open (no sidebar, a runtime from before feedback.*, or
// Zen not answering), the CLI writes the report as a draft for the user to
// read and file, and prints GitHub's form with the title only: opening a
// link sends its query to GitHub before anyone reads the form.

import { cliCommit, doctor } from "./doctor.ts";
import { ZeniusError } from "./errors.ts";
import { workingDir } from "./files.ts";
import { taskSource, type TaskSource } from "./globals.ts";
import { instanceName, socketPath, zeniusHome } from "./instance.ts";
import { fs, inSandbox, os, path } from "./node.ts";
import { writeStderr, writeStdout } from "./output.ts";
import { PROTOCOL_VERSION, RpcClient } from "./rpc.ts";
import { VERSION } from "./version.ts";

export const ISSUES_URL = "https://github.com/zhuconv/zenius/issues/new";
export const TEMPLATE = "zenius-problem.md";
/** The agent's line is cut to this many characters. */
export const MAX_LINE = 300;
/** The most of the line cleanLine reads, as in the runtime: its patterns grow with the square of their input. */
export const MAX_LINE_INPUT = 2000;
/** How long the command waits for the user's answer by default, and at most. */
export const DEFAULT_WAIT_S = 100;
export const MAX_WAIT_S = 600;
const CALL_TIMEOUT_MS = 5000;

export const FEEDBACK_USAGE = `Usage: zenius feedback "<one line: what you were doing when zenius failed>" [--wait <seconds>]

Shows the user a problem report about zenius itself in Zen's agent sidebar.
They read it, may edit it, and send it to zenius's GitHub issues with their
own gh, copy it to GitHub's form, or discard it. zenius sends nothing before
their click. The command prints what they chose: it waits ${DEFAULT_WAIT_S} s by
default (--wait, at most ${MAX_WAIT_S}), and the report stays in the sidebar after.

Use it when zenius itself fails (ZEN_INTERNAL twice, the CLI crashing,
zenius doctor failing after an update), not for a site's errors.

The report holds zenius's and Zen's versions, the OS, the last calls' names,
durations and outcomes, the last failed call, and zenius doctor's results:
no URLs, page text, arguments or screenshots. Links, email addresses and the
home folder's path are taken out of the line.

When no sidebar can show it, the report becomes a draft on this computer,
and the command prints its path and GitHub's form, for the user to file.
`;

/** What the runtime told about itself, or the code of the failure when it didn't answer. */
export type RuntimeFacts = {
  /** Set when the instance didn't answer. */
  code?: string;
  zen?: string;
  version?: string;
  commit?: string;
};

/** What the CLI knows for a draft when the runtime can't compose the report. */
export type Facts = {
  cli: { version: string; protocol: number; commit?: string; sandboxed: boolean };
  node: string;
  os: { platform: string; release: string; arch: string };
  defaultInstance: boolean;
  runtime: RuntimeFacts;
  /** doctor's checks as id and status only: their summaries name paths and profiles. */
  doctor?: { id: string; status: string }[];
};

type Report = { id: string; title: string; body: string };
export type Outcome = { outcome: string; number?: number; url?: string };

/**
 * What feedback.compose gets besides the line: zenius's own facts, and who
 * writes the report, as a task's source says who drives the task. The
 * runtime keeps the source beside the report, for the card, and out of its
 * text.
 */
export type ComposeFacts = { cli: Facts["cli"]; node: string; doctor?: Facts["doctor"]; source: TaskSource };

/** How showing a report went: the user's answer, a refusal, or no card at all, with the report when compose made one. */
export type Shown =
  | { kind: "answered"; outcome: Outcome }
  | { kind: "busy" }
  | { kind: "declined"; until?: number }
  | { kind: "no_card"; error: ZeniusError; report?: Report };

const CODE = /^(?:ok|[A-Z][A-Z0-9_]{1,62})$/;
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const COMMIT = /^([0-9a-f]{4,40})(-dirty)?$/i;
const CHECK_ID = /^[a-z]{1,20}$/;
const STATUS = /^(?:ok|warn|fail|skip)$/;
const ISSUE_URL = /^https:\/\/github\.com\/zhuconv\/zenius\/issues\/[1-9][0-9]*(?:#issuecomment-[0-9]+)?$/;
/** Errors that mean no card can open: an older runtime, no sidebar, or Zen gone. */
const NO_CARD = ["ZEN_UNSUPPORTED", "ZEN_BROWSER_UNAVAILABLE"];

export async function feedbackCommand(rest: string[], instanceFlag: string | undefined): Promise<number> {
  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
    writeStdout(FEEDBACK_USAGE);
    return 0;
  }
  const words: string[] = [];
  let waitS = DEFAULT_WAIT_S;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--wait" || arg.startsWith("--wait=")) {
      const value = arg === "--wait" ? rest[++i] : arg.slice("--wait=".length);
      if (value === undefined || !/^\d{1,4}$/.test(value) || Number(value) > MAX_WAIT_S) {
        return usage(`--wait takes whole seconds, at most ${MAX_WAIT_S}`);
      }
      waitS = Number(value);
    } else {
      words.push(arg);
    }
  }
  const line = cleanLine(words.join(" "));
  if (!line) return usage("zenius feedback needs one line saying what you were doing when zenius failed");
  const instance = instanceName(instanceFlag);
  const facts = await composeFacts(instance);
  const client = new RpcClient({ socketPath: socketPath(instance), instance });
  try {
    const shown = await showReport(client, line, facts, waitS, "zenius feedback");
    switch (shown.kind) {
      case "answered":
        writeStdout(`${outcomeText(shown.outcome)}\n`);
        return 0;
      case "busy":
        writeStderr("zenius feedback: another problem report waits for the user in Zen's agent sidebar. Don't send another: tell the user it's there.\n");
        return 1;
      case "declined":
        writeStderr(`zenius feedback: ${declinedText(shown.until)} Don't send another before then.\n`);
        return 1;
      case "no_card": {
        if (shown.report) return draft(`${DRAFT_HEAD}\n\n${shown.report.body}`, shown.report.title, "no agent sidebar can show the report");
        const runtime = shown.error.code === "ZEN_BROWSER_UNAVAILABLE" ? { code: shown.error.code } : await runtimeFacts(client);
        const known: Facts = {
          cli: facts.cli,
          node: facts.node,
          os: { platform: os.platform(), release: os.release(), arch: os.arch() },
          defaultInstance: instance === "default",
          runtime,
          ...optional("doctor", facts.doctor),
        };
        return draft(draftText(line, known), issueTitle(known), runtime.code ? "Zen isn't answering" : "this Zen's zenius is older than zenius feedback's card");
      }
    }
  } finally {
    client.close();
  }
}

/**
 * zenius's own facts for feedback.compose, the CLI's and the MCP server's
 * alike. With `doctorWithinMs`, doctor's checks are left out when doctor
 * takes longer, as when it fails: the MCP server must answer within a
 * client's time for a call.
 */
export async function composeFacts(instance: string, doctorWithinMs?: number): Promise<ComposeFacts> {
  const cli = { version: VERSION, protocol: PROTOCOL_VERSION, ...optional("commit", cliCommit()), sandboxed: inSandbox() };
  // doctor first: the runtime leaves its status reads out of the report's
  // list of calls, which stays the agent's.
  const checks = doctorWithinMs === undefined ? await doctorChecks(instance) : await settleWithin(doctorChecks(instance), doctorWithinMs);
  return { cli, node: process.versions.node, ...optional("doctor", checks), source: taskSource() };
}

/** `promise`'s value, or undefined when it takes longer than `ms`. It isn't stopped: it ends in its own time. */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the report from the line and the facts, and show it in the card,
 * waiting for the user's answer up to `waitS` seconds, or up to what
 * `waitS()` says once the report is composed: the one way to a report, for
 * the CLI and the MCP server. Errors other than the card's own refusals and
 * a missing card are thrown.
 */
export async function showReport(client: RpcClient, line: string, facts: ComposeFacts, waitS: number | (() => number), op: string): Promise<Shown> {
  let report: Report;
  try {
    report = readReport(await client.call<unknown>("feedback.compose", { line, ...facts }, { op, safetyTimeoutMs: CALL_TIMEOUT_MS }));
  } catch (error) {
    if (error instanceof ZeniusError && NO_CARD.includes(error.code)) return { kind: "no_card", error };
    throw error;
  }
  try {
    const waitMs = (typeof waitS === "function" ? waitS() : waitS) * 1000;
    const outcome = readOutcome(await client.call<unknown>("feedback.propose", { id: report.id, waitMs }, { op, safetyTimeoutMs: waitMs + 15000 }));
    return { kind: "answered", outcome };
  } catch (error) {
    if (error instanceof ZeniusError) {
      if (error.code === "ZEN_FEEDBACK_PENDING") return { kind: "busy" };
      if (error.code === "ZEN_FEEDBACK_DECLINED") return { kind: "declined", ...optional("until", cooldownEnd(error.data?.until)) };
      if (NO_CARD.includes(error.code)) return { kind: "no_card", error, report };
    }
    throw error;
  }
}

function usage(message: string): number {
  writeStderr(`${message}\n\n${FEEDBACK_USAGE}`);
  return 2;
}

/**
 * What the user chose, for the agent: the outcome, and an issue's number and
 * address. `again` says how to send a revision, after a deferral.
 */
export function outcomeText({ outcome, number, url }: Outcome, again = "run zenius feedback again with the revised line"): string {
  switch (outcome) {
    case "posted":
      return `The user sent the report: issue #${number}, ${url}`;
    case "commented":
      return `The user added the report to issue #${number} as a comment: ${url}`;
    case "copied":
      return "The user copied the report to GitHub's form, to file it there.";
    case "deferred":
      return `The user wants to keep working on the report with you before anything is sent. Nothing was sent. Ask them what to change, then ${again}: it shows as a new report.`;
    case "discarded":
      return "The user discarded the report. Don't send another for now.";
    default:
      return "The report waits in Zen's agent sidebar for the user to send, copy or discard it, or to keep working on it with you. Tell the user it's there; don't send another while it waits.";
  }
}

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The cooldown's end from ZEN_FEEDBACK_DECLINED's data, if it's a time in the next hour. */
function cooldownEnd(until: unknown, now = Date.now()): number | undefined {
  return typeof until === "number" && Number.isFinite(until) && until > now && until - now <= 60 * 60 * 1000 ? until : undefined;
}

/** Why the card took no report, after the user's Discard: until when, as the user's clock shows it. An older runtime says only "10 minutes". */
export function declinedText(until: number | undefined, now = Date.now()): string {
  if (until === undefined) return "the user discarded a problem report less than 10 minutes ago.";
  const minutes = Math.max(1, Math.ceil((until - now) / 60000));
  return `the user discarded a problem report, and Zen's agent sidebar shows no new one until ${CLOCK.format(until)} (in ${minutes} min).`;
}

function readReport(value: unknown): Report {
  const { id, title, body } = (value ?? {}) as { id?: unknown; title?: unknown; body?: unknown };
  if (typeof id !== "string" || typeof title !== "string" || typeof body !== "string") {
    throw new ZeniusError("ZEN_INTERNAL", "zenius feedback: feedback.compose's answer has no id, title and body");
  }
  return { id, title, body };
}

/** Only the outcome, and an issue's number and address in zenius's own repository, reach the agent. */
export function readOutcome(value: unknown): Outcome {
  const { outcome, number, url } = (value ?? {}) as { outcome?: unknown; number?: unknown; url?: unknown };
  const known = typeof outcome === "string" && ["posted", "commented", "copied", "deferred", "discarded"].includes(outcome) ? outcome : "pending";
  if (known === "posted" || known === "commented") {
    return Number.isInteger(number) && typeof url === "string" && ISSUE_URL.test(url) ? { outcome: known, number: number as number, url } : { outcome: "pending" };
  }
  return { outcome: known };
}

const DRAFT_HEAD = [
  "# zenius feedback",
  "",
  "A draft problem report that `zenius feedback` wrote on this computer. zenius sent nothing:",
  "read it, take out anything you'd rather not share, and paste it into the issue form.",
].join("\n");

/** Write a draft for the user to file, and tell the agent where it is. */
function draft(text: string, title: string, why: string): number {
  // A sandboxed script writes the working folder, and not ~/.zenius.
  const dir = inSandbox() ? workingDir() : path.join(zeniusHome(), "feedback");
  let file: string;
  try {
    file = writeDraft(dir, text, new Date());
  } catch (error) {
    writeStderr(`zenius feedback: can't write the draft in ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}\n`);
    return 1;
  }
  writeStdout(
    [
      `${why[0]!.toUpperCase()}${why.slice(1)}, so zenius feedback wrote the report as a draft: ${file}`,
      "zenius sends nothing. Show the user the file and this link. To file the report, they read the draft, open the link and paste the draft into the form:",
      issueLink(title),
      "",
    ].join("\n"),
  );
  return 0;
}

/**
 * The agent's line as a report keeps it: one line, without links, email
 * addresses or the home folder's path, which a task's details would bring
 * in, and at most MAX_LINE characters. The runtime cleans it the same way
 * (runtime/JS/zenius/modules/feedbacktext.sys.mjs).
 */
export function cleanLine(text: string, home = os.homedir()): string {
  let line = text.slice(0, MAX_LINE_INPUT).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
  line = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<link>")
    .replace(/\b(?:data|javascript|blob|about|mailto):\S+/gi, "<link>")
    .replace(/(?<![\w.@~-]\/?)www\.\S+/gi, "<link>")
    .replace(/(?<![\w.@~-]\/?)(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?\/\S*/gi, "<link>");
  if (home.length > 1) line = line.split(home).join("~");
  line = line
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  return chars.length > MAX_LINE ? `${chars.slice(0, MAX_LINE - 3).join("")}...` : line;
}

/** doctor's checks as id and status, in the shape feedback.compose takes; undefined when doctor didn't finish. */
async function doctorChecks(instance: string): Promise<Facts["doctor"]> {
  try {
    return (await doctor({ instance })).checks.map(({ id, status }) => ({ id, status })).filter(({ id, status }) => CHECK_ID.test(id) && STATUS.test(status));
  } catch {
    return undefined;
  }
}

/** A runtime from before feedback.* still says which it is. */
async function runtimeFacts(client: RpcClient): Promise<RuntimeFacts> {
  try {
    return readVersion(await client.call<unknown>("browser.version", {}, { op: "zenius feedback", safetyTimeoutMs: CALL_TIMEOUT_MS }));
  } catch (error) {
    return { code: error instanceof ZeniusError && CODE.test(error.code) ? error.code : "ZEN_INTERNAL" };
  }
}

function readVersion(result: unknown): RuntimeFacts {
  const value = (result ?? {}) as { zenVersion?: unknown; runtimeVersion?: unknown; install?: { commit?: unknown } | null };
  const text = (entry: unknown) => (typeof entry === "string" && VERSION_TEXT.test(entry) ? entry : undefined);
  const commit = typeof value.install?.commit === "string" ? COMMIT.exec(value.install.commit) : null;
  return {
    ...optional("zen", text(value.zenVersion)),
    ...optional("version", text(value.runtimeVersion)),
    ...optional("commit", commit ? `${commit[1]!.length === 40 ? commit[1]!.slice(0, 7) : commit[1]}${commit[2] ?? ""}`.toLowerCase() : undefined),
  };
}

/**
 * The draft when the runtime can't compose the report: the same sections as
 * the runtime's (and the issue template's), with what the CLI knows itself.
 */
export function draftText(line: string, facts: Facts): string {
  const { cli, runtime } = facts;
  const unknown = runtime.code ? "Not known: the instance didn't answer." : "Not known: this Zen's zenius is older than zenius feedback's card.";
  return [
    DRAFT_HEAD,
    "It holds only what zenius collects about itself: no URLs, page text, arguments or screenshots.",
    "",
    "## What went wrong, in the agent's words",
    "",
    // An indented code block: the line shows as written, and no Markdown or HTML in it renders.
    `    ${line}`,
    "",
    "## Versions",
    "",
    `- zenius ${cli.version} (protocol ${cli.protocol}${cli.sandboxed ? ", sandboxed" : ""})${cli.commit ? `, commit ${cli.commit}` : ""}`,
    runtime.code
      ? `- zenius runtime: the instance didn't answer (${runtime.code})`
      : `- zenius runtime ${runtime.version ?? "of an unknown version"}${runtime.commit ? `, installed from commit ${runtime.commit}` : ""}`,
    `- Zen ${runtime.zen ?? "of an unknown version"}`,
    `- Node ${facts.node}`,
    `- OS: ${facts.os.platform} ${facts.os.release}, ${facts.os.arch}`,
    `- Instance: ${facts.defaultInstance ? "the default one" : "not the default one"}`,
    "",
    "## The last failed call",
    "",
    unknown,
    "",
    "## The last calls, oldest first",
    "",
    unknown,
    "",
    "## zenius doctor",
    "",
    facts.doctor
      ? facts.doctor
          .filter(({ id, status }) => CHECK_ID.test(id) && STATUS.test(status))
          .map(({ id, status }) => `${id} ${status}`)
          .join(", ") || "No checks."
      : "Not known: doctor didn't finish.",
    "",
  ].join("\n");
}

/** The draft's title, from zenius's own data only. */
export function issueTitle(facts: Facts): string {
  return facts.runtime.code ? `zenius ${facts.cli.version}: ${facts.runtime.code}` : `zenius ${facts.cli.version}: a problem report`;
}

/** GitHub's issue form with the template and the title: the body never goes in the link. */
export function issueLink(title: string): string {
  const link = new URL(ISSUES_URL);
  link.searchParams.set("template", TEMPLATE);
  link.searchParams.set("title", title);
  return link.href;
}

/** Write the draft as <UTC time>.md, readable only by the user, never over an earlier one. */
export function writeDraft(dir: string, text: string, at: Date): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
  for (let n = 1; ; n += 1) {
    const file = path.join(dir, `${stamp}${n > 1 ? `-${n}` : ""}.md`);
    try {
      fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 99) throw error;
    }
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
