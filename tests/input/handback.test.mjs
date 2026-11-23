// An agent tab handed to the user (input/autofill.sys.mjs,
// input/handback.sys.mjs). While the user holds it, their own clicks get
// their saved logins, addresses and cards, and the agent's never do. When the
// agent gets the tab back, every password and card field filled meanwhile,
// by Firefox or by hand and in every frame, is empty before the agent's
// next call runs; the agent's own fields and the user's address stay. A tab
// the agent adopts or claims back gets the same clear. The agent hears how
// many were cleared, never what they held. A submitted login keeps its
// session. The user's input needs the page shown, so these cases run in a
// watched agent tab, on the https fixture with a saved login.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";
import { loginSite } from "./https-fixture.mjs";

let h;
let task;
let site;

const SAVED = { username: "saved-user", password: "saved-secret-pass" };
const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const UI = `const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;`;

before(async () => {
  h = await openHarness("handback");
  // The agent's own values stay in the page across a hand-off: these tests check what the hand back clears (zen-core's glue).
  await chrome(`Services.prefs.setBoolPref("zenius.handoff.quietReload", false); return true;`);
  task = await h.taskSpace("zen-input handback");
  site = await loginSite(h, SAVED);
});

after(async () => {
  try {
    await chrome(`Services.prefs.clearUserPref("zenius.handoff.quietReload"); return true;`).catch(() => {});
    await closePopups().catch(() => {});
    await site?.close();
  } finally {
    await h?.finish();
  }
});

const space = page => ({ space: page.spaceId });
const handOff = page => h.call("spaces.handOff", { ...space(page), reason: "login" });
/**
 * The user's last real input in a task holds a takeOver, or a claim of it,
 * for 10 s (zen-core's rule, once zen-ux's detector reports input). These
 * tests act as the user, then at once as the agent: age that input, as if the
 * user had stopped a while ago.
 */
const ageUserInput = page =>
  chrome(
    `const s = ctx.spaces.peek(arg);
     if (typeof s?.lastUserInputAt === "number") s.lastUserInputAt -= 10000;
     return true;`,
    page.spaceId
  );
/** The agent takes its Space back, as after the user approved. */
const takeBack = async page => {
  await ageUserInput(page);
  return h.call("spaces.takeOver", space(page));
};
/** A claim asks the user: answer Allow, as the user would. */
const claimAllowed = params => Promise.all([h.call("spaces.claim", params), h.call("dev.answerClaim", { space: params.space })]);
const browserIdOf = page => chrome(`${SERVICE} return ZeniusService.resolvePage(arg).browser.browserId;`, { space: page.spaceId, page: page.label });
const handBackStats = () =>
  chrome(`return ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/handback.sys.mjs").handBackStats();`);

/** The usernames the open login suggestions offer; null when none are open. */
const suggestions = () =>
  chrome(`const p = win.document.getElementById("PopupAutoComplete");
    if (p.state !== "open") return null;
    // AutoCompleteParent's result view; a login row's label is its username.
    return (p.view?.results ?? []).filter(r => r.style !== "loginsFooter").map(r => r.label);`);
/** The suggestions' rows once there are some: a popup can open before its rows arrive, and `[]` would end a wait. */
const shownRows = async () => {
  const rows = await suggestions();
  return rows?.length ? rows : null;
};
const closePopups = () =>
  chrome(`for (const p of win.document.querySelectorAll("panel, menupopup")) if (p.state === "open" || p.state === "showing") p.hidePopup(); return true;`);
/**
 * The agent's input in `field` ends in a search that finds nothing of the
 * user's: no rows reach the page, and no popup opens. This waits for that
 * search to end rather than for a set time: a first saved-login search here
 * takes about 400 ms, and a window's first popup wasn't open 400 ms after the
 * key that asked for it, so a check after a set wait can pass with zenius's
 * guard gone. The agent's first input in a field focuses it, which resets
 * the page's search state, so the end seen here is that input's.
 */
async function noSuggestions(page, field, what) {
  const ended = await h.until(async () => {
    const here = await pageAutocomplete(page);
    return here.controlled === field && here.ended && here;
  }, `the search after ${what} to end`);
  assert.equal(ended.userRows, 0, `nothing of the user's reached the page after ${what}`);
  assert.equal(await suggestions(), null, `no suggestions after ${what}`);
}

/**
 * Gecko opens a suggestion popup only in a page that has the window's focus
 * (canOpenModalPicker), and the agent's own input doesn't move that focus.
 * In this headless window no page has it until the user's first click; in
 * the user's own window, the page they're looking at can have it. So before
 * a check that the agent gets no suggestions, the page gets it: without
 * that, the check passes with zenius's guard gone.
 */
async function focusPage(page) {
  const at = { space: page.spaceId, page: page.label };
  await chrome(`${SERVICE} ZeniusService.resolvePage(arg).browser.focus(); return true;`, at);
  await h.until(
    () => chrome(`${SERVICE} return ZeniusService.resolvePage(arg).browser.browsingContext.canOpenModalPicker;`, at),
    "the page to be able to open suggestions"
  );
}

/** Zenius.passwordsCleared events the agent got from `page`, gathered as page.events drains them. */
function clearedEvents(page) {
  const seen = [];
  return {
    async read() {
      const events = await h.call("page.events", { space: page.spaceId, page: page.label });
      seen.push(...events.filter(e => e.method === "Zenius.passwordsCleared"));
      return seen;
    },
  };
}

