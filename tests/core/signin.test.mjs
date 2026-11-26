// The sign-in rules (content/signin.sys.mjs; PROTOCOL.md, Errors,
// ZEN_SIGN_IN_PAGE): a sign-in result, a device-login page and a consent
// screen stay the user's, whoever drives the tab.
//
// 1. A document whose address carries an OAuth authorization response, or
//    whose referrer did, refuses every agent method that reads or acts in
//    documents, and its title, console, dialogs and requests don't reach the
//    agent. An agent that wrote the authorize link with its own PKCE
//    verifier would otherwise read the code after the user's approval.
// 2. A device-login page refuses every action, so an attacker's device code
//    can't be typed or clicked through; reading it still works.
// 3. A consent screen refuses every action too, so an attacker's own app
//    can't be approved through the agent; account choosers, sign-in pages
//    and Google's identity step stay the agent's.
//
// Wherever such a URL travels to the agent, every frame it gets shows it cut
// at its query. Everything here is local: a loopback server plays the
// provider and the app, and the device and consent pages are the tests'
// own, added by dev-only prefs.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { setup, sleep } from "./lib.mjs";

const LEAF = new URL("../../runtime/JS/zenius/content/signin.sys.mjs", import.meta.url);

// A code as providers make them: GitHub's 20 hex characters are the shortest known.
const CODE = "0a1b2c3d4e5f60718293";
const TOKEN = "tok-4e5f60718293";

