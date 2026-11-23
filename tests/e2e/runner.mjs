#!/usr/bin/env node
// Portions adapted from citrolabs/ego-lite (MIT License).
// Source: package/ego-browser/scripts/real-browser-e2e/runner.mjs at tag v2.2.1.
// Changes for zenius: --target ego|zenius, no SDK build step (the ego target
// uses the SDK embedded in the installed Ego Lite unless --sdk-path is given),
// per-case N/A classification for zenius (manifest.mjs), and a JSON result
// file for docs/eval reports.
//
//   node tests/e2e/runner.mjs --target ego [--only "name,name"] [--results out.json]
//   node tests/e2e/runner.mjs --target zenius --instance zen-eval [--include-na]

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";
import { parseTarget, REPO_ROOT, runScript, targetVersion } from "../lib/targets.mjs";
import { e2eCases as egoCases } from "./cases/index.mjs";
import { zenEvalCases } from "./zen-cases/index.mjs";
import { caseInfo } from "./manifest.mjs";
import { egoSource, toZeniusSource, zeniusNames } from "./source.mjs";
import { adaptForZenius } from "./zen-adapt.mjs";

const runnerDir = dirname(fileURLToPath(import.meta.url));
const e2eCases = [...egoCases, ...zenEvalCases];
const argv = process.argv;
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i > 0 ? argv[i + 1] : undefined;
};
const opts = parseTarget(argv);
const sdkPath = argValue("--sdk-path");
const includeNa = argv.includes("--include-na");
const keepTaskSpace = argv.includes("--keep") || process.env.EGO_BROWSER_REAL_E2E_KEEP === "1";
const resultsPath =
  argValue("--results") || join(runnerDir, "out", `results-${opts.target}.json`);

export function parseOnlyCases(configured, availableCaseNames) {
  const raw = typeof configured === "string" ? configured.trim() : "";
  if (!raw) return new Set();
  const available = [...availableCaseNames];
  const availableSet = new Set(available);
  let requested;
  if (raw.startsWith("[")) {
    requested = JSON.parse(raw).map((name) => String(name).trim());
  } else if (availableSet.has(raw)) {
    requested = [raw];
  } else {
    requested = raw.split(",").map((name) => name.trim()).filter(Boolean);
  }
  const unknown = [...new Set(requested)].filter((name) => !availableSet.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown case: ${unknown.join(", ")}. Available: ${available.join(", ")}`);
  }
  return new Set(requested);
}

// A fresh nonce per run: a case passes only if its script printed this.
const SENTINEL = randomUUID();

/** The case body for this target: on zenius, with its adaptation if it has one. */
function caseBody(testCase) {
  const body = testCase.body();
  return opts.target === "zenius" ? adaptForZenius(testCase.name, body) : body;
}

function buildSource(body, context) {
  const source = egoSource(body, { ...context, target: opts.target, sentinel: SENTINEL });
  return opts.target === "zenius" ? toZeniusSource(source) : source;
}

function mapText(text) {
  return opts.target === "zenius" && typeof text === "string" ? zeniusNames(text) : text;
}


async function runOnTarget(source, timeoutMs) {
  const extraArgs = opts.target === "ego" && sdkPath ? ["--sdk-path", sdkPath] : [];
  const result = await runScript(source, { ...opts, timeoutMs, extraArgs });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.code !== 0) {
    // An error thrown outside the case's try (a timer, an unhandled
    // rejection) leaves no summary line; its first line says what happened.
    const thrown = /^(?:Uncaught )?(?:[A-Za-z]*Error|Error)(?: \[[A-Z_]+\])?: (.+)$/m.exec(output)?.[1];
    const error = new Error(
      `${opts.target} script exited with code ${result.code}${thrown ? `: ${thrown.slice(0, 300)}` : ""}`,
    );
    Object.assign(error, result);
    throw error;
  }
  // Ego's launcher can exit 0 after its inner Node process failed.
  if (/nodejs process exited with code\s+[1-9]\d*/.test(output)) {
    const error = new Error("the script reported an inner failure while exiting 0");
    Object.assign(error, result);
    throw error;
  }
  return result;
}

function lastCaseReport(outputs) {
  const lines = outputs.filter(Boolean).join("\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.includes("assertions")) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.assertions === "number") return parsed;
      } catch {}
    }
  }
  return null;
}

function lastLines(text, n = 12) {
  return String(text || "").trim().split("\n").slice(-n).join("\n");
}

/**
 * zenius asks the user before a claim of one of their Spaces or of an ended
 * task, and the claim waits up to 10 minutes for Allow in the browser (SPEC
 * §3.4). Ego asks no one. So on zenius the suite answers every ask
 * with Allow, as the user would, through dev.answerClaim (dev profiles only),
 * and Ego's cases stay unchanged. take() returns the spaces allowed since the
 * last take(), which the case's result records.
 */
async function startClaimAnswerer(instance) {
  let client;
  try {
    client = await connect(instance, { timeout: 5000, callTimeout: 30_000 });
  } catch (error) {
    console.error(`[claims] can't connect to answer claims: ${error?.message}`);
    return null;
  }
  const allowed = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const answer = await client.call("dev.answerClaim", { allow: true, timeout: 1000 });
        if (answer?.verdict) allowed.push(answer.space);
      } catch (error) {
        console.error(`[claims] dev.answerClaim failed, so a claim that asks the user will wait: ${error?.message}`);
        return;
      }
    }
  })();
  return {
    take: () => allowed.splice(0),
    async stop() {
      stopped = true;
      await loop;
      client.close();
    },
  };
}

