/* The problem report card (docs/agent-sidebar.md, "The problem report
 * card"). An agent's `zenius feedback`, or a Work task's report_problem
 * (zenius's MCP tool), has zenius's runtime compose a report for zenius's
 * GitHub issues and propose it. Each open agent sidebar then shows it here,
 * above the chat: the title and the body exactly as they'd be posted, and
 * the user can edit both. Nothing goes out before the user's own click: Send
 * (gh posts it as them), Copy and open GitHub, Not yet (the user goes on
 * refining it with the agent, whose new version comes as a new card), or
 * Discard.
 *
 * A Discard holds new reports off for a while (the runtime's cooldown).
 * Meanwhile the card is one line that says so, in every window's sidebar,
 * with an Undo that brings the report back and ends the cooldown.
 *
 * The card is chrome. No zenius method reaches it, since they act in web
 * pages only, and no page does. Its buttons take only trusted clicks inside
 * it. They arm 400 ms after they appear, after the window comes to the front
 * and after the panel shows again, so a click meant for what was there
 * before never lands on Send, and a double click on Discard never takes it
 * back. The card never takes focus. AgentService reads the report and the
 * cooldown (feedbackSync) and passes the card's actions to the runtime
 * (feedbackAction). */

const ARM_MS = 400;
// GitHub's limits, for what the user types; the runtime checks them too.
const TITLE_MAX = 256;
const BODY_MAX = 65536;
// The line's words reach a screen reader once, through the status, which
// is then emptied, so reading the card finds the line's own, current words.
const SAID_MS = 2000;

const NOT_YET_TIP = "Not yet: nothing is sent. Keep refining it: tell the agent what to change, and its new version shows here.";

/** "10 min", or in its last minute "59 s" down to "1 s" (never "60 s"): how long new reports are held off. */
function span(ms) {
  return ms > 59000 ? `${Math.ceil(ms / 60000)} min` : `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

/** The one line a Discard leaves, until its cooldown ends. */
function lineText(cooldown, now) {
  const left = span(cooldown.until - now);
  return cooldown.refused ? `Discarded. A new report couldn't show; reports open again in ${left}.` : `Discarded. No new reports for ${left}.`;
}

