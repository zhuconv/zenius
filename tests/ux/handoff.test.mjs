// The hand-off and the user's Take over, made safe by zenius itself (the
// user's direction and correction, 2026-11-20). The user always types in
// the agent's own tab:
// - zen-core reloads a page with evidence of danger before the hold
//   begins, at a hand-off and at Take over (service.userTakeOver);
// - a page that loaded afresh for the hold (the agent's hand-off, the
//   user's Take over) or at the user's press (their first press or key in a
//   page with evidence: zen-input's typing hook, zen-core's cleanOnDemand)
//   says so, since a form there may be back at its defaults (the Cloudflare
//   token form, 2026-11-21; zen-input's form tests found the hand-off's);
// - a Take over whose reload fails brings today's prompt back;
// - on a page the agent made itself, the card says it might contain
//   malicious code;
// - the card says that Resume agent clears secret fields once the user typed
//   one (zen-input's onSecretTyped), or always without that event;
// - Resume agent first reloads each page where the user typed a secret
//   and the agent's code or its own page is evidence of danger (zen-input's
//   typedSecrets, zen-core's cleanLoad, zen-observe's evidenceOf), and tells
//   zen-core;
// - a page on a phishing or malware list, or that the agent flagged, warns
//   the user while they're on it, and nothing reloads for it;
//   zen-core's own ways back (spaces.takeOver, spaces.claim) run the same
//   step through service.beforeHandBack;
// - a tab that joins the task during the hold says it's the agent's.
// zen-core's and zen-input's parts are stand-ins here; their suites test
// them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

const CLEARS = "Resume agent clears password, card and code fields, so submit what you type there first.";
const inControl = () => ({ notice: `You're in control · the agent waits until you resume it on ${site()}`, note: CLEARS, more: null, buttons: ["Resume agent"] });
// A page the agent made itself, which no website served.
const MADE_NOTE = "The agent made this page. It might contain malicious code. Keep sensitive information out.";
// A page that loaded afresh at the user's press.
const RELOADED_NOTE = "A form here may be back to its defaults: check it before you submit.";
const RELOADED_MORE = "It reloaded without the agent's changes.";
// A hand-off whose step shows the user a secret (zen-core's secret flag).
const SECRET_NOTE = "Resume agent clears this page, so copy what you need from it first.";
let h;

/** The site the hold cards name: the fixture's host, isolated as the card's texts are. */
const site = () => iso(new URL(h.base).hostname);
let space;
let name;
let P;
let userView;
const run = Date.now().toString(36).slice(-5);

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  name = `zen-ux hand-off ${run}`;
  ({ id: space } = await h.createSpace({ name }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  P = `${prelude(space)}
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const UI = UIM.ZeniusUI;
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    // The Resume line shows always unless a test turns zen-input's event on.
    win.__zuJustInTime ??= UI.secretLineJustInTime;
    UI.secretLineJustInTime = false;
    win.__zuStart ??= gBrowser.selectedTab;
    const pillOn = t => N.noticeElement(t, "zenius-control");
    const pill = () => pillOn(tab);
    const buttonsOf = el => [...(el?.querySelectorAll("button") ?? [])].map(b => b.textContent);
    // The small text as shown, and what waits behind its '?'.
    const card = d => ({ notice: d.controlNotice, note: d.controlNote, more: d.controlMore, buttons: d.controlButtons });
    // The notice on a page that loaded afresh at the user's press: its text,
    // its line and what waits behind the line's '?', and its buttons.
    const reloadedCard = (t = tab) => {
      const el = N.noticeElement(t, "zenius-reloaded");
      const note = el?.querySelector(".zenius-card-note");
      return el
        ? {
            text: N.noticeText(t, "zenius-reloaded"),
            note: note ? [...note.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim() : null,
            more: el.querySelector(".zenius-card-note-more")?.textContent ?? null,
            buttons: buttonsOf(el),
          }
        : null;
    };
    // The user's click, once the pill has armed (it ignores clicks for 400 ms).
    const press = async (el, label) => {
      await sleep(450);
      const b = [...(el?.querySelectorAll("button") ?? [])].find(b => b.textContent === label);
      if (!b) throw new Error("no " + label + " button, only " + buttonsOf(el).join("|"));
      b.click();
    };
    const showTask = async (t = tab) => {
      Pages.landOn(t);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === t);
    };
    const backToUser = async () => {
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
      await until(() => gZenWorkspaces.activeWorkspace === userWs);
    };
    // What zen-core's spaces.handOff does, with the flags its spaceChanged
    // carries when it reloaded the page first.
    const withEvent = (extra, fn) => {
      const emit = ctx.spaces.onEvent;
      ctx.spaces.onEvent = (n, p) => emit(n, n === "spaceChanged" && p.ownership === "agentDelegatedToUser" ? { ...p, ...extra } : p);
      try {
        return fn();
      } finally {
        ctx.spaces.onEvent = emit;
      }
    };
    // pages: the labels zen-core notes as loaded afresh for the hold (the
    // page handed off, when it reloaded, and others).
    const handOff = (text, extra = {}, pages = extra.reloaded ? ["p1"] : []) =>
      withEvent(extra, () => {
        ctx.spaces.setStateText(rec, text);
        ctx.spaces.noteReloaded(rec, pages);
        ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { source: "agent" });
      });
    // zen-core's userTakeOver, standing in: a reload of the page, then the
    // hold, with the flags its spaceChanged carries; in a task the user
    // holds already, the reload alone. what: "reload", "none" or "fail".
    // refusal: zen-core's ZenError for "fail" ({code, reason, message, data}).
    const takeOverAs = (what, refusal = {}) => {
      const seen = [];
      ctx.service.userTakeOver = async (r, b) => {
        const t = gBrowser.getTabForBrowser(b);
        seen.push({ notice: N.noticeText(t, "zenius-control"), prompt: N.noticeText(t, "zenius-takeover"), paused: !!r.paused, ownership: r.ownership });
        if (what === "fail") {
          throw Object.assign(new Error(refusal.message ?? "The page didn't load afresh (timed out)."), {
            code: refusal.code ?? "ZEN_HANDOFF_REFUSED",
            data: { page: "p1", reason: refusal.reason ?? "reloadFailed", ...refusal.data },
          });
        }
        if (what === "reload") {
          const doc = b.browsingContext.currentWindowGlobal.innerWindowId;
          b.reload();
          await until(() => b.browsingContext.currentWindowGlobal?.innerWindowId !== doc && !b.webProgress.isLoadingDocument);
        }
        const flags = what === "reload" ? { reloaded: "reload", carried: true } : {};
        if (r.ownership === "agent") {
          withEvent(flags, () => ctx.spaces.setOwnership(r, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" }));
        }
        return { agentPage: false, reloaded: what === "reload" ? ["p1"] : [], how: flags.reloaded ?? null, carried: !!flags.carried, openerCut: false };
      };
      return seen;
    };
    // Stand-ins for zen-observe's record of the agent's own pages: any
    // document counts with fn(rec, principal); null restores the real ones.
    const MADE = /^(?:about:(?:blank|srcdoc)(?:[?#]|$)|data:|blob:)/i;
    const codeOn = fn => {
      UI.agentCodeOnSite = fn;
      UI.agentCodeInPage = fn && ((r, b) => b.browsingContext.getAllBrowsingContextsInSubtree().some(bc => !!bc.currentWindowGlobal?.documentPrincipal && fn(r, bc.currentWindowGlobal.documentPrincipal)));
      UI.agentMadePage =
        fn &&
        ((r, b) => {
          const wg = b.browsingContext.currentWindowGlobal;
          const p = wg?.documentPrincipal;
          return !!p && MADE.test(wg.documentURI?.spec ?? "") && ((p.isNullPrincipal && !p.precursorPrincipal) || fn(r, p));
        });
    };
    // A page's own script, as the site's would run (or the user's clicks).
    const inPage = (b, code) => ctx.content(b.browsingContext, "dev#evalContent", { code });
    const heard = [];
    const announcer = win.document.getElementById("a11y-announcement");
    const ear = new win.MutationObserver(() => {
      const said = announcer.firstChild?.getAttribute("aria-label");
      if (said) heard.push(said);
    });
    ear.observe(announcer, { childList: true, subtree: true, attributes: true });
    const cleanUp = async () => {
      ear.disconnect();
      N.removeNotice(tab, "zenius-reloaded");
      N.removeNotice(tab, "zenius-page-warning");
      codeOn(null);
      delete ctx.service.userTakeOver;
      delete ctx.service.noteReloaded;
      UI.typedSecrets = null;
      UI.cleanLoad = null;
      UI.evidenceOf = null;
      UI.secretLineJustInTime = false;
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      ctx.spaces.setPaused(rec, false);
      ctx.spaces.setStateText(rec, "");
      ctx.spaces.clearHandBackNotes(rec);
      await backToUser();
      if (win.__zuStart?.isConnected) gBrowser.selectedTab = win.__zuStart;
    };
  `;
});

