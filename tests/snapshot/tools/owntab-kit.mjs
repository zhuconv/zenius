// The shared kit for the own-tab probes (owntab-probe.mjs,
// bypass-probe.mjs). It provides:
// - an RPC client to a dev Zen;
// - the loopback fixture sites (owntab-site.mjs);
// - the user's side of a handoff (the pill, the own tab, Hand back), played
//   through zenius's real UI.
import { connect } from "../../../scripts/lib/rpc.mjs";
import { caught, startServer } from "./owntab-site.mjs";

/** Chrome-side helpers that every dev.evalChrome call of the kit starts with. */
export const PRE = `
  const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
  const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
  const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
  const AC = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/agentcode.sys.mjs");
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(await fn())) { if (Date.now() > end) throw new Error("timed out waiting for " + fn); await sleep(25); }
  };
  const all = () => [...W.allTabs()];
  const ownTabs = () => all().filter(t => ctx.service.pages.isUserOwn(t));
  const pillOn = t => N.noticeElement(t, "zenius-control");
  const pillInfo = t => {
    const el = t && pillOn(t);
    return el ? { note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: [...el.querySelectorAll("button")].map(b => b.textContent) } : null;
  };
  // label: one label, or several, any of which will do (a button renamed in a newer build).
  const press = async (el, label) => {
    await sleep(450);
    const labels = [].concat(label);
    const b = [...(el?.querySelectorAll("button") ?? [])].find(b => labels.includes(b.textContent));
    if (!b) throw new Error("no " + labels.join(" or ") + " button");
    b.click();
  };
  const inContent = (t, code, privileged = false) => ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code, privileged });
  const loaded = t => t.linkedBrowser.currentURI.spec !== "about:blank" && !t.linkedBrowser.webProgress?.isLoadingDocument;
  // Gecko keeps a page in the bfcache only if its load group is idle when it
  // is left, so a bfcache probe waits for the load event to end first.
  const loadEnded = t => until(async () => (await inContent(t, "return (performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0) > 0")) === true, 8000);
  const taskTabs = id => ctx.service.pages.tabsOf(ctx.spaces.peek(id));
  // Any copy of any of the task's tabs, in any window, that carries the pill.
  const pillTab = id => {
    const mine = taskTabs(id);
    const ids = new Set(mine.map(t => t.id).filter(Boolean));
    return mine.find(t => pillOn(t)) ?? all().find(t => ids.has(t.id) && pillOn(t)) ?? null;
  };
  // Each document of the page: where it is, its site, and whether the task's
  // record has that site. An opaque document goes by its precursor, if any.
  const docsOf = (browser, rec) => browser.browsingContext.getAllBrowsingContextsInSubtree().map(bc => {
    const wg = bc.currentWindowGlobal;
    const p = wg?.documentPrincipal;
    return {
      name: bc.parent ? bc.name || "frame" : "top",
      url: (wg?.documentURI?.spec ?? "").slice(0, 48),
      site: p ? (p.isNullPrincipal ? "opaque" : p.siteOriginNoSuffix) : null,
      precursor: p?.isNullPrincipal ? p.precursorPrincipal?.siteOriginNoSuffix ?? null : undefined,
      recorded: p ? AC.agentCodeOnSite(rec, p) : null,
    };
  });
  // The user types into every password field the tab shows, frames included.
  const typeEverywhere = async (t, value) => {
    let typed = 0;
    for (const bc of t.linkedBrowser.browsingContext.getAllBrowsingContextsInSubtree()) {
      try {
        typed += await ctx.content(bc, "dev#evalContent", {
          code: "const p = document.getElementById('pw'); if (!p) return 0; p.value = arg; return 1;",
          privileged: true,
          arg: value,
        });
      } catch {}
    }
    return typed;
  };
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Connects to the dev Zen (ZENIUS_INSTANCE, else the snapshot layer) and starts the
 * fixture sites: A at 127.0.0.1, B at 127.0.0.2.
 */
export async function openKit() {
  const client = await connect(process.env.ZENIUS_INSTANCE ?? "zen-snapshot");
  const call = (method, params) => client.call(method, params);
  const chrome = (code, arg) => client.call("dev.evalChrome", { code: PRE + code, arg });
  const B = await startServer("127.0.0.2");
  const A = await startServer("127.0.0.1", B.base);
  const ev = (space, page, fn) => call("page.evaluate", { space, page, fn, isFunction: true });

  /** The handed page's pill, and the user's own tab if the pill offers one and `open`. */
  async function pillAndOwnTab(space, open = true) {
    return chrome(
      `
      await until(() => pillTab(arg.space), 5000).catch(() => {});
      const t = pillTab(arg.space);
      const pill = pillInfo(t);
      let own = null;
      if (arg.open && pill?.buttons.includes("Use your own tab")) {
        const rec = ctx.spaces.peek(arg.space);
        Pages.landOn(t);
        await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
        await until(() => gBrowser.selectedTab === t);
        const before = new Set(ownTabs());
        await press(pillOn(t), "Use your own tab");
        await until(() => ownTabs().some(x => !before.has(x)));
        own = ownTabs().find(x => !before.has(x));
        await until(() => loaded(own), 10000);
        win.__own = own;
      }
      return {
        pill,
        url: t?.linkedBrowser.currentURI.spec ?? null,
        own: own && { url: own.linkedBrowser.currentURI.spec, container: own.userContextId, ws: own.getAttribute("zen-workspace-id") },
      };
    `,
      { space, open }
    );
  }

  /**
   * The user resumes the agent: Resume agent on the pill (the UI's change;
   * Hand back before it, on the own tab's notice, while there was one).
   */
  async function handBack(space) {
    return chrome(
      `
      const rec = ctx.spaces.peek(arg.space);
      const own = win.__own?.isConnected ? N.noticeElement(win.__own, "zenius-own-tab") : null;
      await press(own ?? pillOn(pillTab(arg.space)), ["Resume agent", "Hand back"]);
      await until(() => rec.ownership === "agent");
      return true;
    `,
      { space }
    );
  }

  function cleanTabs() {
    return chrome(`
      for (const t of ownTabs()) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
      for (const t of all()) {
        const u = t.linkedBrowser?.currentURI?.spec ?? "";
        if (/^(http:\\/\\/127\\.0\\.0\\.[12]|blob:|data:)/.test(u) && !ctx.service.lookup(t)) t.ownerDocument.defaultView.gBrowser.removeTab(t, { animate: false });
      }
      delete win.__own;
      // Service workers, caches and storage of both fixture origins.
      for (const host of ["127.0.0.1", "127.0.0.2"]) {
        await new Promise(r => {
          try { Services.clearData.deleteDataFromHost(host, true, Ci.nsIClearDataService.CLEAR_ALL, r); }
          catch { Services.clearData.deleteDataFromSite(host, {}, true, Ci.nsIClearDataService.CLEAR_ALL, r); }
        });
      }
      return true;
    `);
  }

  async function cleanUp(spaces) {
    for (const space of spaces) {
      await call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    await cleanTabs().catch(e => console.error("cleanUp failed:", e.message));
  }

  async function newTask(name, url = `${A.base}/login`) {
    const { id } = await call("spaces.create", { name: `${name} ${Date.now().toString(36).slice(-4)}` });
    await call("page.goto", { space: id, page: "p1", url });
    return id;
  }

  function close() {
    client.close();
    A.server.close();
    B.server.close();
  }

  return { client, call, chrome, ev, A, B, sleep, caught, pillAndOwnTab, handBack, cleanTabs, cleanUp, newTask, close };
}

/** Runs the named probes in order and prints their results as JSON. */
export async function runProbes(probes, names, kit) {
  const results = {};
  try {
    for (const name of names) {
      const t0 = Date.now();
      try {
        if (!probes[name]) throw new Error(`no probe ${name}; probes: ${Object.keys(probes).join(" ")}`);
        results[name] = await probes[name]();
      } catch (e) {
        results[name] = { error: String(e?.message ?? e), code: e?.code, data: e?.data };
      }
      results[name].ms = Date.now() - t0;
    }
  } finally {
    console.log(JSON.stringify(results, null, 1));
    kit.close();
  }
  return results;
}
