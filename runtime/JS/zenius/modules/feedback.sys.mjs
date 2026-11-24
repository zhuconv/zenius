// zenius feedback's reports and the sidebar card's actions on them (zen-core).
//
// feedback.compose keeps a report's text under a new id; feedback.propose
// shows it in every open agent sidebar (zen-sidebar's card) and waits for the
// user. The card calls this module's actions in process, each on the user's
// own click: send (search for an open issue with the same title, then post),
// postNew, comment (on an issue that search found), copyAndOpen and discard.
// No zenius method reaches them except dev.answerFeedback, which only a dev
// profile has. gh runs from here, with fixed arguments, as the user.
//
// What holds, for the agent and for review:
// - a report's text never changes under its id, and the card's actions post
//   exactly the title and body the card passes, to REPO, which pending()
//   shows the card;
// - one report waits at a time, and after a Discard the next proposal waits
//   DECLINED_MS;
// - the agent gets the outcome, an issue's number and its address, never the
//   edited text or gh's messages.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import {
  bodyProblem,
  commentIssue,
  issueNumber,
  newIssueLink,
  REPO,
  sameTitle,
  titleProblem,
} from "chrome://userscripts/content/zenius/modules/feedbacktext.sys.mjs";
import { devMode, log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/** The sidebar observes it: "asked" when a report waits, "settled" when it's answered. */
export const TOPIC = "zenius-feedback";
/** How long propose waits for the user at most, as a claim's prompt does. */
export const WAIT_MAX_MS = 10 * 60 * 1000;
/** After a Discard, how long the next proposal is refused. */
export const DECLINED_MS = 10 * 60 * 1000;
/** How long an unanswered report's text is kept for a proposal. */
const KEEP_MS = 60 * 60 * 1000;
const MAX_REPORTS = 20;
const GH_TIMEOUT_MS = 60 * 1000;
const GH_OUTPUT_MAX = 1024 * 1024;
// Where a gh installed by Homebrew or a package manager lives: a Zen started
// from the Dock gets a PATH without them.
const GH_PLACES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
// Dev profiles only (devMode): the tests' fake gh, and the new-issue form's
// address, so no test reaches GitHub. Read nowhere else.
const PREF_GH = "zenius.feedback.gh";
const PREF_ISSUES_URL = "zenius.feedback.issuesUrl";
// The repository with its host: gh runs with Zen's environment, where a
// GH_HOST would otherwise point it at another server.
const GH_REPO = `github.com/${REPO}`;
// gh asks nothing and prints no color or notices: its output is parsed.
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/**
 * The gh this Zen would run, or null. The user's Zen looks on PATH and in
 * GH_PLACES. A dev profile runs only the gh its pref names: a developer's
 * own gh may be signed in, and no test may post.
 */
export function findGh() {
  if (devMode()) {
    const named = Services.prefs.getStringPref(PREF_GH, "");
    return named.startsWith("/") && executable(named) ? named : null;
  }
  const dirs = [...(Services.env.get("PATH") || "").split(":"), ...GH_PLACES];
  for (const dir of dirs) {
    if (dir.startsWith("/")) {
      const file = PathUtils.join(dir, "gh");
      if (executable(file)) {
        return file;
      }
    }
  }
  return null;
}

function executable(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.exists() && file.isFile() && file.isExecutable();
  } catch {
    return false;
  }
}

function issuesUrl() {
  const named = devMode() ? Services.prefs.getStringPref(PREF_ISSUES_URL, "") : "";
  return named || `https://github.com/${REPO}/issues/new`;
}

const firstLine = text =>
  String(text)
    .split("\n")
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 300) ?? "";

const lastLine = text =>
  String(text)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .pop() ?? "";

async function readAll(pipe) {
  let text = "";
  for (;;) {
    const chunk = await pipe.readString();
    if (!chunk) {
      return text;
    }
    if (text.length < GH_OUTPUT_MAX) {
      text += chunk;
    }
  }
}

/**
 * Run gh with fixed arguments and `input` on its stdin.
 *
 * @returns {Promise<{stdout: string} | {failed: {error: string, signedOut?: true}}>}
 */