const oneLine = (text, max = 300) => {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const isNumber = n => Number.isSafeInteger(n) && n > 0;
// Bidi controls in a title the lead quotes go, so the title can't end its
// isolate early or carry its direction past it.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Who wrote the report, as the lead says first: the task its source names,
 * by the name the task shows, while the sidebar has that Work chat
 * (AgentService.feedbackAuthor), else an agent.
 */
function writer(service, report) {
  const by = service.feedbackAuthor?.(report.sidebar);
  if (!by) {
    return "An agent wrote this.";
  }
  const title = oneLine(by.title.replace(BIDI_CONTROLS, ""), 60);
  return title ? `${by.agent} wrote this in your task “\u2068${title}\u2069”.` : `${by.agent} wrote this in one of your tasks.`;
}

/**
 * Builds the card in `el` and keeps it in step with the waiting report.
 *
 * @param {object} options
 * @param {HTMLElement} options.el  the panel's #feedback
 * @param {object} options.service  AgentService
 * @param {(url: string) => void} options.openLink  opens a web page in a new tab (the glue's)
 * @returns {() => void}  takes the card down, at the panel's unload
 */
export function mountFeedback({ el, service, openLink }) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const topWin = win.browsingContext.topChromeWindow;
  const make = (tag, props = {}) => Object.assign(doc.createElement(tag), props);

  const heading = make("div", { className: "fb-title", textContent: "Report a problem in zenius" });
  const lead = make("div", { id: "fb-lead", className: "fb-lead" });
  // The title is one line, wrapped to the card's width so all of it shows,
  // even in the narrowest sidebar: Enter adds no line, and a pasted line
  // break becomes a space, as in a one-line field.
  const title = make("textarea", { id: "fb-issue-title", className: "fb-field", maxLength: TITLE_MAX, spellcheck: false, rows: 1 });
  title.setAttribute("aria-label", "Issue title");
  // Gecko has no field-sizing yet: the box takes its text's height.
  const fitTitle = () => {
    if (title.hidden || el.hidden) {
      return;
    }
    title.style.height = "auto";
    const s = win.getComputedStyle(title);
    title.style.height = `${title.scrollHeight + parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth)}px`;
  };
  const onTitleKey = event => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
    }
  };
  const onTitleInput = () => {
    if (/[\r\n]/.test(title.value)) {
      const at = title.selectionStart;
      title.value = title.value.replace(/\r\n|[\r\n]/g, " ");
      title.setSelectionRange(at, at);
    }
    fitTitle();
  };
  title.addEventListener("keydown", onTitleKey);
  title.addEventListener("input", onTitleInput);
  let fittedWidth = 0;
  const resizing = new win.ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (width !== fittedWidth) {
      fittedWidth = width;
      fitTitle();
    }
  });
  resizing.observe(el);
  const body = make("textarea", { id: "fb-issue-body", className: "fb-field", maxLength: BODY_MAX, spellcheck: false, rows: 10 });
  body.setAttribute("aria-label", "Issue body");
  // After a Discard, the card's one line (lineText), for the whole cooldown.
  const line = make("div", { id: "fb-line", className: "fb-line", hidden: true });
  const status = make("div", { id: "fb-status", className: "fb-status" });
  status.setAttribute("role", "status");
  const actions = make("div", { id: "fb-actions", className: "fb-actions" });
  el.replaceChildren(heading, lead, title, body, line, status, actions);
  el.setAttribute("aria-label", "Problem report");

  /** @type {{id: string, title: string, body: string, canPost: boolean, repo: string, cooldownMs: number|null} | null} */
  let report = null;
  // review, checking, duplicate, posting, posted, copied, error, busy or closed
  let phase = "closed";
  let duplicate = null; // {number, title}: the open issue with the same title
  let result = null; // {number, url, commented}
  let problem = null; // {text, signedOut}
  let last = null; // the action Try again repeats
  let running = false; // an action of this card's waits for the runtime
  let armed = false;
  let armTimer = 0;
  /** @type {{until: number, discarded: string|null, refused: {at: number}|null} | null} the runtime's, after a Discard */
  let cooldown = null;
  // What the user typed into a report that went unsent, for an Undo that
  // brings it back: {id, title, body}.
  let kept = null;
  let lineFor = null; // the discarded report's id whose Undo the line shows, while it shows
  let lineSaid = ""; // what the status last told a screen reader of the line
  let lineProblem = null; // why the line's Undo failed
  let tickTimer = 0;
  let saidTimer = 0;

  function show(next) {
    report = next;
    const edits = kept?.id === next.id ? kept : null;
    title.value = edits ? edits.title : next.title;
    body.value = edits ? edits.body : next.body;
    kept = null;
    duplicate = result = problem = last = null;
    phase = "review";
    render();
  }

  // The card goes, unless a newer report waits: then it shows that one.
  // While a Discard's cooldown runs, it goes to its one line.
  function close() {
    if (report && phase !== "posted" && phase !== "copied" && (title.value !== report.title || body.value !== report.body)) {
      kept = { id: report.id, title: title.value, body: body.value };
    }
    const next = service.feedbackReport;
    if (next && next.id !== report?.id) {
      show(next);
      return;
    }
    phase = "closed";
    report = null;
    render();
  }

  function statusText() {
    const where = `github.com/${report?.repo ?? result?.repo}`;
    switch (phase) {
      case "checking":
        return `Looking for an open issue with this title on ${where}…`;
      case "duplicate":
        return `An open issue has this title: #${duplicate.number}. Add your report's body to it as a comment (its title stays as it is), or post a new issue?`;
      case "posting":
        return { comment: `Adding a comment to #${duplicate?.number}…`, copy: "Copying…", defer: "Telling the agent…", discard: "Discarding…" }[last] ?? "Posting…";
      case "posted":
        return result.commented ? `Added as a comment to #${result.number}.` : `Posted as #${result.number}.`;
      case "copied":
        return "Copied the body. Paste it into the issue form that opened.";
      case "error":
        return problem.signedOut
          ? "gh isn't signed in to GitHub. Sign in with gh auth login and try again, or copy the report."
          : `Couldn't send it: ${problem.text}`;
      case "busy":
        return "It's being sent from another window.";
      default:
        return "";
    }
  }

  /**
   * The buttons each phase offers: [action, label, primary]. Wherever the
   * report can still be discarded, Not yet can leave it for the agent to
   * revise, with no cooldown.
   */
  function buttons() {
    const leave = [["defer", "Not yet"], ["discard", "Discard"]];
    switch (phase) {
      case "review":
        return report.canPost ? [["send", "Send", true], ...leave] : [["copy", "Copy and open GitHub", true], ...leave];
      case "duplicate":
        return [["comment", `Add a comment to #${duplicate.number}`, true], ["postNew", "Post a new issue"], ...leave];
      case "error":
        return problem.signedOut || !report.canPost
          ? [["copy", "Copy and open GitHub", true], ["retry", "Try again"], ...leave]
          : [["retry", "Try again", true], ["copy", "Copy and open GitHub"], ...leave];
      case "busy":
        return [["retry", "Try again"]];
      case "posted":
        return result.url ? [["open", `Open #${result.number}`, true], ["close", "Close"]] : [["close", "Close"]];
      case "copied":
        return [["close", "Close"]];
      default:
        return [];
    }
  }

  // Says why a button does what it does: Not yet sends nothing, and Discard
  // holds new reports off.
  function tipFor(action) {
    if (action === "defer") {
      return NOT_YET_TIP;
    }
    if (action === "discard" && report?.cooldownMs) {
      return `Discard. No new reports for ${span(report.cooldownMs)}.`;
    }
    return "";
  }

  function makeButton(action, label, primary) {
    const button = make("button", { type: "button", textContent: label });
    button.dataset.action = action;
    button.classList.toggle("primary", !!primary);
    const tip = tipFor(action);
    if (tip) {
      button.title = tip;
    }
    return button;
  }

  /** The cooldown whose line the card shows: only with no report on it, and only while it runs. */
  function lineCooldown() {
    return phase === "closed" && cooldown && cooldown.until > Date.now() ? cooldown : null;
  }

  function render() {
    const one = lineCooldown();
    el.hidden = phase === "closed" && !one;
    el.classList.toggle("fb-one-line", !!one);
    if (!one) {
      leaveLine();
    }
    if (el.hidden) {
      win.clearTimeout(armTimer);
      return;
    }
    if (one) {
      renderLine(one);
      return;
    }
    heading.hidden = false;
    const done = phase === "posted" || phase === "copied";
    lead.hidden = title.hidden = body.hidden = done;
    title.readOnly = body.readOnly = !["review", "duplicate", "error"].includes(phase);
    if (report) {
      const who = writer(service, report);
      lead.textContent = report.canPost
        ? `${who} Nothing is sent until you press Send, which posts it as you, as a public issue on github.com/${report.repo}.`
        : `${who} Nothing is sent from here: Copy and open GitHub copies the body and opens a public issue form on github.com/${report.repo}.`;
    }
    status.textContent = statusText();
    status.hidden = !status.textContent;
    status.classList.toggle("error", phase === "error");
    actions.replaceChildren(...buttons().map(([action, label, primary]) => makeButton(action, label, primary)));
    fitTitle();
    arm();
  }

  /**
   * The one line after a Discard, with its Undo. Its minutes count down;
   * a screen reader hears the line when it changes (a Discard, a report it
   * kept out), not each minute. Undo is built and armed once for its
   * report: a refusal noticed meanwhile changes the words, not the button,
   * so an agent proposing again and again can't keep Undo from arming.
   */
  function renderLine(one) {
    heading.hidden = lead.hidden = title.hidden = body.hidden = true;
    line.hidden = false;
    // "" for a cooldown with no report to bring back: a line with no Undo.
    const key = one.discarded ?? "";
    if (lineFor !== key) {
      lineFor = key;
      lineProblem = null;
      actions.replaceChildren(...(one.discarded ? [makeButton("undo", "Undo", false)] : []));
      arm();
    }
    const text = lineText(one, Date.now());
    line.textContent = lineProblem ? `${text} Couldn't undo it: ${lineProblem}` : text;
    status.classList.remove("error");
    const say = one.refused ? "refused" : "discarded";
    if (lineSaid !== say) {
      lineSaid = say;
      status.hidden = false;
      status.textContent = line.textContent;
      win.clearTimeout(saidTimer);
      saidTimer = win.setTimeout(() => {
        if (lineFor !== null && el.classList.contains("fb-one-line")) {
          status.textContent = "";
        }
      }, SAID_MS);
    }
    tickAfter(one);
  }

  function leaveLine() {
    if (lineFor === null && !lineSaid) {
      return;
    }
    win.clearTimeout(tickTimer);
    win.clearTimeout(saidTimer);
    line.hidden = true;
    line.textContent = "";
    lineFor = null;
    lineSaid = "";
    lineProblem = null;
    status.textContent = "";
  }

  // The next time the line's words change (span): at the next whole minute
  // left, at 59 s, then each second. Once the time is up, the line goes (the
  // runtime says "reopened" too).
  function tickAfter(one) {
    win.clearTimeout(tickTimer);
    const left = one.until - Date.now();
    const next = left > 60000 ? left % 60000 || 60000 : left > 59000 ? left - 59000 : left % 1000 || 1000;
    tickTimer = win.setTimeout(tick, Math.max(0, Math.min(left, next)) + 5);
  }

  function tick() {
    const one = lineCooldown();
    if (!one) {
      service.feedbackSync();
      render();
      return;
    }
    const text = lineText(one, Date.now());
    line.textContent = lineProblem ? `${text} Couldn't undo it: ${lineProblem}` : text;
    tickAfter(one);
  }

  // Buttons that just appeared, or that the user couldn't see a moment ago,
  // wait before they take a click.
  function arm() {
    armed = false;
    win.clearTimeout(armTimer);
    for (const button of actions.children) {
      button.disabled = true;
    }
    // The line's Undo arms too: only a card that isn't there doesn't.
    if (el.hidden || doc.visibilityState !== "visible") {
      return;
    }
    armTimer = win.setTimeout(() => {
      armed = true;
      for (const button of actions.children) {
        button.disabled = false;
      }
    }, ARM_MS);
  }

  async function run(action, args, busyPhase) {
    const id = report.id;
    running = true;
    phase = busyPhase;
    render();
    let answer;
    try {
      answer = await service.feedbackAction(action, id, ...args);
    } finally {
      running = false;
    }
    if (report?.id !== id) {
      return; // a newer report took the card meanwhile
    }
    if (answer?.busy) {
      phase = "busy";
    } else if (action === "send" && answer?.duplicate && isNumber(answer.duplicate.number)) {
      duplicate = { number: answer.duplicate.number };
      phase = "duplicate";
    } else if (answer?.posted && isNumber(answer.posted.number)) {
      result = issueResult(answer.posted, false);
      phase = "posted";
    } else if (answer?.commented && isNumber(answer.commented.number)) {
      result = issueResult(answer.commented, true);
      phase = "posted";
    } else if (action === "copyAndOpen" && !answer?.error) {
      phase = "copied";
    } else if ((action === "defer" || action === "discard") && !answer?.error) {
      close();
      return;
    } else {
      problem = { text: oneLine(answer?.error || "zenius gave no answer"), signedOut: answer?.signedOut === true };
      phase = "error";
    }
    // Settled meanwhile, here or in another window: only this card's own
    // result is left to show. Anything else goes, for a newer report if one
    // waits.
    if (phase !== "posted" && phase !== "copied" && service.feedbackReport?.id !== id) {
      close();
      return;
    }
    render();
  }

  // The issue's page, only if it's the repo's issue (or a comment on it).
  function issueResult(issue, commented) {
    const repo = report.repo;
    const page = new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/issues/${issue.number}(#issuecomment-\\d+)?$`);
    const url = typeof issue.url === "string" && page.test(issue.url) ? issue.url : null;
    return { number: issue.number, url, commented, repo };
  }

  // Undo, on the line: the runtime shows the discarded report again under
  // its id and ends the cooldown. Every window's card then shows it, this
  // one with what the user had typed into it (kept).
  async function undo() {
    const id = cooldown?.discarded;
    if (!id || running) {
      return;
    }
    running = true;
    for (const button of actions.children) {
      button.disabled = true;
    }
    let answer;
    try {
      answer = await service.feedbackAction("undo", id);
    } finally {
      running = false;
    }
    lineProblem = answer?.error ? oneLine(answer.error) : null;
    // The runtime's "asked" came while this waited: show what's there now,
    // or the line again with why its Undo failed.
    onFeedback(service.feedbackSync(), service.feedbackCooldown);
    if (lineCooldown()) {
      arm();
    }
  }

  function act(action) {
    if (action === "close") {
      close();
      return;
    }
    if (action === "open") {
      if (result?.url) {
        openLink(result.url);
      }
      return;
    }
    if (action === "undo") {
      undo();
      return;
    }
    if (!report) {
      return;
    }
    if (action === "retry") {
      action = last ?? "send";
    }
    if (action === "defer" || action === "discard") {
      last = action;
      run(action, [], "posting");
      return;
    }
    const fields = { title: title.value, body: body.value };
    if (!fields.title.trim() || !fields.body.trim()) {
      problem = { text: fields.title.trim() ? "the body is empty." : "the title is empty.", signedOut: false };
      phase = "error";
      render();
      return;
    }
    last = action;
    if (action === "send") {
      run("send", [fields], "checking");
    } else if (action === "postNew") {
      run("postNew", [fields], "posting");
    } else if (action === "comment" && duplicate) {
      run("comment", [duplicate.number, { body: fields.body }], "posting");
    } else if (action === "copy") {
      run("copyAndOpen", [fields, topWin], "posting");
    }
  }

  const onClick = event => {
    const button = event.target?.closest?.("button[data-action]");
    if (!event.isTrusted || event.type !== "click" || !button || !actions.contains(button) || !armed || button.disabled || running) {
      return;
    }
    act(button.dataset.action);
  };
  actions.addEventListener("click", onClick);

  function onFeedback(next, nextCooldown) {
    cooldown = nextCooldown ?? null;
    // An action of this card's under way decides what shows once it ends.
    if (running) {
      return;
    }
    if (next && next.id === report?.id) {
      return;
    }
    // This card's result (Posted, Copied) stays until Close, which then
    // shows a newer report. Shown at once, the newer one would put Send
    // where the user just clicked, armed before they had read the result.
    if (phase === "posted" || phase === "copied") {
      return;
    }
    if (!next) {
      // Settled: here, in another window, or with no card at all. Or only
      // the cooldown changed: its line comes, changes or goes.
      close();
      return;
    }
    show(next);
  }
  const unsubscribe = service.subscribeFeedback(onFeedback);

  const rearm = () => {
    if (!el.hidden) {
      arm();
    }
  };
  doc.addEventListener("visibilitychange", rearm);
  topWin.addEventListener("activate", rearm);

  onFeedback(service.feedbackSync(), service.feedbackCooldown);

  return () => {
    unsubscribe();
    win.clearTimeout(armTimer);
    win.clearTimeout(tickTimer);
    win.clearTimeout(saidTimer);
    resizing.disconnect();
    title.removeEventListener("keydown", onTitleKey);
    title.removeEventListener("input", onTitleInput);
    actions.removeEventListener("click", onClick);
    doc.removeEventListener("visibilitychange", rearm);
    topWin.removeEventListener("activate", rearm);
  };
}