describe("the rules' tests on URLs (no browser)", () => {
  let L;
  before(async () => {
    L = await import(LEAF);
  });

  test("a code of 16 characters or more, or an access_token or id_token, in the query or the fragment is an authorization response; state doesn't matter", () => {
    const yes = [
      `https://app.example/cb?code=${CODE}&state=s1`,
      `https://app.example/cb?code=${CODE}`,
      `http://localhost:54545/callback?code=${CODE}&state=s`,
      `https://app.example/cb#access_token=${TOKEN}&token_type=bearer`,
      `https://app.example/cb?access_token=${TOKEN}`,
      `https://app.example/cb?id_token=x`,
      `https://app.example/cb#id_token=x`,
      `https://app.example/cb#code=${CODE}`,
      `https://app.example/#/cb?code=${CODE}`,
      `com.example.app:/cb?code=${CODE}`,
      `vscode://ext/cb?code=${CODE}`,
    ];
    const no = [
      "https://shop.example/p?code=SAVE20",
      "https://shop.example/p?code=0a1b2c3d4e5f607",
      `https://app.example/zip?zip_code=${CODE}`,
      `https://app.example/cb?Code=${CODE}`,
      "https://app.example/cb#access_token=",
      "https://app.example/cb?access_token=&id_token=",
      `https://app.example/cb?refresh=${TOKEN}`,
      "https://app.example/search?q=code",
      "not a url",
    ];
    for (const url of yes) {
      assert.equal(L.carriesAuthorizationResponse(url), true, url);
    }
    for (const url of no) {
      assert.equal(L.carriesAuthorizationResponse(url), false, url);
    }
  });

  test("the socket's redaction cuts such URLs at their query wherever they sit in a frame, encoded once or inside another URL, and leaves the rest", () => {
    const frame = JSON.stringify({
      url: `https://app.example/cb?code=${CODE}&state=x`,
      referer: `https://app.example/cb?code=${CODE}`,
      location: `vscode://ext/cb?code=${CODE}`,
      neterror: `about:neterror?e=connectionFailure&u=http%3A//localhost%3A54545/callback%3Fcode%3D${CODE}%26state%3Ds&c=UTF-8`,
      next: `https://a.example/login?next=https://app.example/cb?code=${CODE}`,
      encoded: `https://a.example/l?next=https%3A%2F%2Fapp.example%2Fcb%3Fcode%3D${CODE}`,
      text: `see https://app.example/cb?code=${CODE}&state=x.`,
      promo: "https://shop.example/p?code=SAVE20",
      plain: "https://example.com/path?q=1",
    });
    const out = JSON.parse(L.redactText(frame));
    assert.deepEqual(out, {
      url: "https://app.example/cb",
      referer: "https://app.example/cb",
      location: "vscode://ext/cb",
      neterror: "about:neterror",
      next: "https://a.example/login",
      encoded: "https://a.example/l",
      text: "see https://app.example/cb",
      promo: "https://shop.example/p?code=SAVE20",
      plain: "https://example.com/path?q=1",
    });
    assert.ok(!L.redactText(frame).includes(CODE), "the code is still in the frame");
    const plain = JSON.stringify({ a: "https://example.com/?code=short", b: 1 });
    assert.equal(L.redactText(plain), plain);
  });

  test("a header's relative reference to a callback is cut too: Location, Refresh and Link", () => {
    const base = "http://127.0.0.1:1/authorize";
    assert.equal(L.redactReferences(`/cb?code=${CODE}&state=s1`, base), "/cb");
    assert.equal(L.redactReferences(`0; url=/cb?code=${CODE}`, base), "0; url=/cb");
    assert.equal(L.redactReferences(`</cb?code=${CODE}>; rel="next"`, base), '</cb>; rel="next"');
    assert.equal(L.redactReferences("/promo?code=SAVE20", base), "/promo?code=SAVE20");
    assert.equal(L.redactReferences("text/html; charset=utf-8", base), "text/html; charset=utf-8");
  });

  test("device-login pages: each provider's page where the code is typed, by host and path segment", () => {
    const pages = {
      "https://github.com/login/device": "GitHub's device sign-in page",
      "https://github.com/login/device/select_account": "GitHub's device sign-in page",
      "https://microsoft.com/devicelogin": "Microsoft's device sign-in page",
      "https://www.microsoft.com/devicelogin": "Microsoft's device sign-in page",
      "https://login.microsoft.com/device": "Microsoft's device sign-in page",
      "https://aka.ms/devicelogin": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com/common/oauth2/deviceauth": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/deviceauth": "Microsoft's device sign-in page",
      "https://login.microsoft.com/common/oauth2/deviceauth": "Microsoft's device sign-in page",
      "https://login.windows.net/organizations/oauth2/deviceauth": "Microsoft's device sign-in page",
      // Its US Government and China clouds.
      "https://login.microsoftonline.us/common/oauth2/deviceauth": "Microsoft's device sign-in page",
      "https://login.chinacloudapi.cn/common/oauth2/deviceauth": "Microsoft's device sign-in page",
      "https://login.partner.microsoftonline.cn/organizations/oauth2/v2.0/deviceauth": "Microsoft's device sign-in page",
      "https://microsoft.com/link": "Microsoft's device sign-in page",
      "https://www.microsoft.com/link": "Microsoft's device sign-in page",
      "https://login.live.com/oauth20_remoteconnect.srf": "Microsoft's device sign-in page",
      "https://login.live.com/oauth20_remoteconnect.srf?lc=1033": "Microsoft's device sign-in page",
      "https://www.google.com/device": "Google's device sign-in page",
      "https://google.com/device": "Google's device sign-in page",
      "https://accounts.google.com/device": "Google's device sign-in page",
      "https://accounts.google.com/o/oauth2/device/usercode?flowName=x": "Google's device sign-in page",
      "https://facebook.com/device": "Facebook's device sign-in page",
      "https://www.facebook.com/device": "Facebook's device sign-in page",
      "https://twitch.tv/activate": "Twitch's device sign-in page",
      "https://www.twitch.tv/activate": "Twitch's device sign-in page",
    };
    for (const [url, label] of Object.entries(pages)) {
      assert.equal(L.deviceLoginPage(url), label, url);
    }
    // The same pages as servers read their addresses: escapes decoded,
    // repeated slashes collapsed, any case, and a host's trailing dot.
    const spellings = {
      "https://login.microsoftonline.com/common/OAUTH2/DEVICEAUTH": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com/common/oauth2/%64eviceauth": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com//common/oauth2/deviceauth": "Microsoft's device sign-in page",
      "https://LOGIN.LIVE.COM/OAuth20_RemoteConnect.srf": "Microsoft's device sign-in page",
      "https://login.windows.net./common/oauth2/%64eviceauth": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com/common//oauth2///deviceauth": "Microsoft's device sign-in page",
      "https://github.com/login/%64evice": "GitHub's device sign-in page",
      "https://github.com//login/device": "GitHub's device sign-in page",
      "https://github.com./login/device": "GitHub's device sign-in page",
      "https://GITHUB.COM/LOGIN/DEVICE": "GitHub's device sign-in page",
      "https://github.com/login/device%2F": "GitHub's device sign-in page",
      // A malformed escape elsewhere doesn't keep the rest encoded.
      "https://github.com/login/%64evice/%zz": "GitHub's device sign-in page",
      "https://login.microsoftonline.com/common/oauth2/%64eviceauth/%E0": "Microsoft's device sign-in page",
      "https://login.microsoftonline.com/%E0%A4%A/oauth2/%64eviceauth": "Microsoft's device sign-in page",
      // Encoded twice, or three times.
      "https://github.com/login/%2564evice": "GitHub's device sign-in page",
      "https://login.microsoftonline.com/common/oauth2/%252564eviceauth": "Microsoft's device sign-in page",
      "https://www.twitch.tv./ACTIVATE": "Twitch's device sign-in page",
    };
    for (const [url, label] of Object.entries(spellings)) {
      assert.equal(L.deviceLoginPage(url), label, url);
    }
    for (const url of ["https://login.microsoftonline.us.example/common/oauth2/deviceauth", "https://evil-login.chinacloudapi.cn/common/oauth2/deviceauth", "https://login.live.com/oauth20_authorize.srf", "https://login.live.com/oauth20_remoteconnect", "https://login.windows.net/common/oauth2/authorize", "https://www.microsoft.com/linkedin", "https://github.com/login/devices", "https://github.com/login/%64evices", "https://github.com/login/%2564evices", "https://github.com/login/%E0%A4%A", "https://github.com/login/devic%E0", "https://github.com..//login/device", "https://github.com/login", "https://example.com/device", "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH", "https://device.sso.eu-west-2.api.aws/", "http://github.com/login/device", "https://github.com:8443/login/device", "https://evil.example/github.com/login/device"]) {
      assert.equal(L.deviceLoginPage(url), null, url);
    }
    assert.equal(L.deviceLoginPage("http://127.0.0.1:9/dev-device", ["http://127.0.0.1:9/dev-device"]), "a device sign-in page");
  });

  test("consent screens: each provider's page where the user grants an app access, by host and path; account choosers, sign-in pages and Google's identity step aren't", () => {
    const pages = {
      "https://accounts.google.com/signin/oauth/v3/consent?authuser=0&part=x&client_id=y": "Google's consent page",
      "https://accounts.google.com/signin/oauth/consent?authuser=0": "Google's consent page",
      "https://accounts.google.com/signin/oauth/v2/consentsummary?authuser=0": "Google's consent page",
      "https://accounts.google.com/signin/oauth/legacy/consent": "Google's consent page",
      "https://accounts.google.com/signin/oauth/danger?authuser=0": "Google's consent page",
      "https://accounts.google.com/signin/oauth/warning": "Google's consent page",
      "https://github.com/login/oauth/authorize?client_id=x&scope=repo": "GitHub's Authorize page",
      "https://login.microsoftonline.com/common/adminconsent?client_id=x": "Microsoft's consent prompt",
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0/adminconsent?client_id=x&scope=y": "Microsoft's consent prompt",
      "https://login.microsoft.com/organizations/adminconsent": "Microsoft's consent prompt",
      "https://login.microsoftonline.us/common/adminconsent?client_id=x": "Microsoft's consent prompt",
      "https://login.partner.microsoftonline.cn/contoso.partner.onmschina.cn/v2.0/adminconsent?client_id=x": "Microsoft's consent prompt",
      "https://account.live.com/Consent/Update?mkt=en-US": "Microsoft's consent prompt",
      // The same pages however their address is spelled.
      "https://ACCOUNTS.GOOGLE.COM/signin/oauth/V3/Consent": "Google's consent page",
      "https://accounts.google.com.//signin/oauth/v3/%63onsent": "Google's consent page",
      "https://github.com/login/oauth/%61uthorize?client_id=x": "GitHub's Authorize page",
      "https://github.com//login//oauth/authorize": "GitHub's Authorize page",
    };
    for (const [url, label] of Object.entries(pages)) {
      assert.equal(L.consentPage(url), label, url);
    }
    // Account choosers, sign-in pages, the authorize endpoints (which only
    // redirect), Google's identity step and other pages near them.
    for (const url of [
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=openid",
      "https://accounts.google.com/o/oauth2/auth/oauthchooseaccount?client_id=x",
      "https://accounts.google.com/signin/oauth/oauthchooseaccount?client_id=x",
      "https://accounts.google.com/v3/signin/accountchooser?continue=x",
      "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Faccounts.google.com%2Fsignin%2Foauth%2Fv3%2Fconsent",
      "https://accounts.google.com/signin/oauth/id?authuser=0&client_id=x",
      "https://accounts.google.com/signin/oauth/consentful",
      "https://github.com/login?client_id=x&return_to=%2Flogin%2Foauth%2Fauthorize%3Fclient_id%3Dx",
      "https://github.com/login/oauth/select_account?client_id=x",
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/authorized_apps",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&scope=openid",
      "https://login.microsoftonline.com/common/login",
      "https://login.live.com/oauth20_authorize.srf?client_id=x",
      "http://github.com/login/oauth/authorize",
      "https://github.com:8443/login/oauth/authorize",
      "https://evil.example/github.com/login/oauth/authorize",
    ]) {
      assert.equal(L.consentPage(url), null, url);
    }
    assert.equal(L.consentPage("http://127.0.0.1:9/dev-consent", ["http://127.0.0.1:9/dev-consent"]), "a consent page");
  });

  test("Microsoft's work and school prompt shares its addresses with the sign-in page and the chooser: its own settings tell it apart", () => {
    for (const url of [
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
      "https://login.microsoftonline.com/common/login",
      "https://login.microsoft.com/organizations/oauth2/v2.0/authorize",
      "https://login.windows.net/common/oauth2/authorize",
      "https://login.microsoftonline.us/common/oauth2/v2.0/authorize",
      "https://login.chinacloudapi.cn/common/login",
      "https://login.partner.microsoftonline.cn/common/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com./common/login",
    ]) {
      assert.equal(L.consentByConfig(url), "Microsoft's consent prompt", url);
    }
    for (const url of ["http://login.microsoftonline.com/common/login", "https://login.microsoftonline.com:444/common/login", "https://login.live.com/oauth20_authorize.srf", "https://example.com/common/login"]) {
      assert.equal(L.consentByConfig(url), null, url);
    }
    assert.equal(L.consentByConfig("http://127.0.0.1:9/ms/authorize", ["http://127.0.0.1:9/ms/"]), "a consent page");
    // The sign-in page's settings as Microsoft serves them signed out
    // (shortened), which its account chooser shares: no consent.
    const signIn = `//<![CDATA[\n$Config={"fShowPersistentCookiesWarning":false,"urlMsaSignUp":"https://login.live.com/oauth20_authorize.srf","pgid":"ConvergedSignIn","urlPost":"https://login.microsoftonline.com/common/login","sFT":"x"};\n//]]>`;
    assert.equal(L.configShowsConsent(signIn), false);
    // A page whose settings name consent in its page id or its form's
    // target counts as the prompt.
    assert.equal(L.configShowsConsent(`$Config={"pgid":"ConvergedConsent","urlPost":"https://login.microsoftonline.com/common/login"};`), true);
    assert.equal(L.configShowsConsent(`$Config={"pgid":"Permissions","urlPost":"https://login.microsoftonline.com/common/Consent/Set"};`), true);
    assert.equal(L.configShowsConsent(`$Config={"pgid":"Permissions","urlPost":"https:\\/\\/login.microsoftonline.com\\/common\\/Consent\\/Set"};`), true);
    // Consent elsewhere in the settings, or no settings: not the prompt.
    assert.equal(L.configShowsConsent(`$Config={"pgid":"ConvergedSignIn","urlPost":"/common/login","sHelp":"admin consent"};`), false);
    assert.equal(L.configShowsConsent(`var consent = { "pgid": "x" };`), false);
    assert.equal(L.configShowsConsent(""), false);
  });

  test("a document's flag: its own address first, then its referrer, then the device list, then the consent list; only http(s) documents count", () => {
    assert.deepEqual(L.signInPageOf(`https://app.example/cb?code=${CODE}`), { reason: "authorization_response", page: "a sign-in result" });
    assert.deepEqual(L.signInPageOf("https://app.example/home", `https://app.example/cb?code=${CODE}`), {
      reason: "authorization_response",
      page: "the page right after a sign-in result",
    });
    assert.deepEqual(L.signInPageOf("https://github.com/login/device"), { reason: "device_login", page: "GitHub's device sign-in page" });
    assert.deepEqual(L.signInPageOf("https://github.com/login/oauth/authorize?client_id=x"), { reason: "consent", page: "GitHub's Authorize page" });
    assert.deepEqual(L.signInPageOf("http://127.0.0.1:9/c", "", { consent: ["http://127.0.0.1:9/c"] }), { reason: "consent", page: "a consent page" });
    assert.deepEqual(L.signInPageOf("http://127.0.0.1:9/d", "", { device: ["http://127.0.0.1:9/d"] }), { reason: "device_login", page: "a device sign-in page" });
    // The prompt Microsoft shares an address with is checked in the page, not by its address.
    assert.equal(L.signInPageOf("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x"), null);
    assert.equal(L.signInPageOf("https://app.example/home", "https://app.example/"), null);
    assert.equal(L.signInPageOf(`about:neterror?u=http%3A//x/cb%3Fcode%3D${CODE}`), null);
  });

  test("an act's flag by the tab's current address: device-login pages and consent screens only, as each document's address; a sign-in result stays with its document's load", () => {
    assert.deepEqual(L.listedPageOf("https://github.com/login/device"), { reason: "device_login", page: "GitHub's device sign-in page" });
    assert.deepEqual(L.listedPageOf("https://accounts.google.com/signin/oauth/v3/consent?authuser=0"), { reason: "consent", page: "Google's consent page" });
    assert.deepEqual(L.listedPageOf("http://127.0.0.1:9/c/2", { consent: ["http://127.0.0.1:9/c"] }), { reason: "consent", page: "a consent page" });
    assert.deepEqual(L.listedPageOf("http://127.0.0.1:9/d?x=1", { device: ["http://127.0.0.1:9/d"] }), { reason: "device_login", page: "a device sign-in page" });
    assert.equal(L.listedPageOf(`https://app.example/cb?code=${CODE}`), null);
    assert.equal(L.listedPageOf("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x"), null);
    assert.equal(L.listedPageOf("about:blank"), null);
    assert.equal(L.listedPageOf("not a url"), null);
  });

  test("methods are checked by their declared classes: reads and acts in documents and frames, nothing outside them", () => {
    assert.equal(L.signInGateFor("document", "read"), "read");
    assert.equal(L.signInGateFor("document", "mutate"), "act");
    assert.equal(L.signInGateFor("frames", "mutate"), "act");
    assert.equal(L.signInGateFor("frames", "read"), "read");
    for (const i5 of ["outside", "none", "dev", null]) {
      assert.equal(L.signInGateFor(i5, "mutate"), null, String(i5));
    }
  });
});

