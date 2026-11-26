// The page-code card (ui/pagecode.sys.mjs; the input layer's glue in the UI's
// files). With zenius.agentTabs.pageCode at "ask", the observe layer holds the
// agent's page code on a site the user hasn't allowed and asks once per task
// and site (observe/pagecode.sys.mjs). The agent's tab shows the card, in
// the observe layer's words: "Allow the agent's code on <site>?" [Allow on this
// site] [Not now]. Allow puts the exact site on
// zenius.agentTabs.pageCodeSites, on the user's own click only, and the
// agent's next call there runs. Not now writes nothing, and the card doesn't
// come back for that site in that task. The agent's synthesized clicks and
// keys can't press Allow, nor can its code's dispatched clicks. The card
// takes no focus, moves no view (I1), and goes when its task ends.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { iso, setup } from "./lib.mjs";

let h;
let userView;
let saved;
const run = Date.now().toString(36).slice(-5);
const MODE = "zenius.agentTabs.pageCode";
const SITES = "zenius.agentTabs.pageCodeSites";
/** The fixture's site, as the observe layer's siteOf names it, and as the card does (an http site shows its scheme). */
const site = () => `http://${new URL(h.base).hostname}`;

/** Both prefs as the profile has them (null: unset). */
const prefs = () =>
  h.chrome(`return Object.fromEntries([${JSON.stringify(MODE)}, ${JSON.stringify(SITES)}].map(p => [p, Services.prefs.prefHasUserValue(p) ? Services.prefs.getStringPref(p) : null]));`);
const setPrefs = values =>
  h.chrome(
    `for (const [p, v] of Object.entries(${JSON.stringify(values)})) { if (v === null) Services.prefs.clearUserPref(p); else Services.prefs.setStringPref(p, v); } return true;`
  );

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  saved = await prefs();
});

after(async () => {
  if (saved) {
    await setPrefs(saved).catch(() => {});
  }
  await h?.close();
});

// Chrome-side helpers: pages by browserId, which outlives their labels.
const K = `
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) throw new Error("timed out waiting for " + fn);
      await sleep(25);
    }
  };
  const tabOf = bid => [...Win.uniqueTabs()].find(t => t.linkedBrowser?.browserId === bid) ?? null;
  const VALUE = "zenius-pagecode:";
  const cardOf = (bid, site) => N.noticeElement(tabOf(bid), VALUE + site);
  // Every page-code card in the tab, by site.
  const cardsOf = bid =>
    [...(tabOf(bid)?.linkedBrowser.parentElement.querySelectorAll(".zenius-card") ?? [])]
      .filter(el => el.dataset.value?.startsWith(VALUE))
      .map(el => el.dataset.value.slice(VALUE.length));
  const buttonOf = (bid, site, label) => [...(cardOf(bid, site)?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);
  const sites = () => Services.prefs.getStringPref(${JSON.stringify(SITES)}, "");
  // The tab in view, as the user's click on its card needs.
  const view = async t => {
    ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs").landOn(t);
    await gZenWorkspaces.changeWorkspaceWithID(t.getAttribute("zen-workspace-id"));
    await until(() => gBrowser.selectedTab === t);
  };
  // The user's own click, as the OS's would come, once the card has armed
  // (it ignores clicks for 400 ms).
  const realClick = async el => {
    await sleep(450);
    const r = el.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      win.synthesizeMouseEvent(type, r.x + r.width / 2, r.y + r.height / 2, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
    }
    await sleep(100);
  };
`;

