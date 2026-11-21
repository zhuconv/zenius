// Saved logins, addresses and cards stay out of agent tabs
// (input/autofill.sys.mjs): an agent tab gets no login autofill on load, no
// suggestion popups, and nothing it submits reaches the password manager;
// the user's own tabs still autofill. On an https site with a saved login,
// hidden and watched, with the user's view checked around each case.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";
import { loginSite } from "./https-fixture.mjs";

let h;
let task;
let site;

const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
const SERVICE = `const { ZeniusService } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/service.sys.mjs");`;
const SAVED = { username: "saved-user", password: "saved-secret-pass" };

before(async () => {
  h = await openHarness("logins");
  task = await h.taskSpace("zen-input logins");
  // This run only: the dev Zen trusts the fixture, with one saved login.
  site = await loginSite(h, SAVED);
});

after(async () => {
  try {
    await site?.close();
  } finally {
    await h?.finish();
  }
});

const browserIdOf = page => chrome(`${SERVICE} return ZeniusService.resolvePage(arg).browser.browserId;`, { space: page.spaceId, page: page.label });
const formProcessed = browserId => site.formProcessed(browserId);

const fields = page => page.evaluate(() => ({ user: document.querySelector("#user").value, pass: document.querySelector("#pass").value }));
const AUTOCOMPLETE_POPUPS = ["PopupAutoComplete", "PopupAutoCompleteRichResult"];
async function noSuggestions(how, what) {
  await h.sleep(400);
  const open = (await h.openPopups()).filter(id => AUTOCOMPLETE_POPUPS.includes(id));
  assert.deepEqual(open, [], `${how}: no suggestions popup after ${what}`);
}

test("the user's own tab still fills the saved login on load", async () => {
  const before = await h.call("dev.viewState");
  // The user opens the page in their own tab and looks at it: the password
  // manager waits for a hidden page to show before it fills.
  const tab = await chrome(
    `const tab = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
     win.__zenInputUserTab = tab;
     win.__zenInputUserPrevious = win.gBrowser.selectedTab;
     win.gBrowser.selectedTab = tab;
     return tab.linkedBrowser.browserId;`,
    `${site.origin}/login`
  );
  try {
    assert.equal(await formProcessed(tab), "filled", "the password manager filled the form");
    const values = await chrome(
      `return ZeniusService.content(win.__zenInputUserTab.linkedBrowser.browsingContext, "dev#evalContent", {
         code: "return { user: document.querySelector('#user').value, pass: document.querySelector('#pass').value };", privileged: false });`.replace(
        "return ZeniusService",
        `${SERVICE} return ZeniusService`
      )
    );
    assert.deepEqual(values, { user: SAVED.username, pass: SAVED.password });
  } finally {
    await chrome(
      `win.gBrowser.selectedTab = win.__zenInputUserPrevious;
       win.gBrowser.removeTab(win.__zenInputUserTab);
       delete win.__zenInputUserTab;
       delete win.__zenInputUserPrevious;
       return true;`
    );
  }
  assert.deepEqual(await h.call("dev.viewState"), before, "the user's view is unchanged");
});

test("an agent tab gets no saved login on load and no suggestions, hidden or watched", () =>
  h.bothViews(task, `${site.origin}/login`, async (page, how) => {
    assert.equal(await formProcessed(await browserIdOf(page)), "no_saved_logins", `${how}: the password manager found nothing to fill`);
    assert.deepEqual(await fields(page), { user: "", pass: "" }, `${how}: both fields stay empty`);
    await page.click("#user");
    await noSuggestions(how, "a click on the username");
    // Typing what starts the saved username is what opens the popup when unguarded.
    await page.keyboard.type("sav");
    await noSuggestions(how, "typing the start of the saved username");
    await page.click("#pass");
    await noSuggestions(how, "a click on the password");
  }));

