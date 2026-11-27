// The sign-in rules' code measure (input/codes.sys.mjs): the agent's entry
// into a one-time-code field goes ahead only on a site the user visited
// before the task began, the tab's site, not the field's frame's. A refusal
// puts nothing in, and leaves the page to the agent to read but not act on,
// until it loads again or the user hands it back. Each site here is new to
// this profile's history (network.dns.localDomains sends it to this test's
// server), and a known one is visited in a tab of the user's first.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
let port;
let foundLocalDomains = "";
const stamp = `${process.pid}-${Date.now()}`;
/** Sites with no visit in the user's history, and one the user visits before any task here. */
const FRESH = `fresh-${stamp}.test`;
const KNOWN = `known-${stamp}.test`;
const CLAIMED = `claimed-${stamp}.test`;

const FIELDS = {
  otp: `<input id="f" autocomplete="one-time-code">`,
  split: [1, 2, 3, 4, 5, 6].map(i => `<input id="d${i}" maxlength="1" inputmode="numeric">`).join(""),
  label: `<label for="f">Verification code</label><input id="f">`,
  named: `<input id="f" name="mfaCode">`,
  bare: `<label for="f">Code</label><input id="f">`,
  enter: `<input id="f" placeholder="Enter code">`,
  sent: `<input id="f" aria-label="Enter the code we sent to your email">`,
  codename: `<input id="f" name="code">`,
  six: `<input id="f" placeholder="Enter the 6-digit number">`,
  phone: `<input id="f" type="tel" placeholder="Enter 10 digit number">`,
  promo: `<label for="f">Promo code</label><input id="f">`,
  zip: `<input id="f" name="zipCode" placeholder="Zip code">`,
  cvc: `<input id="f" autocomplete="cc-csc" aria-label="Security code">`,
  plain: `<input id="f" name="q">`,
};
/** Fields outside the form: a card's security code by its own token. */
const LOOSE = {
  loosecsc: `<input id="f" autocomplete="cc-csc" aria-label="Security code">`,
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.writeHead(200, { "content-type": "text/html" });
  if (u.pathname === "/frame") {
    res.end(`<!doctype html><title>frame</title><iframe src="${u.searchParams.get("src")}"></iframe>`);
    return;
  }
  // The form stays put on Enter, so the field is there for the next key.
  const kind = u.searchParams.get("kind");
  res.end(`<!doctype html><title>code</title>${LOOSE[kind] ?? ""}<form onsubmit="return false">${FIELDS[kind] ?? ""}<button id="b" type="button">Next</button></form>`);
});

let n = 0;
/** A page with a field of this kind on `host`, at an address no load used before. */
const at = (host, kind) => `http://${host}:${port}/code?kind=${kind}&n=${++n}`;
const framing = (host, inner) => `http://${host}:${port}/frame?src=${encodeURIComponent(inner)}&n=${++n}`;

const PU = `const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");`;
const hasVisit = url => h.chrome(`${PU} return await PlacesUtils.history.hasVisits(arg);`, url);

before(async () => {
  h = await setup();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  foundLocalDomains = await h.chrome(
    `const found = Services.prefs.getStringPref("network.dns.localDomains", "");
     Services.prefs.setStringPref("network.dns.localDomains", [found, ...arg].filter(Boolean).join(","));
     return found;`,
    [FRESH, KNOWN, CLAIMED]
  );
  // The user's own visit to the known site, before any task here began.
  const known = at(KNOWN, "plain");
  await h.userSpace("codes known", known);
  await h.until(() => hasVisit(known), 10000);
});
after(async () => {
  await h
    ?.chrome(
      `if (arg) Services.prefs.setStringPref("network.dns.localDomains", arg); else Services.prefs.clearUserPref("network.dns.localDomains"); return true;`,
      foundLocalDomains
    )
    .catch(() => {});
  server.close();
  await h?.close();
});

/** The value of a field in a page's top document, or its first frame's, read by the test, not the agent. */
const valueOf = (space, page, selector, frame = false) =>
  h.chrome(
    `const t = ctx.pages.tabFor(ctx.pages.get(ctx.spaces.get(arg.space), arg.page));
     const top = t.linkedBrowser.browsingContext;
     const bc = arg.frame ? top.children[0] : top;
     if (!bc) return null;
     try {
       return await ctx.content(bc, "dev#evalContent", { privileged: true, code: "return document.querySelector(" + JSON.stringify(arg.selector) + ")?.value ?? null;" });
     } catch {
       return null;
     }`,
    { space, page, selector, frame }
  );
