#!/usr/bin/env node
// Compares zenius snapshots with Ego's goldens (tests/golden/ego, see its
// README). For every fixture page and every live-site replay it loads the
// same URL from tests/fixtures/server.mjs at Ego's viewport size, takes the
// viewport and full_page snapshots, normalizes both sides and reports:
//
//   lines      Ego's line count / ours
//   struct     how many lines match in order (2·matched / (ego + ours)), by GNU diff
//   flat       the same with indentation ignored
//   refs       share of Ego's ref'd nodes (role, name, url) we also give a ref
//   locs       share of Ego's (node, locator) pairs we print the same
//   ms         our snapshot's round trip
//
// Ref numbers are dropped (they count across pages in the goldens), and so is
// the header's space name. Files land in --out for a closer look:
// <slug>.<scope>.ego.txt, .ours.txt and .diff.
//
//   node tests/snapshot/golden-diff.mjs [--instance zen-snapshot] [--only regex]
//        [--scope viewport|full_page] [--show 40] [--out dir] [--settle ms]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN = join(ROOT, "tests/golden/ego");

const { values: args } = parseArgs({
  options: {
    instance: { type: "string", default: process.env.ZENIUS_INSTANCE || "zen-snapshot" },
    only: { type: "string" },
    scope: { type: "string" },
    show: { type: "string", default: "0" },
    out: { type: "string", default: join(process.env.TMPDIR || tmpdir(), "zenius-golden-diff") },
    settle: { type: "string", default: "600" },
    debug: { type: "boolean", default: false },
    "no-prune": { type: "boolean", default: false },
    // JSON switches for the walker's fitting experiments, e.g. '{"apc":false}'.
    fit: { type: "string" },
  },
});
const show = Number(args.show);
mkdirSync(args.out, { recursive: true });

const index = JSON.parse(readFileSync(join(GOLDEN, "index.json"), "utf8"));
const only = args.only ? new RegExp(args.only) : null;
const entries = index.pages.filter(p => (p.kind === "fixture" || p.kind === "replay") && (!only || only.test(p.slug)));
const scopes = args.scope ? [args.scope] : ["viewport", "full_page"];

const client = await connect(args.instance);
const call = (method, params) => client.call(method, params);
const fixture = await startFixtureServer("zen-snapshot golden diff");
const base = fixture.baseUrl;
const cross = base.replace("127.0.0.1", "localhost");
const { id: space } = await call("spaces.create", { name: `snapshot golden diff ${Date.now()}` });

function placeholders(text) {
  return text
    .replaceAll(base, "{{BASE}}")
    .replaceAll(cross, "{{CROSS}}")
    .replaceAll(base.replace(/^https?:\/\//, ""), "{{BASE_HOST}}")
    .replaceAll(cross.replace(/^https?:\/\//, ""), "{{CROSS_HOST}}");
}

/** Lines to compare: header dropped, ref numbers dropped, truncated text shortened. */
function normalize(text) {
  return text
    .replace(/\n+$/, "")
    .split("\n")
    .slice(1)
    .map(line =>
      line
        .replace(/\bref=\d+/, "ref")
        // Gecko and Chromium lay text out a little differently, so page heights differ.
        .replace(/^(\[more content [a-z ]+ the viewport: )scrollY=\d+, viewport \d+ \/ page \d+ px/, "$1scrollY=…, viewport … / page … px")
        // Ego cuts long text mid-character; compare the start only.
        .replace(/(text|"[^"]*) "(.{0,60})[^"]*\.\.\."$/u, '$1 "$2…"')
    );
}

function refSignature(line) {
  const m = /^\s*(.*?) \[ref(?:, loc=(.*?))?(?:, url=(.*))?\]$/.exec(line);
  if (!m) return null;
  return { node: `${m[1]}${m[3] ? ` url=${m[3]}` : ""}`, loc: m[2] ?? "-" };
}

function multisetOverlap(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  let hit = 0;
  for (const x of a) {
    const n = counts.get(x) ?? 0;
    if (n) {
      hit++;
      counts.set(x, n - 1);
    }
  }
  return hit;
}

function diffCount(egoFile, oursFile) {
  const r = spawnSync("diff", ["--minimal", "-U0", egoFile, oursFile], { encoding: "utf8", maxBuffer: 1 << 28 });
  let minus = 0;
  let plus = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) minus++;
    else if (line.startsWith("+") && !line.startsWith("+++")) plus++;
  }
  return { minus, plus, text: r.stdout };
}

function compare(slug, scope, egoText, oursText) {
  const ego = normalize(egoText);
  const stem = join(args.out, `${slug}.${scope}`);
  const debugLines = normalize(placeholders(oursText));
  if (args.debug) writeFileSync(`${stem}.ours.debug.txt`, `${debugLines.join("\n")}\n`);
  const ours = debugLines.map(line => line.replace(/\u0007.*$/, ""));
  writeFileSync(`${stem}.ego.txt`, `${ego.join("\n")}\n`);
  writeFileSync(`${stem}.ours.txt`, `${ours.join("\n")}\n`);
  const trimmed = lines => `${lines.map(l => l.trim()).join("\n")}\n`;
  writeFileSync(`${stem}.ego.flat.txt`, trimmed(ego));
  writeFileSync(`${stem}.ours.flat.txt`, trimmed(ours));
  const d = diffCount(`${stem}.ego.txt`, `${stem}.ours.txt`);
  writeFileSync(`${stem}.diff`, d.text);
  const f = diffCount(`${stem}.ego.flat.txt`, `${stem}.ours.flat.txt`);
  const ratio = (minus, a, b) => (a + b ? (2 * (a - minus)) / (a + b) : 1);
  const egoRefs = ego.map(refSignature).filter(Boolean);
  const ourRefs = ours.map(refSignature).filter(Boolean);
  return {
    egoLines: ego.length,
    ourLines: ours.length,
    struct: ratio(d.minus, ego.length, ours.length),
    flat: ratio(f.minus, ego.length, ours.length),
    egoRefs: egoRefs.length,
    ourRefs: ourRefs.length,
    refs: egoRefs.length ? multisetOverlap(egoRefs.map(r => r.node), ourRefs.map(r => r.node)) / egoRefs.length : 1,
    locs: egoRefs.length ? multisetOverlap(egoRefs.map(r => `${r.node} ${r.loc}`), ourRefs.map(r => `${r.node} ${r.loc}`)) / egoRefs.length : 1,
    diff: d.text,
  };
}

async function ensureViewport(w, h) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const size = await call("dev.evalContent", { space, page: "p1", code: "[innerWidth, innerHeight]" });
    if (size[0] === w && size[1] === h) return true;
    await call("dev.evalChrome", { code: `win.resizeBy(${w - size[0]}, ${h - size[1]}); await new Promise(r => win.setTimeout(r, 200));` });
  }
  return false;
}

