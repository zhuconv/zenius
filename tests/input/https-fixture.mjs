// An https site for the login tests: a self-signed certificate for
// 127.0.0.1 (openssl, here and on the Mac). loginSite() has the dev Zen
// accept it and saves a login for it, for one run.
//
//   GET  /login     a login form (username, password)
//   GET  /handback  the same form, a password field outside it (#agentpass),
//                   and a password field (#pin) in a same-origin iframe
//   GET  /inner     that iframe
//   POST /login     sets a session cookie, then 303 to /account
//   GET  /account   "logged in as <user>" with a valid session, else "logged out"
//   GET  /search    a GET form with one named field (form history)
//   GET  /checkout  an address and card form (autocomplete attributes), a
//                   card form known only by its field names, and a card
//                   field in a cross-origin iframe (https://localhost:<port>/card)
//   GET  /card      that iframe
//   GET  /framed?src=<url>  a button, then an iframe showing <url>
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const LOGIN_PAGE = `<!doctype html><title>Log in</title>
<form id=form method=post action=/login>
  <input id=user name=username autocomplete=username>
  <input id=pass type=password name=password autocomplete=current-password>
  <button id=submit>Log in</button>
</form>`;

const HANDBACK_PAGE = `${LOGIN_PAGE}
<p><input id=agentpass type=password autocomplete=off></p>
<iframe id=frame src=/inner style="width: 240px; height: 40px; border: 0"></iframe>`;

const INNER_PAGE = `<!doctype html><body style="margin: 0">
<input id=pin type=password autocomplete=off style="position: absolute; left: 0; top: 0; width: 200px; height: 30px">`;

const SEARCH_PAGE = `<!doctype html><title>Search</title>
<form id=f action=/searched><input id=q name=zeninputsave><button id=go>Go</button></form>`;

const checkoutPage = port => `<!doctype html><title>Checkout</title>
<form id=checkout method=post action=/paid>
  <input id=name name=name autocomplete=name>
  <input id=street name=street autocomplete=street-address>
  <input id=city name=city autocomplete=address-level2>
  <input id=region name=region autocomplete=address-level1>
  <input id=zip name=zip autocomplete=postal-code>
  <input id=email name=email autocomplete=email>
  <input id=ccnumber name=ccnumber autocomplete=cc-number>
  <input id=ccexp name=ccexp autocomplete=cc-exp>
  <input id=csc name=csc autocomplete=cc-csc>
  <button id=pay>Pay</button>
</form>
<form id=plain>
  <input id=plainnumber name=cardnumber placeholder="Card number">
  <select id=plainmonth name=exp-month><option value="">MM</option><option>01</option><option>02</option></select>
  <input id=plaincvc name=cvc placeholder="CVC">
</form>
<iframe id=cardframe src="https://localhost:${port}/card" style="width: 240px; height: 40px; border: 0"></iframe>`;

