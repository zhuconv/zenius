// The claim gate's prompt. When an agent claims a user's Space or an ended
// task, the core asks the user: it sends claimAsked {id, space, name, client,
// until} in process, takes the answer through spaces.answerClaim(id, allow),
// and sends claimSettled {id, verdict} at every end. These tests send the
// events themselves and stand in for answerClaim.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup, iso } from "./lib.mjs";

let h;
let userView;
let seq = 0;

// Chrome-side helpers.
const Q = () => `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const mine = ctx.service.spaces.records().find(r => r.uuid === gZenWorkspaces.activeWorkspace);
  const ask = (id, extra = {}) =>
    ctx.service.emitLocal("claimAsked", { id, space: mine.id, name: mine.name, client: "Test client", until: Date.now() + 30000, ...extra });
  const pillOn = (tab, id) => N.noticeElement(tab, "zenius-claim:" + id);
  const answers = [];
  ctx.service.spaces.answerClaim = (id, allow) => answers.push([id, allow]);
  const press = async (el, label) => {
    await sleep(450);
    [...el.querySelectorAll("button")].find(b => b.textContent === label).click();
  };
`;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
});

after(async () => {
  await h?.chrome(`delete ctx.service.spaces.answerClaim;`).catch(() => {});
  await h?.close();
});

test("an ask shows on the selected tab: the client's sentence, Allow and Deny, a countdown; no focus moves", async () => {
  const id = `ask-${++seq}`;
  const out = await h.chrome(`${Q()}
    const tab = gBrowser.selectedTab;
    const focused = document.activeElement;
    ask(${JSON.stringify(id)});
    try {
      await until(() => pillOn(tab, ${JSON.stringify(id)}));
      const el = pillOn(tab, ${JSON.stringify(id)});
      return {
        text: N.noticeText(tab, "zenius-claim:" + ${JSON.stringify(id)}),
        note: el.querySelector(".zenius-card-note").textContent,
        buttons: [...el.querySelectorAll("button")].map(b => b.textContent),
        primary: el.querySelector("button[primary]").textContent,
        focusKept: document.activeElement === focused,
        selectionKept: gBrowser.selectedTab === tab,
        name: mine.name,
      };
    } finally {
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
    }
  `);
  assert.match(out.text, /^Agent request · denied in (29|30) s$/);
  assert.equal(out.note, `An agent asks to work in your Space “${iso(out.name)}”. It calls itself “${iso("Test client")}”.`);
  assert.deepEqual(out.buttons, ["Allow", "Deny"]);
  assert.equal(out.primary, "Allow");
  assert.equal(out.focusKept, true);
  assert.equal(out.selectionKept, true);
});

test("it moves with the selection, so it stays in sight", async () => {
  const id = `ask-${++seq}`;
  const out = await h.chrome(`${Q()}
    const first = gBrowser.selectedTab;
    const other = gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    ask(${JSON.stringify(id)});
    try {
      await until(() => pillOn(first, ${JSON.stringify(id)}));
      gBrowser.selectedTab = other;
      await until(() => pillOn(other, ${JSON.stringify(id)}));
      return { onOther: !!pillOn(other, ${JSON.stringify(id)}), onFirst: !!pillOn(first, ${JSON.stringify(id)}) };
    } finally {
      ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(id)}, verdict: "deny" });
      gBrowser.selectedTab = first;
      gBrowser.removeTab(other, { animate: false });
    }
  `);
  assert.deepEqual(out, { onOther: true, onFirst: false });
});

test("Allow and Deny answer zen-core once, and the prompt goes", async () => {
  const [allowId, denyId] = [`ask-${++seq}`, `ask-${++seq}`];
  const out = await h.chrome(`${Q()}
    const tab = gBrowser.selectedTab;
    ask(${JSON.stringify(allowId)});
    ask(${JSON.stringify(denyId)});
    await until(() => pillOn(tab, ${JSON.stringify(allowId)}) && pillOn(tab, ${JSON.stringify(denyId)}));
    await press(pillOn(tab, ${JSON.stringify(allowId)}), "Allow");
    await press(pillOn(tab, ${JSON.stringify(denyId)}), "Deny");
    // The core's settle after the answer changes nothing more.
    ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(allowId)}, verdict: "allow" });
    return { answers, left: [!!pillOn(tab, ${JSON.stringify(allowId)}), !!pillOn(tab, ${JSON.stringify(denyId)})] };
  `);
  assert.deepEqual(out.answers, [
    [allowId, true],
    [denyId, false],
  ]);
  assert.deepEqual(out.left, [false, false]);
});