async function runGh(gh, args, input = "") {
  const t0 = Date.now();
  let proc;
  try {
    proc = await Subprocess.call({ command: gh, arguments: args, environment: GH_ENV, environmentAppend: true, stderr: "pipe" });
  } catch (e) {
    return { failed: { error: `gh didn't start: ${firstLine(e?.message ?? e)}` } };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(2000);
  }, GH_TIMEOUT_MS);
  try {
    const out = readAll(proc.stdout);
    const err = readAll(proc.stderr);
    if (input) {
      await proc.stdin.write(input);
    }
    await proc.stdin.close();
    const [stdout, stderr, { exitCode }] = await Promise.all([out, err, proc.wait()]);
    // gh's own words go to the card only, never to the agent: the log keeps
    // the command's name and outcome.
    log(`feedback: gh ${args[0]} ${args[1]} ended ${timedOut ? "at its time limit" : exitCode} in ${Date.now() - t0}ms`);
    if (timedOut) {
      return { failed: { error: `gh didn't finish in ${GH_TIMEOUT_MS / 1000} s` } };
    }
    if (exitCode === 0) {
      return { stdout };
    }
    // gh's exit code when it needs a sign-in.
    if (exitCode === 4) {
      return { failed: { error: "gh isn't signed in to GitHub: sign in with gh auth login, or use Copy and open GitHub", signedOut: true } };
    }
    return { failed: { error: firstLine(stderr) || `gh ended with ${exitCode}` } };
  } catch (e) {
    return { failed: { error: `gh failed: ${firstLine(e?.message ?? e)}` } };
  } finally {
    clearTimeout(timer);
  }
}

const notify = verdict => Services.obs.notifyObservers(null, TOPIC, verdict);

class Feedback {
  /** @type {Map<string, {id: string, title: string, body: string, at: number, outcome: object|null, found: Set<number>, busy: boolean, waiters: Set<object>}>} */
  #reports = new Map();
  /** The report the card shows: proposed, and not answered yet. */
  #shown = null;
  #declinedUntil = 0;

  /**
   * Keep a report's text under a new id. The text is fixed from here on.
   *
   * @param {{title: string, body: string}} text
   * @returns {{id: string, title: string, body: string}}
   */
  compose({ title, body }) {
    this.#prune();
    const id = Services.uuid.generateUUID().toString();
    this.#reports.set(id, { id, title, body, at: Date.now(), outcome: null, found: new Set(), busy: false, waiters: new Set() });
    return { id, title, body };
  }

