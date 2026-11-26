// A task's tab the user unloads with Zen open (Unload Tab; Zen's Unload
// Space goes the same way, through gBrowser.explicitUnloadTabs, which no
// keep-alive holds), then views again: Gecko inserts a new browser for it,
// whose browserId no published set holds until zenius publishes them again
// (service #onTaskBrowser). Its documents must get the guards from their
// first script, and a held secret step's loads the capture.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
const hits = new Map();
/** window.__first: the page refusals' natives its first script saw unwrapped, and whether zen-ux's quiet Notification was there. */
const FIRST_SCRIPT = `window.__first = {
  native: ["Notification", "RTCPeerConnection", "SharedWorker", "BroadcastChannel"].filter(n => Function.prototype.toString.call(window[n]).includes(n)),
  quiet: window.Notification === window.Notification.prototype.constructor && !/function Notification\\(/.test(Function.prototype.toString.call(window.Notification)),
};`;
const GUARDED_FIRST = { native: [], quiet: true };
/** Cacheable pages, each request counted by its path and query; ?r= names the page (its title). */
const server = http.createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
  const r = new URL(req.url, "http://x").searchParams.get("r") ?? "page";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>${r}</title><script>${FIRST_SCRIPT}</script><form><input name=nickname></form>`);
});
let base = "";

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  h = await setup();
});
after(async () => {
  await h?.close();
  server.close();
  server.closeAllConnections();
});

/** A page's tab, in chrome code with `arg` {space, page}. */
const TAB = `const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));`;
const userViews = (space, page) =>
  h.chrome(
    `${TAB} await win.gZenWorkspaces.changeWorkspaceWithID(ctx.spaces.agentsSpace.uuid); win.gBrowser.selectedTab = t; return true;`,
    { space, page }
  );
const userGoesHome = () =>
  h.chrome(
    `const home = win.gZenWorkspaces.getWorkspaces().find(ws => !ctx.spaces.isAgentsSpace(ws.uuid));
     await win.gZenWorkspaces.changeWorkspaceWithID(home.uuid);
     return true;`
  );
const tabNow = (space, page) =>
  h.chrome(
    `${TAB} const bc = t.linkedBrowser.browsingContext;
     return { url: bc?.currentWindowGlobal?.documentURI?.spec ?? "", unloaded: !t.linkedPanel || t.hasAttribute("pending") };`,
    { space, page }
  );
const inPage = (space, page, code) =>
  h.chrome(`${TAB} return ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code: arg.code, privileged: false });`, { space, page, code });
const loadedAt = (space, page, part) =>
  h.until(async () => {
    const now = await tabNow(space, page).catch(() => null);
    return !!now?.url.includes(part) && (await inPage(space, page, "return document.readyState;").catch(() => "")) === "complete";
  }, 10000);
const firstView = (space, page) => inPage(space, page, "return JSON.parse(JSON.stringify(window.__first ?? null));");
const guardsIn = (space, page) => h.chrome(`${TAB} return ctx.content(t.linkedBrowser.browsingContext, "guards#installed", {});`, { space, page });
/** The user's Unload Tab, in the background, as Zen's Unload Space does it. */
const userUnloads = async (space, page) => {
  await h.chrome(`${TAB} win.gBrowser.explicitUnloadTabs([t]); return true;`, { space, page });
  await h.until(async () => (await tabNow(space, page)).unloaded, 5000);
};
/** The user views the unloaded tab again, and it has loaded `r` once more (from the HTTP cache, if it kept the page). */
const userViewsAgain = async (space, page, r) => {
  await userViews(space, page);
  await h.until(async () => !(await tabNow(space, page)).unloaded, 10000);
  await loadedAt(space, page, `r=${r}`);
};
const networkActive = () =>
  h.chrome(`return ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/network.sys.mjs").networkActive();`);
/** The user's Resume, as the UI's button does it: the hand back's steps, then the flip. */
const resumeByUser = space =>
  h.chrome(`const s = ctx.spaces.get(arg); await ctx.service.beforeHandBack(s); ctx.spaces.setOwnership(s, "agent", { source: "user" }); return true;`, space);
/** A load the user makes in the held tab. */
const userLoads = (space, page, u) =>
  h.chrome(
    `${TAB} t.linkedBrowser.loadURI(Services.io.newURI(arg.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`,
    { space, page, url: u }
  );
/** Whether a fetch only the HTTP cache can answer, from `reader`'s page p1 on the same site, gets page `r` back. */
const cachedFor = (reader, r) =>
  h.call("page.fetch", { space: reader, page: "p1", url: `${base}/?r=${r}`, options: { cache: "only-if-cached", mode: "same-origin" } }).then(
    res => String(res.body ?? "").includes(`<title>${r}</title>`),
    () => false
  );