async function main() {
  const onlyCases = parseOnlyCases(
    argValue("--only") ?? process.env.EGO_BROWSER_REAL_E2E_ONLY,
    e2eCases.map((c) => c.name),
  );
  const version = await targetVersion(opts);
  const context = {};
  const caseResults = [];
  let server;
  let tempDir;
  let claims = null;
  let passed = false;
  const totalStartedAt = Date.now();

  function record(testCase, status, durationMs, assertions, message, output) {
    const info = caseInfo(testCase.name);
    caseResults.push({
      name: testCase.name,
      file: info.file,
      category: info.category,
      status,
      durationMs,
      assertions,
      message,
      zenius: info.zenius,
      naReason: info.reason,
      output: status === "fail" ? lastLines(output) : undefined,
    });
  }

  async function runCase(testCase) {
    const { name, timeoutMs = 45_000, expectedOutput, forbiddenOutput } = testCase;
    console.log(`-- ${name}`);
    const source = buildSource(caseBody(testCase), { ...context, keepTaskSpace: keepTaskSpace && passed });
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await runOnTarget(source, timeoutMs);
      const durationMs = Date.now() - startedAt;
      const output = [stdout, stderr].filter(Boolean).join("\n");
      if (expectedOutput && !output.includes(mapText(expectedOutput))) {
        throw Object.assign(new Error(`output did not include ${JSON.stringify(mapText(expectedOutput))}`), { stdout, stderr });
      }
      if (forbiddenOutput && output.includes(mapText(forbiddenOutput))) {
        throw Object.assign(new Error(`output unexpectedly included ${JSON.stringify(mapText(forbiddenOutput))}`), { stdout, stderr });
      }
      const report = lastCaseReport([stdout, stderr]);
      if (!report) throw Object.assign(new Error(`${name} produced no assertion summary`), { stdout, stderr });
      if (report.ok !== true || report.sentinel !== SENTINEL) {
        throw Object.assign(new Error(`${name} did not print the run's success sentinel`), { stdout, stderr });
      }
      record(testCase, "pass", durationMs, report.assertions);
      console.log(`-- ${name} passed (${durationMs} ms, ${report.assertions} assertions)`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const report = lastCaseReport([error?.stdout, error?.stderr]);
      const message = (typeof report?.error === "string" && report.error) || error?.message || String(error);
      record(testCase, "fail", durationMs, report?.assertions ?? 0, message, [error?.stdout, error?.stderr].filter(Boolean).join("\n"));
      console.error(`[FAIL] ${name} (${durationMs} ms): ${message}`);
    }
  }

  async function runExpectedTerminationCase(testCase) {
    const { name, markerName, timeoutMs = 45_000, expectedOutput } = testCase;
    console.log(`-- ${name}`);
    const source = buildSource(caseBody(testCase), { ...context, keepTaskSpace: keepTaskSpace && passed });
    const startedAt = Date.now();
    let commandError;
    let commandResult;
    try {
      commandResult = await runOnTarget(source, timeoutMs);
    } catch (error) {
      commandError = error;
    }
    const durationMs = Date.now() - startedAt;
    try {
      const output = [commandResult?.stdout, commandResult?.stderr, commandError?.stdout, commandError?.stderr, commandError?.message]
        .filter(Boolean)
        .join("\n");
      const expected = mapText(expectedOutput);
      const reported = expected && output.includes(expected);
      if (!commandError && !reported) throw new Error("the browser script completed instead of terminating");
      if (commandError && expected && !reported) throw new Error(`the browser script did not report the expected hard stop: ${expected}`);
      // The marker is written only after newPage() and goto() returned, which
      // tells the intended hard stop from an unrelated startup error.
      await stat(join(tempDir, markerName));
      record(testCase, "pass", durationMs, 1);
      console.log(`-- ${name} passed (${durationMs} ms, expected termination)`);
    } catch (error) {
      record(testCase, "fail", durationMs, 0, error?.message || String(error));
      console.error(`[FAIL] ${name} (${durationMs} ms): ${error?.message}`);
    }
  }

  async function maybeRun(testCase) {
    const info = caseInfo(testCase.name);
    if (onlyCases.size > 0 && !onlyCases.has(testCase.name)) {
      record(testCase, "skip", 0, 0);
      return;
    }
    if (testCase.targets && !testCase.targets.includes(opts.target)) {
      const reason = `only for ${testCase.targets.join(", ")}`;
      console.log(`-- ${testCase.name} (N/A on ${opts.target}: ${reason})`);
      record(testCase, "na", 0, 0, reason);
      return;
    }
    if (opts.target === "zenius" && info.zenius === "na" && !includeNa) {
      console.log(`-- ${testCase.name} (N/A on zenius: ${info.reason})`);
      record(testCase, "na", 0, 0, info.reason);
      return;
    }
    if (opts.target === "zenius" && info.zenius === "differs" && !includeNa) {
      console.log(`-- ${testCase.name} (a deliberate difference on zenius: ${info.reason})`);
      record(testCase, "differs", 0, 0, info.reason);
      return;
    }
    // A family ("X: prepare", "X: resume") shares Pages across its rounds on
    // purpose. When one of its rounds fails, close what the family added to
    // the suite's space, or later cases inherit a full Page budget.
    // Single-round cases close their own Pages when they fail (the prelude's
    // closePagesOpenedByCase), so only named rounds need this.
    const family = testCase.name.includes(": ") ? testCase.name.replace(/: [^:]+$/, "") : null;
    if (family !== currentFamily.name) {
      currentFamily = { name: family, before: family ? await suitePageIds() : null };
    }
    if (testCase.expectedTermination) await runExpectedTerminationCase(testCase);
    else await runCase(testCase);
    const allowed = claims?.take() ?? [];
    if (allowed.length) {
      caseResults.at(-1).claimsAllowed = allowed;
      console.log(`   [claims] answered Allow for space ${allowed.join(", ")}`);
    }
    if (caseResults.at(-1)?.status === "fail" && currentFamily.before) {
      await closeFamilyPages(currentFamily.before);
    }
  }

  let currentFamily = { name: null, before: null };

  /** Target ids of the Pages in the suite's own space, or null if unknown. */
  async function suitePageIds() {
    const source = buildSource(
      `
        const space = (await listTaskSpaces()).find((s) => s.name === taskName);
        const ids = space ? (await (await taskSpace(space.id)).pages()).map((p) => p.targetId) : [];
        cliLog(JSON.stringify({ suitePages: ids }));
      `,
      { ...context, keepTaskSpace: true },
    );
    const result = await runOnTarget(source, 30_000).catch(() => null);
    const line = [result?.stdout, result?.stderr].filter(Boolean).join("\n").split("\n").find((l) => l.startsWith('{"suitePages":'));
    return line ? new Set(JSON.parse(line).suitePages) : null;
  }

  async function closeFamilyPages(before) {
    const source = buildSource(
      `
        const before = new Set(${JSON.stringify("__BEFORE__")});
        const space = (await listTaskSpaces()).find((s) => s.name === taskName);
        const closed = [];
        if (space) {
          for (const page of await (await taskSpace(space.id)).pages()) {
            if (!before.has(page.targetId)) {
              await page.close().then(() => closed.push(page.label), () => {});
            }
          }
        }
        cliLog(JSON.stringify({ closedFamilyPages: closed }));
      `.replace(JSON.stringify("__BEFORE__"), JSON.stringify([...before])),
      { ...context, keepTaskSpace: true },
    );
    const result = await runOnTarget(source, 30_000).catch(() => null);
    const line = [result?.stdout, result?.stderr].filter(Boolean).join("\n").split("\n").find((l) => l.startsWith('{"closedFamilyPages":'));
    if (line && JSON.parse(line).closedFamilyPages.length) console.log(`   [family cleanup] ${line}`);
  }

  async function cleanupTaskSpace() {
    // The suite's own spaces all start with taskName; finish each one.
    const source = buildSource(
      `
        const spaces = await listTaskSpaces();
        const mine = spaces.filter((s) => String(s.name || "").startsWith(taskName));
        const results = [];
        for (const s of mine) {
          try {
            let task;
            if (s.ownership === "user") task = await claimTaskSpace(s.id);
            else if (s.ownership === "agentDelegatedToUser") task = await takeOverTaskSpace(s.id);
            else task = await taskSpace(s.id);
            // finish keeps a space that holds tabs of user or unknown origin
            // (some cases open them on purpose) and hands it to the user.
            // Ego's completeTaskSpace closes it outright; zenius has none.
            // Closing such a tab from outside the SDK ends the task when it's
            // the last one (the user closing the space), and finish then hits
            // a hard stop; finish itself keeps even an adopted one. So on
            // zenius, adopt and close each first. pages.close of the last tab
            // leaves the agent's blank tab, which finish closes with the space.
            let closedFirst = 0;
            if (!keepTaskSpace && evalTarget === "zenius") {
              for (const tab of await task.tabs()) {
                if (tab.label === undefined && tab.openedBy !== "agent") {
                  const page = await task.adopt(tab.page, { as: "cleanup-" + Date.now() + "-" + closedFirst });
                  await page.close();
                  closedFirst += 1;
                }
              }
            }
            const receipt = await task.finish({ keep: keepTaskSpace ? "all" : [] });
            results.push(closedFirst ? { ...receipt, closedFirst } : receipt);
            if (!keepTaskSpace && receipt?.closedSpace === false) {
              if (typeof completeTaskSpace === "function") {
                await completeTaskSpace(s.id, { keep: false });
                results.push({ id: s.id, closedWith: "completeTaskSpace" });
              } else {
                results.push({ id: s.id, leftOpen: "finish kept tabs of user or unknown origin" });
              }
            }
          } catch (error) {
            results.push({ id: s.id, error: String(error?.message || error) });
          }
        }
        // Spaces close asynchronously; name any of ours still listed after a second.
        let left = [];
        for (let attempt = 0; attempt < 20; attempt += 1) {
          left = (await listTaskSpaces()).filter((s) => String(s.name || "").startsWith(taskName)).map((s) => s.id);
          if (keepTaskSpace || !left.length) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        cliLog(JSON.stringify({ cleanup: results, ...(left.length && !keepTaskSpace ? { stillListed: left } : {}) }));
      `,
      { ...context, keepTaskSpace },
    );
    const result = await runOnTarget(source, 60_000).catch((error) => error);
    const out = [result?.stdout, result?.stderr].filter(Boolean).join("\n");
    const summary = out.split("\n").find((line) => line.startsWith('{"cleanup":'));
    // Without its summary the script failed: say how, not just how it ended.
    const failure = result instanceof Error ? `${result.message} | ` : "";
    console.log(`[cleanup] ${summary || failure + lastLines(out, 6)}`);
  }

  try {
    tempDir = await mkdtemp(join(tmpdir(), "zen-eval-e2e-"));
    const artifactDir = join(tempDir, "artifacts");
    const uploadPath = join(tempDir, "fixture-upload.txt");
    const uploadPathTwo = join(tempDir, "fixture-upload-two.txt");
    const taskName = `${opts.target === "ego" ? "ego-lite" : "zenius"} real browser e2e ${Date.now()}-${Math.random().toString(16).slice(2)}`;
    Object.assign(context, {
      artifactDir,
      explicitScreenshotPath: join(artifactDir, "explicit-shot.png"),
      environmentScreenshotPath: join(artifactDir, "environment-shot.png"),
      metadataPath: join(tempDir, "metadata.json"),
      taskName,
      tempDir,
      uploadPath,
      ...(opts.target === "zenius"
        ? { zeniusInstance: opts.instance, zeniusRpcModule: join(REPO_ROOT, "scripts/lib/rpc.mjs") }
        : {}),
      uploadPathTwo,
    });
    await mkdir(artifactDir, { recursive: true });
    await writeFile(uploadPath, "ego-browser upload fixture\n", "utf8");
    await writeFile(uploadPathTwo, "second upload fixture\n", "utf8");

    const fixture = await startFixtureServer(taskName);
    server = fixture.server;
    context.baseUrl = fixture.baseUrl;
    const health = await (await fetch(`${context.baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    if (health.taskName !== taskName || health.ok !== true) throw new Error(`fixture health mismatch: ${JSON.stringify(health)}`);
    await writeFile(
      context.metadataPath,
      JSON.stringify({ baseUrl: context.baseUrl, taskName, tempDir, artifactDir, startedAt: new Date().toISOString() }, null, 2),
    );

    console.log(`== E2E on ${opts.target} ${version.version} (${version.detail}) ==`);
    console.log(`fixture: ${context.baseUrl}`);
    console.log(`task: ${taskName}`);
    if (sdkPath) console.log(`sdk: ${sdkPath}`);

    if (opts.target === "zenius") claims = await startClaimAnswerer(opts.instance);
    for (const testCase of e2eCases) await maybeRun(testCase);
    passed = caseResults.every((r) => r.status !== "fail");
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    if (context.taskName) await cleanupTaskSpace().catch((error) => console.error(`[cleanup] ${error?.message}`));
    if (claims) {
      const allowed = claims.take();
      if (allowed.length) console.log(`[cleanup] answered Allow for space ${allowed.join(", ")}`);
      await claims.stop();
    }
    if (server) await closeFixtureServer(server);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      // Ego's script host can write its state dir (EGO_BROWSER_STATE_DIR,
      // inside tempDir) a moment after a script ends, recreating the folder.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const totalMs = Date.now() - totalStartedAt;
  const summary = summarize(caseResults);
  printSummary(caseResults, summary, totalMs);
  await mkdir(dirname(resultsPath), { recursive: true });
  await writeFile(
    resultsPath,
    JSON.stringify(
      {
        target: opts.target,
        version: version.version,
        versionDetail: version.detail,
        sdk: opts.target === "ego" ? sdkPath || "embedded" : "zenius",
        startedAt: new Date(totalStartedAt).toISOString(),
        totalMs,
        summary,
        cases: caseResults,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`results: ${resultsPath}`);
  if (!passed) process.exitCode = 1;
}

function summarize(results) {
  const count = (pred) => results.filter(pred).length;
  return {
    total: results.length,
    pass: count((r) => r.status === "pass"),
    fail: count((r) => r.status === "fail"),
    skip: count((r) => r.status === "skip"),
    na: count((r) => r.status === "na"),
    differs: count((r) => r.status === "differs"),
    assertions: results.reduce((sum, r) => sum + (r.assertions || 0), 0),
  };
}

function printSummary(results, s, totalMs) {
  console.log(`\n== E2E Summary (${opts.target}) ==`);
  console.log(`  Passed: ${s.pass}  Failed: ${s.fail}  N/A: ${s.na}  Deliberate differences: ${s.differs}  Skipped: ${s.skip}  of ${s.total}`);
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)} s, assertions: ${s.assertions}`);
  const width = Math.max(...results.map((r) => r.name.length), 4);
  for (const r of results) {
    if (r.status === "skip") continue;
    const t = r.status === "na" || r.status === "differs" ? "" : `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`    ${r.name.padEnd(width)}  ${t.padStart(7)}  ${String(r.assertions).padStart(4)}  ${r.status.toUpperCase()}`);
  }
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length) {
    console.log("\n  Failures:");
    for (const r of failed) console.log(`    - ${r.name}: ${r.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
void REPO_ROOT;
