#!/usr/bin/env node
// Draw the README's Benchmarks chart from two bench runs: one row per operation, Ego Lite's
// median and zen(ius)'s on a log axis, and how many times faster zen(ius) is.
//
//   node tests/bench/chart.mjs docs/eval/bench-ego-0.6.3.17.json docs/eval/bench-zenius.json \
//     --out docs/assets/benchmarks --build "a pre-release build, 2026-11-21"
//
// --build names the zen(ius) build in the chart's subtitle and description. A commit hash would
// name nothing in the public repo, whose history is its own, so the chart never prints one.
//
// writes <out>.svg for GitHub's light theme and <out>-dark.svg for its dark one; the README
// picks one with <picture>. Each is drawn on its theme's page colour, because an SVG shown as
// an image can't follow the theme itself. The two series colours passed the dataviz palette
// check against those surfaces (adjacent-pair CVD ΔE ≥ 8, normal vision ≥ 15, contrast ≥ 3:1).
// Ego Lite is the de-emphasised gray on purpose: the chart is about zen(ius).

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// Takes an option and its value out of argv, so what's left are the two runs.
const option = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : (argv.splice(i, 2)[1] ?? "");
};
const outBase = option("--out");
const build = option("--build");
const [egoPath, zenPath] = argv;
if (!egoPath || !zenPath || !outBase || build === "") {
  console.error('usage: node tests/bench/chart.mjs <ego.json> <zenius.json> --out <base> [--build "<which build>"]');
  process.exit(2);
}
const ego = JSON.parse(readFileSync(egoPath, "utf8"));
const zen = JSON.parse(readFileSync(zenPath, "utf8"));
const egoByName = new Map(ego.results.map((r) => [r.name, r]));
const both = zen.results.filter((r) => egoByName.has(r.name));
const zenName = `zen(ius) ${zen.version}${build ? ` (${build})` : ""}`;

// The operations a task uses, in the order it uses them. The full table is
// docs/eval/bench-comparison.md; the footer says how many rows this leaves out.
const ROWS = [
  ["spawn-first-rpc", "Start a script, first call"],
  ["taskspace-create", "New task space"],
  ["goto-local", "Open a local page"],
  ["goto-real", "Open example.com (network)"],
  ["snapshot-typical", "Snapshot, typical page"],
  ["snapshot-huge", "Snapshot, huge page"],
  ["click", "Click"],
  ["fill", "Fill a field"],
  ["type-50", "Type 50 characters"],
  ["evaluate", "Evaluate JavaScript"],
  ["screenshot-viewport", "Screenshot, viewport"],
  ["wait-appears-200", "Wait for an element (200 ms)"],
  ["finish", "Finish a task"],
];
const rows = ROWS.map(([name, label]) => {
  const z = zen.results.find((r) => r.name === name);
  const e = egoByName.get(name);
  if (!z || !e) throw new Error(`no ${name} row in both runs`);
  return { label, zen: z.p50, ego: e.p50, ratio: e.p50 / z.p50 };
});
const faster = both.filter((r) => egoByName.get(r.name).p50 > r.p50).length;
const times = (x) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1)) + "×";
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : v >= 10 ? `${Math.round(v)} ms` : `${Number(v.toPrecision(2))} ms`);

// GitHub's own page, text and border colours for each theme.
const THEMES = {
  "": { bg: "#ffffff", ink: "#1f2328", ink2: "#59636e", muted: "#6e7781", grid: "#eaeef2", link: "#d1d9e0", ego: "#8c959f", zen: "#00846f" },
  "-dark": { bg: "#0d1117", ink: "#f0f6fc", ink2: "#9198a1", muted: "#7d8590", grid: "#21262d", link: "#3d444d", ego: "#5d6670", zen: "#2aa9a3" },
};
const W = 880, X0 = 322, X1 = 752, TOP = 122, STEP = 30;
const DECADES = [[0.1, "0.1 ms"], [1, "1 ms"], [10, "10 ms"], [100, "100 ms"], [1000, "1 s"], [10000, "10 s"]];
const LO = DECADES[0][0], HI = DECADES.at(-1)[0];
const x = (v) => X0 + (Math.log10(v / LO) / Math.log10(HI / LO)) * (X1 - X0);
for (const r of rows) {
  for (const v of [r.zen, r.ego]) if (v < LO || v > HI) throw new Error(`${r.label}: ${v} ms is off the axis`);
}
const yEnd = TOP + STEP * (rows.length - 1);
const H = yEnd + 84;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const desc =
  `A dot plot on a log scale of the median time of ${rows.length} operations an agent uses, ` +
  `for Ego Lite ${ego.version} and ${zenName}. zen(ius) was faster on ` +
  `${faster === both.length ? `all ${faster}` : `${faster} of the ${both.length}`} operations both runs timed. ` +
  rows.map((r) => `${r.label}: Ego Lite ${ms(r.ego)}, zen(ius) ${ms(r.zen)}, ${times(r.ratio)} faster.`).join(" ");

