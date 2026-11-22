// tests/live/judge.mjs: the step log keeps the images the agent read, and the
// judge's message shows each one right after its step, within its limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { blind, judgeContent, parseJudgeOutput, trajectory } from "../live/judge.mjs";

const PNG = (tag) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `iVBOR${tag}` } });
const use = (id, command) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const TASK = {
  prompt: "Find Table 2 in the PDF.",
  rubric: [
    { id: "table2", type: "live", text: "Found Table 2 in the PDF." },
    { id: "bleu", type: "fixed", text: "The BLEU score." },
  ],
};

test("trajectory: a step keeps its images in order, and its output shows each as [image]", () => {
  const steps = trajectory([
    use("a", "zenius run shot.mjs"),
    result("a", [{ type: "text", text: "saved" }, PNG("1"), PNG("2")]),
    use("b", "zenius run read.mjs"),
    result("b", "plain text"),
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].output, "saved\n[image]\n[image]");
  assert.deepEqual(steps[0].images, [{ mediaType: "image/png", data: "iVBOR1" }, { mediaType: "image/png", data: "iVBOR2" }]);
  assert.equal(steps[1].output, "plain text");
  assert.deepEqual(steps[1].images, []);
});

test("judgeContent: each image follows its own step, labeled, and the text is blind to the target", () => {
  const steps = trajectory([
    use("a", "zenius run open.mjs"),
    result("a", [{ type: "text", text: "zenius opened it on zen-eval" }]),
    use("b", "zenius run shot.mjs"),
    result("b", [{ type: "text", text: "shot" }, PNG("x")]),
    use("c", "zenius run end.mjs"),
    result("c", "done"),
  ]);
  const { content, images } = judgeContent({ task: TASK, answer: "zenius found it: 28.4", steps, instance: "zen-eval" });
  assert.deepEqual(images, { shown: 1, notShown: 0 });
  assert.deepEqual(content.map((b) => b.type), ["text", "image", "text"]);
  assert.match(content[0].text, /STEP 2 \(Bash\)[\s\S]*OUTPUT:\nshot\n\[image\]\n\n\[image 1 of step 2\]$/);
  assert.equal(content[1].source.data, "iVBORx");
  assert.match(content[2].text, /^STEP 3 \(Bash\)/);
  assert.match(content[2].text, /Reply with JSON only/);
  const all = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.ok(!/zenius|zen-eval/i.test(all), "no target name and no instance name in the judge's text");
  assert.match(all, /browser opened it on instance/);
  assert.match(all, /- table2: Found Table 2 in the PDF\./);
  assert.ok(!all.includes("- bleu:"), "only live items go to the judge");
});

test("judgeContent: the last images up to the limit; the others say why, where they would have been", () => {
  const big = { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(50) } };
  const svg = { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } };
  const steps = trajectory([use("a", "s1"), result("a", [PNG("1"), PNG("2"), big, svg]), use("b", "s2"), result("b", [PNG("3")])]);
  const { content, images } = judgeContent({ task: TASK, answer: "", steps, limits: { images: 2, imageChars: 40, logChars: 250_000, inputChars: 4000, outputChars: 30_000 } });
  assert.deepEqual(images, { shown: 2, notShown: 3 });
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(text, /\[image 1 of step 1: not shown, over the judge's 2-image limit\]/);
  assert.match(text, /\[image 3 of step 1: not shown, too large\]/);
  assert.match(text, /\[image 4 of step 1: not shown, a image\/svg\+xml image\]/);
  assert.deepEqual(content.filter((b) => b.type === "image").map((b) => b.source.data), ["iVBOR2", "iVBOR3"]);
});

test("judgeContent: past the text limit, the earliest whole steps go, with their images", () => {
  const steps = trajectory([use("a", "first"), result("a", [{ type: "text", text: "x".repeat(300) }, PNG("old")]), use("b", "second"), result("b", "short")]);
  const { content, images } = judgeContent({ task: TASK, answer: "", steps, limits: { images: 20, imageChars: 5_000_000, logChars: 200, inputChars: 4000, outputChars: 30_000 } });
  assert.deepEqual(images, { shown: 0, notShown: 1 });
  const text = content.map((b) => b.text ?? "").join("\n");
  assert.match(text, /\[1 earlier step not shown\]/);
  assert.ok(!text.includes("STEP 1 ("));
  assert.match(text, /STEP 2 \(Bash\)/);
});

test("parseJudgeOutput: the result event's items and cost; nothing usable gives no items", () => {
  const out = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "…" }] } }),
    JSON.stringify({ type: "result", result: '```json\n{"items": [{"id": "table2", "pass": true, "why": "step 2"}]}\n```', total_cost_usd: 0.07, session_id: "s" }),
  ].join("\n");
  const v = parseJudgeOutput(out);
  assert.deepEqual(v.items, [{ id: "table2", pass: true, why: "step 2" }]);
  assert.equal(v.costUsd, 0.07);
  assert.equal(v.sessionId, "s");
  assert.deepEqual(parseJudgeOutput("not json\n").items, []);
  assert.deepEqual(parseJudgeOutput(JSON.stringify({ type: "result", result: "no verdict" })).items, []);
});

test("blind: the targets' names and error prefixes, and the instance", () => {
  assert.equal(blind("Ego Lite and ego-browser and zenius: EGO_X ZEN_Y on zen-eval", "zen-eval"), "browser and browser and browser: BROWSER_X BROWSER_Y on instance");
});
