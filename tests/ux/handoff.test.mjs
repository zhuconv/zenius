// The hand-off and the user's Take over, made safe by zenius itself (the
// user's direction and correction, 2026-11-20). The user always types in
// the agent's own tab:
// - zen-core reloads a page that may hold the agent's code before the hold
//   begins, at a hand-off and at Take over (service.userTakeOver), silently:
//   a card keeps only what the user acts on (the manager, 2026-11-20);
// - a Take over whose reload fails brings today's prompt back;
// - zen-input's typing hook changes nothing in the UI: zen-core reloads a
//   page the agent's sandbox wrote into itself (cleanOnDemand);
// - on a page the agent made itself, the card says it might contain
//   malicious code;
// - the card says that Resume agent clears secret fields once the user typed
//   one (zen-input's onSecretTyped), or always without that event;
// - Resume agent first reloads each page where the user typed a secret
//   (zen-input's typedSecrets, zen-core's cleanLoad), and tells zen-core;
//   zen-core's own ways back (spaces.takeOver, spaces.claim) run the same
//   step through service.beforeHandBack;
// - a tab that joins the task during the hold says it's the agent's.
// zen-core's and zen-input's parts are stand-ins here; their suites test
// them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup, iso } from "./lib.mjs";

const CLEARS = "Resume agent clears password, card and code fields, so submit what you type there first.";
const inControl = () => ({ notice: `You're in control · the agent waits until you resume it · ${site()}`, note: CLEARS, more: null, buttons: ["Resume agent"] });
// A page the agent made itself, which no website served.
const MADE_NOTE = "The agent made this page. It might contain malicious code. Keep sensitive information out.";
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
    const handOff = (text, extra = {}) =>
      withEvent(extra, () => {
        ctx.spaces.setStateText(rec, text);
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
      codeOn(null);
      delete ctx.service.userTakeOver;
      delete ctx.service.noteReloaded;
      UI.typedSecrets = null;
      UI.cleanLoad = null;
      UI.secretLineJustInTime = false;
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      ctx.spaces.setPaused(rec, false);
      ctx.spaces.setStateText(rec, "");
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
      return { said, silent: card(UI.describe(rec)) };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.said, { notice: `Agent needs you · ${iso(name)} · ${site()}`, note: CLEARS, more: `The agent says: “${iso("Log in to continue")}”.`, buttons: ["Resume agent"] });
  assert.deepEqual(out.silent, { notice: `Agent needs you · ${iso(name)} · ${site()}`, note: CLEARS, more: null, buttons: ["Resume agent"] });
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
    notice: `Agent needs you · ${iso(name)} · ${site()}`,
    site: site(),
    label: `Agent needs you, ${iso(name)}, on ${site()}. Resume agent clears password, card and code fields, so submit what you type there first. The agent says: “${iso("Log in to continue")}”.`,
  });
  assert.deepEqual(out.moved, {
    notice: `Agent needs you · ${iso(name)} · ${at}`,
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

test("a hand-off zen-core reloaded first looks and sounds like any other: the reload is silent", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      heard.length = 0;
      handOff("Log in to continue", { reloaded: "get", carried: true });
      await until(() => pill());
      await UIM.announcementsOut(win);
      return { card: card(UI.describe(rec)), heard: heard.slice() };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.card, { notice: `Agent needs you · ${iso(name)} · ${site()}`, note: CLEARS, more: `The agent says: “${iso("Log in to continue")}”.`, buttons: ["Resume agent"] });
  assert.deepEqual(out.heard, [`Agent needs you in ${iso(name)}, on ${site()}. The agent says: “${iso("Log in to continue")}”.`]);
});

test("Take over goes through zen-core's userTakeOver: the agent stays paused while the page reloads, with no card for it; then You're in control, unannounced", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      const seen = takeOverAs("reload");
      heard.length = 0;
      await UI.takeOverByUser(rec);
      await until(() => rec.ownership === "agentDelegatedToUser" && pill());
      await UIM.announcementsOut(win);
      return { seen, after: card(UI.describe(rec)), paused: !!rec.paused, heard: heard.slice() };
    } finally {
      await cleanUp();
    }
  `);
  assert.deepEqual(out.seen, [{ notice: null, prompt: null, paused: true, ownership: "agent" }]);
  assert.deepEqual(out.after, inControl());
  assert.equal(out.paused, false, "the pause lifts once the hold begins");
  assert.deepEqual(out.heard, [], "their own choice: nothing to hear");
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

test("a quiet reload whose new document came in written too (zen-core's stillWritten: a popup or other window on the site holds the agent's writes): the card and what's heard give the way out, since Reload alone can't help", async () => {
  const out = await h.chrome(`${P}
    const offCard = () => {
      const el = N.noticeElement(tab, "zenius-typing-off");
      return el ? { text: N.noticeText(tab, "zenius-typing-off"), note: el.querySelector(".zenius-card-note")?.textContent ?? null, buttons: buttonsOf(el) } : null;
    };
    try {
      await showTask();
      heard.length = 0;
      const written = Object.assign(new Error("the clean copy came in written too"), { stillWritten: true });
      const missed = await UI.userTyping({ browser, trigger: "key", reloaded: Promise.reject(written) });
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

test("the panel's Pause: once the user typed a secret meanwhile, the row says its Resume clears such fields, under the button; Resume reloads that page first, and the line goes", async () => {
  const out = await h.chrome(`${P}
    const row = () => UI.tasks().find(r => r.id === rec.id) ?? null;
    const calls = [];
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

test("Resume agent first reloads each page where the user typed a secret, through zen-core's cleanLoad, tells zen-core, then hands back", async () => {
  const out = await h.chrome(`${P}
    try {
      await showTask();
      handOff("Log in to continue");
      await until(() => pill());
      const order = [];
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

test("a page the agent made itself: the user's Take over keeps it as it is, and the card says, behind the '?', it might contain malicious code", async () => {
  const { label } = await h.call("pages.new", { space });
  try {
    const out = await h.chrome(`${P}${NEW_PAGE}
      const blank = await makeCurrent(${JSON.stringify(label)});
      codeOn(() => true);
      try {
        await showTask(blank);
        await UI.takeOverByUser(rec);
        await until(() => pillOn(blank));
        return { url: blank.linkedBrowser.currentURI.spec, card: card(UI.describe(rec)) };
      } finally {
        await cleanUp();
      }
    `);
    assert.equal(out.url, "about:blank");
    assert.deepEqual(out.card, { notice: "You're in control · the agent waits until you resume it", note: CLEARS, more: MADE_NOTE, buttons: ["Resume agent"] });
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
