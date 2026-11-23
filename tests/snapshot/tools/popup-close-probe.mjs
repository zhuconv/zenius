// The user closes a popup the task adopted: does the opener's world survive?
// For zen-observe's tabClosing fix.
//
// discardLeftTab (observe/agentworld.sys.mjs) waits a main-thread turn after
// a page leaves its task, then skips a tab that's closing: a closing tab
// takes only its own worlds. On Gecko 160 its closing check never saw a
// closing tab. The agent's close (pages.close) removes the tab at once, so
// zen-observe's test, which closes that way, passed. The user's close
// button animates (gBrowser.removeTab with animate, as the tab strip calls
// it), so the tab may still be in the strip, closing, when the check runs,
// and the popup's group lost its worlds, the opener's included.
//
// Each case is its own task. As in zen-observe's test, a listener of the
// world opens the popup at the agent's click, and the popup joins the task.
// - userClose, userCloseXS: the user shows the task's Space and clicks the
//   popup tab's close button. A same-site and a cross-site popup.
// - agentClose (control, zen-observe's 1107591 case): pages.close.
// - release (control): pages.release with group lets the popup and its
//   opener go to the user, still open. Their worlds must end, so the skip
//   is only for a closing tab.
// Each records the opener's and the popup's world values just before the
// close, the opener's after, read without making a world
// (agentworld#peek), and for the user's close the tab's state at the click,
// a turn later (where the check runs) and 300 ms later.
//
//   ZENIUS_INSTANCE=zen-snapshot-main node tests/snapshot/tools/popup-close-probe.mjs [case ...]
//
// Headless on the Linux server only, loopback fixtures only. The user's Space is shown
// again after each user close, and the released tabs are closed.
import { openKit } from "./owntab-kit.mjs";

if (process.platform === "darwin") {
  console.error("popup-close-probe: headless on the Linux server only");
  process.exit(2);
}

const kit = await openKit();
const { call, chrome, A, B, sleep } = kit;
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

/** The agent's world value in a tab's top document, without making a world. */
const worldIn = (id, expr) =>
  chrome(
    `const top = BrowsingContext.getCurrentTopByBrowserId(arg.id);
     return top ? await ctx.content(top, "agentworld#peek", { expr: arg.expr }) : { gone: true };`,
    { id, expr }
  ).catch(e => ({ error: String(e?.message).slice(0, 160) }));

const evaluate = (space, page, fn) => call("page.evaluate", { space, page, fn, isFunction: false });

/** A listener of the world opens the popup at the agent's click; it joins the task. */
async function openPopup(space, url) {
  await evaluate(
    space,
    "p1",
    `(() => {
       const b = document.createElement("button"); b.id = "zsOpen"; b.textContent = "open"; b.style.cssText = "display:block;width:200px;height:30px";
       b.addEventListener("click", () => window.open(${JSON.stringify(url)}));
       document.body.prepend(b);
       return 1;
     })()`
  );
  await call("page.click", { space, page: "p1", target: "#zsOpen" });
  for (let i = 0; i < 100; i++) {
    const p = (await call("pages.list", { space })).find(x => x.url === url);
    if (p) {
      return p.label;
    }
    await sleep(50);
  }
  throw new Error(`the popup didn't join the task: ${JSON.stringify(await call("pages.list", { space }))}`);
}

