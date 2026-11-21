// Shared setup for zen-ux runtime tests. tests/ux/run.sh starts a fresh
// headless dev Zen and sets ZENIUS_INSTANCE; the tests drive it over RPC and
// run chrome-side checks through dev.evalChrome.
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

/** A name as zenius shows it: in a first-strong isolate (ui/text.sys.mjs). */
export const iso = s => `\u2068${s}\u2069`;

export async function setup() {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/ux/run.sh");
  }
  const client = await connect(instance);
  const fixture = await startFixtureServer("zen-ux");
  /** @type {number[]} */
  const created = [];
  const h = {
    client,
    base: fixture.baseUrl,
    call: (method, params) => client.call(method, params),
    /** Run chrome JS (a function body) in the browser; see dev.evalChrome. */
    chrome: code => client.call("dev.evalChrome", { code }),
    /** spaces.create (same params): a task in the Agents Space, which close() ends. */
    async createSpace(params) {
      const r = await client.call("spaces.create", params);
      created.push(r.id);
      return r;
    },
    /**
     * A Space the user made, in the background, with one tab of theirs: no
     * agent holds it. Returns its record's id; close() removes it.
     *
     * @param {string} name
     * @returns {Promise<number>}
     */
    async userSpace(name) {
      const id = await client.call("dev.evalChrome", {
        code: `
          const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
          const ws = await gZenWorkspaces.createAndSaveWorkspace(arg.name, undefined, true);
          W.addBackgroundTab(win, ws.uuid);
          ctx.spaces.refresh();
          return ctx.spaces.peekUuid(ws.uuid).id;
        `,
        arg: { name },
      });
      created.push(id);
      return id;
    },
    /**
     * A Space of the task's own: a Space the user made, with one tab of
     * theirs, that the agent claimed, plus an agent page. The tasks an agent
     * creates share the Agents Space; a claimed Space keeps its own Zen
     * workspace, badge and name. close() removes it.
     *
     * @param {string} name
     * @returns {Promise<{id: number, page: string}>}
     */
    async claimedSpace(name) {
      const id = await h.userSpace(name);
      const claim = client.call("spaces.claim", { space: id });
      let settled = false;
      claim.then(
        () => (settled = true),
        () => (settled = true)
      );
      // zen-core's claim gate asks the user (zen-ux's prompt): the test
      // plays their Allow, a click on the prompt's own button.
      while (!settled) {
        const allowed = await client.call("dev.evalChrome", {
          code: `
            const ask = ctx.service.spaces.pendingClaims?.().find(a => a.space === arg);
            const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
            const el = ask && N.noticeElement(gBrowser.selectedTab, "zenius-claim:" + ask.id);
            if (!el) return false;
            await new Promise(r => win.setTimeout(r, 450));
            [...el.querySelectorAll("button")].find(b => b.textContent === "Allow").click();
            return true;
          `,
          arg: id,
        });
        if (allowed) {
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      await claim;
      const { label } = await client.call("pages.new", { space: id });
      return { id, page: label };
    },
    /** @param {{keep?: number[]}} [opts]  Spaces to leave as they are */
    async close({ keep = [] } = {}) {
      // The Mac keeps its test profile between runs: don't let tasks and
      // Spaces pile up. A task ends, closing its tabs; a Space of its own
      // goes too, unless the user is in it.
      for (const id of created.filter(id => !keep.includes(id))) {
        await client.call("spaces.finish", { space: id, keep: [] }).catch(() => {});
        await h
          .chrome(`
            const rec = ctx.spaces.peek(${id});
            if (!rec || rec.gone) return;
            if (rec.kind === "task") {
              // Ended or stopped earlier: its tabs are left.
              for (const t of ctx.service.pages.tabsOf(rec)) if (t !== gBrowser.selectedTab) gBrowser.removeTab(t, { animate: false });
            } else if (!ctx.service.spaces.isAgentsSpace?.(rec.uuid) && rec.uuid !== gZenWorkspaces.activeWorkspace) {
              await gZenWorkspaces.removeWorkspace(rec.uuid);
            }
          `)
          .catch(() => {});
      }
      client.close();
      await closeFixtureServer(fixture.server);
    },
  };
  return h;
}

/** Chrome-side helpers prepended to dev.evalChrome code. */
export function prelude(space, page = "p1") {
  return `
    const C = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/cursor.sys.mjs");
    const B = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/badges.sys.mjs");
    const { tab, browser, space: rec } = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(page)} });
    const sleep = ms => new Promise(r => win.setTimeout(r, ms));
    const until = async (fn, ms = 3000) => {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) throw new Error("timed out waiting for " + fn);
        await sleep(25);
      }
    };
  `;
}