/** A task with one page, p1, on the fixture's forms page. */
async function task(name) {
  const { id: space } = await h.createSpace({ name: `UI pagecode ${name} ${run}` });
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/zoo/forms.html?${name}` });
  const bid = await h.chrome(`return ctx.resolvePage({ space: ${space}, page: "p1" }).browser.browserId;`);
  return { space, bid };
}

/** The agent's page code in p1: its result, or the error's code and data. */
async function evaluate(space) {
  try {
    return { value: await h.call("page.evaluate", { space, page: "p1", fn: "() => 1 + 1", isFunction: true }) };
  } catch (e) {
    return { code: e.code, data: e.data };
  }
}

/** Back to the user's Space, as each test found it. */
const backToUser = () =>
  h.chrome(
    `if (gZenWorkspaces.activeWorkspace !== ${JSON.stringify(userView.windows[0].activeWorkspace)}) await gZenWorkspaces.changeWorkspaceWithID(${JSON.stringify(userView.windows[0].activeWorkspace)}); return true;`
  );

test("under ask, the agent's page code on a site the user hasn't allowed raises the card in its tab, in the observe layer's words, once per task and site; another task gets its own; nothing takes focus or moves the user's view; always, the default, shows none", async () => {
  const a = await task("ask-a");
  const b = await task("ask-b");
  try {
    await setPrefs({ [MODE]: null, [SITES]: null });
    assert.deepEqual(await evaluate(a.space), { value: 2 }, "always runs it");
    assert.deepEqual(await h.chrome(`${K} await sleep(200); return cardsOf(${a.bid});`), [], "and asks nothing");

    await setPrefs({ [MODE]: "ask", [SITES]: "" });
    const first = await evaluate(a.space);
    assert.equal(first.code, "ZEN_PAGE_CODE_ASKED");
    assert.deepEqual([first.data.site, first.data.asked], [site(), true]);
    const again = await evaluate(a.space);
    assert.deepEqual([again.code, again.data.asked], ["ZEN_PAGE_CODE_ASKED", false], "the second call isn't asked again");
    assert.equal((await evaluate(b.space)).data.asked, true, "another task is asked for itself");
    const out = await h.chrome(`${K}
      await until(() => cardOf(${a.bid}, ${JSON.stringify(site())}) && cardOf(${b.bid}, ${JSON.stringify(site())}));
      const el = cardOf(${a.bid}, ${JSON.stringify(site())});
      return {
        text: N.noticeText(tabOf(${a.bid}), VALUE + ${JSON.stringify(site())}),
        buttons: [...el.querySelectorAll(".zenius-card-buttons button")].map(b => b.textContent),
        primary: el.querySelector("button[primary]")?.textContent ?? null,
        cards: [cardsOf(${a.bid}), cardsOf(${b.bid})],
        focusOnCard: [${a.bid}, ${b.bid}].some(bid => cardOf(bid, ${JSON.stringify(site())})?.contains(Services.focus.focusedElement)),
      };
    `);
    assert.deepEqual(out, {
      text: `Allow the agent's code on ${iso(site())}?`,
      buttons: ["Allow on this site", "Not now"],
      primary: "Allow on this site",
      cards: [[site()], [site()]],
      focusOnCard: false,
    });
    assert.deepEqual(await h.call("dev.viewState"), userView, "the user's view is as it was (I1)");
    assert.deepEqual(await prefs(), { [MODE]: "ask", [SITES]: "" }, "asking writes nothing");
  } finally {
    await setPrefs({ [MODE]: null, [SITES]: null });
  }
});

test("Allow on this site: the user's click appends the exact site to zenius.agentTabs.pageCodeSites, once, after what the list had; the agent's next evaluate runs, and the cards asking for that site go", async () => {
  const a = await task("allow-a");
  const b = await task("allow-b");
  try {
    await setPrefs({ [MODE]: "ask", [SITES]: "https://example.org" });
    assert.equal((await evaluate(a.space)).code, "ZEN_PAGE_CODE_ASKED");
    assert.equal((await evaluate(b.space)).code, "ZEN_PAGE_CODE_ASKED");
    const out = await h.chrome(`${K}
      const s = ${JSON.stringify(site())};
      await until(() => cardOf(${a.bid}, s) && cardOf(${b.bid}, s));
      await view(tabOf(${a.bid}));
      await realClick(buttonOf(${a.bid}, s, "Allow on this site"));
      await until(() => !cardOf(${a.bid}, s));
      return { list: sites(), cards: [cardsOf(${a.bid}), cardsOf(${b.bid})] };
    `);
    assert.deepEqual(out, { list: `https://example.org, ${site()}`, cards: [[], []] });
    assert.deepEqual(await evaluate(a.space), { value: 2 }, "the agent's next call there runs");
    assert.deepEqual(await evaluate(b.space), { value: 2 }, "in every task");
  } finally {
    await setPrefs({ [MODE]: null, [SITES]: null });
    await backToUser();
  }
});

