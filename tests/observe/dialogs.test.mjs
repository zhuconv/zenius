// JavaScript dialogs in agent tabs: no UI, no focus move (I1), reported in
// page.info() and answered by acceptDialog/dismissDialog.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

async function untilDialog(page, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const info = await page.call("page.info");
    if (info.dialog) {
      return info.dialog;
    }
    if (Date.now() > end) {
      assert.fail("no dialog opened");
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

/** Tab-modal dialogs Firefox would show for this page's tab. */
function openSubDialogs(page) {
  return env.chrome(
    `const { browser } = ctx.resolvePage(arg);
     const box = win.gBrowser.getTabDialogBox?.(browser);
     return (box?._contentDialogManager?._dialogs?.length ?? 0) + (box?._tabDialogManager?._dialogs?.length ?? 0);`,
    page.P
  );
}

test("prompt() is reported, shows no UI and takes the agent's text", () =>
  env.inSpace("dialog prompt", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("setTimeout(() => { window.answer = prompt('name?', 'def') }, 0)");
    assert.deepEqual(await untilDialog(page), {
      type: "prompt",
      message: "name?",
      defaultPrompt: "def",
      url: `${env.base}/nav-target`,
    });
    assert.equal(await openSubDialogs(page), 0);
    assert.equal(await page.call("page.acceptDialog", { promptText: "zed" }), true);
    assert.equal(await page.evaluate("window.answer"), "zed");
    assert.deepEqual(Object.keys(await page.call("page.info")).includes("dialog"), false);
  }));

test("confirm() and alert() take accept and dismiss", () =>
  env.inSpace("dialog confirm", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("setTimeout(() => { window.yes = confirm('sure?') }, 0)");
    assert.equal((await untilDialog(page)).type, "confirm");
    assert.equal(await page.call("page.dismissDialog"), true);
    assert.equal(await page.evaluate("window.yes"), false);

    await page.evaluate("setTimeout(() => { window.yes = confirm('sure?') }, 0)");
    await untilDialog(page);
    assert.equal(await page.call("page.acceptDialog"), true);
    assert.equal(await page.evaluate("window.yes"), true);

    await page.evaluate("setTimeout(() => { alert('hello'); window.alerted = true }, 0)");
    const dialog = await untilDialog(page);
    assert.equal(dialog.type, "alert");
    assert.equal(dialog.message, "hello");
    assert.equal("defaultPrompt" in dialog, false);
    assert.equal(await page.call("page.acceptDialog"), true);
    assert.equal(await page.evaluate("window.alerted"), true);
  }));

test("accept and dismiss with no dialog open return false", () =>
  env.inSpace("dialog none", async page => {
    await page.goto(`${env.base}/nav-target`);
    assert.equal(await page.call("page.acceptDialog"), false);
    assert.equal(await page.call("page.dismissDialog"), false);
  }));

test("prompt() accepted without text returns its default", () =>
  env.inSpace("dialog default", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("setTimeout(() => { window.answer = prompt('name?', 'fallback') }, 0)");
    await untilDialog(page);
    assert.equal(await page.call("page.acceptDialog"), true);
    assert.equal(await page.evaluate("window.answer"), "fallback");
    await page.evaluate("setTimeout(() => { window.answer = prompt('name?', 'fallback') }, 0)");
    await untilDialog(page);
    assert.equal(await page.call("page.dismissDialog"), true);
    assert.equal(await page.evaluate("window.answer"), null);
  }));

