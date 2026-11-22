// Rubric C's judge (docs/eval/live-tasks.md, "Grading"): a fixed prompt and the
// same model grade a run's live items against the run's own tool log, blind to
// the target's name. Since round 2 the judge also sees the images the agent
// read, from the transcript, each right after the step that returned it: in
// round 1 a judged fail rested on a screenshot the judge couldn't see
// (docs/eval/live-round1.md, "Fixes for round 2").
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeEmptySessionEnv, removeRunProjectDir, removeStaleSessionFiles } from "./sessions.mjs";

/**
 * What the judge's message holds at most: images (the API's stricter size rule
 * starts above 20 in one request), an image's base64 length, the log's text
 * (round 1's limit), and each step's input and output.
 */
export const JUDGE_LIMITS = { images: 20, imageChars: 5_000_000, logChars: 250_000, inputChars: 4000, outputChars: 30_000 };
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Tool calls with their results, in order. A step keeps the images its result
 * held, in order, while its output text shows each one as "[image]".
 */
export function trajectory(events) {
  const steps = [];
  const byId = new Map();
  for (const e of events) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (e.type === "assistant" && block.type === "tool_use") {
        const input = block.input?.command ?? block.input?.skill ?? block.input?.file_path ?? JSON.stringify(block.input ?? {});
        const step = { id: block.id, tool: block.name, input: String(input), output: "", isError: false, images: [] };
        byId.set(block.id, step);
        steps.push(step);
      } else if (e.type === "user" && block.type === "tool_result") {
        const step = byId.get(block.tool_use_id);
        const parts = Array.isArray(block.content) ? block.content : null;
        const text = parts ? parts.map((c) => c.text ?? `[${c.type}]`).join("\n") : String(block.content ?? "");
        const images = (parts ?? [])
          .filter((c) => c.type === "image" && c.source?.type === "base64" && c.source.data)
          .map((c) => ({ mediaType: String(c.source.media_type ?? ""), data: String(c.source.data) }));
        if (step) Object.assign(step, { output: text, isError: Boolean(block.is_error), images });
      }
    }
  }
  return steps;
}

/** The judge sees no target's name. */
export function blind(text, instance) {
  const out = String(text)
    .replace(/ego[- ]?(browser|lite)/gi, "browser")
    .replace(/zenius/gi, "browser")
    .replace(/\b(ZEN|EGO)_(?=[A-Z])/g, "BROWSER_");
  return instance ? out.replaceAll(instance, "instance") : out;
}

/**
 * The judge's one message: the task, its live items, the final answer, then
 * the log, each step's images right after it. The log keeps whole steps from
 * the end as far as the text limit goes; the images are the last ones up to
 * the count limit. An image left out says why where it would have been.
 */
