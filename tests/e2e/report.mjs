#!/usr/bin/env node
// Render e2e results as Markdown for docs/eval/.
//
//   node tests/e2e/report.mjs baseline <results.json> [more runs…] --out docs/eval/baseline-ego-0.6.3.17.md
//   node tests/e2e/report.mjs compare <ego.json> <zenius.json> --out docs/eval/e2e-comparison.md
//
// With several runs of one target, a case counts as passing when it passed in
// every run; cases that passed in some runs are listed as flaky.

import { readFile, writeFile } from "node:fs/promises";

import { MANIFEST, countsForRubric } from "./manifest.mjs";
import { ZENIUS_ADAPTATIONS, ZENIUS_FIXTURE_READS } from "./zen-adapt.mjs";

const argv = process.argv.slice(2);
const mode = argv[0];
const outIndex = argv.indexOf("--out");
const outPath = outIndex > 0 ? argv[outIndex + 1] : null;
const notesIndex = argv.indexOf("--notes");
const notesPath = notesIndex > 0 ? argv[notesIndex + 1] : null;
const jsonIndex = argv.indexOf("--json");
const jsonPath = jsonIndex > 0 ? argv[jsonIndex + 1] : null;
const VALUE_FLAGS = ["--out", "--notes", "--json"];
const files = argv.slice(1).filter((a, i, all) => !VALUE_FLAGS.includes(a) && !VALUE_FLAGS.includes(all[i - 1]));

