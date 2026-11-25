// The problem report card in the agent sidebar (feedback.mjs; docs/agent-sidebar.md,
// "The problem report card"). An agent's `zenius feedback` has zenius's
// runtime compose a report and propose it; the card shows it, and only the
// user's own clicks send, copy or discard it.
//
// Most tests drive the card through the runtime's side of the contract
// (service.feedback: pending() and the card's actions, and the
// zenius-feedback notices), played by a stand-in that answers as the runtime
// would, so each of the card's states can be reached on purpose. The last
// ones run the runtime's own module, with a fake gh: nothing reaches GitHub,
// and only a headless run presses Copy, since a headed one would write the
// system's clipboard.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { setup } from "./lib.mjs";

const run = Date.now().toString(36).slice(-5);
const REPORT = {
  id: `fb-${run}`,
  title: "zenius 0.1.3: ZEN_INTERNAL in page.click",
  body: "## What happened\n\n    The click failed twice on the same button\n\n## zenius\n\n- runtime: 0.1.3\n- last failure: page.click, 812 ms, ZEN_INTERNAL\n",
  canPost: true,
  repo: "zhuconv/zenius",
};
const SCENARIOS = "chrome://userscripts/content/agent-sidebar/selfcheck.sys.mjs";
const SELFCHECK_WINDOW = "chrome://userscripts/content/zenius/selfcheck/window.xhtml";

let h;
// Whether the window showed the sidebar before this file: a new window
// adopts its opener's sidebar, so a sidebar left open here would open in
// the next file's windows too.
let sidebarWasOpen = false;

const HELPERS = `
  const A = win.ucAgentSidebar.AgentService;
  const svc = A.zenius();
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch {}
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(25);
    }
  };
  const panelDoc = (w = win) => w.document.getElementById("sidebar")?.contentDocument;
  const card = (w = win) => panelDoc(w)?.getElementById("feedback") ?? null;
  const shown = (w = win) => {
    const c = card(w);
    return c && !c.hidden ? c : null;
  };
  /** What the card shows: its fields, words and buttons ("*" marks the primary one). */
  const view = (w = win) => {
    const c = card(w);
    if (!c || c.hidden) return null;
    const $ = id => c.ownerDocument.getElementById(id);
    const buttons = [...$("fb-actions").children];
    return {
      title: $("fb-issue-title").hidden ? null : $("fb-issue-title").value,
      body: $("fb-issue-body").hidden ? null : $("fb-issue-body").value,
      readOnly: $("fb-issue-title").readOnly,
      lead: $("fb-lead").hidden ? null : $("fb-lead").textContent,
      status: $("fb-status").hidden ? null : $("fb-status").textContent,
      buttons: buttons.map(b => (b.classList.contains("primary") ? "*" : "") + b.textContent),
      disabled: buttons.map(b => b.disabled),
      tips: buttons.map(b => b.title),
      line: $("fb-line").hidden ? null : $("fb-line").textContent,
      oneLine: c.classList.contains("fb-one-line"),
    };
  };
  const button = (label, w = win) => [...(card(w)?.querySelectorAll("#fb-actions button") ?? [])].find(b => b.textContent === label);
  /** The user's click on one of the card's buttons, once it has armed. */
  const press = async (label, w = win) => {
    const b = await until(() => {
      const x = button(label, w);
      return x && !x.disabled && x;
    }, "the armed button " + label);
    b.click();
  };
  const openPanel = async (w = win) => {
    if (!(w.SidebarController.isOpen && w.SidebarController.currentID === "viewAgentSidebar")) {
      await w.SidebarController.show("viewAgentSidebar");
    }
    await until(() => w.ucAgentSidebar.panel && card(w), "the sidebar's panel");
  };
  /**
   * The runtime's side, as its service.feedback answers: pending(),
   * cooldown() and the card's actions. arg.answers lists each action's
   * answers in turn; a post, a comment, a copy, a Not yet or a discard
   * settles the report, as the runtime's do, and a discard starts a
   * cooldown of arg.cooldownMs (10 minutes) that Undo ends. arg.hold names
   * actions that wait for release().
   */
  const install = arg => {
    const old = Object.getOwnPropertyDescriptor(svc, "feedback");
    const s = {
      report: arg.report,
      answers: arg.answers ?? {},
      hold: arg.hold ?? [],
      cooldownMs: arg.cooldownMs ?? 600000,
      // As cooldown() answers: {until, discarded, refused}, after a discard.
      cooling: null,
      discarded: null,
      log: [],
      releases: [],
      pending() {
        return this.report;
      },
      cooldown() {
        return this.cooling;
      },
      async act(action, id, args) {
        this.log.push({ action, id, args: args.map(a => (a && typeof a === "object" && "document" in a ? (a === win ? "this window" : "another window") : a)) });
        // Each call takes its answer as it comes, held or not.
        const answer = (this.answers[action] ?? []).shift() ?? {};
        if (this.hold.includes(action)) {
          await new Promise(r => this.releases.push(r));
        }
        const settles = answer.posted || answer.commented || (["copyAndOpen", "defer", "discard"].includes(action) && !answer.error && !answer.busy);
        if (settles && this.report?.id === id) {
          if (action === "discard") {
            this.discarded = this.report;
            this.cooling = { until: Date.now() + this.cooldownMs, discarded: id, refused: null };
          }
          this.report = null;
          Services.obs.notifyObservers(null, "zenius-feedback", "settled");
        }
        return answer;
      },
      send(id, fields) {
        return this.act("send", id, [fields]);
      },
      postNew(id, fields) {
        return this.act("postNew", id, [fields]);
      },
      comment(id, number, fields) {
        return this.act("comment", id, [number, fields]);
      },
      copyAndOpen(id, fields, w) {
        return this.act("copyAndOpen", id, [fields, w]);
      },
      defer(id) {
        return this.act("defer", id, []);
      },
      discard(id) {
        return this.act("discard", id, []);
      },
      async undo(id) {
        this.log.push({ action: "undo", id, args: [] });
        const answer = (this.answers.undo ?? []).shift();
        if (answer) {
          return answer;
        }
        if (!this.cooling || this.cooling.discarded !== id || this.report) {
          return { error: "this report's Discard can't be undone any more" };
        }
        this.cooling = null;
        this.report = this.discarded;
        Services.obs.notifyObservers(null, "zenius-feedback", "asked");
        return {};
      },
      // A proposal the cooldown turned away, and the cooldown's end, as the runtime notifies them.
      refuse() {
        this.cooling = { ...this.cooling, refused: { at: Date.now() } };
        Services.obs.notifyObservers(null, "zenius-feedback", "declined");
      },
      reopen() {
        this.cooling = null;
        Services.obs.notifyObservers(null, "zenius-feedback", "reopened");
      },
      restore() {
        if (old) Object.defineProperty(svc, "feedback", old);
        else delete svc.feedback;
      },
    };
    Object.defineProperty(svc, "feedback", { value: s, configurable: true, writable: true });
    Services.obs.notifyObservers(null, "zenius-feedback", "asked");
    return s;
  };
  const stub = () => svc.feedback;
`;

