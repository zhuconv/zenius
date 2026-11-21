// For docs/research/input-gaps.md (zen-input). The input cases where
// Chromium's own behavior decides what Ego does ("Ego run" there). Also the
// dialog, focus, idle and drag cases whose Ego side was read from its code,
// checked before zenius changes them. Run it on either target:
//   ego-browser nodejs < tests/input/probes/ego-gaps.mjs
//   sdk/bin/zenius nodejs --instance <name> < tests/input/probes/ego-gaps.mjs
// What it touches:
//   - It serves every page itself on loopback: http://127.0.0.1:<port>, and
//     http://localhost:<port> for the cross-site frames (also on ::1 when it
//     can, for a browser that tries localhost there first).
//   - It makes one task space and finishes it in a finally block, and closes
//     the one extra page it opens.
//   - It writes two small files to a temporary folder and deletes the
//     folder.
//   - It uses no clipboard.
// It prints one JSON line per case, {case, gap, ms, result}, then {done}.
// page.evaluate runs in an isolated world on zenius, which can't see the
// page's globals (Ego's runs in the page's own), so each page hands its logs
// over through the DOM (BRIDGE), the same way on both.
// `gap` is the item's label in input-gaps.md: a number for a gap, D1-D7 for
// a deliberate difference (run here so its PARITY note states what Ego
// does), and E for the open question in its section E.
const http = await import("node:http");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let port = 0;
const top = () => `http://127.0.0.1:${port}`;
const cross = () => `http://localhost:${port}`;
// Frames post what they see to the top page, which keeps it in window.frameLog.
const FRAME_LOG = `<script>window.frameLog=[];addEventListener("message",e=>frameLog.push(String(e.data)))</script>`;
// In every page: on a "probe" event, run the command in data-probe-cmd, in
// the page's own world, and write the page's logs to data-probe (ask()).
const BRIDGE =
  `<script>document.addEventListener("probe",()=>{const d=document.documentElement.dataset,c=d.probeCmd;` +
  `if(c==="clear")window.log.length=0;` +
  `else if(c==="remove"){window.kept=document.querySelector("#again");window.kept.remove()}` +
  `else if(c==="putback")document.body.prepend(window.kept);` +
  `else if(c==="blink"){const b=document.querySelector("#again");b.remove();setTimeout(()=>document.body.prepend(b),300)}` +
  `const o={};for(const k of ["log","frameLog","n","got","clicks","chooserEvents"])if(k in window)o[k]=window[k];d.probe=JSON.stringify(o)})</script>`;