const CLOSE = {
  // The user shows the task's Space and clicks the popup tab's close button.
  user: ({ space, label }) =>
    chrome(
      `
      const t = ctx.resolvePage(arg).tab;
      const w = t.ownerDocument.defaultView;
      const home = w.gZenWorkspaces.activeWorkspace;
      const agents = ctx.spaces.agentsSpace.uuid;
      const r = { home: home === agents ? "agents" : "user" };
      try {
        await w.gZenWorkspaces.changeWorkspaceWithID(agents);
        await sleep(300);
        const sel = w.gBrowser.selectedTab;
        r.shown = {
          hidden: t.hidden,
          fadein: t.hasAttribute("fadein"),
          width: Math.round(t.getBoundingClientRect().width),
          selected: sel === t ? "the popup" : ctx.service.lookup(sel) ? "a task tab" : "another tab",
        };
        const browser = t.linkedBrowser;
        const state = () => ({
          connected: t.isConnected,
          closing: !!t.closing,
          browserConnected: !!browser.isConnected,
          tabForBrowser: w.gBrowser.getTabForBrowser?.(browser) === t,
        });
        const button = t.closeButton ?? t.querySelector(".tab-close-button");
        r.by = button ? "close button" : "removeTab with animate";
        if (button) button.click();
        else w.gBrowser.removeTab(t, { animate: true });
        r.atClick = state();
        r.afterTurn = await new Promise(res => Services.tm.dispatchToMainThread(() => res(state())));
        await sleep(300);
        r.after300 = state();
      } finally {
        await w.gZenWorkspaces.changeWorkspaceWithID(home);
      }
      return r;
    `,
      { space, page: label }
    ),
  agent: ({ space, label }) => call("pages.close", { space, page: label }),
  release: ({ space, label }) => call("pages.release", { space, page: label, group: true }),
};

const CASES = {
  userClose: { close: "user" },
  userCloseXS: { close: "user", cross: true },
  agentClose: { close: "agent" },
  release: { close: "release" },
};

async function oneCase(name, { close, cross = false }) {
  step(name, "setup");
  const out = { name, close, popupSite: cross ? "other site" : "same site" };
  let space = null;
  try {
    space = await kit.newTask(`popup-close ${name}`, `${A.base}/sb?opener=${name}`);
    await evaluate(space, "p1", `window.__probe = { made: true }; 1`);
    const url = `${(cross ? B : A).base}/sb?popup=${name}`;
    const label = await openPopup(space, url);
    await evaluate(space, label, `window.__mine = 1; 1`);
    const ids = await chrome(
      `return { popup: ctx.resolvePage(arg.Q).browser.browserId, opener: ctx.resolvePage(arg.P).browser.browserId };`,
      { Q: { space, page: label }, P: { space, page: "p1" } }
    );
    out.before = { opener: await worldIn(ids.opener, "window.__probe"), popup: await worldIn(ids.popup, "window.__mine") };
    step(name, close);
    out.closed = await CLOSE[close]({ space, label, ids });
    await sleep(500);
    out.after = {
      opener: await worldIn(ids.opener, "window.__probe"),
      popup: await worldIn(ids.popup, "window.__mine"),
      pages: (await call("pages.list", { space }).catch(() => [])).map(p => p.label),
    };
    out.agentReads = await evaluate(space, "p1", "JSON.stringify(window.__probe ?? null)").then(
      value => ({ value }),
      e => ({ code: e?.code ?? String(e?.message).slice(0, 120) })
    );
  } catch (e) {
    out.error = `${e?.code ?? ""} ${String(e?.message).slice(0, 200)}`;
  } finally {
    if (space !== null) {
      await call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
  }
  const made = v => v?.value?.made === true;
  if (!out.error) {
    out.verdict =
      close === "release"
        ? made(out.before.opener) && out.after.opener?.none === true
          ? "the opener's world ended (released open)"
          : "the opener's world did NOT end"
        : made(out.before.opener) && made(out.after.opener)
          ? "the opener's world survived"
          : made(out.before.opener)
            ? "the opener's world ENDED"
            : "no control: the opener had no world before the close";
    if (close === "user") {
      out.window = out.closed?.afterTurn?.connected
        ? "the tab was still in the strip a turn after the click (the check's case)"
        : "the tab was gone a turn after the click (removed at once)";
    }
  }
  return out;
}

const names = process.argv.slice(2).filter(n => n in CASES);
const out = [];
try {
  for (const name of names.length ? names : Object.keys(CASES)) {
    out.push(await oneCase(name, CASES[name]));
  }
} finally {
  console.log(JSON.stringify(out, null, 1));
  await kit.cleanTabs().catch(() => {});
  kit.close();
}