test("releaseDialog hands an open dialog to Firefox's own prompt UI", () =>
  env.inSpace("dialog release", async page => {
    await page.goto(`${env.base}/nav-target`);
    await page.evaluate("setTimeout(() => { window.answer = confirm('yours now?') }, 0)");
    await untilDialog(page);
    assert.equal(await openSubDialogs(page), 0);
    const released = await env.chrome(
      `const { releaseDialog } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/observe/dialogs.sys.mjs");
       const { browser } = ctx.resolvePage(arg);
       return releaseDialog(browser);`,
      page.P
    );
    assert.equal(released, true);
    // The agent no longer sees it; Firefox shows it in the tab.
    assert.equal("dialog" in (await page.call("page.info")), false);
    for (let i = 0; i < 50 && (await openSubDialogs(page)) === 0; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(await openSubDialogs(page), 1);
    assert.equal(await page.call("page.acceptDialog"), false);
    // The user answers it there (OK).
    await env.chrome(
      `const { browser } = ctx.resolvePage(arg);
       const box = win.gBrowser.getTabDialogBox(browser);
       const dialog = [...(box._contentDialogManager?._dialogs ?? []), ...(box._tabDialogManager?._dialogs ?? [])][0];
       // The dialog's document sets its buttons up once it has loaded.
       for (let i = 0; i < 100; i++) {
         try {
           const button = dialog._frame.contentDocument.querySelector("dialog").getButton("accept");
           if (button) {
             button.click();
             return true;
           }
         } catch {}
         await new Promise(r => win.setTimeout(r, 20));
       }
       return false;`,
      page.P
    );
    for (let i = 0; i < 50 && (await page.evaluate("window.answer ?? null")) === null; i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(await page.evaluate("window.answer"), true);
  }));

// ---------------------------------------------------------------------------
// Firefox's own questions about what a page did (confirmEx, which no page can
// open) are answered Cancel in an agent tab, and the agent is told.

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A server that records what reaches it, with a form page that posts to itself. */
async function formServer() {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.url !== "/favicon.ico") {
      seen.push(`${req.method} ${req.url}`);
    }
    req.resume();
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(`<!doctype html><title>${req.method}</title><form method="post" action="/posted"><input name="q" value="v"><button id="go">Send</button></form>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { seen, port: server.address().port, close: () => server.close() };
}

test("Firefox's question before a secure page's form goes over http is answered Cancel: the click returns, nothing is sent, the agent is told", () =>
  env.inSpace("dialog insecure form", async page => {
    const target = await formServer();
    await env.chrome(`Services.prefs.setStringPref("network.dns.localDomains", "insecure.test"); return true;`);
    try {
      // A loopback page is a secure context; insecure.test is plain http.
      await page.goto(`${env.base}/nav-target`);
      await page.evaluate(
        `document.body.insertAdjacentHTML("beforeend", '<form method="post" action="http://insecure.test:${target.port}/posted"><input name="q" value="v"><button id="go">Send</button></form>'); 1`
      );
      const started = Date.now();
      const receipt = await page.call("page.click", { target: "#go" });
      assert.ok(Date.now() - started < 5000, `the click took ${Date.now() - started} ms`);
      assert.equal(receipt.refused?.[0]?.kind, "browserConfirmation", JSON.stringify(receipt));
      assert.match(
        receipt.refused[0].message,
        /^Firefox asked to confirm what the page did: "The information you have entered on this page will be sent over an insecure connection.*\(Continue \/ Cancel\)\. An agent doesn't answer the browser's own questions, so zenius answered Cancel/
      );
      await sleep(500);
      assert.deepEqual(target.seen, [], "the form was sent");
      assert.equal(await page.call("page.url"), `${env.base}/nav-target`);
      assert.equal(await openSubDialogs(page), 0);
      const events = (await page.call("page.events")).filter(e => e.method === "Zenius.refused" && e.params.kind === "browserConfirmation");
      assert.equal(events.length, 1);
      assert.equal(events[0].params.url, `${env.base}/nav-target`);
    } finally {
      await env.chrome(`Services.prefs.clearUserPref("network.dns.localDomains"); return true;`);
      target.close();
    }
  }));

test("Firefox's question before a reload sends a form again is answered Cancel: the reload returns, and nothing is sent twice", () =>
  env.inSpace("dialog repost", async page => {
    const site = await formServer();
    try {
      await page.goto(`http://127.0.0.1:${site.port}/form`);
      await page.call("page.click", { target: "#go" });
      await page.call("page.waitForURL", { matcher: { type: "regex", value: "/posted$", flags: "" } });
      assert.deepEqual(site.seen, ["GET /form", "POST /posted"]);
      const started = Date.now();
      const out = await page.call("page.reload", {}).then(
        r => ({ ok: r }),
        e => ({ code: e.code, message: e.message })
      );
      assert.ok(Date.now() - started < 8000, `the reload took ${Date.now() - started} ms: ${JSON.stringify(out)}`);
      await sleep(500);
      assert.deepEqual(site.seen, ["GET /form", "POST /posted"], "the form was sent again");
      assert.equal(await openSubDialogs(page), 0);
      const events = (await page.call("page.events")).filter(e => e.method === "Zenius.refused" && e.params.kind === "browserConfirmation");
      assert.equal(events.length, 1, JSON.stringify(out));
      console.log("reload", JSON.stringify(out).slice(0, 300));
    } finally {
      site.close();
    }
  }));
