#!/usr/bin/env node
// Capture golden snapshots (viewport and full_page) of fixture pages and live
// sites on one target, into tests/golden/<target>/.
//
//   node tests/golden/capture.mjs --target ego [--only slug,slug] [--no-sites] [--no-fixtures] [--no-replay]
//   node tests/golden/capture.mjs --target zenius --instance zen-eval
//
// Ego runs also save each live site's rendered DOM (scripts stripped, <base>
// added) to ego/dom/<slug>.html.gz, then snapshot that static replay from the
// fixture server, so zenius can be compared on identical input later.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";
import { parseTarget, REPO_ROOT, runScript, targetVersion } from "../lib/targets.mjs";
import { FIXTURE_PAGES, SITE_PAGES } from "./pages.mjs";
import { scrubDom } from "./scrub.mjs";

const argv = process.argv;
const opts = parseTarget(argv);
const flag = (name) => argv.includes(name);
const onlyArg = argv.indexOf("--only");
const only = onlyArg > 0 ? new Set(argv[onlyArg + 1].split(",")) : null;
const outDir = join(REPO_ROOT, "tests", "golden", opts.target);
const domDir = join(REPO_ROOT, "tests", "golden", "ego", "dom");

const SETTLE_FIXTURE_MS = 300;
const SETTLE_SITE_MS = 2500;

// Runs in the page. Serializes the rendered DOM with open shadow roots as
// declarative shadow DOM, drops scripts and CSP/refresh metas, and pins the
// base URL so relative links and stylesheets still resolve.
const DUMP_DOM = `() => {
  const roots = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll("*")) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
    }
  };
  walk(document);
  const html = document.documentElement;
  let inner = typeof html.getHTML === "function"
    ? html.getHTML({ serializableShadowRoots: true, shadowRoots: roots })
    : html.innerHTML;
  inner = inner
    .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, "")
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)["']?[^>]*>/gi, "")
    .replace(/<base\\b[^>]*>/gi, "");
  const base = '<base href="' + document.baseURI.replace(/"/g, "&quot;") + '">';
  inner = /<head\\b[^>]*>/i.test(inner)
    ? inner.replace(/<head\\b[^>]*>/i, (m) => m + base)
    : "<head>" + base + "</head>" + inner;
  const attrs = [...html.attributes].map((a) => a.name + '="' + a.value.replace(/"/g, "&quot;") + '"').join(" ");
  return "<!doctype html>\\n<html " + attrs + ">" + inner + "</html>";
}`;

function pageScript({ spaceId, url, settleMs, dump, resultPath }) {
  return `
const { writeFile } = await import("node:fs/promises");
const out = { startedAt: new Date().toISOString() };
// A live site can raise a permission prompt (craigslist asks for location),
// which hands the space to the user. Take it back so the next page can run.
const entry = (await listTaskSpaces()).find((s) => s.id === ${spaceId});
const task = entry?.ownership === "agentDelegatedToUser"
  ? await takeOverTaskSpace(${spaceId})
  : await taskSpace(${spaceId});
if (entry?.ownership === "agentDelegatedToUser") out.tookOver = true;
const page = task.page("p1");
let t = Date.now();
for (let attempt = 0; attempt < 2; attempt++) {
  out.gotoError = undefined;
  try {
    await page.goto(${JSON.stringify(url)}, { timeout: 30000 });
  } catch (error) {
    out.gotoError = String(error?.message || error);
  }
  // Chromium shows an error page for transient network failures
  // (ERR_SOCKET_NOT_CONNECTED was seen); retry once.
  const errorPage = await page.evaluate(() => !!document.querySelector("#main-frame-error, body.neterror")).catch(() => false);
  if (!errorPage) break;
  out.netErrorRetry = (out.netErrorRetry || 0) + 1;
  await page.waitForTimeout(2000);
}
out.gotoMs = Date.now() - t;
await page.waitForTimeout(${settleMs});
out.info = await page.info().catch((error) => ({ error: String(error?.message || error) }));
out.finalUrl = await page.url().catch(() => null);
out.title = await page.title().catch(() => null);
for (const [key, options] of [["viewport", {}], ["full_page", { scope: "full_page" }]]) {
  t = Date.now();
  try {
    out[key] = await page.snapshot(options);
    out[key + "Ms"] = Date.now() - t;
  } catch (error) {
    out[key + "Error"] = String(error?.message || error);
  }
}
${dump ? `try { out.dom = await page.evaluate(${DUMP_DOM}); } catch (error) { out.domError = String(error?.message || error); }` : ""}
await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(out));
console.log("captured", ${JSON.stringify(url)});
`;
}

async function run(source, timeoutMs = 120_000) {
  const result = await runScript(source, { ...opts, timeoutMs });
  if (result.code !== 0) {
    const error = new Error(`script exited ${result.code}: ${(result.stderr || result.stdout).slice(-800)}`);
    error.result = result;
    throw error;
  }
  return result;
}

const { server, baseUrl } = await startFixtureServer("golden-capture");
const crossUrl = baseUrl.replace("127.0.0.1", "localhost");
const baseHost = baseUrl.replace("http://", "");
const crossHost = crossUrl.replace("http://", "");
// Untitled pages show a scheme-less host:port in the header line.
const normalize = (text) =>
  typeof text === "string"
    ? text
        .replaceAll(baseUrl, "{{BASE}}")
        .replaceAll(crossUrl, "{{CROSS}}")
        .replaceAll(baseHost, "{{BASE_HOST}}")
        .replaceAll(crossHost, "{{CROSS_HOST}}")
    : text;