const seconds = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "");
// Machine paths say nothing useful in a report and name the user's account.
export const sanitize = (text) =>
  String(text ?? "")
    .replace(/\/(private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T\//g, "$TMPDIR/")
    .replace(/\/Users\/[^/\s]+\//g, "~/");
const escape = (text) => sanitize(text).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 220);

/** Merge runs of one target into one row per case. */
export function mergeRuns(runs) {
  const byName = new Map();
  for (const run of runs) {
    for (const c of run.cases) {
      const row = byName.get(c.name) || { ...c, runs: [] };
      row.runs.push({ status: c.status, durationMs: c.durationMs, message: c.message, assertions: c.assertions });
      byName.set(c.name, row);
    }
  }
  for (const row of byName.values()) {
    const statuses = row.runs.map((r) => r.status);
    const ran = statuses.filter((s) => s === "pass" || s === "fail");
    row.verdict = statuses.every((s) => s === "na") ? "na"
      : statuses.every((s) => s === "differs") ? "differs"
      : statuses.every((s) => s === "skip") ? "skip"
      : ran.length && ran.every((s) => s === "pass") ? "pass"
      : ran.some((s) => s === "pass") ? "flaky"
      : "fail";
    const times = row.runs.filter((r) => r.status === "pass").map((r) => r.durationMs).sort((a, b) => a - b);
    const mid = times.length >> 1;
    row.medianMs = !times.length ? undefined : times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
    row.lastFailure = [...row.runs].reverse().find((r) => r.status === "fail")?.message;
    row.assertions = Math.max(...row.runs.map((r) => r.assertions || 0));
  }
  return [...byName.values()];
}

function countBy(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1;
  return out;
}

function rubricRows(rows) {
  return rows.filter((r) => countsForRubric(r.name));
}

function describeRuns(runs) {
  const full = runs.filter((r) => !r.cases.some((c) => c.status === "skip"));
  const partial = runs.length - full.length;
  const when = runs.map((r) => r.startedAt.slice(0, 16).replace("T", " ")).join(", ");
  return `${full.length} full run${full.length === 1 ? "" : "s"}${partial ? ` and ${partial} partial run${partial === 1 ? "" : "s"}` : ""}, started ${when}`;
}

/** Failing cases grouped by the first method the target lacked, most first. */
export function missingMethods(rows) {
  const byMethod = new Map();
  for (const r of rows) {
    if (r.verdict !== "fail") continue;
    const method = /unknown method ([\w.]+)/.exec(r.lastFailure ?? "")?.[1];
    if (!method) continue;
    byMethod.set(method, [...(byMethod.get(method) ?? []), r.name]);
  }
  return [...byMethod].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

// The eval harness's own cases (tests/e2e/zen-cases/) are reported apart from Ego's 83.
const isZenEvalCase = (name) => name.startsWith("zen-eval:");

/** The merged runs without the cases' raw output, safe to commit. */
function compactResults(runs, allRows) {
  const first = runs[0];
  return {
    target: first.target,
    version: first.version,
    versionDetail: first.versionDetail,
    sdk: first.sdk,
    runs: runs.map((r) => ({ startedAt: r.startedAt, totalMs: r.totalMs, summary: r.summary })),
    cases: allRows.map((r) => {
      const [file, category, zenius, reason] = MANIFEST[r.name] || [r.file, "?", "run", ""];
      return {
        name: r.name,
        file,
        category,
        zenius,
        ...(reason ? { reason } : {}),
        verdict: r.verdict,
        medianMs: r.medianMs,
        assertions: r.assertions,
        runs: r.runs.map((x) => ({ status: x.status, durationMs: x.durationMs, assertions: x.assertions, ...(x.message ? { message: sanitize(x.message) } : {}) })),
      };
    }),
  };
}

async function baseline() {
  const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
  const first = runs[0];
  const allRows = mergeRuns(runs);
  const rows = allRows.filter((r) => !isZenEvalCase(r.name));
  const extraRows = allRows.filter((r) => isZenEvalCase(r.name));
  if (jsonPath) await writeFile(jsonPath, JSON.stringify(compactResults(runs, allRows), null, 1) + "\n");
  const counts = countBy(rows, "verdict");
  const rubric = rubricRows(rows);
  const rubricCounts = countBy(rubric, "verdict");
  const lines = [];
  lines.push(
    first.target === "ego"
      ? `# e2e baseline: Ego Lite ${first.version}`
      : `# e2e on zenius ${first.version} (${/commit (\w+)/.exec(first.versionDetail ?? "")?.[1] ?? "?"})`,
  );
  lines.push("");
  lines.push(
    `Ego's real-browser e2e suite (83 cases, tag v2.2.1), ported to \`tests/e2e\` and run on ${first.target === "ego" ? "the installed Ego Lite" : "zenius"} ` +
      `(${first.versionDetail}; SDK: ${first.sdk}). ${describeRuns(runs)} UTC, ` +
      (first.target === "ego"
        ? `on the user's Mac with its task spaces in Ego's background Spaces, as agents use it.`
        : `on the user's Mac against a headless dev instance.`),
  );
  lines.push("");
  lines.push("```sh");
  lines.push(`node tests/e2e/runner.mjs --target ${first.target}${first.target === "zenius" ? " --instance <name>" : ""}`);
  lines.push("```");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| | Cases | Pass | Flaky | Fail | N/A | Deliberate difference |");
  lines.push("|---|---|---|---|---|---|---|");
  lines.push(`| All cases | ${rows.length} | ${counts.pass || 0} | ${counts.flaky || 0} | ${counts.fail || 0} | ${counts.na || 0} | ${counts.differs || 0} |`);
  lines.push(`| Rubric A (neither N/A nor a deliberate difference on zenius) | ${rubric.length} | ${rubricCounts.pass || 0} | ${rubricCounts.flaky || 0} | ${rubricCounts.fail || 0} | | |`);
  lines.push("");
  const differs = Object.entries(MANIFEST).filter(([name, [, , zenius]]) => zenius === "differs" && !isZenEvalCase(name)).map(([name]) => name);
  lines.push(
    "Rubric A counts the cases `tests/e2e/manifest.mjs` doesn't mark N/A for zenius: it leaves out the 12 cases that " +
      "exercise Ego's legacy v1 helpers (not in skill guide v2.2.1), the 2 that test CDP itself and the one that drives " +
      "Chromium's PDF viewer. " +
      (differs.length
        ? `It also leaves out ${differs.length === 1 ? "the case" : `the ${differs.length} cases`} where zenius refuses what is tested on purpose ` +
          `(${differs.map((n) => `"${escape(n)}"`).join(", ")}; see below). `
        : "") +
      "Flaky means the case passed in some runs and failed in others.",
  );
  lines.push("");
  if (extraRows.length) {
    lines.push("The cases zenius adds (`tests/e2e/zen-cases/`), outside Ego's suite and its counts:");
    lines.push("");
    for (const r of extraRows) lines.push(`- **${r.name}**: ${r.verdict}${r.assertions ? `, ${r.assertions} assertions` : ""}${r.lastFailure ? ` (${escape(r.lastFailure)})` : ""}`);
    lines.push("");
  }
  if (notesPath) lines.push((await readFile(notesPath, "utf8")).trim(), "");
  const blockers = missingMethods(rows);
  if (blockers.length) {
    lines.push("## Missing methods");
    lines.push("");
    lines.push("Each failing case counted once, under the first method the target didn't have. Landing the top rows unblocks the most cases.");
    lines.push("");
    lines.push("| Method | Cases it blocks first | Cases |");
    lines.push("|---|---|---|");
    for (const [method, names] of blockers) {
      const shown = names.slice(0, 5).map(escape).join("; ") + (names.length > 5 ? `; +${names.length - 5} more` : "");
      lines.push(`| \`${method}\` | ${names.length} | ${shown} |`);
    }
    lines.push("");
  }
  const failing = rows.filter((r) => r.verdict === "fail" || r.verdict === "flaky");
  if (failing.length) {
    lines.push("## Failures on this target");
    lines.push("");
    for (const r of failing) {
      lines.push(`- **${r.name}** (${r.verdict}, \`${r.file}\`): ${escape(r.lastFailure)}`);
    }
    lines.push("");
  }
  lines.push("## Per case");
  lines.push("");
  lines.push(`| Case | File | Category | Zenius | Result | Time (median of passes) | Assertions |`);
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of [...rows, ...extraRows]) {
    const [file, category, zenius] = MANIFEST[r.name] || [r.file, "?", "run"];
    const result = r.verdict === "pass" ? "pass" : r.verdict === "flaky" ? `flaky (${r.runs.filter((x) => x.status === "pass").length}/${r.runs.length})` : r.verdict;
    lines.push(`| ${escape(r.name)} | ${file} | ${category} | ${zenius} | ${result} | ${seconds(r.medianMs)} | ${r.assertions || ""} |`);
  }
  lines.push("");
  if (first.target === "zenius") {
    lines.push("## Adapted for zenius");
    lines.push("");
    lines.push(
      "The adapt cases run with test-only stand-ins for Ego's v1 tab helpers (`openOrReuseTab`, `listTabs`, " +
        "`currentTab`, `closeTab`), its Page ledger file (`readPageLedger`) and CDP iframe targets (`__zenFrame`, `js`), " +
        "built on the dev runtime (`tests/e2e/source.mjs`). These cases are also patched (`tests/e2e/zen-adapt.mjs`):",
    );
    lines.push("");
    for (const [name, { reason }] of Object.entries(ZENIUS_ADAPTATIONS)) lines.push(`- **${escape(name)}**: ${escape(reason)}`);
    lines.push("");
    lines.push(
      "In an isolated world the agent's page code can't see a fixture page's own objects (`window.__fixtureState` and the like), " +
        "so on zenius these cases read them in the page's own world through the dev runtime (`__zenPageWorld`, " +
        "`ZENIUS_FIXTURE_READS` in `tests/e2e/zen-adapt.mjs`): " +
        Object.keys(ZENIUS_FIXTURE_READS).map((name) => `**${escape(name)}**`).join(", ") +
        ".",
    );
    lines.push("");
  }
  lines.push("## N/A on zenius, and why");
  lines.push("");
  for (const [name, [, category, zenius, reason]] of Object.entries(MANIFEST)) {
    if (zenius === "na") lines.push(`- **${name}** (${category}): ${reason}`);
  }
  lines.push("");
  const differences = Object.entries(MANIFEST).filter(([, [, , zenius]]) => zenius === "differs");
  if (differences.length) {
    lines.push("## Deliberate differences on zenius");
    lines.push("");
    lines.push("zenius refuses what these cases test, on purpose. `docs/PARITY.md` (Deliberate divergences) says why.");
    lines.push("");
    for (const [name, [, category, , reason]] of differences) lines.push(`- **${name}** (${category}): ${reason}`);
    lines.push("");
  }
  lines.push(
    jsonPath
      ? `Every run of every case, with its time and failure message: \`${jsonPath.replace(/^.*\/(tests|docs)\//, "$1/")}\`.`
      : `Raw results: ${files.map((f) => "`" + f.replace(/^.*\/(tests|docs)\//, "$1/") + "`").join(", ")}.`,
  );
  lines.push("");
  return lines.join("\n");
}

async function compare() {
  const [egoRun, zenRun] = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
  const ego = new Map(mergeRuns([egoRun]).map((r) => [r.name, r]));
  const zen = new Map(mergeRuns([zenRun]).map((r) => [r.name, r]));
  const names = [...new Set([...ego.keys(), ...zen.keys()])];
  const rubric = names.filter((n) => countsForRubric(n));
  const zenPass = rubric.filter((n) => zen.get(n)?.verdict === "pass").length;
  const lines = [];
  lines.push(`# e2e comparison: Ego Lite ${egoRun.version} vs zenius ${zenRun.version}`);
  lines.push("");
  lines.push(`zenius: ${zenRun.versionDetail}, run ${zenRun.startedAt}. Ego: ${egoRun.versionDetail}, run ${egoRun.startedAt}.`);
  lines.push("");
  lines.push(`**Rubric A: zenius passes ${zenPass} of ${rubric.length} cases (${Math.round((100 * zenPass) / rubric.length)}%); target ≥ 90%.**`);
  lines.push("");
  lines.push("| Case | Category | Ego | zenius | Ego time | zenius time | zenius failure |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const n of names) {
    const e = ego.get(n);
    const z = zen.get(n);
    lines.push(
      `| ${escape(n)} | ${MANIFEST[n]?.[1] ?? "?"} | ${e?.verdict ?? "-"} | ${z?.verdict ?? "-"} | ${seconds(e?.medianMs)} | ${seconds(z?.medianMs)} | ${z?.verdict === "fail" ? escape(z.lastFailure) : ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// Only as a command: parity.mjs imports mergeRuns from here.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const text = mode === "compare" ? await compare() : await baseline();
  if (outPath) {
    await writeFile(outPath, text);
    console.log(`wrote ${outPath}`);
  } else {
    process.stdout.write(text);
  }
}
