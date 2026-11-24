// An agent's page's icon on its copies in the other windows (window sync).
// Window sync sets a copy's icon from the page's image attribute, which
// Gecko makes a moz-remote-image: URL for an SVG favicon. setIcon refuses
// that for the copy, which keeps the icon it had: for a new page, none.
// zen-core gives an agent's page's copies the icon from the page's browser
// instead (windows.sys.mjs, copyIcon).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let home;
/** The tasks this file starts, which it finishes at the end. */
const spaces = [];
before(async () => {
  h = await setup();
  home = await h.chrome(`return win.gZenWorkspaces.activeWorkspace`);
  await openWindow();
});
after(async () => {
  for (const space of spaces) {
    await h?.call("spaces.finish", { space, keep: [] }).catch(() => {});
  }
  // The files after this one share this Zen: one window, showing the Space it showed.
  await h
    ?.chrome(
      `${W}
       for (const w of wins().slice(1)) w.close();
       nth(0).focus();
       if (arg && win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);
       return true;`,
      home
    )
    .catch(() => {});
  await h?.close();
});

const W = `
  const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const nth = n => wins()[n];
  const wid = w => w?.docShell?.outerWindowID ?? null;
  const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const sleep = ms => new Promise(r => later(r, ms));
  const until = async (fn, ms = 10000) => {
    for (const end = Date.now() + ms; !(await fn()); ) {
      if (Date.now() > end) return false;
      await sleep(25);
    }
    return true;
  };
`;

async function openWindow() {
  return h.chrome(
    `${W}
     const first = nth(0);
     const w = first.OpenBrowserWindow();
     await new Promise(r => w.addEventListener("load", r, { once: true }));
     await w.delayedStartupPromise;
     await w.gZenWorkspaces.promiseInitialized;
     await until(() => w.gZenWorkspaces.allStoredTabs.length >= first.gZenWorkspaces.allStoredTabs.length, 30000);
     first.focus();
     await until(() => wid(Services.focus.activeWindow) === wid(first));
     return wins().length;`
  );
}

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='#0b8043'/></svg>";

/** A task's page whose site gives it an SVG favicon. */
async function pageWithIcon(name, slug) {
  const space = await h.space(name);
  spaces.push(space);
  const { label } = await h.call("pages.new", { space });
  await h.call("page.goto", { space, page: label, url: `${h.base}/?${slug}` });
  // As a site's own <link rel=icon>: Gecko's favicon loader sets it on the tab.
  await h.call("page.evaluate", {
    space,
    page: label,
    isFunction: false,
    fn: `(() => { const l = document.createElement("link"); l.rel = "icon"; l.href = "data:image/svg+xml;base64," + btoa(${JSON.stringify(SVG)}); document.head.append(l); return 1; })()`,
  });
  return { space, page: label };
}

// remote: the page's icon is what window sync can't pass on, after Gecko's
// remote SVG decoding. copyRemote: the copy's went through setIcon too, as
// the page's did, so Gecko decoded it the same way.
const ICON = `
  const iconOf = (t, copy) => ({
    remote: (t.getAttribute("image") ?? "").startsWith("moz-remote-image:"),
    copyRemote: (copy?.getAttribute("image") ?? "").startsWith("moz-remote-image:"),
    same: !!copy && copy.linkedBrowser?.mIconURL === t.linkedBrowser.mIconURL,
  });
`;

test("an agent's page's SVG icon, which arrives once its copy is in the other window, goes to that copy", async () => {
  const { space, page } = await pageWithIcon("copy icons", "copy-icon");
  const out = await h.chrome(
    `${W}${ICON}
     const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));
     const copy = Win.copyIn(t, nth(1));
     await until(() => !!t.getAttribute("image"));
     const got = await until(() => !!copy?.getAttribute("image"), 5000);
     return { hadCopy: !!copy, got, ...iconOf(t, copy) };`,
    { space, page }
  );
  assert.deepEqual(out, { hadCopy: true, got: true, remote: true, copyRemote: true, same: true });
});

test("a copy zenius makes for a window that lacks one gets the page's SVG icon too", async () => {
  const { space, page } = await pageWithIcon("copy icons, made", "copy-icon-made");
  const out = await h.chrome(
    `${W}${ICON}
     const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));
     await until(() => !!t.getAttribute("image"));
     // A window that window sync left without the copy (fillCopies says
     // when). Here the copy goes without window sync closing the others.
     const w = nth(1);
     w._zenClosingWindow = true;
     try {
       w.gBrowser.removeTab(Win.copyIn(t, w), { animate: false });
     } finally {
       w._zenClosingWindow = false;
     }
     const gone = await until(() => !Win.copyIn(t, w), 5000);
     // As zenius does after it places a tab.
     Win.repairCopiesSoon(t);
     const made = await until(() => !!Win.copyIn(t, w), 5000);
     const copy = Win.copyIn(t, w);
     const got = await until(() => !!copy?.getAttribute("image"), 5000);
     return { gone, made, got, ...iconOf(t, copy) };`,
    { space, page }
  );
  assert.deepEqual(out, { gone: true, made: true, got: true, remote: true, copyRemote: true, same: true });
});
