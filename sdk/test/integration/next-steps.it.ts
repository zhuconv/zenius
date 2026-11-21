// The errors tonight's behaviours raise reach an agent with what to do next,
// as help("errors") and the guide say: a dialog that stops a call, raw input
// at a dialog, and a claim the user denies or leaves unanswered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZeniusError } from "../../src/errors.ts";
import { needs, unique, useContext, zeniusJson } from "./context.ts";

const context = useContext();

/** A script on a fresh task space whose p1 shows `path`; it prints JSON last, and finishes the space. */
function onPage(path: string, body: string): string {
  return `const task = await taskSpace(${JSON.stringify(unique("it next step"))});
const page = task.page("p1");
await page.goto(${JSON.stringify(context.base + path)});
const caught = async (call) => { try { await call(); return null; } catch (error) { return { code: error.code, message: error.message }; } };
${body}
await task.finish({ keep: [] });`;
}

describe("a dialog that stops a call", () => {
  it("fails selectOption, keeps the choice it made, and says to check before repeating", async () => {
    const out = await zeniusJson(
      context,
      onPage(
        "/ex-month-alert",
        `const error = await caught(() => page.selectOption("select[name=month]", { label: "October" }));
const dialog = (await page.info()).dialog?.message ?? null;
await page.acceptDialog();
console.log(JSON.stringify({ error, dialog, value: await page.evaluate(() => document.querySelector("select").value) }));`,
      ),
    );
    assert.equal(out.error?.code, "ZEN_PAGE_DIALOG_OPENED", JSON.stringify(out));
    assert.match(out.error.message, /opened while page\.selectOption was running; handle it with page\.acceptDialog\(\) or page\.dismissDialog\(\)/);
    assert.match(out.error.message, /\nWhat the call did before the dialog opened took effect: after you handle it, check the page with snapshot\(\) before you repeat anything\.$/);
    assert.equal(out.dialog, "saved m10");
    assert.equal(out.value, "m10");
  });

  it("stops raw typing where it is; while it's open, raw input sends nothing and a click fails", async () => {
    const out = await zeniusJson(
      context,
      onPage(
        "/ex-typing-alert",
        `await page.click("#typed");
const typing = await caught(() => page.keyboard.type("abcd"));
const open = (await page.info()).dialog?.message ?? null;
const more = await caught(() => page.keyboard.type("xyz"));
const click = await caught(() => page.mouse.click(5, 5));
await page.acceptDialog();
console.log(JSON.stringify({ typing, open, more, click, value: await page.evaluate(() => document.querySelector("#typed").value) }));`,
      ),
    );
    assert.equal(out.typing, null, "keyboard.type returns at the dialog");
    assert.equal(out.open, "b pressed");
    assert.equal(out.more, null, "raw typing at an open dialog returns");
    assert.ok(["a", "ab"].includes(out.value), `typing stopped at the dialog, and sent nothing while it was open: ${JSON.stringify(out.value)}`);
    assert.equal(out.click?.code, "ZEN_PAGE_DIALOG_OPENED");
    // Already open: the runtime's message says what to do, and nothing is added.
    assert.match(out.click.message, /^page\.mouse\.click cannot run while a JavaScript alert dialog \("b pressed"\) is open; handle it with page\.acceptDialog\(\) or page\.dismissDialog\(\) before continuing$/);
  });
});

describe("a claim of one of the user's Spaces", () => {
  /** A task finished with its Page kept: the user's now, so a claim asks them. */
  async function kept(): Promise<number> {
    const made = await zeniusJson<{ id: number }>(
      context,
      `const task = await taskSpace(${JSON.stringify(unique("it next step"))});
await task.page("p1").goto(${JSON.stringify(`${context.base}/two`)});
await task.finish({ keep: ["p1"] });
console.log(JSON.stringify({ id: task.spaceId }));`,
    );
    return made.id;
  }

  it("that the user denies says not to claim again on your own", async (t) => {
    if (!needs(t, context, "dev.answerClaim")) return;
    const id = await kept();
    const [out] = await Promise.all([
      zeniusJson(
        context,
        `try { await claimTaskSpace(${id}); console.log("{}"); } catch (error) { console.log(JSON.stringify({ code: error.code, verdict: error.data?.verdict, message: error.message })); }`,
      ),
      context.rpc.call("dev.answerClaim", { space: id, allow: false, timeout: 30_000 }, { safetyTimeoutMs: 40_000 }),
    ]);
    assert.equal(out.code, "ZEN_TASK_SPACE_CLAIM_DENIED", JSON.stringify(out));
    assert.equal(out.verdict, "deny");
    assert.match(out.message, /The user said no, in the browser, to an agent working in their Space/);
    assert.match(out.message, /\nDon't claim it again on your own: say in your reply what you want to do in that Space/);
  });

  it("that nobody answers ends with the same next step", async () => {
    const id = await kept();
    // The SDK's claimTaskSpace() waits the runtime's 10 minutes; the method takes a shorter wait.
    const error = await context.rpc.call("spaces.claim", { space: id, timeout: 300 }).then(
      () => assert.fail("the claim went through"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof ZeniusError, String(error));
    assert.equal(error.code, "ZEN_TASK_SPACE_CLAIM_DENIED");
    assert.equal((error.data as { verdict?: string } | undefined)?.verdict, "timeout");
    assert.match(error.message, /Nobody answered, in the browser, the request to work in Space/);
    assert.match(error.message, /\nDon't claim it again on your own/);
  });
});