after(async () => {
  await h?.chrome(`${P} await cleanUp(); UI.secretLineJustInTime = win.__zuJustInTime; delete win.__zuJustInTime; delete win.__zuStart;`).catch(() => {});
  await h?.close();
});

test("a hand-off with no reload: Agent needs you, with the task, Resume agent, the line that Resume clears secret fields, and the agent's own words behind the '?'", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const said = card(UI.describe(rec));
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill());
      handOff("");
      await until(() => pill());
      return { said, silent: card(UI.describe(rec)), reloaded: reloadedCard() };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.said, { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: CLEARS, more: `The agent says: “${iso("Log in to continue")}”.`, buttons: ["Resume agent"] });
  assert.deepEqual(out.silent, { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: CLEARS, more: null, buttons: ["Resume agent"] });
  assert.equal(out.reloaded, null, "nothing of a reload");
});

test("a hold that ends before its announcement goes out isn't heard: the user's Resume right after the hand-off, or the agent's finish while the user holds the task; one that lasts is heard once (on a Mac, one test's hold was heard in the next)", async () => {
  // A task of its own, to finish.
  const { id: own } = await h.createSpace({ name: `zen-ux brief hold ${run}` });
  await h.call("page.goto", { space: own, page: "p1", url: `${h.base}/` });
  try {
    const out = await h.chrome(`${P}
      const { finishTask } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/methods/spaces.sys.mjs");
      const other = ctx.resolvePage({ space: ${own}, page: "p1" }).space;
      try {
        await showTask();
        await UIM.announcementsOut(win);
        heard.length = 0;
        // Nothing awaits in between: each hold ends within ANNOUNCE_MS.
        handOff("Log in to continue");
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
        ctx.spaces.setStateText(other, "Approve the payment");
        ctx.spaces.setOwnership(other, "agentDelegatedToUser", { source: "agent" });
        const held = !!N.noticeElement(ctx.resolvePage({ space: ${own}, page: "p1" }).tab, "zenius-control");
        finishTask(ctx, other, []);
        await UIM.announcementsOut(win);
        const brief = heard.slice();
        handOff("Log in to continue");
        await UIM.announcementsOut(win);
        return { held, brief, lasting: heard.slice(brief.length) };
      } finally {
        await cleanUp();
      }
    `);
    assert.equal(out.held, true, "the other task's hold began, with its card");
    assert.deepEqual(out.brief, [], "neither brief hold is heard");
    assert.deepEqual(out.lasting, [`Agent needs you in ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”.`]);
  } finally {
    await h.call("spaces.finish", { space: own, keep: [] }).catch(() => {});
  }
});

test("a hand-off whose step shows the user a secret (zen-core's secret flag, on spaceChanged): the card leads with what Resume agent does to the page, the agent's words behind the '?', and it's heard so; the tasks panel's row says it under Resume agent; a hand-off without it, a Take over, and the agent's run again say nothing of it", async () => {
  const out = await h.chrome(`${P}
    const row = () => UI.tasks().find(r => r.id === rec.id) ?? null;
    try {
      await showTask();
      heard.length = 0;
      handOff("Copy the new token", { secret: true });
      await until(() => pill());
      await UIM.announcementsOut(win);
      const res = { secret: { card: card(UI.describe(rec)), heard: heard.slice(), row: row()?.clears ?? null } };
      // The agent's words change while it waits: the line stays.
      ctx.spaces.setStateText(rec, "Copy the new token, then resume me");
      await until(() => card(UI.describe(rec)).more?.includes("then resume me"));
      res.updated = card(UI.describe(rec));
      // Handed back: gone with the hold.
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill());
      res.back = row()?.clears ?? null;
      // The next hand-off doesn't say it.
      handOff("Log in to continue");
      await until(() => pill());
      res.plain = { card: card(UI.describe(rec)), row: row()?.clears ?? null };
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill());
      // Nor does a hold the user began, whatever its event carries.
      withEvent({ secret: true }, () => ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" }));
      await until(() => pill());
      res.takeOver = card(UI.describe(rec)).note;
      return res;
    } finally {
      await cleanUp();
    }
  `);
  const words = text => `The agent says: “${iso(text)}”.`;
  assert.deepEqual(out.secret, {
    card: { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: SECRET_NOTE, more: words("Copy the new token"), buttons: ["Resume agent"] },
    heard: [`Agent needs you in ${iso(name)}, on ${site()}. ${SECRET_NOTE} ${words("Copy the new token")}`],
    row: "Resume agent clears the page the agent handed you, so copy what you need from it first.",
  });
  assert.deepEqual(out.updated, { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: SECRET_NOTE, more: words("Copy the new token, then resume me"), buttons: ["Resume agent"] });
  assert.equal(out.back, null);
  assert.deepEqual(out.plain, { card: { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: CLEARS, more: words("Log in to continue"), buttons: ["Resume agent"] }, row: "Resume agent clears password, card and code fields, so submit what you type there first." });
  assert.equal(out.takeOver, CLEARS);
});

