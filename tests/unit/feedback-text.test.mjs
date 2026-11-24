// zenius feedback's text, without a browser: the runtime's renderer and
// checks (runtime/JS/zenius/modules/feedbacktext.sys.mjs), which a report
// passes before the sidebar's card shows it and gh posts it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  BODY_MAX,
  LINE_INPUT_MAX,
  LINE_MAX,
  TITLE_MAX,
  bodyProblem,
  cleanLine,
  clientFacts,
  commentIssue,
  issueNumber,
  newIssueLink,
  reportBody,
  reportTitle,
  sameTitle,
  titleProblem,
} from "../../runtime/JS/zenius/modules/feedbacktext.sys.mjs";
import { REPO_ROOT } from "../lib/targets.mjs";

const TEMPLATE_FILE = join(REPO_ROOT, ".github", "ISSUE_TEMPLATE", "zenius-problem.md");
const ISSUES = "https://github.com/zhuconv/zenius/issues";

const CLIENT = {
  line: "page.click failed twice",
  cli: { version: "0.1.4", protocol: 1, commit: "abc1234", sandboxed: false },
  node: "v24.22.2",
  doctor: [{ id: "cli", status: "ok" }],
};

/** clientFacts() plus the runtime's own data, as feedback.compose puts them together. */
function facts(more = {}) {
  return {
    ...clientFacts(CLIENT),
    runtime: { version: "0.1.4", commit: "def5678" },
    zen: "1.24.2b",
    os: "Linux 6.8.0, x86_64",
    defaultInstance: true,
    calls: [{ method: "page.click", ms: 31, code: "ZEN_INTERNAL" }],
    lastFailure: { method: "page.click", ms: 31, code: "ZEN_INTERNAL", ago: 12 },
    ...more,
  };
}

const headings = text => text.split("\n").filter(line => line.startsWith("## "));

