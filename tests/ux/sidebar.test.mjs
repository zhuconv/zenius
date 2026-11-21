// zenius's agent sidebar (docs/agent-sidebar.md), headless: the hooks zen-eval's
// Mac tests go by, both modes, the directory, the address bar's '>' rows, and
// what doctor reads (ui.sidebarStatus and the file's marker line). The agents
// are zen-sidebar's mock (tests/fixtures/agent-sidebar) on loopback only: its
// browser steps go through this checkout's own `zenius mcp` to this instance.
// A dev profile starts with uc.agent-sidebar.config = "none" (zen-dev.sh), so
// the tests point it at the mock's config and set it back after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const FIX = new URL("../fixtures/agent-sidebar/", import.meta.url).pathname;
const SCRIPT = new URL("../../runtime/JS/agent-sidebar.uc.js", import.meta.url).pathname;
const SCENE = readFileSync(join(FIX, "scene.js"), "utf8");
const PREF = "uc.agent-sidebar.config";
// The mock's agents are neither Claude Code nor Codex, which the sidebar
// greys out unless this is set (zen-observe's limits).
const PREF_UNKNOWN = "zenius.agentSidebar.allowUnknownAgents";

let h;
let server;
let dir;
let config;
const slow = new Set();
const run = Date.now().toString(36).slice(-5);

// What a page can show the user and what it can only lay out (zen-snapshot's
// red team, docs/research/agent-sidebar-redteam.md, finding 2): the agent
// gets the first kind only. The second slide of the box below overflows a
// box of some size, which the user can bring into view, so it stays.
const SHOWN = ["VISIBLE", "DARKBG", "GRADIENT", "CONTENTS", "SLIDE1", "SLIDE2", "SUMMARY"];
const HIDDEN = ["NAV", "SRINLINE", "DISPNONE", "VISHIDDEN", "OFFSCREEN", "INDENT", "WHITE", "NEARWHITE", "TRANSPARENT", "TINY", "OPACITY", "SRONLY", "CLIPPATH", "COLLAPSED", "SCALED", "DETAILS"];
const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const PAGES = {
  "/zen-ux/hidden.html": page(
    "zen-ux hidden text",
    `<nav>NAV_MARK</nav>
     <p>VISIBLE_MARK</p>
     <p>Read <span class="sr">SRINLINE_MARK</span>more here.</p>
     <p style="display:none">DISPNONE_MARK</p>
     <p style="visibility:hidden">VISHIDDEN_MARK</p>
     <p style="position:absolute;left:-9999px">OFFSCREEN_MARK</p>
     <h2 style="text-indent:-9999px">INDENT_MARK</h2>
     <p style="color:#fff;background:#fff">WHITE_MARK</p>
     <div style="background:#fff"><span style="color:#fefefe">NEARWHITE_MARK</span></div>
     <p style="color:transparent">TRANSPARENT_MARK</p>
     <p style="font-size:1px">TINY_MARK</p>
     <div style="opacity:0"><p>OPACITY_MARK</p></div>
     <p class="sr">SRONLY_MARK</p>
     <p style="clip-path:inset(50%)">CLIPPATH_MARK</p>
     <div style="height:0;overflow:hidden"><p>COLLAPSED_MARK</p></div>
     <p style="transform:scale(0.01);transform-origin:0 0">SCALED_MARK</p>
     <div style="background:#123;color:#fff">DARKBG_MARK</div>
     <h1 style="background:linear-gradient(90deg,#f06,#48f);background-clip:text;color:transparent">GRADIENT_MARK</h1>
     <div style="display:contents"><p>CONTENTS_MARK</p></div>
     <div style="width:200px;overflow:hidden;white-space:nowrap"><span style="display:inline-block;width:200px">SLIDE1_MARK</span><span style="display:inline-block;width:200px">SLIDE2_MARK</span></div>
     <pre>PRE_LINE1
  PRE_LINE2</pre>
     <details><summary>SUMMARY_MARK</summary>DETAILS_MARK</details>`,
    `<style>body { background: #fff; color: #222; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }</style>`
  ),
  // A page that says it is Firefox's PDF viewer (finding 3).
  "/zen-ux/fakepdf.html": page(
    "zen-ux ordinary page",
    `<p>ORDINARY_TEXT on an ordinary page.</p>`,
    `<script>
      window.PDFViewerApplication = {
        initializedPromise: Promise.resolve(),
        pdfDocument: { numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "PLANTED_TEXT the user never sees", hasEOL: true }] }) }) },
      };
    </script>`
  ),
};