for (const [suffix, c] of Object.entries(THEMES)) {
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="${FONT}">`);
  out.push(`<title id="t">Median time of each operation: zen(ius) against Ego Lite</title>`);
  out.push(`<desc id="d">${esc(desc)}</desc>`);
  out.push(`<rect width="${W}" height="${H}" fill="${c.bg}"/>`);
  out.push(`<text x="24" y="38" font-size="17" font-weight="600" fill="${c.ink}">Median time of each operation (log scale)</text>`);
  out.push(`<text x="24" y="61" font-size="13" fill="${c.ink2}">${esc(`Ego Lite ${ego.version} and ${zenName}, the same bench on the same Mac. Lower is faster.`)}</text>`);
  out.push(`<circle cx="30" cy="88" r="5" fill="${c.zen}"/><text x="42" y="92.5" font-size="13" fill="${c.ink}">zen(ius)</text>`);
  out.push(`<circle cx="116" cy="88" r="5" fill="${c.ego}"/><text x="128" y="92.5" font-size="13" fill="${c.ink}">Ego Lite</text>`);
  out.push(`<text x="856" y="${TOP - 20}" font-size="12" fill="${c.muted}" text-anchor="end">times faster</text>`);
  for (const [v, label] of DECADES) {
    const gx = x(v).toFixed(1);
    out.push(`<line x1="${gx}" y1="${TOP - 14}" x2="${gx}" y2="${yEnd + 14}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${gx}" y="${yEnd + 36}" font-size="12" fill="${c.muted}" text-anchor="middle">${label}</text>`);
  }
  rows.forEach((r, i) => {
    const y = TOP + STEP * i, xz = x(r.zen), xe = x(r.ego);
    // Two medians this close would put one dot on the other: move each 4 px off the row.
    const apart = Math.abs(xe - xz) < 10 ? 4 : 0;
    out.push(`<text x="${X0 - 18}" y="${y + 4.5}" font-size="13" fill="${c.ink}" text-anchor="end">${esc(r.label)}</text>`);
    out.push(`<line x1="${xz.toFixed(1)}" y1="${y}" x2="${xe.toFixed(1)}" y2="${y}" stroke="${c.link}" stroke-width="2" stroke-linecap="round"/>`);
    out.push(`<circle cx="${xe.toFixed(1)}" cy="${y - apart}" r="5" fill="${c.ego}" stroke="${c.bg}" stroke-width="2"/>`);
    out.push(`<circle cx="${xz.toFixed(1)}" cy="${y + apart}" r="5.5" fill="${c.zen}" stroke="${c.bg}" stroke-width="2"/>`);
    out.push(`<text x="856" y="${y + 4.5}" font-size="13" font-weight="600" fill="${c.ink}" text-anchor="end" style="font-variant-numeric: tabular-nums">${times(r.ratio)}</text>`);
    // The legend is above, but naming the dots on the first row saves a look up.
    if (i === 0) {
      out.push(`<text x="${(xz - 11).toFixed(1)}" y="${y + 4}" font-size="11" fill="${c.muted}" text-anchor="end">zen(ius)</text>`);
      out.push(`<text x="${(xe + 11).toFixed(1)}" y="${y + 4}" font-size="11" fill="${c.muted}">Ego Lite</text>`);
    }
  });
  out.push(`<text x="24" y="${H - 16}" font-size="12" fill="${c.muted}">${esc(`${rows.length} of the ${both.length} operations both runs timed; zen(ius) was faster on all ${faster}. The median of ${zen.iterations} timed runs of each.`)}</text>`);
  out.push(`</svg>`);
  writeFileSync(`${outBase}${suffix}.svg`, out.join("\n") + "\n");
}
console.log(`${outBase}.svg, ${outBase}-dark.svg: ${rows.length} rows; faster on ${faster} of ${both.length}`);
