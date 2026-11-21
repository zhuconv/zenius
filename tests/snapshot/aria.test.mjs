// content/snapshot/aria.sys.mjs, the locator, role and name API zen-input
// builds on (docs/SPI.md, "Refs and locators"): Ego's locator grammar and
// matching rules, open but not closed shadow roots, hidden elements counted
// by css: and not by role:, Xray results, and no change to the user's view.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;

const A = `
  const A = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/snapshot/aria.sys.mjs");
  const doc = actor.document;
  const describe = el => el.localName + (el.id ? "#" + el.id : "") + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "");
  const q = loc => A.queryLocator(doc, loc).map(describe);
`;

before(async () => {
  h = await setup("aria");
});

after(async () => {
  await h?.assertUserViewUnchanged();
  await h?.close();
});

test("parseLocator reads Ego's locator forms", async () => {
  const out = await h.content(`${A}
    return [
      'loc=role:button[name="Save \\\\"all\\\\""]',
      "role:Button[name*='sav']",
      "role:link[name=Home page]",
      "loc=css:input[name=\\"q\\"]",
      "css=a.nav",
      "href:/docs?x=1#y",
      "text=Save",
      "role:button",
      "href:",
    ].map(s => A.parseLocator(s));
  `);
  assert.deepEqual(out[0], { kind: "role", role: "button", name: 'Save "all"', nameMode: "exact", raw: 'loc=role:button[name="Save \\"all\\""]' });
  assert.equal(out[1].role, "button");
  assert.equal(out[1].name, "sav");
  assert.equal(out[1].nameMode, "substring");
  assert.equal(out[2].name, "Home page");
  assert.deepEqual(out[3], { kind: "css", selector: 'input[name="q"]', raw: 'loc=css:input[name="q"]' });
  assert.equal(out[4].selector, "a.nav");
  assert.deepEqual(out[5], { kind: "href", href: "/docs?x=1#y", raw: "href:/docs?x=1#y" });
  assert.deepEqual(out.slice(6), [null, null, null]);
});

test("role locators match role and accessible name like Ego", async () => {
  await h.goto("/zoo/aria.html");
  const out = await h.content(`${A}
    const city = doc.getElementById("city");
    return {
      slider: q('role:slider[name="Brightness"]'),
      exactIsCaseSensitive: q('role:slider[name="brightness"]'),
      substring: q('role:button[name*="  ALIGN   left "]'),
      labelledBy: q('role:combobox[name="City"]'),
      singleQuoted: q("role:combobox[name='City']"),
      option: q('role:listboxoption[name="Aurora"]'),
      img: q('role:img[name="Five stars"]'),
      image: q('role:image[name="Five stars"]'),
      presentation: q('role:presentation[name*=""]'),
      cityRole: A.ariaRole(city),
      cityName: A.accessibleName(city),
      panelName: A.accessibleName(doc.querySelector("[role=tabpanel]")),
      xray: Cu.isXrayWrapper(A.queryLocator(doc, 'role:slider[name="Brightness"]')[0]),
    };
  `);
  assert.deepEqual(out.slider, ["div[Brightness]"]);
  assert.deepEqual(out.exactIsCaseSensitive, []);
  assert.deepEqual(out.substring, ["button[Align left]"]);
  assert.deepEqual(out.labelledBy, ["input#city"]);
  assert.deepEqual(out.singleQuoted, ["input#city"]);
  assert.deepEqual(out.option, ["li"]);
  // Chromium's tree names ARIA's img image, and Ego's queries compare its
  // names: role:img matches nothing there (zen-input's input-gaps, D).
  assert.deepEqual(out.img, []);
  assert.deepEqual(out.image, ["div[Five stars]"]);
  assert.deepEqual(out.presentation, [], "Chromium ignores presentation, so Ego never matches it");
  assert.equal(out.cityRole, "combobox");
  assert.equal(out.cityName, "City");
  assert.equal(out.panelName, "General");
  assert.equal(out.xray, true, "callers get Xray views");
});

test("css and role reach open shadow roots, in Ego's order, never closed ones", async () => {
  await h.goto("/zoo/shadow.html");
  const out = await h.content(`${A}
    return {
      deep: q('css:input[placeholder="Deep nested input"]'),
      closed: q('css:input[aria-label="Closed shadow input"]'),
      deepRole: q('role:button[name="Deep nested button"]'),
      closedRole: q('role:button[name="Closed shadow button"]'),
      order: A.queryLocator(doc, "css:button, a").map(el => el.textContent),
    };
  `);
  assert.deepEqual(out.deep, ["input#deep-input"]);
  assert.deepEqual(out.closed, []);
  assert.deepEqual(out.deepRole, ["button#deep"]);
  assert.deepEqual(out.closedRole, []);
  assert.deepEqual(out.order, ["Open card action", "Open card link", "Deep nested button", "Shadow list link"]);
});

test("href matches the resolved path or the full URL", async () => {
  await h.goto("/zoo/long.html");
  const out = await h.content(`${A}
    return {
      path: q("href:/nav-target?i=10").length,
      full: q("href:" + new URL("/nav-target?i=10", doc.location.href).href).length,
      hash: q("href:/zoo/long.html#top").length,
      prefixIsNotEnough: q("href:/nav-target").length,
    };
  `);
  assert.deepEqual(out, { path: 1, full: 1, hash: 1, prefixIsNotEnough: 0 });
});

test("hidden twins count for css but not for role, and bad selectors are invalid arguments", async () => {
  await h.goto("/zoo/aria.html");
  await h.page(`
    for (const hidden of [false, true]) {
      const note = document.createElement("div");
      note.setAttribute("role", "note");
      note.setAttribute("aria-label", "Accepted");
      if (hidden) note.style.display = "none";
      document.body.append(note);
    }
  `);
  const out = await h.content(`${A}
    let error;
    try {
      A.queryLocator(doc, "css:button[[[");
    } catch (e) {
      error = { code: e.code, message: e.message };
    }
    return {
      css: q('css:div[aria-label="Accepted"]').length,
      role: q('role:note[name="Accepted"]').length,
      error,
    };
  `);
  assert.equal(out.css, 2);
  assert.equal(out.role, 1);
  assert.equal(out.error.code, "ZEN_INVALID_ARGUMENT");
  assert.match(out.error.message, /^Invalid selector: css:button\[\[\[/);
});
