/* The problem report card (docs/agent-sidebar.md, "The problem report
 * card"). An agent's `zenius feedback` has zenius's runtime compose a report
 * for zenius's GitHub issues and propose it. Each open agent sidebar then
 * shows it here, above the chat: the title and the body exactly as they'd be
 * posted, and the user can edit both. Nothing goes out before the user's own
 * click: Send (gh posts it as them), Copy and open GitHub, or Discard.
 *
 * The card is chrome. No zenius method reaches it, since they act in web
 * pages only, and no page does. Its buttons take only trusted clicks inside
 * it. They arm 400 ms after they appear, after the window comes to the front
 * and after the panel shows again, so a click meant for what was there
 * before never lands on Send. The card never takes focus. AgentService reads
 * the report (feedbackSync) and passes the card's actions to the runtime
 * (feedbackAction). */

const ARM_MS = 400;
// GitHub's limits, for what the user types; the runtime checks them too.
const TITLE_MAX = 256;
const BODY_MAX = 65536;

const oneLine = (text, max = 300) => {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const isNumber = n => Number.isSafeInteger(n) && n > 0;

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
  const status = make("div", { id: "fb-status", className: "fb-status" });
  status.setAttribute("role", "status");
  const actions = make("div", { id: "fb-actions", className: "fb-actions" });
  el.replaceChildren(heading, lead, title, body, status, actions);
  el.setAttribute("aria-label", "Problem report");

  /** @type {{id: string, title: string, body: string, canPost: boolean, repo: string} | null} */
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

  function show(next) {
    report = next;
    title.value = next.title;
    body.value = next.body;
    duplicate = result = problem = last = null;
    phase = "review";
    render();
  }

  // The card goes, unless a newer report waits: then it shows that one.
  function close() {
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
        return { comment: `Adding a comment to #${duplicate?.number}…`, copy: "Copying…", discard: "Discarding…" }[last] ?? "Posting…";
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

  /** The buttons each phase offers: [action, label, primary]. */
  function buttons() {
    switch (phase) {
      case "review":
        return report.canPost
          ? [["send", "Send", true], ["discard", "Discard"]]
          : [["copy", "Copy and open GitHub", true], ["discard", "Discard"]];
      case "duplicate":
        return [["comment", `Add a comment to #${duplicate.number}`, true], ["postNew", "Post a new issue"], ["discard", "Discard"]];
      case "error":
        return problem.signedOut || !report.canPost
          ? [["copy", "Copy and open GitHub", true], ["retry", "Try again"], ["discard", "Discard"]]
          : [["retry", "Try again", true], ["copy", "Copy and open GitHub"], ["discard", "Discard"]];
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

  function render() {
    el.hidden = phase === "closed";
    if (phase === "closed") {
      win.clearTimeout(armTimer);
      return;
    }
    const done = phase === "posted" || phase === "copied";
    lead.hidden = title.hidden = body.hidden = done;
    title.readOnly = body.readOnly = !["review", "duplicate", "error"].includes(phase);
    if (report) {
      lead.textContent = report.canPost
        ? `An agent wrote this. Nothing is sent until you press Send, which posts it as you, as a public issue on github.com/${report.repo}.`
        : `An agent wrote this. Nothing is sent from here: Copy and open GitHub copies the body and opens a public issue form on github.com/${report.repo}.`;
    }
    status.textContent = statusText();
    status.hidden = !status.textContent;
    status.classList.toggle("error", phase === "error");
    actions.replaceChildren(
      ...buttons().map(([action, label, primary]) => {
        const button = make("button", { type: "button", textContent: label });
        button.dataset.action = action;
        button.classList.toggle("primary", !!primary);
        return button;
      })
    );
    fitTitle();
    arm();
  }

  // Buttons that just appeared, or that the user couldn't see a moment ago,
  // wait before they take a click.
  function arm() {
    armed = false;
    win.clearTimeout(armTimer);
    for (const button of actions.children) {
      button.disabled = true;
    }
    if (phase === "closed" || doc.visibilityState !== "visible") {
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
    } else if (action === "discard" && !answer?.error) {
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
    if (!report) {
      return;
    }
    if (action === "retry") {
      action = last ?? "send";
    }
    if (action === "discard") {
      last = "discard";
      run("discard", [], "posting");
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

  const onReport = next => {
    if (next && next.id === report?.id) {
      return;
    }
    // This card's result (Posted, Copied) stays until Close, which then
    // shows a newer report. Shown at once, the newer one would put Send
    // where the user just clicked, armed before they had read the result.
    const result = phase === "posted" || phase === "copied";
    if (!next) {
      // Settled: here (its result shows until Close), in another window, or
      // with no card at all.
      if (!running && !result) {
        close();
      }
      return;
    }
    if (!running && !result) {
      show(next);
    }
  };
  const unsubscribe = service.subscribeFeedback(onReport);

  const rearm = () => {
    if (phase !== "closed") {
      arm();
    }
  };
  doc.addEventListener("visibilitychange", rearm);
  topWin.addEventListener("activate", rearm);

  onReport(service.feedbackSync());

  return () => {
    unsubscribe();
    win.clearTimeout(armTimer);
    resizing.disconnect();
    title.removeEventListener("keydown", onTitleKey);
    title.removeEventListener("input", onTitleInput);
    actions.removeEventListener("click", onClick);
    doc.removeEventListener("visibilitychange", rearm);
    topWin.removeEventListener("activate", rearm);
  };
}
