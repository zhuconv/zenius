// The Zenius actor lives only in web content processes (I5, defense in
// depth). Its child, and the
// content modules it loads, never run in the parent's own tab documents or
// in file, privilegedabout or extension processes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
before(async () => {
  h = await setup();
});
after(() => h?.close());

test("the Zenius actor exists in web pages' processes only", async () => {
  const seen = await h.chrome(
    `const W = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
     const path = PathUtils.join(PathUtils.tempDir, "zenius-actor-test-" + Date.now() + ".html");
     await IOUtils.writeUTF8(path, "<title>a file</title>file");
     const urls = { web: arg.web, parent: "about:preferences", file: PathUtils.toFileURI(path) };
     const out = {};
     try {
       for (const [kind, url] of Object.entries(urls)) {
         // A tab of the user's in the Space the window shows, in the
         // background, loading as the URL bar would.
         const tab = W.addBackgroundTab(win, win.gZenWorkspaces.activeWorkspace);
         try {
           tab.linkedBrowser.fixupAndLoadURIString(url, {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
           const end = Date.now() + 15000;
           const doc = () => tab.linkedBrowser.browsingContext?.currentWindowGlobal;
           while (doc()?.documentURI?.spec !== url && Date.now() < end) {
             await new Promise(r => setTimeout(r, 50));
           }
           let actor = false;
           try {
             actor = !!doc().getActor("Zenius");
           } catch {}
           out[kind] = { loaded: doc()?.documentURI?.spec === url, remoteType: tab.linkedBrowser.remoteType, actor };
         } finally {
           win.gBrowser.removeTab(tab, { animate: false });
         }
       }
     } finally {
       await IOUtils.remove(path, { ignoreAbsent: true });
     }
     return out;`,
    { web: `${h.base}/api/text?actor` }
  );
  for (const [kind, s] of Object.entries(seen)) {
    assert.ok(s.loaded, `${kind} loaded: ${JSON.stringify(seen)}`);
  }
  assert.equal(seen.web.actor, true, `a web page has the actor: ${JSON.stringify(seen)}`);
  assert.equal(seen.parent.actor, false, `about:preferences, in the parent, has none: ${JSON.stringify(seen)}`);
  assert.equal(seen.file.actor, false, `a file: page has none: ${JSON.stringify(seen)}`);
});
