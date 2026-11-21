// Shared setup for zen-core runtime tests. tests/core/run.sh starts a fresh
// headless dev Zen and sets ZENIUS_INSTANCE.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function setup() {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/core/run.sh");
  }
  const client = await connect(instance, { callTimeout: 30000 });
  const fixture = await startFixtureServer("zen-core");
  // I1: nothing a test file does may change what the user sees.
  const viewBefore = await client.call("dev.viewState");
  let n = 0;
  const h = {
    instance,
    client,
    base: fixture.baseUrl,
    call: (method, params) => h.client.call(method, params),
    /** Run chrome JS in the browser (expression or function body); see dev.evalChrome. */
    chrome: (code, arg) => h.client.call("dev.evalChrome", { code, arg }),
    unique: prefix => `${prefix} ${process.pid}-${++n}`,
    /** A new agent space; returns its id. */
    async space(prefix) {
      return (await h.client.call("spaces.create", { name: h.unique(prefix) })).id;
    },
    /**
     * spaces.claim, with the user's Allow on its prompt: dev.answerClaim goes
     * alongside, and answers nothing when the claim asks no one.
     */
    async claim(space, extra = {}) {
      const [claimed] = await Promise.all([
        h.client.call("spaces.claim", { space, ...extra }),
        h.client.call("dev.answerClaim", { space }),
      ]);
      return claimed;
    },
    /** A Space the user made, with one tab, never claimed; returns its id. close() removes it. */
    async userSpace(prefix, url = "about:blank") {
      const { id, uuid } = await h.chrome(
        `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
         const ws = await gZenWorkspaces.createAndSaveWorkspace(arg.name, undefined, true);
         const tab = W.addBackgroundTab(win, ws.uuid);
         // The user's own load, as the URL bar makes it (addBackgroundTab
         // only opens about:blank, I5).
         if (arg.url !== "about:blank") {
           tab.linkedBrowser.fixupAndLoadURIString(arg.url, {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
         }
         const end = Date.now() + 10000;
         while (tab.linkedBrowser.currentURI.spec !== arg.url && Date.now() < end) {
           await new Promise(r => win.setTimeout(r, 25));
         }
         ctx.spaces.refresh();
         return { id: ctx.spaces.peekUuid(ws.uuid).id, uuid: ws.uuid };`,
        { name: h.unique(prefix), url }
      );
      h.madeSpaces.add(uuid);
      return id;
    },
    /**
     * Zen Spaces a test made (by uuid), which close() removes with their
     * tabs if they're still there: a profile that's kept between runs, as
     * on the Mac, would collect them otherwise.
     */
    madeSpaces: new Set(),
    /** zen-ux's takeover prompt opening or closing, as ui/takeover.sys.mjs does it. */
    pause: (space, paused) => h.chrome("ctx.spaces.setPaused(ctx.spaces.get(arg.space), arg.paused)", { space, paused }),
    /** The user takes control in the page (prompt's "Take over"). */
    userTakesOver: space =>
      h.chrome(
        `const rec = ctx.spaces.get(arg);
         ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
         ctx.spaces.setPaused(rec, false);`,
        space
      ),
    async ownership(space) {
      return (await h.call("spaces.list")).taskSpaces.find(s => s.id === space)?.ownership ?? null;
    },
    /**
     * Quit the browser cleanly (it saves its session) and start it again,
     * with these prefs on top of the dev profile's (ZENIUS_DEV_PREFS).
     * The dev profile's browser.startup.page is 0: no tab comes back, so
     * neither does a task in the Agents Space. Pass 3 to keep them.
     * `beforeConnect` runs once Zen is ready, before the new connection
     * (whose opening loads the method modules).
     */
    async restart(prefs = {}, { beforeConnect } = {}) {
      const { execFileSync } = await import("node:child_process");
      const env = { ...process.env };
      let dir = null;
      if (Object.keys(prefs).length) {
        const { mkdtempSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        dir = mkdtempSync(join(tmpdir(), "zenius-prefs-"));
        env.ZENIUS_DEV_PREFS = join(dir, "prefs.js");
        const lines = Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
        writeFileSync(env.ZENIUS_DEV_PREFS, `${lines.join("\n")}\n`);
      }
      // zen-dev.sh says why a quit or start failed (a crash, a timeout, a
      // pid it won't touch) on its stdout and stderr: the error carries both.
      const zenDev = cmd => {
        try {
          execFileSync(process.env.ZENIUS_DEV, [instance, cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
        } catch (e) {
          throw new Error(
            `zen-dev.sh ${instance} ${cmd} failed (${e.status ?? e.signal ?? e.code}).\n` +
              `stdout:\n${e.stdout ?? ""}\nstderr:\n${e.stderr ?? ""}`,
            { cause: e }
          );
        }
      };
      try {
        h.client.close();
        zenDev("quit");
        zenDev("start");
      } finally {
        if (dir) {
          const { rmSync } = await import("node:fs");
          rmSync(dir, { recursive: true, force: true });
        }
      }
      await beforeConnect?.();
      h.client = await connect(instance, { callTimeout: 30000 });
      h.restarted = true;
    },
    /** The dev instance's log lines since its last start that match `re`. */
    instanceLog(re) {
      const file = join(homedir(), ".zenius-dev", "logs", `${instance}.log`);
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(line => re.test(line)) : [];
    },
    /** Delete a space whatever its state (test cleanup). */
    remove: space =>
      h.chrome(
        `const rec = ctx.spaces.peek(arg);
         if (rec && !rec.gone) { for (const t of ctx.pages.inventory(rec)) ctx.pages.closeTab(t.tab); ctx.spaces.remove(rec); }
         return true;`,
        space
      ),
    /** What the user sees: each window's selected tab, workspace and focus, plus the window count. */
    async view() {
      const state = await h.call("dev.viewState");
      state.windowCount = await h.chrome("[...Services.wm.getEnumerator(null)].length");
      return state;
    },
    /** I1: run `fn`, then check that the user's view is exactly as before. */
    async assertNoPreemption(fn) {
      const before = await h.view();
      const result = await fn();
      assert.deepEqual(await h.view(), before, "I1: the user's view changed");
      return result;
    },
    /**
     * A click the agent makes in its page: its own page.click. A click
     * synthesized in the content process looks like the user's to
     * zen-input's guard, which loads a clean copy of a page the agent's
     * code wrote before the user's press reaches it (zen-observe's glue).
     */
    agentClick: (space, page, selector) => h.call("page.click", { space, page, target: selector }),
    async until(fn, ms = 5000) {
      const end = Date.now() + ms;
      while (!(await fn())) {
        if (Date.now() > end) {
          throw new Error(`timed out waiting for ${fn}`);
        }
        await sleep(20);
      }
    },
    async close() {
      try {
        // A restart makes new windows and tabs, so there is nothing to compare.
        if (!h.restarted) {
          assert.deepEqual(await h.call("dev.viewState"), viewBefore, "I1: the user's view changed");
        }
      } finally {
        // After the I1 check: Zen moves a window off a Space it removes.
        // Even a Space a window shows, or one a failed test left.
        await h
          .chrome(
            `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
             const left = arg.filter(uuid => win.gZenWorkspaces.getWorkspaceFromId(uuid));
             for (const uuid of left) {
               for (const tab of W.tabsInWorkspace(uuid)) {
                 tab.ownerDocument.defaultView.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
               }
               // Synchronous apart from its promise, which a headless window may never settle.
               win.gZenWorkspaces.removeWorkspace(uuid);
             }
             ctx.spaces.refresh();
             if (!left.length) return true;
             // Saved, as zenius saves its Agents Space's removal: the run ends
             // with a kill (zen-dev.sh stop), which would bring them back from
             // Zen's own file. Zen drops them from each window's list a tick
             // later, and writes its file in the save.
             const sleep = ms => new Promise(r => win.setTimeout(r, ms));
             const listed = () =>
               W.workspaceWindows().some(w => w.gZenWorkspaces.getWorkspaces().some(ws => left.includes(ws.uuid)));
             for (const end = Date.now() + 10000; listed() && Date.now() < end; ) await sleep(50);
             const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
             await SessionSaver.run();
             const file = PathUtils.join(PathUtils.profileDir, "zen-sessions.jsonlz4");
             for (const end = Date.now() + 10000; Date.now() < end; await sleep(50)) {
               const data = await IOUtils.readJSON(file, { decompress: true }).catch(() => null);
               if (!(data?.spaces ?? []).some(s => left.includes(s.uuid))) break;
             }
             return true;`,
            [...h.madeSpaces]
          )
          .catch(e => console.error(`removing the Spaces the tests made: ${e.message}`));
        h.client.close();
        await closeFixtureServer(fixture.server);
      }
    },
  };
  return h;
}
