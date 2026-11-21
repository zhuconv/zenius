// The Space's private clipboard (runtime/JS/zenius/clipboard/): in a tab the
// agent drives, the page's own copy, cut and clipboard API calls use the
// Space's clipboard and never the user's, the agent's chords share it, and
// the user's own copies in that page, or in any page the agent doesn't
// drive, reach the user's clipboard as usual.
//
// How each agent case proves it left the user's clipboard alone:
// - Headless Zen (the Linux server, and the Mac's test-all) has a private in-memory
//   clipboard: a sentinel goes on it before the case and must still be there
//   after, compared inside the browser.
// - A visible Zen on the Mac (ZENIUS_CLIP_HEADED=1 tests/clipboard/run.sh)
//   uses the user's real pasteboard: the tests never read or write it. They
//   compare NSPasteboard's changeCount (osascript) right before and after
//   each case. It also moves when the user copies something, so a case runs
//   once more on a mismatch; both counts are logged.
// The user's own copies write the system clipboard: those tests run only
// where it's private.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { checkView, FOCUS_PROBE_START, FOCUS_PROBE_STOP } from "../observe/lib.mjs";
import { prelude, setup } from "../ux/lib.mjs";

let h;
let space;
let P;
let userView;
// zen-observe's I1 check: the user's view at the start, a focus probe in the
// parent, and each step's start and end, for the timeline a failure (or
// ZENIUS_FOCUS_LOG=1) prints.
let focusProbe = null;
let probeStopped = true;
const steps = [];
/** "private" | "pasteboard" | "none", see above */
let mode = "none";
const SENTINEL = "USER-CLIPBOARD-SENTINEL";
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  focusProbe = await h.chrome(FOCUS_PROBE_START).catch(() => null);
  probeStopped = !focusProbe;
  const call = h.call;
  h.call = (method, params) => {
    const t = Date.now();
    return call(method, params).finally(() => steps.push({ t, end: Date.now(), step: method }));
  };
  ({ id: space } = await h.createSpace({ name: "zen-ux clipboard test" }));
  P = `${prelude(space)}
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const { SpaceClipboard } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/clipboard/store.sys.mjs");
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const setSystem = text => {
      const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      t.init(null);
      t.addDataFlavor("text/plain");
      const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      s.data = text;
      t.setTransferData("text/plain", s);
      Services.clipboard.setData(t, null, Ci.nsIClipboard.kGlobalClipboard);
    };
    const getSystem = () => {
      const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      t.init(null);
      t.addDataFlavor("text/plain");
      try {
        Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, null);
        const out = {};
        t.getTransferData("text/plain", out);
        return out.value.QueryInterface(Ci.nsISupportsString).data;
      } catch {
        return null;
      }
    };
    // What the system clipboard held when the test started; compared here,
    // never returned.
    const systemUnchanged = () => getSystem() === win.__zeniusClipStart;
    const showAgentPage = async () => {
      Pages.landOn(tab);
      await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
      await until(() => gBrowser.selectedTab === tab);
      await sleep(150);
    };
    const inPage = (code, bc = browser.browsingContext) => ctx.content(bc, "dev#evalContent", { code, privileged: false });
    // The user's input enters through the parent, like OS input.
    const userClickOn = async id => {
      const p = await inPage("const r = document.getElementById(" + JSON.stringify(id) + ").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };");
      const r = browser.getBoundingClientRect();
      for (const type of ["mousedown", "mouseup"]) {
        win.synthesizeMouseEvent(type, r.x + p.x, r.y + p.y, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
      }
    };
    const userChord = (key, target = browser) => {
      target.focus();
      const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      tip.beginInputTransactionForTests(win);
      const accel = AppConstants.platform === "macosx" ? "Meta" : "Control";
      const mod = new win.KeyboardEvent("", { key: accel, code: accel + "Left" });
      const ev = new win.KeyboardEvent("", { key, code: "Key" + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0) });
      tip.keydown(mod);
      tip.keydown(ev);
      tip.keyup(ev);
      tip.keyup(mod);
    };
  `;
  const env = await h.chrome(`
    const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
    return { headless: Services.env.get("MOZ_HEADLESS") === "1", mac: AppConstants.platform === "macosx" };
  `);
  if (env.headless && process.env.ZENIUS_CLIP_HEADED !== "1") {
    mode = "private";
  } else if (env.mac) {
    mode = "pasteboard";
  }
  // For checking this file itself on Linux, with a stand-in osascript.
  if (process.env.ZENIUS_CLIP_MODE === "pasteboard") {
    mode = "pasteboard";
  }
  const how = { private: "a sentinel on headless Zen's own clipboard", pasteboard: "NSPasteboard's changeCount", none: "nothing" };
  console.log(`# the user's clipboard is checked by ${how[mode]}`);
});

