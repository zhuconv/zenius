// The text of a `zenius feedback` problem report (zen-core): the agent's
// line cleaned, the checks on what a client may send, the issue's title and
// body, and GitHub's limits. Plain functions with no imports, so Node's unit
// tests load this file as well (tests/unit/feedback-text.test.mjs) and check
// its sections against the issue template that GitHub's form opens,
// .github/ISSUE_TEMPLATE/zenius-problem.md.

/** Where reports go: the card shows it, and every gh command names it. */
export const REPO = "zhuconv/zenius";
/** The issue template's file name, which the new-issue link names. */
export const TEMPLATE = "zenius-problem.md";
/** The agent's line, at most. */
export const LINE_MAX = 300;
/**
 * The most of a line that cleanLine reads. Its patterns take time that grows
 * with the square of their input, and feedback.compose runs on the parent's
 * main thread: a line of a few hundred kilobytes from any socket client
 * would freeze Zen for minutes. The CLI never sends more than LINE_MAX.
 */
export const LINE_INPUT_MAX = 2000;
/** GitHub's limits for an issue's title and body, which edited text meets too. */
export const TITLE_MAX = 256;
export const BODY_MAX = 65536;

const METHOD = /^[A-Za-z][A-Za-z0-9]{0,40}(?:\.[A-Za-z][A-Za-z0-9]{0,40}){0,3}$/;
const CODE = /^(?:ok|[A-Z][A-Z0-9_]{1,62})$/;
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const COMMIT = /^[0-9a-f]{4,40}(?:-dirty)?$/;
const CHECK_ID = /^[a-z]{1,20}$/;
const STATUS = /^(?:ok|warn|fail|skip)$/;
const OS_TEXT = /^[0-9A-Za-z][0-9A-Za-z ,._()+-]{0,63}$/;

/**
 * The agent's line as a report shows it: one line, without links, email
 * addresses or the home folder's path, which a task's details would bring
 * in, and at most LINE_MAX characters. The CLI cleans it the same way
 * (sdk/src/feedback.ts), for the draft it writes when no card can open.
 *
 * @param {string} text
 * @param {string} [home]  the home folder's path, shown as ~
 */
