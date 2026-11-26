// The core's claim gate, end to end: an agent's spaces.claim of a user's
// Space waits for the user's answer on the UI's prompt. These tests make
// the agent's real call and play the user's clicks; claim.test.mjs covers
// the prompt itself on stand-in events.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, setup } from "./lib.mjs";

let h;
let userView;
const run = Date.now().toString(36).slice(-5);

// Chrome-side helpers. The prompt goes on the selected tab of every window.
const R = () => `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const tab = gBrowser.selectedTab;
  const pillOf = id => N.noticeElement(tab, "zenius-claim:" + id);
  const askFor = space => ctx.service.spaces.pendingClaims().find(a => a.space === space);
  // The user's click, once the prompt has armed (it ignores clicks for 400 ms).
  const press = async (el, label) => {
    await sleep(450);
    [...el.querySelectorAll("button")].find(b => b.textContent === label).click();
  };
  const heard = () => win.document.getElementById("a11y-announcement").firstChild?.getAttribute("aria-label") ?? null;
  // Announcements go out together a moment after the first (ANNOUNCE_MS).
  const heardSoon = async () => {
    await ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").announcementsOut(win);
    return heard();
  };
`;

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  // An announcement the suite before left pending would join this suite's
  // first (they go out together within ANNOUNCE_MS).
  await h.chrome("await new Promise(r => win.setTimeout(r, 450)); return true;");
});

after(async () => {
  await h?.close();
});

/** The agent's claim, settled into a value: the call may fail before an assert could attach. */
const claim = params =>
  h.call("spaces.claim", params).then(
    value => ({ value }),
    error => ({ error })
  );

test("Allow lets an agent's claim of the user's Space through, after a prompt that quotes the agent's own label; nothing moves", async () => {
  const space = await h.userSpace(`zen-ux claim allow ${run}`);
  const pending = claim({ space, client: "Trip\u202E planner", timeout: 30000 });
  const out = await h.chrome(`${R()}
    const focused = Services.focus.focusedElement;
    await until(() => askFor(${space}) && pillOf(askFor(${space}).id));
    const ask = askFor(${space});
    const el = pillOf(ask.id);
    const res = {
      text: N.noticeText(tab, "zenius-claim:" + ask.id),
      note: el.querySelector(".zenius-card-note").textContent,
      heard: await heardSoon(),
      name: ctx.spaces.peek(${space}).name,
      focusKept: Services.focus.focusedElement === focused,
      selectionKept: gBrowser.selectedTab === tab,
    };
    await press(el, "Allow");
    await until(() => !pillOf(ask.id));
    return res;
  `);
  const { value, error } = await pending;
  assert.equal(error, undefined, error?.message);
  assert.equal(value.ownership, "agent");
  const note = `An agent asks to work in your Space “${iso(out.name)}”. It calls itself “${iso("Trip planner")}”.`;
  assert.match(out.text, /^Agent request · denied in (29|30) s$/);
  assert.equal(out.note, note, "zenius's words first; the label cleaned of its override");
  assert.equal(out.heard, `Agent request. ${note}`);
  assert.equal(out.focusKept, true);
  assert.equal(out.selectionKept, true);
});

test("Deny refuses the claim with ZEN_TASK_SPACE_CLAIM_DENIED, and the Space stays the user's", async () => {
  const space = await h.userSpace(`zen-ux claim deny ${run}`);
  const pending = claim({ space, timeout: 30000 });
  const out = await h.chrome(`${R()}
    await until(() => askFor(${space}) && pillOf(askFor(${space}).id));
    const ask = askFor(${space});
    const note = pillOf(ask.id).querySelector(".zenius-card-note").textContent;
    await press(pillOf(ask.id), "Deny");
    await until(() => !pillOf(ask.id));
    return { note, name: ctx.spaces.peek(${space}).name };
  `);
  const { error } = await pending;
  assert.equal(error?.code, "ZEN_TASK_SPACE_CLAIM_DENIED", error?.message);
  assert.equal(error.data.verdict, "deny");
  assert.equal(out.note, `An agent asks to work in your Space “${iso(out.name)}”.`, "no label: zenius's words alone");
  const ownership = await h.chrome(`return ctx.spaces.peek(${space}).ownership;`);
  assert.equal(ownership, "user");
});

test("no answer denies it when the call's time runs out, and the prompt goes", async () => {
  const space = await h.userSpace(`zen-ux claim timeout ${run}`);
  const pending = claim({ space, client: "Slow agent", timeout: 1500 });
  const shown = await h.chrome(`${R()}
    await until(() => askFor(${space}) && pillOf(askFor(${space}).id));
    const ask = askFor(${space});
    return { id: ask.id, text: N.noticeText(tab, "zenius-claim:" + ask.id) };
  `);
  const { error } = await pending;
  assert.match(shown.text, /^Agent request · denied in [12] s$/);
  assert.equal(error?.code, "ZEN_TASK_SPACE_CLAIM_DENIED", error?.message);
  assert.equal(error.data.verdict, "timeout");
  const settled = await h.chrome(`${R()}
    await until(() => !pillOf(${JSON.stringify(shown.id)}));
    return { pill: !!pillOf(${JSON.stringify(shown.id)}), ownership: ctx.spaces.peek(${space}).ownership, pending: !!askFor(${space}) };
  `);
  assert.deepEqual(settled, { pill: false, ownership: "user", pending: false });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