const attr = text => text.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`);
const framedPage = src => `<!doctype html><title>Framed</title><body style="margin: 8px">
<button id=topbtn>top</button><br>
<iframe id=frame src="${attr(src)}" style="width: 900px; height: 600px; border: 0"></iframe>`;

const CARD_PAGE = `<!doctype html><body style="margin: 0">
<input id=cardnumber name=cardnumber autocomplete=cc-number style="position: absolute; left: 0; top: 0; width: 200px; height: 30px">`;

/** @param {string} dir a temp dir for the key and certificate */
export async function startHttpsFixture(dir) {
  const keyFile = join(dir, "fixture-key.pem");
  const certFile = join(dir, "fixture-cert.pem");
  // A config file rather than -addext, which the Mac's LibreSSL may lack.
  const configFile = join(dir, "fixture-openssl.cnf");
  writeFileSync(
    configFile,
    "[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = 127.0.0.1\n[v3]\nsubjectAltName = IP:127.0.0.1, DNS:localhost\n"
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-config", configFile],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const cert = readFileSync(certFile, "utf8");
  const sessions = new Map();
  const server = createServer({ key: readFileSync(keyFile), cert }, (req, res) => {
    const url = new URL(req.url, "https://127.0.0.1");
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const id = randomBytes(12).toString("hex");
        sessions.set(id, form.get("username") || "");
        res.writeHead(303, { location: "/account", "set-cookie": `session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax` });
        res.end();
      });
      return;
    }
    if (url.pathname === "/account") {
      const id = /(?:^|;\s*)session=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
      const user = id && sessions.get(id);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><p id=state>${user ? `logged in as ${user}` : "logged out"}</p>`);
      return;
    }
    const pages = {
      "/handback": HANDBACK_PAGE,
      "/inner": INNER_PAGE,
      "/search": SEARCH_PAGE,
      "/searched": "<!doctype html><p id=state>searched</p>",
      "/checkout": checkoutPage(server.address().port),
      "/card": CARD_PAGE,
      "/framed": framedPage(url.searchParams.get("src") ?? "about:blank"),
    };
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pages[url.pathname] ?? LOGIN_PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    port,
    origin: `https://127.0.0.1:${port}`,
    /** The same server as another site: its iframes run out of process. */
    crossOrigin: `https://localhost:${port}`,
    /** The certificate's DER, base64, for the dev Zen's override. */
    certBase64: cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * The fixture, trusted by the dev Zen and with `login` saved for it, for
 * this run only. It also records what the password manager did with each
 * form (Gecko's own test hook). close() undoes all three.
 *
 * @param {{call: (method: string, params?: object) => Promise<any>, artifactDir: string, sleep: (ms: number) => Promise<void>}} h
 * @param {{username: string, password: string}} login
 */
export async function loginSite(h, login) {
  const site = await startHttpsFixture(h.artifactDir);
  const chrome = (code, arg) => h.call("dev.evalChrome", { code, arg });
  // A listening server keeps the test file running: it closes if setup fails.
  await chrome(
    `const certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
     const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
     for (const host of ["127.0.0.1", "localhost"]) overrides.rememberValidityOverride(host, arg.port, {}, certdb.constructX509FromBase64(arg.cert), true);
     // A run the watchdog stopped never reached close(): its test logins go now.
     for (const l of await Services.logins.getAllLogins()) if (l.origin.startsWith("https://127.0.0.1:")) await Services.logins.removeLoginAsync(l);
     const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
     await Services.logins.addLoginAsync(new LoginInfo(arg.origin, arg.origin, null, arg.username, arg.password, "username", "password"));
     const { LoginManagerParent } = ChromeUtils.importESModule("resource://gre/modules/LoginManagerParent.sys.mjs");
     win.__zenInputLoginEvents = [];
     LoginManagerParent.setListenerForTests((name, data) =>
       win.__zenInputLoginEvents.push({ name, browserId: data?.browsingContext?.top?.browserId ?? null, result: data?.data?.autofillResult ?? null }));
     return true;`,
    { port: site.port, cert: site.certBase64, origin: site.origin, ...login }
  ).catch(async e => {
    await site.close();
    throw e;
  });
  return {
    ...site,
    /** The usernames saved for this site. */
    savedUsernames: () =>
      chrome(`return (await Services.logins.getAllLogins()).filter(l => l.origin === arg).map(l => l.username);`, site.origin),
    /** What the password manager concluded for the last form it processed in tab `browserId`. */
    async formProcessed(browserId) {
      for (const end = Date.now() + 10_000; Date.now() < end; await h.sleep(50)) {
        const seen = await chrome(`return win.__zenInputLoginEvents.filter(e => e.name === "FormProcessed" && e.browserId === arg);`, browserId);
        if (seen.length) {
          return seen.at(-1).result;
        }
      }
      throw new Error(`the password manager never processed a form in tab ${browserId}`);
    },
    async close() {
      try {
        await chrome(
          `const { LoginManagerParent } = ChromeUtils.importESModule("resource://gre/modules/LoginManagerParent.sys.mjs");
           LoginManagerParent.setListenerForTests(null);
           delete win.__zenInputLoginEvents;
           for (const l of await Services.logins.getAllLogins()) if (l.origin === arg.origin) await Services.logins.removeLoginAsync(l);
           const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
           for (const host of ["127.0.0.1", "localhost"]) overrides.clearValidityOverride(host, arg.port, {});
           return true;`,
          { origin: site.origin, port: site.port }
        );
      } finally {
        await site.close();
      }
    },
  };
}