const chrome = (code, arg) => h.call("dev.evalChrome", { code: `${HELPERS}\n${code}`, arg });

before(async () => {
  h = await setup();
  sidebarWasOpen = await chrome(`
    const open = win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar";
    await openPanel();
    return open;
  `);
});

// Each test starts with no report waiting and the stand-in gone.
beforeEach(async () => {
  await chrome(`
    const s = stub();
    if (s?.restore) {
      s.report = null;
      for (const r of s.releases) r();
      s.restore();
    }
    Services.obs.notifyObservers(null, "zenius-feedback", "settled");
    const c = card();
    if (c && !c.hidden) {
      const close = button("Close");
      if (close) {
        await until(() => !close.disabled, "Close");
        close.click();
      }
    }
    await until(() => !shown(), "no card");
    return true;
  `);
});

after(async () => {
  await chrome(
    `
    stub()?.restore?.();
    Services.obs.notifyObservers(null, "zenius-feedback", "settled");
    if (!arg) win.SidebarController.hide();
    return true;
  `,
    sidebarWasOpen
  ).catch(() => {});
  await h?.close();
});

test("a waiting report shows in the open sidebar exactly as it would be posted, with Send and Discard, and takes no focus", async () => {
  const out = await chrome(
    `
    const focused = () => Services.focus.getFocusedElementForWindow(win, true, {});
    const before = focused();
    install({ report: arg });
    await until(() => shown(), "the card");
    const v = view();
    const doc = panelDoc();
    // The empty chat's hint is placed over the panel's middle: it gives way.
    const hint = doc.defaultView.getComputedStyle(doc.getElementById("empty")).display;
    return { v, focusKept: focused() === before, report: A.feedbackReport, hint };
  `,
    REPORT
  );
  assert.equal(out.hint, "none", "the empty chat's hint showed over the card");
  assert.equal(out.v.title, REPORT.title);
  assert.equal(out.v.body, REPORT.body);
  assert.equal(out.v.readOnly, false, "the user can edit it");
  assert.match(out.v.lead, /Nothing is sent until you press Send/);
  assert.match(out.v.lead, /public issue on github\.com\/zhuconv\/zenius/);
  assert.deepEqual(out.v.buttons, ["*Send", "Not yet", "Discard"]);
  assert.equal(out.v.status, null);
  assert.ok(out.focusKept, "the card took the focus");
  assert.deepEqual(out.report, { ...REPORT, cooldownMs: null, sidebar: null });
});

test("the lead names the task whose agent wrote the report, by the report's source and the names the sidebar shows, only while the sidebar has that Work chat; anything else says an agent wrote it", async () => {
  const out = await chrome(
    `
    const M = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentService.sys.mjs");
    // A task is the sidebar's once its first question goes (addTask), as
    // its zenius server, and so the report tool, runs only from then on.
    const conv = A.createTask();
    A.addTask(conv, "Find flights to Tokyo");
    // The agent by the name the sidebar gives its harness, not by its id.
    const harnessList = A.harnessList;
    A.harnessList = () => [{ id: conv.harness, name: "Stand-in Agent" }];
    let n = 0;
    // Each report a new id, so the card shows it afresh; the lead up to its
    // second sentence, which says what Send does.
    const leadFor = async source => {
      const report = { ...arg, id: arg.id + "-by" + n++, source };
      const s = stub();
      if (s?.restore) {
        s.report = report;
        Services.obs.notifyObservers(null, "zenius-feedback", "asked");
      } else {
        install({ report });
      }
      await until(() => A.feedbackReport?.id === report.id && shown(), "the card for " + report.id);
      return view().lead.split(" Nothing is sent")[0];
    };
    try {
      conv.title = "Tokyo \\u202eflights";
      const named = await leadFor({ sidebar: conv.uid, terminal: "devbox/t1" });
      // The user's name for the task wins, as everywhere the task shows.
      A.renameTask(conv, "Our trip");
      const renamed = await leadFor({ sidebar: conv.uid });
      A.renameTask(conv, "");
      conv.title = "";
      const untitled = await leadFor({ sidebar: conv.uid });
      const unknown = await leadFor({ sidebar: "0000-not-a-task" });
      const external = await leadFor({ agent: "claude-code", terminal: "devbox/t5", folder: "/work" });
      const none = await leadFor(undefined);
      A.removeTask(conv);
      const removed = await leadFor({ sidebar: conv.uid });
      return {
        named,
        renamed,
        untitled,
        unknown,
        external,
        none,
        removed,
        pure: {
          kept: M.feedbackOf({ ...arg, source: { sidebar: "abc-123" } })?.sidebar,
          bad: ["../x", "a".repeat(65), 7, null].map(sidebar => M.feedbackOf({ ...arg, source: { sidebar } })?.sidebar),
          shownAnyway: M.feedbackOf({ ...arg, source: "not an object" })?.sidebar,
        },
      };
    } finally {
      A.harnessList = harnessList;
      if (A.tasks.has(conv.uid)) A.removeTask(conv);
    }
  `,
    REPORT
  );
  // The title's bidi control is gone, and the title sits in an isolate.
  assert.equal(out.named, "Stand-in Agent wrote this in your task “\u2068Tokyo flights\u2069”.");
  assert.equal(out.renamed, "Stand-in Agent wrote this in your task “\u2068Our trip\u2069”.");
  assert.equal(out.untitled, "Stand-in Agent wrote this in one of your tasks.");
  for (const k of ["unknown", "external", "none", "removed"]) {
    assert.equal(out[k], "An agent wrote this.", k);
  }
  // Of the source, feedbackOf keeps only a well-formed sidebar uid; a bad
  // source never hides the report, since it isn't posted.
  assert.deepEqual(out.pure, { kept: "abc-123", bad: [null, null, null, null], shownAnyway: null });
});

test("the title shows all of itself, wrapped, and stays one line: Enter adds none, and a pasted line break becomes a space", async () => {
  const long = `${REPORT.title} while the page's own script was still loading the form's second step`;
  const out = await chrome(
    `
    install({ report: { ...arg, title: arg.long } });
    await until(() => shown(), "the card");
    const doc = panelDoc();
    const t = doc.getElementById("fb-issue-title");
    const lineHeight = parseFloat(doc.defaultView.getComputedStyle(t).lineHeight);
    const shown1 = { whole: t.scrollHeight <= t.clientHeight + 1, lines: Math.round((t.clientHeight - 8) / lineHeight) };
    const enter = new doc.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const enterAdded = t.dispatchEvent(enter);
    t.value = "first line" + String.fromCharCode(10) + "second line";
    t.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    return { shown1, enterAdded, pasted: t.value };
  `,
    { ...REPORT, long }
  );
  assert.ok(out.shown1.whole, "the title box hid part of the title");
  assert.ok(out.shown1.lines >= 2, `a long title stayed on ${out.shown1.lines} line`);
  assert.equal(out.enterAdded, false, "Enter wasn't held back in the title");
  assert.equal(out.pasted, "first line second line");
});