/** The refusal of an entry: no internal field left in it. */
const codeRefused = (method, site = FRESH) => e => {
  assert.equal(e.code, "ZEN_SIGN_IN_PAGE", e.message);
  assert.equal(e.data?.reason, "one_time_code");
  assert.equal(e.data?.method, method);
  assert.equal(e.data?.site, site);
  assert.equal("codeCheck" in e.data, false);
  assert.match(e.message, /task\.handOff\(\{ reason: "sign_in" \}\)/);
  // What zenius found, not a claim about the user.
  assert.ok(e.message.includes(`zenius found no visit to ${site} from before this task`), e.message);
  return true;
};
/** A later act on the page the refusal left read-only. */
const readOnly = method => e => {
  assert.equal(e.code, "ZEN_SIGN_IN_PAGE", e.message);
  assert.equal(e.data?.reason, "one_time_code");
  assert.equal(e.data?.method, method);
  assert.doesNotMatch(e.message, /visit/);
  return true;
};
const goto = (space, url, page = "p1") => h.call("page.goto", { space, page, url });
const fill = (space, target = "#f", page = "p1") => h.call("page.fill", { space, page, target, value: "123456" });

test("a code field on a site the user hadn't visited before the task: fill, a typed key, a paste and an inserted text put nothing in, and the page is then the agent's to read, not to act on", async () => {
  const space = await h.space("codes fresh");
  try {
    await goto(space, at(FRESH, "otp"));
    await assert.rejects(fill(space), codeRefused("page.fill"));
    assert.equal(await valueOf(space, "p1", "#f"), "");
    // The agent's usual retry, a script setting the value, is refused, as is any act.
    await assert.rejects(
      h.call("page.evaluate", { space, page: "p1", fn: "document.querySelector('#f').value = '123456'", isFunction: false }),
      readOnly("page.evaluate")
    );
    await assert.rejects(h.call("page.click", { space, page: "p1", target: "#b" }), readOnly("page.click"));
    assert.equal(await valueOf(space, "p1", "#f"), "");
    // Reads still work.
    assert.match(JSON.stringify(await h.call("page.snapshot", { space, page: "p1" })), /textbox/);

    // A new document is for the agent to act on again, and each way in is refused there.
    for (const [action, extra] of [
      ["type", { text: "1" }],
      ["paste", { text: "123456" }],
      ["insertText", { text: "123456" }],
    ]) {
      await goto(space, at(FRESH, "otp"));
      await h.call("page.click", { space, page: "p1", target: "#f" });
      await assert.rejects(h.call("page.keyboard", { space, page: "p1", action, ...extra }), codeRefused(`page.keyboard.${action}`));
      assert.equal(await valueOf(space, "p1", "#f"), "", action);
    }
  } finally {
    await h.remove(space);
  }
});

test("on a site the user visited before the task, the code goes in", async () => {
  const space = await h.space("codes known");
  try {
    await goto(space, at(KNOWN, "otp"));
    await fill(space);
    assert.equal(await valueOf(space, "p1", "#f"), "123456");
    // The answer holds for the task: a key goes in at once too.
    await goto(space, at(KNOWN, "split"));
    await h.call("page.click", { space, page: "p1", target: "#d1" });
    await h.call("page.keyboard", { space, page: "p1", action: "type", text: "7" });
    assert.equal(await valueOf(space, "p1", "#d1"), "7");
  } finally {
    await h.remove(space);
  }
});