const PAGES = {
  "/blank": () => `<p>blank</p>`,
  // Dialogs
  "/confirm-button": () =>
    `<button id=b style="position:absolute;left:40px;top:40px;width:120px;height:40px" onclick="confirm('Sure?')">Del</button>`,
  "/alert-on-two": () => `<input id=i oninput="if (this.value.length === 2) alert('two')">`,
  "/alert-first-click": () =>
    `<button id=b>go</button><script>let n=0;window.log=[];b.onmousedown=()=>log.push("down");b.onmouseup=()=>log.push("up");` +
    `b.onclick=()=>{log.push("click");if(++n===1)alert("x")};b.ondblclick=()=>log.push("dbl")</script>`,
  "/alert-on-enter": () =>
    `<input id=a><script>window.log=[];a.onkeydown=e=>{log.push("down:"+e.key);if(e.key==="Enter")alert("x")};` +
    `a.onkeypress=e=>log.push("press:"+e.key);a.onkeyup=e=>log.push("up:"+e.key)</script>`,
  "/alert-on-contextmenu": () =>
    `<div id=d style="width:200px;height:100px;background:#eee">d</div><script>window.log=[];` +
    `for(const t of ["mousedown","mouseup","auxclick","click"])d.addEventListener(t,()=>log.push(t));` +
    `d.oncontextmenu=e=>{log.push("contextmenu");e.preventDefault();alert("menu")}</script>`,
  "/confirm-on-change": () =>
    `<select id=s onchange="confirm('Reset the cart?')"><option>a</option><option>b</option></select>` +
    `<script>window.log=[];s.addEventListener("input",()=>log.push("input"));s.addEventListener("change",()=>log.push("change"))</script>`,
  "/alert-on-input": () => `<input id=f><script>window.n=0;f.addEventListener("input",()=>{if(++n===1)alert("typed")})</script>`,
  "/alert-then-more": () => `<button id=a onclick="alert('hi')">a</button><button id=b>b</button><input id=t>`,
  // Focus and turns
  "/ce-autofocus": () => `<div id=e contenteditable style="min-height:40px;border:1px solid"></div><script>e.focus()</script>`,
  "/ce-tab": () => `<input id=a><div id=e contenteditable style="min-height:40px;border:1px solid"></div>`,
  "/microtasks": () =>
    `<input id=a><script>window.log=[];a.addEventListener("keydown",e=>{log.push("kd:"+e.key);queueMicrotask(()=>log.push("mt:"+e.key))})</script>`,
  "/undo-in-microtask": () => `<input id=a><script>a.addEventListener("input",()=>queueMicrotask(()=>{a.value=""}))</script>`,
  // Idle and drags
  "/polling": () =>
    `<p>polling</p><script>setInterval(()=>fetch("/tick?"+Math.random()),300);` +
    `setTimeout(()=>document.body.insertAdjacentHTML("beforeend","<button id=late>late</button>"),2000)</script>`,
  "/drag-with-frame": () =>
    `<iframe src="${cross()}/blank" style="width:200px;height:100px"></iframe>` +
    `<div id=src style="position:absolute;left:20px;top:150px;width:80px;height:80px;background:#9cf">src</div>` +
    `<div id=dst style="position:absolute;left:300px;top:150px;width:120px;height:120px;background:#fc9">dst</div>` +
    `<div id=cover style="position:fixed;inset:0"></div><script>window.log=[];` +
    `for(const t of ["mousedown","mouseup"])document.addEventListener(t,e=>log.push(t+":"+e.target.id));setTimeout(()=>cover.remove(),300)</script>`,
  "/frame-drag-host": () => `${FRAME_LOG}<iframe src="${cross()}/frame-drag" style="width:500px;height:300px"></iframe>`,
  "/frame-drag": () =>
    `<div id=fsrc style="position:absolute;left:20px;top:20px;width:80px;height:80px;background:#9cf">fsrc</div>` +
    `<div id=fdst style="position:absolute;left:250px;top:20px;width:120px;height:120px;background:#fc9">fdst</div>` +
    `<script>for(const t of ["mousedown","mouseup"])document.addEventListener(t,e=>parent.postMessage(t+":"+e.target.id,"*"))</script>`,
  "/static-dst": () => `<div id=dst style="width:100px;height:100px">dst</div>`,
  "/drag-into-frame": () =>
    `<div id=src style="width:80px;height:80px;background:#9cf">src</div><iframe id=f src="/drop-frame" style="width:300px;height:200px"></iframe>` +
    `<script>window.log=[];for(const t of ["mousedown","mousemove","mouseup","dragstart","drop"])` +
    `document.addEventListener(t,e=>{if(t!=="mousemove"||log.at(-1)!=="top:mousemove")log.push("top:"+t)})</script>`,
  "/drop-frame": () =>
    `<div id=dst style="width:200px;height:150px;background:#fc9">dst</div><script>` +
    `for(const t of ["mousedown","mousemove","mouseup","dragenter","drop"])document.addEventListener(t,e=>{const log=parent.log;` +
    `const entry="frame:"+t+":"+e.target.id;if(log.at(-1)!==entry)log.push(entry)})</script>`,
  // Refs
  "/middle": () =>
    `<a id=l href="/blank" style="display:block;font-size:40px">open</a><script>window.log=[];` +
    `for(const t of ["mousedown","mouseup","auxclick","click"])l.addEventListener(t,e=>log.push(t+":"+e.button))</script>`,
  "/again": () => `<button id=again onclick="window.clicks=(window.clicks||0)+1">Again</button><p>refs</p>`,
  // Files
  "/files": () =>
    `<input type=file id=one><button id=pick onclick="document.querySelector('#one').click()">pick</button>` +
    `<button id=late onclick="setTimeout(()=>document.querySelector('#one').click(),50)">late</button>` +
    `<button id=picker onclick="document.querySelector('#one').showPicker()">picker</button>` +
    `<button id=detached onclick="const i=document.createElement('input');i.type='file';i.onchange=()=>window.got=i.files[0]?.name;i.click()">detached</button>` +
    `<script>window.chooserEvents=[];for(const t of ["cancel","input","change"])document.querySelector("#one").addEventListener(t,()=>chooserEvents.push(t))</script>`,
  "/zero-frame": () => `${FRAME_LOG}<p>top</p><iframe src="${cross()}/frame-file" style="width:0;height:0;border:0"></iframe>`,
  "/below-frame": () => `${FRAME_LOG}<div style="height:3000px">tall</div><iframe src="${cross()}/frame-file"></iframe>`,
  "/frame-file": () => `<input type=file id=ff><script>ff.onchange=()=>parent.postMessage("files:"+ff.files.length,"*")</script>`,
  // Wheel, pointer and keys across frames
  "/wheel-chain": () =>
    `<body style="margin:0"><iframe src="${cross()}/blank" style="width:400px;height:300px;border:0"></iframe><div style="height:5000px"></div></body>`,
  "/locked": () => `<body style="overflow:hidden"><div style="height:5000px">x</div></body>`,
  "/leave": () =>
    `<body style="margin:0"><div id=m style="width:200px;height:100px;background:#eee" onmouseleave="this.dataset.left=1">m</div>` +
    `<iframe src="${cross()}/blank" style="width:300px;height:200px;border:0"></iframe></body>`,
  "/press-frame": () => `${FRAME_LOG}<input id=a><iframe id=f src="${cross()}/frame-keys"></iframe>`,
  "/frame-keys": () => `<input id=b autofocus><script>document.addEventListener("keydown",e=>parent.postMessage("key:"+e.key,"*"))</script>`,
  "/buttons": () =>
    `<body style="margin:0;height:400px"><script>window.log=[];for(const t of ["mousedown","mouseup","mousemove"])addEventListener(t,e=>log.push(t+":"+e.buttons))</script></body>`,
  "/caps": () => `<input id=a><script>window.log=[];a.onkeydown=e=>log.push(e.key+":"+e.getModifierState("CapsLock"))</script>`,
};

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/tick") {
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }
  const page = PAGES[url.pathname];
  res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page ? `<!doctype html><meta charset=utf-8>${BRIDGE}${page()}` : "no");
}

