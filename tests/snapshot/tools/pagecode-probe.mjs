// Red-teaming the user's setting for agents' page code (the observe layer's
// observe/pagecode.sys.mjs): zenius.agentTabs.pageCode
// is "always" (the default), "ask" (only sites the user allowed, in
// zenius.agentTabs.pageCodeSites) or "never". Does each refusal hold where it
// should (page.evaluate, page.waitForFunction, the agent's own data: pages),
// and can an agent allow itself?
//
// Headless on the Linux server, loopback fixtures only (127.0.0.1 and 127.0.0.2 are two
// sites). This probe is both people: it sets the prefs as the user would in
// about:config (dev.evalChrome, which only a dev profile has: zenius.dev),
// and calls zenius as the agent. It puts both prefs back as it found them.
//
//   scripts/zen-dev.sh <name> start
//   ZENIUS_INSTANCE=<name> node tests/snapshot/tools/pagecode-probe.mjs > out.json

import { createServer } from "node:http";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const PORT_A = 47417;
const PORT_B = 47418;
const A = `http://127.0.0.1:${PORT_A}`;
const B = `http://127.0.0.2:${PORT_B}`;
const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body>${body}</body>`;
const PAGES = {
  "/": page("pc home", "<p>PAGECODE_HOME</p>"),
  // Goes to the other site after a second, on its own.
  "/leave": page("pc leave", `<p>leaving</p><script>setTimeout(() => { location.href = ${JSON.stringify(`${B}/`)}; }, 1000);</script>`),
};

function serve(host, port) {
  return new Promise((ok, fail) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      const body = PAGES[path];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "no");
    });
    server.once("error", fail);
    server.listen(port, host, () => ok(server));
  });
}

const { connect } = await import(join(here, "../../../scripts/lib/rpc.mjs"));
const instance = process.env.ZENIUS_INSTANCE;
if (!instance) {
  console.error("ZENIUS_INSTANCE is not set");
  process.exit(2);
}
const servers = [await serve("127.0.0.1", PORT_A), await serve("127.0.0.2", PORT_B)];
const client = await connect(instance, { callTimeout: 60000 });
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const chrome = (code, arg) => client.call("dev.evalChrome", { code, arg });
const outcome = p => p.then(r => ({ ok: true, value: r?.result ?? r?.value ?? r ?? null }), e => ({ code: e.code ?? null, message: String(e.message).slice(0, 220), data: e.data ?? undefined }));

// The user's about:config. mode: a string, false for a Boolean pref, null to clear.
const PREFS = `
  const set = (name, v) => {
    if (v === undefined) return;
    if (v === null) Services.prefs.clearUserPref(name);
    else if (typeof v === "boolean") { Services.prefs.clearUserPref(name); Services.prefs.setBoolPref(name, v); }
    else { Services.prefs.clearUserPref(name); Services.prefs.setStringPref(name, v); }
  };
  set("zenius.agentTabs.pageCode", arg.mode);
  set("zenius.agentTabs.pageCodeSites", arg.sites);
  return true;