test("the runtime's body has the issue template's sections, in its order", () => {
  const template = readFileSync(TEMPLATE_FILE, "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(template)?.[1] ?? "";
  assert.deepEqual(
    front.split("\n").map(line => line.split(":")[0]),
    ["name", "about", "title"],
    "the front matter: a name, an about line and a title, and no labels the repository lacks"
  );
  assert.ok(headings(template).length >= 5, "the template's sections");
  assert.deepEqual(headings(reportBody(facts())), headings(template));
});

test("cleanLine keeps one line, without links, email addresses or the home folder", () => {
  assert.equal(cleanLine("clicking\nfailed\ttwice\u2028again"), "clicking failed twice again");
  assert.equal(cleanLine("hidden\u202echaracters\u200bgo"), "hidden characters go");
  assert.equal(cleanLine("  spaces   collapse  "), "spaces collapse");
  assert.equal(cleanLine("on https://bank.example/acct?id=7 and HTTP://x.example"), "on <link> and <link>");
  assert.equal(cleanLine("a javascript:alert(1) or data:text/html,x link"), "a <link> or <link> link");
  assert.equal(cleanLine("on www.example.com/path"), "on <link>");
  assert.equal(cleanLine("for jane.doe+x@mail.example.com"), "for <email>");
  assert.equal(cleanLine("on shop.example.com/orders/123 and intranet.example:8443/a?b=c"), "on <link> and <link>");
  assert.equal(cleanLine("mail jane@example.com/x"), "mail <email>/x");
  assert.equal(cleanLine("page.click and page.goto failed in sdk/src/a.ts, v0.1.4/notes and app.v2/x"), "page.click and page.goto failed in sdk/src/a.ts, v0.1.4/notes and app.v2/x");
  assert.equal(cleanLine("see /home/u/notes.txt", "/home/u"), "see ~/notes.txt");
  assert.equal(cleanLine("see /home/u/notes.txt", "/"), "see /home/u/notes.txt", "a home of / changes nothing");
  // A local path's dotted folder is no host, and stays readable. A link
  // without a scheme, or with a slash missing, is still a link.
  assert.equal(
    cleanLine("cache in /tmp/zt-sdk-unit.AbCdEf/x, ~/Sites/example.com/page and ~/Sites/www.example.com/"),
    "cache in /tmp/zt-sdk-unit.AbCdEf/x, ~/Sites/example.com/page and ~/Sites/www.example.com/",
  );
  assert.equal(cleanLine("loads //cdn.example.com/lib.js and https:/shop.example.com/x, not a // comment"), "loads //<link> and https:/<link> not a // comment");
  // A dotted or email-shaped home folder is ~ too, and so is the home
  // folder's path inside another path: the user's name never stays.
  assert.equal(cleanLine("saved to /Users/john.smith/Documents/x.pdf.", "/Users/john.smith"), "saved to ~/Documents/x.pdf.");
  assert.equal(cleanLine("in /home/jane@corp.example/x", "/home/jane@corp.example"), "in ~/x");
  assert.equal(cleanLine("see file:/home/jane/x, (/home/jane) and /Volumes/Backup/home/jane/x", "/home/jane"), "see file:~/x, (~) and /Volumes/Backup~/x");
  // Inside a link, it goes with the rest of the link.
  assert.equal(cleanLine("from files.example.com/home/jane/x", "/home/jane"), "from <link>");
  assert.equal(cleanLine("\n\t "), "");
});

test(`cleanLine keeps at most ${LINE_MAX} characters, counting each emoji as one`, () => {
  const long = cleanLine("x".repeat(LINE_MAX + 100));
  assert.equal(long.length, LINE_MAX);
  assert.ok(long.endsWith("..."));
  assert.equal(cleanLine("x".repeat(LINE_MAX)), "x".repeat(LINE_MAX));
  const emoji = [...cleanLine("\u{1F600}".repeat(LINE_MAX + 1))];
  assert.equal(emoji.length, LINE_MAX);
  assert.equal(emoji.slice(-3).join(""), "...");
});

test(`cleanLine reads at most ${LINE_INPUT_MAX} characters, so a huge line can't hold up Zen`, () => {
  // Its patterns take time that grows with the square of their input: a
  // million characters would take far more than a minute.
  for (const huge of ["a.".repeat(500_000), "a".repeat(1_000_000), "a@".repeat(500_000)]) {
    const t0 = performance.now();
    const line = cleanLine(huge);
    assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
    assert.ok(line.length <= LINE_MAX);
  }
  assert.equal(cleanLine(`${"x ".repeat(LINE_INPUT_MAX / 2)}https://late.example/`).includes("late"), false);
});

test("clientFacts keeps only the checked fields, each in its narrow shape", () => {
  const got = clientFacts(
    { ...CLIENT, line: "on https://x.example/ for me@x.example in /home/u/a", url: "https://x.example/", cli: { ...CLIENT.cli, note: "CLI-NOTE" } },
    "/home/u"
  );
  assert.deepEqual(got, {
    line: "on <link> for <email> in ~/a",
    cli: { version: "0.1.4", protocol: 1, commit: "abc1234", sandboxed: false },
    node: "24.22.2",
    doctor: [{ id: "cli", status: "ok" }],
  });
  const bare = clientFacts({ line: "x", cli: { version: "0.1.4", protocol: 1 }, node: "24.22.2" });
  assert.deepEqual(bare.cli, { version: "0.1.4", protocol: 1, commit: null, sandboxed: false });
  assert.equal(bare.doctor, null);
  assert.equal(clientFacts({ ...CLIENT, cli: { ...CLIENT.cli, commit: "abc1234-dirty" } }).cli.commit, "abc1234-dirty");
});

test("clientFacts refuses a field that doesn't fit, and names it", () => {
  const refused = [
    [{ ...CLIENT, line: 7 }, /^line must be a string/],
    [{ ...CLIENT, line: "\n\t " }, /^line is empty/],
    [{ ...CLIENT, cli: undefined }, /^cli\.version/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, version: "0.1 <b>" } }, /^cli\.version/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, protocol: 1.5 } }, /^cli\.protocol/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, protocol: "1" } }, /^cli\.protocol/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, protocol: 1000 } }, /^cli\.protocol/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, commit: "not a hash" } }, /^cli\.commit/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, commit: "ABC1234" } }, /^cli\.commit/],
    [{ ...CLIENT, cli: { ...CLIENT.cli, sandboxed: "yes" } }, /^cli\.sandboxed/],
    [{ ...CLIENT, node: "24; rm" }, /^node must be/],
    [{ ...CLIENT, node: undefined }, /^node must be/],
    [{ ...CLIENT, doctor: "cli ok" }, /^doctor must be a list/],
    [{ ...CLIENT, doctor: Array.from({ length: 41 }, () => ({ id: "cli", status: "ok" })) }, /^doctor must be a list/],
    [{ ...CLIENT, doctor: [{ id: "cli", status: "ok" }, { id: "Cli", status: "ok" }] }, /^doctor\[1\] must be/],
    [{ ...CLIENT, doctor: [{ id: "cli", status: "great" }] }, /^doctor\[0\] must be/],
  ];
  for (const [params, message] of refused) {
    assert.throws(() => clientFacts(params), { message }, JSON.stringify(params));
  }
  assert.throws(() => clientFacts(null), { message: /^line must be a string/ });
});

