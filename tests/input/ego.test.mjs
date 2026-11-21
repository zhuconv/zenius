// Ego's Page API e2e cases for page actions (refs/ego-lite's
// scripts/real-browser-e2e/cases), ported in tests/input/ego/ and run against
// a dev Zen through tests/input/harness.mjs. Each case checks Ego's
// observable behavior: which element an action reaches, trusted events,
// messages, timings. After all of them, the user's view must be unchanged
// (I1) and every Space must still be the agent's (zen-ux's takeover detector
// never saw the agent's input).
import { after, before, test } from "node:test";
import { openHarness } from "./harness.mjs";
import { pageActionabilityCase } from "./ego/page-actionability.mjs";
import { pageActionIdleFailFastCase, pageActionPopupReceiptCase } from "./ego/page-action-latency.mjs";
import { pageActionMotionCase } from "./ego/page-action-motion.mjs";
import { pageClickHitTargetCase } from "./ego/page-click-hit-target.mjs";
import { pageDragAndDrawCase } from "./ego/page-drag-and-draw.mjs";
import { pageKeyboardInterfaceCase } from "./ego/page-keyboard.mjs";
import { pageOopifActionCase, pageOopifRestoreCase } from "./ego/page-oopif.mjs";
import { pageSelectorCompatibilityCase } from "./ego/page-selector-compatibility.mjs";
import { pageShadowDomCase } from "./ego/page-shadow-dom.mjs";
import { pageTextLocatorCase } from "./ego/page-text-locators.mjs";
import { pageWheelTrapCase } from "./ego/page-wheel-trap.mjs";
import { portableKeyboardWorkflowCase } from "./ego/workflow-chains.mjs";

let h;

before(async () => {
  h = await openHarness("ego");
});

after(async () => {
  await h?.finish();
});

const cases = [
  ["page-actionability", pageActionabilityCase],
  ["page-click-hit-target", pageClickHitTargetCase],
  ["page-wheel-trap", pageWheelTrapCase],
  ["page-action-motion", pageActionMotionCase],
  ["page-selector-compatibility", pageSelectorCompatibilityCase],
  ["page-text-locators", pageTextLocatorCase],
  ["page-shadow-dom", pageShadowDomCase],
  ["page-keyboard", pageKeyboardInterfaceCase],
  ["workflow-chains: portable keyboard", portableKeyboardWorkflowCase],
  ["page-drag-and-draw", pageDragAndDrawCase],
  ["page-action-latency: popup receipts", pageActionPopupReceiptCase],
  ["page-action-latency: idle fail-fast", pageActionIdleFailFastCase],
];

// The harness checks each copy and cut chord a case sends against the
// system clipboard (system-clipboard.mjs).
for (const [name, fn] of cases) {
  test(name, t => h.run(t, fn));
}

test("page-oopif: actions, then a later round on the same Page", async t => {
  let saved;
  await h.run(t, async () => {
    saved = await pageOopifActionCase(h);
  });
  if (saved) {
    await h.run(t, () => pageOopifRestoreCase(h, saved));
  }
});
