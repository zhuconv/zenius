// Static checks of the UI's code: what must never appear in it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../runtime/JS/zenius/", import.meta.url).pathname;
const files = [
  ...readdirSync(join(ROOT, "ui"))
    .filter(f => f.endsWith(".mjs"))
    .map(f => join(ROOT, "ui", f)),
  join(ROOT, "methods", "ui.sys.mjs"),
];

test("ui code never moves the OS cursor or dispatches native input (I1)", () => {
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /sendNative\w*|synthesizeNative\w*|sendNativeMouseEvent|activateNativeMenuItem/, file);
  }
});

test("ui code never shows window-level toasts or opens a popup on its own (I1)", () => {
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Toasts show over whatever Space the user is in.
    assert.doesNotMatch(src, /showToast\s*\(/, file);
  }
  // The tasks panel opens only at the user's click on the strip or its All
  // agent tasks button (one call, which both handlers share) or from the
  // controller's openTasksPanel(), which nothing in ui calls by itself.
  const panel = readFileSync(join(ROOT, "ui", "panel.sys.mjs"), "utf8");
  const index = readFileSync(join(ROOT, "ui", "index.sys.mjs"), "utf8");
  assert.equal((panel.match(/openTasksPanel\(win, [^\n]*, strip\)/g) ?? []).length, 1);
  assert.doesNotMatch(index.replace(/openTasksPanel\(win\) \{[\s\S]*?\n  \}/, ""), /openTasksPanel\(/);
});
