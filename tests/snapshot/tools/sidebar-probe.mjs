// Red team of the agent sidebar and the '>' dispatch (zen-snapshot, for the
// manager, 2026-11-21): can a page or an agent reach the sidebar's chrome
// code, read the user's chats or start a process, and does agent activity
// leave the user's focus and tab alone (I1)?
//
// The agent is sidebar-redteam-agent.py, a scripted ACP agent (no real
// agent, no network). The pages are this probe's own, on 127.0.0.1 and
// 127.0.0.2 (two sites).
//
//   node tests/snapshot/tools/sidebar-probe.mjs setup <dir>
//     writes <dir>/config.json and <dir>/prefs.js, then start the Zen with
//     ZENIUS_DEV_PREFS=<dir>/prefs.js scripts/zen-dev.sh <name> start
//   ZENIUS_INSTANCE=<name> node tests/snapshot/tools/sidebar-probe.mjs run <dir> [case ...]
//
// Cases: xss, spoof, perm, fs, echo, fakepdf, stallpdf, realpdf, slowpdf, drop, typed,
// i1work, i1chat; step 6's live (the live card's content, when it draws and
// its cost), watch (Watch and Ctrl+Tab by the user, a page and the agent),
// pill (the watch chip: since zen-ux's 843a989 a hint where zenius's strip
// can't be read, and Ctrl+Tab the only way back), refused (a Take over
// zen-core refuses, for real: the page's fresh load would leave its site),
// cost (one picture alone, the parent stall around it) and namelink (the
// chat follows a task by the name its agent reports);
// sessions (last: it reads what the others started). The Take over's
// discard is sandbox-probe.mjs's sidebarTakeover (with panelTakeover, the
// control). Headless on the Linux server only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

if (process.platform === "darwin") {
  console.error("sidebar-probe: headless on the Linux server only");
  process.exit(2);
}

const here = dirname(new URL(import.meta.url).pathname);
const [mode, dirArg, ...wanted] = process.argv.slice(2);
if (!["setup", "run"].includes(mode) || !dirArg) {
  console.error("usage: sidebar-probe.mjs setup|run <dir> [case ...]");
  process.exit(2);
}
const dir = resolve(dirArg);
// ZS_PORT_A and ZS_PORT_B move them, for runs on two instances at once.
const PORT_A = Number(process.env.ZS_PORT_A) || 47317;
const PORT_B = Number(process.env.ZS_PORT_B) || 47318;
const A = `http://127.0.0.1:${PORT_A}`;
const B = `http://127.0.0.2:${PORT_B}`;
const agentLog = join(dir, "agent.jsonl");
const workspace = join(dir, "workspace");

