// The case behind the sign-in rules (v0.1.11): a page that one of the
// user's accounts owns is shared with another of theirs, while Zen is
// signed in to a third. The agent signs in as the owner by itself, shares,
// and switches the user's tabs back, and no rule of zenius's stops it on the
// way: the provider's account chooser and identity step, the callback's
// HTTP redirect, and a code the app emails, read in the user's webmail in
// another of the task's tabs. What stays the user's still does: the
// callback page itself and the page its script redirect leaves, a scopes
// consent screen, a device-code page, and a code typed on a site the user
// had never visited.
//
// Everything is loopback, with made-up accounts: one server plays the
// provider, the app and the webmail, on hosts network.dns.localDomains
// sends to it. Each host is new to this profile's history; the user's own
// tab visits the app before any task here begins.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let port;
let foundLocalDomains = "";
let userSpace = 0;
const stamp = `${process.pid}-${Date.now()}`;
const IDP = `idp-${stamp}.test`;
const APP = `app-${stamp}.test`;
const MAIL = `mail-${stamp}.test`;
/** The same app on a host the user never visited. */
const NEW_APP = `newapp-${stamp}.test`;
/** A sign-in code as providers make them: GitHub's 20 hex characters. */
const CODE = "0a1b2c3d4e5f60718293";
/** The user's accounts: the page's owner, the one to share with, and the one Zen is on. */
const OWNER = "owner@example.test";
const SECOND = "second@example.test";
const VIEWER = "viewer@example.test";

const origin = host => `http://${host}:${port}`;
/** Each app host's shares, as `${email}: ${access}`. */
const shares = new Map();
/** The webmail's messages: {id, from, body}. */
const mail = [];
/** The app's emailed codes, by `${host}|${email}`. */
const codes = new Map();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const q = u.searchParams;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  const html = (body, headers = {}) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(`<!doctype html><meta charset=utf-8>${body}`);
  };
  const redirect = (to, headers = {}) => {
    res.writeHead(302, { location: to, "cache-control": "no-store", ...headers });
    res.end();
  };
  const signedIn = as => ({ "set-cookie": `acct=${encodeURIComponent(as)}; path=/` });
  if (host === IDP) {
    const mode = q.get("mode") === "script" ? "script" : "http";
    const app = q.get("app") ?? "";
    switch (u.pathname) {
      // Both accounts are signed in to the provider in this Zen.
      case "/chooser":
        html(`<title>Choose an account</title><h1>Choose an account</h1>
${[OWNER, VIEWER].map(as => `<p><a id="${as.split("@")[0]}" href="/identity?as=${encodeURIComponent(as)}&app=${app}&mode=${mode}">${as}</a></p>`).join("")}`);
        return;
      // The identity step, shown every time, approved app or not.
      case "/identity":
        html(`<title>Sign in to App</title><p>Sign in to App as ${q.get("as")}</p>
<a id="continue" href="/authorize?as=${encodeURIComponent(q.get("as"))}&app=${app}&mode=${mode}">Continue</a>`);
        return;
      // The grant, for an app the account already uses: no consent screen.
      case "/authorize":
        redirect(`${origin(app)}/cb?code=${CODE}&state=${encodeURIComponent(q.get("as"))}${mode === "script" ? "&script=1" : ""}`);
        return;
      // The tests' own consent screen and device-code page (dev prefs).
      case "/consent":
        html(`<title>Consent</title><p>App wants to read your files</p><button id="allow" onclick="document.title = 'allowed'">Allow</button>`);
        return;
      case "/device":
        html(`<title>Device</title><label>Device code <input id="code"></label><button id="go" onclick="document.title = 'continued'">Continue</button>`);
        return;
    }
  }
  if (host === APP || host === NEW_APP) {
    const me = decodeURIComponent(/(?:^|;\s*)acct=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
    switch (u.pathname) {
      // The user's own sign-in, from before any task.
      case "/welcome":
        html(`<title>App</title><p id="who">Signed in as ${q.get("as")}</p>`, signedIn(q.get("as")));
        return;
      case "/login":
        html(`<title>Log in</title><a id="provider" href="${origin(IDP)}/chooser?app=${host}&mode=${q.get("mode") ?? "http"}">Continue with Provider</a>
<a id="by-email" href="/signin">Sign in with email</a>`);
        return;
      case "/cb": {
        const as = q.get("code") === CODE ? q.get("state") : "";
        if (q.has("script")) {
          html(`<title>Signing in</title><script>location.replace("/app")</script>`, signedIn(as));
        } else {
          redirect("/app", signedIn(as));
        }
        return;
      }
      case "/app":
        html(`<title>App</title><p id="who">Signed in as ${me || "nobody"}</p>
<form action="/share"><input id="share-with" name="email" aria-label="Share with"><select id="access" name="access"><option>view</option><option>edit</option></select><button id="share">Share</button></form>
<ul id="shares">${(shares.get(host) ?? []).map(s => `<li>${s}</li>`).join("")}</ul>`);
        return;
      case "/share":
        // Only the page's owner shares it.
        if (me === OWNER) {
          shares.set(host, [...(shares.get(host) ?? []), `${q.get("email")}: ${q.get("access")}`]);
        }
        redirect("/app");
        return;
      // A sign-in by a code the app emails.
      case "/signin":
        html(`<title>Sign in</title><form action="/send"><input id="email" name="email" aria-label="Email"><button id="send">Send code</button></form>`);
        return;
      case "/send": {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        codes.set(`${host}|${q.get("email")}`, code);
        mail.push({ id: mail.length + 1, from: host, body: `Your code is ${code}` });
        html(`<title>Enter code</title><form action="/verify"><input type="hidden" name="email" value="${q.get("email")}">
<label for="code">Enter the code we sent to your email</label><input id="code" name="code" autocomplete="one-time-code"><button id="verify">Verify</button></form>`);
        return;
      }
      case "/verify":
        if (codes.get(`${host}|${q.get("email")}`) === q.get("code")) {
          redirect("/app", signedIn(q.get("email")));
        } else {
          html(`<title>Wrong code</title><p>wrong code</p>`);
        }
        return;
    }
  }
  if (host === MAIL) {
    switch (u.pathname) {
      // A search lists only the matching mail, newest first.
      case "/search":
        html(`<title>Search</title><ul>${mail
          .filter(m => m.from === q.get("from"))
          .reverse()
          .map(m => `<li><a id="m${m.id}" href="/message?id=${m.id}">From ${m.from}</a></li>`)
          .join("")}</ul>`);
        return;
      case "/message":
        html(`<title>Message</title><p id="body">${mail.find(m => String(m.id) === q.get("id"))?.body ?? ""}</p>`);
        return;
    }
  }
  html(`<title>Page</title><p>page</p>`);
});

