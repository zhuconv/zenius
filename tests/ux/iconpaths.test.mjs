// No Nucleo icon in zenius. Zen's search-glass.svg and sparkles.svg are
// Nucleo icons, whose license forbids passing them on, so no file under
// runtime/ may carry their path data. '>''s "Ask agent" icon reads the
// installed Zen's glass at run time and draws stars of zenius's own
// (runtime/JS/agent-urlbar/AgentUrlbar.sys.mjs).
//
// Their path data isn't in this test either. It reads the installed Zen's
// icons now, and knows the copy that was once in runtime/ (Zen 1.24.3b's, as
// the Mac's Zen.app ships them) only by fingerprints: a hash of each
// subpath's numbers. A copy is found by its numbers in order, however they
// are written.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const ICONS = ["chrome://browser/skin/zen-icons/search-glass.svg", "chrome://browser/skin/zen-icons/sparkles.svg"];
/** Zen 1.24.3b's glass (two subpaths) and the large star of its sparkles: the first of each one's numbers, how many, and the SHA-256 of them all joined by ",". */
const FINGERPRINTS = [
  { what: "1.24.3b search-glass.svg, outline", first: "1.569", count: 54, sha256: "4a6480548e30fe333c0060a893c58968722082de6b0ef60a02a898153166d59a" },
  { what: "1.24.3b search-glass.svg, lens", first: "3.136", count: 26, sha256: "f6f0239a3caca44d1a603074f29c3c399f11b70db4df64413a9358b248f41cbd" },
  { what: "1.24.3b sparkles.svg, large star", first: "9.994", count: 74, sha256: "b1f551af047bc13ebcc08e7c41d36ae3396739f64707a3c7115fe438948a815a" },
];

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
/** The numbers in `text`, in order, each as Number() writes it. */
const numbers = text => (text.match(NUMBER) ?? []).map(x => String(Number(x)));
const sha256 = list => createHash("sha256").update(list.join(",")).digest("hex");
/** Each subpath's numbers; a run this long can't be chance. */
const subpaths = d =>
  d
    .split(/(?=[Mm])/)
    .map(numbers)
    .filter(n => n.length >= 8);

/**
 * What of `needles` the numbers `haystack` hold, each needle's numbers in a
 * row: this Zen's subpaths (`live`) or fingerprints (`prints`).
 */
function finds(haystack, { live = [], prints = [] }) {
  const hits = new Set();
  for (let i = 0; i < haystack.length; i++) {
    for (const n of live) {
      if (haystack[i] === n.list[0] && i + n.list.length <= haystack.length && n.list.every((v, k) => haystack[i + k] === v)) {
        hits.add(n.what);
      }
    }
    for (const p of prints) {
      if (haystack[i] === p.first && i + p.count <= haystack.length && sha256(haystack.slice(i, i + p.count)) === p.sha256) {
        hits.add(p.what);
      }
    }
  }
  return [...hits];
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

let h;
/** This Zen's icons' subpaths, read at run time. */
let live = [];

before(async () => {
  h = await setup();
  const paths = await h.chrome(`
    const out = {};
    for (const url of ${JSON.stringify(ICONS)}) {
      const text = await (await win.fetch(url)).text();
      const doc = new win.DOMParser().parseFromString(text, "image/svg+xml");
      out[url] = [...doc.querySelectorAll("path")].map(p => p.getAttribute("d") ?? "");
    }
    return out;
  `);
  live = Object.entries(paths).flatMap(([url, ds]) =>
    ds.flatMap(subpaths).map((list, i) => ({ what: `this Zen's ${url.split("/").pop()}, subpath ${i + 1}`, list }))
  );
});

after(async () => {
  await h?.close();
});

test("no file under runtime/ carries the path data of Zen's search glass or sparkles (Nucleo icons): neither this Zen's, read now, nor 1.24.3b's, by fingerprint", () => {
  assert.ok(live.some(n => n.what.includes("search-glass")) && live.some(n => n.what.includes("sparkles")), "this Zen's icons were read");
  // The finder finds a copy, however it's written.
  const planted = live.map(n => n.list.map(v => (v.startsWith("0.") ? v.slice(1) : v)).join(", ")).join("\n");
  assert.equal(finds(numbers(planted), { live }).length, live.length, "the finder finds this Zen's paths in a copy");
  const found = {};
  for (const path of files(join(repo, "runtime"))) {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) {
      continue;
    }
    const hits = finds(numbers(bytes.toString("utf8")), { live, prints: FINGERPRINTS });
    if (hits.length) {
      found[relative(repo, path)] = hits;
    }
  }
  assert.deepEqual(found, {}, "path data of Nucleo icons under runtime/");
});

test("'>''s icon is built at run time: its rim is this Zen's own glass, read now, and its stars are zenius's own", async () => {
  const out = await h.chrome(`
    const { AgentUrlbar } = ChromeUtils.importESModule("chrome://userscripts/content/agent-urlbar/AgentUrlbar.sys.mjs");
    const icons = await AgentUrlbar.loadIcons();
    const svg = url => decodeURIComponent(url.slice(url.indexOf(",") + 1));
    return { light: svg(icons.light), dark: svg(icons.dark) };
  `);
  const glass = live.filter(n => n.what.includes("search-glass"));
  const sparkles = live.filter(n => n.what.includes("sparkles"));
  // Only the sparkles' prints count here. The rim is this Zen's glass by
  // design, and on a Zen whose glass is the fingerprinted one (the Mac's
  // 1.24.3b) the glass's prints are the rim. The scan of runtime/ above still
  // looks for all of them.
  const stars = FINGERPRINTS.filter(p => p.what.includes("sparkles"));
  assert.ok(stars.length > 0, "the sparkles' prints");
  for (const [scheme, svg] of Object.entries(out)) {
    const n = numbers(svg);
    assert.equal(finds(n, { live: glass }).length, glass.length, `${scheme}: the rim is this Zen's glass`);
    assert.deepEqual(finds(n, { live: sparkles, prints: stars }), [], `${scheme}: no star of Zen's sparkles`);
  }
});