after(async () => {
  if (!probeStopped) {
    probeStopped = true;
    await h?.chrome(FOCUS_PROBE_STOP).catch(() => {});
  }
  await h
    ?.chrome(`${P}
      UI.takeover.reset();
      if (rec.ownership !== "agent") ctx.spaces.setOwnership(rec, "agent", { source: "user" });
      delete win.__zeniusClipStart;
      if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
    `)
    .catch(() => {});
  await h?.close();
});

/** Load the test page: one button per way a page touches the clipboard. */
async function setupPage(url = `${h.base}/`, { navigate = true } = {}) {
  if (navigate) {
    await h.call("page.goto", { space, page: "p1", url });
  }
  await evaluate(`(() => {
    document.body.innerHTML = '<input id="src" value="SELECTED-TEXT"> <input id="dst"> <p id="rich"><b>bold</b> words</p>';
    const done = p => p.then(v => (window.__r = v ?? "ok"), e => (window.__r = "ERR " + e.name));
    const select = id => { const s = document.getElementById(id); s.focus(); s.select(); return s; };
    const actions = {
      writeText: () => done(navigator.clipboard.writeText("PAGE-WRITETEXT")),
      write: () => done(navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob(["PAGE-WRITE"], { type: "text/plain" }),
        "text/html": new Blob(["<b>PAGE-WRITE</b>"], { type: "text/html" }),
      })])),
      copy: () => { select("src"); window.__r = String(document.execCommand("copy")); },
      cut: () => { const s = select("src"); window.__r = document.execCommand("cut") + " value=" + s.value; },
      customCopy: () => {
        document.addEventListener("copy", e => {
          e.preventDefault();
          e.clipboardData.setData("text/plain", "CUSTOM");
          e.clipboardData.setData("text/html", "<i>CUSTOM</i>");
        }, { once: true });
        select("src");
        window.__r = String(document.execCommand("copy"));
      },
      copyRich: () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("rich"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        window.__r = String(document.execCommand("copy"));
      },
      readText: () => done(navigator.clipboard.readText().then(t => "read " + t)),
      read: () => done(navigator.clipboard.read().then(async items => {
        const parts = [];
        for (const item of items) for (const t of item.types) parts.push(t + "=" + await (await item.getType(t)).text());
        return parts.join("|");
      })),
    };
    for (const [id, fn] of Object.entries(actions)) {
      const b = document.createElement("button");
      b.id = id;
      b.textContent = id;
      b.onclick = fn;
      document.body.append(b);
    }
    return true;
  })()`);
}

function evaluate(expr) {
  return h.call("dev.evalContent", { space, page: "p1", code: `return (${expr});` });
}

/** The page's handler result once it has settled. */
async function pageResult() {
  for (let i = 0; i < 150; i++) {
    const r = await evaluate("window.__r === undefined ? null : String(window.__r)");
    if (r !== null) {
      return r;
    }
    await sleep(20);
  }
  throw new Error("the page's handler didn't finish");
}

/** The agent clicks a button (zen-input's page.click). */
async function agentClick(id) {
  await evaluate("(() => { window.__r = undefined; document.getElementById('src').value = 'SELECTED-TEXT'; return true; })()");
  await h.call("page.click", { space, page: "p1", target: `#${id}` });
  return pageResult();
}

