// What a page in an agent tab can reach through zen-snapshot's sandbox.
// The sandbox shares the
// page's compartment, so any object of ours a page function receives leads
// it to the sandbox's global. Checked here:
//   - a page that traps every method and getter of its realm (hostile-page.js)
//     gets no object of ours from the agent's snapshots and locator queries,
//     whether its traps return real values or String objects that check
//     what their methods are given;
//   - a page handed its sandbox's global anyway finds no chrome helper on it,
//     and nothing it can call there returns a frame's text, while the
//     agent's own snapshot still shows that frame.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const HOSTILE = readFileSync(new URL("./hostile-page.js", import.meta.url), "utf8");
const SECRET = "SECRET-FRAME-TEXT-4242";
let h;
let other;
let frameUrl;

before(async () => {
  h = await setup("hostile");
  // Another origin of the same site (another port of 127.0.0.1): its frame
  // lives in the page's process, where the walker reads it.
  other = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><p>${SECRET}</p><a href="/account">My account</a>`);
  });
  await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
  frameUrl = `http://127.0.0.1:${other.address().port}/`;
});

after(async () => {
  await h?.assertUserViewUnchanged();
  await h?.close();
  await new Promise(resolve => (other ? other.close(resolve) : resolve()));
});

const snap = options => h.call("page.snapshot", { space: h.space, page: "p1", options: { includeRefs: true, ...options } });

// Something for each path of the walker, aria.js and locators.js that reads
// the page: names from labels and labelledby, form values, options, a table,
// generated content, SVG titles, slots, UA widgets and a same-site frame.
const PAGE = `
  <h1>Hostile page</h1>
  <button id="icon"></button>
  <button aria-labelledby="lbl">x</button><span id="lbl">Labelled</span>
  <label for="name">Name</label><input id="name" name="q" value="Ada" placeholder="Your name">
  <label>Remember <input type="checkbox" checked></label>
  <input type="password" value="hunter2" aria-label="Secret">
  <input type="submit" value="Go"> <input type="file"> <input type="date" value="2000-01-02">
  <textarea aria-label="Notes">two
lines</textarea>
  <select aria-label="Pick"><option>One</option><option selected>Two</option></select>
  <select multiple size="3" aria-label="Many"><optgroup label="Group"><option>A</option><option>B</option></optgroup></select>
  <table><tr><th>Head</th></tr><tr><td>Cell <b>bold</b></td></tr></table>
  <details><summary>More</summary><p>Folded</p></details>
  <a href="/somewhere">Link</a>
  <svg width="20" height="20" role="img"><title>Chart</title><circle cx="10" cy="10" r="4"></circle></svg>
  <div contenteditable="true">Edit me</div>
  <div role="button" tabindex="0" aria-label="Div button"></div>
  <p class="before">text</p><style>.before::before { content: "Generated "; }</style>
  <x-host><span>Slotted</span></x-host>
  <video controls muted width="160" height="90"></video>
  <iframe src="FRAME" width="300" height="80"></iframe>`;

/** Loads PAGE with the frame, then runs `script` as the page's own. */
async function load(html, script) {
  await h.goto("/nav-target");
  await h.page(`
    document.body.innerHTML = ${JSON.stringify(html.replace("FRAME", frameUrl))};
    document.querySelector("x-host")?.attachShadow({ mode: "open" }).append(
      document.createElement("slot"), Object.assign(document.createElement("button"), { textContent: "Shadow button" }));
    await new Promise(resolve => document.querySelector("iframe").addEventListener("load", resolve, { once: true }));
    return true;`);
  if (script) {
    await h.page(`const s = document.createElement("script"); s.textContent = ${JSON.stringify(script)}; document.head.append(s); return true;`);
  }
}

/** A page-realm value, read from chrome so no sandbox of the page's runs. */
const pageValue = async name => JSON.parse(await h.content(`return JSON.stringify(Components.utils.waiveXrays(window)[${JSON.stringify(name)}]);`));

for (const mode of ["spy", "hostile"]) {
  test(`a page that traps every DOM member gets no object of ours (${mode})`, async () => {
    await load(PAGE, HOSTILE.replace("%MODE%", mode));
    const shots = [];
    for (const scope of ["full_page", "viewport"]) shots.push((await snap({ scope })).text);
    // zen-input's locators run aria.js and locators.js in the same sandbox.
    for (const target of ['role:button[name="Labelled"]', 'role:textbox[name*="Name"]', 'role:button[name="Div button"]',
      'css:input[name="q"]', "href:/somewhere"]) {
      await h.call("page.focus", { space: h.space, page: "p1", target, options: {} }).catch(() => {});
    }
    const report = await pageValue("__hostile");
    assert.deepEqual(report.leaks, [], "no page function got an object of ours");
    // Not vacuous: the page's own members ran, for the reads no primordial covers.
    assert.ok(report.calls > 50, `the page's traps ran (${report.calls} calls)`);
    assert.match(shots[0], /button "Labelled"/, "names still come through");
    assert.ok(shots[0].includes(SECRET), "the agent's snapshot still shows the frame");
  });
}

test("a page handed its sandbox's global finds no chrome helper and no frame's text", async () => {
  await load('<button></button><x-host></x-host><iframe src="FRAME" width="300" height="80"></iframe>');
  assert.ok((await snap({ scope: "full_page" })).text.includes(SECRET), "the agent's snapshot shows the frame");
  // As a leak would: the page gets its document's sandbox global.
  await h.content(`
    const { sandboxFor } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/snapshot/sandbox.sys.mjs");
    Components.utils.waiveXrays(window).__leaked = Components.utils.waiveXrays(sandboxFor(window).sandbox);
    return true;`);
  const probe = `(() => {
    const g = window.__leaked;
    const frame = document.querySelector("iframe");
    const options = JSON.stringify({ scope: "full_page", topLevel: true, docIndex: 0 });
    const fake = { frame: () => "", closedShadowRoot: () => null, openShadowRoots: () => [], onScreen: () => null,
      dateTimeFields: () => null, mediaControls: () => null };
    const out = { globals: Object.getOwnPropertyNames(g).filter(k => k.startsWith("__zs")).sort(), hits: [], calls: 0 };
    try { g.__zsWalker.capture(document, options); out.bare = "ran"; } catch (e) { out.bare = e.name; }
    for (const name of out.globals) {
      const api = g[name];
      for (const key of Object.keys(api)) {
        if (typeof api[key] !== "function") continue;
        for (const args of [[frame], [frame, '{"clip":null}'], [document, "{}"], [document, options], [document, options, fake]]) {
          out.calls++;
          try {
            const r = api[key](...args);
            if ((typeof r === "string" ? r : JSON.stringify(r) ?? "").includes(${JSON.stringify(SECRET)})) out.hits.push(name + "." + key);
          } catch {}
        }
      }
    }
    window.__probe = out;
  })();`;
  await h.page(`const s = document.createElement("script"); s.textContent = ${JSON.stringify(probe)}; document.head.append(s); return true;`);
  const out = await pageValue("__probe");
  assert.deepEqual(out.globals, ["__zsAria", "__zsDom", "__zsLocators", "__zsWalker"], "no chrome helper on the global");
  assert.equal(out.bare, "TypeError", "the walker runs only with the helpers the chrome side lends it");
  assert.ok(out.calls > 100, `the probe called what it found (${out.calls})`);
  assert.deepEqual(out.hits, [], "nothing on the global returns the frame's text");
});