test("Not now writes nothing: the card goes, the agent hears the user declined for this task, and the card doesn't come back for that site in that task", async () => {
  const { space, bid } = await task("notnow");
  try {
    await setPrefs({ [MODE]: "ask", [SITES]: "https://example.org" });
    assert.equal((await evaluate(space)).code, "ZEN_PAGE_CODE_ASKED");
    await h.chrome(`${K}
      const s = ${JSON.stringify(site())};
      await until(() => cardOf(${bid}, s));
      await view(tabOf(${bid}));
      await realClick(buttonOf(${bid}, s, "Not now"));
      await until(() => !cardOf(${bid}, s));
      return true;
    `);
    assert.deepEqual(await prefs(), { [MODE]: "ask", [SITES]: "https://example.org" }, "nothing written");
    const next = await evaluate(space);
    assert.equal(next.code, "ZEN_PAGE_CODE_ASKED");
    assert.equal(next.data.declined, true, "the agent hears the user declined");
    assert.deepEqual(await h.chrome(`${K} await sleep(300); return cardsOf(${bid});`), [], "no card comes back");
  } finally {
    await setPrefs({ [MODE]: null, [SITES]: null });
    await backToUser();
  }
});

test("Allow on this site: the agent's synthesized input can't press it (its click where the button shows lands in the page; its Tab, Enter and Space stay in the page), nor can its code's dispatched clicks, which reach only the page; the list stays as it was and the card stays", async () => {
  const { space, bid } = await task("synth");
  try {
    await setPrefs({ [MODE]: "ask", [SITES]: "" });
    assert.equal((await evaluate(space)).code, "ZEN_PAGE_CODE_ASKED");
    const spot = await h.chrome(`${K}
      const s = ${JSON.stringify(site())};
      await until(() => cardOf(${bid}, s));
      const t = tabOf(${bid});
      await view(t);
      await sleep(450);
      const r = buttonOf(${bid}, s, "Allow on this site").getBoundingClientRect();
      const area = t.linkedBrowser.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2 - area.x),
        y: Math.round(r.y + r.height / 2 - area.y),
        over: r.left >= area.left && r.right <= area.right && r.top >= area.top && r.bottom <= area.bottom,
      };
    `);
    assert.equal(spot.over, true, "the button shows over the page");
    // The agent's input, through the input layer as any agent's.
    await h.call("page.mouse", { space, page: "p1", action: "click", x: spot.x, y: spot.y, options: {} });
    for (let i = 0; i < 4; i++) {
      await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Tab", options: {} });
    }
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Enter", options: {} });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "Space", options: {} });
    const state = () =>
      h.chrome(`${K}
        const s = ${JSON.stringify(site())};
        await sleep(300);
        return { list: sites(), card: !!cardOf(${bid}, s), focusOnCard: !!cardOf(${bid}, s)?.contains(Services.focus.focusedElement) };
      `);
    assert.deepEqual(await state(), { list: "", card: true, focusOnCard: false }, "the agent's clicks and keys");
    assert.equal((await evaluate(space)).code, "ZEN_PAGE_CODE_ASKED", "the agent's code still doesn't run there");
    // A dispatched click, which only code can make: the agent's code clicks
    // what shows under the button, untrusted, in its own page, where it runs
    // unasked. (Gecko trusts any event chrome code dispatches, and only
    // chrome code can reach the card.) The card stays up across the load.
    await h.call("page.goto", { space, page: "p1", url: "data:text/html,<body style='margin:0'><div id=under style='height:100vh'></div>" });
    const hit = await h.call("page.evaluate", {
      space,
      page: "p1",
      fn: `({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        el?.click();
        return el?.id ?? null;
      }`,
      arg: { x: spot.x, y: spot.y },
      isFunction: true,
    });
    assert.equal(hit, "under", "the agent's code finds the page's element there");
    assert.deepEqual(await state(), { list: "", card: true, focusOnCard: false }, "the agent's dispatched clicks");
  } finally {
    await setPrefs({ [MODE]: null, [SITES]: null });
    await backToUser();
  }
});