test("the buttons arm 400 ms after they appear, and again when new ones take their place: an earlier click does nothing", async () => {
  const out = await chrome(
    `
    const s = install({ report: arg, answers: { send: [{ duplicate: { number: 7, title: arg.title, url: "https://github.com/zhuconv/zenius/issues/7" } }] } });
    await until(() => shown(), "the card");
    const first = view().disabled;
    button("Send").click();
    await sleep(100);
    const early = s.log.length;
    await press("Send");
    await until(() => button("Add a comment to #7"), "the duplicate question");
    const second = view().disabled;
    button("Add a comment to #7").click();
    await sleep(100);
    const afterEarly = s.log.length;
    await sleep(450);
    return { first, early, second, afterEarly, armed: view().disabled, log: s.log.map(e => e.action) };
  `,
    REPORT
  );
  assert.deepEqual(out.first, [true, true, true], "Send, Not yet and Discard took a click as they appeared");
  assert.equal(out.early, 0, "a click before Send armed sent the report");
  assert.deepEqual(out.second, [true, true, true, true], "the duplicate question's buttons took a click as they appeared");
  assert.equal(out.afterEarly, 1, "a click before the comment button armed went through");
  assert.deepEqual(out.armed, [false, false, false, false]);
  assert.deepEqual(out.log, ["send"]);
});

test("Send posts the fields' text as the user edited it, then shows the issue until Close", async () => {
  const out = await chrome(
    `
    const s = install({ report: arg, answers: { send: [{ posted: { number: 41, url: "https://github.com/zhuconv/zenius/issues/41" } }] } });
    await until(() => shown(), "the card");
    const doc = panelDoc();
    doc.getElementById("fb-issue-title").value = arg.title + " (edited)";
    doc.getElementById("fb-issue-body").value = arg.body + "\\nAnd one line of mine.\\n";
    await press("Send");
    await until(() => view()?.status?.startsWith("Posted"), "the posted line");
    const posted = view();
    const settled = A.feedbackReport;
    await press("Close");
    await until(() => !shown(), "the card to close");
    return { log: s.log, posted, settled };
  `,
    REPORT
  );
  assert.deepEqual(out.log, [{ action: "send", id: REPORT.id, args: [{ title: `${REPORT.title} (edited)`, body: `${REPORT.body}\nAnd one line of mine.\n` }] }]);
  assert.equal(out.posted.status, "Posted as #41.");
  assert.deepEqual(out.posted.buttons, ["*Open #41", "Close"]);
  assert.equal(out.posted.title, null, "the fields stayed after the post");
  assert.equal(out.settled, null, "the report still waited after the post");
});

test("a newer report waits behind this card's Posted or Copied result and shows at Close, so Send never takes the place of a result", async () => {
  const out = await chrome(
    `
    const results = {};
    const s = install({
      report: arg.report,
      answers: { send: [{ posted: { number: 41, url: "https://github.com/zhuconv/zenius/issues/41" } }], copyAndOpen: [{}] },
    });
    // The agent hears the outcome and proposes again at once, while the
    // card shows what the user's click did.
    const proposeAgain = async next => {
      s.report = next;
      Services.obs.notifyObservers(null, "zenius-feedback", "asked");
      await until(() => A.feedbackReport?.id === next.id, "the newer report " + next.id);
      // Past the 400 ms a new set of buttons waits before it arms.
      await sleep(700);
    };
    await until(() => shown(), "the card");
    await press("Send");
    await until(() => view()?.status?.startsWith("Posted"), "the posted line");
    await proposeAgain(arg.second);
    results.afterPost = view();
    await press("Close");
    await until(() => view()?.title === arg.second.title, "the second report at Close");
    results.second = view();
    await press("Copy and open GitHub");
    await until(() => view()?.status?.startsWith("Copied"), "the copied line");
    await proposeAgain(arg.third);
    results.afterCopy = view();
    await press("Close");
    await until(() => view()?.title === arg.third.title, "the third report at Close");
    results.third = view();
    results.log = s.log.map(e => e.action);
    return results;
  `,
    {
      report: REPORT,
      second: { ...REPORT, id: `${REPORT.id}-second`, title: `${REPORT.title} (second)`, canPost: false },
      third: { ...REPORT, id: `${REPORT.id}-third`, title: `${REPORT.title} (third)` },
    }
  );
  assert.equal(out.afterPost.status, "Posted as #41.");
  assert.deepEqual(out.afterPost.buttons, ["*Open #41", "Close"], "the newer report took the result's place before Close");
  assert.equal(out.afterPost.title, null);
  assert.equal(out.second.title, `${REPORT.title} (second)`);
  assert.deepEqual(out.second.buttons, ["*Copy and open GitHub", "Not yet", "Discard"]);
  assert.equal(out.afterCopy.status, "Copied the body. Paste it into the issue form that opened.");
  assert.deepEqual(out.afterCopy.buttons, ["Close"], "the newer report took the result's place before Close");
  assert.equal(out.third.title, `${REPORT.title} (third)`);
  assert.deepEqual(out.third.buttons, ["*Send", "Not yet", "Discard"]);
  assert.deepEqual(out.log, ["send", "copyAndOpen"], "a click went to a report the user hadn't seen");
});

test("an open issue with the same title asks once more: a comment there, or a new issue", async () => {
  const duplicate = { duplicate: { number: 7, title: REPORT.title, url: "https://github.com/zhuconv/zenius/issues/7" } };
  const out = await chrome(
    `
    const results = {};
    let s = install({ report: arg.report, answers: { send: [arg.duplicate], comment: [{ commented: { number: 7, url: "https://github.com/zhuconv/zenius/issues/7#issuecomment-99" } }] } });
    await until(() => shown(), "the card");
    await press("Send");
    await until(() => button("Add a comment to #7"), "the duplicate question");
    results.question = view();
    await press("Add a comment to #7");
    await until(() => view()?.status?.startsWith("Added"), "the comment's line");
    results.commented = view();
    results.commentLog = s.log;
    await press("Close");
    await until(() => !shown(), "the card to close");

    s.restore();
    s = install({ report: { ...arg.report, id: arg.report.id + "-2" }, answers: { send: [arg.duplicate], postNew: [{ posted: { number: 42, url: "https://github.com/zhuconv/zenius/issues/42" } }] } });
    await until(() => shown(), "the second card");
    await press("Send");
    await press("Post a new issue");
    await until(() => view()?.status?.startsWith("Posted"), "the posted line");
    results.posted = view();
    results.newLog = s.log;
    return results;
  `,
    { report: REPORT, duplicate }
  );
  assert.equal(out.question.status, "An open issue has this title: #7. Add your report's body to it as a comment (its title stays as it is), or post a new issue?");
  assert.deepEqual(out.question.buttons, ["*Add a comment to #7", "Post a new issue", "Not yet", "Discard"]);
  assert.equal(out.question.title, REPORT.title, "the fields stay for the second question");
  assert.deepEqual(
    out.commentLog.map(e => [e.action, e.args]),
    [
      ["send", [{ title: REPORT.title, body: REPORT.body }]],
      ["comment", [7, { body: REPORT.body }]],
    ]
  );
  assert.equal(out.commented.status, "Added as a comment to #7.");
  assert.deepEqual(out.commented.buttons, ["*Open #7", "Close"]);
  assert.deepEqual(
    out.newLog.map(e => e.action),
    ["send", "postNew"]
  );
  assert.equal(out.posted.status, "Posted as #42.");
});