test("an agent's own login reaches no password manager, hidden or watched", () =>
  h.bothViews(task, `${site.origin}/login`, async (page, how) => {
    const user = `agent-${how}`;
    await page.fill("#user", user);
    await page.fill("#pass", "agent-typed-secret");
    await page.click("#submit");
    await page.waitForFunction(() => document.querySelector("#state") !== null, undefined, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.querySelector("#state").textContent), `logged in as ${user}`, `${how}: the login worked`);
    await h.sleep(300);
    const doorhanger = await chrome(
      `${SERVICE} return !!win.PopupNotifications.getNotification("password", ZeniusService.resolvePage(arg).browser);`,
      { space: page.spaceId, page: page.label }
    );
    assert.equal(doorhanger, false, `${how}: no "save password" doorhanger, shown or waiting`);
    assert.deepEqual(await site.savedUsernames(), [SAVED.username], `${how}: the password manager holds only the user's own login`);
  }));

test("an agent tab gets no form history suggestions", async () => {
  // Zen ships with form history off (browser.formfill.enable); on for this test.
  await chrome(
    `Services.prefs.setBoolPref("browser.formfill.enable", true);
     const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
     await FormHistory.update({ op: "add", fieldname: "zeninputq", value: "zenius remembered query" });
     return true;`
  );
  try {
    await h.bothViews(task, "data:text/html,<!doctype html><input id=q name=zeninputq>", async (page, how) => {
      await page.click("#q");
      await page.keyboard.type("zen");
      await noSuggestions(how, "typing what the user typed before");
    });
  } finally {
    await chrome(
      // The pref first: removing entries works with form history off too.
      `Services.prefs.clearUserPref("browser.formfill.enable");
       const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
       await FormHistory.update({ op: "remove", fieldname: "zeninputq" });
       return true;`
    );
  }
});

test("an agent tab saves no form history, whatever the pref; the user's own tab does", async () => {
  const FH = `const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");`;
  const saved = () => chrome(`${FH} return (await FormHistory.search(["value"], { fieldname: "zeninputsave" })).map(e => e.value).sort();`);
  // Zen ships with form history off; on, so that only the guard stops it.
  await chrome(`Services.prefs.setBoolPref("browser.formfill.enable", true); return true;`);
  try {
    await h.bothViews(task, `${site.origin}/search`, async (page, how) => {
      // Typed, so the field holds a value as if a user had entered it.
      await page.click("#q");
      await page.keyboard.type(`agent query ${how}`);
      await page.click("#go");
      await h.until(async () => (await page.evaluate(() => location.pathname)) === "/searched", "the search results");
      await h.sleep(300);
      assert.deepEqual(await saved(), [], `${how}: the agent's search is not saved`);
    });

    // The control: the user searches in their own tab, and that is saved.
    await chrome(
      `${SERVICE}
       const tab = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
       win.__zenInputUserTab = tab;
       for (const end = Date.now() + 10000; !(tab.linkedBrowser.currentURI.spec === arg && tab.linkedBrowser.browsingContext.currentWindowGlobal?.isInitialDocument === false) && Date.now() < end; ) await new Promise(r => win.setTimeout(r, 25));
       await new Promise(r => win.setTimeout(r, 200));
       // As the user's typing sets it (setUserInput), then their Enter.
       await ZeniusService.content(tab.linkedBrowser.browsingContext, "dev#evalContent", {
         code: "document.querySelector('#q').setUserInput('user query'); document.querySelector('#f').requestSubmit(); return true;",
         privileged: true,
       });
       return true;`,
      `${site.origin}/search`
    );
    assert.deepEqual(await h.until(async () => (await saved()).length && (await saved()), "the user's search to be saved"), ["user query"]);
  } finally {
    await chrome(
      `${FH}
       Services.prefs.clearUserPref("browser.formfill.enable");
       if (win.__zenInputUserTab) win.gBrowser.removeTab(win.__zenInputUserTab);
       delete win.__zenInputUserTab;
       await FormHistory.update({ op: "remove", fieldname: "zeninputsave" });
       return true;`
    );
  }
});