export function judgeContent({ task, answer, steps, instance = null, limits = JUDGE_LIMITS }) {
  const live = task.rubric.filter((r) => r.type === "live");
  const head = [
    "You grade one run of a browser agent on a live website. Judge only from the run's own page reads in the log below, not from what you know: the site may have changed since your training.",
    "Some steps returned images, such as screenshots the agent read. Each image follows the step that returned it, where that step's OUTPUT shows [image], and it is part of that step's page read.",
    `TASK: ${task.prompt}`,
    "ITEMS. Each passes only if the final answer states it correctly, as the run's own page reads show it:",
    ...live.map((r) => `- ${r.id}: ${r.text}`),
    `FINAL ANSWER:\n${blind(answer, instance)}`,
    "LOG:",
  ].join("\n\n");
  const tail = 'Reply with JSON only: {"items": [{"id": "<item id>", "pass": true|false, "why": "<one sentence that cites the step>"}]}';
  const texts = steps.map(
    (s, i) =>
      `STEP ${i + 1} (${s.tool})\nINPUT:\n${blind(s.input, instance).slice(0, limits.inputChars)}\nOUTPUT:\n${blind(s.output, instance).slice(0, limits.outputChars)}`
  );
  let first = texts.length;
  let used = 0;
  while (first > 0 && used + texts[first - 1].length + 2 <= limits.logChars) used += texts[--first].length + 2;
  const entries = steps.flatMap((s, i) => (s.images ?? []).map((image, k) => ({ step: i, k, image })));
  const why = new Map();
  for (const e of entries) {
    if (!IMAGE_TYPES.test(e.image.mediaType)) why.set(e, `a ${e.image.mediaType || "typeless"} image`);
    else if (e.image.data.length > limits.imageChars) why.set(e, "too large");
  }
  const fits = entries.filter((e) => e.step >= first && !why.has(e));
  for (const e of fits.slice(0, Math.max(0, fits.length - limits.images))) why.set(e, `over the judge's ${limits.images}-image limit`);
  const blocks = [];
  const text = (t) => (blocks.at(-1)?.type === "text" ? (blocks.at(-1).text += `\n\n${t}`) : blocks.push({ type: "text", text: t }));
  text(first > 0 ? `${head}\n\n[${first} earlier step${first === 1 ? "" : "s"} not shown]` : head);
  let shown = 0;
  for (let i = first; i < steps.length; i++) {
    text(texts[i]);
    for (const e of entries.filter((x) => x.step === i)) {
      const label = `image ${e.k + 1} of step ${i + 1}`;
      if (why.has(e)) {
        text(`[${label}: not shown, ${why.get(e)}]`);
        continue;
      }
      text(`[${label}]`);
      blocks.push({ type: "image", source: { type: "base64", media_type: e.image.mediaType, data: e.image.data } });
      shown++;
    }
  }
  text(tail);
  return { content: blocks, images: { shown, notShown: entries.length - shown } };
}

/** The judge's verdict from its stream-json output: the result event, its cost and the items. */
export function parseJudgeOutput(out) {
  let result = null;
  for (const line of String(out).split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e?.type === "result") result = e;
    } catch {
      // not a JSON line
    }
  }
  let items = [];
  try {
    items = JSON.parse(/\{[\s\S]*\}/.exec(result?.result ?? "")[0]).items ?? [];
  } catch {
    items = [];
  }
  return { result, costUsd: result?.total_cost_usd ?? null, items: Array.isArray(items) ? items : [], sessionId: result?.session_id ?? null };
}

/**
 * Run the judge on one run: `claude -p` with no tools, its one message as
 * stream-json so it can hold images, in a temp folder of its own under
 * outDir. Writes <outDir>/<id>.judge.json (the result event and the image
 * counts) and returns { costUsd, items, images }.
 * - claude(args) gives [file, args] for Claude Code (run.mjs's helper);
 * - isolationArgs keep the user's settings, skills and MCP servers out;
 * - env(tmp) is the environment, built from scratch, with tmp as TMPDIR.
 */
export async function runJudge({ claude, model, effort, isolationArgs, env, outDir, id, task, answer, steps, instance = null, limits = JUDGE_LIMITS, timeoutMs = 10 * 60_000 }) {
  const { content, images } = judgeContent({ task, answer, steps, instance, limits });
  const work = realpathSync(mkdtempSync(join(outDir, `judge-${id}-`)));
  mkdirSync(join(work, "tmp"));
  const out = await new Promise((resolveJudge) => {
    // The judge has no tools at all.
    const [file, args] = claude([
      "-p", "--model", model, ...(effort ? ["--effort", effort] : []), ...isolationArgs,
      "--tools", "", "--max-turns", "2", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ]);
    const child = spawn(file, args, { cwd: work, env: env(join(work, "tmp")), stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (text += c));
    child.on("close", () => {
      clearTimeout(timer);
      removeStaleSessionFiles(child.pid, work);
      resolveJudge(text);
    });
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
  removeRunProjectDir(work);
  rmSync(work, { recursive: true, force: true });
  const verdict = parseJudgeOutput(out);
  removeEmptySessionEnv(verdict.sessionId);
  writeFileSync(join(outDir, `${id}.judge.json`), JSON.stringify({ ...(verdict.result ?? { error: "no result event", output: String(out).slice(-2000) }), images }, null, 2) + "\n");
  return { costUsd: verdict.costUsd, items: verdict.items, images };
}