test("the hold card names the site the user is on, after the task, and follows the page's top document when it moves to another site on its own (a sign-in's redirect)", async () => {
  // Another site on the same server: localhost isn't 127.0.0.1's site.
  const elsewhere = h.base.replace("127.0.0.1", "localhost");
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const read = () => ({
        notice: UI.describe(rec).controlNotice,
        site: pill().querySelector(".zenius-card-site")?.textContent ?? null,
        label: pill().getAttribute("aria-label"),
      });
      const first = read();
      // The page moves on its own, as a SAML post or an SSO redirect does.
      const doc = browser.browsingContext.currentWindowGlobal.innerWindowId;
      browser.loadURI(Services.io.newURI(${JSON.stringify(`${elsewhere}/api/text?signin`)}), {
        triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(${JSON.stringify(h.base)}), {}),
      });
      await until(() => browser.browsingContext.currentWindowGlobal?.innerWindowId !== doc && pill()?.querySelector(".zenius-card-site")?.textContent !== first.site, 8000);
      const moved = read();
      return { first, moved, ownership: rec.ownership };
    } finally {
      await cleanUp();
    }
  `);
  // Back on the fixture's site, for the tests after this one.
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  const at = iso(new URL(elsewhere).hostname);
  assert.deepEqual(out.first, {
    notice: `Agent needs you · ${iso(name)} on ${site()}`,
    site: site(),
    label: `Agent needs you, ${iso(name)}, on ${site()}. Resume agent clears password, card and code fields, so submit what you type there first. The agent says: “${iso("Log in to continue")}”.`,
  });
  assert.deepEqual(out.moved, {
    notice: `Agent needs you · ${iso(name)} on ${at}`,
    site: at,
    label: `Agent needs you, ${iso(name)}, on ${at}. Resume agent clears password, card and code fields, so submit what you type there first. The agent says: “${iso("Log in to continue")}”.`,
  });
  assert.equal(out.ownership, "agentDelegatedToUser", "the user still holds the task");
});

test("the hold card's site is the page's registrable domain as Firefox's address bar shows it, and none for a page without a site", async () => {
  const out = await h.chrome(`
    const UIM = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const at = url => {
      try {
        return UIM.heldSite({ currentURI: Services.io.newURI(url) });
      } catch (e) {
        return "throws: " + e;
      }
    };
    return {
      subdomain: at("https://accounts.google.com/signin?continue=1"),
      lookalike: at("https://accounts.google.com.evil.co/"),
      ip: at("http://127.0.0.1:8080/"),
      oneLabel: at("http://localhost:3000/"),
      idn: at("https://xn--bcher-kva.de/"),
      data: at("data:text/html,x"),
      about: at("about:blank"),
      blob: at("blob:https://example.com/0c6f1d2e-0000-4000-8000-000000000000"),
      file: at("file:///tmp/x.html"),
      noPage: UIM.heldSite(null),
    };
  `);
  assert.deepEqual(out, {
    subdomain: iso("google.com"),
    lookalike: iso("evil.co"),
    ip: iso("127.0.0.1"),
    oneLabel: iso("localhost"),
    idn: iso("bücher.de"),
    data: null,
    about: null,
    blob: null,
    file: null,
    noPage: null,
  });
});

test("a hand-off zen-core reloaded first says so on the page, as Take over does, since a form there may be back at its defaults though it looks filled in (zen-input's form tests): the hold's card, then the reload's, each heard", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      heard.length = 0;
      handOff("Log in to continue", { reloaded: "get", carried: true });
      await until(() => pill() && reloadedCard());
      await UIM.announcementsOut(win);
      return { card: card(UI.describe(rec)), reloaded: reloadedCard(), heard: heard.join(" ") };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.card, { notice: `Agent needs you · ${iso(name)} on ${site()}`, note: CLEARS, more: `The agent says: “${iso("Log in to continue")}”.`, buttons: ["Resume agent"] });
  assert.deepEqual(out.reloaded, { text: "This page reloaded", note: RELOADED_NOTE, more: RELOADED_MORE, buttons: ["Dismiss"] });
  assert.equal(out.heard, `Agent needs you in ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”. This page reloaded. ${RELOADED_NOTE} ${RELOADED_MORE}`);
});

test("a hand-off that loaded another page of the task afresh, by zen-core's label, says so on that page, and not on a page that didn't reload", async () => {
  const { label } = await h.call("pages.new", { space });
  await h.call("page.goto", { space, page: label, url: `${h.base}/` });
  try {
    const out = await h.chrome(`${P}
      const other = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(label)} });
      try {
        handOff("Sign in", {}, [${JSON.stringify(label)}]);
        await until(() => reloadedCard(other.tab));
        return { other: reloadedCard(other.tab), p1: reloadedCard(tab) };
      } finally {
        N.removeNotice(other.tab, "zenius-reloaded");
        N.removeNotice(other.tab, "zenius-control");
        await cleanUp();
      }
    `);
    assert.deepEqual(out.other, { text: "This page reloaded", note: RELOADED_NOTE, more: RELOADED_MORE, buttons: ["Dismiss"] });
    assert.equal(out.p1, null, "a page that didn't reload says nothing of one");
  } finally {
    await h.call("page.close", { space, page: label }).catch(() => {});
    // p1 is the task's page again, where the agent acted last, as the other
    // tests expect its cards.
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  }
});

test("end to end, on zen-core's real hand-off: the agent's code left a field in the page (zen-observe's hooked), so the hand-off loads it afresh first, and the page says it reloaded, and why, from the hold's evidence", async () => {
  // A task of its own: the evidence and the hold start clean.
  const { id: own } = await h.createSpace({ name: `zen-ux hand-off reload ${run}` });
  await h.call("page.goto", { space: own, page: "p1", url: `${h.base}/zoo/forms.html` });
  const Q = `${prelude(own)}
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const EV = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/evidence.sys.mjs");
    const doc = () => browser.browsingContext.currentWindowGlobal?.innerWindowId ?? null;
  `;
  try {
    await h.call("page.evaluate", { space: own, page: "p1", fn: "() => { document.body.insertAdjacentHTML('beforeend', '<input id=zenius-agent-field>'); return true; }", isFunction: true });
    const before = await h.chrome(`${Q} await until(() => EV.evidenceOf(browser).hooked, 5000); return { doc: doc(), hooked: EV.evidenceOf(browser).hooked ?? null };`);
    assert.ok(before.hooked, "zen-observe's world flagged the page hooked");
    const handed = await h.call("spaces.handOff", { space: own });
    assert.equal(handed.ownership, "agentDelegatedToUser");
    assert.deepEqual(handed.reloaded, ["p1"], "the hand-off loaded the page afresh");
    const out = await h.chrome(`${Q}
      await until(() => N.noticeElement(tab, "zenius-control") && N.noticeElement(tab, "zenius-reloaded"), 5000);
      const el = N.noticeElement(tab, "zenius-reloaded");
      const note = el.querySelector(".zenius-card-note");
      return {
        fresh: doc() !== ${before.doc},
        field: await ctx.content(browser.browsingContext, "dev#evalContent", { code: "return !!document.getElementById('zenius-agent-field');" }),
        pill: N.noticeText(tab, "zenius-control"),
        reloaded: {
          text: N.noticeText(tab, "zenius-reloaded"),
          note: [...note.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim(),
          more: el.querySelector(".zenius-card-note-more")?.textContent ?? null,
        },
      };
    `);
    assert.deepEqual(out, {
      fresh: true,
      field: false,
      pill: `Agent needs you · ${iso(`zen-ux hand-off reload ${run}`)} on ${site()}`,
      // zen-core's hold says why, by the page's label (spaceChanged's evidence).
      reloaded: { text: "This page reloaded · the agent's code had changed it", note: RELOADED_NOTE, more: `${RELOADED_MORE} What its code left: ${iso(before.hooked)}.` },
    });
  } finally {
    await h.chrome(`${Q} N.removeNotice(tab, "zenius-reloaded"); if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" }); return true;`).catch(() => {});
    await h.call("spaces.finish", { space: own, keep: [] }).catch(() => {});
  }
});

test("Take over goes through zen-core's userTakeOver: the agent stays paused while the page reloads; then You're in control, unannounced, and the page says it reloaded, since a form may be back at its defaults; a Take over with no reload says nothing of one", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      const seen = takeOverAs("reload");
      heard.length = 0;
      await UI.takeOverByUser(rec);
      await until(() => rec.ownership === "agentDelegatedToUser" && pill());
      await UIM.announcementsOut(win);
      const res = { seen, after: card(UI.describe(rec)), paused: !!rec.paused, reloaded: reloadedCard(), heard: heard.slice() };
      N.removeNotice(tab, "zenius-reloaded");
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill() && !rec.paused);
      takeOverAs("none");
      await UI.takeOverByUser(rec);
      await until(() => rec.ownership === "agentDelegatedToUser" && pill());
      res.noReload = reloadedCard();
      return res;
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.seen, [{ notice: null, prompt: null, paused: true, ownership: "agent" }]);
  assert.deepEqual(out.after, inControl());
  assert.equal(out.paused, false, "the pause lifts once the hold begins");
  assert.deepEqual(out.reloaded, { text: "This page reloaded", note: RELOADED_NOTE, more: RELOADED_MORE, buttons: ["Dismiss"] });
  assert.deepEqual(out.heard, [`This page reloaded. ${RELOADED_NOTE} ${RELOADED_MORE}`], "the hold itself is their own choice: only the reload is heard");
  assert.equal(out.noReload, null);
});

