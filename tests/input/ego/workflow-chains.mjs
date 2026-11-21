// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Ego's e2e case workflow-chains.mjs, ported to tests/input/harness.mjs (Ego's Page
// API over zenius RPC). Edits from Ego's text are marked "zenius:".

export async function portableKeyboardWorkflowCase(h) {
  const { taskSpace, taskName, newPageAt, baseUrl, assert, assertEqual, assertIncludes, assertRejects, assertRejectsAny, wait } = h;
  const { scrollingActionTimeout, artifactDir, join, readFile } = h;
  const task = await taskSpace(taskName);
  const page = await newPageAt(task, baseUrl + "/?workflow=keyboard");

  await page.fill("#text-input", "portable clipboard");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+C");
  await page.evaluate(() => {
    const target = document.querySelector("#append-input");
    target.value = "";
    target.focus();
  });
  await page.keyboard.press("ControlOrMeta+V");
  assertEqual(
    await page.evaluate("document.querySelector('#append-input').value"),
    "portable clipboard",
    "ControlOrMeta copy and paste use the current platform shortcut"
  );
  await page.keyboard.press("ControlOrMeta+Z");
  assertEqual(
    await page.evaluate("document.querySelector('#append-input').value"),
    "",
    "ControlOrMeta undo reverts the native paste"
  );

  const textLength = await page.evaluate(() => {
    const area = document.querySelector("#text-area");
    area.value = Array.from({ length: 40 }, (_, index) => "line " + index).join("\n");
    area.focus();
    area.setSelectionRange(Math.floor(area.value.length / 2), Math.floor(area.value.length / 2));
    return area.value.length;
  });
  const toEnd = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
  const toStart = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";
  await page.keyboard.press(toEnd);
  assertEqual(
    await page.evaluate("document.querySelector('#text-area').selectionStart"),
    textLength,
    "the host-platform document-end shortcut reaches the end"
  );
  await page.keyboard.press(toStart);
  assertEqual(
    await page.evaluate("document.querySelector('#text-area').selectionStart"),
    0,
    "the host-platform document-start shortcut reaches the beginning"
  );

  await page.close();
}
