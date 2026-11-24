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
   * The runtime's side, as its service.feedback answers: pending()
   * and the card's actions. arg.answers lists each action's answers in turn;
   * a post, a comment, a copy or a discard settles the report, as the
   * runtime's do. arg.hold names actions that wait for release().
   */
  const install = arg => {
    const old = Object.getOwnPropertyDescriptor(svc, "feedback");
    const s = {
      report: arg.report,
      answers: arg.answers ?? {},
      hold: arg.hold ?? [],
      log: [],
      releases: [],
      pending() {
        return this.report;
      },
      async act(action, id, args) {
        this.log.push({ action, id, args: args.map(a => (a && typeof a === "object" && "document" in a ? (a === win ? "this window" : "another window") : a)) });
        // Each call takes its answer as it comes, held or not.
        const answer = (this.answers[action] ?? []).shift() ?? {};
        if (this.hold.includes(action)) {
          await new Promise(r => this.releases.push(r));
        }
        const settles = answer.posted || answer.commented || ((action === "copyAndOpen" || action === "discard") && !answer.error && !answer.busy);
        if (settles && this.report?.id === id) {
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
      discard(id) {
        return this.act("discard", id, []);
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
  assert.deepEqual(out.v.buttons, ["*Send", "Discard"]);
  assert.equal(out.v.status, null);
  assert.ok(out.focusKept, "the card took the focus");
  assert.deepEqual(out.report, REPORT);
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
  assert.deepEqual(out.first, [true, true], "Send and Discard took a click as they appeared");
  assert.equal(out.early, 0, "a click before Send armed sent the report");
  assert.deepEqual(out.second, [true, true, true], "the duplicate question's buttons took a click as they appeared");
  assert.equal(out.afterEarly, 1, "a click before the comment button armed went through");
  assert.deepEqual(out.armed, [false, false, false]);
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
  assert.deepEqual(out.second.buttons, ["*Copy and open GitHub", "Discard"]);
  assert.equal(out.afterCopy.status, "Copied the body. Paste it into the issue form that opened.");
  assert.deepEqual(out.afterCopy.buttons, ["Close"], "the newer report took the result's place before Close");
  assert.equal(out.third.title, `${REPORT.title} (third)`);
  assert.deepEqual(out.third.buttons, ["*Send", "Discard"]);
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
  assert.deepEqual(out.question.buttons, ["*Add a comment to #7", "Post a new issue", "Discard"]);
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
  assert.deepEqual(out.failed.buttons, ["*Try again", "Copy and open GitHub", "Discard"]);
  assert.equal(out.failed.readOnly, false, "the fields stay editable after a failure");
  assert.match(out.signedOut.status, /gh auth login/);
  assert.deepEqual(out.signedOut.buttons, ["*Copy and open GitHub", "Try again", "Discard"]);
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
  assert.deepEqual(out.first.buttons, ["*Copy and open GitHub", "Discard"]);
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

test("Discard settles the report, and a report settled elsewhere closes the card", async () => {
  const out = await chrome(
    `
    let s = install({ report: arg });
    await until(() => shown(), "the card");
    await press("Discard");
    await until(() => !shown(), "the card to close");
    const discarded = { log: s.log, report: A.feedbackReport };
    s.restore();
    // The runtime settles it with no click here (a timeout, or another window's Discard).
    s = install({ report: { ...arg, id: arg.id + "-b" } });
    await until(() => shown(), "the second card");
    s.report = null;
    Services.obs.notifyObservers(null, "zenius-feedback", "settled");
    await until(() => !shown(), "the second card to close");
    return { discarded, elsewhere: s.log };
  `,
    REPORT
  );
  assert.deepEqual(out.discarded.log, [{ action: "discard", id: REPORT.id, args: [] }]);
  assert.equal(out.discarded.report, null);
  assert.deepEqual(out.elsewhere, []);
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
    assert.deepEqual(out.first.buttons, ["*Send", "Discard"]);
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
    assert.deepEqual(out.asked.buttons, ["*Add a comment to #8", "Post a new issue", "Discard"]);
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
    assert.deepEqual(failed.buttons, ["*Copy and open GitHub", "Try again", "Discard"]);
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
        assert.deepEqual(out.first.buttons, ["*Copy and open GitHub", "Discard"]);
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

  // Last: after a Discard, proposals wait ten minutes.
  test("Discard runs nothing, and the agent hears only that the user discarded the report", async () => {
    answer({});
    const report = await compose();
    const proposal = propose(report.id);
    await chrome(`
      await until(() => shown(), "the card");
      await press("Discard");
      await until(() => !shown(), "the card to go");
      return true;
    `);
    assert.deepEqual(await proposal, { outcome: "discarded" });
    assert.deepEqual(ghLog(), []);
  });
});