/** The user picks their saved login from the suggestions under the username field. */
async function userPicksSavedLogin(page) {
  await h.userClick(page, "#user");
  const offered = await h.until(shownRows, "the user's login suggestions");
  assert.deepEqual(offered, [SAVED.username], "the user's click offers their saved login");
  await h.userPress(page, "ArrowDown", "Enter");
  await h.until(() => h.asUser(page, "return document.querySelector('#pass').value.length > 0"), "the password manager to fill the password");
}

async function inWatchedPage(path, fn) {
  const page = await h.newPageAt(task, `${site.origin}${path}`);
  const back = await h.watch(page);
  try {
    await fn(page);
  } finally {
    await closePopups().catch(() => {});
    // A failed case may leave the Space with the user, or paused.
    await chrome(
      `${SERVICE} ${UI}
       const rec = ZeniusService.spaces.peek(arg);
       if (UI.takeover.promptState(arg)) UI.takeover.resolve(arg, "continue");
       if (rec.paused) UI.resumeByUser(rec);
       return true;`,
      page.spaceId
    ).catch(() => {});
    await takeBack(page).catch(() => {});
    await back();
    await page.close().catch(() => {});
  }
}

test("while the user holds an agent tab, their click gets their saved logins; the agent's never does", () =>
  inWatchedPage("/login", async page => {
    assert.equal(await site.formProcessed(await browserIdOf(page)), "no_saved_logins", "nothing fills on load");
    await focusPage(page);
    await page.click("#user");
    await page.keyboard.type("sav");
    await noSuggestions(page, "user", "the agent's click and typing");
    await page.fill("#user", "");

    await handOff(page);
    await h.userClick(page, "#user");
    assert.deepEqual(await h.until(shownRows, "the user's login suggestions"), [SAVED.username], "the user's click offers their saved login");
    await h.userPress(page, "Escape");
    await h.until(async () => (await suggestions()) === null, "the suggestions to close");

    await takeBack(page);
    await focusPage(page);
    await page.click("#pass");
    await page.click("#user");
    await noSuggestions(page, "user", "the agent's click once it has the tab back");
  }));

test("hand back empties every password the user filled, in every frame, and keeps the agent's own", () =>
  inWatchedPage("/handback", async page => {
    await page.waitForFunction(() => document.querySelector("#frame").contentDocument?.querySelector("#pin") !== null);
    const events = clearedEvents(page);
    await events.read();
    await page.fill("#agentpass", "agent-own-secret");
    const before = await handBackStats();

    await handOff(page);
    await userPicksSavedLogin(page);
    // ...and types a PIN by hand into the iframe. Letters: the event's url
    // has the fixture's random port, which could contain a digit PIN.
    await h.userClick(page, "#pin", { frame: "#frame" });
    await h.userPress(page, ..."pqxz");
    await h.until(
      () => h.asUser(page, "return document.querySelector('#frame').contentDocument.querySelector('#pin').value.length === 4"),
      "the user's PIN"
    );

    await takeBack(page);
    const fields = await page.evaluate(() => {
      const pin = document.querySelector("#frame").contentDocument.querySelector("#pin");
      return { user: user.value, pass: pass.value, agentpass: agentpass.value, pin: pin.value };
    });
    assert.deepEqual(fields, { user: SAVED.username, pass: "", agentpass: "agent-own-secret", pin: "" }, "the user's passwords are gone, the agent's stays");
    const cleared = await h.until(async () => (await events.read()).length && (await events.read()), "a Zenius.passwordsCleared event");
    assert.equal(cleared.length, 1, "one event for the tab");
    assert.equal(cleared[0].params.count, 2, "it counts both fields");
    const text = JSON.stringify(cleared);
    assert.ok(!text.includes(SAVED.password) && !text.includes("pqxz"), "the event never says what the fields held");
    const after = await handBackStats();
    assert.equal(after.cleared - before.cleared, 2);
    assert.equal(after.afterKey - before.afterKey, 0, "a handOff waits for no key");
  }));

test("a login the user submits keeps its session after hand back, and saves nothing", () =>
  inWatchedPage("/login", async page => {
    const events = clearedEvents(page);
    await events.read();
    await handOff(page);
    await userPicksSavedLogin(page);
    await h.userClick(page, "#submit");
    await h.until(async () => (await h.asUser(page, "return document.querySelector('#state')?.textContent ?? ''")) === `logged in as ${SAVED.username}`, "the login");
    await h.sleep(300);
    const doorhanger = await chrome(`${SERVICE} return !!win.PopupNotifications.getNotification("password", ZeniusService.resolvePage(arg).browser);`, {
      space: page.spaceId,
      page: page.label,
    });
    assert.equal(doorhanger, false, "the user's login in an agent tab offers no save");

    await takeBack(page);
    assert.equal(await page.evaluate(() => document.querySelector("#state").textContent), `logged in as ${SAVED.username}`);
    await page.goto(`${site.origin}/account`);
    assert.equal(await page.evaluate(() => document.querySelector("#state").textContent), `logged in as ${SAVED.username}`, "the session survives a reload");
    assert.deepEqual(await site.savedUsernames(), [SAVED.username], "the password manager holds only the user's own login");
    await h.sleep(200);
    assert.deepEqual(await events.read(), [], "nothing to clear: the login page is gone");
  }));