test("the title names zenius's version and what failed last, from zenius's own data only", () => {
  assert.equal(reportTitle(facts()), "zenius 0.1.4: ZEN_INTERNAL in page.click");
  assert.equal(reportTitle(facts({ lastFailure: null })), "zenius 0.1.4: a problem report");
});

test("the body keeps only calls that fit: a method's name, whole milliseconds and a code", () => {
  const body = reportBody(
    facts({
      calls: [
        { method: "page.goto", ms: 120, code: "ok" },
        { method: "page.goto https://x.example/", ms: 5, code: "ok" },
        { method: "page.fill", ms: 1.5, code: "ok" },
        { method: "page.click", ms: 31, code: "not a code" },
        { method: "page.click", ms: 31, code: "ZEN_INTERNAL" },
      ],
    })
  );
  assert.ok(body.includes("\n| page.goto | 120 | ok |\n| page.click | 31 | ZEN_INTERNAL |\n"), body);
  assert.ok(!body.includes("x.example") && !body.includes("page.fill") && !body.includes("not a code"), body);
  assert.ok(body.includes("\npage.click: ZEN_INTERNAL after 31 ms, 12 s before this report.\n"), body);
  assert.ok(body.includes("\n    page.click failed twice\n"), "the agent's line, as an indented code block");
  const none = reportBody(facts({ calls: [], lastFailure: null, doctor: null, runtime: { version: "<b>", commit: "nope" } }));
  assert.ok(none.includes("\n## The last failed call\n\nNone since Zen started.\n"), none);
  assert.ok(none.includes("\n## The last calls, oldest first\n\nNone since Zen started.\n"), none);
  assert.ok(none.includes("\n## zenius doctor\n\nNot known: doctor didn't finish.\n"), none);
  assert.ok(none.includes("\n- zenius runtime of an unknown version\n"), none);
});

test(`titleProblem: GitHub's ${TITLE_MAX} characters, on one line, with nothing hidden`, () => {
  assert.equal(titleProblem("zenius 0.1.4: a problem report"), null);
  assert.equal(titleProblem("x".repeat(TITLE_MAX)), null);
  assert.equal(titleProblem(""), "the title is empty");
  assert.equal(titleProblem("   "), "the title is empty");
  assert.equal(titleProblem(undefined), "the title is empty");
  assert.equal(titleProblem("x".repeat(TITLE_MAX + 1)), `the title is longer than ${TITLE_MAX} characters`);
  assert.equal(titleProblem("two\nlines"), "the title has a line break or a hidden character");
  assert.equal(titleProblem("zero\u200bwidth"), "the title has a line break or a hidden character");
});