const pct = x => `${(100 * x).toFixed(1).padStart(5)}%`;
const rows = [];
console.log(`${"page".padEnd(40)} ${"scope".padEnd(9)} ${"lines".padStart(11)} struct   flat   refs   locs     ms`);
for (const entry of entries) {
  const url = entry.url.replaceAll("{{BASE}}", base).replaceAll("{{CROSS}}", cross);
  try {
    await call("page.goto", { space, page: "p1", url });
    if (!(await ensureViewport(entry.viewport.w, entry.viewport.h))) {
      console.log(`${entry.slug}: couldn't set the viewport to ${entry.viewport.w}x${entry.viewport.h}`);
    }
    await new Promise(r => setTimeout(r, Number(args.settle)));
  } catch (e) {
    console.log(`${entry.slug}: ${e.message}`);
    continue;
  }
  for (const scope of scopes) {
    const file = entry.files?.[scope];
    if (!file) continue;
    const egoText = readFileSync(join(GOLDEN, file), "utf8");
    let result;
    const t0 = performance.now();
    try {
      const options = {
        scope: scope === "viewport" ? "only_within_viewport" : scope,
        ...(args.debug ? { debug: true } : {}),
        ...(args["no-prune"] ? { prune: false } : {}),
        ...(args.fit ? { fit: JSON.parse(args.fit) } : {}),
      };
      result = await call("page.snapshot", { space, page: "p1", options });
    } catch (e) {
      console.log(`${entry.slug.padEnd(40)} ${scope.padEnd(9)} ERROR ${e.code ?? ""} ${e.message}`);
      continue;
    }
    const ms = performance.now() - t0;
    const r = compare(`${entry.slug}${entry.kind === "replay" ? ".replay" : ""}`, scope, egoText, result.text);
    rows.push({ ...r, ms });
    console.log(
      `${entry.slug.padEnd(40)} ${scope.padEnd(9)} ${`${r.egoLines}/${r.ourLines}`.padStart(11)} ${pct(r.struct)} ${pct(r.flat)} ${pct(r.refs)} ${pct(r.locs)} ${ms.toFixed(0).padStart(6)}`
    );
    if (show && r.diff) {
      console.log(r.diff.split("\n").slice(0, show).map(l => `    ${l}`).join("\n"));
    }
  }
}
if (rows.length) {
  const mean = key => rows.reduce((s, r) => s + r[key], 0) / rows.length;
  console.log(`${"mean".padEnd(40)} ${"".padEnd(9)} ${"".padStart(11)} ${pct(mean("struct"))} ${pct(mean("flat"))} ${pct(mean("refs"))} ${pct(mean("locs"))}`);
}
console.log(`files: ${args.out}`);
// Spaces persist across restarts; leave none behind.
await call("spaces.finish", { space, keep: [] }).catch(() => {});
client.close();
await closeFixtureServer(fixture.server);