// Ego's embedded Node (stdin mode) resolves listen() only while a timer is
// pending (zen-eval's note in tests/observe/ego/title-after-click.mjs).
const keepAlive = setInterval(() => {}, 20);
const server = http.createServer(handle);
await new Promise(r => server.listen(0, "127.0.0.1", r));
port = server.address().port;
const server6 = http.createServer(handle);
await new Promise(r => {
  server6.once("error", r);
  server6.listen(port, "::1", r);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-input-ego-gaps-"));
const A = path.join(dir, "a.txt");
const B = path.join(dir, "b.txt");
fs.writeFileSync(A, "alpha\n");
fs.writeFileSync(B, "beta\n");

const errorOf = e => ({ error: e?.code ?? e?.name ?? "Error", message: String(e?.message ?? e).split("\n")[0].slice(0, 240) });
/** How `p` settles within `ms`: resolved (with its value), rejected, or still pending. */
function within(p, ms) {
  const t0 = Date.now();
  return Promise.race([
    p.then(
      v => ({ settled: "resolved", value: v ?? null, ms: Date.now() - t0 }),
      e => ({ settled: "rejected", ...errorOf(e), ms: Date.now() - t0 })
    ),
    sleep(ms).then(() => ({ settled: "pending", ms })),
  ]);
}

const task = await taskSpace(`zen-input ego gaps ${Date.now()}`);
let page;
let cases = 0;
const go = p => page.goto(`${top()}${p}`);
const read = fn => page.evaluate(fn);
/** Run a BRIDGE command in the page's own world; returns the page's logs. */
const ask = (cmd = "read") =>
  page.evaluate(c => {
    const d = document.documentElement.dataset;
    d.probeCmd = c;
    document.dispatchEvent(new CustomEvent("probe"));
    return JSON.parse(d.probe || "{}");
  }, cmd);
const pageVar = async name => (await ask())[name] ?? null;

async function run(name, gap, fn) {
  const t0 = Date.now();
  let result;
  try {
    result = await Promise.race([fn(), sleep(30000).then(() => ({ hung: true }))]);
  } catch (e) {
    result = errorOf(e);
  }
  // No case leaves a dialog open for the next one.
  await page.dismissDialog().catch(() => {});
  cases++;
  console.log(JSON.stringify({ case: name, gap, ms: Date.now() - t0, result }));
}

try {
  page = await task.newPage();
  // Ego's guard against a click's file chooser ends just after the click
  // (page-model.ts:3264-3290). A chooser the page opens later would show
  // the user's own file picker, so the case that does that runs only where
  // the page is Gecko's, that is on zenius.
  await go("/blank");
  const onZenius = await read(() => navigator.userAgent.includes("Firefox"));

  // ---- Dialogs: what a gesture does once a handler opens one (gaps 1-3, E)
  await run("mouse.up whose click opens confirm()", "1", async () => {
    await go("/confirm-button");
    await page.mouse.move(100, 60);
    await page.mouse.down();
    const up = page.mouse.up();
    const first = await within(up, 3000);
    const info = await page.info();
    await page.dismissDialog();
    return { up: first, infoDialog: info?.dialog?.type ?? null, afterAnswer: await within(up, 3000) };
  });
  await run("keyboard.type whose input opens alert() at the second character", "1", async () => {
    await go("/alert-on-two");
    await page.click("#i");
    const typing = page.keyboard.type("abcd");
    const first = await within(typing, 3000);
    await page.dismissDialog();
    const afterAnswer = await within(typing, 3000);
    await sleep(200);
    return { type: first, afterAnswer, value: await read(() => document.querySelector("#i").value) };
  });
  await run("dblclick whose first click alerts", "2", async () => {
    await go("/alert-first-click");
    const r = await page.dblclick("#b");
    await page.acceptDialog();
    await sleep(300);
    return { receipt: r?.dialog?.type ?? r, log: await pageVar("log") };
  });
  await run("press Enter whose keydown alerts", "2", async () => {
    await go("/alert-on-enter");
    const r = await page.press("#a", "Enter");
    await page.acceptDialog();
    await sleep(200);
    return { receipt: r?.dialog?.type ?? r, log: await pageVar("log") };
  });
  await run("right click whose contextmenu handler alerts", "2", async () => {
    await go("/alert-on-contextmenu");
    const r = await page.click("#d", { button: "right" });
    await page.dismissDialog();
    await sleep(300);
    return { receipt: r?.dialog?.type ?? r, log: await pageVar("log") };
  });
  await run("selectOption whose change opens confirm()", "3", async () => {
    await go("/confirm-on-change");
    const first = await within(page.selectOption("#s", "b"), 3000);
    const info = await page.info();
    await page.dismissDialog();
    await sleep(200);
    return { selectOption: first, infoDialog: info?.dialog?.type ?? null, log: await pageVar("log") };
  });
  await run("fill whose input handler alerts", "1", async () => {
    await go("/alert-on-input");
    const call = page.fill("#f", "hello");
    const first = await within(call, 3000);
    await page.dismissDialog();
    const afterAnswer = await within(call, 3000);
    await sleep(400);
    return { fill: first, afterAnswer, value: await read(() => document.querySelector("#f").value), inputEvents: await pageVar("n") };
  });
  await run("actions while a dialog is already open", "E", async () => {
    await go("/alert-then-more");
    const opened = await page.click("#a");
    const r = { opened: opened?.dialog?.type ?? opened };
    for (const [name, fn] of [
      ["click", () => page.click("#b")],
      ["hover", () => page.hover("#b")],
      ["fill", () => page.fill("#t", "x")],
      ["mouse.click", () => page.mouse.click(5, 5)],
      ["keyboard.press", () => page.keyboard.press("a")],
      ["mouse.move", () => page.mouse.move(6, 6)],
      ["keyboard.type", () => page.keyboard.type("z")],
    ]) {
      r[name] = await within(fn(), 3000);
    }
    return r;
  });

  await run("middle click on a link", "D3", async () => {
    await go("/middle");
    const before = (await task.pages()).length;
    const r = await within(page.click("#l", { button: "middle" }), 5000);
    await sleep(800);
    const pages = await task.pages();
    // Close what it opened, so the task holds one page again.
    for (const p of pages.slice(before)) {
      await p.close().catch(() => {});
    }
    return { click: r, pagesBefore: before, pagesAfter: pages.length, log: await pageVar("log") };
  });

  // ---- Focus and turns (gaps 4, 5)
  await run("type into a contenteditable the page focused itself", "4", async () => {
    await go("/ce-autofocus");
    await sleep(200);
    await page.keyboard.type("hi");
    return await read(() => ({ text: document.querySelector("#e").textContent, active: document.activeElement.id }));
  });
  await run("Tab into a contenteditable, then type", "4", async () => {
    await go("/ce-tab");
    await page.focus("#a");
    await page.keyboard.press("Tab");
    await page.keyboard.type("x");
    return await read(() => ({ text: document.querySelector("#e").textContent, active: document.activeElement.id }));
  });
  await run("keydown and microtask order while typing", "5", async () => {
    await go("/microtasks");
    await page.click("#a");
    await page.keyboard.type("ab");
    return await pageVar("log");
  });
  await run("fill into a field a microtask empties", "5", async () => {
    await go("/undo-in-microtask");
    const r = await within(page.fill("#a", "hello"), 6000);
    return { fill: r, value: await read(() => document.querySelector("#a").value) };
  });

  // ---- Idle fail-fast and drags (gaps 6, 8, 9, 10)
  await run("click a target that appears after 2 s on a page that polls", "6", async () => {
    await go("/polling");
    return await within(page.click("#late", { timeout: 5000 }), 8000);
  });
  await run("dragAndDrop with a cross-site frame on the page, ends covered for 300 ms", "8", async () => {
    await go("/drag-with-frame");
    const r = await within(page.dragAndDrop("#src", "#dst"), 6000);
    return { drag: r, log: await pageVar("log") };
  });
  await run("dragAndDrop between two elements inside one cross-site frame", "8", async () => {
    await go("/frame-drag-host");
    await sleep(500);
    const r = await within(page.dragAndDrop("#fsrc", "#fdst"), 6000);
    await sleep(200);
    return { drag: r, frameLog: await pageVar("frameLog") };
  });
  await run("dragAndDrop with a missing source on an idle page", "9", async () => {
    await go("/static-dst");
    return await within(page.dragAndDrop("#nope", "#dst"), 6000);
  });
  await run("dragAndDrop from the top document into a same-origin frame", "10", async () => {
    await go("/drag-into-frame");
    await sleep(300);
    const r = await within(page.dragAndDrop("#src", "#dst"), 6000);
    await sleep(200);
    return { drag: r, log: await pageVar("log") };
  });

  // ---- A ref whose element is removed and put back (gap 11)
  await run("click a ref whose element was removed, then put back", "11", async () => {
    await go("/again");
    // The page's one button; zenius prints its name on a child line, so match the ref on the button's own.
    const refOf = async () => (String(await page.snapshot()).match(/button[^\n]*\[ref=(\d+)/) ?? [])[1];
    let ref = await refOf();
    await ask("remove");
    const whileDetached = await within(page.click(`@${ref}`, { timeout: 1000 }), 3000);
    await ask("putback");
    const afterPutBack = await within(page.click(`@${ref}`, { timeout: 1000 }), 3000);
    ref = await refOf();
    await ask("blink");
    const putBackDuringRetry = await within(page.click(`@${ref}`, { timeout: 2000 }), 4000);
    return { whileDetached, afterPutBack, putBackDuringRetry, clicks: ((await pageVar("clicks")) ?? 0) };
  });

  // ---- Files (gaps 12-17, F7)
  const names = () => read(() => Array.from(document.querySelector("#one").files, f => f.name));
  await run("setInputFiles with two files on a one-file input", "12", async () => {
    await go("/files");
    const r = await within(page.setInputFiles("#one", [A, B]), 5000);
    return { setInputFiles: r, files: await names() };
  });
  await run("setInputFiles with an empty list after one file", "D1", async () => {
    await go("/files");
    await page.setInputFiles("#one", A);
    const r = await within(page.setInputFiles("#one", []), 5000);
    return { setInputFiles: r, files: await names() };
  });
  await run("fileChooser.setFiles with two files on a one-file chooser, then one", "13", async () => {
    await go("/files");
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click("#pick")]);
    const two = await within(chooser.setFiles([A, B]), 5000);
    const one = await within(chooser.setFiles(A), 5000);
    return { two, one, files: await names() };
  });
  await run("fileChooser.setFiles on an input the page never attached", "14", async () => {
    await go("/files");
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click("#detached")]);
    const r = await within(chooser.setFiles(A), 5000);
    await sleep(100);
    return { setFiles: r, pageSaw: await pageVar("got") };
  });
  if (onZenius) {
    await run("a click whose handler opens the chooser 50 ms later", "15", async () => {
      await go("/files");
      return await within(page.click("#late"), 5000);
    });
  } else {
    console.log(
      JSON.stringify({
        case: "a click whose handler opens the chooser 50 ms later",
        gap: "15",
        skipped: "only run on zenius: on Ego the chooser opens after its guard ended, so the native file picker would show",
      })
    );
  }
  await run("a click whose handler calls showPicker()", "15", async () => {
    await go("/files");
    return await within(page.click("#picker"), 5000);
  });
  await run("a click that opens a chooser nobody waits for: what the input hears", "D4", async () => {
    await go("/files");
    const r = await within(page.click("#pick"), 5000);
    await sleep(500);
    return { click: r, events: await pageVar("chooserEvents") };
  });
  await run("waitForFileChooser on a page that closes", "16", async () => {
    const other = await task.newPage();
    await other.goto(`${top()}/files`);
    const wait = other.waitForFileChooser({ timeout: 10000 });
    wait.catch(() => {});
    await other.close();
    return await within(wait, 12000);
  });
  await run("setInputFiles in a 0-size cross-site frame", "17", async () => {
    await go("/zero-frame");
    await sleep(500);
    const r = await within(page.setInputFiles("#ff", A), 6000);
    await sleep(200);
    return { setInputFiles: r, frameLog: await pageVar("frameLog") };
  });
  await run("setInputFiles in a cross-site frame below the fold", "17", async () => {
    await go("/below-frame");
    await sleep(500);
    const before = await read(() => scrollY);
    const r = await within(page.setInputFiles("#ff", A), 6000);
    await sleep(200);
    return { setInputFiles: r, scrollYBefore: before, scrollYAfter: await read(() => scrollY), frameLog: await pageVar("frameLog") };
  });

  // ---- Wheel, pointer and keys across frames (gaps 18-23)
  await run("wheel over a cross-site frame that can't scroll", "18", async () => {
    await go("/wheel-chain");
    await sleep(500);
    await page.mouse.move(200, 150);
    await page.mouse.wheel(0, 600);
    await sleep(500);
    return { scrollY: await read(() => scrollY) };
  });
  await run("wheel on a page locked with body{overflow:hidden}", "19", async () => {
    await go("/locked");
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 800);
    await sleep(500);
    return { scrollY: await read(() => scrollY) };
  });
  await run("mouseleave when the pointer moves into a cross-site frame", "20", async () => {
    await go("/leave");
    await sleep(500);
    await page.hover("#m");
    await page.mouse.move(150, 200);
    await sleep(200);
    return { left: await read(() => document.querySelector("#m").dataset.left ?? null) };
  });
  await run("page.press on a cross-site frame element", "21", async () => {
    await go("/press-frame");
    await sleep(500);
    const r = await within(page.press("#f", "z"), 5000);
    await sleep(200);
    return { press: r, frameLog: await pageVar("frameLog") };
  });
  await run("mouse.click while a button is held", "22", async () => {
    await go("/buttons");
    await page.mouse.move(10, 10);
    await page.mouse.down();
    await ask("clear");
    await page.mouse.click(50, 50);
    await page.mouse.move(60, 60);
    const log = await pageVar("log");
    await page.mouse.up();
    return log;
  });
  await run("CapsLock, then a key", "23", async () => {
    await go("/caps");
    await page.focus("#a");
    await page.keyboard.press("CapsLock");
    await page.keyboard.press("a");
    const r = { log: await pageVar("log"), value: await read(() => document.querySelector("#a").value) };
    await page.keyboard.press("CapsLock");
    return r;
  });
} finally {
  await task.finish({ keep: [] }).catch(e => console.error("finish failed", e?.message));
  server.close();
  server6.close();
  fs.rmSync(dir, { recursive: true, force: true });
  clearInterval(keepAlive);
}
console.log(JSON.stringify({ done: true, cases }));