test("zen-input's typing hook changes nothing in who holds the task: zen-core reloads the page itself; a reload that doesn't come brings a card with Reload, which tries again, and the card goes with the next document", async () => {
  const out = await h.chrome(`${P}
    const offCard = () => {
      const el = N.noticeElement(tab, "zenius-typing-off");
      return el ? { text: N.noticeText(tab, "zenius-typing-off"), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: buttonsOf(el) } : null;
    };
    try {
      await showTask();
      const before = { ownership: rec.ownership, paused: !!rec.paused, prompt: N.noticeText(tab, "zenius-takeover"), pill: !!pill() };
      const came = await UI.userTyping({ browser, trigger: "key", reloaded: Promise.resolve({ how: "reload" }) });
      const quiet = offCard();
      const none = UI.userTyping({ browser, trigger: "key" });
      const missed = await UI.userTyping({ browser, trigger: "press", reloaded: Promise.reject(new Error("no new document")) });
      const after = { ownership: rec.ownership, paused: !!rec.paused, prompt: N.noticeText(tab, "zenius-takeover"), pill: !!pill() };
      const card = offCard();
      // Reload: zen-core's clean load again; the card stays up while it tries.
      const calls = [];
      UI.cleanLoad = async b => {
        calls.push(b === browser);
        b.reload();
        return { how: "reload" };
      };
      const doc = browser.browsingContext.currentWindowGlobal.innerWindowId;
      await press(N.noticeElement(tab, "zenius-typing-off"), "Reload");
      await until(() => browser.browsingContext.currentWindowGlobal?.innerWindowId !== doc && !offCard());
      return { came, quiet, none, missed, same: JSON.stringify(after) === JSON.stringify(before), after, card, calls };
    } finally {
      N.removeNotice(tab, "zenius-typing-off");
      await cleanUp();
    }
  `);
  assert.deepEqual(
    { ...out, after: undefined, card: undefined },
    { came: true, quiet: null, none: null, missed: false, same: true, after: undefined, card: undefined, calls: [true] }
  );
  assert.deepEqual(out.after, { ownership: "agent", paused: false, prompt: null, pill: false });
  assert.deepEqual(out.card, { text: "This page couldn't reload", note: "Clicks and typing here stay off until it does.", buttons: ["Reload", "Dismiss"] });
});

test("a quiet reload whose new document came in with evidence too (zen-core's stillEvident: a popup or other window on the site holds the agent's code): the card and what's heard give the way out, since Reload alone can't help", async () => {
  const out = await h.chrome(`${P}
    const offCard = () => {
      const el = N.noticeElement(tab, "zenius-typing-off");
      return el ? { text: N.noticeText(tab, "zenius-typing-off"), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: buttonsOf(el) } : null;
    };
    try {
      await showTask();
      heard.length = 0;
      const still = Object.assign(new Error("the clean copy came in with evidence too"), { stillEvident: true });
      const missed = await UI.userTyping({ browser, trigger: "key", reloaded: Promise.reject(still) });
      await UIM.announcementsOut(win);
      return { missed, card: offCard(), heard: heard.slice() };
    } finally {
      N.removeNotice(tab, "zenius-typing-off");
      await cleanUp();
    }
  `);
  const note = "Clicks and typing here stay off. Close the popup or other window on this site, then reload.";
  assert.equal(out.missed, false);
  assert.deepEqual(out.card, { text: "This page couldn't reload", note, buttons: ["Reload", "Dismiss"] });
  assert.deepEqual(out.heard, [`This page couldn't reload. ${note}`]);
});

test("a Take over that loaded another page of the task afresh, by zen-core's label (a form page that a popup the agent acted in last could reach), says so on that page, and not on the page taken over when it didn't reload itself", async () => {
  const { label } = await h.call("pages.new", { space });
  await h.call("page.goto", { space, page: label, url: `${h.base}/` });
  try {
    const out = await h.chrome(`${P}
      const other = ctx.resolvePage({ space: ${space}, page: ${JSON.stringify(label)} });
      let taken = null;
      let reloaded = null;
      try {
        await showTask();
        // zen-core's userTakeOver, standing in: the page taken over holds
        // as it is; the task's other page loads afresh, named by its label.
        ctx.service.userTakeOver = async (r, b) => {
          const mine = b === other.browser;
          taken = mine ? other.tab : tab;
          reloaded = mine ? { browser, tab, label: "p1" } : { browser: other.browser, tab: other.tab, label: ${JSON.stringify(label)} };
          const doc = reloaded.browser.browsingContext.currentWindowGlobal.innerWindowId;
          reloaded.browser.reload();
          await until(() => reloaded.browser.browsingContext.currentWindowGlobal?.innerWindowId !== doc && !reloaded.browser.webProgress.isLoadingDocument);
          ctx.spaces.setOwnership(r, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
          return { agentPage: false, how: null, reloaded: [reloaded.label], carried: false, openerCut: false };
        };
        await UI.takeOverByUser(rec);
        await until(() => rec.ownership === "agentDelegatedToUser" && pillOn(taken));
        await until(() => reloadedCard(reloaded.tab));
        return { reloaded: reloadedCard(reloaded.tab), taken: reloadedCard(taken) };
      } finally {
        if (reloaded) N.removeNotice(reloaded.tab, "zenius-reloaded");
        N.removeNotice(other.tab, "zenius-control");
        await cleanUp();
      }
    `);
    assert.deepEqual(out.reloaded, { text: "This page reloaded", note: RELOADED_NOTE, more: RELOADED_MORE, buttons: ["Dismiss"] });
    assert.equal(out.taken, null, "the page taken over held as it was");
  } finally {
    await h.call("page.close", { space, page: label }).catch(() => {});
    // p1 is the task's page again, where the agent acted last, as the other
    // tests expect its cards.
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  }
});