/** Put the sentinel on headless Zen's private clipboard. */
async function markSystem() {
  assert.equal(mode, "private");
  await h.chrome(`${P}
    setSystem(${JSON.stringify(SENTINEL)});
    win.__zeniusClipStart = getSystem();
  `);
}

/** Show the user's own Space again, also after a failed check. */
function backToUserSpace() {
  return h.chrome(`${P} if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);`);
}

/** NSPasteboard's change count: it moves on every write and tells nothing of the content. */
function changeCount() {
  const out = execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount'], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const n = Number(out.trim());
  if (!Number.isInteger(n)) {
    throw new Error(`osascript gave no change count: ${JSON.stringify(out)}`);
  }
  return n;
}

/**
 * Run an agent case, and check that it left the user's clipboard alone (see
 * the top of this file). Returns what `run` returned; `run` must be
 * repeatable.
 */
async function untouched(name, run) {
  const t = Date.now();
  try {
    return await checkUntouched(name, run);
  } finally {
    steps.push({ t, end: Date.now(), step: `case: ${name}` });
  }
}

async function checkUntouched(name, run) {
  if (mode === "private") {
    await markSystem();
    const result = await run();
    assert.equal(await h.chrome(`${P} return systemUnchanged();`), true, `${name} left the user's clipboard alone`);
    return result;
  }
  if (mode === "pasteboard") {
    for (let attempt = 1; ; attempt++) {
      const before = changeCount();
      const result = await run();
      const after = changeCount();
      console.log(`# ${name}: pasteboard changeCount ${before} -> ${after}${attempt > 1 ? " (second try)" : ""}`);
      if (after === before) {
        return result;
      }
      if (attempt === 2) {
        assert.fail(`${name}: the pasteboard changed during both tries (last ${before} -> ${after})`);
      }
    }
  }
  return run();
}

/** The Space's clipboard. */
function store() {
  return h.chrome(`${P} return SpaceClipboard.read(rec.id);`);
}

test("a page's copy buttons fill the Space's clipboard and leave the user's alone", async () => {
  await setupPage();
  const cases = {
    writeText: { "text/plain": "PAGE-WRITETEXT" },
    write: { "text/html": "<b>PAGE-WRITE</b>", "text/plain": "PAGE-WRITE" },
    copy: { "text/plain": "SELECTED-TEXT" },
    customCopy: { "text/html": "<i>CUSTOM</i>", "text/plain": "CUSTOM" },
    copyRich: { "text/html": "<b>bold</b> words", "text/plain": "bold words" },
  };
  for (const [id, want] of Object.entries(cases)) {
    const r = await untouched(id, () => agentClick(id));
    assert.ok(!r.startsWith("ERR"), `${id}: ${r}`);
    assert.deepEqual(await store(), want, `${id} filled the Space's clipboard`);
  }
});

test("a page's cut deletes the selection, undoably, into the Space's clipboard", async () => {
  await setupPage();
  assert.equal(await untouched("cut", () => agentClick("cut")), "true value=");
  assert.deepEqual(await store(), { "text/plain": "SELECTED-TEXT" });
  await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+Z" });
  assert.equal(await evaluate("document.getElementById('src').value"), "SELECTED-TEXT", "undo brings it back");
});

test("the agent's paste pastes what the page copied, and the page reads what the agent copied", async () => {
  await setupPage();
  await untouched("the page's copy, then the agent's paste", async () => {
    await agentClick("copy");
    await evaluate("(() => { const d = document.getElementById('dst'); d.value = ''; d.focus(); return true; })()");
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+V" });
  });
  assert.equal(await evaluate("document.getElementById('dst').value"), "SELECTED-TEXT");
  // The agent cuts with its own keys (zen-input's chords); the page reads it.
  const read = await untouched("the agent's cut keys, then the page's read", async () => {
    await h.call("page.fill", { space, page: "p1", target: "#dst", value: "AGENT-CUT" });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+A" });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+X" });
    return agentClick("readText");
  });
  assert.equal(read, "read AGENT-CUT");
  assert.equal(await evaluate("document.getElementById('dst').value"), "", "the agent's cut emptied the field");
});

