#!/usr/bin/env node
// Render bench results as Markdown for docs/eval/.
//
//   node tests/bench/report.mjs baseline <bench.json> --out docs/eval/bench-ego-0.6.3.17.md
//   node tests/bench/report.mjs compare <ego.json> <zenius.json> [--notes <md>] --out docs/eval/bench-comparison.md

import { readFile, writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const mode = argv[0];
const outIndex = argv.indexOf("--out");
const outPath = outIndex > 0 ? argv[outIndex + 1] : null;
const notesIndex = argv.indexOf("--notes");
const notesPath = notesIndex > 0 ? argv[notesIndex + 1] : null;
const VALUE_FLAGS = ["--out", "--notes"];
const files = argv.slice(1).filter((a, i, all) => !VALUE_FLAGS.includes(a) && !VALUE_FLAGS.includes(all[i - 1]));

const ms = (v) => (typeof v === "number" ? (v >= 100 ? v.toFixed(0) : v.toFixed(1)) : "–");
const GROUPS = [
  ["process", "Process"],
  ["spaces", "Task spaces"],
  ["navigation", "Navigation"],
  ["snapshot", "Snapshot"],
  ["actions", "Actions"],
  ["screenshot", "Screenshot"],
  ["waits", "Waits"],
  ["baseline", "Round-trip floor"],
  ["cold", "First call in a new process"],
  ["motion", "Cursor motion"],
];

// SPEC §5 targets, keyed by bench name.
const TARGETS = {
  "spawn-first-rpc": "≤ 80 ms",
  "snapshot-typical": "≤ 60 ms",
  "snapshot-large": "≤ 134 ms",
  "screenshot-viewport": "≤ 300 ms",
};

function table(results, group) {
  const rows = results.filter((r) => r.group === group);
  if (!rows.length) return [];
  const lines = ["| Operation | p50 ms | p95 ms | mean | min | max | n | Note |", "|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    if (r.error) {
      lines.push(`| ${r.label} | error | | | | | | ${String(r.error).replace(/\|/g, "\\|").slice(0, 160)} |`);
      continue;
    }
    const notes = [];
    if (r.bytes) notes.push(`${(r.bytes / 1024).toFixed(1)} KiB of text`);
    if (r.resume) notes.push(`taskSpace(id) resume p50 ${ms(r.resume.p50)} ms; process wall p50 ${ms(r.wall?.p50)} ms`);
    if (TARGETS[r.name]) notes.push(`SPEC target ${TARGETS[r.name]}`);
    lines.push(`| ${r.label} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.mean)} | ${ms(r.min)} | ${ms(r.max)} | ${r.n} | ${notes.join("; ")} |`);
  }
  return lines;
}

function motionSection(results) {
  const rows = results.filter((r) => r.group === "motion" && r.timeline);
  if (!rows.length) return [];
  const lines = [
    "Each timed call is matched with the page-side input events it caused (the bench fixture logs",
    "pointer, click, key and wheel events with wall-clock times). *Before input* runs from the SDK call",
    "to the first input event (resolve, actionability, cursor), *input span* from the first input",
    "event to `click`, *after click* from `click` to the call returning. The columns are means, so",
    "they add up to the call's mean; times have 1 ms resolution.",
    "",
    "| Variant | call mean | before input | input span | after click | pointermoves per click | all trusted |",
    "|---|---|---|---|---|---|---|",
  ];
  // Page and SDK clocks both have 1 ms resolution, so -1 means "at once".
  const mean = (s) => (typeof s?.mean === "number" ? ms(Math.max(0, s.mean)) : "–");
  for (const r of rows) {
    const t = r.timeline;
    const moves = t.moves ? (t.moves.min === t.moves.max ? String(t.moves.min) : `${t.moves.min}–${t.moves.max}`) : "–";
    lines.push(
      `| ${r.label} | ${ms(r.mean)} | ${mean(t.beforeInput)} | ${mean(t.inputSpan)} | ${mean(t.afterClick)} | ${moves} | ${t.allTrusted ? "yes" : "no"} |`,
    );
  }
  return lines;
}

async function baseline() {
  const doc = JSON.parse(await readFile(files[0], "utf8"));
  const name = doc.target === "ego" ? "Ego Lite" : "zenius";
  const lines = [
    `# Bench: ${name} ${doc.version}`,
    "",
    `${doc.versionDetail}. Run ${doc.startedAt.slice(0, 16).replace("T", " ")} UTC on the user's Mac (${doc.machine.platform} ${doc.machine.arch}), ` +
      `${doc.iterations} iterations per operation after ${doc.warmup} warm-up iterations, with the task space in the background as agents use it.`,
    "",
    "```sh",
    `node tests/bench/bench.mjs --target ${doc.target}${doc.target === "zenius" ? " --instance <name>" : ""}`,
    "```",
    "",
    "Warm operations run in a loop inside one script, the way an agent chains actions within a round.",
    "\"First call in a new process\" spawns one CLI process per sample and times its first call after",
    "`taskSpace(id)`, which is what each agent round pays first. Local pages come from",
    "`tests/fixtures/server.mjs`: `/zoo/bench.html`, and the GitHub and Wikipedia replays of",
    "`tests/golden/ego/dom/`, so both targets snapshot the same input.",
    "",
  ];
  if (notesPath) lines.push((await readFile(notesPath, "utf8")).trim(), "");
  for (const [group, title] of GROUPS) {
    if (group === "motion") continue;
    const t = table(doc.results, group);
    if (t.length) lines.push(`## ${title}`, "", ...t, "");
  }
  const motion = table(doc.results, "motion");
  if (motion.length) lines.push("## Cursor motion", "", ...motion, "", ...motionSection(doc.results), "");
  return lines.join("\n");
}

async function compare() {
  const [a, b] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
  const byName = new Map(b.results.map((r) => [r.name, r]));
  const lines = [
    `# Bench comparison: Ego Lite ${a.version} vs zenius ${b.version}`,
    "",
    `Ego run ${a.startedAt}, zenius run ${b.startedAt} (${b.versionDetail}). Ratio below 1 means zenius is faster.`,
    "",
    "| Operation | Ego p50 | zenius p50 | ratio | Ego p95 | zenius p95 |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of a.results) {
    const z = byName.get(r.name);
    const ratio = z && !z.error && r.p50 ? (z.p50 / r.p50).toFixed(2) : "–";
    lines.push(`| ${r.label} | ${ms(r.p50)} | ${z?.error ? "error" : ms(z?.p50)} | ${ratio} | ${ms(r.p95)} | ${z?.error ? "" : ms(z?.p95)} |`);
  }
  lines.push("", "Times in ms. A dash means the zenius run didn't include that row.", "");
  if (notesPath) lines.push((await readFile(notesPath, "utf8")).trim(), "");
  return lines.join("\n");
}

const text = mode === "compare" ? await compare() : await baseline();
if (outPath) {
  await writeFile(outPath, text);
  console.log(`wrote ${outPath}`);
} else {
  process.stdout.write(text);
}