if (mode === "setup") {
  mkdirSync(workspace, { recursive: true });
  const config = {
    default: "zsred",
    agents: {
      zsred: {
        name: "ZS Red",
        command: "/usr/bin/env",
        args: ["python3", join(here, "sidebar-redteam-agent.py"), agentLog, workspace, A],
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(
    join(dir, "prefs.js"),
    `user_pref("uc.agent-sidebar.config", ${JSON.stringify(join(dir, "config.json"))});\n` +
      `user_pref("uc.agent-sidebar.harness", "zsred");\n` +
      // zen-observe's limits run only known adapters; the fixtures' mock and this scripted agent need this.
      `user_pref("zenius.agentSidebar.allowUnknownAgents", true);\n` +
      // actorStall: one content process per site, so the user's page and the agent's share one.
      (wanted.includes("--one-process") ? `user_pref("dom.ipc.processCount.webIsolated", 1);\n` : "")
  );
  console.log(join(dir, "prefs.js"));
  process.exit(0);
}

// --- Pages ---------------------------------------------------------------------

const page = (title, body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const PAGES_A = {
  "/plain": page("Plain page", `<p>Plain page text.</p><input id="f" aria-label="field">`),
  "/clicked": page("Clicked", "clicked"),
  "/search": page("Loopback search", "the dropped text was searched here"),
  "/hidden": page(
    "TITLE_MARK hidden test",
    `<nav>NAV_MARK</nav>
     <p>VISIBLE_MARK</p>
     <p style="display:none">DISPNONE_MARK</p>
     <p style="visibility:hidden">VISHIDDEN_MARK</p>
     <p style="position:absolute;left:-9999px">OFFSCREEN_MARK</p>
     <p style="color:#fff;background:#fff">WHITE_MARK</p>
     <p style="font-size:1px">TINY_MARK</p>
     <p style="opacity:0">OPACITY_MARK</p>
     <p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">SRONLY_MARK</p>
     <p aria-hidden="true">ARIAHIDDEN_MARK</p>
     <details><summary>SUMMARY_MARK</summary>COLLAPSED_MARK</details>
     <!-- COMMENT_MARK -->
     <noscript>NOSCRIPT_MARK</noscript>
     <template>TEMPLATE_MARK</template>
     <img alt="ALT_MARK" src="data:,">
     <input type="password" value="PASSWORD_MARK">
     <input type="hidden" value="HIDDENINPUT_MARK">
     <input value="INPUTVALUE_MARK">
     <textarea>TEXTAREA_MARK</textarea>
     <iframe src="/frame-same"></iframe>
     <iframe src="${B}/frame-cross"></iframe>`
  ),
  "/frame-same": page("same frame", "IFRAME_SAME_MARK"),
  // A page that says it is Firefox's PDF viewer.
  "/fakepdf": page(
    "An ordinary page",
    `<p>VISIBLE_FAKEPDF_MARK, an ordinary web page.</p>`,
    `<script>
      window.PDFViewerApplication = {
        initializedPromise: Promise.resolve(),
        pdfDocument: {
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "PDFAPI_ONLY_MARK: text the user never sees", hasEOL: true }] }) }),
        },
      };
    </script>`
  ),
  "/stallpdf": page(
    "A stalling page",
    `<p>STALL page</p>`,
    `<script>window.PDFViewerApplication = { initializedPromise: new Promise(() => {}) };</script>`
  ),
  // Step 6: the agent's page for the live card, a red band on top. It logs
  // the keys it hears; with ?ctrltab=1 it also sends itself Ctrl+Tab every
  // 300 ms (a page's own try at the watch's way back).
  "/live": page(
    "ZS live page",
    `<div style="height:600px;background:rgb(255,0,0);color:#fff;font:40px sans-serif">LIVE_PAGE_MARK</div><input id="f">`,
    `<script>
      window.__keys = [];
      for (const type of ["keydown", "keyup"]) addEventListener(type, e => __keys.push(type + ":" + (e.ctrlKey ? "C-" : "") + e.key + (e.isTrusted ? "" : "(synthetic)")), true);
      if (location.search.includes("ctrltab=1")) setInterval(() => {
        for (const t of [document, window, document.body]) for (const type of ["keydown", "keyup"])
          t?.dispatchEvent(new KeyboardEvent(type, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true, bubbles: true, cancelable: true }));
      }, 300);
    </script>`
  ),
  "/live2": page("ZS live page 2", `<div style="height:600px;background:rgb(0,0,255)">LIVE2_MARK</div>`),
  // The card's picture actor: a page that sets traps in its own realm for
  // anything that might reach the picture (a prototype the painting could go
  // through, a setter on Object.prototype for the reply's fields, a promise's
  // then, a node added to its document), and times its own main thread.
  "/trap": page(
    "ZS trap page",
    `<div style="height:600px;background:rgb(255,0,0)">TRAP_PAGE_MARK</div>`,
    `<script>
      window.__traps = [];
      const hit = k => { __traps.push(k); try { navigator.sendBeacon("/hit?w=trap&k=" + encodeURIComponent(k)); } catch {} };
      const method = (proto, n) => { const d = Object.getOwnPropertyDescriptor(proto, n); if (!d || typeof d.value !== "function") return; const f = d.value; Object.defineProperty(proto, n, { ...d, value: function (...a) { hit(proto.constructor.name + "." + n); return f.apply(this, a); } }); };
      const accessor = (obj, n, label) => { const d = Object.getOwnPropertyDescriptor(obj, n); if (!d?.get) return; Object.defineProperty(obj, n, { ...d, get() { hit(label + " get " + n); return d.get.call(this); }, set: d.set && function (v) { hit(label + " set " + n); return d.set.call(this, v); } }); };
      for (const n of ["createElementNS", "createElement"]) method(Document.prototype, n);
      for (const n of ["getContext", "toDataURL", "toBlob"]) method(HTMLCanvasElement.prototype, n);
      for (const n of ["width", "height"]) accessor(HTMLCanvasElement.prototype, n, "canvas");
      for (const n of ["scale", "drawImage", "getImageData", "fillRect"]) method(CanvasRenderingContext2D.prototype, n);
      for (const n of ["innerWidth", "innerHeight", "devicePixelRatio"]) accessor(window, n, "window");
      for (const n of ["data", "width", "height"]) accessor(ImageData.prototype, n, "ImageData");
      accessor(Object.getPrototypeOf(Uint8Array.prototype), "buffer", "TypedArray");
      accessor(ArrayBuffer.prototype, "byteLength", "ArrayBuffer");
      for (const n of ["url", "ms", "jpeg", "data", "pixels"]) Object.defineProperty(Object.prototype, n, { configurable: true, set(v) { hit("Object.prototype set " + n); Object.defineProperty(this, n, { value: v, writable: true, enumerable: true, configurable: true }); } });
      const then = Promise.prototype.then; Promise.prototype.then = function (...a) { hit("Promise.then"); return then.apply(this, a); };
      new MutationObserver(list => { for (const m of list) hit("mutation " + m.type); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      window.__lags = []; let last = performance.now();
      setInterval(() => { const now = performance.now(); const lag = now - last - 20; if (lag > 10) __lags.push({ t: now, lag }); last = now; }, 20);
    </script>`
  ),
  // The user's own page for the actor cases: it times its main thread.
  "/ticker": page(
    "ZS user ticker",
    `<div style="height:600px;background:rgb(128,0,128)">TICKER_MARK</div>`,
    `<script>window.__lags = []; let last = performance.now(); setInterval(() => { const now = performance.now(); const lag = now - last - 20; if (lag > 10) __lags.push({ t: now, lag }); last = now; }, 20);</script>`
  ),
  // Step 6's pill: fields along the top of the page, where a site's search
  // box or sign-in often is, and where the pill sits while the user watches.
  "/pillpage": page(
    "ZS pill page",
    `<input id="left" aria-label="left" style="position:absolute;left:8px;top:14px;width:180px">` +
      `<input id="mid" aria-label="mid" style="position:absolute;left:50%;transform:translateX(-50%);top:14px;width:200px">` +
      `<input id="right" aria-label="right" style="position:absolute;right:8px;top:14px;width:180px">` +
      `<div style="position:absolute;top:60px;left:8px">PILL_PAGE_MARK</div>`
  ),
  "/other": page("Another task's page", `<div style="height:600px;background:rgb(0,160,0)">OTHER_TASK_MARK</div>`),
  // A page that is costly to paint: a turbulence filter over the viewport and
  // blurred shadows. Its picture is drawn in the parent process.
  "/heavy": page(
    "ZS heavy page",
    `<svg width="1600" height="1000" style="position:absolute;inset:0"><filter id="t"><feTurbulence baseFrequency="0.013" numOctaves="10"/><feGaussianBlur stdDeviation="2"/></filter><rect width="1600" height="1000" filter="url(#t)"/></svg>` +
      `<div style="position:absolute;inset:0;display:flex;flex-wrap:wrap">${'<b style="width:36px;height:36px;margin:6px;border-radius:50%;box-shadow:0 0 40px 18px rgba(0,0,0,.4);filter:blur(1px)"></b>'.repeat(700)}</div>`
  ),
};
const PAGES_B = { "/frame-cross": page("cross frame", "IFRAME_CROSS_MARK"), "/ticker": PAGES_A["/ticker"] };
/** A valid one-page PDF that shows `text`. */
function tinyPdf(text) {
  const stream = `BT /F1 18 Tf 20 120 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const REAL_PDF = tinyPdf("REALPDF_MARK");
const hits = [];
const flipped = new Set();
function serve(host, port, pages) {
  return new Promise((ok, fail) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      hits.push(`${host}:${port}${req.url}`);
      if (path === "/flip") {
        // The refused Take over's page: the first load of each key is a
        // page; any later load of it goes to the other site.
        const k = new URL(req.url, "http://x").searchParams.get("k") ?? "";
        if (flipped.has(k)) {
          res.writeHead(302, { location: `${B}/ticker`, "cache-control": "no-store" });
          res.end();
          return;
        }
        flipped.add(k);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page("ZS flip page", `<input id="f" aria-label="field"><p>FLIP_MARK</p>`));
        return;
      }
      if (path === "/real.pdf") {
        res.writeHead(200, { "content-type": "application/pdf", "content-length": REAL_PDF.length });
        res.end(REAL_PDF);
        return;
      }
      if (path === "/slow.pdf") {
        // Headers and the first bytes, then nothing: pdf.js waits for the rest.
        res.writeHead(200, { "content-type": "application/pdf", "content-length": 100000 });
        res.write("%PDF-1.4\n%");
        return;
      }
      const body = pages[path];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "not found");
    });
    server.once("error", fail);
    server.listen(port, host, () => ok(server));
  });
}

// --- Zen ------------------------------------------------------------------------

const { connect } = await import(join(here, "../../../scripts/lib/rpc.mjs"));
const instance = process.env.ZENIUS_INSTANCE;
if (!instance) {
  console.error("ZENIUS_INSTANCE is not set");
  process.exit(2);
}
const servers = [await serve("127.0.0.1", PORT_A, PAGES_A), await serve("127.0.0.2", PORT_B, PAGES_B)];
const client = await connect(instance, { callTimeout: 120000 });
const step = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PRE = `
  const sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await fn(); } catch {} if (v || Date.now() > end) return v; await sleep(50); }
  };
  const g = win.ucAgentSidebar;
  const AS = g?.AgentService;
  const panelDoc = () => win.document.getElementById("sidebar")?.contentDocument;
  const openTab = async url => {
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
    await until(() => tab.linkedBrowser.currentURI.spec === url && !tab.hasAttribute("busy"));
    await sleep(300);
    return tab;
  };
  const openPanel = async () => {
    if (!(win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar")) {
      await win.SidebarController.show("viewAgentSidebar");
    }
    await until(() => g.panel);
    return g.panel;
  };
  const view = () => {
    const fe = Services.focus.focusedElement;
    return {
      tab: win.gBrowser.selectedTab.linkedBrowser.currentURI.spec,
      tabs: win.gBrowser.tabs.length,
      space: win.gZenWorkspaces?.activeWorkspace ?? null,
      focused: fe ? fe.localName + (fe.id ? "#" + fe.id : "") : null,
      focusedContent: Services.focus.focusedContentBrowsingContext?.currentWindowGlobal?.documentURI?.spec ?? null,
      sidebarOpen: !!win.SidebarController.isOpen,
      panelFocused: !!panelDoc()?.hasFocus(),
    };
  };
  const convState = c => ({ busy: !!c.busy, status: c.status ?? null, messages: c.messages.map(m => ({ role: m.role, text: (m.text ?? m.title ?? "").slice(0, 100), answer: m.answer ?? undefined })) });
  // Step 6 (Watch, Ctrl+Tab, the live card).
  const inContent = (t, code) => ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { code, privileged: false });
  const UI = () => ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
  const theConv = () => AS.tasks.get(win.__zsConv);
  const isTaskTab = t => { const rec = AS.zenRecord(theConv()); return !!rec && UI().lookup(t)?.rec === rec; };
  // The user's own Ctrl+Tab: a text input processor on the chrome window.
  // held: more keydowns of Tab before it comes up (the same press, held).
  const userCtrlTab = ({ held = 0 } = {}) => {
    const tip = (win.__zsTip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor));
    if (!tip.beginInputTransactionForTests(win)) throw new Error("no keyboard transaction on the chrome window");
    const ctrl = new win.KeyboardEvent("", { key: "Control", code: "ControlLeft", keyCode: 17 });
    const tab = new win.KeyboardEvent("", { key: "Tab", code: "Tab", keyCode: 9 });
    tip.keydown(ctrl); tip.keydown(tab);
    for (let i = 0; i < held; i++) tip.keydown(new win.KeyboardEvent("", { key: "Tab", code: "Tab", keyCode: 9, repeat: true }));
    tip.keyup(tab); tip.keyup(ctrl);
  };
  const clean = s => s == null ? null : s.replace(/[\\u2066-\\u2069]/g, "").replace(/\\s+/g, " ").trim();
  // Since zen-ux's 843a989 the watch is zenius's (ZeniusUI.watch): zenius's
  // strip says "Watching <task> \u00b7 Ctrl+Tab" while the window watches, and the
  // chip (#zenius-watch-pill) says the same only where the strip can't be
  // read (a collapsed sidebar, compact mode). Neither has a Back control.
  // Since af4bc5b a watched task's end keeps the way back: the strip
  // ([watching="done"]) says "Task done \u00b7 Ctrl+Tab back to your tabs", and
  // ZeniusUI.watchingDone gives the ended task's id, until Ctrl+Tab or the
  // user's own pick.
  const chipEl = () => { const c = win.document.getElementById("zenius-watch-pill"); return c && !c.hidden ? c : null; };
  const where = () => {
    const strip = win.document.getElementById("zenius-agents-strip");
    return {
      watching: g.watching,
      zenius: UI().watching?.(win) ?? null,
      done: UI().watchingDone?.(win) ?? null,
      stripState: strip?.getAttribute("watching") ?? null,
      attr: win.document.documentElement.getAttribute("data-zenius-watching"),
      tab: win.gBrowser.selectedTab.linkedBrowser.currentURI.spec,
      space: win.gZenWorkspaces?.activeWorkspace ?? null,
      taskTab: isTaskTab(win.gBrowser.selectedTab),
      strip: strip?.hasAttribute("watching") ? clean(strip.querySelector(".zenius-strip-text")?.textContent) : null,
      chip: clean(chipEl()?.textContent ?? null),
    };
  };
  // Zen's sidebar expanded or collapsed (a collapsed one shows only the
  // strip's dot, so the chip says the watch). Returns how to put it back.
  const sidebarExpanded = async on => {
    const PREF = "zen.view.sidebar-expanded";
    const had = Services.prefs.prefHasUserValue(PREF) ? Services.prefs.getBoolPref(PREF) : null;
    const now = () => win.document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
    Services.prefs.setBoolPref(PREF, on);
    await until(() => now() === on, 5000);
    await sleep(500);
    return () => (had === null ? Services.prefs.clearUserPref(PREF) : Services.prefs.setBoolPref(PREF, had));
  };
  // The live card as the user sees it: its line, its buttons, and the colour
  // at the top middle of its picture.
  const card = () => {
    const doc = panelDoc();
    const live = doc?.getElementById("live");
    if (!live) return null;
    const shot = doc.getElementById("live-shot");
    let px = null;
    try {
      if (shot.width && shot.height) {
        const d = shot.getContext("2d").getImageData(Math.floor(shot.width / 2), Math.min(8, shot.height - 1), 1, 1).data;
        px = [d[0], d[1], d[2]];
      }
    } catch (e) { px = "unread: " + e.message; }
    const box = doc.getElementById("messages").getBoundingClientRect();
    const r = live.getBoundingClientRect();
    const watchBtn = doc.getElementById("watch");
    const hint = doc.getElementById("watch-hint");
    return {
      hidden: live.hidden, live: live.dataset.live ?? null,
      text: doc.getElementById("live-text").textContent,
      // Since zen-sidebar's 68b8d7b: Watch only starts a watch, and while
      // this window watches, #watch hides and #watch-hint shows instead.
      watch: watchBtn.hidden ? null : watchBtn.textContent,
      watching: live.dataset.watching ?? null,
      hint: hint && !hint.hidden ? clean(hint.textContent) : null,
      takeOverShown: !doc.getElementById("take-over").hidden,
      px, size: [shot.width, shot.height],
      inView: !live.hidden && r.bottom > box.top && r.top < box.bottom,
    };
  };
  // When each of the card's pictures started and resolved: every drawSnapshot
  // that agent-sidebar code calls (a wrapper on the WindowGlobalParent
  // prototype: one reflector per object in the shared system compartment, so
  // the panel's calls go through it), and since d9c7646 every sendQuery of
  // the picture actor's parent (one a picture; zen-sidebar's suggestion).
  // unhookPictures() puts both back.
  const hookPictures = () => {
    if (win.__zsPictures) return win.__zsPictures;
    const P = (win.__zsPictures = { list: [], undo: [] });
    const timed = (result) => {
      const entry = { start: win.performance.now(), end: null };
      P.list.push(entry);
      Promise.resolve(result).then(() => (entry.end = win.performance.now()), () => (entry.end = win.performance.now()));
    };
    const wgpProto = Object.getPrototypeOf(win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal);
    const drawSnapshot = wgpProto.drawSnapshot;
    wgpProto.drawSnapshot = function (...args) {
      const from = Components.stack.caller?.filename ?? "";
      const result = drawSnapshot.apply(this, args);
      if (/agent-sidebar/.test(from)) timed(result);
      return result;
    };
    P.undo.push(() => (wgpProto.drawSnapshot = drawSnapshot));
    const actorClass = pictureModule()?.AgentSidebarPictureParent;
    if (actorClass) {
      const had = Object.getOwnPropertyDescriptor(actorClass.prototype, "sendQuery");
      actorClass.prototype.sendQuery = function (...args) {
        const result = Object.getPrototypeOf(actorClass.prototype).sendQuery.apply(this, args);
        timed(result);
        return result;
      };
      P.undo.push(() => (had ? Object.defineProperty(actorClass.prototype, "sendQuery", had) : delete actorClass.prototype.sendQuery));
    }
    return P;
  };
  const unhookPictures = () => {
    const P = win.__zsPictures;
    if (P) {
      for (const undo of P.undo) undo();
      delete win.__zsPictures;
    }
  };
  // The card's pictures drawn so far, as its #live[data-drawn] says (since
  // zen-sidebar's d9c7646; null in a build without it, or with no panel).
  const drawnCount = () => {
    const v = panelDoc()?.getElementById("live")?.dataset.drawn;
    return v === undefined ? null : Number(v);
  };
  // A stretch of time: the card's pictures (the change in #live[data-drawn];
  // in a build without it, the drawSnapshot calls of agent-sidebar code), the
  // parent's main-thread stalls (a 20 ms timer's lateness; the manager's bar:
  // none over 50 ms on the costly page), split, when picture spans are known,
  // into those that overlap a picture and the rest, and the CPU of the parent
  // and of the page's process.
  const stretch = async ms => {
    const procs = async () => { const p = await ChromeUtils.requestProcInfo(); const o = { parent: p.cpuTime }; for (const c of p.children) o[c.pid] = c.cpuTime; return o; };
    const front = AS.zenFrontTab(theConv());
    const pid = front?.linkedBrowser.browsingContext.currentWindowGlobal?.osPid ?? null;
    const P = hookPictures();
    const k0 = P.list.length;
    const doc0 = panelDoc();
    const d0 = drawnCount();
    const c0 = await procs();
    const stalls = [];
    let last = win.performance.now();
    const timer = win.setInterval(() => { const now = win.performance.now(); const lag = now - last - 20; if (lag > 10) stalls.push({ from: last + 20, to: now, lag }); last = now; }, 20);
    await sleep(ms);
    win.clearInterval(timer);
    const c1 = await procs();
    await until(() => P.list.slice(k0).every(p => p.end !== null), 3000);
    const snapshots = P.list.slice(k0);
    const d1 = panelDoc() === doc0 ? drawnCount() : null;
    const byDrawn = d0 !== null || d1 !== null;
    const overlaps = s => snapshots.some(p => s.from < (p.end ?? Infinity) && s.to > p.start);
    const top = list => Math.round(Math.max(0, ...list.map(s => s.lag)));
    const took = snapshots.filter(p => p.end !== null).map(p => Math.round(p.end - p.start)).sort((a, b) => a - b);
    return {
      pictures: byDrawn ? (d1 ?? d0) - (d0 ?? 0) : snapshots.length,
      countedBy: byDrawn ? "data-drawn" : "drawSnapshot",
      every: panelDoc()?.getElementById("live")?.dataset.every ?? null,
      pictureMs: took.length ? { median: took[took.length >> 1], max: took.at(-1) } : null,
      maxStallMs: top(stalls),
      cardStallMs: snapshots.length ? top(stalls.filter(overlaps)) : null,
      parentCpuMs: Math.round((c1.parent - c0.parent) / 1e6),
      pageCpuMs: pid != null && c0[pid] != null && c1[pid] != null ? Math.round((c1[pid] - c0[pid]) / 1e6) : null,
    };
  };
  // The picture actor's parent module (d9c7646), else null.
  const pictureModule = () => {
    try {
      return ChromeUtils.importESModule(panelBase() + "AgentSidebarPictureParent.sys.mjs");
    } catch {
      return null;
    }
  };
  const panelBase = () => {
    const url = win.SidebarController.sidebars.get("viewAgentSidebar")?.url ?? "";
    return url ? url.slice(0, url.lastIndexOf("/") + 1) : "chrome://userscripts/content/agent-sidebar/";
  };
  // One picture from the actor's drawPicture, whichever its signature:
  // (browser, size) at d9c7646, (conv, tab, size) since zen-ux's guard
  // (10edb02), which checks the tab against the chat's task. bytes: the
  // JPEG's data URL, or the raw pixels since 3430b87; ms: the child's own
  // time (d9c7646 only).
  const pictureOf = async (conv, tab, size = { width: 375, height: 120 }) => {
    const mod = pictureModule();
    if (!mod?.drawPicture) return null;
    const p = mod.drawPicture.length >= 3 ? await mod.drawPicture(conv, tab, size) : await mod.drawPicture(tab.linkedBrowser, size);
    return { painted: !!p, bytes: p ? (p.pixels?.byteLength ?? p.url?.length ?? 0) : 0, ms: p?.ms ?? null };
  };
  // A stand-in for a work chat linked by id to the task with that id, for the
  // guard's paintable() (it reads only these fields).
  const convFor = space => ({ kind: "work", zen: { name: "", id: space, since: Date.now() }, createdAt: Date.now() });
  // zenius's Resume agent on its control card over the task's page (armed
  // 400 ms after it shows), as the user presses it.
  const resumeAgent = async rec => {
    const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
    const el = await until(() => ctx.service.pages.tabsOf(rec).map(t => N.noticeElement?.(t, "zenius-control")).find(Boolean), 5000);
    if (!el) return "no control card";
    await sleep(600);
    const b = [...el.querySelectorAll("button")].find(x => x.textContent === "Resume agent");
    if (!b) return "no Resume agent";
    b.click();
    return "pressed";
  };
  // Has the picture actor been made in the tab's document? (getExistingActor
  // makes none.)
  const actorIn = async t => {
    try {
      return await ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, code: "return !!actor.manager.getExistingActor?.('AgentSidebarPicture')" });
    } catch (e) {
      return "unread: " + e.message;
    }
  };
