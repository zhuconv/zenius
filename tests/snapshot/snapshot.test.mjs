// page.snapshot in a real headless Zen, after Ego's snapshot and ref e2e
// cases (refs/ego-lite), covering:
// header and viewport footer, scopes, ref identity and staleness, subtree
// roots (iframe roots included), same- and cross-process frames, shadow DOM,
// locators that resolve to exactly their node, option errors, and I1.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;

before(async () => {
  h = await setup("snapshot");
});

after(async () => {
  await h?.assertUserViewUnchanged();
  await h?.close();
});

// Every test reads refs; the default result is {text} alone (checked below).
const snap = (options = {}) => h.call("page.snapshot", { space: h.space, page: "p1", options: { includeRefs: true, ...options } });
const body = text => text.split("\n").slice(1);
/** The runtime's own message, without the RPC client's "method: code: " prefix. */
const message = e => e.message.slice(`${e.method}: ${e.code}: `.length);
const refOf = (text, pattern) => {
  const line = text.split("\n").find(l => pattern.test(l));
  assert.ok(line, `no line matches ${pattern}`);
  return Number(/\[ref=(\d+)/.exec(line)[1]);
};

/** The line matching pattern and the lines under it. */
const subtree = (text, pattern) => {
  const lines = text.split("\n");
  const at = lines.findIndex(l => pattern.test(l));
  assert.ok(at >= 0, `no line matches ${pattern}`);
  const indent = lines[at].search(/\S/);
  const end = lines.findIndex((l, i) => i > at && l.search(/\S/) <= indent);
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
};

/** What a printed ref resolves to, through the registry and the ref's own frame. */
function describe(ref) {
  return h.call("dev.evalChrome", {
    code: `
      const { Refs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/snapshot/refs.sys.mjs");
      const { browser } = ctx.resolvePage({ space: ${h.space}, page: "p1" });
      const r = Refs.resolve(browser, ${ref});
      return ctx.content(r.browsingContext, "snapshot/index#describeRef",
        { refId: ${ref}, innerWindowId: r.innerWindowId, localId: r.localId });
    `,
  });
}

test("header, tree and the viewport footer follow Ego's format", async () => {
  await h.goto("/zoo/long.html");
  const { text, refs } = await snap();
  const lines = text.split("\n");
  assert.match(lines[0], new RegExp(`^\\[p1 "zoo: long page" \\| space "[^"]+"\\(${h.space}\\): 1 managed, 0 untracked — p1\\* "zoo: long page"\\]$`));
  assert.equal(lines[1], "root");
  assert.match(lines.at(-1), /^\[more content below the viewport: scrollY=0, viewport \d+ \/ page \d+ px; scroll or use snapshot\(\{ scope: "full_page" \}\)\]$/);
  assert.ok(text.includes('text "Item 1"'));
  assert.ok(!text.includes('text "Item 149"'), "the viewport stops at the fold");
  assert.ok(text.includes('text "Fixed footer"'), "fixed content is on screen");
  assert.ok(refs.length > 0 && refs.every(r => Number.isInteger(r.ref) && r.role));

  const full = await snap({ scope: "full_page" });
  assert.ok(full.text.includes('text "Item 149"'));
  assert.ok(full.text.endsWith("\n") && !full.text.includes("[more content"), "full_page has no footer");
});

test("a node keeps its ref across snapshots; full_page retires refs it didn't print", async () => {
  await h.goto("/zoo/long.html");
  const first = await snap();
  const top = refOf(first.text, /anchor .*#top/);
  const again = await snap();
  assert.equal(refOf(again.text, /anchor .*#top/), top, "same node, same ref");

  const full = await snap({ scope: "full_page" });
  const last = refOf(full.text, /button \[ref=\d+\]$/ );
  assert.equal(refOf(full.text, /anchor .*#top/), top);
  assert.ok(last > 0);

  // Scroll the inner list away: a viewport snapshot keeps refs it didn't print.
  const view = await snap();
  assert.ok(!view.text.includes("Last button"));
  assert.deepEqual(await describe(top), { tag: "a", id: "", text: "Top" });

  await h.goto("/zoo/long.html");
  // dev.evalChrome reports what its code threw as ZEN_INTERNAL, with the message.
  await assert.rejects(describe(top), e => e.message.endsWith(`ZenError: Stale ref: @${top}; take a new snapshot`));
  await assert.rejects(snap({ scope: "subtree", root: `@${top}` }), e => e.code === "ZEN_REF_STALE");
  await assert.rejects(snap({ scope: "subtree", root: "@99999" }), e => e.code === "ZEN_REF_NOT_FOUND" && message(e) === "Unknown ref: @99999");
});

test("refs from a page the tab left for the bfcache are stale", async t => {
  // A same-site goto can swap the tab's top browsing context and keep the
  // old one, with its document, in the bfcache. Whether
  // Gecko keeps it isn't zenius's to decide: a frame still loading keeps the
  // page out, and memory pressure (the Linux server under a parallel test-all) evicts it.
  // So try a few times, and skip, saying what Gecko did, if it never kept one.
  const topId = () =>
    h.call("dev.evalChrome", { code: `return ctx.resolvePage({ space: ${h.space}, page: "p1" }).browser.browsingContext.id;` });
  const tries = [];
  for (let i = 0; i < 3; i++) {
    await h.goto(`/?try=${i}`);
    await h.call("page.waitForLoadState", { space: h.space, page: "p1", state: "networkidle" }).catch(() => {});
    const ref = refOf((await snap()).text, /\[ref=\d+/);
    const before = await topId();
    await h.goto(`/?try=${i}&after=1`);
    const out = await h.call("dev.evalChrome", {
      code: `
        const { Refs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/snapshot/refs.sys.mjs");
        const { browser } = ctx.resolvePage({ space: ${h.space}, page: "p1" });
        let code = "resolved";
        try {
          Refs.resolve(browser, ${ref});
        } catch (e) {
          code = e.code;
        }
        const old = BrowsingContext.get(${before});
        return { code, oldInBFCache: !!old?.isInBFCache, swapped: browser.browsingContext.id !== ${before}, oldAlive: !!old && !old.isDiscarded };
      `,
    });
    if (!out.oldInBFCache) {
      tries.push({ swapped: out.swapped, oldAlive: out.oldAlive, code: out.code });
      continue;
    }
    assert.equal(out.code, "ZEN_REF_STALE");
    await assert.rejects(snap({ scope: "subtree", root: `@${ref}` }), e => e.code === "ZEN_REF_STALE");
    return;
  }
  t.skip(`Gecko kept no old page in the bfcache in ${tries.length} tries: ${JSON.stringify(tries)}`);
});

test("a ref to a node the page moved into another document is stale, also to actions that wait for a node the page took out", async () => {
  // isConnected holds in any document: a same-origin frame's, or a windowless
  // one from createHTMLDocument. A ref names a node of its own page, so the
  // walker's resolve checks the node's document too. Element actions resolve
  // with `detached` and wait while the page has the node out (the input layer,
  // input-gaps 11); they wait only for a node still of the ref's document.
  // Before the check, the click landed in the frame, and the windowless
  // document's node threw ZEN_INTERNAL.
  const moves = {
    "a same-origin frame": `document.getElementById("mvFrame").contentDocument.body.append(b);`,
    "a windowless document": `(window.__mvDoc = document.implementation.createHTMLDocument("mv")).body.append(b);`,
  };
  for (const [into, move] of Object.entries(moves)) {
    await h.goto(`/zoo/frame-child.html?moved=${encodeURIComponent(into)}`);
    await h.page(`
      document.body.insertAdjacentHTML("afterbegin", '<button id="mv" aria-label="Mover">Mover</button><iframe id="mvFrame"></iframe>');
      const root = document.documentElement;
      document.getElementById("mv").addEventListener("click", () => root.setAttribute("data-mv-clicks", String(Number(root.getAttribute("data-mv-clicks") || 0) + 1)));
      return true;
    `);
    const ref = refOf((await snap({ scope: "full_page" })).text, /button "Mover" \[ref=\d+/);
    await h.page(`const b = document.getElementById("mv"); ${move} return true;`);
    const click = await h.call("page.click", { space: h.space, page: "p1", target: `@${ref}`, options: { timeout: 1000 } }).then(
      () => "clicked",
      e => e.code,
    );
    assert.equal(click, "ZEN_REF_STALE", `moved into ${into}`);
    assert.equal(await h.page(`return document.documentElement.getAttribute("data-mv-clicks");`), null, `nothing clicked it in ${into}`);
    await assert.rejects(snap({ scope: "subtree", root: `@${ref}` }), e => e.code === "ZEN_REF_STALE", `a subtree root moved into ${into}`);
  }
});

test("refs follow the page's browserId, not its <browser>: Zen's window copies each keep their own permanentKey", async () => {
  // Zen moves a page's docShell, and with it the browserId, to the copy of
  // its tab the user selects in another window (SPI.md, "Windows: a page is
  // its sync id"). A <browser> holding the same docShell finds its refs.
  await h.goto("/zoo/long.html");
  const ref = refOf((await snap()).text, /\[ref=\d+/);
  const out = await h.call("dev.evalChrome", {
    code: `
      const { Refs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/snapshot/refs.sys.mjs");
      const { browser } = ctx.resolvePage({ space: ${h.space}, page: "p1" });
      const tryResolve = b => {
        try {
          return Refs.resolve(b, ${ref}).localId !== undefined;
        } catch (e) {
          return e.code;
        }
      };
      return {
        copy: tryResolve({ browserId: browser.browserId, browsingContext: browser.browsingContext, permanentKey: {} }),
        other: tryResolve({ browserId: browser.browserId + 1e6, browsingContext: browser.browsingContext, permanentKey: browser.permanentKey }),
      };
    `,
  });
  assert.deepEqual(out, { copy: true, other: "ZEN_REF_NOT_FOUND" });
});

test("refs the agent read before its page moved into the page's copy in a second window still click, and the next snapshot keeps them", async () => {
  // The user views the agent's page from a second window. Zen moves the live
  // docShell, and its browserId, into that window's copy of the tab
  // (the core's design). resolvePage then returns the copy, another
  // <browser>. The window comes first, so the page
  // opens with a copy in it.
  // Helpers after the core's tests/core/windows.test.mjs.
  const W = `
    const Win = ChromeUtils.importESModule("chrome://userscripts/content/zenius/modules/windows.sys.mjs");
    const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
    const wid = w => w?.docShell?.outerWindowID ?? null;
    const nth = n => wins()[n];
    // Timers of no window: a window this code closes takes its own with it.
    const { setTimeout: later } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const sleep = ms => new Promise(r => later(r, ms));
    const until = async (fn, ms = 10000) => {
      for (const end = Date.now() + ms; !(await fn()); ) {
        if (Date.now() > end) throw new Error("timed out: " + fn);
        await sleep(25);
      }
    };
    const focus = async n => {
      nth(n).focus();
      await until(() => wid(Services.focus.activeWindow) === wid(nth(n)));
    };
    const show = async (n, uuid) => {
      const w = nth(n);
      if (w.gZenWorkspaces.activeWorkspace !== uuid) {
        await w.gZenWorkspaces.changeWorkspace(w.gZenWorkspaces.getWorkspaces().find(ws => ws.uuid === uuid));
      }
    };
    const live = () => ctx.resolvePage({ space: arg.space, page: arg.page });
  `;
  const chrome = (code, page = null) => h.call("dev.evalChrome", { code: `${W}${code}`, arg: { space: h.space, page } });
  let page = null;
  try {
    await chrome(`
      const first = nth(0);
      const w = first.OpenBrowserWindow();
      await new Promise(r => w.addEventListener("load", r, { once: true }));
      await w.delayedStartupPromise;
      await w.gZenWorkspaces.promiseInitialized;
      await focus(0);
      return true;
    `);
    page = (await h.call("pages.new", { space: h.space })).label;
    await h.goto("/", page);
    const button = /button "Increment counter"/;
    const refIn = async () => refOf((await h.call("page.snapshot", { space: h.space, page, options: { includeRefs: true } })).text, button);
    const ref = await refIn();
    const moved = await chrome(
      `
      const { tab, browser } = live();
      const id = browser.browserId;
      await until(() => Win.copyIn(tab, nth(1)));
      const copy = Win.copyIn(tab, nth(1));
      await focus(1);
      await show(1, ctx.spaces.agentsSpace.uuid);
      // Zen moves the docShell to the copy the focused window selects. A
      // selection made while the Space switch settles can be undone, so the
      // user selects it again, as they'd click it again.
      await until(() => {
        if (nth(1).gBrowser.selectedTab !== copy) nth(1).gBrowser.selectedTab = copy;
        return copy._zenContentsVisible && copy.linkedBrowser.browserId === id;
      });
      const now = live();
      return {
        inSecondWindow: wid(now.tab.ownerDocument.defaultView) === wid(nth(1)),
        otherBrowser: now.browser !== browser,
        sameBrowserId: now.browser.browserId === id,
      };
    `,
      page
    );
    assert.deepEqual(moved, { inSecondWindow: true, otherBrowser: true, sameBrowserId: true });
    // The fixture's count is the page's own JavaScript, which the agent's
    // isolated world doesn't see: read it in the page's (glue by the observe layer).
    const clicks = () => h.call("dev.evalContent", { space: h.space, page, code: "window.__fixtureState.clicks" });
    const before = await clicks();
    await h.call("page.click", { space: h.space, page, target: `@${ref}` });
    assert.equal(await clicks(), before + 1, "a click through the ref reaches its button");
    assert.equal(await refIn(), ref, "the next snapshot keeps the ref");
  } finally {
    // The user goes back to the first window and closes the second, which
    // hands the page back to the first window's copy.
    await chrome(`
      if (wins().length > 1) {
        await show(1, nth(0).gZenWorkspaces.activeWorkspace).catch(() => {});
        await focus(0);
        for (const w of wins().slice(1)) w.close();
        await until(() => wins().length === 1);
        await sleep(300);
      }
      return true;
    `);
    if (page) {
      await h.call("pages.close", { space: h.space, page });
    }
  }
});

test("subtree prints the ref'd node first, and an iframe root includes its document", async () => {
  await h.goto("/zoo/frames.html");
  const full = await snap({ scope: "full_page" });
  const sameOrigin = full.text.split("\n").filter(l => /^\s*iframe \[ref=\d+\]$/.test(l));
  assert.ok(sameOrigin.length >= 4, "every loaded frame prints");

  const cross = refOf(full.text, /^    iframe \[ref=\d+\]$/);
  const sub = await snap({ scope: "subtree", root: `@${cross}` });
  const lines = body(sub.text);
  assert.match(lines[0], new RegExp(`^iframe \\[ref=${cross}\\]$`));
  assert.equal(lines[1], "  root");
  assert.ok(sub.text.includes('text "Frame child"'));

  // A node inside a cross-origin (out-of-process) frame resolves in its own process.
  const crossLink = refOf(full.text, /anchor \[ref=\d+, loc=href:http:\/\/localhost:\d+\/nav-target/);
  assert.equal((await describe(crossLink)).text, "Frame link");
  const deep = await snap({ scope: "subtree", root: `@${crossLink}` });
  assert.match(body(deep.text)[0], new RegExp(`^anchor \\[ref=${crossLink}, loc=href:http://localhost:\\d+/nav-target, url=http://localhost:\\d+/nav-target\\]$`));

  // A root takes a ref as Ego's parseRef does: "@21", "ref=21" or a bare "21".
  for (const root of [`ref=${cross}`, String(cross), ` ${cross} `]) {
    assert.equal(body((await snap({ scope: "subtree", root })).text)[0], lines[0], `root ${JSON.stringify(root)}`);
  }
  for (const root of ["e21", "@", "21a", ""]) {
    await assert.rejects(snap({ scope: "subtree", root }), e => e.code === "ZEN_INVALID_ARGUMENT", `root ${JSON.stringify(root)}`);
  }
});

test("the default snapshot includes visible iframe content, in and out of process", async () => {
  await h.goto("/zoo/frames.html");
  const { text } = await snap();
  const frames = text.split("\n").filter(l => /^\s*iframe \[ref=\d+\]$/.test(l)).length;
  assert.ok(frames >= 4);
  assert.equal(text.split('text "Frame child"').length - 1 >= 3, true);
  assert.ok(text.includes('text "Srcdoc paragraph"'));
  assert.ok(!text.includes('text "Spacer before lazy frame"'), "below the fold");
});

test("a frame whose process doesn't answer prints empty instead of holding up the snapshot", async () => {
  await h.goto("/zoo/frames.html");
  // A locator unique to the top document, so every other frame gets asked to count it.
  await h.page(`document.body.insertAdjacentHTML("beforeend", '<button aria-label="Only in the top document">x</button>')`);
  await h.call("dev.evalChrome", { code: `Services.prefs.setIntPref("zenius.snapshot.frameTimeoutMs", 800);` });
  try {
    // Busy-loop the cross-site frame's content process for 2.5 s, without waiting for it.
    await h.call("dev.evalChrome", {
      code: `
        const { browsingContext } = ctx.resolvePage({ space: ${h.space}, page: "p1" });
        const frame = browsingContext
          .getAllBrowsingContextsInSubtree()
          .find(bc => bc.currentWindowGlobal?.documentURI?.host === "localhost");
        ctx.content(frame, "dev#evalContent", { privileged: true, code: "const end = Date.now() + 2500; while (Date.now() < end) {}" }).catch(() => {});
      `,
    });
    const t0 = Date.now();
    const { text } = await snap({ scope: "full_page" });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `the snapshot took ${elapsed} ms`);
    assert.ok(!/localhost:\d+\/nav-target/.test(text), "the busy frame prints empty");
    assert.ok(text.includes('text "Srcdoc paragraph"'), "the other frames print");
    assert.ok(text.includes('loc=css:button[aria-label="Only in the top document"]'), "locators still print");
  } finally {
    await h.call("dev.evalChrome", { code: `Services.prefs.clearUserPref("zenius.snapshot.frameTimeoutMs");` });
    // Let the frame's process finish its loop before the next test.
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
});

test("shadow DOM, open and closed, prints in place with refs", async () => {
  await h.goto("/zoo/shadow.html");
  const { text } = await snap({ scope: "full_page" });
  for (const needle of ['text "Slotted title"', 'text "Closed shadow text"', 'button [ref=', 'text "Deep nested button"', 'text "Shadow list link"']) {
    assert.ok(text.includes(needle), needle);
  }
  assert.match(text, /textbox "Closed shadow input" \[ref=\d+\]\n/, "no locator inside a closed root");
  const deep = refOf(text, /textbox \[ref=\d+, loc=css:input\[placeholder="Deep nested input"\]\]/);
  assert.deepEqual(await describe(deep), { tag: "input", id: "deep-input", text: "" });
});

// Material Web's <md-list-item tabindex="-1"> delegates focus to the link in
// its shadow root, so the host isn't focusable and Ego gives it no ref.
test("a shadow host that delegates focus gets no ref from its tabindex", async () => {
  await h.goto("/nav-target");
  await h.page(`
    document.body.innerHTML = '<x-item id="d" tabindex="-1"></x-item><x-item id="c" tabindex="-1"></x-item><x-item id="n" tabindex="-1"></x-item>';
    for (const [id, init] of [["d", { mode: "open", delegatesFocus: true }], ["c", { mode: "closed", delegatesFocus: true }], ["n", { mode: "open" }]]) {
      document.getElementById(id).attachShadow(init).innerHTML = '<a href="#' + id + '">Item ' + id + '</a> <span>more</span>';
    }`);
  const { text, refs } = await snap();
  assert.equal(refs.filter(r => r.role === "anchor").length, 3, text);
  const hosts = refs.filter(r => r.role === "container");
  assert.equal(hosts.length, 1, text);
  assert.deepEqual(await describe(hosts[0].ref), { tag: "x-item", id: "n", text: "" });
});

test("every printed locator matches exactly its own node", async () => {
  for (const page of ["/zoo/forms.html", "/zoo/aria.html", "/zoo/semantics.html"]) {
    await h.goto(page);
    const { refs } = await snap({ scope: "full_page" });
    const withLoc = refs.filter(r => r.loc);
    assert.ok(withLoc.length > 3, `${page} prints locators`);
    const out = await h.call("dev.evalChrome", {
      code: `
        const { Refs } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/snapshot/refs.sys.mjs");
        const { browser, browsingContext } = ctx.resolvePage({ space: ${h.space}, page: "p1" });
        const refs = ${JSON.stringify(withLoc)};
        const bad = [];
        for (const r of refs) {
          const target = Refs.resolve(browser, r.ref);
          const same = await ctx.content(browsingContext, "dev#evalContent", {
            privileged: true,
            arg: { loc: r.loc, ref: r.ref, innerWindowId: target.innerWindowId, localId: target.localId },
            code: \`
              const A = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/snapshot/aria.sys.mjs");
              const R = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/snapshot/registry.sys.mjs");
              const found = A.queryLocator(actor.document, arg.loc);
              const node = R.resolveRef(actor, { refId: arg.ref, innerWindowId: arg.innerWindowId, localId: arg.localId });
              return found.length === 1 && found[0] === node;
            \`,
          });
          if (!same) bad.push(r.loc);
        }
        return bad;
      `,
    });
    assert.deepEqual(out, [], `${page}: locators that don't resolve to their node`);
  }
});

test("a locator prints only on the node it matches, not on a twin proposing the same text", async () => {
  await h.goto("/zoo/aria.html");
  // css: locators can't see into closed shadow roots (Ego's resolver can't),
  // so the light-DOM button is the only match for both buttons' candidate.
  await h.page(`
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "closed" }).innerHTML = '<button aria-label="Twin action">A</button>';
    document.body.insertAdjacentHTML("beforeend", '<button aria-label="Twin action" id="real-twin">B</button>');
  `);
  const { text } = await snap({ scope: "full_page" });
  const twins = text.split("\n").filter(l => l.includes('button "Twin action" [ref='));
  assert.equal(twins.length, 2);
  assert.match(twins[0], /^\s*button "Twin action" \[ref=\d+\]$/);
  assert.match(twins[1], /^\s*button "Twin action" \[ref=\d+, loc=css:button\[aria-label="Twin action"\]\]$/);
  assert.equal((await describe(refOf(twins[1], /./))).id, "real-twin");
});

test("icon buttons and links with no text print their accessible name (pdf.js toolbar)", async () => {
  await h.goto("/nav-target");
  // pdf.js's toolbar: each button holds a 0×0 overflow-hidden label and has a title.
  await h.page(`document.body.innerHTML = \`
    <style>.toolbarButton > span { display: inline-block; width: 0; height: 0; overflow: hidden; }</style>
    <div id="toolbar">
      <button class="toolbarButton" title="Print" type="button"><span>Print</span></button>
      <button class="toolbarButton" title="Save" type="button"><span>Download</span></button>
      <button class="toolbarButton" title="Tools" type="button"></button>
      <button class="toolbarButton" title="Hidden title" type="button"><span style="display:none">Gone</span></button>
      <a title="Menu toggle" tabindex="0"><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg></a>
      <a href="/nav-target" title="Home link"><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg></a>
      <button aria-label="Zoom in" type="button"><span>+</span></button>
      <button type="button">Visible text</button>
    </div>\`;`);
  const view = (await snap()).text;
  // The hidden label wins over the title, as in accname; text left out by
  // display:none doesn't count.
  for (const name of ["Print", "Download", "Tools", "Hidden title"]) {
    assert.match(view, new RegExp(`\\n\\s*button "${name}" \\[ref=\\d+`), name);
  }
  assert.match(view, /\n\s*anchor "Menu toggle" \[ref=\d+/);
  // A link's url= tells it apart, so it keeps Ego's form.
  assert.match(view, /\n\s*anchor \[ref=\d+[^\n]*url=[^\n]*nav-target\]\n\s*svg_root/);
  assert.match(view, /\n\s*button "Zoom in" \[ref=\d+/);
  // A control with text keeps Ego's form: no name, the text below it.
  assert.match(view, /\n\s*button \[ref=\d+\]\n\s*text "Visible text"/);
  // full_page shows the hidden labels themselves, as Ego does.
  const full = (await snap({ scope: "full_page" })).text;
  assert.match(full, /\n\s*button \[ref=\d+\]\n\s*text "Print"/);
});

// Firefox fills saved passwords into login pages on load. Chromium's page
// content leaves out the value of a field that is or was a password field,
// or is masked with -webkit-text-security, once it holds anything (no
// bullets either), so Ego prints the textbox alone.
test("a password field's value never prints, not even its length", async () => {
  await h.goto("/nav-target");
  await h.page(`document.body.innerHTML = \`
    <form>
      <label>Password <input id="pw" name="pw" type="password" value="attr-Secret-1"></label>
      <input name="pw2" type="password" placeholder="Your password">
      <input id="pw3" name="pw3" type="password">
      <input id="shown" name="shown" type="password">
      <input id="masked" name="masked" type="text" style="-webkit-text-security: disc">
      <textarea id="note" name="note" style="-webkit-text-security: disc"></textarea>
      <button type="button" aria-labelledby="pw"></button>
      <input name="plain" type="text" value="visible text">
    </form>\`;
    // What autofill does: the value comes from script, not the markup.
    document.getElementById("pw3").value = "js-Secret-3";
    // A show-password toggle: type=text now, but it was a password field.
    const shown = document.getElementById("shown");
    shown.value = "toggled-Secret-4";
    shown.type = "text";
    document.getElementById("masked").value = "css-Secret-5";
    document.getElementById("note").value = "css-Secret-6";`);
  for (const scope of ["viewport", "full_page"]) {
    const result = await snap({ scope });
    assert.doesNotMatch(JSON.stringify(result), /Secret|•/, scope);
    for (const loc of ['input[name="pw"]', 'input[name="pw3"]', 'input[name="shown"]', 'input[name="masked"]', 'textarea[name="note"]']) {
      const selector = loc.replace(/[[\]]/g, "\\$&");
      // The textbox and nothing under it: the next line isn't indented deeper.
      assert.match(result.text, new RegExp(`\\n( *)textbox \\[ref=\\d+, loc=css:${selector}\\]\\n(?!\\1 )`), `${scope} ${loc}`);
    }
    // An empty one still shows its placeholder, and a plain field its text.
    assert.match(result.text, /textbox \[ref=\d+, loc=css:input\[name="pw2"\]\]\n\s*text "Your password"/);
    assert.match(result.text, /textbox \[ref=\d+, loc=css:input\[name="plain"\]\]\n\s*text "visible text"/);
    // A button named by the password field doesn't get its value as a name.
    assert.match(result.text, /\n\s*button \[ref=\d+\]\n/);
  }
});

// Chromium prints a date or time input's fields as spinbutton refs (Ego's
// zoo-forms golden). Gecko's datetimebox, a UA widget, has the same fields
// in the locale's order, so this test doesn't check the order.
test("date and time inputs print their fields as spinbutton refs", async () => {
  await h.goto("/zoo/forms.html");
  const first = (await snap({ scope: "full_page" })).text;
  const date = subtree(first, /textbox \[ref=\d+, loc=css:input\[name="birthday"\]\]$/);
  const fieldRef = (part, name, value) => {
    const m = new RegExp(`\\n\\s*spinbutton "${name}" \\[ref=(\\d+)\\]\\n\\s*text "${value}"`).exec(part);
    assert.ok(m, `${name} "${value}" in:\n${part}`);
    return Number(m[1]);
  };
  const year = fieldRef(date, "Year", "2000");
  fieldRef(date, "Month", "01");
  fieldRef(date, "Day", "02");
  assert.match(date, /\n\s*text "\/"/);
  // An empty time input shows its placeholders.
  const time = subtree(first, /textbox \[ref=\d+, loc=css:input\[name="time"\]\]$/);
  fieldRef(time, "Hours", "--");
  fieldRef(time, "Minutes", "--");
  // A field ref resolves to Gecko's field and stays the same across snapshots.
  assert.deepEqual(await describe(year), { tag: "span", id: "", text: "2000" });
  const again = subtree((await snap({ scope: "full_page" })).text, /textbox \[ref=\d+, loc=css:input\[name="birthday"\]\]$/);
  assert.equal(fieldRef(again, "Year", "2000"), year);
});

// Chromium prints a media element's control bar as refs (Ego's GitHub
// golden: `video [ref]` > `button "play" [ref]`, `text "0:00"`,
// `text "/ 0:28"`, `spinbutton "volume" [ref]`, `button "unmute" [ref]`, …).
// Gecko's videocontrols widget has the same controls; we print them with
// Chromium's names, in its order, and agents click them by ref.
test("media controls print as refs in Chromium's order, and clicking them plays", async () => {
  await h.goto("/nav-target");
  await h.page(`
    // Three seconds of silence: a video with no video track, so no full screen button.
    const rate = 8000, samples = rate * 3, buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
    const ascii = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
    ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples * 2, true);
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    document.body.innerHTML = '<video id="v" controls muted width="480" height="270"></video>' +
      '<audio id="a" controls></audio><video id="plain" width="200" height="100"></video>';
    const media = [document.getElementById("v"), document.getElementById("a")];
    await Promise.all(media.map(m => new Promise((resolve, reject) => {
      m.addEventListener("loadedmetadata", resolve, { once: true });
      m.addEventListener("error", () => reject(new Error("media failed")), { once: true });
      m.src = url;
    })));
    // The controls show the duration once the widget heard of it.
    for (let i = 0; i < 50 && !media.every(m => m.duration === 3); i++) await new Promise(r => setTimeout(r, 20));
    return true;
  `);
  const controls = (role, name) => `\\n\\s*${role} "${name}" \\[ref=\\d+\\]`;
  const text = (await snap({ scope: "full_page" })).text;
  const video = subtree(text, /^\s*video \[ref=\d+\]$/);
  assert.match(video, new RegExp(
    [controls("button", "play"), `\\n\\s*text "0:00"`, `\\n\\s*text "/ 0:03"`, controls("spinbutton", "volume"),
      controls("button", "unmute"), controls("spinbutton", "video time scrubber")].join("") + "$"));
  const audio = subtree(text, /^\s*audio \[ref=\d+\]$/);
  assert.match(audio, new RegExp(
    [controls("button", "play"), `\\n\\s*text "0:00"`, `\\n\\s*text "/ 0:03"`, controls("spinbutton", "volume"),
      controls("button", "mute"), controls("spinbutton", "audio time scrubber")].join("") + "$"));
  // Without controls a video is a bare line, as before.
  assert.match(text, /\n\s*video\n|\n\s*video$/);

  // The refs resolve to Gecko's controls, and clicking them drives the media.
  const play = refOf(video, /button "play"/);
  assert.deepEqual(await describe(play), { tag: "button", id: "playButton", text: "" });
  const click = async ref => h.call("page.click", { space: h.space, page: "p1", target: `@${ref}`, options: {} });
  const state = () => h.page(`({ paused: document.getElementById("v").paused, muted: document.getElementById("v").muted })`);
  await click(play);
  assert.equal((await state()).paused, false);
  await click(refOf(video, /button "unmute"/));
  assert.equal((await state()).muted, false);
  // The play button is now the pause button, under the same ref.
  const playing = subtree((await snap({ scope: "full_page" })).text, /^\s*video \[ref=\d+\]$/);
  assert.equal(refOf(playing, /button "pause"/), play);
  assert.match(playing, new RegExp(controls("button", "mute")));
  await click(play);
  assert.equal((await state()).paused, true);
});

// Ego prints text and names between quotes as they are; only locators escape.
test("text and names keep inner quotes raw, and page text can't forge a ref", async () => {
  await h.goto("/nav-target");
  await h.page(`
    document.body.innerHTML = "<p id=q></p><button id=b>x</button><p id=f></p>";
    document.getElementById("q").textContent = 'Say "hi" \\\\ back';
    document.getElementById("b").setAttribute("aria-label", 'Direct link to "Examples"');
    // The walker's ref placeholders are \\u0001d:k\\u0002, filled in by the parent.
    document.getElementById("f").textContent = "fake \\u0001" + "0:0\\u0002 ref";`);
  const view = (await snap()).text;
  assert.match(view, /\n\s*text "Say "hi" \\ back"\n/);
  assert.match(view, /\n\s*button "Direct link to "Examples"" \[ref=\d+, loc=css:button\[aria-label="Direct link to \\"Examples\\""\]\]\n/);
  assert.match(view, /\n\s*text "fake 0:0 ref"(\n|$)/);
  assert.equal(view.match(/\[ref=/g).length, 1, view);
});

test("interactiveOnly keeps refs, frames and the text that labels a control", async () => {
  await h.goto("/zoo/long.html");
  const full = await snap({ scope: "full_page" });
  const only = await snap({ scope: "full_page", interactiveOnly: true });
  assert.deepEqual(only.refs, full.refs, "the same refs, numbered the same");
  assert.equal(body(only.text)[0], "root");
  assert.match(only.text, /\n  button \[ref=\d+\]\n    text "Sticky action"\n/);
  assert.match(only.text, /\n  container "Inner scroller" \[ref=\d+\]\n    button \[ref=\d+\]\n      text "Inner bottom button"\n/);
  for (const gone of ["heading", "ordered_list", 'text "Item 1"', 'text "Inner item 1"']) {
    assert.ok(!only.text.includes(gone), `${gone} isn't interactive`);
  }

  await h.goto("/zoo/frames.html");
  const frames = await snap({ scope: "full_page", interactiveOnly: true });
  assert.ok(frames.text.split("\n").filter(l => /^\s*iframe \[ref=\d+\]$/.test(l)).length >= 4);
  assert.match(frames.text, /\n  iframe \[ref=\d+\]\n    root\n      textbox \[ref=\d+\]\n      button \[ref=\d+\]\n        text "Frame button"\n/);
  assert.match(frames.text, /\n      anchor \[ref=\d+, loc=href:http:\/\/localhost:\d+\/nav-target, url=[^\]]+\]\n        text "Frame link"\n/);
  assert.ok(!frames.text.includes('text "Frame child"'));
});

test("maxResultLength keeps whole lines that fit, and registers only their refs", async () => {
  const notice = max => `[snapshot truncated at maxResultLength=${max}; use scope "subtree" with a ref, or a larger maxResultLength]`;
  await h.goto("/zoo/long.html");
  const cut = await snap({ scope: "full_page", maxResultLength: 300 });
  const lines = cut.text.split("\n");
  assert.equal(lines.at(-2), notice(300));
  const kept = lines.slice(1, -2);
  assert.ok(kept.join("\n").length <= 300);
  const last = Math.max(...cut.refs.map(r => r.ref));
  await assert.rejects(snap({ scope: "subtree", root: `@${last + 1}` }), e => e.code === "ZEN_REF_NOT_FOUND", "refs past the cut aren't registered");

  const full = await snap({ scope: "full_page" });
  const fullLines = body(full.text).slice(0, -1);
  assert.deepEqual(fullLines.slice(0, kept.length), kept, "the same lines and numbers as the full tree");
  assert.ok([...kept, fullLines[kept.length]].join("\n").length > 300, "the next line wouldn't fit");

  // Nothing fits: header, notice and footer only. A truncated full_page retires no refs.
  await h.goto("/zoo/long.html");
  const view = await snap();
  const top = refOf(view.text, /anchor .*#top/);
  const tiny = await snap({ maxResultLength: 1 });
  assert.equal(tiny.text.split("\n")[1], notice(1));
  assert.match(tiny.text.split("\n")[2], /^\[more content below the viewport: /);
  assert.deepEqual(tiny.refs, []);
  await snap({ scope: "full_page", maxResultLength: 20 });
  assert.equal((await describe(top)).text, "Top");
});

test("options are checked with Ego's messages", async () => {
  const expected = ". Expected: await page.snapshot({ scope?, root?, includeActionMarks?, includeStableLocator? })";
  await assert.rejects(snap({ scope: "subtree" }), e => e.code === "ZEN_INVALID_ARGUMENT" && message(e) === `page.snapshot subtree scope requires root to be a snapshot ref such as @21${expected}`);
  await assert.rejects(snap({ root: "@1" }), e => message(e) === `page.snapshot root is only supported when scope is subtree${expected}`);
  await assert.rejects(snap({ scope: "subtree", root: "button" }), e => message(e) === `page.snapshot root must be a snapshot ref such as @21${expected}`);
  await assert.rejects(snap({ scope: "everything" }), e => e.code === "ZEN_INVALID_ARGUMENT");
  await assert.rejects(snap({ interactiveOnly: "yes" }), e => message(e) === `page.snapshot interactiveOnly must be a boolean${expected}`);
  for (const maxResultLength of [-1, 1.5, "10"]) {
    await assert.rejects(snap({ maxResultLength }), e => message(e) === `page.snapshot maxResultLength must be a non-negative integer${expected}`);
  }

  await assert.rejects(snap({ includeRefs: 1 }), e => message(e) === `page.snapshot includeRefs must be a boolean${expected}`);

  await h.goto("/zoo/aria.html");
  const bare = await h.call("page.snapshot", { space: h.space, page: "p1", options: {} });
  assert.deepEqual(Object.keys(bare), ["text"], "refs only when asked for");
  const plain = await snap({ includeActionMarks: false, includeStableLocator: false });
  assert.ok(!/\[ref=|loc=/.test(plain.text));
  assert.deepEqual(plain.refs, []);
});