test("when gh fails or isn't signed in, the card says so and offers Try again and Copy", async () => {
  const out = await chrome(
    `
    const s = install({
      report: arg,
      answers: {
        send: [
          { error: "HTTP 502: Server Error" },
          { error: "To get started with GitHub CLI, please run: gh auth login", signedOut: true },
          { posted: { number: 43, url: "https://github.com/zhuconv/zenius/issues/43" } },
        ],
      },
    });
    await until(() => shown(), "the card");
    await press("Send");
    await until(() => button("Try again"), "the error");
    const failed = view();
    await press("Try again");
    await until(() => view()?.status?.startsWith("gh isn't signed in"), "the signed-out line");
    const signedOut = view();
    await press("Try again");
    await until(() => view()?.status?.startsWith("Posted"), "the posted line");
    return { failed, signedOut, log: s.log.map(e => e.action) };
  `,
    REPORT
  );
  assert.equal(out.failed.status, "Couldn't send it: HTTP 502: Server Error");
  assert.deepEqual(out.failed.buttons, ["*Try again", "Copy and open GitHub", "Not yet", "Discard"]);
  assert.equal(out.failed.readOnly, false, "the fields stay editable after a failure");
  assert.match(out.signedOut.status, /gh auth login/);
  assert.deepEqual(out.signedOut.buttons, ["*Copy and open GitHub", "Try again", "Not yet", "Discard"]);
  assert.deepEqual(out.log, ["send", "send", "send"]);
});

test("without gh, Copy and open GitHub hands the fields' text and this window to the runtime", async () => {
  const out = await chrome(
    `
    const s = install({ report: { ...arg, canPost: false } });
    await until(() => shown(), "the card");
    const first = view();
    await press("Copy and open GitHub");
    await until(() => view()?.status?.startsWith("Copied"), "the copied line");
    return { first, copied: view(), log: s.log };
  `,
    REPORT
  );
  assert.deepEqual(out.first.buttons, ["*Copy and open GitHub", "Not yet", "Discard"]);
  assert.match(out.first.lead, /Nothing is sent from here/);
  assert.deepEqual(out.log, [{ action: "copyAndOpen", id: REPORT.id, args: [{ title: REPORT.title, body: REPORT.body }, "this window"] }]);
  assert.equal(out.copied.status, "Copied the body. Paste it into the issue form that opened.");
  assert.deepEqual(out.copied.buttons, ["Close"]);
});

test("in two windows: a sidebar opened later shows the waiting report, the other window's post shows as busy, and settling closes both cards", async () => {
  const out = await chrome(
    `
    const s = install({
      report: arg,
      hold: ["send"],
      answers: { send: [{ posted: { number: 44, url: "https://github.com/zhuconv/zenius/issues/44" } }, { busy: true }] },
    });
    await until(() => shown(), "this window's card");
    const w2 = win.OpenBrowserWindow();
    try {
      await until(() => w2.ucAgentSidebar?.AgentService && w2.gBrowser, "the other window", 30000);
      await w2.delayedStartupPromise;
      await openPanel(w2);
      await until(() => shown(w2), "the other window's card");
      const later = view(w2);
      // This window sends, and its post waits; the other window's Send finds it under way.
      await press("Send");
      await until(() => s.log.length === 1, "this window's send");
      s.hold = [];
      await press("Send", w2);
      await until(() => view(w2)?.status?.startsWith("It's being sent"), "the other window's busy line");
      const busy = view(w2);
      for (const r of s.releases.splice(0)) r();
      await until(() => view()?.status?.startsWith("Posted"), "this window's posted line");
      await until(() => !shown(w2), "the other window's card to close");
      return { later, busy, here: view(), log: s.log.map(e => [e.action, e.args.length]) };
    } finally {
      w2.close();
      await until(() => w2.closed, "the other window to close").catch(() => {});
    }
  `,
    REPORT
  );
  assert.equal(out.later.title, REPORT.title, "the later sidebar shows the waiting report");
  assert.equal(out.later.body, REPORT.body);
  assert.equal(out.busy.status, "It's being sent from another window.");
  assert.deepEqual(out.busy.buttons, ["Try again"]);
  assert.equal(out.here.status, "Posted as #44.");
});

test("Discard settles the report and leaves the card's one line, and a report settled elsewhere closes the card", async () => {
  const out = await chrome(
    `
    let s = install({ report: arg });
    await until(() => shown(), "the card");
    await press("Discard");
    await until(() => view()?.oneLine, "the card's one line");
    const discarded = { log: s.log, report: A.feedbackReport, view: view() };
    s.restore();
    // The runtime settles it with no click here (a timeout, or another window's Not yet).
    s = install({ report: { ...arg, id: arg.id + "-b" } });
    await until(() => view()?.title, "the second card");
    s.report = null;
    Services.obs.notifyObservers(null, "zenius-feedback", "settled");
    await until(() => !shown(), "the second card to close");
    return { discarded, elsewhere: s.log };
  `,
    REPORT
  );
  assert.deepEqual(out.discarded.log, [{ action: "discard", id: REPORT.id, args: [] }]);
  assert.equal(out.discarded.report, null);
  assert.equal(out.discarded.view.line, "Discarded. No new reports for 10 min.");
  assert.deepEqual(out.discarded.view.buttons, ["Undo"]);
  assert.equal(out.discarded.view.title, null, "the fields stayed beside the line");
  assert.deepEqual(out.elsewhere, []);
});

test("Not yet leaves the report for the agent: nothing is sent, no cooldown starts, and the agent's new version shows as a new card whose buttons arm after 400 ms", async () => {
  const out = await chrome(
    `
    const s = install({ report: { ...arg, cooldownMs: 600000 } });
    await until(() => shown(), "the card");
    const first = view();
    await press("Not yet");
    await until(() => !shown(), "the card to go");
    const left = { log: s.log.slice(), report: A.feedbackReport, cooldown: A.feedbackCooldown };
    // The agent's new version is a new report, under a new id.
    s.report = { ...arg, id: arg.id + "-v2", title: arg.title + " (v2)", cooldownMs: 600000 };
    Services.obs.notifyObservers(null, "zenius-feedback", "asked");
    await until(() => view()?.title === s.report.title, "the new version");
    const second = view();
    button("Send").click();
    await sleep(100);
    const early = s.log.length;
    await until(() => !button("Send").disabled, "the new version's Send to arm");
    return { first, left, second, early };
  `,
    REPORT
  );
  assert.deepEqual(out.first.buttons, ["*Send", "Not yet", "Discard"]);
  assert.deepEqual(out.first.tips, ["", "Not yet: nothing is sent. Keep refining it: tell the agent what to change, and its new version shows here.", "Discard. No new reports for 10 min."]);
  assert.deepEqual(out.left.log, [{ action: "defer", id: REPORT.id, args: [] }]);
  assert.equal(out.left.report, null);
  assert.equal(out.left.cooldown, null, "Not yet started a cooldown");
  assert.equal(out.second.title, `${REPORT.title} (v2)`);
  assert.deepEqual(out.second.disabled, [true, true, true], "the new version's buttons took a click as they appeared");
  assert.equal(out.early, 1, "a click before the new version's Send armed went through");
});

