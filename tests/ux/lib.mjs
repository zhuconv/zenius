// Shared setup for the UI runtime tests. tests/ux/run.sh starts a headless
// dev Zen (a fresh profile on Linux, a kept one on the Mac) and sets
// ZENIUS_INSTANCE; the tests drive it over RPC and run chrome-side checks
// through dev.evalChrome.
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

/** A name as zenius shows it: in a first-strong isolate (ui/text.sys.mjs). */
export const iso = s => `\u2068${s}\u2069`;

/**
 * Chrome code that puts the window in the user's own Space, if it isn't
 * there: the first Space that's neither the Agents Space nor held by an
 * agent. Zen's empty tab follows the Space. Returns where it was, or null.
 */
const TO_USER_SPACE = `
  const zw = gZenWorkspaces;
  ctx.spaces.refresh?.();
  const name = uuid => zw.getWorkspaces().find(w => w.uuid === uuid)?.name ?? String(uuid);
  const theirs = ws => !ctx.service.spaces.isAgentsSpace?.(ws.uuid) && (ctx.spaces.peekUuid?.(ws.uuid)?.ownership ?? "user") === "user";
  const user = zw.getWorkspaces().find(theirs);
  if (!user) {
    throw new Error("tests/ux: this profile has no Space of the user's own to start in");
  }
  const from = zw.activeWorkspace;
  if (from === user.uuid) {
    return { from: null };
  }
  await zw.changeWorkspaceWithID(user.uuid);
  if (zw.activeWorkspace !== user.uuid) {
    throw new Error("tests/ux: the window stays in the Space " + name(zw.activeWorkspace) + ", not the user's " + user.name);
  }
  return { from: name(from), to: user.name };
`;

export async function setup() {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/ux/run.sh");
  }
  const client = await connect(instance);
  const fixture = await startFixtureServer("zen-ux");
  // Each file starts in the user's own Space. A kept profile (the Mac's)
  // comes back in the Space Zen showed when it last quit: after a quit in
  // the Agents Space it starts there, with the user's Space empty (79
  // failures in one Mac run, reproduced on the Linux server). The tests take
  // the view they find as the user's (dev.viewState), and Zen's switch to a
  // Space that's already active selects nothing, so every landOn-then-switch
  // would wait for a tab that never comes.
  const start = await client.call("dev.evalChrome", { code: TO_USER_SPACE });
  if (start?.from) {
    process.stderr.write(`tests/ux: the window started in the Space "${start.from}"; moved to the user's "${start.to}"\n`);
  }
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
      // The core's claim gate asks the user (the UI's prompt): the test
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
      // The Mac keeps its profile, and the run's end kills Zen (zen-dev.sh's
      // stop) before Firefox saves its prefs on its own. A pref a suite's
      // after() set back would be lost, and the next run would start with
      // the test's value: panel.test.mjs's systemNotification, on the eval harness's
      // kept profile.
      await h.chrome("Services.prefs.savePrefFile(null); return true;").catch(() => {});
      client.close();
      await closeFixtureServer(fixture.server);
    },
  };
  return h;
}

/**
 * The longest wait between frames (ms) at which the cursor's move animation
 * still ends within the move's grace (cursor.sys.mjs: its duration plus
 * 120 ms; a start and an end can each wait a frame). A throttled Mac (the eval harness's
 * background-priority run with the screen locked) paints far more seldom, so a
 * move there may resolve before its animation ends: `animated` is false by
 * design.
 */
export const SMOOTH_FRAME_MS = 50;

// The page's side of untilTakesInput, privileged, so that its callbacks are
// no code left in the page: refresh ticks from now, then the time since the
// document began loading, on the clock performance.now() reads.
const TAKES_INPUT_CODE = `const win = actor.contentWindow;
  const t = win.performance.timing;
  const loading = t.domLoading ? t.domLoading - t.navigationStart : 0;
  for (let i = 0; i <= arg.ticks; i++) {
    await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
  }
  for (let left; (left = loading + arg.ms + 20 - win.performance.now()) > 0; ) {
    await new Promise(resolve => win.setTimeout(resolve, Math.ceil(left)));
  }
  return true;`;

/**
 * Chrome-side code for dev.evalChrome: `await untilTakesInput(browser)` waits
 * until the page `browser` shows takes a person's input. Gecko ignores the
 * user's input aimed at a document until the document has had
 * dom.input_events.security.minNumTicks refresh ticks and minTimeElapsedInMS
 * since it began loading, against clickjacking. zenius's own events are
 * exempt, but a test's user input enters through the parent as the OS's
 * would, so a click sent sooner is lost, as a person's would be: most often
 * right after a load the test set off, such as a task's finish or Stop
 * loading the pages the agent wrote afresh. A person would click again; a
 * test waits instead, so that every click it sends must take. The page must
 * be shown, since a hidden one has no refresh ticks.
 */
export const UNTIL_TAKES_INPUT = `
  const untilTakesInput = browser =>
    ctx.content(browser.browsingContext, "dev#evalContent", {
      privileged: true,
      code: ${JSON.stringify(TAKES_INPUT_CODE)},
      arg: {
        ticks: Services.prefs.getIntPref("dom.input_events.security.minNumTicks", 0),
        ms: Services.prefs.getIntPref("dom.input_events.security.minTimeElapsedInMS", 0),
      },
    });
`;

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
    // fn's value, and the longest wait between this window's frames while it
    // ran, its end included: how smoothly the window painted meanwhile.
    const withFrames = async fn => {
      const start = win.performance.now();
      let last = null;
      let gap = 0;
      let on = true;
      const tick = t => {
        if (on) {
          gap = Math.max(gap, t - (last ?? start));
          last = t;
          win.requestAnimationFrame(tick);
        }
      };
      win.requestAnimationFrame(tick);
      try {
        const value = await fn();
        return { value, gap: Math.round(Math.max(gap, win.performance.now() - (last ?? start))) };
      } finally {
        on = false;
      }
    };
  `;
}