// The user's pass on defenses (2026-11-21): a page reloads only on evidence
// of danger, and the notice says which (zen-core's results carry what they
// acted on: cleanOnDemand's evidence, holdForUser's by label). Only the
// agent's code (hooked) and its own page (made) reload: a listed or flagged
// page gets its warning instead, so those two never say why a page
// reloaded.
test("the reload notice says why the page reloaded: the agent's code changed it, with what it left, or the agent made it; a list or the agent's flag isn't why; at the user's press, from zen-core's result or the hook's own read; at Take over and the agent's hand-off, by the page's label", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      const res = {};
      const at = async (evidence, extra = {}) => {
        N.removeNotice(tab, "zenius-reloaded");
        await UI.userTyping({ browser, trigger: "press", field: false, reloaded: Promise.resolve({ how: "get", ...(evidence ? { evidence } : {}) }), ...extra });
        return reloadedCard();
      };
      UI.evidenceOf = () => ({});
      res.hooked = await at({ hooked: "a script element" });
      res.made = await at({ made: "" });
      res.listed = await at({ listed: "goog-phish-proto" });
      res.flagged = await at({ flagged: "it asks for the user's bank login" });
      res.both = await at({ listed: "goog-malware-proto", flagged: "it asks for a code", hooked: "a form" });
      res.none = await at({});
      // A result without evidence: what the page had as the hook ran.
      UI.evidenceOf = b => (b === browser ? { hooked: "an on* attribute" } : {});
      res.ownRead = await at(null);
      UI.evidenceOf = () => ({});
      N.removeNotice(tab, "zenius-reloaded");
      // Take over: holdForUser's evidence, by label.
      const seen = takeOverAs("reload");
      const take = ctx.service.userTakeOver;
      ctx.service.userTakeOver = async (r, b) => ({ ...(await take(r, b)), evidence: { p1: { hooked: "a script element" } } });
      await UI.takeOverByUser(rec);
      await until(() => reloadedCard());
      res.takeOver = reloadedCard();
      // The agent's hand-off: its spaceChanged's evidence, by label.
      N.removeNotice(tab, "zenius-reloaded");
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      ctx.spaces.clearHandBackNotes(rec);
      await until(() => !pill());
      handOff("Sign in", { reloaded: "get", evidence: { p1: { hooked: "an inline handler (onfocus)" } } });
      await until(() => reloadedCard());
      res.handOff = reloadedCard();
      return res;
    } finally {
      await cleanUp();
    }
  `);
  const card = (text, more = RELOADED_MORE) => ({ text, note: RELOADED_NOTE, more, buttons: ["Dismiss"] });
  const lost = "Your click didn't go through · the page reloaded, as ";
  assert.deepEqual(out.hooked, card(`${lost}the agent's code had changed it`, `${RELOADED_MORE} What its code left: ${iso("a script element")}.`));
  assert.deepEqual(out.made, card(`${lost}the agent made it`));
  assert.deepEqual(out.listed, card("Your click didn't go through · the page reloaded"));
  assert.deepEqual(out.flagged, card("Your click didn't go through · the page reloaded"));
  assert.deepEqual(out.both, card(`${lost}the agent's code had changed it`, `${RELOADED_MORE} What its code left: ${iso("a form")}.`), "what a clean copy clears");
  assert.deepEqual(out.none, card("Your click didn't go through · the page reloaded"));
  assert.deepEqual(out.ownRead, card(`${lost}the agent's code had changed it`, `${RELOADED_MORE} What its code left: ${iso("an on* attribute")}.`));
  assert.deepEqual(out.takeOver, card("This page reloaded · the agent's code had changed it", `${RELOADED_MORE} What its code left: ${iso("a script element")}.`));
  assert.deepEqual(out.handOff, card("This page reloaded · the agent's code had changed it", `${RELOADED_MORE} What its code left: ${iso("an inline handler (onfocus)")}.`));
});

test("a clean copy at the user's press says so on the page: their click didn't go through, the page reloaded, and a form may be back at its defaults; it offers no choice and takes no focus, a screen reader hears it, and it goes with its ✕ or the tab's next document; a press on a field or a key says only that the page reloaded; one with nothing to clean, or that didn't come, says none of it", async () => {
  const out = await h.chrome(`${P}
    const focusNow = () => ({ el: Services.focus.focusedElement, inCard: !!N.noticeElement(tab, "zenius-reloaded")?.contains(win.document.activeElement) });
    try {
      await showTask();
      browser.focus();
      const before = focusNow();
      heard.length = 0;
      const res = {};
      res.came = await UI.userTyping({ browser, trigger: "press", field: false, reloaded: Promise.resolve({ how: "get", carried: true, focused: false }) });
      await UIM.announcementsOut(win);
      const focus = focusNow();
      res.press = { card: reloadedCard(), heard: heard.slice(), focusKept: focus.el === before.el, inCard: focus.inCard };
      res.hold = { ownership: rec.ownership, paused: !!rec.paused, prompt: N.noticeText(tab, "zenius-takeover"), pill: !!pill() };
      // The tab's next document takes it away.
      const doc = browser.browsingContext.currentWindowGlobal.innerWindowId;
      browser.reload();
      await until(() => browser.browsingContext.currentWindowGlobal?.innerWindowId !== doc && !browser.webProgress.isLoadingDocument);
      await until(() => !reloadedCard());
      // A press on a field, whose focus comes back, and a key, which zen-input replays.
      await UI.userTyping({ browser, trigger: "press", field: true, reloaded: Promise.resolve({ how: "reload" }) });
      res.onField = reloadedCard();
      N.removeNotice(tab, "zenius-reloaded");
      await UI.userTyping({ browser, trigger: "key", field: true, reloaded: Promise.resolve({ how: "reload" }) });
      res.key = reloadedCard();
      // Its ✕.
      await press(N.noticeElement(tab, "zenius-reloaded"), "Dismiss");
      await until(() => !reloadedCard());
      // Nothing to clean, and no new document.
      await UI.userTyping({ browser, trigger: "press", field: false, reloaded: Promise.resolve({ how: null, carried: false, focused: false }) });
      res.nothing = reloadedCard();
      res.missed = await UI.userTyping({ browser, trigger: "press", field: false, reloaded: Promise.reject(new Error("no new document")) });
      res.failed = { reloaded: reloadedCard(), off: !!N.noticeElement(tab, "zenius-typing-off") };
      return res;
    } finally {
      N.removeNotice(tab, "zenius-typing-off");
      await cleanUp();
    }
  `);
  const reloaded = { text: "This page reloaded", note: RELOADED_NOTE, more: RELOADED_MORE, buttons: ["Dismiss"] };
  assert.equal(out.came, true);
  assert.deepEqual(out.press, {
    card: { ...reloaded, text: "Your click didn't go through · the page reloaded" },
    heard: [`Your click didn't go through: the page reloaded. ${RELOADED_NOTE} ${RELOADED_MORE}`],
    focusKept: true,
    inCard: false,
  });
  assert.deepEqual(out.hold, { ownership: "agent", paused: false, prompt: null, pill: false }, "it only informs: who holds the task stays as it was");
  assert.deepEqual(out.onField, reloaded);
  assert.deepEqual(out.key, reloaded);
  assert.equal(out.nothing, null, "nothing to clean: no reload, no notice");
  assert.equal(out.missed, false);
  assert.deepEqual(out.failed, { reloaded: null, off: true }, "a reload that didn't come has its own card");
});