const PU = `const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");`;

before(async () => {
  h = await setup();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  foundLocalDomains = await h.chrome(
    `const found = Services.prefs.getStringPref("network.dns.localDomains", "");
     Services.prefs.setStringPref("network.dns.localDomains", [found, ...arg].filter(Boolean).join(","));
     return found;`,
    [IDP, APP, MAIL, NEW_APP]
  );
  // The user's own tab, signed in to the app as the account Zen is on,
  // before any task here began: their visit is in history.
  const welcome = `${origin(APP)}/welcome?as=${encodeURIComponent(VIEWER)}`;
  userSpace = await h.userSpace("case user", welcome);
  await h.until(() => h.chrome(`${PU} return await PlacesUtils.history.hasVisits(arg);`, welcome), 10000);
});
after(async () => {
  await h
    ?.chrome(
      `for (const pref of ["devicePages", "consentPages"]) Services.prefs.clearUserPref("zenius.signIn." + pref);
       if (arg) Services.prefs.setStringPref("network.dns.localDomains", arg); else Services.prefs.clearUserPref("network.dns.localDomains");
       return true;`,
      foundLocalDomains
    )
    .catch(() => {});
  server.closeAllConnections?.();
  server.close();
  await h?.close();
});

const at = p => async url => h.until(async () => (await h.call("page.url", p)) === url, 10000);
const text = async p => (await h.call("page.snapshot", p)).text;
/** The error the call fails with (it must fail). */
async function failure(method, params) {
  try {
    await h.call(method, params);
  } catch (e) {
    return e;
  }
  assert.fail(`${method} didn't fail`);
}

/** Through the app's Continue with Provider, the chooser and the identity step, as `who` (its id there). */
async function signInWithProvider(p, who, mode = "http") {
  await h.call("page.goto", { ...p, url: `${origin(APP)}/login?mode=${mode}` });
  await h.call("page.click", { ...p, target: "#provider" });
  await at(p)(`${origin(IDP)}/chooser?app=${APP}&mode=${mode}`);
  assert.match(await text(p), /Choose an account/);
  await h.call("page.click", { ...p, target: `#${who}` });
  await h.call("page.waitForSelector", { ...p, target: "#continue" });
  await h.call("page.click", { ...p, target: "#continue" });
  await at(p)(`${origin(APP)}/app`);
}

/** Who the user's own tab says is signed in once it loads the app's page (which sets no account), read by the test. */
async function userTabSays() {
  return h.chrome(
    `const browser = ctx.pages.tabsOf(ctx.spaces.get(arg.space))[0].linkedBrowser;
     const before = browser.browsingContext.currentWindowGlobal?.innerWindowId;
     browser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     const end = Date.now() + 10000;
     while (Date.now() < end) {
       const wg = browser.browsingContext.currentWindowGlobal;
       if (wg && wg.innerWindowId !== before && browser.currentURI.spec === arg.url) {
         try {
           const who = await ctx.content(browser.browsingContext, "dev#evalContent", { privileged: true, code: "return document.querySelector('#who')?.textContent ?? null;" });
           if (who) return who;
         } catch {}
       }
       await new Promise(r => win.setTimeout(r, 50));
     }
     return null;`,
    { space: userSpace, url: `${origin(APP)}/app` }
  );
}