test("zen-core's claimSettled (a timeout, the client gone) removes it; with none, it goes a second past its time", async () => {
  const [settled, lapsed] = [`ask-${++seq}`, `ask-${++seq}`];
  const out = await h.chrome(`${Q()}
    const tab = gBrowser.selectedTab;
    ask(${JSON.stringify(settled)});
    ask(${JSON.stringify(lapsed)}, { until: Date.now() + 300 });
    await until(() => pillOn(tab, ${JSON.stringify(settled)}) && pillOn(tab, ${JSON.stringify(lapsed)}));
    ctx.service.emitLocal("claimSettled", { id: ${JSON.stringify(settled)}, verdict: "timeout" });
    const afterSettle = !!pillOn(tab, ${JSON.stringify(settled)});
    await until(() => !pillOn(tab, ${JSON.stringify(lapsed)}), 3000);
    return { afterSettle, answers };
  `);
  assert.equal(out.afterSettle, false);
  assert.deepEqual(out.answers, [], "no answer on the user's behalf");
});

test("a malformed ask shows nothing", async () => {
  const out = await h.chrome(`${Q()}
    const tab = gBrowser.selectedTab;
    ctx.service.emitLocal("claimAsked", { id: 7, space: mine.id, name: "x", client: "y", until: Date.now() + 30000 });
    ctx.service.emitLocal("claimAsked", { id: "no-until", space: mine.id, name: "x", client: "y", until: "soon" });
    ctx.service.emitLocal("claimAsked", { id: "no-space", name: "x", client: "y", until: Date.now() + 30000 });
    ctx.service.emitLocal("claimAsked", null);
    await sleep(100);
    return [...tab.linkedBrowser.parentElement.querySelectorAll('.zenius-card[data-value^="zenius-claim:"]')].length;
  `);
  assert.equal(out, 0);
});

test("zenius's words come first; a client's name is only a label after them, and can't reorder or stretch them", async () => {
  const out = await h.chrome(`
    const { plainText, claimCard } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    return {
      bidi: plainText("Claude\\u202Eedoc ruoy\\u202C", 40),
      control: plainText("Line\\none\\u0000", 40),
      zeroWidth: plainText("Ze\\u200Bnius\\uFEFF", 40),
      separators: plainText("a\\u2028b\\u2029c", 40),
      spaces: plainText("  a   b\\u00A0 c  ", 40),
      long: plainText("x".repeat(50), 40),
      codePoints: [...plainText("\\u{1F600}".repeat(50), 40)].length,
      none: plainText(undefined, 40),
      named: claimCard("Trip planner", "Work", 0).note,
      unnamed: claimCard("", "Work", 0).note,
    };
  `);
  assert.deepEqual(out, {
    bidi: "Claudeedoc ruoy",
    control: "Lineone",
    zeroWidth: "Zenius",
    separators: "abc",
    spaces: "a b c",
    long: `${"x".repeat(39)}…`,
    codePoints: 40,
    none: "",
    named: `An agent asks to work in your Space “${iso("Work")}”. It calls itself “${iso("Trip planner")}”.`,
    unnamed: `An agent asks to work in your Space “${iso("Work")}”.`,
  });
});

test("Ego's 10-minute wait counts down in minutes, then in seconds", async () => {
  const out = await h.chrome(`${Q()}
    const tab = gBrowser.selectedTab;
    const id = "ask-long";
    ask(id, { until: Date.now() + 600000 });
    try {
      await until(() => pillOn(tab, id));
      return N.noticeText(tab, "zenius-claim:" + id);
    } finally {
      ctx.service.emitLocal("claimSettled", { id, verdict: "gone" });
    }
  `);
  assert.equal(out, "Agent request · denied in 10 min");
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