test("the Resume line comes just in time: once the user typed into a password, card or code field of the task (zen-input's onSecretTyped), it leads the card then up or the next, the agent's words behind the '?'; it goes once the agent runs again", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      UI.secretLineJustInTime = true;
      handOff("Log in to continue");
      await until(() => pill());
      const row = () => UI.tasks().find(r => r.id === rec.id)?.clears ?? null;
      const small = () => ({ note: UI.describe(rec).controlNote, more: UI.describe(rec).controlMore, row: row() });
      const res = { before: small() };
      UI.secretTyped({ browser });
      await until(() => UI.describe(rec).controlMore);
      res.typed = small();
      // Resume agent: the agent runs again, and the line goes with it.
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill());
      handOff("Log in to continue");
      await until(() => pill());
      res.next = small();
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill());
      // Typed while the agent's prompt was up: the hold that follows says it.
      UI.secretTyped({ browser });
      handOff("Log in to continue");
      await until(() => pill());
      res.early = small();
      return res;
    } finally {
      await cleanUp();
    }
  `);
  const said = `The agent says: “${iso("Log in to continue")}”.`;
  // The panel row's Resume agent clears them too: its line comes with the card's.
  assert.deepEqual(out, {
    before: { note: said, more: null, row: null },
    typed: { note: CLEARS, more: said, row: CLEARS },
    next: { note: said, more: null, row: null },
    early: { note: CLEARS, more: said, row: CLEARS },
  });
});

test("the panel's Pause: once the user typed a secret meanwhile, the row says its Resume clears such fields, under the button; Resume reloads that page first, as it has evidence of danger, and the line goes", async () => {
  const out = await h.chrome(`${P}
    const row = () => UI.tasks().find(r => r.id === rec.id) ?? null;
    const calls = [];
    UI.evidenceOf = b => (b === browser ? { hooked: "a script element" } : {});
    try {
      await showTask();
      UI.secretLineJustInTime = true;
      UI.pauseByUser(rec);
      const res = { paused: row()?.clears ?? null };
      UI.typedSecrets = async () => [browser];
      UI.cleanLoad = async b => {
        calls.push(b === browser);
        return { how: "reload" };
      };
      UI.secretTyped({ browser });
      res.typed = row()?.clears ?? null;
      // As the panel draws it: under the row's buttons, as their description.
      const strip = win.document.getElementById("zenius-agents-strip");
      const panelEl = () => win.document.getElementById("zenius-tasks-panel");
      strip?.click();
      try {
        await until(() => panelEl()?.state === "open");
        const rowEl = panelEl().querySelector('.zenius-task[data-space="' + rec.id + '"]');
        const line = rowEl?.querySelector(":scope > .zenius-task-clears");
        const box = rowEl?.querySelector(":scope > .zenius-task-actions");
        res.drawn = {
          text: line?.textContent ?? null,
          under: !!line && line.getBoundingClientRect().top >= box.getBoundingClientRect().bottom - 0.5,
          resume: [...box.querySelectorAll("button")].find(b => b.dataset.action === "resume")?.textContent ?? null,
        };
      } finally {
        if (panelEl()?.state === "open") {
          panelEl().hidePopup();
          await until(() => panelEl().state === "closed");
        }
      }
      await UI.resumeByUser(rec);
      await until(() => !rec.paused);
      res.resumed = row()?.clears ?? null;
      res.calls = calls;
      return res;
    } finally {
      await cleanUp();
    }
  `);
  const line = "Resume clears password, card and code fields, so submit what you type there first.";
  assert.deepEqual(out, {
    paused: null,
    typed: line,
    drawn: { text: line, under: true, resume: "Resume" },
    resumed: null,
    calls: [true],
  });
});

// Listed and flagged pages: the danger there is the page itself, which a
// clean copy can't remove (a listed copy is marked again, a flagged one
// loses its flag). So they get no hold and no clean copy, only a warning
// while the user is on the page, which informs: no choice, no focus.
test("a page on a phishing or malware list, or that the agent flagged, warns the user while they're on it: in the hold, as the mark comes, and on a page no task drives, in its words; not while the agent drives it, nor for the agent's code alone; no choice but its ✕, which keeps it away for that document; no focus; heard once", async () => {
  const out = await h.chrome(`${P}
    const warning = (t = tab) => {
      const el = N.noticeElement(t, "zenius-page-warning");
      const note = el?.querySelector(".zenius-card-note");
      return el
        ? {
            text: N.noticeText(t, "zenius-page-warning"),
            note: note ? [...note.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim() : null,
            more: el.querySelector(".zenius-card-note-more")?.textContent ?? null,
            buttons: buttonsOf(el),
          }
        : null;
    };
    const doc = b => b.browsingContext.currentWindowGlobal.innerWindowId;
    // zen-observe's onEvident, as it fires: once per document and reason.
    const marked = (b, reason, detail = "") => UI.evidenceAdded({ browser: b, innerWindowId: doc(b), reason, detail });
    let mine = null;
    try {
      await showTask();
      const res = {};
      const marks = new Map();
      UI.evidenceOf = b => marks.get(b) ?? {};
      // The agent flags the page as it drives it: nothing shows yet.
      marks.set(browser, { flagged: "it asks for a seed phrase" });
      marked(browser, "flagged", "it asks for a seed phrase");
      res.driving = warning();
      // The hand-off: the user is on it now.
      heard.length = 0;
      const focused = document.activeElement;
      handOff("Log in to continue");
      await until(() => pill() && warning());
      res.held = warning();
      res.focus = document.activeElement === focused && !N.noticeElement(tab, "zenius-page-warning").contains(document.activeElement);
      // Another mark on the page changes nothing shown, and isn't heard again.
      marks.set(browser, { flagged: "it asks for a seed phrase", hooked: "a script element" });
      marked(browser, "hooked", "a script element");
      await UIM.announcementsOut(win);
      res.heard = heard.join(" ");
      // Resume agent: the agent drives it again.
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      res.resumed = warning();
      // On the list too: the next hold says that first, the flag behind the '?'.
      marks.set(browser, { listed: "goog-phish-proto", flagged: "it asks for a seed phrase" });
      handOff("Log in to continue");
      await until(() => pill() && warning());
      res.both = warning();
      // Its ✕: gone for this document, whatever mark comes next.
      await press(N.noticeElement(tab, "zenius-page-warning"), "Dismiss");
      res.dismissed = warning();
      marked(browser, "listed", "goog-phish-proto");
      res.stillDismissed = warning();
      // A new document starts clean, and its list mark brings the warning back.
      marks.delete(browser);
      const was = doc(browser);
      browser.reload();
      await until(() => doc(browser) !== was && !browser.webProgress.isLoadingDocument);
      res.newDoc = warning();
      marks.set(browser, { listed: "goog-malware-proto" });
      marked(browser, "listed", "goog-malware-proto");
      res.listed = warning();
      // The agent's code or its own page alone: the hold and the clean copy cover those.
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      marks.set(browser, { hooked: "a script element", made: "" });
      handOff("Log in to continue");
      await until(() => pill());
      marked(browser, "made");
      res.hooked = warning();
      // A page no task drives, in the user's own Space, as the mark comes.
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await backToUser();
      mine = gBrowser.addTab("about:blank", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      await until(() => mine.linkedBrowser.browsingContext?.currentWindowGlobal);
      // Its words are the agent's: one line, at most 200 characters.
      marks.set(mine.linkedBrowser, { flagged: "a lookalike\\nof the bank's sign-in " + "x".repeat(300) });
      marked(mine.linkedBrowser, "flagged");
      res.mine = warning(mine);
      return res;
    } finally {
      if (mine) gBrowser.removeTab(mine);
      await cleanUp();
    }
  `);
  const note = "Be careful what you enter here.";
  assert.equal(out.driving, null, "not while the agent drives it");
  assert.deepEqual(out.held, { text: `The agent flagged this page · ${iso("it asks for a seed phrase")}`, note, more: null, buttons: ["Dismiss"] });
  assert.equal(out.focus, true, "it takes no focus");
  assert.equal(out.heard.split(`The agent flagged this page: ${iso("it asks for a seed phrase")}. ${note}`).length, 2, `heard once, in ${JSON.stringify(out.heard)}`);
  assert.equal(out.resumed, null, "the agent has the page back");
  assert.deepEqual(out.both, { text: "This page is on a phishing or malware list", note, more: `The agent flagged it too: ${iso("it asks for a seed phrase")}.`, buttons: ["Dismiss"] });
  assert.equal(out.dismissed, null);
  assert.equal(out.stillDismissed, null, "dismissed for that document");
  assert.equal(out.newDoc, null, "a new document starts clean");
  assert.deepEqual(out.listed, { text: "This page is on a phishing or malware list", note, more: null, buttons: ["Dismiss"] });
  assert.equal(out.hooked, null, "the agent's code or its own page alone");
  assert.deepEqual(out.mine, { text: `The agent flagged this page · ${iso(`a lookalike of the bank's sign-in ${"x".repeat(166)}`)}`, note, more: null, buttons: ["Dismiss"] });
});

test("a Take over that couldn't begin says why on its page, in a line, with what still works: Try again tries again, Stop task stops, Resume agent resumes; the agent stays paused until the user picks; when loading the page afresh would leave its site, there's no Try again", async () => {
  const out = await h.chrome(`${P}
    const refused = () => N.noticeElement(tab, "zenius-takeover-refused");
    // note: the line and, behind its '?', the rest, as the note's element holds them.
    // badge: the task's state in its badge and the strip; events: the taskBadge
    // states the agent sidebar's directory hears.
    const events = [];
    const off = ctx.service.addEventListener((e, p) => e === "taskBadge" && p.space === rec.id && events.push(p.state));
    const look = () => ({ text: N.noticeText(tab, "zenius-takeover-refused"), note: refused()?.querySelector(".zenius-card-note")?.textContent ?? null, buttons: buttonsOf(refused()), prompt: !!N.noticeElement(tab, "zenius-takeover"), control: !!pill(), ownership: rec.ownership, paused: !!rec.paused, badge: UI.badgeFor(rec)?.state ?? null });
    try {
      await showTask();
      const res = {};
      // The page didn't load afresh in time: Try again, and this time it does.
      takeOverAs("fail", { reason: "reloadFailed" });
      await UI.takeOverByUser(rec);
      await until(() => refused());
      await sleep(300);
      res.timedOut = look();
      const seen = takeOverAs("reload");
      await press(refused(), "Try again");
      await until(() => rec.ownership === "agentDelegatedToUser" && pill());
      res.retried = { seen: seen.length, card: card(UI.describe(rec)), refused: !!refused() };
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !pill() && !rec.paused);
      // Off the site: no Try again; Resume agent resumes.
      takeOverAs("fail", { reason: "reloadFailed", message: "The page didn't load afresh (it would have gone to https://other.example/, on another site, so zenius stopped that load).", data: { offSite: "https://other.example/" } });
      await UI.takeOverByUser(rec);
      await until(() => refused());
      res.offSite = look();
      await press(refused(), "Resume agent");
      await until(() => !rec.paused && !refused());
      res.resumed = look();
      // Another of the task's tabs can reach it: Stop task stops.
      takeOverAs("fail", { reason: "reachable" });
      await UI.takeOverByUser(rec);
      await until(() => refused());
      res.reachable = look();
      await press(refused(), "Stop task");
      await until(() => rec.ownership === "user" && !refused());
      res.stopped = look();
      res.events = events.includes("needs-user");
      return res;
    } finally {
      off();
      await cleanUp();
    }
  `);
  const closed = { text: null, note: null, buttons: [], prompt: false, control: false };
  assert.deepEqual(out.timedOut, { text: "Can't take over this page", note: "The page didn't load afresh in time.", buttons: ["Try again", "Stop task", "Resume agent"], prompt: false, control: false, ownership: "agent", paused: true, badge: "needs-user" });
  assert.deepEqual(out.retried, { seen: 1, card: inControl(), refused: false });
  assert.deepEqual(out.offSite, { text: "Can't take over this page", note: "Loading it afresh would take you to another site. zenius stopped that load. Stop task ends the task, and the page is yours.", buttons: ["Stop task", "Resume agent"], prompt: false, control: false, ownership: "agent", paused: true, badge: "needs-user" });
  assert.deepEqual(out.resumed, { ...closed, ownership: "agent", paused: false, badge: out.resumed.badge === "working" ? "working" : "idle" });
  assert.deepEqual(out.reachable, { text: "Can't take over this page", note: "Another of the task's tabs on this site can still reach it. Close the task's other tabs on this site, then try again.", buttons: ["Try again", "Stop task", "Resume agent"], prompt: false, control: false, ownership: "agent", paused: true, badge: "needs-user" });
  assert.deepEqual(out.stopped, { ...closed, ownership: "user", paused: false, badge: null });
  assert.equal(out.events, true, "the agent sidebar heard the task needs the user (taskBadge)");
});

test("Resume agent first reloads each page with evidence of danger where the user typed a secret, through zen-core's cleanLoad, tells zen-core, then hands back", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const order = [];
      UI.evidenceOf = b => (b === browser ? { hooked: "a script element" } : {});
      UI.typedSecrets = async (service, r) => (r.id === rec.id ? [browser] : []);
      UI.cleanLoad = async b => {
        order.push("cleanLoad " + (b === browser));
        return { how: "get", newGroup: false };
      };
      ctx.service.noteReloaded = (r, bs) => order.push("noteReloaded " + bs.length + " " + (bs[0] === browser));
      const off = ctx.service.addEventListener((event, params) => {
        if (event === "spaceChanged" && params?.space === rec.id && params.ownership === "agent") order.push("agent");
      });
      try {
        await press(pill(), "Resume agent");
        await until(() => rec.ownership === "agent");
      } finally {
        off();
      }
      return order;
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out, ["cleanLoad true", "noteReloaded 1 true", "agent"]);
});

// The user's pass on defenses (2026-11-21): without evidence of danger, a
// page keeps what the user typed until zen-input's clear empties its secret
// fields; only code the agent left there could have read it. A page on a
// list or that the agent flagged stays too: a clean copy can't clear the
// page itself.
for (const [what, evidence] of [
  ["without evidence of danger", {}],
  ["on a phishing or malware list", { listed: "goog-phish-proto" }],
  ["that the agent flagged", { flagged: "it asks for a seed phrase" }],
]) {
test(`Resume agent leaves a page ${what} as it is, though the user typed a secret there: nothing reloads, zen-core hears of no reload, and the agent gets the task back`, async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const order = [];
      UI.evidenceOf = b => (b === browser ? ${JSON.stringify(evidence)} : {});
      UI.typedSecrets = async (service, r) => (r.id === rec.id ? [browser] : []);
      UI.cleanLoad = async () => {
        order.push("cleanLoad");
        return { how: "reload" };
      };
      ctx.service.noteReloaded = () => order.push("noteReloaded");
      const off = ctx.service.addEventListener((event, params) => {
        if (event === "spaceChanged" && params?.space === rec.id && params.ownership === "agent") order.push("agent");
      });
      try {
        await press(pill(), "Resume agent");
        await until(() => rec.ownership === "agent");
      } finally {
        off();
      }
      const back = await ctx.service.beforeHandBack(rec);
      return { order, back: back.length };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out, { order: ["agent"], back: 0 });
});
}

test("with zen-core's quiet loads off (zenius.handoff.quietReload, a test's switch), Resume agent asks nothing and reloads nothing: the agent has the task before the press returns; zen-core's own way back reloads nothing either", async () => {
  const out = await h.chrome(`${P}
    Services.prefs.setBoolPref("zenius.handoff.quietReload", false);
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const asked = [];
      UI.typedSecrets = async () => {
        asked.push("typedSecrets");
        return [browser];
      };
      UI.cleanLoad = async () => {
        asked.push("cleanLoad");
        return { how: "reload" };
      };
      const hook = await ctx.service.beforeHandBack(rec);
      // The pill takes clicks 400 ms after it shows.
      await new Promise(r => win.setTimeout(r, 450));
      [...pill().querySelectorAll("button")].find(b => b.textContent === "Resume agent").click();
      // zen-input's clear runs on this change, ahead of the agent's next call.
      return { asked, hook: hook.length, ownership: rec.ownership };
    } finally {
      Services.prefs.clearUserPref("zenius.handoff.quietReload");
      await cleanUp();
    }
  `);
  assert.deepEqual(out, { asked: [], hook: 0, ownership: "agent" });
});

test("zen-core's own ways back to the agent await service.beforeHandBack, the same reload step, which leaves who holds the task alone", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const order = [];
      UI.evidenceOf = b => (b === browser ? { hooked: "an on* attribute" } : {});
      UI.typedSecrets = async (service, r) => (r.id === rec.id ? [browser] : []);
      UI.cleanLoad = async b => {
        order.push("cleanLoad " + (b === browser));
        return { how: "reload" };
      };
      ctx.service.noteReloaded = (r, bs) => order.push("noteReloaded " + bs.length);
      const hook = typeof ctx.service.beforeHandBack;
      const reloaded = await ctx.service.beforeHandBack(rec);
      // A page whose reload failed isn't named.
      UI.cleanLoad = async () => {
        throw new Error("no new document");
      };
      const failed = await ctx.service.beforeHandBack(rec);
      return { hook, order, reloaded: reloaded.map(b => b === browser), failed: failed.length, ownership: rec.ownership };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out, { hook: "function", order: ["cleanLoad true", "noteReloaded 1"], reloaded: [true], failed: 0, ownership: "agentDelegatedToUser" });
});

test("a tab that joins the task during the user's hold has a card saying it's the agent's, with Resume agent", async () => {
  const { label } = await h.call("pages.new", { space, url: `${h.base}/api/text?joined` });
  try {
    const out = await h.chrome(`${P}
      try {
        await showTask();
        handOff("Log in to continue");
        await until(() => UI.describe(rec).controlNotice);
        const { tab: joined } = ctx.resolvePage({ space: rec.id, page: ${JSON.stringify(label)} });
        // zen-core's adoptPopup, for a tab the user opened from the agent's page.
        ctx.service.emitLocal("popup", { space: rec.id, page: ${JSON.stringify(label)}, tab: ctx.service.pages.tabId(joined), opener: "p1" });
        await until(() => N.noticeElement(joined, "zenius-joined"));
        const el = N.noticeElement(joined, "zenius-joined");
        const shown = { text: N.noticeText(joined, "zenius-joined"), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: buttonsOf(el) };
        await press(el, "Resume agent");
        await until(() => rec.ownership === "agent" && !N.noticeElement(joined, "zenius-joined"));
        return { shown, back: rec.ownership };
      } finally {
        await cleanUp();
      }
    `);
    assert.deepEqual(out.shown, {
      text: `Agent's tab · ${iso(name)}`,
      note: "You opened it from the agent's page, so it's part of the task: the agent can use it once you resume it.",
      buttons: ["Resume agent"],
    });
    assert.equal(out.back, "agent");
  } finally {
    await h.call("pages.close", { space, page: label });
  }
});