const jobs = [];
if (!flag("--no-fixtures")) {
  for (const p of FIXTURE_PAGES) jobs.push({ ...p, kind: "fixture", url: baseUrl + p.path, settleMs: SETTLE_FIXTURE_MS });
}
if (!flag("--no-sites")) {
  for (const p of SITE_PAGES) jobs.push({ ...p, kind: "site", settleMs: SETTLE_SITE_MS, dump: opts.target === "ego" });
}
const selected = only ? jobs.filter((j) => only.has(j.slug)) : jobs;

const tmp = await mkdtemp(join(tmpdir(), "zen-eval-golden-"));
await mkdir(outDir, { recursive: true });
await mkdir(domDir, { recursive: true });
const version = await targetVersion(opts);
const records = [];
let spaceId = null;

async function capture(job, kind, url) {
  const resultPath = join(tmp, `${job.slug}-${kind}.json`);
  const started = Date.now();
  try {
    await run(pageScript({ spaceId, url, settleMs: job.settleMs, dump: job.dump && kind === "live", resultPath }));
    const out = JSON.parse(await readFile(resultPath, "utf8"));
    const suffix = kind === "replay" ? ".replay" : "";
    const files = {};
    for (const scope of ["viewport", "full_page"]) {
      if (typeof out[scope] !== "string") continue;
      const name = `${job.slug}${suffix}.${scope}.txt`;
      await writeFile(join(outDir, name), normalize(out[scope]).replace(/\n?$/, "\n"));
      files[scope] = name;
    }
    if (out.dom) await writeFile(join(domDir, `${job.slug}.html.gz`), gzipSync(scrubDom(out.dom), { level: 9 }));
    const record = {
      slug: job.slug,
      kind: kind === "replay" ? "replay" : job.kind,
      url: normalize(url),
      finalUrl: normalize(out.finalUrl),
      title: out.title,
      why: job.why,
      capturedAt: out.startedAt,
      gotoMs: out.gotoMs,
      gotoError: out.gotoError,
      viewport: out.info && { w: out.info.w, h: out.info.h, pw: out.info.pw, ph: out.info.ph },
      snapshotMs: { viewport: out.viewportMs, full_page: out.full_pageMs },
      bytes: { viewport: out.viewport?.length, full_page: out.full_page?.length },
      errors: [out.viewportError, out.full_pageError, out.domError].filter(Boolean),
      files,
      dom: out.dom ? `dom/${job.slug}.html.gz` : undefined,
    };
    records.push(record);
    console.log(`${kind.padEnd(6)} ${job.slug.padEnd(40)} ${String(Date.now() - started).padStart(6)} ms  vp ${record.bytes.viewport ?? "-"} B  full ${record.bytes.full_page ?? "-"} B${record.errors.length ? "  ERR " + record.errors.join("; ") : ""}`);
  } catch (error) {
    records.push({ slug: job.slug, kind, url: normalize(url), error: String(error.message).slice(0, 500) });
    console.log(`${kind.padEnd(6)} ${job.slug.padEnd(40)} FAILED ${String(error.message).slice(0, 300)}`);
  }
}

try {
  const created = await run(`
const task = await taskSpace("zen-eval golden ${Date.now()}");
console.log("SPACE=" + task.spaceId);
`);
  const createdOut = created.stdout + created.stderr;
  spaceId = Number(/SPACE=(\d+)/.exec(createdOut)?.[1]);
  if (!spaceId) throw new Error("no space id in " + createdOut);

  for (const job of selected) await capture(job, "live", job.url);
  if (opts.target === "ego" ? !flag("--no-replay") : !flag("--no-replay")) {
    for (const job of selected.filter((j) => j.kind === "site")) {
      const replayUrl = `${baseUrl}/golden-replay/${job.slug}.html`;
      const exists = await fetch(replayUrl).then((r) => r.ok).catch(() => false);
      if (exists) await capture({ ...job, settleMs: 1500 }, "replay", replayUrl);
    }
  }
} finally {
  if (spaceId) {
    await run(`const task = await taskSpace(${spaceId}); console.log(JSON.stringify(await task.finish({ keep: [] })));`, 30_000)
      .then((r) => console.log("finished space", spaceId, (r.stdout + r.stderr).trim().split("\n").pop()))
      .catch((error) => console.error("FINISH FAILED for space", spaceId, error.message));
  }
  await closeFixtureServer(server);
  await rm(tmp, { recursive: true, force: true });
}

// Merge into the existing index so partial (--only) runs keep other records.
const indexPath = join(outDir, "index.json");
let index = { pages: [] };
try {
  index = JSON.parse(await readFile(indexPath, "utf8"));
} catch {}
const key = (r) => `${r.slug}|${r.kind}`;
const merged = new Map(index.pages.map((r) => [key(r), r]));
for (const r of records) merged.set(key(r), r);
index = {
  target: opts.target,
  version: version.version,
  versionDetail: version.detail,
  updatedAt: new Date().toISOString(),
  placeholders: {
    "{{BASE}}": "fixture server origin, http://127.0.0.1:<port> (tests/fixtures/server.mjs)",
    "{{CROSS}}": "the same server as http://localhost:<port>, a different site for OOPIF tests",
    "{{BASE_HOST}}": "127.0.0.1:<port>, as untitled pages show it in the header line",
    "{{CROSS_HOST}}": "localhost:<port>",
  },
  pages: [...merged.values()].sort((a, b) => key(a).localeCompare(key(b))),
};
await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
const failed = records.filter((r) => r.error || r.errors?.length);
console.log(`\n${records.length} captures, ${failed.length} with errors; index ${indexPath}`);