`;
const setting = (mode, sites) => chrome(PREFS, { mode, sites });
const read = () =>
  chrome(`
    const v = name => { const t = Services.prefs.getPrefType(name); return t === Services.prefs.PREF_STRING ? Services.prefs.getStringPref(name) : t === Services.prefs.PREF_BOOL ? Services.prefs.getBoolPref(name) : t === Services.prefs.PREF_INVALID ? null : "type " + t; };
    return { mode: v("zenius.agentTabs.pageCode"), sites: v("zenius.agentTabs.pageCodeSites") };
  `);

const out = {};
const before = await read();
out.prefsBefore = before;
const { id: space } = await client.call("spaces.create", { name: `zs-pagecode-${Date.now().toString(36).slice(-5)}` });
const evaluate = (pg = "p1") => outcome(client.call("page.evaluate", { space, page: pg, fn: "() => document.title" }));
const waitFn = (pg = "p1", timeout = 3000) => outcome(client.call("page.waitForFunction", { space, page: pg, fn: "() => false", options: { timeout, polling: 200 } }));
const goto = (url, pg = "p1") => outcome(client.call("page.goto", { space, page: pg, url, options: {} }));
try {
  await client.call("page.goto", { space, page: "p1", url: `${A}/`, options: {} });

  step("always");
  await setting(null, null);
  out.always = { evaluate: await evaluate(), waitForFunction: await waitFn("p1", 600) };

  step("never");
  await setting("never", "http://127.0.0.1");
  out.never = {
    evaluate: await evaluate(),
    waitForFunction: await waitFn(),
    gotoSite: await goto(`${A}/`),
    gotoData: await goto("data:text/html,<title>own</title><p>own"),
    pagesNewData: await outcome(client.call("pages.new", { space, url: "data:text/html,<title>own2</title>" })),
  };
  // A data: page the agent loaded while page code ran, then reloaded under never.
  await setting(null, null);
  out.never.dataLoadedUnderAlways = await goto("data:text/html,<title>own3</title><p>own3");
  await setting("never", null);
  out.never.reloadData = await outcome(client.call("page.reload", { space, page: "p1", options: {} }));
  out.never.evaluateData = await evaluate();

  step("ask");
  await setting("ask", null);
  out.ask = { evaluateData: await evaluate() };
  await client.call("page.goto", { space, page: "p1", url: `${A}/`, options: {} });
  out.ask.evaluateUnlisted = await evaluate();
  out.ask.evaluateAgain = await evaluate();
  await setting(undefined, "http://127.0.0.1");
  out.ask.evaluateListed = await evaluate();
  await setting(undefined, "127.0.0.1");
  out.ask.evaluateBareHost = await evaluate();
  await setting(undefined, "http://127.0.0.1,http://127.0.0.1:47417, http://evil.example");
  out.ask.sitesWithPortAndOthers = await evaluate();
  out.ask.otherSite = (await goto(`${B}/`)).ok ? await evaluate() : "no load";
  out.ask.aboutBlank = await (async () => {
    const r = await outcome(client.call("pages.new", { space }));
    const label = r.value?.label ?? r.value?.page ?? null;
    return { opened: r.ok, label, evaluate: label ? await evaluate(label) : null };
  })();
  // A page that leaves for an unlisted site while the agent's wait polls it.
  await setting(undefined, "http://127.0.0.1");
  await client.call("page.goto", { space, page: "p1", url: `${A}/leave`, options: {} });
  const t0 = Date.now();
  out.ask.waitWhileLeaving = { ...(await waitFn("p1", 8000)), ms: Date.now() - t0 };
  // A pref of another type reads as ask (the SDK's find): a Boolean false.
  await setting(false, null);
  await client.call("page.goto", { space, page: "p1", url: `${A}/`, options: {} });
  out.ask.booleanPref = await evaluate();

  step("self");
  // Can the agent allow itself? Its loads of the settings pages, its keys in
  // the page (the input layer's, dispatched in the content process), and the
  // module's Allow with anything but the user's click.
  await setting("ask", null);
  out.self = {
    gotoAboutConfig: await goto("about:config"),
    gotoAboutPreferences: await goto("about:preferences"),
    gotoChrome: await goto("chrome://browser/content/browser.xhtml"),
  };
  const view0 = await client.call("dev.viewState");
  out.self.keys = [];
  for (const key of ["Control+l", "Alt+d", "F6"]) {
    out.self.keys.push(await outcome(client.call("page.keyboard", { space, page: "p1", action: "press", key, options: {} })).then(r => `${key}: ${r.ok ? "ok" : r.code}`));
  }
  out.self.typed = await outcome(client.call("page.keyboard", { space, page: "p1", action: "type", text: "about:config", options: {} })).then(r => r.ok || r.code);
  out.self.enter = await outcome(client.call("page.keyboard", { space, page: "p1", action: "press", key: "Enter", options: {} })).then(r => r.ok || r.code);
  // With the card asking (the input layer's change): the agent tabs through
  // the page and past its end, then presses Enter and Space. Does the
  // focus ever reach the card's Allow, and is anything written?
  await setting("ask", null);
  await client.call("page.goto", { space, page: "p1", url: `${A}/?card`, options: {} });
  out.self.cardAsk = await evaluate();
  const CARD = `
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const tab = ctx.resolvePage({ space: arg, page: "p1" }).tab;
    const card = N.noticeElement(tab, "zenius-pagecode:http://127.0.0.1");
    const fe = Services.focus.focusedElement;
    return { card: !!card, buttons: card ? [...card.querySelectorAll("button")].map(b => b.textContent) : null, chromeFocus: fe ? fe.localName + (fe.className ? "." + String(fe.className).split(" ")[0] : "") : null, focusOnCard: !!card && !!fe && card.contains(fe), sites: Services.prefs.getStringPref("zenius.agentTabs.pageCodeSites", "") };
  `;
  out.self.beforeTabs = await chrome(CARD, space).catch(e => "unread: " + e.message);
  const tabsOut = [];
  for (let i = 0; i < 25; i++) tabsOut.push(await outcome(client.call("page.keyboard", { space, page: "p1", action: "press", key: "Tab", options: {} })).then(r => r.ok));
  for (const key of ["Enter", " "]) tabsOut.push(await outcome(client.call("page.keyboard", { space, page: "p1", action: "press", key, options: {} })).then(r => r.ok));
  out.self.tabbedOut = { presses: tabsOut.length, ok: tabsOut.filter(Boolean).length };
  out.self.afterTabs = await chrome(CARD, space).catch(e => "unread: " + e.message);
  const view1 = await client.call("dev.viewState");
  out.self.viewSame = JSON.stringify(view0) === JSON.stringify(view1);
  out.self.aboutConfigTabs = await chrome(`return [...Services.wm.getEnumerator("navigator:browser")].flatMap(w => [...w.gBrowser.tabs]).filter(t => /^about:(config|preferences)/.test(t.linkedBrowser.currentURI.spec)).length;`);
  // The module's Allow, called by chrome code with a click it made: chrome
  // code's events are trusted, so this passes (and writes; restored below).
  // It shows only that the function trusts its caller: no agent or page can
  // call it (chrome code only; its one caller is the input layer's card).
  out.self.allowFromChromeCode = await chrome(`
    const m = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/pagecode.sys.mjs");
    const card = win.document.createElement("div");
    const button = win.document.createElement("button");
    card.append(button);
    const e = new win.MouseEvent("click", { bubbles: true });
    let result = null;
    button.addEventListener("click", ev => { result = m.allowPageCodeSite("http://127.0.0.2", ev, card); });
    button.dispatchEvent(e);
    return { returned: result, sites: Services.prefs.getStringPref("zenius.agentTabs.pageCodeSites", "") };
  `);
  // Every method zenius serves (each module's methods), and any whose name
  // suggests a setting.
  out.self.methods = await chrome(`
    const names = [];
    for (const mod of ["actions", "browser", "events", "io", "navigation", "observe", "pages", "snapshot", "spaces", "ui"]) {
      try { names.push(...Object.keys(ChromeUtils.importESModule("chrome://userscripts/content/zenius/methods/" + mod + ".sys.mjs").methods ?? {})); } catch {}
    }
    return { count: names.length, prefLike: names.filter(n => /pref|config|setting|allow|pagecode/i.test(n)) };
  `).catch(e => ({ error: e.message }));
  out.prefsAfterSelf = await read();
} finally {
  await chrome(PREFS, { mode: before.mode, sites: before.sites }).catch(() => {});
  out.prefsRestored = JSON.stringify(await read().catch(() => null)) === JSON.stringify(before);
  await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
  console.log(JSON.stringify(out, null, 1));
  client.close?.();
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
}