describe("in the browser", () => {
  let h;
  let base = "";
  let closedPort = 0;
  const beacons = [];
  // Loads of the callback's address with no query, as Back loads a stripped
  // callback that the back-forward cache didn't keep.
  let bareCallbackLoads = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;
    // ?bf keeps the page cacheable, so Back can restore it from the
    // back-forward cache (no-store keeps a page out of it).
    const html = body => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(q.has("bf") ? {} : { "cache-control": "no-store" }) });
      res.end(`<!doctype html><meta charset=utf-8>${body}`);
    };
    switch (url.pathname) {
      // The provider's grant: back to the app's callback, relative as a
      // same-origin provider sends it.
      case "/authorize":
        res.writeHead(302, { location: `/cb?code=${CODE}&state=s1`, "cache-control": "no-store" });
        res.end();
        return;
      // The app's callback, which shows its code, as a manual flow's page does.
      case "/cb":
        if (!url.search) {
          bareCallbackLoads++;
        }
        html(`<title>Code ${q.get("code") ?? ""}</title><p id=code>Your code: ${q.get("code") ?? ""}</p>
<a id=on href="/landing">on</a>
<script>
${q.has("strip") ? `history.replaceState(null, "", "/cb");` : ""}
${q.has("log") ? `console.log("the code is", ${JSON.stringify(CODE)});` : ""}
${q.has("beacon") ? `fetch("/beacon?u=" + encodeURIComponent(location.href));` : ""}
${q.has("alert") ? `setTimeout(() => alert("code " + ${JSON.stringify(CODE)}), 50);` : ""}
${q.has("go") ? `setTimeout(() => { location.href = "/landing"; }, 200);` : ""}
</script>`);
        return;
      // A callback with no title: a tab shows its URL instead.
      case "/cbnotitle":
        html(`<p>signed in</p>`);
        return;
      case "/beacon":
        beacons.push(q.get("u"));
        res.writeHead(204);
        res.end();
        return;
      case "/landing":
        html(`<title>Landing</title><p>landed</p><a id=next href="/after">after</a>`);
        return;
      case "/after":
        html(`<title>After</title><p>after</p>`);
        return;
      // A page whose link leads to the callback, for a call that ends there.
      case "/start":
        html(`<title>Start</title><p>start</p><a id=to-cb href="/cb?code=${CODE}&state=s2">to the callback</a>
<script>${q.has("later") ? `setTimeout(() => { location.href = "/cb?code=${CODE}&state=s3"; }, 400);` : ""}</script>`);
        return;
      // A page with a frame that lands on a callback (silent sign-in).
      case "/host":
        html(`<title>Host</title><p>host</p><iframe id=f src="/cb?code=${CODE}&state=s4"></iframe>`);
        return;
      case "/promo":
        html(`<title>Promo ${q.get("code")}</title><p>promo</p>`);
        return;
      // The tests' consent screen, and the account chooser before it.
      case "/chooser":
        html(`<title>Choose an account</title><a id=account href="/consent">user@example.com</a>`);
        return;
      case "/consent":
        html(`<title>Consent</title><p>An app wants to access your account</p>
<label>Note <input id=note></label><button id=accept onclick="document.title = 'accepted'">Allow</button>`);
        return;
      // A sign-in host whose consent prompt shares its address with its
      // sign-in page and chooser, as Microsoft's does: the page's own
      // settings tell them apart. ?slow holds the page's end back, so a
      // call can land while it is still loading, its button already there.
      case "/ms/authorize": {
        const consent = q.get("step") === "consent";
        const config = consent
          ? `{"pgid":"ConvergedConsent","urlPost":"https://login.microsoftonline.com/common/Consent/Set"}`
          : `{"pgid":"ConvergedSignIn","urlPost":"https://login.microsoftonline.com/common/login"}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.write(`<!doctype html><meta charset=utf-8><title>${consent ? "Permissions requested" : "Pick an account"}</title>
<script>//<![CDATA[
$Config=${config};
//]]></script>
<button id=go style="position:fixed;left:0;top:0;width:240px;height:120px" onclick="document.title = 'clicked'">${consent ? "Accept" : "user@example.com"}</button>`);
        if (q.has("slow")) {
          setTimeout(() => res.end("<p>loaded</p>"), 1500);
        } else {
          res.end("<p>loaded</p>");
        }
        return;
      }
      // An app that moves to another address in place (history.pushState).
      case "/spa":
        html(`<title>App</title><button id=go style="position:fixed;left:0;top:0;width:240px;height:120px" onclick="document.title = 'clicked'">Go</button>`);
        return;
      // The tests' device-login page.
      case "/device":
        html(`<title>Device</title><label>Code <input id=code></label>
<select id=sel><option>a<option>b</select><input type=file id=file>
<button id=go onclick="document.title = 'clicked'">Continue</button>`);
        return;
      default:
        html(`<title>Page</title><p>page</p>`);
    }
  });

  before(async () => {
    h = await setup();
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    // A loopback port nothing listens on: a CLI's redirect with nobody there.
    closedPort = await new Promise(r => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
  });

  after(async () => {
    await h
      ?.chrome(`for (const pref of ["devicePages", "consentPages", "consentConfigPages"]) Services.prefs.clearUserPref("zenius.signIn." + pref); return true;`)
      .catch(() => {});
    await h?.close();
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  });

  /** A new task with one page; returns {space, page, p}. */
  async function task(prefix) {
    const space = await h.space(prefix);
    const page = (await h.call("pages.list", { space }))[0]?.label ?? "p1";
    return { space, page, p: { space, page } };
  }

  /** The call's error code, or "ok". */
  async function outcome(method, params) {
    try {
      await h.call(method, params);
      return "ok";
    } catch (e) {
      return e.code ?? String(e);
    }
  }

  /** The error the call fails with (it must fail). */
  async function failure(method, params) {
    try {
      await h.call(method, params);
    } catch (e) {
      return e;
    }
    assert.fail(`${method} didn't fail`);
  }

  test("a callback reached through the provider's redirect: every read and act is refused, its title is blank, and its URL is cut wherever the agent sees it", async () => {
    const { space, p } = await task("signin callback");
    try {
      await h.call("page.goto", { ...p, url: `${base}/authorize` });
      for (const [method, params] of [
        ["page.snapshot", p],
        ["page.screenshot", p],
        ["page.title", p],
        ["page.evaluate", { ...p, fn: "document.body.innerText", isFunction: false }],
        ["page.waitForSelector", { ...p, target: "#code", options: { timeout: 1000 } }],
        ["page.click", { ...p, target: "#on" }],
        ["page.fetch", { ...p, url: `${base}/page` }],
      ]) {
        const e = await failure(method, params);
        assert.equal(e.code, "ZEN_SIGN_IN_PAGE", `${method}: ${e.message}`);
        assert.equal(e.data?.reason, "authorization_response", method);
        assert.equal(e.data?.method, method);
        assert.match(e.message, /task\.handOff\(\)/, method);
      }
      assert.equal(await h.call("page.url", p), `${base}/cb`);
      const info = await h.call("page.info", p);
      assert.equal(info.url, `${base}/cb`);
      assert.equal(info.title, "");
      const listed = (await h.call("pages.list", { space }))[0];
      assert.deepEqual([listed.url, listed.title], [`${base}/cb`, ""]);
      const tab = (await h.call("tabs.list", { space }))[0];
      assert.deepEqual([tab.url, tab.title], [`${base}/cb`, ""]);
      // The agent's own pattern can't read the code a character at a time.
      assert.equal(await outcome("page.waitForURL", { ...p, matcher: { type: "regex", value: `code=${CODE.slice(0, 4)}` }, options: { timeout: 500 } }), "ZEN_TIMEOUT");
      assert.equal(await outcome("page.waitForURL", { ...p, matcher: { type: "regex", value: "/cb$" }, options: { timeout: 2000 } }), "ok");
      // The provider's redirect named the callback relative to itself; the
      // events show it cut too.
      const events = JSON.stringify(await h.call("page.events", p));
      assert.ok(!events.includes(CODE), `the code reached page.events: ${events.slice(0, 600)}`);
      assert.ok(events.includes('"location":"/cb"'), "the redirect's Location is missing");
      // Navigation and closing still work.
      await h.call("page.goto", { ...p, url: `${base}/page` });
      assert.match((await h.call("page.snapshot", p)).text, /page/);
      await h.call("page.goto", { ...p, url: `${base}/authorize` });
      await h.call("pages.close", p);
    } finally {
      await h.remove(space);
    }
  });

  test("the fragment form, a callback that strips its query with replaceState, and that callback brought back by Back from the back-forward cache, stay refused", async () => {
    const { space, p } = await task("signin forms");
    try {
      await h.call("page.goto", { ...p, url: `${base}/cb#access_token=${TOKEN}&token_type=bearer` });
      assert.equal(await outcome("page.snapshot", p), "ZEN_SIGN_IN_PAGE");
      // Back restores the stripped callback from the back-forward cache: the
      // same document, whose address no longer shows the code. Under load
      // the cache may not keep it, and Back loads the address it was left
      // at afresh: /cb, a page without the code, which the agent may read.
      // So every try checks that no read shows the code, and the test needs
      // one restore from the cache, which must be refused.
      let restored = 0;
      for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
        await h.call("page.goto", { ...p, url: `${base}/cb?code=${CODE}&strip=1&bf=1` });
        assert.equal(await h.call("page.url", p), `${base}/cb`, "the page didn't strip its query");
        assert.equal(await outcome("page.snapshot", p), "ZEN_SIGN_IN_PAGE");
        await h.call("page.goto", { ...p, url: `${base}/page?bf=1` });
        assert.equal(await outcome("page.snapshot", p), "ok");
        const loads = bareCallbackLoads;
        await h.call("page.evaluate", { ...p, fn: "history.back()", isFunction: false });
        // A load from the server comes before the address changes.
        await h.until(async () => (await h.call("page.url", p)) === `${base}/cb`, 5000);
        const read = await h.call("page.snapshot", p).then(
          s => s.text,
          e => e.code
        );
        if (bareCallbackLoads === loads) {
          restored = attempt;
          assert.equal(read, "ZEN_SIGN_IN_PAGE", "the page Back restored from the back-forward cache was readable");
        } else {
          assert.ok(!read.includes(CODE), `try ${attempt}: Back loaded /cb afresh, and the read showed the code: ${read}`);
        }
      }
      assert.ok(restored, "Back never restored the callback from the back-forward cache in 3 tries");
    } finally {
      await h.remove(space);
    }
  });

  test("the page right after a callback is refused by its referrer, and the one after that is the agent's again", async () => {
    const { space, p } = await task("signin referrer");
    try {
      await h.call("page.goto", { ...p, url: `${base}/cb?code=${CODE}&go=1` });
      await h.until(async () => (await h.call("page.url", p)) === `${base}/landing`, 5000);
      const e = await failure("page.snapshot", p);
      assert.equal(e.code, "ZEN_SIGN_IN_PAGE");
      assert.equal(e.data.page, "the page right after a sign-in result");
      await h.call("page.goto", { ...p, url: `${base}/after` });
      assert.match((await h.call("page.snapshot", p)).text, /after/);
    } finally {
      await h.remove(space);
    }
  });

  test("a call that ends on a callback: a wait the page's own navigation takes there fails instead of reading it", async () => {
    const { space, p } = await task("signin midcall");
    try {
      await h.call("page.goto", { ...p, url: `${base}/start?later=1` });
      const e = await failure("page.waitForSelector", { ...p, target: "#code", options: { timeout: 5000 } });
      assert.equal(e.code, "ZEN_SIGN_IN_PAGE", e.message);
    } finally {
      await h.remove(space);
    }
  });

  test("a callback's console, dialog and requests don't reach the agent", async () => {
    const { space, p } = await task("signin events");
    try {
      beacons.length = 0;
      await h.call("page.goto", { ...p, url: `${base}/cb?code=${CODE}&log=1&beacon=1&alert=1` });
      await h.until(() => beacons.length > 0, 5000);
      await sleep(300);
      const events = await h.call("page.events", p);
      const methods = events.map(e => e.method);
      assert.ok(!methods.includes("Runtime.consoleAPICalled"), methods.join(", "));
      assert.ok(!methods.includes("Page.javascriptDialogOpening"), methods.join(", "));
      assert.ok(!JSON.stringify(events).includes("/beacon"), "the callback's request reached page.events");
      assert.ok(!JSON.stringify(events).includes(CODE));
      // Its dialog isn't the agent's to answer or to wait on.
      assert.notEqual(await outcome("page.acceptDialog", p), "ok");
    } finally {
      await h.remove(space);
    }
  });

  test("a frame that lands on a callback: the page's screenshot is refused while it's there, and calls into it are refused", async () => {
    const { space, p } = await task("signin frame");
    try {
      await h.call("page.goto", { ...p, url: `${base}/host` });
      const shot = await failure("page.screenshot", p);
      assert.equal(shot.code, "ZEN_SIGN_IN_PAGE");
      assert.equal(shot.data.frame, true);
      // The host page itself stays the agent's.
      assert.equal(await h.call("page.title", p), "Host");
      assert.equal(await outcome("page.click", { ...p, target: "p" }), "ok");
      const frameCall = await outcome("page.waitForSelector", { ...p, target: "#code", options: { timeout: 1500 } });
      assert.notEqual(frameCall, "ok", "a call read the frame's callback");
    } finally {
      await h.remove(space);
    }
  });

  test("another page's sign-in result: neither its title nor its URL's code reaches a snapshot's header, spaces.list or the page budget's error", async () => {
    const { space, p } = await task("signin others");
    // Long enough that a title made of it is shortened: the code must go first.
    const untitled = `${base}/cbnotitle?state=${"s".repeat(48)}&code=${CODE}`;
    // Any part of the code is a leak, not only all of it.
    const leak = value => {
      const text = JSON.stringify(value);
      return text.includes(CODE.slice(0, 8)) ? text.slice(0, 1200) : "";
    };
    try {
      await h.call("pages.new", { space, url: `${base}/cb?code=${CODE}&state=s6` });
      await h.call("pages.new", { space, url: untitled });
      await h.call("page.goto", { ...p, url: `${base}/page` });
      const snap = await h.call("page.snapshot", p);
      assert.equal(leak(snap), "");
      assert.match(snap.text.split("\n")[0], /"127\.0\.0\.1:\d+\/cbnotitle"/, "the untitled callback's cut URL is missing from the header");
      assert.equal(leak((await h.call("spaces.list")).taskSpaces.find(s => s.id === space)), "");
      await h.chrome(`Services.prefs.setIntPref("zenius.pageBudget", 3); return true;`);
      const e = await failure("pages.new", { space });
      assert.equal(e.code, "ZEN_PAGE_BUDGET_REACHED", e.message);
      assert.equal(leak({ message: e.message, data: e.data }), "");
    } finally {
      await h.chrome(`Services.prefs.clearUserPref("zenius.pageBudget"); return true;`).catch(() => {});
      await h.remove(space);
    }
  });

  test("a short ?code= (a promo or product code) is no sign-in: the page is the agent's", async () => {
    const { space, p } = await task("signin promo");
    try {
      await h.call("page.goto", { ...p, url: `${base}/promo?code=SAVE20` });
      assert.equal(await h.call("page.title", p), "Promo SAVE20");
      assert.equal(await h.call("page.url", p), `${base}/promo?code=SAVE20`);
    } finally {
      await h.remove(space);
    }
  });

  test("a loopback callback nobody answers: Firefox's error page carries it encoded, and the agent sees it cut everywhere", async () => {
    const { space, p } = await task("signin neterror");
    try {
      const nav = await failure("page.goto", { ...p, url: `http://127.0.0.1:${closedPort}/callback?code=${CODE}&state=s1` });
      assert.ok(!JSON.stringify({ m: nav.message, d: nav.data }).includes(CODE), nav.message);
      for (const method of ["page.snapshot", "page.title", "page.evaluate"]) {
        // The error page may still be coming in: its document answers once it has.
        let code = "ZEN_PAGE_UNRESPONSIVE";
        for (let tries = 0; code === "ZEN_PAGE_UNRESPONSIVE" && tries < 20; tries++) {
          code = await outcome(method, { ...p, fn: "1", isFunction: false });
          if (code === "ZEN_PAGE_UNRESPONSIVE") {
            await sleep(100);
          }
        }
        assert.ok(code === "ZEN_PAGE_NOT_WEB_CONTENT" || code === "ZEN_SIGN_IN_PAGE", `${method}: ${code}`);
      }
      const everything = JSON.stringify([await h.call("page.url", p), await h.call("pages.list", { space }), await h.call("tabs.list", { space }), await h.call("page.events", p)]);
      assert.ok(!everything.includes(CODE), everything.slice(0, 600));
      assert.ok(!everything.includes("code%3D"), everything.slice(0, 600));
    } finally {
      await h.remove(space);
    }
  });

  test("a held callback is unchanged for the user: the hand-off works there, and the rules refuse only the agent", async () => {
    const { space, p } = await task("signin hold");
    try {
      await h.call("page.goto", { ...p, url: `${base}/cb?code=${CODE}&state=s5` });
      await h.call("spaces.handOff", { space });
      // The user's own reading of it, as Zen's chrome does.
      const title = await h.chrome(
        `const rec = ctx.spaces.get(arg); const tab = ctx.pages.tabFor(ctx.pages.get(rec, "p1")); return tab.linkedBrowser.contentTitle;`,
        space
      );
      assert.equal(title, `Code ${CODE}`);
    } finally {
      await h.remove(space);
    }
  });

  test("on a device-login page reads work and every action is refused: each method of class document or frames with access mutate, from the runtime's registry", async () => {
    await h.chrome(`Services.prefs.setStringPref("zenius.signIn.devicePages", arg); return true;`, `${base}/device`);
    const { space, p } = await task("signin device");
    try {
      await h.call("page.goto", { ...p, url: `${base}/device` });
      assert.match((await h.call("page.snapshot", p)).text, /Continue/);
      assert.equal((await h.call("page.screenshot", p)).mimeType, "image/png");
      assert.equal(await h.call("page.title", p), "Device");
      const registry = await h.call("dev.registry");
      const acts = registry.filter(m => (m.i5 === "document" || m.i5 === "frames") && m.access === "mutate").map(m => m.method);
      assert.ok(acts.includes("page.fill") && acts.includes("page.evaluate") && acts.includes("page.click"), acts.join(", "));
      // Class frames has no page gate: its content calls are checked, and
      // reaching one needs a file chooser open.
      const atContentCall = new Set(registry.filter(m => m.i5 === "frames").map(m => m.method));
      const refused = [];
      const notRefused = [];
      for (const method of acts) {
        if (atContentCall.has(method)) {
          continue;
        }
        const code = await outcome(method, { ...p, target: "#code", value: "ABCD-EFGH", fn: "1", isFunction: false });
        (code === "ZEN_SIGN_IN_PAGE" ? refused : notRefused).push(`${method}: ${code}`);
      }
      assert.deepEqual(notRefused, [], `actions not refused on the device page (refused: ${refused.length})`);
      assert.equal(await h.call("page.title", p), "Device", "an action reached the page");
      // Navigation still works.
      await h.call("page.goto", { ...p, url: `${base}/page` });
      assert.equal(await outcome("page.click", { ...p, target: "body" }), "ok");
    } finally {
      await h.chrome(`Services.prefs.clearUserPref("zenius.signIn.devicePages"); return true;`);
      await h.remove(space);
    }
  });

  test("on a consent screen reads work and every action is refused; the account chooser before it stays the agent's", async () => {
    await h.chrome(`Services.prefs.setStringPref("zenius.signIn.consentPages", arg); return true;`, `${base}/consent`);
    const { space, p } = await task("signin consent");
    try {
      // The chooser is the agent's: picking the account works.
      await h.call("page.goto", { ...p, url: `${base}/chooser` });
      await h.call("page.click", { ...p, target: "#account" });
      await h.until(async () => (await h.call("page.url", p)) === `${base}/consent`, 5000);
      assert.match((await h.call("page.snapshot", p)).text, /Allow/);
      assert.equal((await h.call("page.screenshot", p)).mimeType, "image/png");
      assert.equal(await h.call("page.title", p), "Consent");
      const registry = await h.call("dev.registry");
      const acts = registry.filter(m => (m.i5 === "document" || m.i5 === "frames") && m.access === "mutate").map(m => m.method);
      const atContentCall = new Set(registry.filter(m => m.i5 === "frames").map(m => m.method));
      const notRefused = [];
      for (const method of acts) {
        if (atContentCall.has(method)) {
          continue;
        }
        const code = await outcome(method, { ...p, target: "#accept", value: "x", fn: "1", isFunction: false });
        if (code !== "ZEN_SIGN_IN_PAGE") {
          notRefused.push(`${method}: ${code}`);
        }
      }
      assert.deepEqual(notRefused, [], "actions not refused on the consent screen");
      const e = await failure("page.click", { ...p, target: "#accept" });
      assert.equal(e.data?.reason, "consent");
      assert.equal(e.data?.page, "a consent page");
      assert.match(e.message, /task\.handOff\(\)/);
      assert.equal(await h.call("page.title", p), "Consent", "an action reached the page");
      // Navigation still works, and the next page is the agent's.
      await h.call("page.goto", { ...p, url: `${base}/page` });
      assert.equal(await outcome("page.click", { ...p, target: "body" }), "ok");
    } finally {
      await h.chrome(`Services.prefs.clearUserPref("zenius.signIn.consentPages"); return true;`);
      await h.remove(space);
    }
  });

  test("a consent prompt at its sign-in page's address (Microsoft's) is told by its own settings: the sign-in page stays the agent's, and an act sent while the prompt loads waits for the check and is refused", async () => {
    await h.chrome(`Services.prefs.setStringPref("zenius.signIn.consentConfigPages", arg); return true;`, `${base}/ms/`);
    const { space, p } = await task("signin consent settings");
    try {
      // The sign-in page and its chooser: the agent picks the account.
      await h.call("page.goto", { ...p, url: `${base}/ms/authorize?step=signin` });
      await h.call("page.click", { ...p, target: "#go" });
      assert.equal(await h.call("page.title", p), "clicked");
      // The prompt at the same address: reads work, acts are refused.
      await h.call("page.goto", { ...p, url: `${base}/ms/authorize?step=consent` });
      assert.match((await h.call("page.snapshot", p)).text, /Accept/);
      const e = await failure("page.click", { ...p, target: "#go" });
      assert.equal(e.data?.reason, "consent");
      assert.equal(e.data?.page, "a consent page");
      // Sent while the prompt is still loading, its button already parsed:
      // each act waits for the page's settings to be checked, then is
      // refused, in the page's process (page.evaluate) and from the parent
      // (page.mouse) alike.
      await h.call("page.goto", { ...p, url: `${base}/ms/authorize?step=consent&slow=1`, options: { waitUntil: "commit" } });
      const [click, evaluate, mouse] = await Promise.all([
        outcome("page.click", { ...p, target: "#go" }),
        outcome("page.evaluate", { ...p, fn: "document.title = 'evaluated'", isFunction: false }),
        outcome("page.mouse", { ...p, action: "click", x: 60, y: 60 }),
      ]);
      assert.deepEqual({ click, evaluate, mouse }, { click: "ZEN_SIGN_IN_PAGE", evaluate: "ZEN_SIGN_IN_PAGE", mouse: "ZEN_SIGN_IN_PAGE" });
      assert.equal(await h.call("page.title", p), "Permissions requested", "an action reached the prompt");
    } finally {
      await h.chrome(`Services.prefs.clearUserPref("zenius.signIn.consentConfigPages"); return true;`);
      await h.remove(space);
    }
  });

  test("a page that moves in place (history.pushState) to a consent screen's or a device-login page's address refuses actions there, by the tab's address; reads still work", async () => {
    await h.chrome(`Services.prefs.setStringPref("zenius.signIn.consentPages", arg); return true;`, `${base}/consent`);
    await h.chrome(`Services.prefs.setStringPref("zenius.signIn.devicePages", arg); return true;`, `${base}/device`);
    const { space, p } = await task("signin in place");
    try {
      for (const [to, reason] of [
        ["/consent?step=2", "consent"],
        ["/device?step=2", "device_login"],
      ]) {
        await h.call("page.goto", { ...p, url: `${base}/spa` });
        assert.equal(await outcome("page.click", { ...p, target: "#go" }), "ok", "the app's own page");
        await h.call("page.evaluate", { ...p, fn: `document.title = 'app'; history.pushState(null, '', '${to}')`, isFunction: false });
        assert.equal(await h.call("page.url", p), `${base}${to}`);
        const e = await failure("page.click", { ...p, target: "#go" });
        assert.equal(e.data?.reason, reason, to);
        assert.equal(await outcome("page.mouse", { ...p, action: "click", x: 60, y: 60 }), "ZEN_SIGN_IN_PAGE", to);
        assert.equal(await outcome("page.evaluate", { ...p, fn: "document.title = 'evaluated'", isFunction: false }), "ZEN_SIGN_IN_PAGE", to);
        assert.equal(await h.call("page.title", p), "app", `an action reached the page at ${to}`);
        assert.match((await h.call("page.snapshot", p)).text, /Go/, "reads still work");
      }
    } finally {
      await h.chrome(`for (const pref of ["devicePages", "consentPages"]) Services.prefs.clearUserPref("zenius.signIn." + pref); return true;`);
      await h.remove(space);
    }
  });
});