test("the card goes when its task ends, even with the tab kept, and goes with its tab", async () => {
  const kept = await task("end-kept");
  const closed = await task("end-closed");
  try {
    await setPrefs({ [MODE]: "ask", [SITES]: "" });
    assert.equal((await evaluate(kept.space)).code, "ZEN_PAGE_CODE_ASKED");
    assert.equal((await evaluate(closed.space)).code, "ZEN_PAGE_CODE_ASKED");
    await h.chrome(`${K} await until(() => cardOf(${kept.bid}, ${JSON.stringify(site())}) && cardOf(${closed.bid}, ${JSON.stringify(site())})); return true;`);
    await h.call("spaces.finish", { space: kept.space, keep: ["p1"] });
    await h.call("pages.close", { space: closed.space, page: "p1" });
    const out = await h.chrome(`${K}
      await sleep(200);
      return { kept: !!tabOf(${kept.bid}), keptCards: cardsOf(${kept.bid}), closed: !!tabOf(${closed.bid}) };
    `);
    assert.deepEqual(out, { kept: true, keptCards: [], closed: false });
  } finally {
    await setPrefs({ [MODE]: null, [SITES]: null });
    await h.chrome(`${K} const t = tabOf(${kept.bid}); if (t) gBrowser.removeTab(t, { animate: false }); return true;`).catch(() => {});
  }
});

test("the card stays whole at any page width: its title, the whole site in it, wraps, and the buttons go under it when they don't fit beside it", async () => {
  const { space, bid } = await task("widths");
  try {
    const out = await h.chrome(`${K}
      const PC = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pagecode.sys.mjs");
      const t = tabOf(${bid});
      await view(t);
      const lengths = { short: "https://example.com", long: "https://examplecorporation-identity-services.co.uk" };
      // From wider than the widest pill to a sliver.
      const widths = [592, 480, 400, 320, 240];
      const misfits = {};
      const under = {};
      for (const [length, s] of Object.entries(lengths)) {
        const seen = [];
        for (const w of widths) {
          const id = PC.PAGE_CODE_NOTICE + s;
          N.showNotice(t, id, PC.pageCodeCard(s));
          await until(() => N.noticeElement(t, id));
          const el = N.noticeElement(t, id);
          const layer = el.parentElement;
          layer.style.width = w + "px";
          await sleep(150);
          const ls = win.getComputedStyle(layer);
          const l = layer.getBoundingClientRect();
          const c = el.getBoundingClientRect();
          const within = r => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
          const bad = [];
          if (c.left < l.left + parseFloat(ls.paddingLeft) - 0.5 || c.right > l.right - parseFloat(ls.paddingRight) + 0.5) bad.push("off its page");
          for (const part of el.querySelectorAll(".zenius-card-title, .zenius-card-button")) {
            if (!within(part.getBoundingClientRect())) bad.push("cut: " + part.textContent.slice(0, 20));
          }
          const title = el.querySelector(".zenius-card-title");
          const range = title.ownerDocument.createRange();
          range.selectNodeContents(title);
          if ([...range.getClientRects()].some(r => !within(r))) bad.push("the title's text is cut");
          if (!title.textContent.includes(PC.siteLabel(s))) bad.push("the site isn't whole");
          if (bad.length) misfits[length + " / " + w] = bad;
          seen.push(el.querySelector(".zenius-card-buttons").getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1 ? "under" : "beside");
          layer.style.width = "";
          N.removeNotice(t, id);
          await until(() => !N.noticeElement(t, id));
        }
        under[length] = seen.join(" ");
      }
      return { misfits, under };
    `);
    assert.deepEqual(out.misfits, {});
    // The buttons sit beside the title while they fit.
    assert.match(out.under.short, /^beside /);
    assert.match(out.under.long, / under$/);
  } finally {
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await backToUser();
  }
});