const NEW_PAGE = `
  const makeCurrent = async (label) => {
    const { tab: t } = ctx.resolvePage({ space: rec.id, page: label });
    await C.moveCursor(t, { x: 20, y: 20 }, { label: "Wait", kind: "move" });
    return t;
  };
`;

// The user's pass on defenses (2026-11-21): the line comes only when the
// page asks for a password, a card's details or a one-time code, or the
// agent flagged it.
test("a page the agent made itself: the user's Take over keeps it as it is, and the card says, behind the '?', it might contain malicious code, only once the page asks for a password, card or code, or the agent flagged it", async () => {
  const { label } = await h.call("pages.new", { space });
  try {
    const out = await h.chrome(`${P}${NEW_PAGE}
      const blank = await makeCurrent(${JSON.stringify(label)});
      codeOn(() => true);
      const takeOver = async () => {
        await showTask(blank);
        await UI.takeOverByUser(rec);
        await until(() => pillOn(blank));
      };
      const handBack = async () => {
        ctx.spaces.setOwnership(rec, "agent", { source: "user" });
        await until(() => !pillOn(blank));
      };
      const res = {};
      try {
        UI.evidenceOf = () => ({});
        await takeOver();
        // Time for the page's frames to answer.
        await new Promise(r => win.setTimeout(r, 500));
        res.plain = { url: blank.linkedBrowser.currentURI.spec, card: card(UI.describe(rec)) };
        await handBack();
        await inPage(blank.linkedBrowser, "document.body.innerHTML = '<input type=password>'; return true;");
        await takeOver();
        await until(() => UI.describe(rec).controlMore, 5000).catch(() => {});
        res.password = card(UI.describe(rec));
        await handBack();
        await inPage(blank.linkedBrowser, "document.body.textContent = ''; return true;");
        UI.evidenceOf = b => (b === blank.linkedBrowser ? { flagged: "it asks for the user's bank login" } : {});
        await takeOver();
        res.flagged = card(UI.describe(rec));
        return res;
      } finally {
        await cleanUp();
      }
    `);
    assert.equal(out.plain.url, "about:blank");
    const held = more => ({ notice: "You're in control · the agent waits until you resume it", note: CLEARS, more, buttons: ["Resume agent"] });
    assert.deepEqual(out.plain.card, held(null), "a page that asks for no secret: no line");
    assert.deepEqual(out.password, held(MADE_NOTE), "a password field: the line, once the page answers");
    assert.deepEqual(out.flagged, held(MADE_NOTE), "the agent flagged it: the line at once");
  } finally {
    await h.call("pages.close", { space, page: label });
  }
});