test("after Discard the card is one line, with Undo, for the whole cooldown: Undo arms after 400 ms, the minutes count down, a screen reader hears the line once, and a sidebar opened later shows it", async () => {
  const out = await chrome(
    `
    // 61 s: the line says 2 min, and 1 min a second later.
    const s = install({ report: { ...arg, cooldownMs: 61000 }, cooldownMs: 61000 });
    await until(() => shown(), "the card");
    const tip = button("Discard").title;
    await press("Discard");
    await until(() => view()?.oneLine, "the line");
    const doc = panelDoc();
    const first = view();
    const said = doc.getElementById("fb-status").textContent;
    button("Undo").click();
    await sleep(100);
    const early = s.log.length;
    await until(() => view()?.line?.includes("1 min"), "the minutes to count down", 5000);
    const counted = view().line;
    const saidThen = doc.getElementById("fb-status").textContent;
    await until(() => doc.getElementById("fb-status").textContent === "", "the status to empty", 5000);
    // The line comes from the runtime's cooldown: a sidebar shut and opened
    // again shows it too.
    win.SidebarController.hide();
    await until(() => !win.SidebarController.isOpen, "the sidebar to shut");
    await openPanel();
    await until(() => view()?.oneLine, "the line in the sidebar opened again");
    const reopened = view();
    return { tip, first, said, early, counted, saidThen, reopened, cooldown: A.feedbackCooldown };
  `,
    REPORT
  );
  assert.equal(out.tip, "Discard. No new reports for 2 min.");
  assert.equal(out.first.line, "Discarded. No new reports for 2 min.");
  assert.deepEqual(out.first.buttons, ["Undo"]);
  assert.deepEqual(out.first.disabled, [true], "Undo took a click as it appeared");
  assert.equal(out.first.title, null);
  assert.equal(out.first.lead, null);
  assert.equal(out.early, 1, "a click before Undo armed took the Discard back");
  assert.equal(out.said, out.first.line, "a screen reader wasn't told of the line");
  assert.equal(out.counted, "Discarded. No new reports for 1 min.");
  assert.equal(out.saidThen, out.said, "a screen reader was told each minute");
  assert.match(out.reopened.line, /^Discarded\. No new reports for (1 min|\d+ s)\.$/);
  assert.deepEqual(out.reopened.buttons, ["Undo"]);
  assert.equal(out.cooldown.discarded, REPORT.id);
  assert.equal(out.cooldown.refused, null);
});

test("Undo brings the report back, with what the user had typed into it, ends the cooldown, and its buttons arm again", async () => {
  const out = await chrome(
    `
    const s = install({ report: arg });
    await until(() => shown(), "the card");
    panelDoc().getElementById("fb-issue-title").value = arg.title + " (mine)";
    await press("Discard");
    await until(() => view()?.oneLine, "the line");
    await press("Undo");
    await until(() => view()?.title, "the report again");
    const back = view();
    await until(() => !button("Send").disabled, "Send to arm");
    return { back, log: s.log, cooldown: A.feedbackCooldown, report: A.feedbackReport?.id ?? null };
  `,
    REPORT
  );
  assert.equal(out.back.title, `${REPORT.title} (mine)`);
  assert.equal(out.back.body, REPORT.body);
  assert.equal(out.back.oneLine, false);
  assert.equal(out.back.line, null);
  assert.deepEqual(out.back.buttons, ["*Send", "Not yet", "Discard"]);
  assert.deepEqual(out.back.disabled, [true, true, true], "the report took a click as it came back");
  assert.deepEqual(
    out.log.map(e => [e.action, e.id]),
    [
      ["discard", REPORT.id],
      ["undo", REPORT.id],
    ]
  );
  assert.equal(out.cooldown, null);
  assert.equal(out.report, REPORT.id);
});

test("a report the cooldown turned away changes the line's words, not its Undo, and the line goes when the cooldown ends or its time is up", async () => {
  const out = await chrome(
    `
    let s = install({ report: arg });
    await until(() => shown(), "the card");
    await press("Discard");
    await until(() => view()?.oneLine, "the line");
    const undo = await until(() => {
      const b = button("Undo");
      return b && !b.disabled && b;
    }, "Undo to arm");
    s.refuse();
    await until(() => view()?.line?.includes("couldn't show"), "the refusal's line");
    const refused = view();
    const said = panelDoc().getElementById("fb-status").textContent;
    // A caller that keeps proposing: the words stay, and so does Undo, armed.
    for (let i = 0; i < 3; i++) {
      s.refuse();
      await sleep(50);
    }
    const kept = button("Undo") === undo && !undo.disabled;
    s.reopen();
    await until(() => !shown(), "the line to go at reopened");
    s.restore();
    // A cooldown whose time ran out goes too, with no notice.
    s = install({ report: { ...arg, id: arg.id + "-c" }, cooldownMs: 1500 });
    await until(() => shown(), "the second card");
    await press("Discard");
    await until(() => view()?.oneLine, "the second line");
    await until(() => !shown(), "the second line to go once its time was up", 5000);
    return { refused, said, kept };
  `,
    REPORT
  );
  assert.equal(out.refused.line, "Discarded. A new report couldn't show; reports open again in 10 min.");
  assert.equal(out.said, out.refused.line, "a screen reader wasn't told of the refusal");
  assert.ok(out.kept, "proposals replaced Undo or kept it from arming");
});

test("an Undo that fails says why, and Undo arms again", async () => {
  const out = await chrome(
    `
    const s = install({ report: arg, answers: { undo: [{ error: "this report's Discard can't be undone any more" }] } });
    await until(() => shown(), "the card");
    await press("Discard");
    await until(() => view()?.oneLine, "the line");
    await press("Undo");
    await until(() => view()?.line?.includes("Couldn't undo"), "the failure");
    const failed = view();
    await until(() => !button("Undo").disabled, "Undo to arm again");
    return { failed, log: s.log.map(e => e.action) };
  `,
    REPORT
  );
  assert.equal(out.failed.line, "Discarded. No new reports for 10 min. Couldn't undo it: this report's Discard can't be undone any more");
  assert.deepEqual(out.failed.disabled, [true]);
  assert.deepEqual(out.log, ["discard", "undo"]);
});