/** A one-page PDF with `line` on it. */
function onePagePdf(line) {
  const stream = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

before(async () => {
  h = await setup();
  // The mock's pages, on an ephemeral loopback port: serve.mjs's fixed one
  // could meet another run's on this shared machine.
  const root = join(FIX, "www");
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    if (PAGES[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[path]);
      return;
    }
    if (path === "/zen-ux/real.pdf") {
      const pdf = onePagePdf("REAL_PDF_LINE from zen-ux");
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length }).end(pdf);
      return;
    }
    if (path === "/zen-ux/slow.pdf") {
      // The headers and the first bytes, then nothing: pdf.js waits for the
      // rest (finding 4).
      res.writeHead(200, { "content-type": "application/pdf", "content-length": 100000 });
      res.write("%PDF-1.4\n%");
      slow.add(res);
      res.on("close", () => slow.delete(res));
      return;
    }
    try {
      const body = await readFile(join(root, path === "/" ? "article.html" : path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  dir = mkdtempSync(join(tmpdir(), "zen-ux-sidebar-"));
  config = join(dir, "config.json");
  execFileSync(process.execPath, [join(FIX, "config.mjs"), "--instance", process.env.ZENIUS_INSTANCE, "--out", config, "--www", www(), "--logs", join(dir, "logs")]);
});

after(async () => {
  await h
    ?.chrome(`
      Services.prefs.setStringPref(${JSON.stringify(PREF)}, "none");
      Services.prefs.clearUserPref(${JSON.stringify(PREF_UNKNOWN)});
      if (win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar") win.SidebarController.hide();
      return true;
    `)
    .catch(() => {});
  await h?.close();
  for (const res of slow) {
    res.destroy();
  }
  server?.closeAllConnections();
  server?.close();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const www = () => `http://127.0.0.1:${server.address().port}`;
// A directory row's group: the .asb-dir-group heading before it.
const GROUP_OF = `const groupOf = row => {
  for (let el = row?.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.classList.contains("asb-dir-group")) return el.dataset.group;
  }
  return null;
};`;
/** Chrome JS with zen-sidebar's scene helpers (`S`) first; `arg` is bound to `arg`. */
const chrome = (code, arg) => h.call("dev.evalChrome", { code: `${SCENE}\n${GROUP_OF}\n${code}`, arg });
/** The prompt the mock agents got with `question` in it: its text, and the
 * text of each resource (the page) that came with it. */
function promptWith(question) {
  for (const name of ["mock.log", "mock-claude.log"]) {
    let lines = [];
    try {
      lines = readFileSync(join(dir, "logs", name), "utf8").split("\n").filter(Boolean);
    } catch {}
    for (const line of lines) {
      const message = JSON.parse(line);
      const blocks = message.method === "session/prompt" ? message.params.prompt : [];
      const text = blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
      if (text.includes(question)) {
        return { text, resources: blocks.filter(b => b.type === "resource").map(b => b.resource.text) };
      }
    }
  }
  return null;
}
/** Chrome JS: ask `arg.question` in the chat of a new tab on `arg.url`, and
 * wait for the answer; the tab closes after. `arg.pdf`: wait for the PDF
 * viewer rather than the load, which a PDF that never ends doesn't finish. */
const ASK_IN_TAB = `
  const g = win.ucAgentSidebar;
  const tab = win.gBrowser.addTab(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  win.gBrowser.selectedTab = tab;
  if (arg.pdf) {
    await S.until(() => tab.linkedBrowser.documentContentType === "application/pdf", 10000);
    await S.sleep(500);
  } else {
    await S.until(() => tab.linkedBrowser.currentURI.spec === arg.url && !tab.hasAttribute("busy"));
  }
  const conv = g.conversationFor(tab);
  const started = Date.now();
  try {
    const sent = g.submit(conv, { question: arg.question, selection: "", attachments: [] });
    sent.catch(() => {});
    if (arg.stopWhile) {
      await S.until(() => conv.status === arg.stopWhile, 10000);
      const status = conv.status;
      g.AgentService.cancel(conv);
      await S.until(() => !conv.busy, 2000);
      return { status, busy: conv.busy, ms: Date.now() - started, notes: conv.messages.filter(m => m.role === "note").map(m => m.text) };
    }
    await S.until(() => !conv.busy, arg.wait ?? 30000);
    return { busy: conv.busy, ms: Date.now() - started, notes: conv.messages.filter(m => m.role === "note").map(m => m.text), last: conv.messages.at(-1)?.text ?? null };
  } finally {
    win.gBrowser.removeTab(tab, { animate: false });
  }
`;
/** The sidebar reads the mock's agents from now on. */
const useMock = () =>
  chrome(`
    Services.prefs.setBoolPref(${JSON.stringify(PREF_UNKNOWN)}, true);
    Services.prefs.setStringPref(${JSON.stringify(PREF)}, ${JSON.stringify(config)});
    await win.ucAgentSidebar.AgentService.loadConfig();
    return true;
  `);

test("the file carries doctor's marker among its first 20 lines, and a dev profile's sidebar reports itself with no agents", async () => {
  const head = readFileSync(SCRIPT, "utf8").split("\n").slice(0, 20).map(line => line.trim());
  assert.ok(head.includes("// zenius: agent-sidebar"), "the marker line");
  const status = await h.call("ui.sidebarStatus", {});
  assert.deepEqual(status, { loaded: true, windows: 1, config: "none", configPath: "none" });
});

test("ui.sidebarStatus names the config it reads, and says when it's missing", async () => {
  try {
    await useMock();
    assert.deepEqual(await h.call("ui.sidebarStatus", {}), { loaded: true, windows: 1, config: "found", configPath: config });
    const gone = join(dir, "nowhere.json");
    await chrome(`Services.prefs.setStringPref(${JSON.stringify(PREF)}, ${JSON.stringify(gone)}); return true;`);
    assert.deepEqual(await h.call("ui.sidebarStatus", {}), { loaded: true, windows: 1, config: "missing", configPath: gone });
  } finally {
    await chrome(`Services.prefs.setStringPref(${JSON.stringify(PREF)}, "none"); return true;`);
  }
});

test("Chat mode: the panel is about the tab in view, and its header shows only the page's title", async () => {
  await useMock();
  const out = await chrome(`
    const tab = await S.openTab(${JSON.stringify(`${www()}/article.html`)});
    await S.openPanel();
    win.ucAgentSidebar.setMode("chat");
    const doc = S.panelDoc();
    await S.until(() => doc.documentElement.dataset.mode === "chat");
    const title = doc.getElementById("title")?.textContent ?? null;
    const res = { mode: doc.documentElement.dataset.mode, title, page: tab.linkedBrowser.contentTitle, dir: !!doc.getElementById("dir") && !doc.getElementById("dir").hidden };
    win.gBrowser.removeTab(tab, { animate: false });
    return res;
  `);
  assert.equal(out.mode, "chat");
  assert.equal(out.title, out.page);
  assert.equal(out.dir, false, "the directory's button is Work's only");
});

test("startWorkChat starts a task in Work mode: it resolves to the task's uid, the header shows the task's name, its steps read as lines, and the directory files it under Done when it ends", async () => {
  await useMock();
  const out = await chrome(`
    await S.openPanel();
    const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
    const uid = await startWorkChat(win, { text: "SCENARIO:weather", source: "urlbar" });
    const doc = S.panelDoc();
    await S.until(() => doc.documentElement.dataset.mode === "work");
    const conv = win.ucAgentSidebar.AgentService.tasks.get(uid);
    await S.until(() => conv && !conv.busy && conv.messages.length > 1, 60000);
    win.ucAgentSidebar.toggleDirectory();
    const drawer = win.document.getElementById("zenius-sidebar-directory");
    await S.until(() => drawer && !drawer.hidden);
    const row = drawer.querySelector('.asb-dir-row[data-task="' + uid + '"]');
    const res = {
      uid: typeof uid,
      mode: doc.documentElement.dataset.mode,
      title: doc.getElementById("title")?.textContent ?? null,
      name: conv.title,
      steps: [...doc.querySelectorAll(".steps > .step")].map(s => ({ status: s.dataset.status, label: s.querySelector(".label")?.textContent ?? "" })),
      group: groupOf(row),
      current: row?.dataset.current ?? null,
    };
    win.ucAgentSidebar.closeDirectory();
    return res;
  `);
  assert.equal(out.uid, "string");
  assert.equal(out.mode, "work");
  assert.equal(out.title, out.name, "the header is the task's name");
  assert.ok(out.steps.length >= 2 && out.steps.every(s => s.label && s.status === "done"), JSON.stringify(out.steps));
  assert.match(out.steps[0].label, /^Open /);
  assert.equal(out.group, "done");
  assert.equal(out.current, "true");
});

// A work chat follows only the zenius task its own open started, by that
// task's id (zenius's red team, finding 6). On resume that id goes to the
// agent's zenius server, so a chat linked to another task would put its
// agent in that task's tabs.
const START_CHAT = `
  await S.openPanel();
  const A = win.ucAgentSidebar.AgentService;
  const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
  const uid = await startWorkChat(win, { text: arg.text, source: "urlbar" });
  const conv = A.tasks.get(uid);
  await S.until(() => conv && !conv.busy && conv.messages.some(m => m.role === "tool" && m.status === "completed"), 60000);
  const rec = A.zenRecord(conv);
`;
const END_CHAT = `
  if (rec) {
    try { A.zeniusUI()?.stopByUser(rec); } catch {}
    for (const t of A.zenius().pages.tabsOf(rec)) win.gBrowser.removeTab(t, { animate: false });
  }
  A.removeTask(conv);
`;

test("a shell call that echoes another task's name links the chat to nothing: not taskSpace(\"…\") in its command, nor open's first sentence in its output", async () => {
  await useMock();
  const name = `echo target ${run}`;
  const { id: other } = await h.call("spaces.create", { name });
  try {
    const out = await chrome(`${START_CHAT}
      const res = { zen: conv.zen, title: conv.title, linked: rec?.id ?? null, tabs: A.zenTabs(conv).length };
      ${END_CHAT}
      return res;
    `, { text: `ECHOTASK:${name}` });
    assert.equal(out.zen, null, JSON.stringify(out));
    assert.equal(out.linked, null);
    assert.notEqual(out.title, name);
    assert.equal(out.tabs, 0);
  } finally {
    await h.call("spaces.finish", { space: other, keep: [] }).catch(() => {});
  }
});

test("a cut task name links the chat only to the task its own open started, never to the task whose whole name its agent asked for", async () => {
  await useMock();
  // Another client's task, its name past 60 characters. The chat's agent asks
  // for that whole name: its own task gets it with a number, which the mock
  // cuts at 60 in open's result as an older zenius mcp did, so the other
  // task's name begins as the cut one does.
  const name = `cut name ${run} for a task whose name runs past sixty characters`;
  const { id: other } = await h.call("spaces.create", { name });
  try {
    const out = await chrome(`
      // The other task is older than the chat's open by more than the slack.
      await S.sleep(1500);
      ${START_CHAT}
      const res = { result: conv.messages.find(m => m.role === "tool")?.result ?? null, id: conv.zen?.id ?? null, name: rec?.name ?? null, title: conv.title };
      ${END_CHAT}
      return res;
    `, { text: `OPENCUT:${name}` });
    assert.match(out.result, /^Open [^\n]*\nStarted the task ".{59}…"\. Opened /u, out.result);
    assert.notEqual(out.id, other, "never the other client's task");
    assert.equal(out.name, `${name} 2`, "its own task, which zenius numbered");
    assert.equal(out.title, out.name);
  } finally {
    await h.call("spaces.finish", { space: other, keep: [] }).catch(() => {});
  }
});

test("zenius's strip says what the sidebar does: a task is working while its chat's turn runs and needs the user for the sidebar's reasons, and zenius's own reason reads as its card does, with no Take over on the live card while a refusal stands", async () => {
  await useMock();
  const out = await chrome(`
    const UI = win.ucAgentSidebar.AgentService.zeniusUI();
    const calls = [];
    const real = UI.noteSidebarTask;
    UI.noteSidebarTask = function (id, note) {
      calls.push({ id, ...note });
      return real.call(this, id, note);
    };
    try {
      ${START_CHAT}
      const g = win.ucAgentSidebar;
      const strip = () => win.document.querySelector("#zenius-agents-strip .zenius-strip-text")?.textContent ?? null;
      const mine = () => calls.filter(c => c.id === rec?.id).map(c => ({ running: c.running, needs: c.needs }));
      const res = { linked: !!rec };
      res.asked = { state: conv.task.state, why: conv.task.why, badge: UI.badgeFor(rec)?.state ?? null, strip: strip(), calls: mine() };
      // The user answers: a turn runs, then ends with no question.
      const sent = g.submit(conv, { question: "ECHO thanks", selection: "", attachments: [] });
      sent.catch(() => {});
      await S.until(() => !conv.busy && conv.messages.some(m => m.role === "assistant" && String(m.text ?? "").includes("ECHO thanks")), 30000);
      res.answered = { state: conv.task.state, badge: UI.badgeFor(rec)?.state ?? null, calls: mine().slice(2) };
      // zenius's own reason (a Take over that couldn't begin), as its taskBadge says it.
      const needsBefore = A.needsCount();
      A.zenius().emitLocal("taskBadge", { space: rec.id, state: "needs-user" });
      res.refused = { state: conv.task.state, text: conv.task.text, needsAdded: A.needsCount() - needsBefore, calls: mine().length };
      A.zenius().emitLocal("taskBadge", { space: rec.id, state: "idle" });
      res.after = { state: conv.task.state };
      // A Take over zenius refuses for real (zen-core's userTakeOver stubbed,
      // as zen-ux's handoff tests do): loading the page afresh would take the
      // user to another site. zenius's card then offers no Try again, and the
      // live card no Take over, until the refusal clears.
      const doc = S.panelDoc();
      const takeOverShown = () => !doc.getElementById("live").hidden && !doc.getElementById("take-over").hidden;
      const Z = A.zenius();
      const ownTake = Object.prototype.hasOwnProperty.call(Z, "userTakeOver");
      const realTake = Z.userTakeOver;
      Z.userTakeOver = async () => {
        throw Object.assign(new Error("The page didn't load afresh (it would have gone to https://other.example/, on another site)."), {
          code: "ZEN_HANDOFF_REFUSED",
          data: { page: "p1", reason: "reloadFailed", offSite: "https://other.example/" },
        });
      };
      try {
        res.cardBefore = !!(await S.until(takeOverShown, 10000));
        doc.getElementById("take-over").click();
        await S.until(() => conv.task.text === "Can't take over this page" && !takeOverShown(), 10000);
        const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
        const card = Z.pages.tabsOf(rec).map(t => N.noticeElement(t, "zenius-takeover-refused")).find(Boolean);
        const buttons = [...(card?.querySelectorAll("button") ?? [])];
        res.refusedForReal = {
          text: conv.task.text,
          cardShown: !doc.getElementById("live").hidden,
          takeOverShown: takeOverShown(),
          zeniusButtons: buttons.map(b => b.textContent).filter(t => /^(Try again|Stop task|Resume agent)$/.test(t)),
        };
        // Resume agent on zenius's card (armed after 400 ms) ends the
        // refusal, and Take over comes back.
        await S.sleep(450);
        buttons.find(b => b.textContent === "Resume agent")?.click();
        await S.until(() => takeOverShown() && conv.task.state === "done", 10000);
        res.resumed = { state: conv.task.state, takeOverShown: takeOverShown() };
      } finally {
        if (ownTake) {
          Z.userTakeOver = realTake;
        } else {
          delete Z.userTakeOver;
        }
        await g.stopWatching();
      }
      ${END_CHAT}
      res.letGo = mine().at(-1);
      return res;
    } finally {
      UI.noteSidebarTask = real;
    }
  `, { text: `OPENASK:strip check ${run}` });
  assert.equal(out.linked, true);
  assert.deepEqual(out.asked, {
    state: "needs",
    why: "question",
    badge: "needs-user",
    strip: "An agent needs you",
    calls: [{ running: true, needs: null }, { running: false, needs: "question" }],
  });
  assert.equal(out.answered.state, "done");
  assert.notEqual(out.answered.badge, "needs-user");
  assert.deepEqual(out.answered.calls, [{ running: true, needs: null }, { running: false, needs: null }]);
  assert.deepEqual(out.refused, { state: "needs", text: "Can't take over this page", needsAdded: 1, calls: 4 }, "zenius's own reason isn't told back to it");
  assert.deepEqual(out.after, { state: "done" });
  assert.equal(out.cardBefore, true, "the live card offers Take over while the agent has the page");
  assert.deepEqual(
    out.refusedForReal,
    { text: "Can't take over this page", cardShown: true, takeOverShown: false, zeniusButtons: ["Stop task", "Resume agent"] },
    "after zenius refuses, its card holds the choices, and the live card's Take over would fail the same way"
  );
  assert.deepEqual(out.resumed, { state: "done", takeOverShown: true });
  assert.deepEqual(out.letGo, { running: false, needs: null });
});

test("a question the agent ends with puts its task under Needs you, and Work's switch counts it in the needs color", async () => {
  await useMock();
  const out = await chrome(`
    await S.openPanel();
    const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
    const uid = await startWorkChat(win, { text: "QUESTION", source: "urlbar" });
    const conv = win.ucAgentSidebar.AgentService.tasks.get(uid);
    await S.until(() => conv && !conv.busy && conv.messages.length > 1, 60000);
    const doc = S.panelDoc();
    const needs = doc.getElementById("needs");
    // The count follows the task's state a moment after the answer ends.
    await S.until(() => needs && !needs.hidden && Number(needs.textContent) >= 1, 5000);
    win.ucAgentSidebar.toggleDirectory();
    const drawer = win.document.getElementById("zenius-sidebar-directory");
    await S.until(() => drawer && !drawer.hidden);
    const row = await S.until(() => drawer.querySelector('.asb-dir-row[data-task="' + uid + '"]'), 5000);
    const res = { group: groupOf(row), count: needs && !needs.hidden ? Number(needs.textContent) : 0, inWork: !!needs?.closest("#to-work") };
    win.ucAgentSidebar.closeDirectory();
    return res;
  `);
  assert.equal(out.group, "needs");
  assert.ok(out.count >= 1, "the count shows");
  assert.equal(out.inWork, true, "the count sits in Work's switch");
});

test("the address bar: with '>', 'Ask agent' is the first row and Enter starts a work chat with the text; without it, the row comes second and Enter isn't the sidebar's", async () => {
  await useMock();
  const out = await chrome(`
    const sidebar = win.ucAgentSidebar;
    const calls = [];
    const real = sidebar.startWorkChat;
    sidebar.startWorkChat = async (text, opts) => {
      calls.push({ text, source: opts?.source });
      return "uid-test";
    };
    const bar = win.gURLBar;
    // As typed: gURLBar.search() would take '>' for Firefox's Actions token.
    const type = async (value, ours) => {
      bar.view.close();
      bar.focus();
      bar.value = value;
      bar.inputField.setSelectionRange(value.length, value.length);
      bar.inputField.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value.slice(-1) }));
      await S.until(() => bar.view.isOpen && bar.view.visibleResults.some(r => r.providerName === ours), 5000);
      const rows = [...bar.view.panel.querySelectorAll(".urlbarView-row")].filter(r => !r.hidden);
      return bar.view.visibleResults.slice(0, 2).map((r, i) => ({ i, provider: r.providerName, heuristic: !!r.heuristic, dynamic: rows[i]?.getAttribute("dynamicType") ?? null }));
    };
    try {
      // Plain input first: once a row is picked, the address bar reverts
      // its text a moment later.
      const plain = await type("compare nonstop flights to Tokyo", "ZeniusAskAgentSuggest");
      const prefixed = await type("> compare nonstop flights to Tokyo", "ZeniusAskAgent");
      const selected = bar.view.selectedResult?.providerName ?? null;
      bar.handleCommand(new win.KeyboardEvent("keydown", { key: "Enter" }));
      await S.until(() => calls.length, 3000);
      return { prefixed, selected, plain, calls };
    } finally {
      sidebar.startWorkChat = real;
      bar.view.close();
      bar.handleRevert?.();
    }
  `);
  assert.deepEqual(out.prefixed[0], { i: 0, provider: "ZeniusAskAgent", heuristic: true, dynamic: "zeniusAskAgent" });
  assert.equal(out.selected, "ZeniusAskAgent", "Enter picks it");
  assert.deepEqual(out.calls, [{ text: "compare nonstop flights to Tokyo", source: "urlbar" }]);
  assert.notEqual(out.plain[0].provider, "ZeniusAskAgentSuggest", "Enter without '>' searches");
  assert.equal(out.plain[0].heuristic, true);
  assert.deepEqual(out.plain[1], { i: 1, provider: "ZeniusAskAgentSuggest", heuristic: false, dynamic: "zeniusAskAgent" });
});

test("a page's text reaches the agent only as far as the user can see it: no off-screen, transparent, tiny, opacity-0, clipped or same-color text", async () => {
  await useMock();
  const question = `ECHO hidden ${run}`;
  const out = await chrome(ASK_IN_TAB, { url: `${www()}/zen-ux/hidden.html`, question });
  assert.equal(out.busy, false);
  const sent = promptWith(question);
  assert.ok(sent, "the question reached the agent");
  assert.equal(sent.resources.length, 1, "with the page");
  const text = sent.resources[0];
  assert.deepEqual(SHOWN.filter(m => !text.includes(`${m}_MARK`)), [], "every visible mark goes");
  assert.deepEqual(HIDDEN.filter(m => text.includes(`${m}_MARK`)), [], "no hidden mark goes");
  assert.ok(text.includes("Read more here."), "text around a hidden word keeps its line");
  assert.ok(text.includes("PRE_LINE1\n  PRE_LINE2"), "preformatted text keeps its lines");
});

test("only Firefox's PDF viewer reads as a PDF: a page that defines PDFViewerApplication goes as its visible text, and a real PDF still goes as its text", async () => {
  await useMock();
  const ask = async (path, question) => {
    const out = await chrome(ASK_IN_TAB, { url: `${www()}${path}`, question, pdf: path.endsWith(".pdf") });
    assert.equal(out.busy, false);
    return promptWith(question)?.resources[0] ?? "";
  };
  const fake = await ask("/zen-ux/fakepdf.html", `ECHO fakepdf ${run}`);
  assert.ok(fake.includes("ORDINARY_TEXT on an ordinary page."), fake);
  assert.ok(!fake.includes("PLANTED_TEXT"), "not the page's planted 'PDF' text");
  assert.ok(!fake.includes("PDF text"), "not headed as a PDF");
  const real = await ask("/zen-ux/real.pdf", `ECHO realpdf ${run}`);
  assert.match(real, /PDF text, pages 1-1 of 1/);
  assert.ok(real.includes("REAL_PDF_LINE from zen-ux"), real);
});

test("a page that never finishes reading can't hold a question up: it goes without the page after the read's bound, with a note, and Stop ends it before that", async () => {
  await useMock();
  const ask = (question, stopWhile = null) => chrome(ASK_IN_TAB, { url: `${www()}/zen-ux/slow.pdf`, question, pdf: true, stopWhile, wait: 15000 });
  try {
    await chrome(`Services.prefs.setIntPref("uc.agent-sidebar.page-read-timeout", 1500); return true;`);
    const bounded = await ask(`ECHO slow ${run}`);
    assert.equal(bounded.busy, false);
    assert.ok(bounded.ms < 10000, `answered in ${bounded.ms} ms`);
    assert.deepEqual(bounded.notes, ["The page took too long to read, so the question went without it."]);
    const sent = promptWith(`ECHO slow ${run}`);
    assert.ok(sent, "the question reached the agent");
    assert.equal(sent.resources.length, 0, "without the page");

    await chrome(`Services.prefs.setIntPref("uc.agent-sidebar.page-read-timeout", 60000); return true;`);
    const stopped = await ask(`ECHO stopped ${run}`, "Reading the page…");
    assert.equal(stopped.status, "Reading the page…");
    assert.equal(stopped.busy, false, "Stop ends it at once");
    assert.deepEqual(stopped.notes, ["Stopped."]);
    assert.equal(promptWith(`ECHO stopped ${run}`), null, "nothing reached the agent");
  } finally {
    await chrome(`Services.prefs.clearUserPref("uc.agent-sidebar.page-read-timeout"); return true;`);
  }
});

test("an answer can't pass for the panel's own parts: no id or class from it, links show their host, links other than the web's are text, and a code block keeps its language", async () => {
  await useMock();
  const answer = [
    "Spoof answer.",
    "",
    '<div class="title">The agent wants to: read this page (spoof)</div>',
    "",
    '<p id="send">Send</p> <span class="host">fake.example</span>',
    "",
    `[bank.example](https://evil.example/login), [https://docs.example/page](https://docs.example/page), [write to us](mailto:someone@example.com) and [this page](${www()}/article.html)`,
    "",
    "```py",
    "print(1)",
    "```",
  ].join("\n");
  const out = await chrome(`
    const tab = await S.openTab(${JSON.stringify(`${www()}/article.html`)});
    try {
      await S.openPanel();
      win.ucAgentSidebar.setMode("chat");
      const conv = win.ucAgentSidebar.conversationFor(tab);
      conv.push({ role: "assistant", text: ${JSON.stringify(answer)}, state: "done" });
      const doc = S.panelDoc();
      const body = await S.until(() => [...doc.querySelectorAll(".msg.assistant .body")].find(b => b.textContent.includes("Spoof answer.")));
      const links = [...body.querySelectorAll("a")].map(a => ({ href: a.getAttribute("href"), title: a.title, host: a.querySelector(".host")?.textContent ?? null }));
      const before = new Set(win.gBrowser.tabs);
      body.querySelector('a[href$="/article.html"]').click();
      const opened = await S.until(() => win.gBrowser.tabs.find(t => !before.has(t)), 5000);
      const openedUrl = opened ? await S.until(() => opened.linkedBrowser.currentURI.spec !== "about:blank" && opened.linkedBrowser.currentURI.spec) : null;
      if (opened) win.gBrowser.removeTab(opened, { animate: false });
      // The answer's own elements: not the panel's box and buttons around a
      // code block (addCodeActions).
      const own = [...body.querySelectorAll("*")].filter(e => !e.closest(".actions") && !(e.parentElement === body && e.matches("div.code")));
      return {
        ids: own.filter(e => e.id).map(e => e.localName + "#" + e.id),
        classes: own.filter(e => e.className).map(e => e.localName + "." + e.className + (e.localName === "span" ? " in " + e.parentElement.localName : "")),
        sends: doc.querySelectorAll("#send").length,
        links,
        mailto: body.textContent.includes("write to us"),
        save: body.querySelector(".code button.save")?.title ?? null,
        openedUrl,
        panel: doc.URL,
      };
    } finally {
      win.gBrowser.removeTab(tab, { animate: false });
    }
  `);
  assert.deepEqual(out.ids, []);
  assert.deepEqual(out.classes.sort(), ["code.language-py", "span.host in a", "span.host in a"]);
  assert.equal(out.sends, 1, "the panel's own #send only");
  assert.deepEqual(out.links, [
    { href: "https://evil.example/login", title: "https://evil.example/login", host: "evil.example" },
    { href: "https://docs.example/page", title: "https://docs.example/page", host: null },
    { href: `${www()}/article.html`, title: `${www()}/article.html`, host: new URL(www()).host },
  ]);
  assert.equal(out.mailto, true, "a mailto: link is its text");
  assert.equal(out.save, "Save as .py");
  assert.equal(out.openedUrl, `${www()}/article.html`, "the user's click opens the link in a new tab");
  assert.match(out.panel, /panel\.html$/);
});

test("step 6: the live card draws only while the user can see it; Watch moves the window only on its click, and ⌃Tab back only while watching; Take over is zenius's own, until its Resume agent", async t => {
  await useMock();
  const before = await h.call("dev.viewState");
  const out = await chrome(`
    const g = win.ucAgentSidebar;
    const AS = g.AgentService;
    const P = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebarPictureParent.sys.mjs");
    await S.openPanel();
    const userSpace = win.gZenWorkspaces.activeWorkspace;
    const userTab = win.gBrowser.selectedTab;
    const atUser = () => win.gZenWorkspaces.activeWorkspace === userSpace && win.gBrowser.selectedTab === userTab;
    const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
    // The flights scene holds its last click, so the agent keeps working.
    const uid = await startWorkChat(win, { text: "SCENARIO:flights", source: "urlbar" });
    const conv = AS.tasks.get(uid);
    const doc = S.panelDoc();
    const live = doc.getElementById("live");
    const drawn = () => Number(live.dataset.drawn ?? 0);
    const ctrlTab = () => win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true, bubbles: true, cancelable: true }));
    const res = { space: null };
    try {
      await S.until(() => conv.busy && AS.zenRecord(conv) && AS.zenFrontTab(conv) && !live.hidden && live.dataset.live === "true", 30000);
      const rec = AS.zenRecord(conv);
      res.space = rec.id;
      // The agent's run opened and filled its page: the window stayed put.
      res.during = { atUser: atUser(), watching: g.watching };
      // A picture every 2 s while the card shows; none in Chat, where Work's
      // card can't be seen; again once it shows.
      let mark = drawn();
      await S.sleep(4500);
      res.shown = drawn() - mark;
      g.setMode("chat");
      await S.sleep(300);
      mark = drawn();
      await S.sleep(4500);
      res.unseen = drawn() - mark;
      g.showTask(uid);
      await S.until(() => doc.documentElement.dataset.mode === "work" && !live.hidden, 5000);
      mark = drawn();
      await S.sleep(4500);
      res.again = drawn() - mark;
      // ⌃Tab while not watching isn't the sidebar's.
      res.ctrlTabUnwatched = { notStopped: ctrlTab(), atUser: atUser() };
      // Watch, on its click: the task's Space; the card says ⌃Tab is the way
      // back where Watch was (the user's design), and zenius's strip says
      // "Watching <task> · ⌃Tab" (the chip shows only where the strip can't be read).
      doc.getElementById("watch").click();
      await S.until(() => g.watching === uid, 10000);
      res.watch = { space: win.gZenWorkspaces.activeWorkspace === rec.uuid, watchShown: !doc.getElementById("watch").hidden, hint: doc.getElementById("watch-hint").hidden ? null : doc.getElementById("watch-hint").textContent, card: doc.getElementById("live").dataset.watching, chip: !(win.document.getElementById("zenius-watch-pill")?.hidden ?? true), strip: win.document.getElementById("zenius-agents-strip").getAttribute("watching"), attr: win.document.documentElement.getAttribute("data-zenius-watching") === uid };
      // The user's ⌃Tab goes back to their Space and tab.
      res.ctrlTabWatched = { stopped: !ctrlTab() };
      await S.until(() => g.watching === null && atUser(), 5000);
      res.back = { atUser: atUser(), watching: g.watching, button: doc.getElementById("watch").hidden ? null : doc.getElementById("watch").textContent, hintShown: !doc.getElementById("watch-hint").hidden, card: doc.getElementById("live").dataset.watching };
      // Take over: zenius's own (the tasks panel's), then a watch; the
      // button's call says whether the user has the task.
      const realTakeOver = g.takeOver;
      let taking = null;
      g.takeOver = (...args) => (taking = realTakeOver(...args));
      try {
        doc.getElementById("take-over").click();
        await S.until(() => taking, 5000);
        res.took = await taking;
      } finally {
        g.takeOver = realTakeOver;
      }
      await S.until(() => AS.isHeld(conv) === "takeover" && g.watching === uid, 10000);
      await S.until(() => /^You have control/.test(doc.getElementById("live-text").textContent), 5000);
      res.takeover = { held: AS.isHeld(conv), ownership: rec.ownership, watching: g.watching === uid, text: doc.getElementById("live-text").textContent.split(" · ")[0], takeOverShown: !doc.getElementById("take-over").hidden };
      // While the user has the page, where they may type a password, the
      // card paints nothing: it keeps its last picture.
      mark = drawn();
      res.heldPicture = await P.drawPicture(conv, AS.zenFrontTab(conv), { width: 320, height: 160 });
      await S.sleep(2500);
      res.heldDrawn = drawn() - mark;
      // zenius's Resume agent, on its control card over the page, hands it
      // back. The card takes clicks 400 ms after it shows (notices.sys.mjs's
      // ARM_MS: a double click on Take over mustn't land on it).
      const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
      const card = await S.until(() => [...win.gBrowser.tabs].map(tab => N.noticeElement(tab, "zenius-control")).find(Boolean), 5000);
      await S.sleep(600);
      [...(card?.querySelectorAll("button") ?? [])].find(b => b.textContent === "Resume agent")?.click();
      await S.until(() => !AS.isHeld(conv) && rec.ownership === "agent", 10000);
      res.resumed = { held: AS.isHeld(conv), ownership: rec.ownership };
    } finally {
      AS.cancel(conv);
      await S.until(() => !conv.busy, 10000);
      if (g.watching) await g.stopWatching();
      if (win.gZenWorkspaces.activeWorkspace !== userSpace) await win.gZenWorkspaces.changeWorkspaceWithID(userSpace);
      if (userTab.isConnected) win.gBrowser.selectedTab = userTab;
      g.setMode("chat");
    }
    return res;
  `);
  if (out.space) {
    await h.call("spaces.finish", { space: out.space, keep: [] }).catch(() => {});
  }
  t.diagnostic(`live card: ${out.shown} pictures in 4.5 s shown, ${out.unseen} unseen, ${out.again} again`);
  assert.deepEqual(out.during, { atUser: true, watching: null }, "the agent's run never moves the window");
  assert.ok(out.shown >= 1 && out.shown <= 3, `pictures while shown: ${out.shown}`);
  assert.equal(out.unseen, 0, "no picture while the card can't be seen");
  assert.ok(out.again >= 1, `pictures once it shows again: ${out.again}`);
  assert.deepEqual(out.ctrlTabUnwatched, { notStopped: true, atUser: true }, "⌃Tab while not watching is Zen's");
  const ctrlTabLabel = process.platform === "darwin" ? "⌃Tab" : "Ctrl+Tab";
  assert.deepEqual(out.watch, { space: true, watchShown: false, hint: `${ctrlTabLabel} back to your tabs`, card: "true", chip: false, strip: "true", attr: true });
  assert.deepEqual(out.ctrlTabWatched, { stopped: true });
  assert.deepEqual(out.back, { atUser: true, watching: null, button: "Watch", hintShown: false, card: "false" });
  assert.equal(out.took, true, "the Take over button's call says the user has the task");
  assert.deepEqual(out.takeover, { held: "takeover", ownership: "agentDelegatedToUser", watching: true, text: "You have control", takeOverShown: false });
  assert.equal(out.heldPicture, null, "no picture of the page while the user has it");
  assert.equal(out.heldDrawn, 0, "the card draws nothing while the user has the page");
  assert.deepEqual(out.resumed, { held: false, ownership: "agent" });
  const after = await h.call("dev.viewState");
  assert.equal(after.windows[0].activeWorkspace, before.windows[0].activeWorkspace, "the user's Space at the end");
});
test("step 6: the card paints only an agent's page of its chat's own task, checked before the actor is made: never the user's tab, a tab they opened from the task's page, or another task's page; a picture is raw pixels of the size asked; a page too busy to answer costs only itself, and the card keeps what it has", async () => {
  await useMock();
  const other = await h.createSpace({ name: `zen-ux sidebar other ${run}` });
  let out;
  try {
    await h.call("page.goto", { space: other.id, page: "p1", url: `${www()}/zen-ux/hidden.html?other` });
    out = await chrome(
      `
      const g = win.ucAgentSidebar;
      const AS = g.AgentService;
      const P = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebarPictureParent.sys.mjs");
      await S.openPanel();
      const userSpace = win.gZenWorkspaces.activeWorkspace;
      const userTab0 = win.gBrowser.selectedTab;
      const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
      const uid = await startWorkChat(win, { text: "SCENARIO:flights", source: "urlbar" });
      const conv = AS.tasks.get(uid);
      const doc = S.panelDoc();
      const live = doc.getElementById("live");
      const drawn = () => Number(live.dataset.drawn ?? 0);
      const actorIn = tab => tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getExistingActor("AgentSidebarPicture") ?? null;
      const size = { width: 320, height: 160 };
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const loaded = tab => S.until(() => !tab.hasAttribute("busy") && tab.linkedBrowser.currentURI.spec.startsWith("http"), 10000);
      const opened = [];
      const res = { space: null };
      try {
        await S.until(() => conv.busy && AS.zenRecord(conv) && AS.zenFrontTab(conv) && !live.hidden && live.dataset.live === "true" && drawn() > 0, 30000);
        const rec = AS.zenRecord(conv);
        res.space = rec.id;
        const agentTab = AS.zenFrontTab(conv);
        const zp = AS.zenius().pages;
        // The agent's page: pixels exactly as wide as asked, no taller.
        const pic = await P.drawPicture(conv, agentTab, size);
        res.agent = { width: pic?.width, tall: pic?.height >= 1 && pic?.height <= size.height, bytes: pic?.pixels?.byteLength === size.width * pic?.height * 4, actor: !!actorIn(agentTab) };
        const refusal = async tab => {
          const picture = await P.drawPicture(conv, tab, size);
          return { picture: picture && picture.width + "x" + picture.height, paintable: P.paintable(conv, tab), actor: actorIn(tab) };
        };
        // The user's own tab, in no task, and another client's task.
        const userTab = win.gBrowser.addTab(arg.user, { triggeringPrincipal: principal, inBackground: true });
        opened.push(userTab);
        await loaded(userTab);
        const otherTab = win.gBrowser.getTabForBrowser(ctx.resolvePage({ space: arg.other, page: "p1" }).browser);
        res.refused = { user: await refusal(userTab), other: await refusal(otherTab) };
        // Take over (zenius's own), and a tab the user opens from the page
        // they hold (a middle-click): it joins the task as theirs, with no
        // page of the agent's (zenius's noteOpenedTab; zen-snapshot's red
        // team, 1b). While they hold the task, nothing is painted.
        await g.takeOver(uid);
        await S.until(() => AS.isHeld(conv) === "takeover", 10000);
        const fromTask = win.gBrowser.addTab(arg.user + "?from-task", { triggeringPrincipal: principal, openerBrowser: agentTab.linkedBrowser, inBackground: true });
        opened.push(fromTask);
        await loaded(fromTask);
        res.fromTaskJoined = zp.tabsOf(rec).includes(fromTask) && !zp.forTab(fromTask);
        res.held = await refusal(agentTab);
        // zenius's Resume agent, on its control card (armed 400 ms after it shows).
        const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
        const card = await S.until(() => [...win.gBrowser.tabs].map(tab => N.noticeElement(tab, "zenius-control")).find(Boolean), 5000);
        await S.sleep(600);
        [...card.querySelectorAll("button")].find(b => b.textContent === "Resume agent").click();
        await S.until(() => !AS.isHeld(conv) && rec.ownership === "agent", 10000);
        // The agent has the task again; the user's tab in it is still theirs.
        res.refused.fromTask = await refusal(fromTask);
        // The card shows again (a picture now) with the user's tab as the
        // task's front tab (they picked it): none; with the agent's: one.
        const showAgain = async () => {
          g.setMode("chat");
          await S.sleep(200);
          const mark = drawn();
          g.showTask(uid);
          await S.until(() => doc.documentElement.dataset.mode === "work" && !live.hidden, 5000);
          await S.sleep(1500);
          return drawn() - mark;
        };
        zp.noteFront(fromTask);
        await S.until(() => AS.zenFrontTab(conv) === fromTask, 5000);
        res.frontUser = { drawn: await showAgain(), actor: actorIn(fromTask) };
        zp.noteFront(agentTab);
        await S.until(() => AS.zenFrontTab(conv) === agentTab, 5000);
        res.frontAgent = await showAgain();
        // The agent's page too busy to answer (6 s of its own script): the
        // ask gives up, the parent's main thread runs on, and the card,
        // asking as it shows again, keeps what it has.
        Services.prefs.setIntPref("uc.agent-sidebar.picture-timeout", 1500);
        const busy = ctx.content(agentTab.linkedBrowser.browsingContext, "dev#evalContent", { code: "const end = Date.now() + 6000; while (Date.now() < end) {} return true;", privileged: true }).catch(() => null);
        await S.sleep(200);
        let gap = 0;
        let last = win.performance.now();
        const ticker = win.setInterval(() => {
          const now = win.performance.now();
          gap = Math.max(gap, now - last);
          last = now;
        }, 10);
        const t0 = win.performance.now();
        const busyPicture = await P.drawPicture(conv, agentTab, size);
        res.busy = { picture: busyPicture, ms: Math.round(win.performance.now() - t0) };
        g.setMode("chat");
        await S.sleep(200);
        g.showTask(uid);
        await S.until(() => live.dataset.every === "kept", 5000);
        win.clearInterval(ticker);
        res.busy.every = live.dataset.every;
        res.busy.gap = Math.round(gap);
        await busy;
        // The user's own tab from before the chat has no picture actor
        // either. (A page the card painted while it was the agent's keeps
        // its idle actor once its task ends, until it unloads: an earlier
        // test's kept page.)
        res.ownTab = { paintable: P.paintable(conv, userTab0), actor: actorIn(userTab0) };
      } finally {
        Services.prefs.clearUserPref("uc.agent-sidebar.picture-timeout");
        AS.cancel(conv);
        await S.until(() => !conv.busy, 10000).catch(() => {});
        for (const tab of opened) {
          if (tab.isConnected) win.gBrowser.removeTab(tab, { animate: false });
        }
        if (win.gZenWorkspaces.activeWorkspace !== userSpace) await win.gZenWorkspaces.changeWorkspaceWithID(userSpace);
        if (userTab0.isConnected) win.gBrowser.selectedTab = userTab0;
        g.setMode("chat");
      }
      return res;
    `,
      { user: `${www()}/zen-ux/hidden.html`, other: other.id }
    );
  } finally {
    await h.call("spaces.finish", { space: other.id, keep: [] }).catch(() => {});
  }
  if (out.space) {
    await h.call("spaces.finish", { space: out.space, keep: [] }).catch(() => {});
  }
  assert.deepEqual(out.agent, { width: 320, tall: true, bytes: true, actor: true }, "the agent's page");
  assert.equal(out.fromTaskJoined, true, "the tab the user opened from the page they held is the task's, with no page of the agent's");
  assert.deepEqual(out.held, { picture: null, paintable: false, actor: out.held.actor }, "nothing painted while the user holds the task");
  const none = { picture: null, paintable: false, actor: null };
  assert.deepEqual(out.refused, { user: none, other: none, fromTask: none });
  assert.deepEqual(out.frontUser, { drawn: 0, actor: null }, "the user's tab as the task's front tab");
  assert.ok(out.frontAgent >= 1, `the agent's page as the front tab again: ${out.frontAgent} pictures`);
  assert.equal(out.busy.picture, null);
  assert.ok(out.busy.ms >= 1400 && out.busy.ms < 3000, `the busy page's ask gave up after ${out.busy.ms} ms`);
  assert.equal(out.busy.every, "kept");
  assert.ok(out.busy.gap < 250, `the parent's main thread ran on: its longest gap was ${out.busy.gap} ms`);
  assert.deepEqual(out.ownTab, { paintable: false, actor: null }, "the user's own tab from before the chat");
});

test("the sidebar's ways in are zenius's watch: a directory tab and the card's Watch, with Ctrl+Tab back from each. Where the strip can't be read, the chip says 'Watching <task> · Ctrl+Tab' in the page area's corner, capped, and every click on it reaches the page, while watching and after Take over", async () => {
  await useMock();
  const out = await chrome(`
    const g = win.ucAgentSidebar;
    const AS = g.AgentService;
    const UI = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/index.sys.mjs").ZeniusUI;
    await S.openPanel();
    const userSpace = win.gZenWorkspaces.activeWorkspace;
    const userTab0 = win.gBrowser.selectedTab;
    const atUser = () => win.gZenWorkspaces.activeWorkspace === userSpace && win.gBrowser.selectedTab === userTab0;
    const key = type => win.dispatchEvent(new win.KeyboardEvent(type, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true, bubbles: true, cancelable: true }));
    const ctrlTab = () => {
      const stopped = !key("keydown");
      key("keyup");
      return stopped;
    };
    const { startWorkChat } = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs");
    const uid = await startWorkChat(win, { text: "SCENARIO:flights", source: "urlbar" });
    const conv = AS.tasks.get(uid);
    const doc = S.panelDoc();
    const live = doc.getElementById("live");
    // Where a click at a point lands, by the window's own hit test (which
    // skips pointer-events: none): the page (its <browser>) or chrome.
    const landsOn = (x, y) => {
      const el = win.document.elementFromPoint(x, y);
      if (!el) return "nothing";
      if (el.localName === "browser") return "page";
      if (el.closest?.("#zenius-watch-pill")) return "chip";
      return el.id || el.localName;
    };
    const look = () => {
      const pill = win.document.getElementById("zenius-watch-pill");
      if (!pill || pill.hidden) return { shown: false };
      const a = win.document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      const name = pill.querySelector(".zenius-watch-name");
      const n = name.getBoundingClientRect();
      const k = pill.querySelector(".zenius-watch-key").getBoundingClientRect();
      return {
        shown: true,
        topCenter: [12, 20, 36].map(dy => landsOn(a.left + a.width / 2, a.top + dy)),
        onName: landsOn(n.left + Math.min(40, n.width / 2), n.top + n.height / 2),
        onKey: landsOn(k.left + k.width / 2, k.top + k.height / 2),
        capped: p.width <= 280.5 && p.width <= Math.max(120, a.width * 0.4) + 0.5,
        corner: p.left - a.left >= 0 && p.left - a.left < 20 && p.top - a.top >= 0 && p.top - a.top < 20,
        cut: name.scrollWidth > name.clientWidth,
        key: pill.querySelector(".zenius-watch-key").textContent,
        buttons: pill.querySelectorAll("button").length,
      };
    };
    const res = { space: null };
    try {
      await S.until(() => conv.busy && AS.zenRecord(conv) && AS.zenFrontTab(conv) && !live.hidden, 30000);
      const rec = AS.zenRecord(conv);
      res.space = rec.id;
      // The directory: one of the shown task's tabs.
      g.showTask(uid);
      g.toggleDirectory();
      const chipTab = await S.until(() => win.document.querySelector('.asb-dir-row[data-task="' + uid + '"] .asb-dir-tab'), 5000);
      chipTab.click();
      await S.until(() => UI.watching(win) === rec.id && g.watching === uid, 10000);
      res.directory = { attr: win.document.documentElement.getAttribute("data-zenius-watching") === uid, strip: win.document.getElementById("zenius-agents-strip").getAttribute("watching") };
      res.directoryBack = { stopped: ctrlTab() };
      await S.until(() => g.watching === null && atUser(), 5000);
      res.directoryBack.atUser = atUser();
      g.closeDirectory();
      // The chip shows where the strip can't be read: a collapsed sidebar.
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", false);
      await S.until(() => win.document.documentElement.getAttribute("zen-sidebar-expanded") !== "true", 5000);
      // zenius's name for the task, which the strip and the chip show.
      rec.name = "Compare the prices of round-trip flights from Denver to Tokyo in late March across every airline and booking site, including fees for seats and bags, then list the three best options with links for the family".slice(0, 200).padEnd(200, " plan");
      res.nameLength = rec.name.length;
      doc.getElementById("watch").click();
      await S.until(() => g.watching === uid, 10000);
      await S.sleep(400);
      res.watching = look();
      res.cardBack = { stopped: ctrlTab() };
      await S.until(() => g.watching === null && atUser(), 5000);
      res.cardBack.atUser = atUser();
      // Take over watches too: the user's own click at the page's top
      // center goes to the page, not to the chip.
      await g.takeOver(uid);
      await S.until(() => AS.isHeld(conv) === "takeover" && g.watching === uid, 10000);
      await S.sleep(400);
      res.takeover = look();
      const a = win.document.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
      const hits = [];
      const onDown = e => hits.push(e.originalTarget?.localName ?? null);
      win.addEventListener("mousedown", onDown, true);
      try {
        const x = a.left + a.width / 2;
        const y = a.top + 20;
        for (const type of ["mousedown", "mouseup"]) {
          win.synthesizeMouseEvent(type, x, y, { button: 0, buttons: type === "mousedown" ? 1 : 0, clickCount: 1 }, { isDOMEventSynthesized: false });
        }
        await S.sleep(300);
      } finally {
        win.removeEventListener("mousedown", onDown, true);
      }
      res.click = { hits, watching: g.watching === uid };
      // zenius's Resume agent, on its control card (armed 400 ms after it shows).
      const N = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/notices.sys.mjs");
      const card = await S.until(() => [...win.gBrowser.tabs].map(tab => N.noticeElement(tab, "zenius-control")).find(Boolean), 5000);
      await S.sleep(600);
      [...card.querySelectorAll("button")].find(b => b.textContent === "Resume agent").click();
      await S.until(() => !AS.isHeld(conv), 10000);
    } finally {
      Services.prefs.setBoolPref("zen.view.sidebar-expanded", true);
      AS.cancel(conv);
      await S.until(() => !conv.busy, 10000).catch(() => {});
      if (g.watching) await g.stopWatching();
      if (win.gZenWorkspaces.activeWorkspace !== userSpace) await win.gZenWorkspaces.changeWorkspaceWithID(userSpace);
      if (userTab0.isConnected) win.gBrowser.selectedTab = userTab0;
      g.closeDirectory();
      g.setMode("chat");
    }
    return res;
  `);
  if (out.space) {
    await h.call("spaces.finish", { space: out.space, keep: [] }).catch(() => {});
  }
  assert.deepEqual(out.directory, { attr: true, strip: "true" }, "the directory's tab is zenius's watch");
  assert.deepEqual(out.directoryBack, { stopped: true, atUser: true }, "Ctrl+Tab back from the directory's watch");
  assert.deepEqual(out.cardBack, { stopped: true, atUser: true }, "Ctrl+Tab back from the card's watch");
  assert.equal(out.nameLength, 200);
  // The key as the platform shows it (watch.sys.mjs's BACK_KEY).
  const backKey = process.platform === "darwin" ? "⌃Tab" : "Ctrl+Tab";
  const chip = { shown: true, topCenter: ["page", "page", "page"], onName: "page", onKey: "page", capped: true, corner: true, cut: true, key: `· ${backKey}`, buttons: 0 };
  assert.deepEqual(out.watching, chip, "while watching");
  assert.deepEqual(out.takeover, chip, "after Take over");
  assert.deepEqual(out.click, { hits: ["browser"], watching: true }, "the user's click at the page's top center went to the page, and the watch went on");
});

test("with no agent, the sidebar starts cleanly and the address bar offers no 'Ask agent' row", async () => {
  const gone = join(dir, "no-config.json");
  try {
    for (const value of ["none", gone]) {
      await chrome(`Services.prefs.setStringPref(${JSON.stringify(PREF)}, ${JSON.stringify(value)}); await win.ucAgentSidebar.AgentService.loadConfig().catch(() => null); return true;`);
      const status = await h.call("ui.sidebarStatus", {});
      assert.equal(status.error, undefined, `${value}: no startup error`);
      assert.equal(status.loaded, true);
      const rows = await chrome(`
        const bar = win.gURLBar;
        bar.view.close();
        bar.focus();
        bar.value = "> plan a trip";
        bar.inputField.setSelectionRange(13, 13);
        bar.inputField.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: "p" }));
        await S.sleep(1500);
        const providers = bar.view.visibleResults.map(r => r.providerName);
        bar.view.close();
        bar.handleRevert?.();
        return providers;
      `);
      assert.ok(!rows.some(p => /^ZeniusAskAgent/.test(p)), `${value}: ${rows.join(", ")}`);
    }
  } finally {
    await chrome(`Services.prefs.setStringPref(${JSON.stringify(PREF)}, "none"); return true;`);
  }
});