test("read() gives the Space's text and HTML as one ClipboardItem", async () => {
  await setupPage();
  const r = await untouched("write, then read", async () => {
    await agentClick("write");
    return agentClick("read");
  });
  assert.equal(r, "text/plain=PAGE-WRITE|text/html=<b>PAGE-WRITE</b>");
});

test("a page reads the Space's clipboard only from the site that wrote it; the agent's paste goes anywhere", async () => {
  // Two origins on the fixture server: 127.0.0.1 and localhost.
  const other = h.base.replace("127.0.0.1", "localhost");
  assert.notEqual(other, h.base);
  const refusals = async () =>
    (await h.call("page.events", { space, page: "p1" })).filter(e => e.method === "Zenius.refused" && e.params.kind === "clipboardRead");
  await h.call("page.events", { space, page: "p1" });
  await untouched("a copy on one site, read by another, then by itself, then pasted by the agent", async () => {
    await setupPage(`${h.base}/`);
    assert.equal(await agentClick("writeText"), "ok");
    await setupPage(`${other}/`);
    assert.equal(await agentClick("readText"), "ERR NotAllowedError", "another site can't read it");
    await evaluate("(() => { window.__r = undefined; return true; })()");
    const receipt = await h.call("page.click", { space, page: "p1", target: "#read" });
    assert.equal(await pageResult(), "ERR NotAllowedError");
    assert.deepEqual(receipt.refused?.map(r => r.kind), ["clipboardRead"], "the click's receipt names the refusal");
    const refused = await refusals();
    assert.equal(refused.length, 2, JSON.stringify(refused));
    assert.match(refused[0].params.message, /holds what http:\/\/127\.0\.0\.1:\d+ wrote/);
    assert.ok(refused[0].params.url.startsWith(other), refused[0].params.url);
    // The agent's own paste is its choice, as a user's paste is.
    await evaluate("(() => { const d = document.getElementById('dst'); d.value = ''; d.focus(); return true; })()");
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+V" });
    assert.equal(await evaluate("document.getElementById('dst').value"), "PAGE-WRITETEXT");
    await setupPage(`${h.base}/`);
    assert.equal(await agentClick("readText"), "read PAGE-WRITETEXT", "the site that wrote it reads it");
  });
  // The agent's own copy keys: the site it copied on may read it, no other.
  await untouched("the agent's copy keys on one site, read by each", async () => {
    await setupPage(`${other}/`);
    await h.call("page.fill", { space, page: "p1", target: "#dst", value: "AGENT-COPY" });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+A" });
    await h.call("page.keyboard", { space, page: "p1", action: "press", key: "ControlOrMeta+C" });
    assert.equal(await agentClick("readText"), "read AGENT-COPY");
    await setupPage(`${h.base}/`);
    assert.equal(await agentClick("readText"), "ERR NotAllowedError");
  });
  assert.deepEqual(await store(), { "text/plain": "AGENT-COPY" }, "a refused read changes nothing");
  // A content process names the copying document's origin; the parent
  // believes it only for a document that process hosts in the tab.
  const named = await h.chrome(`${P}
    const { hostedOrigin } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/clipboard/store.sys.mjs");
    const bc = browser.browsingContext;
    const own = bc.currentWindowGlobal.documentPrincipal.origin;
    return { own: hostedOrigin(bc, own) === own, other: hostedOrigin(bc, "https://bank.example"), odd: hostedOrigin(bc, { toString: () => own }) };
  `);
  assert.deepEqual(named, { own: true, other: null, odd: null });
});