// The card takes only a trusted click on one of its armed buttons. Gecko
// trusts every event that chrome code dispatches, and code that isn't
// chrome can't reach the card's elements at all, so an untrusted click
// can't be made to reach it: isTrusted is a second line. What keeps
// pages and agents off the card is that it's chrome, which this checks.
test("only a click on an armed button of the card reaches the runtime, and code with a page's principal can't touch the card at all", async () => {
  const out = await chrome(
    `
    const s = install({ report: arg });
    await until(() => shown(), "the card");
    await until(() => !button("Send").disabled, "the buttons to arm");
    // Code with a web page's principal, as a page's own script has, gets no
    // access to the card's buttons.
    const sb = Cu.Sandbox("https://example.com", { wantXrays: true });
    const reach = {};
    for (const label of ["Send", "Not yet", "Discard"]) {
      sb.target = button(label);
      try {
        reach[label] = Cu.evalInSandbox("target.click(); 'clicked'", sb);
      } catch (e) {
        reach[label] = "denied: " + String(e?.message ?? e);
      }
    }
    await sleep(100);
    const afterPage = s.log.length;
    // A click on the card, but not on a button, does nothing.
    for (const id of ["fb-lead", "fb-issue-title", "fb-issue-body", "fb-actions"]) {
      panelDoc().getElementById(id).click();
    }
    await sleep(100);
    const afterCard = s.log.length;
    // The user's click is trusted, and that's what acts.
    let trusted = null;
    button("Not yet").addEventListener("click", e => (trusted = e.isTrusted), { once: true });
    await press("Not yet");
    await until(() => s.log.length === 1, "Not yet's action");
    return { reach, afterPage, afterCard, trusted, log: s.log.map(e => e.action) };
  `,
    REPORT
  );
  for (const [label, result] of Object.entries(out.reach)) {
    assert.match(result, /^denied: Permission denied to access property "click"/, `code with a page's principal clicked ${label}`);
  }
  assert.equal(out.afterPage, 0, "a page's code reached the runtime through the card");
  assert.equal(out.afterCard, 0, "a click beside the buttons reached the runtime");
  assert.equal(out.trusted, true);
  assert.deepEqual(out.log, ["defer"]);
});

test("the report's title and body, the names its lead takes from the sidebar, and the runtime's words show as text: markup in them makes no element and runs nothing", async () => {
  const MARKUP = '<img src=x onerror="window.__fbHit = 1"><b>bold</b><script>window.__fbHit = 2</script>';
  // The lead quotes a task's name up to 60 characters: this one fits whole.
  const TASK = '<img src=y onerror="window.__fbHit = 3">';
  const AGENT = '<i onmouseover="window.__fbHit = 4">Agent</i>';
  const out = await chrome(
    `
    // The lead's names: the task's, which its agent may have given it, and
    // the agent's, by the name the sidebar lists.
    const conv = A.createTask();
    A.addTask(conv, "Find flights to Tokyo");
    conv.title = arg.task;
    const harnessList = A.harnessList;
    A.harnessList = () => [{ id: conv.harness, name: arg.agent }];
    try {
      const report = {
        ...arg.report,
        id: arg.report.id + "-m",
        title: "Markup " + arg.markup,
        body: "## What happened\\n\\n" + arg.markup + "\\n",
        source: { sidebar: conv.uid },
      };
      const s = install({ report, answers: { send: [{ error: arg.markup }], undo: [{ error: arg.markup }] } });
      await until(() => shown(), "the card");
      const shownAs = view();
      await press("Send");
      await until(() => view()?.status?.startsWith("Couldn't send it"), "the error");
      const failed = view();
      await press("Discard");
      await until(() => view()?.oneLine, "the line");
      await press("Undo");
      await until(() => view()?.line?.includes("Couldn't undo"), "Undo's failure");
      const line = view().line;
      await sleep(200);
      const panelWin = panelDoc().defaultView;
      return {
        title: report.title,
        body: report.body,
        shownAs,
        failed,
        line,
        elements: card().querySelectorAll("img, b, script, i").length,
        hit: panelWin.__fbHit ?? null,
        log: s.log.map(e => e.action),
      };
    } finally {
      A.harnessList = harnessList;
      if (A.tasks.has(conv.uid)) A.removeTask(conv);
    }
  `,
    { report: REPORT, markup: MARKUP, task: TASK, agent: AGENT }
  );
  assert.equal(out.shownAs.lead.split(" Nothing is sent")[0], `${AGENT} wrote this in your task “\u2068${TASK}\u2069”.`);
  assert.equal(out.shownAs.title, out.title);
  assert.equal(out.shownAs.body, out.body);
  assert.equal(out.failed.status, `Couldn't send it: ${MARKUP}`);
  assert.equal(out.line, `Discarded. No new reports for 10 min. Couldn't undo it: ${MARKUP}`);
  assert.equal(out.elements, 0, "markup made elements in the card");
  assert.equal(out.hit, null, "markup ran in the panel");
  assert.deepEqual(out.log, ["send", "discard", "undo"]);
});

test("a report the card couldn't show exactly as it would be posted never shows", async () => {
  const out = await chrome(
    `
    const results = [];
    // Built from code points: a right-to-left override in the title, a bell in the body.
    const cases = [
      { ...arg, id: arg.id + "-rlo", title: "zenius" + String.fromCodePoint(0x202e) + "kcilc" },
      { ...arg, id: arg.id + "-bel", body: arg.body + String.fromCodePoint(7) },
      { ...arg, id: arg.id + "-two", title: "two\\nlines" },
      { ...arg, id: arg.id + "-long", title: "x".repeat(257) },
      { ...arg, id: arg.id + "-repo", repo: "zhuconv/zenius/../other" },
    ];
    for (const report of cases) {
      const s = install({ report });
      await sleep(300);
      results.push({ id: report.id, shown: !!shown(), held: A.feedbackReport });
      s.restore();
      Services.obs.notifyObservers(null, "zenius-feedback", "settled");
    }
    return results;
  `,
    REPORT
  );
  for (const r of out) {
    assert.deepEqual(r, { id: r.id, shown: false, held: null }, r.id);
  }
});

test("the self-check's window never shows a report", async () => {
  const out = await chrome(
    `
    const SC = ChromeUtils.importESModule(arg.scenarios);
    install({ report: arg.report });
    await until(() => shown(), "the browser window's card");
    const w = Services.ww.openWindow(null, arg.url, "_blank", "chrome,dialog=no,resizable", null);
    try {
      await until(() => w.document?.documentURI === arg.url && w.document.readyState === "complete", "the self-check window");
      win.focus();
      await SC.prepare(w);
      const doc = await until(() => [...w.document.querySelectorAll("browser")].map(b => b.contentDocument).find(d => d?.getElementById("feedback")), "the self-check's panel");
      await sleep(300);
      return { hidden: doc.getElementById("feedback").hidden, empty: !doc.getElementById("feedback").children.length, here: !!shown() };
    } finally {
      SC.cleanup();
      w.close();
      await until(() => w.closed, "the self-check window to close").catch(() => {});
    }
  `,
    { report: REPORT, scenarios: SCENARIOS, url: SELFCHECK_WINDOW }
  );
  assert.deepEqual(out, { hidden: true, empty: true, here: true });
});