/** The agent's camera in its page: refused at once, a prompt still waiting after 2 s, or a stream. */
const CAMERA = `(async () => {
  const asked = navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "granted"; }, e => e.name);
  return Promise.race([asked, new Promise(r => setTimeout(() => r("still waiting (a prompt)"), 2000))]);
})()`;

test("an agent's tab the user unloads and views again: guarded from its first script, and the agent's camera is refused there", async () => {
  const space = await h.space("unload agent");
  await h.chrome(`Services.prefs.setBoolPref("media.navigator.streams.fake", true); Services.prefs.setBoolPref("media.devices.unfocused.enabled", true); return true;`);
  try {
    await h.call("page.goto", { space, page: "p1", url: `${base}/?r=u1` });
    await userGoesHome();
    await userUnloads(space, "p1");
    await userViewsAgain(space, "p1", "u1");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "its first script had the guards");
    assert.equal(await guardsIn(space, "p1"), true);
    await userGoesHome();
    const camera = await h.call("page.evaluate", { space, page: "p1", fn: CAMERA, isFunction: false });
    assert.equal(camera?.result ?? camera, "NotAllowedError", "the agent's camera");
  } finally {
    await h.chrome(`for (const n of ["media.navigator.streams.fake", "media.devices.unfocused.enabled"]) Services.prefs.clearUserPref(n); return true;`).catch(() => {});
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("a held step's tab the user unloads and views again: guarded from its first script", async () => {
  const space = await h.space("unload held");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${base}/?r=u2` });
    await h.call("spaces.handOff", { space });
    await userGoesHome();
    await userUnloads(space, "p1");
    await userViewsAgain(space, "p1", "u2");
    assert.deepEqual(await firstView(space, "p1"), GUARDED_FIRST, "its first script had the guards");
    assert.equal(await guardsIn(space, "p1"), true);
    await userGoesHome();
    await resumeByUser(space);
  } finally {
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});

test("a held secret step's tab the user unloads: the request observers go off with no task tab holding a browser, and its load when viewed again writes nothing to the HTTP cache", async () => {
  const space = await h.space("unload secret");
  let reader = null;
  try {
    await h.call("page.goto", { space, page: "p1", url: `${base}/?r=u3` });
    await h.call("spaces.handOff", { space, secret: true });
    // The user's step: a cacheable page, loaded only while the step is marked.
    await userLoads(space, "p1", `${base}/?r=u3-step`);
    await loadedAt(space, "p1", "r=u3-step");
    await userGoesHome();
    await userUnloads(space, "p1");
    // Gone with its browser: the observers of the user's own browsing go off (I4).
    await h.until(async () => !(await networkActive()), 5000).catch(() => {});
    assert.equal(await networkActive(), false, "the request observers stayed on for a browser that's gone");
    // Another task's page opens and closes meanwhile: the sets go out again.
    const other = await h.space("unload secret other");
    await h.call("page.goto", { space: other, page: "p1", url: `${base}/?r=u3-other` });
    await h.remove(other);
    const loads = hits.get("/?r=u3-step");
    await userViewsAgain(space, "p1", "u3-step");
    assert.equal(hits.get("/?r=u3-step"), loads + 1, "the premise: the hold kept the step's page out of the cache, so the view asked the server");
    assert.equal(await networkActive(), true, "the step's tab holds a browser again");
    await userGoesHome();
    // Another task's page on the same site reads what its cache has.
    reader = await h.space("unload secret reader");
    await h.call("page.goto", { space: reader, page: "p1", url: `${base}/?r=u3-reader` });
    assert.equal(await cachedFor(reader, "u3-step"), false, "the load after the unload was cached");
    await resumeByUser(space);
  } finally {
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
    if (reader) {
      await h.remove(reader).catch(() => {});
    }
  }
});

test("a held secret step's tab the user unloads: Resume blanks it, and the step's page never loads again", async () => {
  const space = await h.space("unload secret resume");
  try {
    await h.call("page.goto", { space, page: "p1", url: `${base}/?r=u4` });
    await h.call("spaces.handOff", { space, secret: true });
    await userLoads(space, "p1", `${base}/?r=u4-step`);
    await loadedAt(space, "p1", "r=u4-step");
    await userGoesHome();
    await userUnloads(space, "p1");
    const loads = hits.get("/?r=u4-step");
    await resumeByUser(space);
    const back = await h.call("spaces.takeOver", { space });
    assert.deepEqual(back.blanked ?? [], ["p1"]);
    assert.equal((await tabNow(space, "p1")).url, "about:blank");
    assert.equal(hits.get("/?r=u4-step"), loads, "the step's page never loaded again");
  } finally {
    await userGoesHome().catch(() => {});
    await h.remove(space).catch(() => {});
  }
});