test("the agent signs in as the owner by itself, through the provider's chooser and identity step, shares with the user's other account, and switches the user's tabs back", async () => {
  const space = await h.space("case share");
  const p = { space, page: "p1" };
  try {
    // The site keeps one account for all tabs: note the user's before switching.
    await h.call("spaces.noteAccount", { space, site: APP, account: VIEWER });
    await signInWithProvider(p, "owner");
    assert.match(await text(p), new RegExp(`Signed in as ${OWNER}`));

    await h.call("page.fill", { ...p, target: "#share-with", value: SECOND });
    await h.call("page.selectOption", { ...p, target: "#access", values: ["edit"] });
    await h.call("page.click", { ...p, target: "#share" });
    await h.until(async () => (await text(p)).includes(`${SECOND}: edit`), 10000);

    // Back to the account the user's tabs use.
    await signInWithProvider(p, "viewer");
    assert.match(await text(p), new RegExp(`Signed in as ${VIEWER}`));
    const { accountsToRestore } = await h.call("spaces.noteAccount", { space, site: APP, restored: true });
    assert.deepEqual(accountsToRestore, []);
    assert.equal(await userTabSays(), `Signed in as ${VIEWER}`);

    // No hand-off on the way: the task is still the agent's.
    const listed = (await h.call("spaces.list")).taskSpaces.find(s => s.id === space);
    assert.equal(listed?.ownership, "agent");
  } finally {
    await h.remove(space);
  }
});

test("a callback that moves on by a script stays unread, and so does the page it leaves; page.goto() to the app reads it", async () => {
  const space = await h.space("case script");
  const p = { space, page: "p1" };
  try {
    await signInWithProvider(p, "owner", "script");
    const e = await failure("page.snapshot", p);
    assert.equal(e.code, "ZEN_SIGN_IN_PAGE", e.message);
    assert.equal(e.data?.reason, "authorization_response");
    assert.equal(e.data?.page, "the page right after a sign-in result");
    await h.call("page.goto", { ...p, url: `${origin(APP)}/app` });
    assert.match(await text(p), new RegExp(`Signed in as ${OWNER}`));
  } finally {
    await h.remove(space);
  }
});

test("a code the app emails: the agent reads it in the user's webmail, in another of the task's tabs, and enters it in the sign-in it started; on a site the user never visited, the same entry is held", async () => {
  const space = await h.space("case email");
  const p = { space, page: "p1" };
  /** Asks `host` for a code for the owner, then reads the newest message from it, as the guide says. */
  const askAndRead = async host => {
    await h.call("page.goto", { ...p, url: `${origin(host)}/signin` });
    await h.call("page.fill", { ...p, target: "#email", value: OWNER });
    await h.call("page.click", { ...p, target: "#send" });
    await h.call("page.waitForSelector", { ...p, target: "#code" });
    const { label } = await h.call("pages.new", { space });
    const inbox = { space, page: label };
    await h.call("page.goto", { ...inbox, url: `${origin(MAIL)}/search?from=${host}` });
    const newest = await h.call("page.evaluate", { ...inbox, fn: "document.querySelector('li a').id", isFunction: false });
    await h.call("page.click", { ...inbox, target: `#${newest}` });
    await h.call("page.waitForSelector", { ...inbox, target: "#body" });
    const code = /Your code is (\d{6})/.exec(await text(inbox))?.[1];
    await h.call("pages.close", inbox);
    assert.ok(code, "the message's code");
    return code;
  };
  try {
    const code = await askAndRead(APP);
    await h.call("page.fill", { ...p, target: "#code", value: code });
    await h.call("page.click", { ...p, target: "#verify" });
    await at(p)(`${origin(APP)}/app`);
    assert.match(await text(p), new RegExp(`Signed in as ${OWNER}`));

    const held = await askAndRead(NEW_APP);
    const e = await failure("page.fill", { ...p, target: "#code", value: held });
    assert.equal(e.code, "ZEN_SIGN_IN_PAGE", e.message);
    assert.equal(e.data?.reason, "one_time_code");
    assert.equal(e.data?.site, NEW_APP);
  } finally {
    await h.remove(space);
  }
});

test("a scopes consent screen and a device-code page stay the user's: acting there is refused, reading works", async () => {
  await h.chrome(
    `Services.prefs.setStringPref("zenius.signIn.consentPages", arg.consent);
     Services.prefs.setStringPref("zenius.signIn.devicePages", arg.device);
     return true;`,
    { consent: `${origin(IDP)}/consent`, device: `${origin(IDP)}/device` }
  );
  const space = await h.space("case consent");
  const p = { space, page: "p1" };
  try {
    await h.call("page.goto", { ...p, url: `${origin(IDP)}/consent` });
    assert.equal((await failure("page.click", { ...p, target: "#allow" })).data?.reason, "consent");
    assert.match(await text(p), /wants to read your files/);
    await h.call("page.goto", { ...p, url: `${origin(IDP)}/device` });
    assert.equal((await failure("page.fill", { ...p, target: "#code", value: "WDJB-MJHT" })).data?.reason, "device_login");
    assert.equal(await h.call("page.title", p), "Device");
  } finally {
    await h.chrome(`for (const pref of ["devicePages", "consentPages"]) Services.prefs.clearUserPref("zenius.signIn." + pref); return true;`);
    await h.remove(space);
  }
});