test("split one-character boxes and a field named or labelled for a code count, or one that says just Code; a promo, zip, phone number, card security code or plain field doesn't", async () => {
  const space = await h.space("codes kinds");
  try {
    for (const kind of ["label", "named", "bare", "enter", "sent", "codename", "six"]) {
      await goto(space, at(FRESH, kind));
      await assert.rejects(fill(space), codeRefused("page.fill"), kind);
    }
    await goto(space, at(FRESH, "split"));
    await assert.rejects(fill(space, "#d1"), codeRefused("page.fill"));
    await goto(space, at(FRESH, "split"));
    await h.call("page.click", { space, page: "p1", target: "#d1" });
    await assert.rejects(h.call("page.keyboard", { space, page: "p1", action: "type", text: "123456" }), codeRefused("page.keyboard.type"));
    assert.equal(await valueOf(space, "p1", "#d1"), "");
    for (const kind of ["promo", "zip", "cvc", "loosecsc", "phone", "plain"]) {
      await goto(space, at(FRESH, kind));
      await fill(space);
      assert.equal(await valueOf(space, "p1", "#f"), "123456", kind);
    }
  } finally {
    await h.remove(space);
  }
});

test("Enter, Tab and the arrows still go to a code field, so a code the user typed can be sent; a digit or Backspace doesn't", async () => {
  const space = await h.space("codes keys");
  try {
    await goto(space, at(FRESH, "otp"));
    for (const key of ["Enter", "Tab", "ArrowLeft"]) {
      await h.call("page.press", { space, page: "p1", target: "#f", key });
    }
    await assert.rejects(h.call("page.press", { space, page: "p1", target: "#f", key: "1" }), codeRefused("page.press"));
    await goto(space, at(FRESH, "otp"));
    await assert.rejects(h.call("page.press", { space, page: "p1", target: "#f", key: "Backspace" }), codeRefused("page.press"));
  } finally {
    await h.remove(space);
  }
});

test("the tab's site decides, not the field's frame's: a new site framing a known site's field is refused, a known site framing a new site's field isn't", async () => {
  const space = await h.space("codes frames");
  try {
    await goto(space, framing(FRESH, at(KNOWN, "otp")));
    await h.until(async () => (await valueOf(space, "p1", "#f", true)) === "");
    await assert.rejects(fill(space), codeRefused("page.fill"));
    assert.equal(await valueOf(space, "p1", "#f", true), "");

    await goto(space, framing(KNOWN, at(FRESH, "otp")));
    await h.until(async () => (await valueOf(space, "p1", "#f", true)) === "");
    await fill(space);
    assert.equal(await valueOf(space, "p1", "#f", true), "123456");
  } finally {
    await h.remove(space);
  }
});

test("the user's hand back makes the page the agent's to act on again; the code still goes only to them", async () => {
  const space = await h.space("codes hand back");
  try {
    await goto(space, at(FRESH, "otp"));
    await assert.rejects(fill(space), codeRefused("page.fill"));
    await assert.rejects(h.call("page.evaluate", { space, page: "p1", fn: "1 + 1", isFunction: false }), readOnly("page.evaluate"));
    await h.call("spaces.handOff", { space, reason: "sign_in" });
    await h.chrome(`ctx.spaces.setOwnership(ctx.spaces.get(arg), "agent", { source: "user" }); return true;`, space);
    assert.equal(await h.call("page.evaluate", { space, page: "p1", fn: "1 + 1", isFunction: false }), 2);
    await assert.rejects(fill(space), codeRefused("page.fill"));
  } finally {
    await h.remove(space);
  }
});

test("a refusal past the tries says the page changed, not that no visit was found", async () => {
  const message = await h.chrome(
    `const { codeEntryRefusal } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/signin.sys.mjs");
     return codeEntryRefusal("page.fill", "example.com", true).message;`
  );
  assert.match(message, /its page changed each time zenius checked it/);
  assert.doesNotMatch(message, /visit/);
});

test("a claimed Space of the user's counts their visits from before the claim, made after the Space was", async () => {
  const user = await h.userSpace("codes claimed");
  // The user's own visit in their Space, before the agent claims it.
  const visit = at(CLAIMED, "plain");
  await h.chrome(
    `const tab = ctx.pages.tabsOf(ctx.spaces.get(arg.space))[0];
     tab.linkedBrowser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
     return true;`,
    { space: user, url: visit }
  );
  await h.until(() => hasVisit(visit), 10000);
  await h.claim(user);
  try {
    const { label } = await h.call("pages.new", { space: user });
    await goto(user, at(CLAIMED, "otp"), label);
    await fill(user, "#f", label);
    assert.equal(await valueOf(user, label, "#f"), "123456");
  } finally {
    await h.call("spaces.finish", { space: user, keep: [] }).catch(() => {});
  }
});