  #prune() {
    const old = Date.now() - KEEP_MS;
    for (const [id, report] of this.#reports) {
      if (report !== this.#shown && (report.at < old || this.#reports.size > MAX_REPORTS)) {
        this.#reports.delete(id);
      }
    }
  }

  /**
   * Show the report in the sidebar's card and wait for the user, at most
   * `waitMs`. The card stays when the wait ends or the caller goes, until
   * the user answers; proposing the same id again waits again, and once
   * the user answered it returns that outcome at once.
   *
   * @param {string} id  from compose
   * @param {number} waitMs
   * @param {object|null} conn  the caller's connection: its closing ends the wait, not the card
   * @returns {Promise<{outcome: "posted"|"commented"|"copied"|"discarded"|"pending", number?: number, url?: string}>}
   */
  propose(id, waitMs, conn) {
    const report = this.#reports.get(id);
    if (!report) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "no report with that id: compose one first (a report waits an hour for its proposal)");
    }
    if (report.outcome) {
      return Promise.resolve(report.outcome);
    }
    if (this.#shown && this.#shown !== report) {
      throw new ZenError("ZEN_FEEDBACK_PENDING", "another problem report waits for the user's answer in the sidebar: one report at a time");
    }
    if (!this.#shown) {
      const left = this.#declinedUntil - Date.now();
      if (left > 0) {
        throw new ZenError(
          "ZEN_FEEDBACK_DECLINED",
          `the user discarded a problem report less than ${DECLINED_MS / 60000} minutes ago: don't propose another before then`,
          { retryAfterMs: Math.ceil(left) }
        );
      }
      if (!Services.obs.enumerateObservers(TOPIC).hasMoreElements()) {
        throw new ZenError("ZEN_UNSUPPORTED", "no agent sidebar can show the report: zenius feedback writes a draft instead", { reason: "no_sidebar" });
      }
      this.#shown = report;
      notify("asked");
    }
    const wait = Math.min(Math.max(0, waitMs), WAIT_MAX_MS);
    return new Promise(resolve => {
      const waiter = {};
      const hooks = conn?.state ? (conn.state.onClose ??= []) : null;
      waiter.done = outcome => {
        clearTimeout(waiter.timer);
        report.waiters.delete(waiter);
        const i = hooks ? hooks.indexOf(waiter.onClose) : -1;
        if (i >= 0) {
          hooks.splice(i, 1);
        }
        resolve(outcome);
      };
      waiter.timer = setTimeout(() => waiter.done({ outcome: "pending" }), wait);
      if (hooks) {
        waiter.onClose = () => waiter.done({ outcome: "pending" });
        hooks.push(waiter.onClose);
      }
      report.waiters.add(waiter);
    });
  }

  /**
   * The report the card shows, or null: its id, its text as composed, whether
   * a gh was found to Send with (no gh runs for it), and where it would go.
   *
   * @returns {{id: string, title: string, body: string, canPost: boolean, repo: string} | null}
   */
  pending() {
    const report = this.#shown;
    return report ? { id: report.id, title: report.title, body: report.body, canPost: findGh() !== null, repo: REPO } : null;
  }

  /**
   * Send: an open issue with exactly this title comes back as `duplicate`,
   * for the card to ask about; otherwise the issue is posted.
   *
   * @returns {Promise<{duplicate: {number: number, title: string, url: string}} | {posted: {number: number, url: string}} | {error: string, signedOut?: true} | {busy: true}>}
   */
  send(id, fields) {
    return this.#act(id, async report => {
      const problem = titleProblem(fields?.title) ?? bodyProblem(fields?.body);
      const gh = problem ? null : findGh();
      if (problem || !gh) {
        return { error: problem ?? "no gh was found: use Copy and open GitHub" };
      }
      const listed = await runGh(gh, [
        "issue",
        "list",
        `--repo=${GH_REPO}`,
        "--state=open",
        `--search=${fields.title} in:title`,
        "--json=number,title,url",
        "--limit=30",
      ]);
      if (listed.failed) {
        return listed.failed;
      }
      let issues;
      try {
        issues = JSON.parse(listed.stdout);
      } catch {
        return { error: "gh's search answer wasn't JSON" };
      }
      const same = sameTitle(issues, fields.title);
      if (same.length) {
        for (const issue of same) {
          report.found.add(issue.number);
        }
        return { duplicate: same[0] };
      }
      return this.#create(report, gh, fields);
    });
  }

  /** Post a new issue, after the card asked about a duplicate. */
  postNew(id, fields) {
    return this.#act(id, async report => {
      const problem = titleProblem(fields?.title) ?? bodyProblem(fields?.body);
      const gh = problem ? null : findGh();
      if (problem || !gh) {
        return { error: problem ?? "no gh was found: use Copy and open GitHub" };
      }
      return this.#create(report, gh, fields);
    });
  }

  async #create(report, gh, { title, body }) {
    const created = await runGh(gh, ["issue", "create", `--repo=${GH_REPO}`, `--title=${title}`, "--body-file=-"], body);
    if (created.failed) {
      return created.failed;
    }
    const url = lastLine(created.stdout);
    const number = issueNumber(url);
    if (!number) {
      return { error: "gh's answer wasn't the new issue's address: look at the repository's issues before trying again" };
    }
    this.#settle(report, { outcome: "posted", number, url });
    return { posted: { number, url } };
  }

  /** Add the body as a comment on an issue that this report's own search found. */
  comment(id, number, fields) {
    return this.#act(id, async report => {
      if (!Number.isInteger(number) || !report.found.has(number)) {
        return { error: "that issue isn't one the search found for this report" };
      }
      const problem = bodyProblem(fields?.body);
      const gh = problem ? null : findGh();
      if (problem || !gh) {
        return { error: problem ?? "no gh was found: use Copy and open GitHub" };
      }
      const commented = await runGh(gh, ["issue", "comment", String(number), `--repo=${GH_REPO}`, "--body-file=-"], fields.body);
      if (commented.failed) {
        return commented.failed;
      }
      const url = lastLine(commented.stdout);
      if (commentIssue(url) !== number) {
        return { error: "gh's answer wasn't the comment's address: look at the issue before trying again" };
      }
      this.#settle(report, { outcome: "commented", number, url });
      return { commented: { number, url } };
    });
  }

  /**
   * The body as shown goes to the clipboard, and a new tab in `win` opens
   * GitHub's form with the template and the title. The body never goes in
   * the link.
   */
  copyAndOpen(id, fields, win) {
    return this.#act(id, async report => {
      const problem = titleProblem(fields?.title) ?? bodyProblem(fields?.body);
      if (problem) {
        return { error: problem };
      }
      const target = win?.gBrowser ? win : Services.wm.getMostRecentWindow("navigator:browser");
      if (!target) {
        return { error: "no browser window to open GitHub's form in" };
      }
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(fields.body);
      target.openTrustedLinkIn(newIssueLink(fields.title, issuesUrl()), "tab");
      this.#settle(report, { outcome: "copied" });
      return {};
    });
  }

  /** The user discarded the report: the next proposal waits DECLINED_MS. */
  discard(id) {
    return this.#act(id, async report => {
      this.#declinedUntil = Date.now() + DECLINED_MS;
      this.#settle(report, { outcome: "discarded" });
      return {};
    });
  }

  /** One action at a time, on the report the card shows. */
  async #act(id, fn) {
    const report = this.#shown;
    if (!report || report.id !== id) {
      return { error: "this report no longer waits for an answer" };
    }
    if (report.busy) {
      return { busy: true };
    }
    report.busy = true;
    try {
      return await fn(report);
    } catch (e) {
      return { error: firstLine(e?.message ?? e) || "the action failed" };
    } finally {
      report.busy = false;
    }
  }

  #settle(report, outcome) {
    report.outcome = Object.freeze(outcome);
    if (this.#shown === report) {
      this.#shown = null;
    }
    for (const waiter of [...report.waiters]) {
      waiter.done(report.outcome);
    }
    notify("settled");
  }
}

export const feedback = new Feedback();