test(`bodyProblem: GitHub's ${BODY_MAX} characters, with line breaks and tabs but nothing hidden`, () => {
  assert.equal(bodyProblem("## Versions\n\n- zenius 0.1.4\n\tindented"), null);
  assert.equal(bodyProblem("x".repeat(BODY_MAX)), null);
  assert.equal(bodyProblem(""), "the body is empty");
  assert.equal(bodyProblem("\n\n"), "the body is empty");
  assert.equal(bodyProblem(null), "the body is empty");
  assert.equal(bodyProblem("x".repeat(BODY_MAX + 1)), `the body is longer than ${BODY_MAX} characters`);
  assert.equal(bodyProblem("a bell\u0007"), "the body has a hidden or control character");
  assert.equal(bodyProblem("right\u202eto left"), "the body has a hidden or control character");
});

test("issueNumber and commentIssue read only addresses in zenius's repository", () => {
  assert.equal(issueNumber(`${ISSUES}/12`), 12);
  assert.equal(issueNumber("https://github.com/someone/zenius/issues/12"), null);
  assert.equal(issueNumber("https://github.com/someone/zenius/issues/12", "someone/zenius"), 12);
  for (const url of [`${ISSUES}/0`, `${ISSUES}/12/`, `${ISSUES}/12#issuecomment-3`, `${ISSUES}/12345678901`, "http://github.com/zhuconv/zenius/issues/12", "https://github.com/zhuconv/zenius/pull/12", 12, null]) {
    assert.equal(issueNumber(url), null, String(url));
  }
  assert.equal(commentIssue(`${ISSUES}/12#issuecomment-345`), 12);
  for (const url of [`${ISSUES}/12`, `${ISSUES}/12#issuecomment-`, "https://github.com/someone/zenius/issues/12#issuecomment-345", undefined]) {
    assert.equal(commentIssue(url), null, String(url));
  }
});

test("sameTitle keeps the open issues with exactly that title, whose number matches their address", () => {
  const title = "zenius 0.1.4: ZEN_INTERNAL in page.click";
  const list = [
    { number: 3, title, url: `${ISSUES}/3`, body: "BODY", state: "OPEN" },
    { number: 4, title: ` ${title} `, url: `${ISSUES}/4` },
    { number: 5, title: title.toUpperCase(), url: `${ISSUES}/5` },
    { number: 6, title: `${title} again`, url: `${ISSUES}/6` },
    { number: 7, title, url: "https://github.com/someone/zenius/issues/7" },
    { number: 8, title, url: `${ISSUES}/9` },
    null,
    { number: 10, url: `${ISSUES}/10` },
  ];
  assert.deepEqual(sameTitle(list, title), [
    { number: 3, title, url: `${ISSUES}/3` },
    { number: 4, title: ` ${title} `, url: `${ISSUES}/4` },
  ]);
  assert.deepEqual(sameTitle({ items: list }, title), []);
  assert.deepEqual(sameTitle(undefined, title), []);
});

test("newIssueLink opens GitHub's form with the template and the title, and never the body", () => {
  const link = new URL(newIssueLink("zenius 0.1.4: ZEN_INTERNAL in page.click & #2?"));
  assert.equal(`${link.origin}${link.pathname}`, `${ISSUES}/new`);
  assert.deepEqual([...link.searchParams], [
    ["template", "zenius-problem.md"],
    ["title", "zenius 0.1.4: ZEN_INTERNAL in page.click & #2?"],
  ]);
  assert.equal(link.hash, "");
  const fixture = new URL(newIssueLink("t", "http://127.0.0.1:8000/feedback-form"));
  assert.equal(`${fixture.origin}${fixture.pathname}`, "http://127.0.0.1:8000/feedback-form");
  assert.equal(fixture.searchParams.get("title"), "t");
});