// ---------------------------------------------------------------------------
// The runtime's own module (modules/feedback.sys.mjs): a report composed and
// proposed as zenius feedback does, and the card's buttons pressed. gh is a
// fake that the dev pref zenius.feedback.gh names; it notes what it got and
// answers as each test sets. The Discard comes last: after it, proposals wait
// ten minutes.
describe("with the runtime's own module", () => {
  const HEADED = process.env.ZENIUS_UX_HEADED === "1";
  const ISSUE = n => `https://github.com/${REPORT.repo}/issues/${n}`;
  const FIELDS = {
    line: "page.click kept failing on a sign-up form",
    cli: { version: "0.1.4", protocol: 1, commit: "abc1234", sandboxed: false },
    node: "v24.22.2",
    doctor: [
      { id: "cli", status: "ok" },
      { id: "instance", status: "ok" },
    ],
  };
  // Text a user might add: accents, CJK and an emoji, and trailing spaces.
  const ADDED = `Seen again on the ${String.fromCodePoint(0x63, 0x61, 0x66, 0xe9)} page, ${String.fromCodePoint(0x4e2d, 0x6587, 0x1f600)}  \n`;
  let dir;
  let gh;
  let logFile;
  let answersFile;
  /** What the fake answers to each `gh <noun> <verb>` from now on; its log starts again. */
  const answer = answers => {
    writeFileSync(answersFile, JSON.stringify(answers));
    writeFileSync(logFile, "");
  };
  const ghLog = () =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  const compose = () => h.call("feedback.compose", FIELDS);
  // Not awaited until the card's click: it answers once the user did.
  const propose = id => h.call("feedback.propose", { id, waitMs: 60000 });
  // How long a Discard holds reports off here (a dev profile's pref), or the runtime's 10 minutes.
  const declinedMs = ms =>
    chrome(
      `if (arg === null) Services.prefs.clearUserPref("zenius.feedback.declinedMs");
       else Services.prefs.setIntPref("zenius.feedback.declinedMs", arg);
       return true;`,
      ms
    );

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "zenius-ux-fakegh-"));
    gh = join(dir, "gh");
    logFile = join(dir, "log.jsonl");
    answersFile = join(dir, "answers.json");
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, input }) + "\\n");
const step = args.slice(0, 2).join(" ");
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(answersFile)}, "utf8"))[step] ?? { exit: 1, stderr: "fake gh: no answer for " + step };
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.exit ?? 0);
`
    );
    chmodSync(gh, 0o700);
    answer({});
    await chrome(
      `Services.prefs.setStringPref("zenius.feedback.gh", arg.gh);
       Services.prefs.setStringPref("zenius.feedback.issuesUrl", arg.form);
       return true;`,
      { gh, form: `${h.base}/feedback-form` }
    );
  });

  after(async () => {
    await chrome(
      `Services.prefs.clearUserPref("zenius.feedback.gh");
       Services.prefs.clearUserPref("zenius.feedback.issuesUrl");
       Services.prefs.clearUserPref("zenius.feedback.declinedMs");
       return true;`
    ).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  test("Send posts exactly the title and body the card shows, the user's edits included, and the agent hears only the outcome", async () => {
    answer({ "issue list": { stdout: "[]" }, "issue create": { stdout: `${ISSUE(41)}\n` } });
    const report = await compose();
    const proposal = propose(report.id);
    const edited = { title: `${report.title} (edited)`, body: `${report.body}\n${ADDED}` };
    const out = await chrome(
      `
      await until(() => shown(), "the card");
      const first = view();
      const $ = id => panelDoc().getElementById(id);
      $("fb-issue-title").value = arg.title;
      $("fb-issue-body").value = arg.body;
      await press("Send");
      await until(() => view()?.status?.startsWith("Posted"), "Posted");
      return { first, posted: view() };
    `,
      edited
    );
    assert.deepEqual([out.first.title, out.first.body], [report.title, report.body], "the card shows the report as composed");
    // Composed with no source, as zenius feedback does: no task to name.
    assert.equal(out.first.lead.split(" Nothing is sent")[0], "An agent wrote this.");
    assert.deepEqual(out.first.buttons, ["*Send", "Not yet", "Discard"]);
    assert.equal(out.posted.status, "Posted as #41.");
    assert.deepEqual(out.posted.buttons, ["*Open #41", "Close"]);
    assert.deepEqual(await proposal, { outcome: "posted", number: 41, url: ISSUE(41) });
    const create = ghLog().find(call => call.args[1] === "create");
    assert.ok(create.args.includes(`--title=${edited.title}`), JSON.stringify(create.args));
    assert.equal(create.input, edited.body);
  });

  test("an open issue with the same title: Add a comment posts the body the card shows on that issue", async () => {
    const report = await compose();
    answer({
      "issue list": { stdout: JSON.stringify([{ number: 8, title: report.title, url: ISSUE(8) }]) },
      "issue comment": { stdout: `${ISSUE(8)}#issuecomment-99\n` },
    });
    const proposal = propose(report.id);
    const body = `${report.body}\n${ADDED}`;
    const out = await chrome(
      `
      await until(() => shown(), "the card");
      panelDoc().getElementById("fb-issue-body").value = arg;
      await press("Send");
      await until(() => view()?.buttons.includes("*Add a comment to #8"), "the question");
      const asked = view();
      await press("Add a comment to #8");
      await until(() => view()?.status?.startsWith("Added"), "Added");
      return { asked, done: view() };
    `,
      body
    );
    assert.deepEqual(out.asked.buttons, ["*Add a comment to #8", "Post a new issue", "Not yet", "Discard"]);
    assert.equal(out.done.status, "Added as a comment to #8.");
    assert.deepEqual(out.done.buttons, ["*Open #8", "Close"]);
    assert.deepEqual(await proposal, { outcome: "commented", number: 8, url: `${ISSUE(8)}#issuecomment-99` });
    const comment = ghLog().find(call => call.args[1] === "comment");
    assert.deepEqual(comment.args.slice(0, 3), ["issue", "comment", "8"]);
    assert.equal(comment.input, body);
  });

  test("gh signed out: the card says so and offers Copy first, and Try again posts once gh is signed in", async () => {
    answer({ "issue list": { exit: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" } });
    const report = await compose();
    const proposal = propose(report.id);
    const failed = await chrome(`
      await until(() => shown(), "the card");
      await press("Send");
      await until(() => view()?.buttons.includes("*Copy and open GitHub"), "the sign-in error");
      return view();
    `);
    assert.equal(failed.status, "gh isn't signed in to GitHub. Sign in with gh auth login and try again, or copy the report.");
    assert.deepEqual(failed.buttons, ["*Copy and open GitHub", "Try again", "Not yet", "Discard"]);
    assert.deepEqual([failed.title, failed.body], [report.title, report.body], "the text stays for the next try");
    answer({ "issue list": { stdout: "[]" }, "issue create": { stdout: `${ISSUE(43)}\n` } });
    const posted = await chrome(`
      await press("Try again");
      await until(() => view()?.status?.startsWith("Posted"), "Posted");
      return view();
    `);
    assert.equal(posted.status, "Posted as #43.");
    assert.deepEqual(await proposal, { outcome: "posted", number: 43, url: ISSUE(43) });
    assert.equal(ghLog().find(call => call.args[1] === "create").input, report.body);
  });

  test(
    "without gh, Copy and open GitHub puts the body the card shows on the clipboard and opens the form with only its title",
    { skip: HEADED && "Copy writes the system's clipboard in a headed run" },
    async () => {
      await chrome(`Services.prefs.clearUserPref("zenius.feedback.gh"); return true;`);
      answer({});
      try {
        const report = await compose();
        const proposal = propose(report.id);
        const fields = { title: `${report.title} & more`, body: `${report.body}\n${ADDED}` };
        const out = await chrome(
          `
          await until(() => shown(), "the card");
          const first = view();
          const $ = id => panelDoc().getElementById(id);
          $("fb-issue-title").value = arg.title;
          $("fb-issue-body").value = arg.body;
          const before = new Set(win.gBrowser.tabs);
          const selected = win.gBrowser.selectedTab;
          await press("Copy and open GitHub");
          await until(() => view()?.status?.startsWith("Copied"), "Copied");
          const tab = await until(
            () => [...win.gBrowser.tabs].find(t => !before.has(t) && t.linkedBrowser.currentURI.spec.startsWith(arg.form)),
            "the form's tab"
          );
          const url = tab.linkedBrowser.currentURI.spec;
          win.gBrowser.selectedTab = selected;
          win.gBrowser.removeTab(tab);
          const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
          t.init(null);
          t.addDataFlavor("text/plain");
          Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard);
          const o = {};
          t.getTransferData("text/plain", o);
          return { first, copied: view(), url, clipboard: o.value.QueryInterface(Ci.nsISupportsString).data };
        `,
          { ...fields, form: `${h.base}/feedback-form` }
        );
        assert.match(out.first.lead, /^An agent wrote this\. Nothing is sent from here: Copy and open GitHub/);
        assert.deepEqual(out.first.buttons, ["*Copy and open GitHub", "Not yet", "Discard"]);
        assert.equal(out.copied.status, "Copied the body. Paste it into the issue form that opened.");
        assert.deepEqual(out.copied.buttons, ["Close"]);
        assert.equal(out.clipboard, fields.body);
        const form = new URL(out.url);
        assert.equal(`${form.origin}${form.pathname}`, `${h.base}/feedback-form`);
        assert.deepEqual(
          [...form.searchParams],
          [
            ["template", "zenius-problem.md"],
            ["title", fields.title],
          ],
          "the link carries the title, never the body"
        );
        assert.deepEqual(await proposal, { outcome: "copied" });
        assert.deepEqual(ghLog(), [], "Copy runs no gh");
      } finally {
        await chrome(`Services.prefs.setStringPref("zenius.feedback.gh", arg); return true;`, gh);
      }
    }
  );

  test("a report composed with a sidebar task's source names that task in the card, as compose kept it", async () => {
    const task = await chrome(`
      const conv = A.createTask();
      A.addTask(conv, "Find flights to Tokyo");
      return { uid: conv.uid, agent: A.harnessList().find(h => h.id === conv.harness)?.name ?? conv.harness };
    `);
    try {
      answer({ "issue list": { stdout: "[]" }, "issue create": { stdout: `${ISSUE(43)}\n` } });
      const report = await h.call("feedback.compose", { ...FIELDS, source: { sidebar: task.uid, terminal: "devbox/t1" } });
      const proposal = propose(report.id);
      const lead = await chrome(
        `
        await until(() => A.feedbackReport?.id === arg && shown(), "the card for " + arg);
        const lead = view().lead;
        await press("Send");
        await until(() => view()?.status?.startsWith("Posted"), "Posted");
        await press("Close");
        await until(() => !shown(), "the card to go");
        return lead;
      `,
        report.id
      );
      assert.equal(lead.split(" Nothing is sent")[0], `${task.agent} wrote this in your task “\u2068Find flights to Tokyo\u2069”.`);
      assert.deepEqual(await proposal, { outcome: "posted", number: 43, url: ISSUE(43) });
      // The source stays beside the report: none of it is posted.
      const create = ghLog().find(call => call.args[1] === "create");
      assert.ok(!create.input.includes(task.uid) && !create.args.some(a => a.includes(task.uid)), "the task's uid went out");
    } finally {
      await chrome(`const conv = A.tasks.get(arg); if (conv) A.removeTask(conv); return true;`, task.uid);
    }
  });

  // Last: after a Discard, proposals wait ten minutes.
  test("Discard runs nothing, the agent hears only that the user discarded the report, and the card's line goes when the cooldown ends", async () => {
    answer({});
    await declinedMs(3000);
    try {
      const report = await compose();
      const proposal = propose(report.id);
      const line = await chrome(`
        await until(() => shown(), "the card");
        await press("Discard");
        await until(() => view()?.oneLine, "the line");
        const line = view().line;
        await until(() => !shown(), "the line to go", 10000);
        return line;
      `);
      assert.deepEqual(await proposal, { outcome: "discarded" });
      assert.match(line, /^Discarded\. No new reports for [1-3] s\.$/);
      assert.deepEqual(ghLog(), []);
    } finally {
      await declinedMs(null);
    }
  });

  test("Not yet: the agent hears deferred, the report never shows again, and its new version shows at once as a new card", async () => {
    answer({});
    const first = await compose();
    const proposal = propose(first.id);
    await chrome(`
      await until(() => shown(), "the card");
      await press("Not yet");
      await until(() => !shown(), "the card to go");
      return true;
    `);
    assert.deepEqual(await proposal, { outcome: "deferred" });
    assert.deepEqual(await propose(first.id), { outcome: "deferred" }, "proposed again, it waited");
    const revised = await compose();
    const second = propose(revised.id);
    const out = await chrome(
      `
      await until(() => shown() && A.feedbackReport?.id === arg, "the new version's card");
      const v = view();
      const cooldown = svc.feedback.cooldown();
      await press("Not yet");
      await until(() => !shown(), "the card to go");
      return { v, cooldown };
    `,
      revised.id
    );
    assert.deepEqual(out.v.buttons, ["*Send", "Not yet", "Discard"]);
    assert.equal(out.cooldown, null, "Not yet started a cooldown");
    assert.deepEqual(await second, { outcome: "deferred" });
    assert.deepEqual(ghLog(), []);
  });

  test("Discard, then a report the cooldown turns away, then Undo: the line says so, and Undo brings the same report back, ends the cooldown, and its proposal waits again", async () => {
    answer({});
    await declinedMs(60000);
    try {
      const first = await compose();
      const proposal = propose(first.id);
      await chrome(`
        await until(() => shown(), "the card");
        await press("Discard");
        await until(() => view()?.oneLine, "the line");
        return true;
      `);
      assert.deepEqual(await proposal, { outcome: "discarded" });
      const other = await compose();
      await assert.rejects(propose(other.id), { code: "ZEN_FEEDBACK_DECLINED" });
      const out = await chrome(`
        await until(() => view()?.line?.includes("couldn't show"), "the refusal's line");
        const line = view().line;
        await press("Undo");
        await until(() => view()?.title, "the report again");
        return { line, id: A.feedbackReport?.id ?? null, cooldown: svc.feedback.cooldown() };
      `);
      assert.match(out.line, /^Discarded\. A new report couldn't show; reports open again in (1 min|\d+ s)\.$/);
      assert.equal(out.id, first.id, "Undo brought another report back");
      assert.equal(out.cooldown, null, "the cooldown ran on after Undo");
      // Its proposal waits again, for the user's next answer.
      const again = propose(first.id);
      await chrome(`
        await press("Not yet");
        await until(() => !shown(), "the card to go");
        return true;
      `);
      assert.deepEqual(await again, { outcome: "deferred" });
      assert.deepEqual(ghLog(), []);
    } finally {
      await declinedMs(null);
    }
  });
});