export function cleanLine(text, home = "") {
  let line = String(text).slice(0, LINE_INPUT_MAX).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
  // A host without a scheme (www.example.com/x, shop.example.com/x) never
  // starts inside a word, an address or a local path: not right after a word
  // character, dot, hyphen, @ or ~, or after a slash that follows one. So a
  // local path's dotted folder (/tmp/app.cache/x, ~/Sites/www.example.com/x)
  // stays, and a dotted home folder does until it's ~ below.
  line = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<link>")
    .replace(/\b(?:data|javascript|blob|about|mailto):\S+/gi, "<link>")
    .replace(/(?<![\w.@~-]\/?)www\.\S+/gi, "<link>")
    // The host's last label is letters only, as a top-level domain's is, so
    // a folder such as app.v2/ stays; a dotted word with no slash, such as
    // page.snapshot, stays too.
    .replace(/(?<![\w.@~-]\/?)(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?\/\S*/gi, "<link>");
  // The home folder's path after the links, which take it with them, and
  // before the addresses, so an email-shaped one (/home/jane@corp.example)
  // is ~ too. Everywhere it shows, so the user's name never stays.
  if (home.length > 1) {
    line = line.split(home).join("~");
  }
  line = line
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  return chars.length > LINE_MAX ? `${chars.slice(0, LINE_MAX - 3).join("")}...` : line;
}

/**
 * What a client sent for a report, checked field by field. Only these
 * fields reach the report, each held to a narrow shape, so the agent's line
 * is the only free text in it: a script that calls feedback.compose itself
 * can't put a page's data in a public issue any other way. Other fields are
 * left out.
 *
 * @param {object} params  feedback.compose's params
 * @param {string} [home]
 * @returns {{line: string, cli: {version: string, protocol: number, commit: string|null, sandboxed: boolean}, node: string, doctor: {id: string, status: string}[]|null}}
 * @throws {Error} naming the field that doesn't fit
 */
export function clientFacts(params, home = "") {
  const p = params && typeof params === "object" ? params : {};
  if (typeof p.line !== "string") {
    throw new Error("line must be a string: what the agent was doing when zenius failed, in one line");
  }
  const line = cleanLine(p.line, home);
  if (!line) {
    throw new Error("line is empty: say in one line what you were doing when zenius failed");
  }
  const cli = p.cli && typeof p.cli === "object" ? p.cli : {};
  if (typeof cli.version !== "string" || !VERSION_TEXT.test(cli.version)) {
    throw new Error("cli.version must be a version, such as 0.1.4");
  }
  if (!Number.isInteger(cli.protocol) || cli.protocol < 0 || cli.protocol > 999) {
    throw new Error("cli.protocol must be a whole number");
  }
  if (cli.commit !== undefined && cli.commit !== null && (typeof cli.commit !== "string" || !COMMIT.test(cli.commit))) {
    throw new Error("cli.commit must be a commit's short hash, with -dirty if the copy had changes");
  }
  if (cli.sandboxed !== undefined && typeof cli.sandboxed !== "boolean") {
    throw new Error("cli.sandboxed must be true or false");
  }
  if (typeof p.node !== "string" || !VERSION_TEXT.test(p.node.replace(/^v/, ""))) {
    throw new Error("node must be Node's version, such as v24.11.0");
  }
  let doctor = null;
  if (p.doctor !== undefined && p.doctor !== null) {
    if (!Array.isArray(p.doctor) || p.doctor.length > 40) {
      throw new Error("doctor must be a list of at most 40 checks, as {id, status}");
    }
    doctor = p.doctor.map((check, i) => {
      if (!check || !CHECK_ID.test(check.id) || !STATUS.test(check.status)) {
        throw new Error(`doctor[${i}] must be {id, status}: an id of lowercase letters, and ok, warn, fail or skip`);
      }
      return { id: check.id, status: check.status };
    });
  }
  return {
    line,
    cli: { version: cli.version, protocol: cli.protocol, commit: cli.commit ?? null, sandboxed: cli.sandboxed === true },
    node: p.node.replace(/^v/, ""),
    doctor,
  };
}

/**
 * The issue's title, from zenius's own data only: its version and what
 * failed last.
 *
 * @param {{cli: {version: string}, lastFailure: {method: string, code: string}|null}} facts
 */
export function reportTitle(facts) {
  const failure = facts.lastFailure;
  return failure ? `zenius ${facts.cli.version}: ${failure.code} in ${failure.method}` : `zenius ${facts.cli.version}: a problem report`;
}

/**
 * The issue's body, in the template's sections. The agent's line is an
 * indented code block, so nothing in it renders as Markdown or HTML.
 *
 * @param {object} facts  clientFacts() plus the runtime's own: runtime
 *   {version, commit}, zen, os, defaultInstance, calls, lastFailure
 */
export function reportBody(facts) {
  const { cli, runtime } = facts;
  return [
    "From `zenius feedback`. It holds only what zenius collects about itself: no URLs, page text, arguments or screenshots.",
    "",
    "## What went wrong, in the agent's words",
    "",
    `    ${facts.line}`,
    "",
    "## Versions",
    "",
    `- zenius ${cli.version} (protocol ${cli.protocol}${cli.sandboxed ? ", sandboxed" : ""})${cli.commit ? `, commit ${cli.commit}` : ""}`,
    `- zenius runtime ${shown(runtime.version, VERSION_TEXT)}${runtime.commit && COMMIT.test(runtime.commit) ? `, installed from commit ${runtime.commit}` : ""}`,
    `- Zen ${shown(facts.zen, VERSION_TEXT)}`,
    `- Node ${facts.node}`,
    `- OS: ${shown(facts.os, OS_TEXT)}`,
    `- Instance: ${facts.defaultInstance ? "the default one" : "not the default one"}`,
    "",
    "## The last failed call",
    "",
    failureText(facts.lastFailure),
    "",
    "## The last calls, oldest first",
    "",
    ...callsText(facts.calls),
    "",
    "## zenius doctor",
    "",
    facts.doctor ? facts.doctor.map(({ id, status }) => `${id} ${status}`).join(", ") || "No checks." : "Not known: doctor didn't finish.",
    "",
  ].join("\n");
}

function shown(text, shape) {
  return typeof text === "string" && shape.test(text) ? text : "of an unknown version";
}

/** A call as a report keeps it: only a known method's name, a duration and a code. */
function fits(call) {
  return call && METHOD.test(call.method) && CODE.test(call.code) && Number.isInteger(call.ms) && call.ms >= 0;
}

function failureText(failure) {
  if (!failure || !fits(failure)) {
    return "None since Zen started.";
  }
  return `${failure.method}: ${failure.code} after ${failure.ms} ms, ${agoText(failure.ago)} before this report.`;
}

function callsText(calls) {
  const kept = (calls ?? []).filter(fits);
  if (!kept.length) {
    return ["None since Zen started."];
  }
  return ["| Method | ms | Outcome |", "|---|--:|---|", ...kept.map(({ method, ms, code }) => `| ${method} | ${ms} | ${code} |`)];
}

function agoText(seconds) {
  const s = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : 0;
  if (s < 90) {
    return `${s} s`;
  }
  if (s < 90 * 60) {
    return `${Math.round(s / 60)} min`;
  }
  return `${Math.round(s / 3600)} h`;
}

/** Why GitHub would refuse this title, or the card couldn't show it as posted; null when it fits. */
export function titleProblem(title) {
  if (typeof title !== "string" || !title.trim()) {
    return "the title is empty";
  }
  if (title.length > TITLE_MAX) {
    return `the title is longer than ${TITLE_MAX} characters`;
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)) {
    return "the title has a line break or a hidden character";
  }
  return null;
}

