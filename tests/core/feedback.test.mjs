// zenius feedback's report and the sidebar card's actions on it
// (modules/feedback.sys.mjs), through dev.answerFeedback, which answers as
// the card's buttons do. gh is a fake that the dev pref names: it notes what
// it got and answers as each test sets, so nothing reaches GitHub. A
// stand-in observer of the card's topic plays the sidebar. The Discard test
// runs last: after it, proposals wait ten minutes.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { connect } from "../../scripts/lib/rpc.mjs";
import { setup, sleep } from "./lib.mjs";

const REPO = "zhuconv/zenius";
const ISSUE = n => `https://github.com/${REPO}/issues/${n}`;
const FIELDS = {
  line: "page.click kept failing on https://example.com/x for me@example.com",
  cli: { version: "0.1.4", protocol: 1, commit: "abc1234", sandboxed: false },
  node: "v24.22.2",
  doctor: [
    { id: "cli", status: "ok" },
    { id: "instance", status: "ok" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "zenius-fakegh-"));
const gh = join(dir, "gh");
const logFile = join(dir, "log.jsonl");
const answersFile = join(dir, "answers.json");
writeFileSync(
  gh,
  `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, input, prompt: process.env.GH_PROMPT_DISABLED ?? null }) + "\\n");
const step = args.slice(0, 2).join(" ");
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(answersFile)}, "utf8"))[step] ?? { exit: 1, stderr: "fake gh: no answer for " + step };
if (answer.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, answer.delayMs);
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.exit ?? 0);
`
);
chmodSync(gh, 0o700);
/** What the fake answers to each `gh <noun> <verb>`, from now on; its log starts again. */
const answer = answers => {
  writeFileSync(answersFile, JSON.stringify(answers));
  writeFileSync(logFile, "");
};
const ghLog = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

let h;
before(async () => {
  h = await setup();
  answer({});
  await h.chrome(
    `Services.prefs.setStringPref("zenius.feedback.gh", arg.gh);
     Services.prefs.setStringPref("zenius.feedback.issuesUrl", arg.form);
     return true;`,
    { gh, form: `${h.base}/feedback-form` }
  );
});

after(async () => {
  await h?.chrome(
    `Services.prefs.clearUserPref("zenius.feedback.gh");
     Services.prefs.clearUserPref("zenius.feedback.issuesUrl");
     const s = ctx.service;
     if (s.testFeedbackObserver) { Services.obs.removeObserver(s.testFeedbackObserver, "zenius-feedback"); delete s.testFeedbackObserver; }
     return true;`
  );
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The stand-in sidebar: an observer of the card's topic, which notes what it's told. */
const sidebar = {
  on: () =>
    h.chrome(
      `const s = ctx.service;
       if (!s.testFeedbackObserver) {
         s.testFeedbackObserver = { seen: [], observe(_subject, _topic, data) { this.seen.push(data); } };
         Services.obs.addObserver(s.testFeedbackObserver, "zenius-feedback");
       }
       s.testFeedbackObserver.seen = [];
       return true;`
    ),
  off: () =>
    h.chrome(
      `const s = ctx.service;
       if (s.testFeedbackObserver) { Services.obs.removeObserver(s.testFeedbackObserver, "zenius-feedback"); delete s.testFeedbackObserver; }
       return true;`
    ),
  seen: () => h.chrome(`return ctx.service.testFeedbackObserver?.seen ?? null;`),
};
const pending = () => h.chrome(`return ctx.service.feedback.pending();`);
async function shown() {
  for (let i = 0; i < 100; i++) {
    const report = await pending();
    if (report) {
      return report;
    }
    await sleep(50);
  }
  throw new Error("no report showed in the card");
}
const compose = (fields = FIELDS) => h.call("feedback.compose", fields);
const propose = (id, waitMs = 30000) => h.call("feedback.propose", { id, waitMs });
const card = params => h.call("dev.answerFeedback", params);

test("compose keeps the checked fields only: the line cleaned, zenius's own data, and the last calls", async () => {
  await h.call("browser.version", {});
  await assert.rejects(h.call("spaces.list", ["https://secret.example/"]), { code: "ZEN_INVALID_ARGUMENT" });
  const report = await compose({ ...FIELDS, extra: "PAGE-DATA-MARKER", cli: { ...FIELDS.cli, note: "CLI-NOTE-MARKER" } });
  assert.match(report.id, /^\{[0-9a-f-]{36}\}$/);
  assert.equal(report.title, "zenius 0.1.4: ZEN_INVALID_ARGUMENT in spaces.list");
  assert.ok(report.body.includes("\n    page.click kept failing on <link> for <email>\n"), report.body);
  for (const text of ["example.com", "me@", "secret", "PAGE-DATA-MARKER", "CLI-NOTE-MARKER"]) {
    assert.ok(!report.body.includes(text), `the body has ${text}`);
  }
  assert.match(report.body, /^- zenius 0\.1\.4 \(protocol 1\), commit abc1234$/m);
  assert.match(report.body, /^- Node 24\.22\.2$/m);
  assert.match(report.body, /^\| spaces\.list \| \d+ \| ZEN_INVALID_ARGUMENT \|$/m);
  assert.match(report.body, /^cli ok, instance ok$/m);
  assert.ok(!/feedback\./.test(report.body), "feedback's own calls stay out of the list");
  for (const bad of [
    { ...FIELDS, line: " " },
    { ...FIELDS, cli: { ...FIELDS.cli, version: "0.1 <b>" } },
    { ...FIELDS, cli: { ...FIELDS.cli, commit: "not a hash" } },
    { ...FIELDS, node: "24; rm" },
    { ...FIELDS, doctor: [{ id: "Cli", status: "ok" }] },
  ]) {
    await assert.rejects(compose(bad), { code: "ZEN_INVALID_ARGUMENT" }, JSON.stringify(bad));
  }
});

test("with no sidebar to show the card, propose fails at once, for the CLI to write a draft", async () => {
  // This lane's profile has no agent sidebar (zen-dev.sh leaves its scripts
  // out), so with the stand-in gone nothing observes the card's topic.
  await sidebar.off();
  const { id } = await compose();
  await assert.rejects(propose(id, 1000), error => error.code === "ZEN_UNSUPPORTED" && error.data?.reason === "no_sidebar");
  assert.equal(await pending(), null);
});

test("Send posts exactly the card's title and body, to the repository the card shows", async () => {
  await sidebar.on();
  answer({ "issue list": { stdout: "[]" }, "issue create": { stdout: `${ISSUE(41)}\n` } });
  const { id, title, body } = await compose();
  const proposal = propose(id);
  assert.deepEqual(await shown(), { id, title, body, canPost: true, repo: REPO });
  const edited = { title: `-${title} (edited)`, body: `${body}\nThe user added this line.` };
  assert.deepEqual(await card({ action: "send", ...edited }), { posted: { number: 41, url: ISSUE(41) } });
  assert.deepEqual(await proposal, { outcome: "posted", number: 41, url: ISSUE(41) });
  const calls = ghLog();
  assert.deepEqual(
    calls.map(call => call.args),
    [
      ["issue", "list", `--repo=github.com/${REPO}`, "--state=open", `--search=${edited.title} in:title`, "--json=number,title,url", "--limit=30"],
      ["issue", "create", `--repo=github.com/${REPO}`, `--title=${edited.title}`, "--body-file=-"],
    ]
  );
  assert.equal(calls[1].input, edited.body);
  assert.ok(calls.every(call => call.prompt === "1"), "gh runs with its prompts off");
  assert.deepEqual(await sidebar.seen(), ["asked", "settled"]);
  assert.equal(await pending(), null);
  assert.deepEqual(await propose(id, 1000), { outcome: "posted", number: 41, url: ISSUE(41) }, "an answered report's id gives its outcome");
});

test("an open issue with the same title: comment there, only on a number the search found", async () => {
  const { id, title, body } = await compose();
  answer({
    "issue list": {
      stdout: JSON.stringify([
        { number: 7, title: `${title} and more`, url: ISSUE(7) },
        { number: 8, title, url: ISSUE(8) },
      ]),
    },
    "issue comment": { stdout: `${ISSUE(8)}#issuecomment-99\n` },
  });
  const proposal = propose(id);
  await shown();
  assert.deepEqual(await card({ action: "send" }), { duplicate: { number: 8, title, url: ISSUE(8) } });
  assert.match((await card({ action: "comment", number: 7 })).error, /isn't one the search found/);
  assert.deepEqual(await card({ action: "comment", number: 8 }), { commented: { number: 8, url: `${ISSUE(8)}#issuecomment-99` } });
  assert.deepEqual(await proposal, { outcome: "commented", number: 8, url: `${ISSUE(8)}#issuecomment-99` });
  const commentCall = ghLog().find(call => call.args[1] === "comment");
  assert.deepEqual(commentCall.args, ["issue", "comment", "8", `--repo=github.com/${REPO}`, "--body-file=-"]);
  assert.equal(commentCall.input, body);
});

test("an open issue with the same title: or post a new issue", async () => {
  const { id, title } = await compose();
  answer({ "issue list": { stdout: JSON.stringify([{ number: 8, title, url: ISSUE(8) }]) }, "issue create": { stdout: `${ISSUE(42)}\n` } });
  const proposal = propose(id);
  await shown();
  assert.equal((await card({ action: "send" })).duplicate.number, 8);
  assert.deepEqual(await card({ action: "postNew" }), { posted: { number: 42, url: ISSUE(42) } });
  assert.equal((await proposal).number, 42);
});

test("gh signed out: the card says so and keeps the report as composed; Copy puts the body on the clipboard and opens the form with the title only", async () => {
  answer({ "issue list": { exit: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" } });
  const { id, title, body } = await compose();
  const proposal = propose(id);
  await shown();
  const failed = await card({ action: "send", title: "an edited title", body: "an edited body" });
  assert.equal(failed.signedOut, true);
  assert.match(failed.error, /isn't signed in/);
  assert.deepEqual(await pending(), { id, title, body, canPost: true, repo: REPO }, "a report's text never changes under its id");

  await h.chrome(`ctx.service.testSelectedTab = Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedTab; return true;`);
  const copiedTitle = "zenius 0.1.4: a title & more";
  assert.deepEqual(await card({ action: "copyAndOpen", title: copiedTitle, body: "the body as the card shows it" }), {});
  assert.deepEqual(await proposal, { outcome: "copied" });
  const clipboard = await h.chrome(
    `const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
     t.init(null);
     t.addDataFlavor("text/plain");
     Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard);
     const o = {};
     t.getTransferData("text/plain", o);
     return o.value.QueryInterface(Ci.nsISupportsString).data;`
  );
  assert.equal(clipboard, "the body as the card shows it");
  let opened = "";
  for (let i = 0; i < 100 && !opened.startsWith(h.base); i++) {
    await sleep(50);
    opened = await h.chrome(`return Services.wm.getMostRecentWindow("navigator:browser").gBrowser.selectedBrowser.currentURI.spec;`);
  }
  await h.chrome(
    `const w = Services.wm.getMostRecentWindow("navigator:browser");
     const tab = w.gBrowser.selectedTab;
     w.gBrowser.selectedTab = ctx.service.testSelectedTab;
     w.gBrowser.removeTab(tab);
     delete ctx.service.testSelectedTab;
     return true;`
  );
  const form = new URL(opened);
  assert.equal(`${form.origin}${form.pathname}`, `${h.base}/feedback-form`);
  assert.deepEqual([...form.searchParams], [
    ["template", "zenius-problem.md"],
    ["title", copiedTitle],
  ]);
  assert.equal(ghLog().length, 1, "Copy runs no gh");
});

test("one report waits at a time, and an action while another runs is busy", async () => {
  answer({ "issue list": { stdout: "[]", delayMs: 1500 }, "issue create": { stdout: `${ISSUE(50)}\n` } });
  const first = await compose();
  const second = await compose();
  const proposal = propose(first.id);
  await shown();
  await assert.rejects(propose(second.id, 1000), { code: "ZEN_FEEDBACK_PENDING" });
  const sending = card({ action: "send" });
  await sleep(500);
  assert.deepEqual(await card({ action: "discard" }), { busy: true });
  assert.deepEqual(await sending, { posted: { number: 50, url: ISSUE(50) } });
  assert.equal((await proposal).outcome, "posted");
});

test("a wait can end before the user answers: the card stays, a closed connection ends only its own wait, and the outcome comes later", async () => {
  const { id } = await compose();
  assert.deepEqual(await propose(id, 200), { outcome: "pending" });
  assert.equal((await pending())?.id, id);
  const other = await connect(h.instance, { callTimeout: 30000 });
  const gone = other.call("feedback.propose", { id, waitMs: 30000 }).catch(() => "closed");
  await sleep(200);
  other.close();
  assert.equal(await gone, "closed");
  assert.equal((await pending())?.id, id);
  answer({ "issue create": { stdout: `${ISSUE(60)}\n` } });
  assert.deepEqual(await card({ action: "postNew" }), { posted: { number: 60, url: ISSUE(60) } });
  assert.deepEqual(await propose(id, 1000), { outcome: "posted", number: 60, url: ISSUE(60) });
});

test("a dev profile runs only the gh its pref names, never one on PATH", async () => {
  await h.chrome(`Services.prefs.clearUserPref("zenius.feedback.gh"); return true;`);
  answer({});
  try {
    const { id } = await compose();
    const proposal = propose(id);
    assert.equal((await shown()).canPost, false);
    assert.match((await card({ action: "send" })).error, /no gh was found/);
    await h.chrome(`Services.prefs.setStringPref("zenius.feedback.gh", arg); return true;`, gh);
    answer({ "issue create": { stdout: `${ISSUE(70)}\n` } });
    assert.equal((await card({ action: "postNew" })).posted.number, 70);
    assert.equal((await proposal).number, 70);
  } finally {
    await h.chrome(`Services.prefs.setStringPref("zenius.feedback.gh", arg); return true;`, gh);
  }
});

// Last: after a Discard, proposals wait ten minutes.
test("Discard: nothing runs, and the next proposal is refused for ten minutes as the user declined", async () => {
  answer({});
  const { id } = await compose();
  const next = await compose();
  const proposal = propose(id);
  await shown();
  assert.deepEqual(await card({ action: "discard" }), {});
  assert.deepEqual(await proposal, { outcome: "discarded" });
  const refused = await propose(next.id, 1000).catch(error => error);
  assert.equal(refused.code, "ZEN_FEEDBACK_DECLINED");
  assert.ok(refused.data?.retryAfterMs > 9 * 60 * 1000, JSON.stringify(refused.data));
  assert.deepEqual(ghLog(), []);
});