`;
const chrome = (code, arg) => client.call("dev.evalChrome", { code: PRE + code, arg });
const agentEntries = () =>
  existsSync(agentLog)
    ? readFileSync(agentLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : [];
const entriesSince = (n, kind) => agentEntries().slice(n).filter(e => !kind || e.kind === kind);

/** Ask in the selected tab's chat (as the user would from the panel), and wait for the answer. */
const ASK = `
  const tab = win.gBrowser.selectedTab;
  const conv = g.conversationFor(tab);
  if (arg.panel) { await openPanel(); g.panel.show(conv); }
  const sent = g.submit(conv, { question: arg.question, selection: "", attachments: [] });
  sent.catch(() => {});
  await until(() => conv.busy, 5000);
  const done = await until(() => !conv.busy, arg.wait ?? 20000);
  return { done: !!done, state: convState(conv) };
`;

const suffix = () => Date.now().toString(36).slice(-5);

/**
 * The user, on their own page, starts a work chat (step 6). Returns once the
 * sidebar has seen its agent's zenius open call, which the scripted agent
 * keeps running (LINK's WAIT, 4 s) while this probe makes the task, as
 * zenius makes it during the agent's own open: since zen-sidebar's 7c72787
 * the sidebar links a chat only to a task made while its open ran. With
 * arg.open false (no open call coming) it waits a second instead.
 */
const START_CHAT = `
  await openTab(arg.url);
  const uid = await g.startWorkChat(arg.question, { source: "urlbar" });
  win.__zsConv = uid;
  const conv = AS.tasks.get(uid);
  if (arg.open === false) { await sleep(1000); return { openSeen: null }; }
  const seen = await until(() => conv.messages.some(m => m.role === "tool" && String(m.id).startsWith("open")), 15000);
  return { openSeen: !!seen };
`;
/** Then the chat's link: the task it follows, once the agent's open has ended. */
const AWAIT_LINK = `
  const conv = theConv();
  const rec = await until(() => AS.zenRecord(conv), arg?.ms ?? 10000);
  await until(() => conv.busy, 5000);
  return { linked: rec ? rec.name : null, busy: !!conv.busy };
