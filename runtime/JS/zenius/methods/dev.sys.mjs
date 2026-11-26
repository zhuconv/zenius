// dev.* methods (the core). Registered only on a dev profile (readSettings in
// modules/util.sys.mjs): pref zenius.dev, which scripts/zen-dev.sh sets, in a
// profile under ~/.zenius-dev/profiles/. A daily profile never has them, even
// with the pref.

import { evalAsync, systemSandbox } from "chrome://userscripts/content/zenius/modules/sandbox.sys.mjs";
import { hostWindow, viewState } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Gate classes (SPI.md, "Dispatch"): access for the control gate (I3), i5
// for the web-content gate (I5).
export const access = {
  "dev.evalChrome": "none",
  "dev.evalContent": "none",
  "dev.stats": "none",
  "dev.viewState": "none",
  "dev.registry": "none",
  "dev.answerClaim": "none",
};

export const i5 = {
  "dev.evalChrome": "dev",
  "dev.evalContent": "dev",
  "dev.stats": "dev",
  "dev.viewState": "dev",
  "dev.registry": "dev",
  "dev.answerClaim": "dev",
};

export const methods = {
  /** Run chrome JS in the parent. Globals: the browser window's, plus ctx, service, win. */
  "dev.evalChrome": async (ctx, params) => {
    const win = hostWindow();
    const sb = systemSandbox(win, { ctx, service: ctx.service, win });
    return evalAsync(sb, String(params.code ?? ""), { arg: params.arg, filename: "zenius-dev-chrome" });
  },

  /**
   * Run JS in a page. By default it runs in the page's own world; with
   * privileged: true it runs as chrome in the content process, with `actor`
   * bound and the page's window (behind Xrays) as the global's prototype.
   */
  "dev.evalContent": async (ctx, params) => {
    const { browsingContext } = ctx.resolvePage(params);
    return ctx.content(
      browsingContext,
      "dev#evalContent",
      { code: String(params.code ?? ""), privileged: !!params.privileged, arg: params.arg },
      { timeout: params.timeout ?? 30000 }
    );
  },

  /** Per-method latency stats since startup (recent window). */
  "dev.stats": async ctx => ctx.service.stats(),

  /** What the user sees in every window, for I1 checks. */
  "dev.viewState": async () => viewState(),

  /**
   * Every registered method: its module, access and I5 class, and whether
   * its module declared each (the input layer's registry test).
   */
  "dev.registry": async ctx => ctx.service.registry(),

  /**
   * Answer a claim's prompt as the user would, for tests: the ask for
   * `space` (any ask, without `space`) gets `allow` (default true). Waits up
   * to `timeout` ms (default 15000) for one, so a test can send it with its
   * spaces.claim, on any connection. {verdict: null} when no ask came: the
   * claim needed none (the space became the agent's), or none was made.
   */
  "dev.answerClaim": async (ctx, params) => {
    const allow = params.allow ?? true;
    const timeout = params.timeout ?? 15000;
    const deadline = Date.now() + timeout;
    while (true) {
      const ask = ctx.spaces.pendingClaims().find(a => params.space === undefined || a.space === params.space);
      if (ask) {
        ctx.spaces.answerClaim(ask.id, allow === true);
        return { id: ask.id, space: ask.space, verdict: allow === true ? "allow" : "deny" };
      }
      if (params.space !== undefined) {
        const rec = ctx.spaces.peek(params.space);
        if (!rec || rec.gone || rec.ownership !== "user") {
          return { verdict: null };
        }
      }
      if (Date.now() >= deadline) {
        return { verdict: null, timedOut: true };
      }
      await new Promise(resolve => lazy.setTimeout(resolve, 50));
    }
  },
};