test("the clipboard parent ignores messages from pages that aren't a task's, and malformed ones", async t => {
  if (mode !== "private") {
    // A mistake here would write the system clipboard: never the user's
    // real pasteboard on the Mac.
    t.skip("headless only: it checks the system clipboard stays untouched");
    return;
  }
  await setupPage();
  await markSystem();
  const out = await h.chrome(`${P}
    const actorFor = b => b.browsingContext.currentWindowGlobal.getActor("ZeniusClipboard");
    const user = gBrowser.selectedTab.linkedBrowser;
    const mine = actorFor(user);
    const theirs = actorFor(browser);
    const before = SpaceClipboard.read(rec.id);
    const res = {
      userClip: mine.receiveMessage({ name: "clip", data: { data: { "text/plain": "FORGED" }, at: Date.now() } }) ?? null,
      userRead: mine.receiveMessage({ name: "read", data: { at: Date.now() } }),
      oddType: theirs.receiveMessage({ name: "write", data: { data: { "application/x-moz-file": "/etc/passwd" }, at: Date.now() } }),
      tooBig: theirs.receiveMessage({ name: "write", data: { data: { "text/plain": "x".repeat(4 * 1024 * 1024 + 1) }, at: Date.now() } }),
      // A moment long past, as if the user had used the page then.
      stale: theirs.receiveMessage({ name: "write", data: { data: { "text/plain": "STALE" }, at: 1 } }),
      notObject: theirs.receiveMessage({ name: "clip", data: "nonsense" }) ?? null,
    };
    res.space = SpaceClipboard.read(rec.id);
    res.onlyStale = JSON.stringify({ "text/plain": "STALE" }) === JSON.stringify(res.space);
    SpaceClipboard.write(rec.id, before);
    res.system = systemUnchanged();
    return res;
  `);
  assert.equal(out.userClip, null);
  assert.deepEqual(out.userRead, { route: "user" });
  assert.deepEqual(out.oddType, { route: "refused" });
  assert.deepEqual(out.tooBig, { route: "refused" });
  assert.deepEqual(out.stale, { route: "space" }, "a stale time counts as now");
  assert.equal(out.notObject, null);
  assert.equal(out.onlyStale, true, "only the well-formed write reached the Space's clipboard");
  assert.equal(out.system, true, "the user's clipboard is untouched");
});

