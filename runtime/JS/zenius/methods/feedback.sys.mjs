// feedback.* methods (the core): a problem report about zenius itself, which
// the user reads in the sidebar's card and sends, copies, keeps working on
// with the agent, or discards (modules/feedback.sys.mjs). The report holds
// zenius's own data and the agent's one line, nothing from pages.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { feedback, WAIT_MAX_MS } from "chrome://userscripts/content/zenius/modules/feedback.sys.mjs";
import { clientFacts, reportBody, reportTitle } from "chrome://userscripts/content/zenius/modules/feedbacktext.sys.mjs";
import { cleanSource } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";
import { RUNTIME_VERSION, zenVersion } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

export const access = {
  "feedback.compose": "none",
  "feedback.propose": "none",
  "dev.answerFeedback": "none",
};

export const i5 = {
  "feedback.compose": "none",
  "feedback.propose": "none",
  "dev.answerFeedback": "dev",
};

const ACTIONS = ["send", "postNew", "comment", "copyAndOpen", "defer", "discard", "undo"];

function home() {
  try {
    return Services.dirsvc.get("Home", Ci.nsIFile).path;
  } catch {
    return "";
  }
}

function osText() {
  const info = name => {
    try {
      return String(Services.sysinfo.getProperty(name));
    } catch {
      return "";
    }
  };
  return `${info("name")} ${info("version")}, ${info("arch")}`;
}

/** The install's commit as a report shows it: short, as `git log --oneline` does. */
function installCommit(install) {
  const commit = String(install?.commit ?? "").toLowerCase();
  const match = commit.match(/^([0-9a-f]{4,40})(-dirty)?$/);
  return match ? `${match[1].length === 40 ? match[1].slice(0, 7) : match[1]}${match[2] ?? ""}` : null;
}

export const methods = {
  // The client's fields (feedbacktext's clientFacts), plus the runtime's
  // own data: its version and install, Zen's, the OS, and its last calls.
  "feedback.compose": async (ctx, params) => {
    // Who wrote it, as a task's source says who drives the task: the card
    // names the sidebar's chat from it. It stays beside the report, never in
    // its text, which may go to GitHub.
    const source = cleanSource(params?.source, "a problem report's source");
    let client;
    try {
      client = clientFacts(params, home());
    } catch (e) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `feedback.compose: ${e.message}`);
    }
    const { calls, lastFailure } = ctx.service.recentCalls();
    const facts = {
      ...client,
      runtime: { version: RUNTIME_VERSION, commit: installCommit(ctx.service.install) },
      zen: zenVersion(),
      os: osText(),
      defaultInstance: ctx.service.instance === "default",
      calls,
      lastFailure,
    };
    return feedback.compose({ title: reportTitle(facts), body: reportBody(facts), source });
  },

  "feedback.propose": async (ctx, params) => {
    const { id, waitMs = WAIT_MAX_MS } = params ?? {};
    if (typeof id !== "string" || !id) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "feedback.propose: id must be the id feedback.compose returned");
    }
    if (typeof waitMs !== "number" || !(waitMs >= 0)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "feedback.propose: waitMs must be a number of milliseconds");
    }
    // A wait its client canceled ends at once; the card stays for the user.
    return ctx.unlessStopped(feedback.propose(id, waitMs, ctx.conn ?? null));
  },

  // Tests only: the user's answer on the card, as its buttons give it. It
  // waits for a report to show, so a test can send it beside the proposal.
  // Undo acts on the discarded report, `id` or the cooldown's.
  "dev.answerFeedback": async (ctx, params) => {
    const { action, title, body, number, id, timeoutMs = 10000 } = params ?? {};
    if (!ACTIONS.includes(action)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `dev.answerFeedback: action must be one of ${ACTIONS.join(", ")}`);
    }
    if (action === "undo") {
      const discarded = id ?? feedback.cooldown()?.discarded;
      return discarded ? feedback.undo(discarded) : { answered: false };
    }
    const until = Date.now() + timeoutMs;
    let shown = feedback.pending();
    while (!shown && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50));
      shown = feedback.pending();
    }
    if (!shown) {
      return { answered: false };
    }
    const fields = { title: title ?? shown.title, body: body ?? shown.body };
    if (action === "comment") {
      return feedback.comment(shown.id, number, { body: fields.body });
    }
    if (action === "discard" || action === "defer") {
      return feedback[action](shown.id);
    }
    return feedback[action](shown.id, fields, null);
  },
};