test("end to end, on zen-observe's real record: a data: page the agent went to, and a blob: page its code made on the site, say the agent made them when the user takes them over", async () => {
  // A task of its own: the record lasts the task's life.
  const { id: made } = await h.createSpace({ name: `zen-ux agent-made ${run}` });
  const Q = `${prelude(made)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const takenOver = async () => {
      await UI.takeOverByUser(rec);
      await until(() => N.noticeElement(tab, "zenius-control"), 5000);
      // The page asks for a password: the line comes once it says so.
      await until(() => UI.describe(rec).controlMore, 5000).catch(() => {});
      const { controlNote, controlMore, controlButtons } = UI.describe(rec);
      return { scheme: browser.currentURI.scheme, note: controlNote, more: controlMore, buttons: controlButtons };
    };
    const handBack = async () => {
      ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      await until(() => !N.noticeElement(tab, "zenius-control"));
      return true;
    };
  `;
  await h.chrome(`${Q} UI.agentCodeOnSite = null; UI.agentCodeInPage = null; UI.agentMadePage = null; return true;`);
  // The agent goes to a page of its own (zen-snapshot's dataGoto).
  await h.call("page.goto", { space: made, page: "p1", url: "data:text/html,<title>Sign in</title><input type=password>" });
  const data = await h.chrome(`${Q} try { return await takenOver(); } finally { await handBack(); }`);
  // On the site, its code makes a page of its own and moves the tab there.
  await h.call("page.goto", { space: made, page: "p1", url: `${h.base}/zoo/forms.html` });
  await h.call("page.evaluate", {
    space: made,
    page: "p1",
    fn: "() => { const u = URL.createObjectURL(new Blob(['<title>Sign in</title><input type=password>'], { type: 'text/html' })); setTimeout(() => (location.href = u), 0); return u; }",
    isFunction: true,
  });
  await h.chrome(`${Q} await until(() => browser.currentURI.schemeIs("blob") && browser.contentTitle === "Sign in", 5000); return true;`);
  const blob = await h.chrome(`${Q} try { return await takenOver(); } finally { await handBack(); }`);
  assert.deepEqual(data, { scheme: "data", note: CLEARS, more: MADE_NOTE, buttons: ["Resume agent"] });
  assert.deepEqual(blob, { scheme: "blob", note: CLEARS, more: MADE_NOTE, buttons: ["Resume agent"] });
});

test("siteName: the registrable domain zen-observe's record goes by, shown as Firefox shows IDNs", async () => {
  const out = await h.chrome(`
    const { siteName } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs");
    const f = s => siteName(Services.io.newURI(s));
    // A Cyrillic "а" (U+0430) in front of a Latin "pple": a look-alike.
    const spoof = "https://www." + String.fromCodePoint(0x430) + "pple.com/login";
    return {
      sub: f("https://accounts.google.com/signin"),
      suffix: f("https://www.bbc.co.uk/news"),
      chain: f("https://accounts.google.com.secure-login.evil.co/x"),
      ip: f("http://127.0.0.1:8080/"),
      local: f("http://localhost:3000/"),
      idn: f("https://www.münchen.de/"),
      ace: f("https://www.xn--mnchen-3ya.de/"),
      spoof: f(spoof),
    };
  `);
  assert.deepEqual(out, {
    sub: "google.com",
    suffix: "bbc.co.uk",
    chain: "evil.co",
    ip: "127.0.0.1",
    local: "localhost",
    idn: "münchen.de",
    ace: "münchen.de",
    spoof: "xn--pple-43d.com",
  });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
});
