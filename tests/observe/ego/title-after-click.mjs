// What page.title() reads right after a link click starts a navigation, on
// either target: `ego-browser nodejs < this` (Ego) or
// `zenius nodejs --instance <name> < this` (zenius). It serves its own pages
// on 127.0.0.1 and finishes the task space it makes.
//
// Two responses, each after 300 ms:
//   whole  headers and the whole document, <title> included, at once (the
//          slow page of tests/observe/navigation.test.mjs)
//   split  headers and "<!doctype html><html><head>" (enough to commit), then
//          <title> 800 ms later
// Prints one JSON line: per mode, how often title() read "slow page", "" or
// something else, and how long it took.
const http = await import("node:http");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRIALS = { whole: 30, split: 6 };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const head = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (url.pathname === "/start") {
    res.writeHead(200, head);
    return res.end(`<!doctype html><title>start</title><a id="go" style="display:block;font-size:40px" href="/${url.searchParams.get("mode")}?i=${url.searchParams.get("i")}">go</a>`);
  }
  if (url.pathname === "/whole") {
    await sleep(300);
    res.writeHead(200, head);
    return res.end(`<!doctype html><html><head><title>slow page</title></head><body><h1>slow document loaded</h1></body></html>`);
  }
  if (url.pathname === "/split") {
    await sleep(300);
    res.writeHead(200, head);
    res.write(`<!doctype html><html><head>` + " ".repeat(2048));
    await sleep(800);
    return res.end(`<title>slow page</title></head><body><h1>split</h1></body></html>`);
  }
  res.writeHead(404, head);
  res.end("no");
});
// Ego's embedded Node (stdin mode) resolves listen() only while a timer is
// pending (seen on the Mac): without one the script hangs about
// 100 s and the CLI exits 0 with no output.
const keepAlive = setInterval(() => {}, 20);
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const task = await taskSpace(`observe title probe ${Date.now()}`);
const out = {};
try {
  const page = await task.newPage();
  for (const [mode, n] of Object.entries(TRIALS)) {
    const seen = {};
    const ms = [];
    let wrongUrl = 0;
    for (let i = 0; i < n; i++) {
      await page.goto(`${base}/start?mode=${mode}&i=${i}`);
      await page.click("#go");
      const t0 = Date.now();
      const title = await page.title();
      ms.push(Date.now() - t0);
      const key = title === "slow page" ? "parsed" : title === "" ? "empty" : `other:${title}`;
      seen[key] = (seen[key] ?? 0) + 1;
      if (!(await page.url()).includes(`/${mode}?i=${i}`)) wrongUrl++;
    }
    ms.sort((a, b) => a - b);
    out[mode] = { trials: n, seen, wrongUrl, msMedian: ms[n >> 1], msMax: ms[n - 1] };
  }
} finally {
  await task.finish({ keep: [] }).catch(e => console.error("finish failed", e?.message));
  server.close();
}
clearInterval(keepAlive);
console.log(JSON.stringify(out));