`;

/** One picture of the task's front tab as the card takes it (its scale), timed, arg.n times. */
const COST = `
  const front = AS.zenFrontTab(theConv());
  const wgp = front.linkedBrowser.browsingContext.currentWindowGlobal;
  const doc = panelDoc();
  const width = Math.round((doc?.getElementById("live-shot")?.clientWidth || 380) * (doc?.defaultView?.devicePixelRatio || 1));
  const pageWidth = win.gBrowser.selectedBrowser.getBoundingClientRect().width || 1280;
  const scale = Math.min(1, Math.max(0.2, width / pageWidth));
  const times = [];
  for (let i = 0; i < arg.n; i++) {
    const t0 = win.performance.now();
    const bitmap = await wgp.drawSnapshot(null, scale, "white");
    times.push(Math.round(win.performance.now() - t0));
    bitmap.close();
    await sleep(100);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { url: front.linkedBrowser.currentURI.spec.replace(/^http:\\/\\/[^/]+/, ""), scale: Math.round(scale * 100) / 100, median: sorted[sorted.length >> 1], max: sorted.at(-1), times };
`;

const CASES = {
  async xss() {
    await chrome(`await openTab(arg); return true;`, `${A}/plain`);
    const asked = await chrome(ASK, { question: "XSS", panel: true });
    await sleep(500);
    const dom = await chrome(`
      const doc = panelDoc();
      const msg = [...doc.querySelectorAll(".msg")].reverse().find(m => m.textContent.includes("Red team answer"));
      if (!msg) return { error: "no rendered answer", text: doc.body.textContent.slice(0, 300) };
      const els = [...msg.querySelectorAll("*")];
      const tags = [...new Set(els.map(e => e.localName))].sort();
      const handlers = els.flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => e.localName + "[" + a.name + "]"));
      const styled = els.filter(e => e.hasAttribute("style")).map(e => e.localName);
      const links = [...msg.querySelectorAll("a[href]")].map(a => ({ href: a.getAttribute("href"), text: a.textContent }));
      const overlay = !!doc.getElementById("zsOverlay");
      return { tags, handlers, styled, links, overlay, bodyVisible: doc.defaultView.getComputedStyle(doc.body).display };
    `);
    // The user clicks every link in the answer.
    const clicks = await chrome(`
      const doc = panelDoc();
      const msg = [...doc.querySelectorAll(".msg")].reverse().find(m => m.textContent.includes("Red team answer"));
      const before = new Set(win.gBrowser.tabs);
      const out = {};
      for (const a of msg ? msg.querySelectorAll("a[href]") : []) {
        a.click();
        await sleep(400);
        const added = win.gBrowser.tabs.filter(t => !before.has(t));
        out[a.getAttribute("href").slice(0, 50)] = added.map(t => t.linkedBrowser.currentURI.spec || "(loading)");
        for (const t of added) { before.add(t); }
      }
      await sleep(600);
      const opened = win.gBrowser.tabs.filter(t => !before.has(t) || /127\\.0\\.0\\.1:${PORT_A}\\/clicked/.test(t.linkedBrowser.currentURI.spec));
      const urls = opened.map(t => t.linkedBrowser.currentURI.spec);
      for (const t of opened) win.gBrowser.removeTab(t, { animate: false });
      return { perLink: out, openedNow: urls, panelUrl: panelDoc()?.URL ?? null };
    `);
    const canary = await chrome(`return Services.prefs.getBoolPref("zs.redteam.xss", false);`);
    return { asked: asked.done, dom, clicks, canary, serverHits: hits.filter(h => /clicked|pixel|remote|form|refresh/.test(h)) };
  },

  // An answer dressed as the panel's own permission prompt: what of it survives?
  async spoof() {
    await chrome(`await openTab(arg); return true;`, `${A}/plain`);
    const asked = await chrome(ASK, { question: "SPOOF", panel: true });
    await sleep(400);
    const dom = await chrome(`
      const doc = panelDoc();
      const msg = [...doc.querySelectorAll(".msg")].reverse().find(m => m.textContent.includes("Spoof answer"));
      const body = msg && [...msg.children].find(c => c.textContent.includes("Spoof answer"));
      if (!body) return { error: "no rendered answer" };
      return [...body.querySelectorAll("*")].map(e => ({ tag: e.localName, class: e.getAttribute("class"), id: e.id || null, data: Object.keys(e.dataset).join(",") || null, text: e.textContent.slice(0, 40) }));
    `);
    return { asked: asked.done, rendered: dom };
  },

  async perm() {
    await chrome(`await openTab(arg); return true;`, `${A}/plain`);
    const n = agentEntries().length;
    const started = await chrome(`
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      const sent = g.submit(conv, { question: "PERM", selection: "", attachments: [] });
      sent.catch(() => {});
      await until(() => conv.messages.some(m => m.role === "permission"), 8000);
      await sleep(2500);
      return { state: convState(conv), needs: AS.needsCount?.() ?? null };
    `);
    const beforeStop = entriesSince(n, "permission");
    const stopped = await chrome(`
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      await AS.cancel(conv);
      await until(() => !conv.busy, 8000);
      return convState(conv);
    `);
    await sleep(800);
    return { started, answeredBeforeStop: beforeStop, afterStop: entriesSince(n, "permission"), stopped };
  },

  async fs() {
    await chrome(`await openTab(arg); return true;`, `${A}/plain`);
    const n = agentEntries().length;
    const asked = await chrome(ASK, { question: "FS" });
    const fsEntry = entriesSince(n, "fs")[0]?.data ?? null;
    return {
      asked: asked.done,
      fs: fsEntry && Object.fromEntries(Object.entries(fsEntry).map(([k, v]) => [k, v.error ? `error ${v.error.code} ${v.error.message}` : v.answered ? "answered" : "no answer"])),
      written: existsSync(join(workspace, "zs-written.txt")),
      terminal: existsSync(join(workspace, "zs-terminal")),
      initialize: agentEntries().find(e => e.kind === "initialize")?.data?.clientCapabilities ?? null,
    };
  },

  async echo() {
    await chrome(`await openTab(arg); return true;`, `${A}/hidden`);
    const n = agentEntries().length;
    const asked = await chrome(ASK, { question: "ECHO" });
    const prompt = entriesSince(n, "prompt")[0]?.data;
    const text = (prompt?.resources ?? []).map(r => r.text).join("\n");
    const marks = ["TITLE", "NAV", "VISIBLE", "DISPNONE", "VISHIDDEN", "OFFSCREEN", "WHITE", "TINY", "OPACITY", "SRONLY", "ARIAHIDDEN", "SUMMARY", "COLLAPSED",
      "COMMENT", "NOSCRIPT", "TEMPLATE", "ALT", "PASSWORD", "HIDDENINPUT", "INPUTVALUE", "TEXTAREA", "IFRAME_SAME", "IFRAME_CROSS"];
    return {
      asked: asked.done,
      resources: (prompt?.resources ?? []).map(r => ({ uri: r.uri, mimeType: r.mimeType, length: (r.text ?? "").length })),
      sent: marks.filter(m => text.includes(m + "_MARK")),
      notSent: marks.filter(m => !text.includes(m + "_MARK")),
      instructions: (prompt?.texts ?? []).some(t => t.includes("<instructions>")),
    };
  },

  async fakepdf() {
    await chrome(`await openTab(arg); return true;`, `${A}/fakepdf`);
    const n = agentEntries().length;
    const asked = await chrome(ASK, { question: "ECHO" });
    const prompt = entriesSince(n, "prompt")[0]?.data;
    const text = (prompt?.resources ?? []).map(r => r.text).join("\n");
    return {
      asked: asked.done,
      contentType: await chrome(`return win.gBrowser.selectedBrowser.documentContentType;`),
      // Neither mark contains the other (zen-ux: an earlier fake mark was part of the visible one).
      gotFakeText: text.includes("PDFAPI_ONLY_MARK"),
      gotVisibleText: text.includes("VISIBLE_FAKEPDF_MARK"),
      header: text.split("\n\n")[0],
    };
  },

  async stallpdf() {
    await chrome(`await openTab(arg); return true;`, `${A}/stallpdf`);
    const n = agentEntries().length;
    const asked = await chrome(ASK, { question: "ECHO", wait: 8000 });
    const reachedAgent = entriesSince(n, "prompt").length > 0;
    const stopped = await chrome(`
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      if (conv.busy) await AS.cancel(conv);
      await until(() => !conv.busy, 5000);
      return { busyAfterStop: !!conv.busy };
    `);
    return { finishedIn8s: asked.done, status: asked.state.status, reachedAgent, ...stopped };
  },

  // A real PDF in Firefox's viewer: its text still reaches the agent (the control for the PDF fix).
  async realpdf() {
    await chrome(`await openTab(arg); await until(() => win.gBrowser.selectedBrowser.documentContentType === "application/pdf", 10000); await sleep(1500); return true;`, `${A}/real.pdf`);
    const n = agentEntries().length;
    const asked = await chrome(ASK, { question: "ECHO" });
    const prompt = entriesSince(n, "prompt")[0]?.data;
    const text = (prompt?.resources ?? []).map(r => r.text).join("\n");
    return {
      asked: asked.done,
      contentType: await chrome(`return win.gBrowser.selectedBrowser.documentContentType;`),
      gotText: text.includes("REALPDF_MARK"),
      header: text.split("\n\n")[0],
    };
  },

  // A PDF that never finishes loading: the read must end, and Stop must too.
  async slowpdf() {
    await chrome(`
      const tab = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      win.gBrowser.selectedTab = tab;
      await until(() => tab.linkedBrowser.documentContentType === "application/pdf", 10000);
      await sleep(1000);
      return true;`, `${A}/slow.pdf`);
    const n = agentEntries().length;
    const t0 = Date.now();
    const asked = await chrome(ASK, { question: "ECHO", wait: 40000 });
    const ms = Date.now() - t0;
    const stopped = await chrome(`
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      const busy = !!conv.busy;
      if (busy) await AS.cancel(conv);
      await until(() => !conv.busy, 5000);
      return { busyBeforeStop: busy, busyAfterStop: !!conv.busy };
    `);
    return { finished: asked.done, ms, status: asked.state.status, lastMessage: asked.state.messages.at(-1), reachedAgent: entriesSince(n, "prompt").length > 0, ...stopped };
  },

  // Stop while the panel reads a PDF that never finishes: the question ends
  // at Stop, and the agent hears nothing, then or once the read's own bound
  // (30 s) has passed.
  async slowpdfStop() {
    await chrome(`
      const tab = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      win.gBrowser.selectedTab = tab;
      await until(() => tab.linkedBrowser.documentContentType === "application/pdf", 10000);
      await sleep(1000);
      return true;`, `${A}/slow.pdf`);
    const n = agentEntries().length;
    const stopped = await chrome(`
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      g.submit(conv, { question: "ECHO", selection: "", attachments: [] }).catch(() => {});
      await until(() => conv.busy, 5000);
      const reading = !!(await until(() => /Reading/.test(conv.status ?? ""), 15000));
      await sleep(2000);
      const statusAtStop = conv.status ?? null;
      const t0 = Date.now();
      AS.cancel(conv);
      const ended = !!(await until(() => !conv.busy, 5000));
      return { reading, statusAtStop, ended, stopMs: Date.now() - t0, last: convState(conv).messages.at(-1) ?? null };
    `);
    const heardAtStop = entriesSince(n, "prompt").length > 0;
    await sleep(31000);
    return { ...stopped, heardAtStop, heardLater: entriesSince(n, "prompt").length > 0 };
  },

  // What each session got at session/new, and what its first prompt said about page text.
  async sessions() {
    const entries = agentEntries();
    const firstPrompt = {};
    for (const e of entries.filter(e => e.kind === "prompt")) firstPrompt[e.data.sessionId] ??= e.data;
    return entries.filter(e => e.kind === "session/new").map(e => {
      const p = e.data.params ?? {};
      const prompt = firstPrompt[e.data.sessionId];
      const system = JSON.stringify(p.systemPrompt ?? "");
      const instructions = (prompt?.texts ?? []).find(t => t.includes("<instructions>")) ?? "";
      return {
        sessionId: e.data.sessionId,
        keys: Object.keys(p),
        mcpServers: (p.mcpServers ?? []).map(m => m.name ?? m.command ?? JSON.stringify(m).slice(0, 60)),
        meta: p._meta ? JSON.stringify(p._meta).slice(0, 300) : null,
        untrustedWording: /untrusted|not instructions|never .*instructions/i.test(system + instructions),
        work: /browser agent/i.test(system + instructions),
        pageAttached: (prompt?.resources ?? []).length > 0,
        firstQuestion: (prompt?.texts ?? []).filter(t => !t.includes("<instructions>")).join(" ").slice(0, 60),
      };
    });
  },

  // The user drops text a page offered onto the address bar. Firefox searches
  // dropped text with the default engine, so a loopback engine is the default
  // for the drop: nothing leaves the machine.
  async drop() {
    const n = agentEntries().length;
    const out = await chrome(`
      const { SearchService: S } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
      await S.init();
      const original = await S.getDefault();
      const engine = await S.addUserEngine({ name: "ZS loopback", url: arg.search });
      const reason = S.CHANGE_REASON?.UNKNOWN ?? 0;
      await S.setDefault(engine, reason);
      try {
        await openTab(arg.url);
        const before = new Set(AS.tasks.keys());
        const dt = new win.DataTransfer();
        dt.setData("text/plain", ">ZSDROP red team");
        const ev = new win.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
        win.gURLBar.inputField.dispatchEvent(ev);
        await sleep(2500);
        const added = [...AS.tasks.keys()].filter(k => !before.has(k));
        return { newTasks: added.length, tab: win.gBrowser.selectedTab.linkedBrowser.currentURI.spec, engine: (await S.getDefault()).name };
      } finally {
        await S.setDefault(original, reason);
        await S.removeEngine(engine);
      }
    `, { url: `${A}/plain`, search: `${A}/search?q=%s` });
    return { ...out, agentGotIt: entriesSince(n, "prompt").some(e => e.data.texts.join(" ").includes("ZSDROP")), searchHits: hits.filter(h => h.includes("/search")) };
  },

  // The control for drop: the user types '>' and presses Enter.
  async typed() {
    const n = agentEntries().length;
    const out = await chrome(`
      await openTab(arg.url);
      const before = new Set(AS.tasks.keys());
      win.gURLBar.focus();
      win.gURLBar.inputField.value = ">ZSTYPED red team";
      win.gURLBar.inputField.dispatchEvent(new win.Event("input", { bubbles: true }));
      const row = await until(() => win.gURLBar.view.isOpen && win.document.querySelector('.urlbarView-row[dynamicType="zeniusAskAgent"]'), 5000);
      win.gURLBar.handleCommand(new win.KeyboardEvent("keydown", { key: "Enter" }));
      await sleep(2500);
      const added = [...AS.tasks.keys()].filter(k => !before.has(k));
      return { row: !!row, newTasks: added.length, view: view() };
    `, { url: `${A}/plain` });
    await sleep(1500);
    return { ...out, agentGotIt: entriesSince(n, "prompt").some(e => e.data.texts.join(" ").includes("ZSTYPED")) };
  },

  // Work mode: the user starts a task, closes the sidebar and reads their page; the agent works.
  async i1work() {
    const out = await chrome(`
      await openTab(arg.url);
      const uid = await g.startWorkChat("I1 red team work", { source: "urlbar" });
      const conv = AS.tasks.get(uid);
      await until(() => conv?.busy, 5000);
      win.SidebarController.hide();
      win.gBrowser.selectedBrowser.focus();
      await sleep(300);
      const base = view();
      const changes = [];
      const end = Date.now() + 7000;
      while (Date.now() < end && conv.busy) {
        const now = view();
        for (const k of Object.keys(base)) if (now[k] !== base[k]) changes.push({ k, from: base[k], to: now[k], at: Date.now() });
        await sleep(150);
      }
      return { base, changes: changes.slice(0, 10), stillBusy: !!conv.busy, state: convState(conv), needs: AS.needsCount?.() ?? null };
    `, { url: `${A}/plain` });
    return out;
  },

  // Chat mode: the panel is open on the tab's chat, the user asked, then went back to the page.
  async i1chat() {
    return chrome(`
      await openTab(arg.url);
      const conv = g.conversationFor(win.gBrowser.selectedTab);
      await openPanel();
      g.panel.show(conv);
      const sent = g.submit(conv, { question: "I1 red team chat", selection: "", attachments: [] });
      sent.catch(() => {});
      await until(() => conv.busy, 5000);
      win.gBrowser.selectedBrowser.focus();
      await sleep(300);
      const base = view();
      const changes = [];
      const end = Date.now() + 7000;
      while (Date.now() < end && conv.busy) {
        const now = view();
        for (const k of Object.keys(base)) if (now[k] !== base[k]) changes.push({ k, from: base[k], to: now[k] });
        await sleep(150);
      }
      return { base, changes: changes.slice(0, 10), stillBusy: !!conv.busy, state: convState(conv) };
    `, { url: `${A}/plain` });
  },

  // Step 6, the live card (the manager's condition 2): what it shows, and
  // whether it draws only while the sidebar is open and the card visible.
  // This probe's own zenius client stands in for the agent's zenius calls;
  // the scripted agent names the task, so the chat links to it, and stays busy.
  async live() {
    const name = `zs-live-${suffix()}`;
    const n = agentEntries().length;
    const opened = await chrome(START_CHAT, { url: `${A}/plain`, question: `LINK ${name} HOLD 110 LONG` });
    const { id: space } = await client.call("spaces.create", { name });
    const out = {};
    try {
      await client.call("page.goto", { space, page: "p1", url: `${A}/live` });
      out.start = { ...opened, ...(await chrome(AWAIT_LINK)) };
      const phase = (label, setup) =>
        chrome(`${setup}; await sleep(1200); const before = where(); const s = await stretch(8000); return { ...s, card: card(), where: where(), moved: JSON.stringify(before) !== JSON.stringify(where()) };`).then(r => {
          step("live", label, JSON.stringify({ pictures: r.pictures, countedBy: r.countedBy, every: r.every, maxStallMs: r.maxStallMs, cardStallMs: r.cardStallMs }));
          out[label] = r;
        });
      // At the end of the thread, in view, while the agent works.
      await phase("visible", `await openPanel(); g.showTask(theConv()); const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight`);
      out.userTabIsTask = await chrome(`return isTaskTab(win.gBrowser.selectedTab);`);
      // Scrolled up the thread: the card is out of view.
      await phase("scrolledAway", `panelDoc().getElementById("messages").scrollTop = 0`);
      // The panel on Chat, then back on the task.
      await phase("chatMode", `g.setMode("chat")`);
      await chrome(`g.showTask(theConv()); const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight; return true;`);
      // The sidebar closed.
      await phase("sidebarClosed", `win.SidebarController.hide()`);
      out.panelAfterClose = await chrome(`return panelDoc()?.URL ?? null;`);
      // The cost of one picture, timed directly, on this page and on a costly one.
      out.costLive = await chrome(COST, { n: 10 });
      await client.call("page.goto", { space, page: "p1", url: `${A}/heavy` });
      out.costHeavy = await chrome(COST, { n: 10 });
      await phase("heavyClosed", `win.SidebarController.hide()`);
      await phase("heavyVisible", `await openPanel(); g.showTask(theConv()); const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight`);
      // The agent hands the task to the user: the card waits; nothing moves (I1).
      await client.call("page.goto", { space, page: "p1", url: `${A}/live` });
      out.handOff = await client.call("spaces.handOff", { space }).then(r => r?.ownership ?? "ok", e => ({ error: e.message }));
      await phase("handedOff", `0`);
      // The agent's turn ends.
      await phase("done", `await AS.cancel(theConv()); await until(() => !theConv().busy, 5000)`);
      // The picture never goes to the agent: the next question carries text only.
      await chrome(`const sent = g.submit(theConv(), { question: "ECHO after the card", selection: "", attachments: [] }); sent.catch(() => {}); await until(() => !theConv().busy, 10000); return true;`);
      out.promptTypes = entriesSince(n, "prompt").map(e => e.data.types ?? null);
      // The manager's condition 2, with zen-sidebar's bar: a picture every 2 s
      // at most while the card shows (8 s: 4, and one as it appears), none
      // while it doesn't, and no stall over 50 ms from the card on the costly page.
      // The bar is judged by each stretch's worst stall, whatever caused it
      // (zen-sidebar's ask), and a card that drew fewer than 2 pictures in
      // view fails: its pictures weren't counted, so nothing else can pass.
      const count = label => out[label]?.pictures ?? null;
      const seen = count("visible");
      out.condition2 = {
        countingWorks: seen !== null && seen >= 2,
        everyTwoSeconds: seen !== null && seen <= 5 && (count("heavyVisible") ?? Infinity) <= 5,
        noneWhenHidden: ["scrolledAway", "chatMode", "sidebarClosed", "heavyClosed", "handedOff", "done"].every(l => count(l) === 0),
        heavyMaxStallMs: out.heavyVisible?.maxStallMs ?? null,
        stallBar50: (out.heavyVisible?.maxStallMs ?? Infinity) <= 50,
        heavyEvery: out.heavyVisible?.every ?? null,
        pictures: Object.fromEntries(["visible", "scrolledAway", "chatMode", "sidebarClosed", "heavyClosed", "heavyVisible", "handedOff", "done"].map(l => [l, count(l)])),
      };
      out.condition2.pass = out.condition2.countingWorks && out.condition2.everyTwoSeconds && out.condition2.noneWhenHidden && out.condition2.stallBar50;
    } finally {
      await chrome(`unhookPictures(); await g.stopWatching({ back: true }); return true;`).catch(() => {});
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    return out;
  },

  // Step 6, Watch and Ctrl+Tab (the manager's condition 3, I1): only the
  // user's click starts a watch and only the user's Ctrl+Tab goes back; the
  // page's own Ctrl+Tab and the agent's change nothing. Since 843a989 the
  // watch is zenius's: with Zen's sidebar expanded, its strip says
  // "Watching <task> \u00b7 Ctrl+Tab" and the chip stays away (pill has the chip).
  // Since af4bc5b the task's end keeps Ctrl+Tab's way back: nothing moves by
  // itself, the page's own Ctrl+Tab doesn't take it, the user's does, and
  // the page they watched closes once they leave it.
  async watch() {
    const name = `zs-watch-${suffix()}`;
    const opened = await chrome(START_CHAT, { url: `${A}/plain`, question: `LINK ${name} HOLD 90` });
    const { id: space } = await client.call("spaces.create", { name });
    const out = {};
    const agentPress = page => client.call("page.keyboard", { space, page, action: "press", key: "Control+Tab", options: {} }).then(() => "ok", e => `${e.code ?? ""} ${e.message}`.slice(0, 160));
    try {
      await chrome(`win.__zsSidebarBack = await sidebarExpanded(true); return true;`);
      await client.call("page.goto", { space, page: "p1", url: `${A}/live?ctrltab=1` });
      out.start = { ...opened, ...(await chrome(AWAIT_LINK)) };
      out.home = await chrome(`await sleep(1500); return where();`);
      // Not watching: the page keeps sending itself Ctrl+Tab; the agent presses it too.
      out.agentPressIdle = await agentPress("p1");
      out.idle = await chrome(`await sleep(1500); return where();`);
      // The user clicks Watch on the card.
      out.watched = await chrome(`
        await openPanel(); g.showTask(theConv());
        await until(() => !panelDoc().getElementById("live").hidden, 5000);
        panelDoc().getElementById("watch").click();
        await until(() => g.watching, 5000);
        await sleep(600);
        return { ...where(), card: card() };
      `);
      // While watching: the page's Ctrl+Tab goes on, the agent presses it,
      // opens a tab and moves its page.
      out.pageCtrlTab = await chrome(`await sleep(1500); return { ...where(), pageSent: (await inContent(win.gBrowser.selectedTab, "return window.__keys.filter(k => k.includes('(synthetic)')).length")) };`);
      out.agentPress = await agentPress("p1");
      out.afterAgentPress = await chrome(`await sleep(800); return { ...where(), pageHeard: await inContent(win.gBrowser.selectedTab, "return window.__keys.filter(k => !k.includes('(synthetic)')).slice(-6)") };`);
      out.agentNewTab = await client.call("pages.new", { space, url: `${A}/live2` }).then(r => r?.label ?? "ok", e => ({ error: e.message }));
      out.afterNewTab = await chrome(`await sleep(1500); return where();`);
      out.agentGoto = await client.call("page.goto", { space, page: "p1", url: `${A}/live?ctrltab=1&moved=1` }).then(() => "ok", e => ({ error: e.message }));
      out.afterGoto = await chrome(`await sleep(1500); return where();`);
      // The user's Ctrl+Tab, held a moment: back to their page, and the rest
      // of that press (the held key's next keydown) goes no further. A
      // second later a new press is Zen's. Zen's own Ctrl+Tab listens in the
      // system group on the document, after zenius's window listener: what
      // reaches a listener there is Zen's. (Since 843a989 the key's keyup
      // ends that press, so a new press at once is Zen's too.)
      out.userCtrlTab = await chrome(`
        const reached = [];
        const listen = e => { if (e.key === "Tab" && e.ctrlKey) reached.push(reached.label); };
        win.document.addEventListener("keydown", listen, { mozSystemGroup: true });
        try {
          reached.label = "back";
          userCtrlTab({ held: 2 });
          await until(() => !g.watching, 3000);
          await sleep(300);
          const back = where();
          await sleep(900);
          reached.label = "later";
          userCtrlTab();
          await sleep(600);
          const later = where();
          return { back, laterTab: later.tab, laterTabChanged: later.tab !== back.tab, reachedZen: reached };
        } finally {
          win.document.removeEventListener("keydown", listen, { mozSystemGroup: true });
        }
      `);
      out.backHome = out.userCtrlTab.back.tab === out.home.tab && out.userCtrlTab.back.space === out.home.space;
      // Put the user back on their page for the next part.
      await chrome(`const t = win.gBrowser.tabs.find(x => x.linkedBrowser.currentURI.spec === arg); if (t) win.gBrowser.selectedTab = t; await sleep(300); return true;`, out.home.tab);
      // The user watches; the agent closes the page they watch.
      out.watch2 = await chrome(`panelDoc().getElementById("watch").click(); await until(() => g.watching, 5000); await sleep(600); return { ...where(), label: ctx.service.pages.forTab?.(win.gBrowser.selectedTab)?.label ?? null };`);
      out.agentClose = out.watch2.label ? await client.call("pages.close", { space, page: out.watch2.label }).then(() => "ok", e => ({ error: e.message })) : "no label";
      out.afterAgentClose = await chrome(`await sleep(1500); return where();`);
      // The user watches again, on the agent's other page, now one that keeps
      // sending itself Ctrl+Tab; the agent ends its task. Since af4bc5b the
      // window stays and keeps Ctrl+Tab's way back ("Task done"), which the
      // page's own Ctrl+Tab must not take. Then the user's Ctrl+Tab goes back,
      // and the page they left closes a tick later (zen-core's closeLeft).
      out.agentGotoDone = typeof out.agentNewTab === "string" && out.agentNewTab !== "ok"
        ? await client.call("page.goto", { space, page: out.agentNewTab, url: `${A}/live?ctrltab=1&done=1` }).then(() => "ok", e => ({ error: e.message }))
        : "no page label";
      out.watch3 = await chrome(`const shown = await g.watch(win.__zsConv); await sleep(600); return { shown, ...where() };`);
      out.agentFinish = await client.call("spaces.finish", { space, keep: [] }).then(() => "ok", e => ({ error: e.message }));
      out.afterFinish = await chrome(`await sleep(1500); return where();`);
      out.doneBack = await chrome(`
        userCtrlTab();
        await until(() => !UI().watchingDone?.(win), 3000);
        await sleep(600);
        return { ...where(), leftPageOpen: win.gBrowser.tabs.some(t => !t.closing && t.linkedBrowser.currentURI.spec.includes("done=1")) };
      `);
      // What the user saw, judged: the card and zenius's strip while
      // watching, no chip with the sidebar expanded, only the user's
      // Ctrl+Tab ending the watch, and after the task's end the way back
      // kept until the user's Ctrl+Tab.
      const hintOk = w => w?.strip === `Watching ${name} \u00b7 Ctrl+Tab` && w?.chip === null;
      const f = out.afterFinish ?? {};
      out.verdict = {
        cardWhileWatching: out.watched?.card ? { watch: out.watched.card.watch, watching: out.watched.card.watching, hint: out.watched.card.hint } : null,
        cardOk: out.watched?.card?.watch === null && out.watched?.card?.watching === "true" && out.watched?.card?.hint === "Ctrl+Tab back to your tabs",
        stripHint: hintOk(out.watched) && hintOk(out.pageCtrlTab),
        zeniusWatches: out.watched?.zenius === space,
        notByPageOrAgent: !out.idle?.watching && !!out.pageCtrlTab?.watching && !!out.afterAgentPress?.watching,
        backHome: out.backHome,
        heldPressStopped: !(out.userCtrlTab?.reachedZen ?? []).includes("back"),
        // Whether Zen then moves a tab depends on the Space's tabs.
        laterIsZens: (out.userCtrlTab?.reachedZen ?? []).includes("later"),
        hintGoneAfter: out.userCtrlTab?.back?.strip === null && out.userCtrlTab?.back?.chip === null,
        // After the task's end (zen-ux's suggested check, af4bc5b).
        doneHint: f.watching === null && f.zenius === null && f.attr === null && f.done === space && f.stripState === "done" && f.strip === "Task done \u00b7 Ctrl+Tab back to your tabs" && f.chip === null,
        doneNothingMoved: out.agentGotoDone === "ok" && !!f.tab && f.tab === out.watch3?.tab,
        doneBack: out.doneBack?.tab === out.home?.tab && out.doneBack?.done === null && out.doneBack?.strip === null,
        leftPageClosed: out.doneBack?.leftPageOpen === false,
      };
    } finally {
      await chrome(`await g.stopWatching({ back: true }); await AS.cancel(theConv()).catch(() => {}); win.__zsSidebarBack?.(); win.__zsSidebarBack = null; return true;`).catch(() => {});
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      // Back on the user's page, whatever happened.
      if (out.home?.tab) await chrome(`if (arg.space && win.gZenWorkspaces.activeWorkspace !== arg.space) await win.gZenWorkspaces.changeWorkspaceWithID(arg.space); const t = win.gBrowser.tabs.find(x => x.linkedBrowser.currentURI.spec === arg.tab); if (t) win.gBrowser.selectedTab = t; return true;`, out.home).catch(() => {});
    }
    return out;
  },

  // Step 6's chip while the user watches (Take over watches too). At 10edb02
  // the pill sat over the page's top middle and grew with the task's name (up
  // to 80% of the window); the manager's bar for the fix: with a
  // 200-character name, a click at the page's top center reaches the page,
  // while watching and after Take over. Since zen-ux's 843a989 zenius's
  // strip says "Watching <task> \u00b7 Ctrl+Tab", and the chip says the same only
  // where the strip can't be read, as a hint with no Back: every click goes
  // through it, and only the user's Ctrl+Tab goes back. Each name is watched
  // with Zen's sidebar expanded (the strip, no chip), then collapsed (the
  // chip): where it sits, what it covers, where the user's clicks on it and
  // on the fields along the page's top land, and Ctrl+Tab.
  async pill() {
    const out = {};
    const long = n => `zs-pill-${"x".repeat(n - 14)}-${suffix()}`;
    // A name over 80 characters links only by id (zen-sidebar's 7c72787):
    // before it, the chat looked its task up by its title, cut at 80.
    for (const [label, name, how] of [["short", `zs-pill-${suffix()}`, "watch"], ["long75", long(75), "watch"], ["long200", long(200), "watch"], ["long200TakeOver", long(200), "takeOver"]]) {
      const opened = await chrome(START_CHAT, { url: `${A}/plain`, question: `LINK ${name} HOLD 60` });
      const { id: space } = await client.call("spaces.create", { name });
      try {
        await client.call("page.goto", { space, page: "p1", url: `${A}/pillpage` });
        const start = { ...opened, ...(await chrome(AWAIT_LINK)) };
        if (!start.linked) {
          out[label] = { nameLength: name.length, start, error: "the chat didn't link to its task" };
          continue;
        }
        out[label] = { nameLength: name.length, start, ...(await chrome(`
          const userTab = win.gBrowser.selectedTab;
          const putBack = await sidebarExpanded(true);
          try {
            await openPanel(); g.showTask(theConv());
            await until(() => !panelDoc().getElementById("live").hidden, 5000);
            if (arg === "takeOver") {
              panelDoc().getElementById("take-over").click();
              await until(() => g.watching && AS.zenRecord(theConv())?.ownership === "agentDelegatedToUser", 8000);
            } else {
              panelDoc().getElementById("watch").click();
              await until(() => g.watching, 5000);
            }
            await sleep(800);
            const tab = win.gBrowser.selectedTab;
            // Expanded: zenius's strip says it, and no chip.
            const expanded = where();
            // Collapsed: only the strip's dot shows, so the chip says it.
            await sidebarExpanded(false);
            await sleep(400);
            const b = tab.linkedBrowser.getBoundingClientRect();
            const area = win.document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
            const chip = chipEl();
            const cr = chip?.getBoundingClientRect() ?? null;
            const keyEl = chip?.querySelector(".zenius-watch-key") ?? null;
            const nameEl = chip?.querySelector(".zenius-watch-name") ?? null;
            const kr = keyEl?.getBoundingClientRect() ?? null;
            const rect = r => r && r.width ? [r.left, r.top, r.width, r.height].map(Math.round) : null;
            const center = r => [r.left + r.width / 2, r.top + r.height / 2];
            const inside = ([x, y], r) => !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            // Where a click at a point goes, by the window's hit test (which
            // skips pointer-events: none): the page, the chip, or other chrome.
            const landsOn = (x, y) => {
              const el = win.document.elementFromPoint(x, y);
              return !el ? "nothing" : el === tab.linkedBrowser ? "page" : el.closest?.("#zenius-watch-pill") ? "chip" : (el.id || el.localName);
            };
            const fields = {};
            for (const id of ["left", "mid", "right"]) {
              const at = await inContent(tab, "const r = document.getElementById(" + JSON.stringify(id) + ").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];");
              const p = [b.left + at[0], b.top + at[1]];
              fields[id] = { at: p.map(Math.round), underChip: inside(p, cr), lands: landsOn(...p) };
            }
            // Looked at before any click: a click in the agent's page while the
            // agent has it brings zenius's takeover prompt.
            const topCenter = landsOn(area.left + area.width / 2, area.top + 20);
            const controls = chip ? chip.querySelectorAll("button, a, input, select, textarea, [role=button], [tabindex]").length : null;
            const pointerEvents = chip ? win.getComputedStyle(chip).pointerEvents : null;
            const before = where();
            // The user's click, from the parent (a real click's path through chrome).
            const click = async ([x, y]) => {
              const send = (type, buttons = 0) => win.synthesizeMouseEvent(type, x, y,
                { identifier: 0, button: 0, buttons, clickCount: 1, modifiers: 0, inputSource: 1 },
                { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false });
              send("mousemove"); await sleep(30); send("mousedown", 1); await sleep(40); send("mouseup");
              await sleep(600);
            };
            const focused = () => inContent(tab, "return document.activeElement?.id ?? null");
            const clickOn = async el => {
              if (!el || !rect(el.getBoundingClientRect())) return null;
              const p = center(el.getBoundingClientRect());
              const lands = landsOn(...p);
              await click(p);
              return { lands, focused: await focused(), watchingAfter: !!g.watching };
            };
            // On the chip's name and on its key: the page under them gets the click.
            const onName = await clickOn(nameEl);
            const onKey = await clickOn(keyEl);
            // In the field the chip covers, if it covers one, and in the middle field.
            await click(fields.left.at);
            const leftFocused = (await focused()) === "left";
            await click(fields.mid.at);
            const midFocused = (await focused()) === "mid";
            const afterClicks = where();
            // The user's Ctrl+Tab: the only way back, to their own tab.
            userCtrlTab();
            await until(() => !g.watching, 3000);
            await sleep(400);
            const back = where();
            return {
              how: arg,
              held: AS.zenRecord(theConv())?.ownership ?? null,
              expanded: { strip: expanded.strip, chip: expanded.chip, zenius: expanded.zenius !== null },
              chipText: before.chip,
              chipRect: rect(cr),
              areaRect: rect(area),
              pageRect: rect(b),
              corner: !!cr && cr.left - area.left >= 0 && cr.left - area.left < 20 && cr.top - area.top >= 0 && cr.top - area.top < 20,
              capped: !!cr && cr.width <= Math.max(120, Math.min(280, area.width * 0.4)) + 1,
              keyWhole: !!kr && !!cr && kr.width > 0 && kr.left >= cr.left - 0.5 && kr.right <= cr.right + 0.5,
              key: clean(keyEl?.textContent ?? null),
              controls,
              pointerEvents,
              topCenter,
              fields,
              onName,
              onKey,
              leftFocused,
              midFocused,
              watchingAfterClicks: !!afterClicks.watching,
              back: { watching: back.watching, zenius: back.zenius, chip: back.chip, strip: back.strip, onUserTab: win.gBrowser.selectedTab === userTab },
            };
          } finally {
            putBack();
          }
        `, how).catch(e => ({ error: `${e?.code ?? ""} ${String(e?.message).slice(0, 200)}` }))) };
        const r = out[label];
        // The chip as a hint: shown only collapsed, in the corner, capped,
        // the key whole, no controls, every click on it and along the page's
        // top reaching the page, the watch kept by clicks and ended by Ctrl+Tab.
        r.verdict = r.error ? null : {
          stripNotChip: !!r.expanded?.strip && r.expanded.chip === null,
          chipCollapsed: !!r.chipText && /\u00b7 Ctrl\+Tab$/.test(r.chipText),
          cornerCapped: r.corner && r.capped,
          keyWhole: r.keyWhole,
          noControls: r.controls === 0,
          clicksReachPage: r.onName?.lands === "page" && r.onKey?.lands === "page" && r.topCenter === "page" && Object.values(r.fields ?? {}).every(f => f.lands === "page") && r.leftFocused && r.midFocused,
          clicksKeepWatch: !!r.onName?.watchingAfter && !!r.onKey?.watchingAfter && r.watchingAfterClicks,
          ctrlTabBack: r.back?.watching === null && r.back?.zenius === null && r.back?.chip === null && r.back?.onUserTab === true,
          heldAfterBack: how === "takeOver" ? r.held === "agentDelegatedToUser" : r.held === "agent",
        };
      } finally {
        await chrome(`
          await g.stopWatching({ back: true });
          const rec = AS.zenRecord(theConv());
          if (rec?.ownership === "agentDelegatedToUser") { await resumeAgent(rec); await until(() => rec.ownership === "agent", 10000); }
          await AS.cancel(theConv()).catch(() => {});
          return true;
        `).catch(() => {});
        await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      }
      step("pill", label, JSON.stringify(out[label]?.verdict ?? out[label]));
    }
    return out;
  },

  // A Take over zen-core refuses, for real (S42; zenius's tests stub the
  // refusal): the agent's code ran in its page, so Take over first loads the
  // page afresh, and that load would leave the site (the page redirects to
  // the other site once loaded), so zenius stops it. What the user meets:
  // the card on the page, the sidebar's directory ("Can't take over this
  // page" under Needs you, zen-sidebar's 68b8d7b), whether the window
  // watches the refused task (Take over is a watch since 843a989) and
  // Ctrl+Tab goes back, and whether the agent stays paused until the user
  // picks (its call waits, and runs after Resume agent).
  async refused() {
    const name = `zs-refused-${suffix()}`;
    const key = suffix();
    const h0 = hits.length;
    const opened = await chrome(START_CHAT, { url: `${A}/plain`, question: `LINK ${name} HOLD 90` });
    const { id: space } = await client.call("spaces.create", { name });
    const out = {};
    const refusalJs = `
      const rec = AS.zenRecord(theConv());
      const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
      const refusal = () => ctx.service.pages.tabsOf(rec).map(t => N.noticeElement?.(t, "zenius-takeover-refused")).find(Boolean) ?? null;
    `;
    let pending = null;
    try {
      await chrome(`win.__zsSidebarBack = await sidebarExpanded(true); return true;`);
      await client.call("page.goto", { space, page: "p1", url: `${A}/flip?k=${key}` });
      out.start = { ...opened, ...(await chrome(AWAIT_LINK)) };
      // The agent's code reads the page, so the user's typing there could be
      // seen: a Take over loads it afresh first.
      out.agentCode = await client.call("page.evaluate", { space, page: "p1", fn: "() => document.title" }).then(r => r?.result ?? r, e => ({ error: `${e.code ?? ""} ${e.message}`.slice(0, 160) }));
      out.home = await chrome(`return where();`);
      // The user presses Take over on the live card.
      out.pressed = await chrome(`${refusalJs}
        await openPanel(); g.showTask(theConv());
        await until(() => !panelDoc().getElementById("live").hidden && !panelDoc().getElementById("take-over").hidden, 5000);
        panelDoc().getElementById("take-over").click();
        await until(() => refusal() || rec.ownership === "agentDelegatedToUser", 20000);
        await sleep(1000);
        const c = refusal();
        return {
          ownership: rec.ownership,
          paused: !!rec.paused,
          badge: UI().badgeFor?.(rec)?.state ?? null,
          refusal: c ? { text: clean(c.textContent), buttons: [...c.querySelectorAll("button")].map(b => clean(b.textContent)) } : null,
          pages: ctx.service.pages.tabsOf(rec).map(t => t.linkedBrowser.currentURI.spec),
          where: where(),
          card: card(),
        };
      `);
      // The page's loads: the agent's, then the fresh one, and whether the
      // other site was asked for anything.
      out.loads = hits.slice(h0).filter(h => h.includes(`k=${key}`) || h.startsWith(`127.0.0.2:${PORT_B}/`));
      // The sidebar's directory: the task's row and its group.
      out.directory = await chrome(`
        if (!g.directoryOpen) g.toggleDirectory();
        const row = await until(() => win.document.querySelector('.asb-dir-row[data-task="' + win.__zsConv + '"]'), 5000);
        let group = row?.previousElementSibling ?? null;
        while (group && !group.matches(".asb-dir-group")) group = group.previousElementSibling;
        const res = row ? { state: row.dataset.state ?? null, text: clean(row.textContent), group: group?.dataset.group ?? null } : null;
        g.closeDirectory();
        return res;
      `);
      // The agent acts while the refusal waits for the user: its call should wait.
      pending = client.call("page.evaluate", { space, page: "p1", fn: "() => location.href" }).then(r => ({ ran: r?.result ?? r }), e => ({ error: `${e.code ?? ""} ${e.message}`.slice(0, 160) }));
      out.agentWhileRefused = await Promise.race([pending, sleep(3000).then(() => "waiting after 3 s")]);
      // The user's Ctrl+Tab, if the refused Take over watches.
      out.ctrlTab = await chrome(`
        const was = { watching: g.watching, zenius: UI().watching?.(win) ?? null, strip: where().strip };
        if (was.watching || was.zenius) { userCtrlTab(); await until(() => !g.watching && !UI().watching?.(win), 3000); await sleep(400); }
        return { was, now: where() };
      `);
      out.backHome = out.ctrlTab.now.tab === out.home.tab;
      // The user picks Resume agent on the refusal.
      out.resume = await chrome(`${refusalJs}
        const c = refusal();
        const b = c && [...c.querySelectorAll("button")].find(x => clean(x.textContent) === "Resume agent");
        if (!b) return { pressed: false };
        await sleep(600);
        b.click();
        await until(() => !rec.paused, 5000);
        await sleep(300);
        return { pressed: true, ownership: rec.ownership, paused: !!rec.paused, badge: UI().badgeFor?.(rec)?.state ?? null, refusalGone: !refusal(), where: where() };
      `);
      out.agentAfterResume = await Promise.race([pending, sleep(5000).then(() => "waiting 5 s after Resume agent")]);
      const p = out.pressed ?? {};
      out.verdict = {
        refused: (p.refusal?.text ?? "").startsWith("Can't take over this page"),
        offSiteLine: /another site/.test(p.refusal?.text ?? ""),
        noTryAgain: !!p.refusal && !p.refusal.buttons.includes("Try again"),
        staysAgentsPaused: p.ownership === "agent" && p.paused === true,
        needsUser: p.badge === "needs-user",
        // Since zen-sidebar's 91b7548 the live card hides Take over while
        // zenius reports a refusal (it would fail the same way).
        noTakeOverOnCard: p.card?.takeOverShown === false,
        directoryNeedsYou: out.directory?.group === "needs" && /Can't take over this page/.test(out.directory?.text ?? ""),
        agentWaits: typeof out.agentWhileRefused === "string",
        pageStaysOnSite: (p.pages ?? []).length > 0 && !(p.pages ?? []).some(u => u.startsWith(B)),
        otherSiteAsked: out.loads.some(h => h.startsWith(`127.0.0.2:${PORT_B}/`)),
        backHome: out.backHome,
        resumes: out.resume?.pressed === true && out.resume.paused === false && out.resume.ownership === "agent" && out.resume.refusalGone === true,
        agentRunsAfter: !!out.agentAfterResume?.ran,
      };
    } finally {
      await chrome(`await g.stopWatching({ back: true }); await AS.cancel(theConv()).catch(() => {}); win.__zsSidebarBack?.(); win.__zsSidebarBack = null; return true;`).catch(() => {});
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      if (out.home?.tab) await chrome(`const t = win.gBrowser.tabs.find(x => x.linkedBrowser.currentURI.spec === arg); if (t) win.gBrowser.selectedTab = t; return true;`, out.home.tab).catch(() => {});
    }
    return out;
  },

  // The live card's picture alone (no agent, the sidebar closed): drawSnapshot
  // of a task's page at the card's scale, timed, with the parent's main-thread
  // stall around it, on a plain page and a costly one; then the same span
  // with no picture, the control.
  async cost() {
    const { id: space } = await client.call("spaces.create", { name: `zs-cost-${suffix()}` });
    const out = {};
    try {
      for (const path of ["/live", "/heavy"]) {
        await client.call("page.goto", { space, page: "p1", url: `${A}${path}` });
        await sleep(1500);
        out[path] = await chrome(`
          const tab = ctx.resolvePage({ space: arg.space, page: "p1" }).tab;
          const wgp = tab.linkedBrowser.browsingContext.currentWindowGlobal;
          const scale = Math.min(1, Math.max(0.2, 375 / (win.gBrowser.selectedBrowser.getBoundingClientRect().width || 1280)));
          const span = async pictures => {
            let maxLag = 0, last = win.performance.now();
            const timer = win.setInterval(() => { const now = win.performance.now(); maxLag = Math.max(maxLag, now - last - 20); last = now; }, 20);
            const times = [];
            const end = win.performance.now() + 4000;
            while (win.performance.now() < end) {
              if (pictures) {
                const t0 = win.performance.now();
                (await wgp.drawSnapshot(null, scale, "white")).close();
                times.push(Math.round(win.performance.now() - t0));
              }
              await sleep(200);
            }
            win.clearInterval(timer);
            const sorted = [...times].sort((a, b) => a - b);
            return { pictures: times.length, median: sorted[sorted.length >> 1] ?? null, max: sorted.at(-1) ?? null, maxStallMs: Math.round(maxLag) };
          };
          // The picture actor's drawPicture, as the card calls it (d9c7646 on;
          // since zen-ux's guard, for a stand-in chat of this task): the round
          // trip, the page process's own time when it says, the reply's size,
          // and the parent's stall around it.
          const actorSpan = async () => {
            if (!pictureModule()?.drawPicture) return null;
            const conv = convFor(arg.space);
            let maxLag = 0, last = win.performance.now();
            const timer = win.setInterval(() => { const now = win.performance.now(); maxLag = Math.max(maxLag, now - last - 20); last = now; }, 20);
            const trips = [], paints = [];
            let bytes = 0, pictures = 0;
            const end = win.performance.now() + 4000;
            while (win.performance.now() < end) {
              const t0 = win.performance.now();
              const p = await pictureOf(conv, tab, { width: 375, height: 120 });
              trips.push(Math.round(win.performance.now() - t0));
              if (p?.painted) { pictures++; bytes = Math.max(bytes, p.bytes); if (p.ms != null) paints.push(Math.round(p.ms)); }
              await sleep(200);
            }
            win.clearInterval(timer);
            const mid = a => [...a].sort((x, y) => x - y)[a.length >> 1] ?? null;
            return { pictures, tripMedian: mid(trips), tripMax: Math.max(0, ...trips), paintMedian: mid(paints), paintMax: paints.length ? Math.max(...paints) : null, replyBytes: bytes, maxStallMs: Math.round(maxLag) };
          };
          return { scale: Math.round(scale * 100) / 100, drawing: await span(true), actor: await actorSpan(), control: await span(false) };
        `, { space });
        step("cost", path, JSON.stringify(out[path]));
      }
    } finally {
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    return out;
  },

  // Step 6's picture actor (d9c7646), against the manager's four conditions:
  // asked only for an agent tab of the chat's task (never a user's tab), its
  // pictures only to the panel, no events or observers (I4), and a costly
  // page costs only itself. The agent's page is /trap; the user's own page is
  // on the other site, so in another process. Since zen-ux's guard
  // (10edb02), drawPicture(conv, tab, size) must refuse any tab but an agent
  // page of the chat's live task, before it makes an actor in the tab.
  async actor() {
    const name = `zs-actor-${suffix()}`;
    const opened = await chrome(START_CHAT, { url: `${B}/ticker`, question: `LINK ${name} HOLD 90` });
    const { id: space } = await client.call("spaces.create", { name });
    const { id: otherSpace } = await client.call("spaces.create", { name: `zs-actor-other-${suffix()}` });
    const out = {};
    const h0 = hits.length;
    try {
      await client.call("page.goto", { space, page: "p1", url: `${A}/trap` });
      await client.call("page.goto", { space: otherSpace, page: "p1", url: `${A}/other` });
      out.start = { ...opened, ...(await chrome(AWAIT_LINK)) };
      const READ = `
        const agentTab = () => AS.zenFrontTab(theConv());
        const userTab = () => win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === ${JSON.stringify(`${B}/ticker`)});
        const pid = t => t?.linkedBrowser.browsingContext.currentWindowGlobal?.osPid ?? null;
      `;
      // The panel on Chat: no card, so no picture (the control for the traps).
      out.control = await chrome(READ + `
        g.setMode("chat");
        await sleep(1500);
        const n0 = await inContent(agentTab(), "return window.__traps.length");
        await sleep(6000);
        return { traps: await inContent(agentTab(), "return window.__traps.slice(" + n0 + ")") };
      `);
      // The card in view while the agent works: pictures of /trap.
      out.painting = await chrome(READ + `
        await openPanel(); g.showTask(theConv());
        const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight;
        await sleep(300);
        const t = agentTab();
        const n0 = await inContent(t, "return window.__traps.length");
        const t0 = await inContent(t, "return performance.now()");
        const d0 = drawnCount() ?? 0;
        await sleep(8000);
        return {
          drawn: (drawnCount() ?? 0) - d0,
          every: panelDoc().getElementById("live").dataset.every ?? null,
          traps: await inContent(t, "return window.__traps.slice(" + n0 + ")"),
          pageStallsMs: await inContent(t, "return window.__lags.filter(e => e.t > " + t0 + ").map(e => Math.round(e.lag))"),
          card: card(),
        };
      `);
      // I4: the child module is loaded only in a process the card painted in.
      out.i4 = await chrome(READ + `
        const url = panelBase() + "AgentSidebarPictureChild.sys.mjs";
        const probe = async t => {
          try {
            return await ctx.content(t.linkedBrowser.browsingContext, "dev#evalContent", { privileged: true, arg: url, code:
              "return { module: typeof Cu.isESModuleLoaded === 'function' ? Cu.isESModuleLoaded(arg) : (Cu.loadedESModules ?? []).includes(arg), actor: !!actor.manager.getExistingActor?.('AgentSidebarPicture') }" });
          } catch (e) { return "unread: " + e.message; }
        };
        return { agentPid: pid(agentTab()), userPid: pid(userTab()), agentProcess: await probe(agentTab()), userProcess: await probe(userTab()) };
      `);
      // drawPicture asked straight for tabs the card must never paint: the
      // user's own tab (in no task) and another task's page; the chat's own
      // agent page is the control. Refused, and with no actor made in the
      // refused tab's document?
      out.direct = await chrome(READ + `
        if (!pictureModule()?.drawPicture) return { module: false };
        const other = ctx.resolvePage({ space: arg, page: "p1" }).tab;
        const ask = async t => ({ ...(await pictureOf(theConv(), t)), actorMade: await actorIn(t) });
        return { userTabInATask: !!UI().lookup(userTab()), userTab: await ask(userTab()), otherTask: await ask(other), agentTab: await ask(agentTab()) };
      `, otherSpace);
      // A tab the user opens from the task's page while they hold it joins the
      // task as the user's: once the user picks it, is it painted?
      out.handOff = await client.call("spaces.handOff", { space }).then(r => r?.ownership ?? "ok", e => ({ error: e.message }));
      // The task's own page while the user holds it.
      out.heldPage = await chrome(READ + `return pictureOf(theConv(), agentTab());`);
      out.userOrigin = await chrome(READ + `
        const rec = AS.zenRecord(theConv());
        const from = agentTab();
        const d0 = drawnCount() ?? 0;
        const t = win.gBrowser.addTab(arg, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), openerBrowser: from.linkedBrowser });
        await until(() => t.linkedBrowser.currentURI.spec === arg && !t.hasAttribute("busy"), 8000);
        await sleep(300);
        win.gBrowser.selectedTab = t;
        await sleep(2500);
        return {
          inTask: ctx.service.pages.tabsOf(rec).includes(t),
          openedBy: rec.ledger?.unmanaged?.[ctx.service.pages.tabId(t)] ?? null,
          agentPage: !!ctx.service.pages.forTab(t),
          isFront: agentTab() === t,
          drawn: (drawnCount() ?? 0) - d0,
          card: card(),
          asked: await pictureOf(theConv(), t),
          actorMade: await actorIn(t),
        };
      `, `${B}/ticker?opened`);
      // The card draws a new front tab at its next render: the user leaves
      // the panel on Chat and comes back to the task.
      out.userOriginAfterRender = await chrome(READ + `
        const d0 = drawnCount() ?? 0;
        g.setMode("chat");
        await sleep(500);
        g.showTask(theConv());
        const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight;
        await sleep(2500);
        const front = agentTab();
        return { front: front?.linkedBrowser.currentURI.spec.replace(/^http:\\/\\/[^/]+/, "") ?? null, drawn: (drawnCount() ?? 0) - d0, card: card() };
      `);
      // The user resumes the agent; the tab they opened stays in the task,
      // their own, so still not painted. Then the agent adopts it
      // (pages.adopt, which empties its password fields): it is the agent's
      // page from then on, and the card may paint it.
      out.resumed = await chrome(READ + `
        const rec = AS.zenRecord(theConv());
        const pressed = await resumeAgent(rec);
        await until(() => rec.ownership === "agent", 10000);
        await sleep(300);
        const t = win.gBrowser.tabs.find(x => x.linkedBrowser.currentURI.spec.includes("/ticker?opened"));
        return { pressed, ownership: rec.ownership, inTask: !!t && ctx.service.pages.tabsOf(rec).includes(t), front: agentTab() === t, asked: t ? await pictureOf(theConv(), t) : "no tab", actorMade: t ? await actorIn(t) : null, tabId: t ? ctx.service.pages.tabId(t) : null };
      `);
      if (out.resumed?.tabId) {
        out.adopt = await client.call("pages.adopt", { space, tab: out.resumed.tabId }).then(r => r?.label ?? "ok", e => ({ error: `${e.code ?? ""} ${e.message}`.slice(0, 160) }));
        out.adopted = await chrome(READ + `
          const t = win.gBrowser.tabs.find(x => x.linkedBrowser.currentURI.spec.includes("/ticker?opened"));
          return { openedBy: ctx.service.pages.forTab(t)?.openedBy ?? null, asked: await pictureOf(theConv(), t), actorMade: await actorIn(t) };
        `);
      }
      // Trap beacons over the whole case, the page's own load included.
      out.trapHits = hits.slice(h0).filter(h => h.includes("/hit?w=trap"));
    } finally {
      // A task the user still holds can't be finished: hand it back first.
      await chrome(`if (AS.zenRecord(theConv())?.ownership === "agentDelegatedToUser") { await resumeAgent(AS.zenRecord(theConv())); await until(() => AS.zenRecord(theConv())?.ownership === "agent", 10000); } await AS.cancel(theConv()).catch(() => {}); for (const t of [...win.gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.includes("/ticker?opened")) win.gBrowser.removeTab(t, { animate: false }); return true;`).catch(() => {});
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      await client.call("spaces.finish", { space: otherSpace, keep: [] }).catch(() => {});
    }
    return out;
  },

  // A costly agent page in the same content process as the user's own page
  // (setup's --one-process: one process per site): how long and how often
  // does the user's page stall while the card paints the agent's page?
  async actorStall() {
    const name = `zs-stall-${suffix()}`;
    const opened = await chrome(START_CHAT, { url: `${A}/ticker`, question: `LINK ${name} HOLD 80` });
    const { id: space } = await client.call("spaces.create", { name });
    const out = {};
    try {
      await client.call("page.goto", { space, page: "p1", url: `${A}/heavy` });
      out.start = { ...opened, ...(await chrome(AWAIT_LINK)) };
      const READ = `
        const user = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === ${JSON.stringify(`${A}/ticker`)});
        const pid = t => t?.linkedBrowser.browsingContext.currentWindowGlobal?.osPid ?? null;
      `;
      out.processes = await chrome(READ + `return { agent: pid(AS.zenFrontTab(theConv())), user: pid(user), shared: pid(AS.zenFrontTab(theConv())) === pid(user) };`);
      const measure = (label, setup) =>
        chrome(READ + `
          ${setup};
          win.gBrowser.selectedTab = user;
          await sleep(1000);
          const t0 = await inContent(user, "return performance.now()");
          const d0 = drawnCount() ?? 0;
          await sleep(12000);
          const lags = await inContent(user, "return window.__lags.filter(e => e.t > " + t0 + ").map(e => Math.round(e.lag))");
          return { pictures: (drawnCount() ?? 0) - d0, every: panelDoc()?.getElementById("live")?.dataset.every ?? null, userWorstStallMs: Math.max(0, ...lags), userStallsOver50: lags.filter(l => l > 50) };
        `).then(r => {
          step("actorStall", label, JSON.stringify(r));
          out[label] = r;
        });
      await measure("cardHidden", `g.setMode("chat")`);
      await measure("cardShown", `await openPanel(); g.showTask(theConv()); const m = panelDoc().getElementById("messages"); m.scrollTop = m.scrollHeight`);
    } finally {
      await chrome(`await AS.cancel(theConv()).catch(() => {}); return true;`).catch(() => {});
      await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
    }
    return out;
  },

  // A chat follows the zenius task its agent names: can it name another
  // client's task (this probe's), and what does the card show then? Named
  // in zenius's open result ("open"), or in any shell command the agent
  // reports ("command": an echo of taskSpace("<name>")), for a task made
  // before the chat. Since zen-sidebar's 7c72787 a chat links only to a task
  // made while its own open ran, so "openDuring" makes the probe's task
  // then: the agent's own report of its open is all the sidebar has to go on.
  async namelink() {
    const out = {};
    for (const [via, ask, when] of [["open", n => `LINK ${n} HOLD 8`, "before"], ["command", n => `LINKCMD ${n}`, "before"], ["openDuring", n => `LINK ${n} HOLD 8`, "during"]]) {
      const name = `zs-other-${via}-${suffix()}`;
      let space = null;
      const make = async () => {
        space = (await client.call("spaces.create", { name })).id;
        await client.call("page.goto", { space, page: "p1", url: `${A}/other` });
      };
      try {
        // Made well before the agent's open (the link allows 1 s of slack before it).
        if (when === "before") {
          await make();
          await sleep(2500);
        }
        const opened = await chrome(START_CHAT, { url: `${A}/plain`, question: ask(name), open: via !== "command" });
        if (when === "during") await make();
        const start = { ...opened, ...(await chrome(AWAIT_LINK, { ms: 7000 })) };
        out[via] = { when, start, ...(await chrome(`
          await openPanel(); g.showTask(theConv());
          await sleep(2500);
          const rec = AS.zenRecord(theConv());
          return { linkedTo: rec?.name ?? null, card: card(), tabs: AS.zenTabs(theConv()).map(t => t.url), takeOverOffered: card()?.takeOverShown ?? null };
        `)) };
      } finally {
        await chrome(`await AS.cancel(theConv()).catch(() => {}); return true;`).catch(() => {});
        if (space) await client.call("spaces.finish", { space, keep: [] }).catch(() => {});
      }
    }
    return out;
  },
};

const out = {};
try {
  out.sidebar = await chrome(`return { api: !!g, agents: AS ? Object.keys(AS.config?.agents ?? {}) : null, harness: AS?.preferredHarness?.() ?? null };`);
  // The user's tabs belong in their own Space. A profile whose last run
  // ended in the Agents Space starts there, and zenius then takes the user's
  // tab for no place of theirs: a watch from it goes back to their Space,
  // not to that tab (843a989's placeOf).
  const space0 = await chrome(`
    const S = ctx.service.spaces;
    const recs = S.records?.() ?? [];
    const own = win.gZenWorkspaces?.getWorkspaces().find(ws => !S.isAgentsSpace?.(ws.uuid) && !recs.some(r => !r.gone && r.uuid === ws.uuid && r.kind === "task"));
    if (own && win.gZenWorkspaces.activeWorkspace !== own.uuid) await win.gZenWorkspaces.changeWorkspaceWithID(own.uuid);
    return win.gZenWorkspaces?.activeWorkspace ?? null;
  `);
  out.userView0 = await client.call("dev.viewState");
  const order = Object.keys(CASES).filter(k => k !== "sessions").concat("sessions");
  for (const name of wanted.length ? wanted : order) {
    step(name);
    try {
      out[name] = await CASES[name]();
    } catch (e) {
      out[name] = { error: `${e?.code ?? ""} ${String(e?.message).slice(0, 300)}` };
    }
    // Back to a quiet window: the sidebar closed, extra tabs gone, the
    // user's Space shown (a case may leave the window on the task's).
    await chrome(`
      win.SidebarController.hide();
      if (arg && win.gZenWorkspaces && win.gZenWorkspaces.activeWorkspace !== arg) await win.gZenWorkspaces.changeWorkspaceWithID(arg);
      for (const t of [...win.gBrowser.tabs]) {
        const u = t.linkedBrowser.currentURI.spec;
        if (/^http:\\/\\/127\\.0\\.0\\.[12]:/.test(u) && !ctx.service.lookup(t)) win.gBrowser.removeTab(t, { animate: false });
      }
      return true;
    `, space0).catch(() => {});
  }
  out.userView1 = await client.call("dev.viewState");
  out.userViewSame = JSON.stringify(out.userView0) === JSON.stringify(out.userView1);
  delete out.userView0;
  delete out.userView1;
} finally {
  console.log(JSON.stringify(out, null, 1));
  client.close?.();
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
}
