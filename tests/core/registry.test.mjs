// Every registered method declares its gate classes in its own module
// (SPI.md, "Dispatch"):
// - `export const access`, the control gate's class (I3);
// - `export const i5`, the web-content gate's class (I5).
// A method added without them fails here, and so does an I5 class that
// doesn't fit the method's name. The gates read the classes. Their name
// lists remain as the fallback for a call without a
// class, so a stale name there would exempt a method added under it later,
// unannounced.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const WEBCONTENT = "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
const NAVIGATION = "chrome://userscripts/content/zenius/methods/navigation.sys.mjs";

let h;
let registry;
before(async () => {
  h = await setup();
  registry = await h.call("dev.registry", {});
});
after(() => h?.close());

test("every registered method declares an access class and an I5 class in its module", () => {
  assert.ok(registry.length > 50, `the registry lists ${registry.length} methods`);
  const missing = registry
    .filter(r => !r.accessDeclared || !r.i5Declared)
    .map(r => `${r.method} (methods/${r.module}.sys.mjs): ${[!r.accessDeclared && "access", !r.i5Declared && "i5"].filter(Boolean).join(" and ")}`);
  assert.deepEqual(
    missing,
    [],
    `declare each in its module's export const access / export const i5 (SPI.md, "Dispatch"):\n${missing.join("\n")}`
  );
});

test("each method's declared I5 class fits its name", () => {
  // The gates go by the declared classes, so the names
  // are what a wrong declaration is still checked against:
  // a page.* method acts in its page's document or outside it, a
  // filechooser.* one in the chooser's frame, a dev.* one exists only in dev
  // profiles, and no other method is document, outside or dev.
  const fits = ({ method, i5 }) => {
    if (method.startsWith("page.")) {
      return i5 === "document" || i5 === "outside";
    }
    if (method.startsWith("filechooser.")) {
      return i5 === "frames";
    }
    if (method.startsWith("dev.")) {
      return i5 === "dev";
    }
    return i5 === "none" || i5 === "frames";
  };
  const wrong = registry.filter(r => r.i5Declared && !fits(r)).map(r => `${r.method} (methods/${r.module}.sys.mjs): declared ${r.i5}`);
  assert.deepEqual(wrong, [], `a class that doesn't fit the method's name:\n${wrong.join("\n")}`);
});

test("the content check refuses non-web documents for every class but outside and dev", async () => {
  // Asked of a document with the system principal, as zen-core's dispatch
  // asks it: with the method's declared class.
  const refused = await h.chrome(
    `const { checkContentCall } = ChromeUtils.importESModule(arg.url);
     const wgp = {
       isClosed: false,
       isInProcess: true,
       documentPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
       documentURI: Services.io.newURI("about:preferences"),
     };
     const bc = { currentWindowGlobal: wgp, embedderElement: null };
     bc.top = bc;
     return arg.methods.filter(([m, i5]) => {
       try {
         checkContentCall(m, bc, i5);
         return false;
       } catch (e) {
         if (e.code !== "ZEN_PAGE_NOT_WEB_CONTENT") {
           throw e;
         }
         return true;
       }
     }).map(([m]) => m);`,
    { url: WEBCONTENT, methods: registry.map(r => [r.method, r.i5]) }
  );
  const expected = registry.filter(r => r.i5 !== "outside" && r.i5 !== "dev").map(r => r.method);
  assert.deepEqual([...refused].sort(), expected.sort());
});

test("the page gates' lists of exempt methods name only registered methods", async () => {
  // OUTSIDE_DOCUMENT skips the I5 gate; UNGATED skips the wait for a
  // pending navigation and the dialog check.
  const lists = await h.chrome(
    `return {
       OUTSIDE_DOCUMENT: [...ChromeUtils.importESModule(arg.webcontent).OUTSIDE_DOCUMENT],
       UNGATED: [...ChromeUtils.importESModule(arg.navigation).UNGATED],
     };`,
    { webcontent: WEBCONTENT, navigation: NAVIGATION }
  );
  const names = new Set(registry.map(r => r.method));
  const stale = Object.entries(lists).flatMap(([list, methods]) => methods.filter(m => !names.has(m)).map(m => `${list}: ${m}`));
  assert.deepEqual(stale, [], `these lists name methods nobody registers:\n${stale.join("\n")}`);
});
