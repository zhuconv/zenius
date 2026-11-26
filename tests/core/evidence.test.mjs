// The core's evidence (SPI.md, "Flagged and listed"): the agent's own
// flag (page.flag) and the Safe Browsing lists (listed), both kept in
// the observe layer's evidence flag (observe/evidence.sys.mjs), per document.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

const url = path => `${h.base}${path}`;
const EVIDENCE = "chrome://userscripts/content/zenius/observe/evidence.sys.mjs";
/** The observe layer's evidenceOf of a page's tab: {reason: detail}. */
const evidenceOf = (space, label) =>
  h.chrome(
    `const s = ctx.spaces.get(arg.space);
     const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
     return ChromeUtils.importESModule(${JSON.stringify(EVIDENCE)}).evidenceOf(b);`,
    { space, label }
  );
const loaded = async (space, label, part) => {
  const end = Date.now() + 10000;
  while (!(await h.call("page.url", { space, page: label })).includes(part)) {
    assert.ok(Date.now() < end, `${label} never loaded ${part}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

test("page.flag marks the page's document flagged with the agent's reason, until a load brings a new document", async () => {
  const space = await h.space("ev flag");
  const { label } = await h.call("pages.new", { space, url: url("/form?ev=1") });
  await loaded(space, label, "ev=1");
  assert.deepEqual(await evidenceOf(space, label), {}, "a plain page has no evidence");
  const reason = "It imitates the bank's sign-in on another domain";
  assert.deepEqual(await h.call("page.flag", { space, page: label, reason: `  ${reason} ` }), { ok: true });
  assert.deepEqual(await evidenceOf(space, label), { flagged: reason }, "trimmed");
  await h.call("page.reload", { space, page: label, options: {} });
  assert.deepEqual(await evidenceOf(space, label), {}, "a reload starts clean");
  await h.call("pages.close", { space, page: label });
});

test("page.flag refuses a reason that isn't one line of 1 to 200 characters, and a page that isn't there", async () => {
  const space = await h.space("ev refuse");
  const { label } = await h.call("pages.new", { space, url: url("/form?ev=2") });
  await loaded(space, label, "ev=2");
  const bad = [undefined, 5, "", "   ", "x".repeat(201), "two\nlines", "a\u0000b", "a\u0085b", "a\u202eb", "a\u2066b", "a\u200fb", "a\u061cb"];
  for (const reason of bad) {
    await assert.rejects(h.call("page.flag", { space, page: label, reason }), { code: "ZEN_INVALID_ARGUMENT" }, JSON.stringify(reason));
  }
  assert.deepEqual(await h.call("page.flag", { space, page: label, reason: "x".repeat(200) }), { ok: true }, "200 is fine");
  await assert.rejects(h.call("page.flag", { space, page: "p99", reason: "phishing" }), { code: "ZEN_PAGE_NOT_FOUND" });
  await h.call("pages.close", { space, page: label });
});

test("page.flag waits for the agent's control: while the user holds the task it's refused", async () => {
  const space = await h.space("ev held");
  const { label } = await h.call("pages.new", { space, url: url("/form?ev=3") });
  await loaded(space, label, "ev=3");
  await h.call("spaces.handOff", { space });
  await assert.rejects(h.call("page.flag", { space, page: label, reason: "phishing" }), { code: "ZEN_TASK_SPACE_USER_IN_CONTROL" });
  assert.deepEqual(await evidenceOf(space, label), {});
});

test("a task document on a Safe Browsing list is marked listed: the page someone clicked through Gecko's warning to", async () => {
  const space = await h.space("ev listed");
  const { label } = await h.call("pages.new", { space, url: url("/form?ev=4") });
  await loaded(space, label, "ev=4");
  // Mozilla's offline test entry (moztest-phish-simple), served by the fixture.
  // Added to the names the dev profile maps to this machine; the end puts back what was there.
  const foundLocalDomains = await h.chrome(`const found = Services.prefs.getStringPref("network.dns.localDomains", ""); Services.prefs.setStringPref("network.dns.localDomains", [found, ...arg].filter(Boolean).join(",")); return found;`, ["itisatrap.org"]);
  try {
    const trap = `http://itisatrap.org:${new URL(h.base).port}/firefox/its-a-trap.html`;
    // Gecko would show its warning page instead; the click-through loads past the classifier.
    await h.chrome(
      `const s = ctx.spaces.get(arg.space);
       const b = ctx.pages.tabFor(ctx.pages.get(s, arg.label)).linkedBrowser;
       b.loadURI(Services.io.newURI(arg.url), {
         triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
         loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CLASSIFIER,
       });
       return true;`,
      { space, label, url: trap }
    );
    const end = Date.now() + 10000;
    let evidence = {};
    while (!("listed" in (evidence = await evidenceOf(space, label)))) {
      assert.ok(Date.now() < end, `never listed: ${JSON.stringify(evidence)}`);
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(evidence.listed, "phishing: moztest-phish-simple");
    await h.call("page.goto", { space, page: label, url: url("/form?ev=5"), options: {} });
    assert.deepEqual(await evidenceOf(space, label), {}, "a page on no list isn't");
  } finally {
    await h.chrome(`if (arg) Services.prefs.setStringPref("network.dns.localDomains", arg); else Services.prefs.clearUserPref("network.dns.localDomains"); return true;`, foundLocalDomains).catch(() => {});
    await h.call("pages.close", { space, page: label }).catch(() => {});
  }
});