test("what the user types after their first key pauses the agent is cleared when the agent resumes", () =>
  inWatchedPage("/handback", async page => {
    await page.fill("#agentpass", "agent-own-secret");
    // The agent leaves the focus in an empty password field.
    await page.click("#pass");
    const before = await handBackStats();
    await h.userPress(page, "p");
    const paused = await chrome(`${SERVICE} const rec = ZeniusService.spaces.peek(arg); return { paused: rec.paused, ownership: rec.ownership };`, page.spaceId);
    assert.deepEqual(paused, { paused: true, ownership: "agent" }, "the user's key opened the takeover prompt");
    await h.userPress(page, ..."asted");
    await h.until(() => h.asUser(page, "return document.querySelector('#pass').value.length === 6"), "the user's typing");
    await chrome(`${SERVICE} ${UI} UI.takeover.resolve(arg, "continue"); return true;`, page.spaceId);

    assert.deepEqual(await page.evaluate(() => [pass.value, agentpass.value]), ["", "agent-own-secret"]);
    const after = await handBackStats();
    assert.equal(after.afterKey - before.afterKey, 1, "the snapshot after a key leaves out the focused field");
    assert.equal(after.cleared - before.cleared, 1);
  }));

test("a key that reaches the page before the snapshot is still cleared", () =>
  inWatchedPage("/handback", async page => {
    // As if the user's first key landed before the snapshot: the focused
    // field already holds it when the snapshot is taken.
    await page.fill("#agentpass", "agent-own-secret");
    await page.fill("#pass", "x");
    const run = skipFocused =>
      chrome(
        `${SERVICE}
         const bc = ZeniusService.resolvePage(arg).browser.browsingContext;
         await ZeniusService.content(bc, "secrets#snapshot", { skipFocused: arg.skipFocused });
         return (await ZeniusService.content(bc, "secrets#clearChanged", {})).cleared;`,
        { space: page.spaceId, page: page.label, skipFocused }
      );
    assert.equal(await run(false), 0, "a plain snapshot would keep it");
    assert.equal(await run(true), 1, "after a key, the focused field is left out, so it's cleared");
    assert.deepEqual(await page.evaluate(() => [pass.value, agentpass.value]), ["", "agent-own-secret"]);
  }));