test("copies in the page's frames, same-origin and cross-site, are caught too", async () => {
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/zoo/frames.html` });
  // frame-child's own button copies its input instead, in two of its frames.
  const frames = await h.chrome(`${P}
    await until(() => browser.browsingContext.children.filter(bc => bc.currentWindowGlobal?.documentURI?.spec.endsWith("/zoo/frame-child.html")).length >= 2, 5000);
    const kids = browser.browsingContext.children;
    const find = host => kids.find(bc => {
      const u = bc.currentWindowGlobal?.documentURI;
      return u?.host === host && u.spec.endsWith("/zoo/frame-child.html");
    });
    const out = {};
    for (const [label, host] of [["same-origin", "127.0.0.1"], ["cross-site", "localhost"]]) {
      const bc = find(host);
      out[label] = { remote: bc.currentWindowGlobal.osPid !== browser.browsingContext.currentWindowGlobal.osPid };
      await inPage(\`
        const b = document.querySelector("button");
        b.textContent = "Copy in the \${label} frame";
        b.onclick = () => {
          const i = document.querySelector("input");
          i.value = "FRAME \${label}";
          i.focus();
          i.select();
          document.execCommand("copy");
        };
        return true;
      \`, bc);
    }
    return out;
  `);
  assert.equal(frames["cross-site"].remote, true, "the cross-site frame runs in its own process");
  for (const label of ["same-origin", "cross-site"]) {
    const got = await untouched(`a copy in the ${label} frame`, async () => {
      await h.chrome(`${P} SpaceClipboard.clear(rec.id);`);
      await h.call("page.click", { space, page: "p1", target: `text=Copy in the ${label} frame` });
      return h.chrome(`${P}
        await until(() => SpaceClipboard.read(rec.id)?.["text/plain"] === ${JSON.stringify(`FRAME ${label}`)});
        return SpaceClipboard.read(rec.id);
      `);
    });
    assert.deepEqual(got, { "text/plain": `FRAME ${label}` }, label);
  }
});

test("without a user gesture a page can't use the clipboard in an agent tab either", async () => {
  // A new document has no user activation yet.
  await setupPage();
  await h.chrome(`${P} SpaceClipboard.clear(rec.id);`);
  const r = await untouched("writeText without a gesture", () =>
    evaluate(`navigator.clipboard.writeText("NO-GESTURE").then(() => "ok", e => "ERR " + e.name)`)
  );
  assert.equal(r, "ERR NotAllowedError");
  assert.equal(await store(), null);
});

test("the guarded methods look like the browser's own", async () => {
  await setupPage();
  const r = await evaluate(`["writeText", "write", "readText", "read"].map(n => {
    const d = Object.getOwnPropertyDescriptor(Clipboard.prototype, n);
    return [n, d.value.name, d.value.length, String(d.value).includes("[native code]"), d.writable, d.enumerable, d.configurable].join(" ");
  })`);
  assert.deepEqual(r, [
    "writeText writeText 1 true true true true",
    "write write 1 true true true true",
    "readText readText 0 true true true true",
    "read read 0 true true true true",
  ]);
});

// The user's own copies write the system clipboard: only where it's private.
const userTest = (name, fn) =>
  test(name, async t => {
    if (mode !== "private") {
      t.skip("writes the system clipboard, which here is the user's own");
      return;
    }
    await fn();
  });

userTest("the user's own copy in the agent's page reaches their clipboard", async () => {
  await setupPage();
  await markSystem();
  const out = await h.chrome(`${P}
    SpaceClipboard.write(rec.id, { "text/plain": "THE AGENT'S" });
    await showAgentPage();
    // Their click opens the takeover prompt; the page's handler copies.
    await userClickOn("copy");
    await until(() => getSystem() === "SELECTED-TEXT");
    const prompt = !!UI.takeover.promptState(rec.id);
    UI.takeover.resolve(rec.id, "continue");
    // Their Ctrl/Cmd+C opens no prompt; the copy is theirs all the same.
    await inPage("const s = document.getElementById('src'); s.value = 'USER-KEYS'; s.focus(); s.select(); return true;");
    userChord("c");
    await until(() => getSystem() === "USER-KEYS");
    return { prompt, store: SpaceClipboard.read(rec.id) };
  `).finally(() => backToUserSpace());
  assert.deepEqual(out, { prompt: true, store: { "text/plain": "THE AGENT'S" } });
});

userTest("after Take over, the page's copies are the user's as usual", async () => {
  await setupPage();
  await markSystem();
  const out = await h.chrome(`${P}
    SpaceClipboard.write(rec.id, { "text/plain": "THE AGENT'S" });
    await showAgentPage();
    UI.takeOverByUser(rec);
    await sleep(100);
    await userClickOn("writeText");
    await until(() => getSystem() === "PAGE-WRITETEXT");
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
    return SpaceClipboard.read(rec.id);
  `).finally(() => backToUserSpace());
  assert.deepEqual(out, { "text/plain": "THE AGENT'S" });
});

userTest("pages in the user's own tabs copy natively", async () => {
  await markSystem();
  const out = await h.chrome(`${P}
    const userTab = gBrowser.addTab("data:text/html,<input id=s value=USER-TAB-TEXT>", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    const before = gBrowser.selectedTab;
    try {
      await until(() => userTab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec.startsWith("data:"), 5000);
      gBrowser.selectedTab = userTab;
      await sleep(150);
      await inPage("const s = document.getElementById('s'); s.focus(); s.select(); return true;", userTab.linkedBrowser.browsingContext);
      userChord("c", userTab.linkedBrowser);
      await until(() => getSystem() === "USER-TAB-TEXT");
      return getSystem();
    } finally {
      gBrowser.selectedTab = before;
      gBrowser.removeTab(userTab);
    }
  `);
  assert.equal(out, "USER-TAB-TEXT");
});

test("whose copy it is: the user's only while they use the agent's page", async () => {
  const out = await h.chrome(`${P}
    await showAgentPage();
    // No grace period left over from an earlier test's Continue, and no
    // keystroke of the user's from the last second.
    UI.takeover.reset();
    await until(() => Date.now() - UI.takeover.lastKeyAt(browser) > 1100, 3000);
    // The prompt opened at the user's input: an agent copy made just before
    // stays the agent's.
    const st = UI.takeover.handleInput(rec, tab, "pointer");
    const prompt = [UI.isUserUsing(browser, st.openedAt - 20), UI.isUserUsing(browser, st.openedAt + 10)];
    UI.takeover.resolve(rec.id, "continue");
    const afterContinue = UI.isUserUsing(browser, Date.now() + 10);
    // A key that opens no prompt (Shift here, Cmd+C in life) makes the next
    // second's copies the user's.
    browser.focus();
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    tip.beginInputTransactionForTests(win);
    const shift = new win.KeyboardEvent("", { key: "Shift", code: "ShiftLeft" });
    tip.keydown(shift);
    tip.keyup(shift);
    const k = UI.takeover.lastKeyAt(browser);
    const key = [UI.isUserUsing(browser, k - 100), UI.isUserUsing(browser, k + 500), UI.isUserUsing(browser, k + 1500)];
    UI.pauseByUser(rec);
    const paused = UI.isUserUsing(browser, Date.now() + 10);
    UI.resumeByUser(rec);
    return { prompt, afterContinue, key, paused, keySeen: k > 0 };
  `).finally(() => backToUserSpace());
  assert.deepEqual(out, {
    prompt: [false, true],
    afterContinue: false,
    key: [false, true, false],
    paused: true,
    keySeen: true,
  });
});

test("the Space's clipboard ends with the task", async () => {
  const { id: other } = await h.createSpace({ name: "zen-ux clipboard end" });
  await h.call("page.goto", { space: other, page: "p1", url: `${h.base}/` });
  await h.chrome(`${P} SpaceClipboard.write(${other}, { "text/plain": "ENDS" });`);
  await h.call("spaces.finish", { space: other, keep: [] });
  assert.equal(await h.chrome(`${P} return SpaceClipboard.read(${other});`), null);
});

test("a page the user loaded while holding control is guarded once they hand back", async () => {
  await setupPage();
  // The user takes over and loads a page in the agent's tab: its document
  // starts while the agent doesn't drive the tab. (An earlier test's user
  // keys must be over 1 s old, or the agent's copies would count as theirs.)
  await h.chrome(`${P}
    await until(() => Date.now() - UI.takeover.lastKeyAt(browser) > 1100, 3000);
    ctx.spaces.setOwnership(rec, "agentDelegatedToUser", { reason: "manual_takeover", source: "user" });
    const before = browser.browsingContext.currentWindowGlobal;
    browser.loadURI(Services.io.newURI(${JSON.stringify(`${h.base}/?user-loaded`)}), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    await until(() => browser.browsingContext.currentWindowGlobal !== before && browser.currentURI.spec.endsWith("?user-loaded"), 5000);
    ctx.spaces.setOwnership(rec, "agent", { source: "user" });
  `);
  await setupPage(null, { navigate: false });
  const cases = { writeText: { "text/plain": "PAGE-WRITETEXT" }, copy: { "text/plain": "SELECTED-TEXT" } };
  for (const [id, want] of Object.entries(cases)) {
    await h.chrome(`${P} SpaceClipboard.clear(rec.id);`);
    const r = await untouched(`${id} on a page the user loaded`, () => agentClick(id));
    assert.ok(!r.startsWith("ERR"), `${id}: ${r}`);
    assert.deepEqual(await store(), want, `${id} filled the Space's clipboard`);
  }
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  probeStopped = true;
  const log = focusProbe ? await h.chrome(FOCUS_PROBE_STOP).catch(() => null) : null;
  await checkView("tests/clipboard", userView, view, { probe: focusProbe, steps, log });
});