/** Why GitHub would refuse this body, or the card couldn't show it as posted; null when it fits. */
export function bodyProblem(body) {
  if (typeof body !== "string" || !body.trim()) {
    return "the body is empty";
  }
  if (body.length > BODY_MAX) {
    return `the body is longer than ${BODY_MAX} characters`;
  }
  if (/[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}]/u.test(body)) {
    return "the body has a hidden or control character";
  }
  return null;
}

/** The number of an issue of `repo` from its page's address, or null. */
export function issueNumber(url, repo = REPO) {
  const match = typeof url === "string" && url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]{0,9})$/);
  return match && match[1] === repo ? Number(match[2]) : null;
}

/** The issue's number from a comment's address on an issue of `repo`, or null. */
export function commentIssue(url, repo = REPO) {
  const match = typeof url === "string" && url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]{0,9})#issuecomment-[0-9]{1,20}$/);
  return match && match[1] === repo ? Number(match[2]) : null;
}

/**
 * The open issues from gh's search whose title is exactly `title`, as
 * {number, title, url}: GitHub's search matches words, not whole titles.
 *
 * @param {unknown} list  gh issue list's JSON
 */
export function sameTitle(list, title, repo = REPO) {
  const want = String(title).trim();
  return (Array.isArray(list) ? list : [])
    .filter(issue => issue && typeof issue.title === "string" && issue.title.trim() === want && issueNumber(issue.url, repo) === issue.number)
    .map(({ number, title: found, url }) => ({ number, title: found, url }));
}

/**
 * GitHub's new-issue form with the template and the title filled in. The
 * body never goes in the link: the user pastes it from the clipboard.
 *
 * @param {string} title
 * @param {string} [base]  the form's address; tests name a fixture's
 */
export function newIssueLink(title, base = `https://github.com/${REPO}/issues/new`) {
  const link = new URL(base);
  link.searchParams.set("template", TEMPLATE);
  link.searchParams.set("title", title);
  return link.href;
}