test("what the user types while they paused the agent is cleared on Resume", () =>
  inWatchedPage("/handback", async page => {
    await page.fill("#agentpass", "agent-own-secret");
    await chrome(`${SERVICE} ${UI} UI.pauseByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
    await h.userClick(page, "#pass");
    await h.userPress(page, ..."typed");
    await h.until(() => h.asUser(page, "return document.querySelector('#pass').value.length === 5"), "the user's typing");
    const before = await handBackStats();
    await chrome(`${SERVICE} ${UI} UI.resumeByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
    assert.deepEqual(await page.evaluate(() => [pass.value, agentpass.value]), ["", "agent-own-secret"]);
    assert.equal((await handBackStats()).cleared - before.cleared, 1);
  }));

test("typedSecrets names each page whose current document holds a password filled while the user held the Space, and changes nothing (zen-ux's Resume)", () =>
  inWatchedPage("/handback", async page => {
    await page.fill("#agentpass", "agent-own-secret");
    const other = await h.newPageAt(task, `${site.origin}/handback?other=1`);
    const typed = () =>
      chrome(
        `${SERVICE} const { typedSecrets } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/handback.sys.mjs");
         return (await typedSecrets(ZeniusService, ZeniusService.spaces.peek(arg))).map(b => b.browserId);`,
        page.spaceId
      );
    try {
      await chrome(`${SERVICE} ${UI} UI.pauseByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
      assert.deepEqual(await typed(), [], "nothing yet: the agent's own password was there at the snapshot");
      await h.userClick(page, "#pass");
      await h.userPress(page, ..."typed");
      await h.until(() => h.asUser(page, "return document.querySelector('#pass').value.length === 5"), "the user's typing");
      const [pageId, otherId] = [await browserIdOf(page), await browserIdOf(other)];
      assert.deepEqual(await typed(), [pageId], "the page they typed in, not the other");
      assert.equal(await h.asUser(page, "return document.querySelector('#pass').value"), "typed", "asking changed nothing");
      // A password in a document that came after the snapshot (a two-step
      // login's password page) counts too.
      const goTo = async (p, search) => {
        await h.asUser(p, `location.search = ${JSON.stringify(search)}; return true;`);
        await h.until(() => h.asUser(p, `return location.search === ${JSON.stringify(search)} && document.readyState === "complete"`), `the page's ${search} document`);
      };
      await goTo(other, "?other=2");
      await h.asUser(other, "document.querySelector('#pass').value = 'later'; return true;");
      assert.deepEqual((await typed()).sort(), [pageId, otherId].sort(), "and the page whose newer document holds one");
      // A page that moved on after the user typed (a submitted login) holds nothing of it.
      await goTo(page, "?moved=1");
      assert.deepEqual(await typed(), [otherId], "not the page that moved on");
      await chrome(`${SERVICE} ${UI} UI.resumeByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
      assert.equal(await other.evaluate(() => pass.value), "", "the clear ran as before");
    } finally {
      await other.close().catch(() => {});
    }
  }));

test("a one-time code the user typed while they held the tab is cleared on Resume, and the agent hears a code was", () =>
  inWatchedPage("/handback", async page => {
    // The page's own field, made without the agent's code.
    await h.asUser(page, "const f = document.createElement('input'); f.id = 'otp'; f.autocomplete = 'one-time-code'; document.body.append(f); return true;");
    const events = clearedEvents(page);
    await events.read();
    await chrome(`${SERVICE} ${UI} UI.pauseByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
    await h.userClick(page, "#otp");
    await h.userPress(page, ..."123456");
    await h.until(() => h.asUser(page, "return document.querySelector('#otp').value.length === 6"), "the user's code");
    const before = await handBackStats();
    await chrome(`${SERVICE} ${UI} UI.resumeByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
    assert.equal(await page.evaluate(() => document.querySelector("#otp").value), "", "the code is gone before the agent's call");
    assert.equal((await handBackStats()).codes - before.codes, 1);
    const cleared = await h.until(async () => (await events.read()).length > 0 && (await events.read()), "the agent's Zenius.passwordsCleared");
    const { count, passwords, cards, codes, message } = cleared[0].params;
    assert.deepEqual({ count, passwords, cards, codes }, { count: 1, passwords: 0, cards: 0, codes: 1 });
    assert.match(message, /^1 one-time code field filled while the user held this tab/);
  }));

// ---------------------------------------------------------------------------
// onSecretTyped (zen-ux's line on the hold card, the manager's decision
// 2026-11-20): the user's own input first changing a field Resume clears,
// once per document.

/** onSecretTyped's calls from now on, as browserIds. */
async function watchSecretTyped() {
  await chrome(
    `const H = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/handback.sys.mjs");
     win.__zenInputSecretTyped?.stop();
     const seen = [];
     win.__zenInputSecretTyped = { seen, stop: H.onSecretTyped(({ browser }) => seen.push(browser.browserId)) };
     return true;`
  );
  return {
    seen: () => chrome(`return win.__zenInputSecretTyped.seen;`),
    count: n => h.until(async () => (await chrome(`return win.__zenInputSecretTyped.seen;`)).length === n, `${n} onSecretTyped calls`),
    stop: () => chrome(`win.__zenInputSecretTyped?.stop(); delete win.__zenInputSecretTyped; return true;`),
  };
}

const pauseByUser = page => chrome(`${SERVICE} ${UI} UI.pauseByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);

/**
 * Wait until the window sends the user's keys to `selector` in the page's
 * top document, or in its frame whose URL has `frameUrl`: there, and
 * focused. Under load the window learned of a focus move late, and keys
 * sent sooner went to the frame that had the focus (test-all).
 */
async function keysGoTo(page, selector, frameUrl = null, ms = 30_000) {
  const focused = `return document.activeElement === document.querySelector(${JSON.stringify(selector)})`;
  await h.until(
    async () =>
      (await chrome(
        `${SERVICE} const { browser } = ZeniusService.resolvePage(arg);
         const bc = Services.focus.focusedContentBrowsingContext;
         if (!bc || bc.top !== browser.browsingContext) return false;
         return arg.frameUrl ? bc !== bc.top && !!bc.currentURI?.spec.includes(arg.frameUrl) : bc === bc.top;`,
        { space: page.spaceId, page: page.label, frameUrl }
      )) && (frameUrl ? h.frameJs(page, frameUrl, focused) : h.asUser(page, focused)),
    `the user's keys to go to ${selector}`,
    ms
  );
}

/** The user clicks into `selector` of the top document, again if the focus didn't land there, and types `keys`. */
async function userTypes(page, selector, ...keys) {
  for (let attempt = 1; ; attempt++) {
    await h.userClick(page, selector);
    try {
      await keysGoTo(page, selector, null, 5000);
      break;
    } catch (e) {
      if (attempt === 4) {
        throw e;
      }
    }
  }
  await h.userPress(page, ...keys);
}

test("onSecretTyped: the user's typing fires once per document, for a one-time code, a password and a frame's password; never for a plain field", () =>
  inWatchedPage("/handback", async page => {
    await h.until(() => h.asUser(page, "return !!document.querySelector('#frame').contentDocument?.querySelector('#pin')"), "the iframe's field");
    // The page's own field, made without the agent's code.
    await h.asUser(page, "const f = document.createElement('input'); f.id = 'otp'; f.autocomplete = 'one-time-code'; document.body.append(f); return true;");
    const id = await browserIdOf(page);
    const typed = await watchSecretTyped();
    try {
      await pauseByUser(page);
      await userTypes(page, "#user", ..."name");
      await h.until(() => h.asUser(page, "return document.querySelector('#user').value === 'name'"), "the user's username", 30_000);
      await h.sleep(300);
      assert.deepEqual(await typed.seen(), [], "a username is no secret field");

      await userTypes(page, "#otp", "1");
      await typed.count(1);
      assert.deepEqual(await typed.seen(), [id], "the page's browser");
      await h.userPress(page, ..."23456");
      await userTypes(page, "#pass", ..."pass");
      await h.until(() => h.asUser(page, "return document.querySelector('#pass').value === 'pass'"), "the user's password", 30_000);

      await h.userClick(page, "#pin", { frame: "#frame" });
      await keysGoTo(page, "#pin", "/inner");
      await h.userPress(page, ..."pqxz");
      await h.until(
        () => h.asUser(page, "return document.querySelector('#frame').contentDocument.querySelector('#pin').value.length === 4"),
        "the user's PIN"
      );
      await typed.count(2);
      await h.sleep(300);
      assert.deepEqual(await typed.seen(), [id, id], "once for the page, once for its frame: more typing in either fires nothing");
    } finally {
      await typed.stop();
    }
  }));

test("onSecretTyped: a card field fires, one known only by its name and one in a cross-origin frame too; an address and the agent's keys there don't", () =>
  inWatchedPage("/checkout", async page => {
    await h.until(() => h.frameJs(page, "/card", "return !!document.querySelector('#cardnumber')"), "the card iframe");
    const typed = await watchSecretTyped();
    try {
      // The agent's keys reach the cross-origin frame's field in its own
      // process (page.keyboard forwards them there), still as zenius's.
      await page.click("#cardframe");
      await h.frameJs(page, "/card", "document.querySelector('#cardnumber').focus(); return true;");
      await page.keyboard.type("42");
      await h.until(() => h.frameJs(page, "/card", "return document.querySelector('#cardnumber').value === '42'"), "the agent's keys in the iframe");
      await h.sleep(300);
      assert.deepEqual(await typed.seen(), [], "the agent's keys are no user's");

      await pauseByUser(page);
      // The agent's keys left the focus in the cross-origin frame.
      await userTypes(page, "#street", ..."1 Road");
      await h.until(() => h.asUser(page, "return document.querySelector('#street').value === '1 Road'"), "the user's street", 30_000);
      await h.sleep(300);
      assert.deepEqual(await typed.seen(), [], "an address is no secret field");

      // Known as a card field only by its name (form autofill's heuristics).
      await userTypes(page, "#plainnumber", "5");
      await typed.count(1);

      // A card field in a cross-origin iframe, as payment providers embed
      // them (headless Zen passes no parent-made click into it: see the card
      // clear's test).
      await h.userClick(page, "#cardframe");
      await h.frameJs(page, "/card", "document.querySelector('#cardnumber').focus(); return true;");
      await keysGoTo(page, "#cardnumber", "/card");
      await h.userPress(page, "4");
      await h.until(() => h.frameJs(page, "/card", "return document.querySelector('#cardnumber').value === '424'"), "the iframe's card number", 30_000);
      await typed.count(2);
    } finally {
      await typed.stop();
    }
  }));

test("onSecretTyped: the agent's own fill, typing, text, paste and selection never fire it, nor the page's script; the user's saved login does", () =>
  inWatchedPage("/handback", async page => {
    await h.asUser(
      page,
      `const s = document.createElement('select'); s.id = 'expmonth'; s.autocomplete = 'cc-exp-month';
       s.innerHTML = '<option value="">MM</option><option>01</option>'; document.body.append(s);
       const f = document.createElement('input'); f.id = 'otp'; f.autocomplete = 'one-time-code'; document.body.append(f);
       return true;`
    );
    const typed = await watchSecretTyped();
    try {
      await page.fill("#agentpass", "agent-own-secret");
      await page.click("#pass");
      await page.keyboard.type("abc");
      await page.keyboard.insertText("d");
      await page.click("#otp");
      await page.keyboard.paste("123456");
      await page.selectOption("#expmonth", "01");
      await h.asUser(page, "document.querySelector('#pass').dispatchEvent(new InputEvent('input', { bubbles: true })); return true;");
      assert.deepEqual(
        await h.asUser(page, "return [pass.value, otp.value, expmonth.value]"),
        ["abcd", "123456", "01"],
        "the agent's input landed"
      );
      await h.sleep(300);
      assert.deepEqual(await typed.seen(), [], "none of it is the user's");

      await handOff(page);
      await userPicksSavedLogin(page);
      await typed.count(1);
      assert.deepEqual(await typed.seen(), [await browserIdOf(page)], "the password manager's fill is the user's");
    } finally {
      await typed.stop();
    }
  }));

// ---------------------------------------------------------------------------
// Addresses and cards (the manager's decision): while the user holds an
// agent tab, their own click gets their saved addresses and cards. On the
// way back, the card details filled meanwhile are emptied like passwords;
// addresses stay, for the agent to go on with.

const SAVED_ADDRESS = {
  name: "Saved Person",
  "street-address": "1 Saved Street",
  "address-level2": "Aurora",
  "address-level1": "CO",
  "postal-code": "80012",
  country: "US",
  email: "saved@example.com",
};

/** Run `fn` with one saved address, for this run only. */
async function withSavedAddress(fn) {
  const guid = await chrome(
    `Services.prefs.setStringPref("extensions.formautofill.addresses.supported", "on");
     Services.prefs.setBoolPref("extensions.formautofill.addresses.enabled", true);
     const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");
     await formAutofillStorage.initialize();
     return formAutofillStorage.addresses.add(arg);`,
    SAVED_ADDRESS
  );
  try {
    await fn();
  } finally {
    await chrome(
      `Services.prefs.clearUserPref("extensions.formautofill.addresses.supported");
       Services.prefs.clearUserPref("extensions.formautofill.addresses.enabled");
       const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");
       await formAutofillStorage.addresses.remove(arg);
       return true;`,
      guid
    );
  }
}

/** What the open suggestions offer, as text; null when none are open. */
const suggestionText = () =>
  chrome(`const p = win.document.getElementById("PopupAutoComplete");
    if (p.state !== "open") return null;
    return JSON.stringify((p.view?.results ?? []).map(r => [r.style, r.label, r.comment]));`);

const popupState = () =>
  chrome(`const p = win.document.getElementById("PopupAutoComplete"); return { state: p.state, selected: p.selectedIndex };`);

/**
 * The autocomplete as the page's own process sees it. The parent tells it
 * the popup opened with an async message, and a key the user presses next
 * can overtake that message in a busy process (input runs first), so keys
 * wait for `open` here, not only for the parent's popup.
 */
const pageAutocomplete = page =>
  page.privileged(`const ac = Cc["@mozilla.org/autocomplete/controller;1"].getService(Ci.nsIAutoCompleteController);
    const controlled = Cc["@mozilla.org/satchel/form-fill-controller;1"].getService(Ci.nsIFormFillController).controlledElement;
    const { STATUS_SEARCHING, STATUS_COMPLETE_NO_MATCH, STATUS_COMPLETE_MATCH } = Ci.nsIAutoCompleteController;
    // A login field's "Manage Passwords" footer is a row with nothing of the user's.
    let userRows = 0;
    for (let i = 0; i < ac.matchCount; i++) userRows += ac.getStyleAt(i) === "loginsFooter" ? 0 : 1;
    return { open: actor.manager.getActor("AutoComplete").popupOpen, searching: ac.searchStatus === STATUS_SEARCHING,
             ended: ac.searchStatus === STATUS_COMPLETE_NO_MATCH || ac.searchStatus === STATUS_COMPLETE_MATCH,
             rows: ac.matchCount, userRows, controlled: controlled?.id ?? null, path: location.pathname };`);

/** Form autofill controls the focused field once it has classified the form. */
const controlled = (page, id) => h.until(async () => (await pageAutocomplete(page)).controlled === id, `form autofill to control #${id}`);

/** The user opens the suggestions of the focused field and picks the first row (the saved address, or `expected`). */
async function userPicksFirstSuggestion(page, expected = /Saved Person|1 Saved Street/) {
  // A click into the focused field opens them once the page has the window's
  // focus (see focusPage), and ArrowDown either way. Pressed while they open,
  // it changes nothing.
  const { state } = await popupState();
  const here = await pageAutocomplete(page);
  if (state === "closed" && !here.open) {
    await h.userPress(page, "ArrowDown");
  }
  await h.until(async () => (await popupState()).state === "open" && (await pageAutocomplete(page)).open, "the suggestions to open, as the page sees them");
  const offered = await suggestionText();
  assert.match(offered, expected, "the user's own click offers what they saved");
  // Firefox keeps a card's rows disabled for a moment after they open
  // (security.notification_enable_delay, against clickjacking): until then a
  // key selects nothing, for the user too.
  await h.until(
    () =>
      chrome(`const item = win.document.getElementById("PopupAutoComplete").getElementsByTagName("richlistitem")[0];
        return !!item && !item.disabled;`),
    "the suggestions to take input"
  );
  // Row 0 is the saved address, before the footer's rows.
  for (let i = 0; i < 4; i++) {
    const { selected } = await popupState();
    if (selected === 0) {
      break;
    }
    await h.userPress(page, selected > 0 ? "ArrowUp" : "ArrowDown");
    await h.until(async () => (await popupState()).selected !== selected, "the selection to move");
  }
  assert.equal((await popupState()).selected, 0);
  await h.userPress(page, "Enter");
}

const fieldValues = (page, ids) => page.evaluate(list => Object.fromEntries(list.map(id => [id, document.getElementById(id).value])), ids);

test("while the user holds an agent tab, their click gets their saved address, the agent's doesn't, and the address stays on hand back", () =>
  withSavedAddress(() =>
    inWatchedPage("/checkout", async page => {
      const events = clearedEvents(page);
      await events.read();
      await focusPage(page);
      await page.click("#name");
      await controlled(page, "name");
      // An address field opens its suggestions on ArrowDown, typing, or a
      // click into it once focused (on focus alone only card fields do).
      await page.keyboard.press("ArrowDown");
      await page.click("#name");
      await noSuggestions(page, "name", "the agent's ArrowDown and click in an address field");

      await handOff(page);
      await h.userClick(page, "#name");
      await userPicksFirstSuggestion(page);
      await h.until(() => h.asUser(page, "return document.querySelector('#street')?.value === '1 Saved Street'"), "the address to fill").catch(async e => {
        throw new Error(`${e.message}; the page's autocomplete: ${JSON.stringify(await pageAutocomplete(page).catch(err => err.message))}`);
      });

      await takeBack(page);
      assert.deepEqual(await fieldValues(page, ["name", "street", "city", "zip", "ccnumber"]), {
        name: "Saved Person",
        street: "1 Saved Street",
        city: "Aurora",
        zip: "80012",
        ccnumber: "",
      });
      await h.sleep(200);
      assert.deepEqual(await events.read(), [], "nothing to clear: an address stays");

      // The agent has the tab back.
      await focusPage(page);
      await page.click("#city");
      await controlled(page, "city");
      await page.keyboard.press("ArrowDown");
      await page.click("#city");
      await noSuggestions(page, "city", "the agent's ArrowDown and click once it has the tab back");
    })
  ));

test("hand back empties the card details the user typed, in every frame, and keeps their address and the agent's own", () =>
  inWatchedPage("/checkout", async page => {
    await page.waitForFunction(() => document.querySelector("#cardframe") !== null);
    await h.until(() => h.frameJs(page, "/card", "return !!document.querySelector('#cardnumber')"), "the card iframe");
    const events = clearedEvents(page);
    await events.read();
    // The agent's own card field.
    await page.fill("#ccexp", "12/30");

    await handOff(page);
    const typeInto = async (id, text) => {
      await h.userClick(page, `#${id}`);
      await h.userPress(page, ...text);
    };
    await typeInto("ccnumber", "4242424242424242");
    await typeInto("csc", "123");
    await typeInto("street", "1 User Road");
    // Known as card fields only by their names.
    await typeInto("plainnumber", "5555555555554444");
    await typeInto("plaincvc", "987");
    // The user's own dropdown (the select guard refuses only the agent's).
    const dropdownOpen = () => chrome(`return win.document.getElementById("ContentSelectDropdownPopup")?.state === "open";`);
    await h.userClick(page, "#plainmonth");
    await h.until(dropdownOpen, "the select's dropdown");
    await h.userPress(page, "ArrowDown", "Enter");
    await h.until(async () => !(await dropdownOpen()), "the dropdown to close");
    // A card field in a cross-origin iframe, as payment providers embed them.
    // Headless Zen passes no parent-made click on into an out-of-process
    // iframe: the user's click focuses the frame, the frame its field, and
    // the typing is the user's.
    await h.userClick(page, "#cardframe");
    await h.frameJs(page, "/card", "document.querySelector('#cardnumber').focus(); return true;");
    await h.userPress(page, ..."4000056655665556");
    await h.until(() => h.frameJs(page, "/card", "return document.querySelector('#cardnumber').value.length === 16"), "the iframe's card number");
    await h.until(
      () => h.asUser(page, "return document.querySelector('#plaincvc').value === '987' && document.querySelector('#plainmonth').value !== ''"),
      "the user's typing"
    );

    await takeBack(page);
    assert.deepEqual(await fieldValues(page, ["ccnumber", "csc", "ccexp", "street", "plainnumber", "plaincvc", "plainmonth"]), {
      ccnumber: "",
      csc: "",
      ccexp: "12/30",
      street: "1 User Road",
      plainnumber: "",
      plaincvc: "",
      plainmonth: "",
    });
    assert.equal(await h.frameJs(page, "/card", "return document.querySelector('#cardnumber').value"), "", "the iframe's card number is gone");
    const cleared = await h.until(async () => (await events.read()).length && (await events.read()), "a Zenius.passwordsCleared event");
    assert.deepEqual([cleared[0].params.passwords, cleared[0].params.cards], [0, 6], "six card fields, no passwords");
    assert.ok(!/4242424242424242|5555555555554444|4000056655665556/.test(JSON.stringify(cleared)), "the event never says what the fields held");
  }));

// ---------------------------------------------------------------------------
// The user's saved card. Its number is encrypted with the OS keystore, which
// on Linux is the session's Secret Service: tests/input/keyring.sh runs this
// on a Zen of its own, with a private D-Bus session and a throwaway keyring
// (the manager, 2026-11-20). Anywhere else it skips, and touches no keystore.

const KEYRING_BUS = process.env.ZENIUS_KEYRING_BUS ?? "";
const SAVED_CARD = { "cc-name": "Saved Cardholder", "cc-number": "4111111111111111", "cc-exp-month": 12, "cc-exp-year": 2031 };

/** A call on keyring.sh's private bus, never the user's: its reply as text. */
function onPrivateBus(dest, path, method, ...args) {
  return execFileSync("dbus-send", [`--bus=${KEYRING_BUS}`, "--print-reply", `--dest=${dest}`, path, method, ...args], { encoding: "utf8" });
}

/** The labels of the items in the throwaway keyring's default collection. */
function keyringLabels() {
  const get = (path, iface, name) => onPrivateBus("org.freedesktop.secrets", path, "org.freedesktop.DBus.Properties.Get", `string:${iface}`, `string:${name}`);
  const items = get("/org/freedesktop/secrets/aliases/default", "org.freedesktop.Secret.Collection", "Items");
  return [...items.matchAll(/object path "([^"]+)"/g)].map(([, item]) => get(item, "org.freedesktop.Secret.Item", "Label").match(/string "(.*)"/)?.[1]);
}

/** What the user's own keyring dir holds, with times: it must not change. */
function userKeyrings() {
  const dir = process.env.ZENIUS_USER_KEYRINGS;
  try {
    return readdirSync(dir).map(name => `${name} ${statSync(join(dir, name)).mtimeMs}`);
  } catch {
    return [];
  }
}

/** Run `fn` with one saved card, for this run only. */
async function withSavedCard(fn) {
  const guid = await chrome(
    `Services.prefs.setStringPref("extensions.formautofill.creditCards.supported", "on");
     Services.prefs.setBoolPref("extensions.formautofill.creditCards.enabled", true);
     const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");
     await formAutofillStorage.initialize();
     return formAutofillStorage.creditCards.add(arg);`,
    SAVED_CARD
  );
  try {
    await fn();
  } finally {
    await chrome(
      `Services.prefs.clearUserPref("extensions.formautofill.creditCards.supported");
       Services.prefs.clearUserPref("extensions.formautofill.creditCards.enabled");
       const { formAutofillStorage } = ChromeUtils.importESModule("resource://autofill/FormAutofillStorage.sys.mjs");
       await formAutofillStorage.creditCards.remove(arg);
       return true;`,
      guid
    );
  }
}

test("while the user holds an agent tab, their click in a card field gets their saved card, the agent's doesn't, and hand back empties it", async t => {
  if (!KEYRING_BUS) {
    t.skip("runs from tests/input/keyring.sh only, on a private keyring");
    return;
  }
  // Before anything can reach a keystore: this Zen's session bus is the
  // private one keyring.sh made, never the user's, and the secret service
  // answering there is keyring.sh's throwaway keyring.
  const bus = await chrome(`return Services.env.get("DBUS_SESSION_BUS_ADDRESS");`);
  assert.equal(bus, KEYRING_BUS, "this Zen's session bus is the test's private one");
  assert.ok(process.env.ZENIUS_USER_BUS && process.env.ZENIUS_USER_KEYRINGS, "keyring.sh says where the user's bus and keyrings are");
  assert.notEqual(bus, process.env.ZENIUS_USER_BUS, "never the user's");
  const owner = onPrivateBus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetConnectionUnixProcessID", "string:org.freedesktop.secrets");
  assert.equal(owner.match(/uint32 (\d+)/)?.[1], process.env.ZENIUS_KEYRING_PID, "the secret service there is keyring.sh's");
  const theirs = userKeyrings();
  const label = await chrome(`return ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs").OSKeyStore.STORE_LABEL;`);

  await withSavedCard(() =>
    inWatchedPage("/checkout", async page => {
      assert.ok(keyringLabels().includes(label), `the card's key (${label}) is in the throwaway keyring`);
      const events = clearedEvents(page);
      await events.read();
      // A card field opens its suggestions on focus, and on ArrowDown.
      await focusPage(page);
      await page.click("#ccnumber");
      await controlled(page, "ccnumber");
      await page.keyboard.press("ArrowDown");
      await noSuggestions(page, "ccnumber", "the agent's click and ArrowDown in a card field");

      await handOff(page);
      await h.userClick(page, "#ccnumber");
      await userPicksFirstSuggestion(page, /1111/);
      await h.until(() => h.asUser(page, "return document.querySelector('#ccnumber').value === '4111111111111111'"), "the saved card to fill").catch(async e => {
        throw new Error(`${e.message}; the page's autocomplete: ${JSON.stringify(await pageAutocomplete(page).catch(err => err.message))}`);
      });
      assert.match(await h.asUser(page, "return document.querySelector('#ccexp').value"), /^12\/(20)?31$/, "and its expiry");

      await takeBack(page);
      assert.deepEqual(await fieldValues(page, ["ccnumber", "ccexp", "csc"]), { ccnumber: "", ccexp: "", csc: "" }, "hand back emptied what the user's card filled");
      const cleared = await h.until(async () => (await events.read()).length && (await events.read()), "a Zenius.passwordsCleared event");
      assert.deepEqual([cleared[0].params.passwords, cleared[0].params.cards], [0, 2], "the card's number and expiry, no passwords");
      assert.ok(!JSON.stringify(cleared).includes("4111111111111111"), "the event never says what the fields held");

      await focusPage(page);
      await page.click("#csc");
      await page.click("#ccnumber");
      await page.keyboard.press("ArrowDown");
      await noSuggestions(page, "ccnumber", "the agent's click and ArrowDown once it has the tab back");
    })
  );
  assert.deepEqual(userKeyrings(), theirs, "the user's own keyring dir is as it was");
});

// ---------------------------------------------------------------------------
// Tabs the agent takes over (the manager's decision): a claimed Space's
// pages and an adopted tab have every password and card detail the agent
// didn't set emptied before its first call.

/** A Space of the user's own with one tab, loaded as the user loads a URL (zen-core's tests do the same). */
const userSpace = (name, url) =>
  chrome(
    `${SERVICE}
     const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const ws = await win.gZenWorkspaces.createAndSaveWorkspace(arg.name, undefined, true);
     const tab = W.addBackgroundTab(win, ws.uuid);
     tab.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     for (const end = Date.now() + 10000; tab.linkedBrowser.currentURI.spec !== arg.url && Date.now() < end; ) await new Promise(r => win.setTimeout(r, 25));
     ZeniusService.spaces.refresh();
     win.__zenInputUserTab = tab;
     return { space: ZeniusService.spaces.peekUuid(ws.uuid).id, uuid: ws.uuid };`,
    { name: `${name} ${Date.now()}`, url }
  );

/** Run `code` in the user's own tab (privileged, for setUserInput). */
const inUserTab = code =>
  chrome(
    `${SERVICE}
     return ZeniusService.content(win.__zenInputUserTab.linkedBrowser.browsingContext, "dev#evalContent", { code: arg, privileged: true });`,
    code
  );

/** The user types into their own tab: the values set as their input sets them. */
const userFillsOwnTab = values =>
  inUserTab(`for (const [sel, v] of Object.entries(${JSON.stringify(values)})) document.querySelector(sel).setUserInput(v); return true;`);

test("a tab the agent adopts has the passwords it didn't set emptied before its first call", async () => {
  const { space, uuid } = await userSpace("zen-input adopt", `${site.origin}/handback`);
  try {
    await h.until(() => inUserTab("return document.readyState === 'complete' && !!document.querySelector('#pass')"), "the user's page");
    await userFillsOwnTab({ "#user": "their-name", "#pass": "their-secret" });
    await claimAllowed({ space });
    const [userTab] = (await h.call("tabs.list", { space })).filter(t => t.url.endsWith("/handback"));
    const { label } = await h.call("pages.adopt", { space, tab: userTab.tab, as: "adopted" });
    const fields = await h.call("page.evaluate", {
      space,
      page: label,
      fn: "({ user: document.querySelector('#user').value, pass: document.querySelector('#pass').value })",
      isFunction: false,
    });
    assert.deepEqual(fields, { user: "their-name", pass: "" }, "the password is gone before the agent's first call; the username stays");
    const events = await h.until(
      async () => {
        const e = (await h.call("page.events", { space, page: label })).filter(x => x.method === "Zenius.passwordsCleared");
        return e.length && e;
      },
      "a Zenius.passwordsCleared event"
    );
    assert.equal(events[0].params.passwords, 1);
    assert.match(events[0].params.message, /didn't set/);
    assert.ok(!JSON.stringify(events).includes("their-secret"));
  } finally {
    await h.call("spaces.finish", { space, keep: [] }).catch(() => {});
    await chrome(`delete win.__zenInputUserTab; await win.gZenWorkspaces.removeWorkspace(arg); return true;`, uuid).catch(() => {});
  }
});

test("a Space the agent claims back after the user stopped it has their passwords emptied", () =>
  inWatchedPage("/handback", async page => {
    await page.fill("#agentpass", "agent-own-secret");
    await chrome(`${SERVICE} ${UI} UI.stopByUser(ZeniusService.spaces.peek(arg)); return true;`, page.spaceId);
    // The Space is the user's now: they type a password in its page.
    await h.userClick(page, "#pass");
    await h.userPress(page, ..."theirs");
    await h.until(() => h.asUser(page, "return document.querySelector('#pass').value.length === 6"), "the user's typing");
    // The user asks the agent to go on there.
    await ageUserInput(page);
    await claimAllowed(space(page));
    assert.deepEqual(await page.evaluate(() => [pass.value, agentpass.value]), ["", "agent-own-secret"]);
  }));
