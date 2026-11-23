// How each of Ego's e2e cases counts for zenius (SPEC §6, rubric A).
//
// category:
//   v2       uses only the public v2 API from skill guide v2.2.1
//   v2+obs   v2 behavior, observed partly through a legacy helper
//            (listTabs, currentTab, openOrReuseTab, closeTab) or an Ego SDK
//            knob that zenius spells ZENIUS_* (see toZeniusSource)
//   v2+cdp   v2 behavior with one or more raw page.cdp/task.cdp assertions
//   v2+ledger reads Ego's on-disk Page ledger, an SDK internal
//   v1       exercises Ego's legacy v1 helpers (hidden from help(), not in
//            skill guide v2.2.1)
//   cdp      exists to test CDP itself
//   chromium tests a Chromium-only surface
//
// zenius: "run" counts toward rubric A; "na" is excluded, with the reason.
// "differs" is excluded too, but it isn't a gap: zenius refuses what the
// case tests on purpose, and docs/PARITY.md's deliberate divergences say why.
// Reports list it apart from N/A.
// "adapt" runs as ported for now, and gets a zenius variant in tests/e2e/
// zenius-cases/ if the only failures are the Ego-specific parts.

const HELPERS = "Ego's legacy v1 helpers (useOrCreateTaskSpace, js, gotoAndWait, …)";
const NOT_IN_GUIDE = "which skill guide v2.2.1 leaves out";
const V1 = `uses ${HELPERS}, ${NOT_IN_GUIDE}`;

const table = {
  "environment initialization": ["environment.mjs", "v1", "na", `${V1}; also asserts CDP Runtime.evaluate`],
  "helper surface": ["helper-surface.mjs", "v1", "na", `checks that ${HELPERS} are installed; skill guide v2.2.1 leaves them out`],
  "task spaces and control": ["task-space.mjs", "v1", "na", `${V1}; its v2 lifecycle part (handOff, takeover, finish receipts, claim) is covered by "zen-eval: v2 control lifecycle"`],
  "TaskSpace profile selection": ["profile-selection.mjs", "v2", "run"],
  "v2 cross-space routing": ["task-space.mjs", "v2", "run"],
  "navigation helpers": ["navigation.mjs", "v1", "na", V1],
  "observation helpers": ["observation.mjs", "v1", "na", `${V1}; also uses CDP Network.enable`],
  "pointer and scroll helpers": ["pointer.mjs", "v1", "na", V1],
  "keyboard and file helpers": ["keyboard.mjs", "v1", "na", V1],
  "keyboard regression": ["keyboard-regression.mjs", "v1", "na", V1],
  "wait, fetch, cdp, js, help": ["runtime.mjs", "v1", "na", `${V1}; also asserts CDP`],
  "runtime regression": ["runtime-regression.mjs", "v1", "na", V1],
  "target-scoped event isolation": ["event-isolation.mjs", "v1", "na", `${V1}; also reads CDP Network events`],
  "page labels: create": ["page-labels.mjs", "v2+obs", "adapt", "opens an unknown-origin tab with legacy openOrReuseTab"],
  "page labels: restore and reuse": ["page-labels.mjs", "v2+obs", "adapt", "observes tabs with legacy listTabs"],
  "page labels: close and do not reuse": ["page-labels.mjs", "v2+obs", "adapt", "closes a tab behind the SDK's back with legacy closeTab"],
  "page labels: persist before hard stop": ["page-labels.mjs", "v2", "run"],
  "page labels: restore after hard stop": ["page-labels.mjs", "v2", "run"],
  "page inventory and budget": ["page-labels.mjs", "v2+obs", "adapt", "sets EGO_BROWSER_PAGE_BUDGET, which the zenius SDK doesn't read yet; legacy listTabs"],
  "page adoption and release": ["page-labels.mjs", "v2+obs", "adapt", "observes tabs with legacy listTabs"],
  "page basic operations": ["page-labels.mjs", "v2+cdp", "adapt", "legacy currentTab for Page activation; page.cdp/task.cdp assertions"],
  "page complex evaluate": ["page-labels.mjs", "v2+obs", "adapt", "legacy currentTab for Page activation"],
  "page fetch": ["page-labels.mjs", "v2+obs", "adapt", "legacy currentTab for Page activation"],
  "page actions and popup adoption": ["page-labels.mjs", "v2+ledger", "adapt", "legacy currentTab; reads Ego's ledger file"],
  "Page action popup receipts": ["page-action-latency.mjs", "v2", "run"],
  "Page action idle fail-fast": ["page-action-latency.mjs", "v2", "run"],
  "Page click hit target": ["page-click-hit-target.mjs", "v2", "run"],
  "Page action motion tolerance": ["page-action-motion.mjs", "v2", "run"],
  "Page drag and canvas drawing": ["page-drag-and-draw.mjs", "v2", "run"],
  "Page JavaScript dialog handling": ["page-dialogs.mjs", "v2+cdp", "adapt", "one row asserts that raw Page.getFrameTree fails fast during a dialog"],
  "Page media playback": ["page-media-playback.mjs", "v2", "run"],
  "Page scrolled screenshot": ["page-screenshot.mjs", "v2", "run"],
  "Page default screenshot path: first run": ["page-default-screenshot-path.mjs", "v2+obs", "run", "sets globalThis.EGO_BROWSER_OUTPUT_DIR, which the zenius SDK reads under that name"],
  "Page default screenshot path: second run": ["page-default-screenshot-path.mjs", "v2+obs", "run", "sets globalThis.EGO_BROWSER_OUTPUT_DIR, which the zenius SDK reads under that name"],
  "Page snapshot locator quality": ["page-snapshot-locators.mjs", "v2", "run"],
  "Page snapshot iframe viewport": ["page-snapshot-subtree.mjs", "v2+cdp", "adapt", "asserts the cross-origin frame is an OOPIF through task.cdp Target.getTargets"],
  "Page snapshot subtree": ["page-snapshot-subtree.mjs", "v2", "run"],
  "Page auto-scroll past a wheel trap": ["page-wheel-trap.mjs", "v2", "run"],
  "Page snapshot viewport overflow hint": ["page-snapshot-viewport-overflow.mjs", "v2", "run"],
  "Page ref identity across partial snapshots": ["page-ref-identity.mjs", "v2", "run"],
  "Page refs across rounds: prepare": ["page-ref-identity.mjs", "v2", "run"],
  "Page refs across rounds: resume": ["page-ref-identity.mjs", "v2", "run"],
  "Page refs in dialog workflows": ["page-ref-workflows.mjs", "v2", "run"],
  "Page refs after failed actions: prepare": ["page-ref-workflows.mjs", "v2", "run"],
  "Page refs after failed actions: resume": ["page-ref-workflows.mjs", "v2", "run"],
  "Page refs after upload: prepare": ["page-ref-workflows.mjs", "v2", "run"],
  "Page refs after upload: resume": ["page-ref-workflows.mjs", "v2", "run"],
  "Page snapshot lazy iframe": ["page-snapshot-subtree.mjs", "v2", "run"],
  "Page snapshot sibling iframes": ["page-snapshot-subtree.mjs", "v2", "run"],
  "Page snapshot nested iframes": ["page-snapshot-subtree.mjs", "v2", "run"],
  "Page snapshot replaced iframe": ["page-snapshot-subtree.mjs", "v2", "run"],
  "Page open Shadow DOM locators": ["page-shadow-dom.mjs", "v2", "run"],
  "Page text locators": ["page-text-locators.mjs", "v2", "run"],
  "Page Playwright selector compatibility": ["page-selector-compatibility.mjs", "v2", "run"],
  "Page popup waiter and URL diagnostic": ["page-popup-waiter.mjs", "v2", "run"],
  "Page download lifecycle": ["page-download.mjs", "v2", "run"],
  "Concurrent TaskSpace downloads": ["page-download.mjs", "v2", "run"],
  "Concurrent Page downloads: slow response": ["page-download.mjs", "v2", "run"],
  "Page Chromium PDF viewer download": ["page-download.mjs", "chromium", "na", "drives Chromium's PDF viewer (cr-icon-button#save); Zen shows PDFs in pdf.js, covered by \"zen-eval: pdf.js viewer download\""],
  "Page download across rounds: prepare": ["page-download.mjs", "v2", "run"],
  "Page download across rounds: resume": ["page-download.mjs", "v2", "run"],
  "Page OOPIF actions": ["page-oopif.mjs", "v2+cdp", "adapt", "finds the frame target through task.cdp Target.getTargets"],
  "Page OOPIF restore and close": ["page-oopif.mjs", "v2+cdp", "adapt", "finds the frame target through task.cdp Target.getTargets"],
  "Page load states": ["page-load-states.mjs", "v2+cdp", "adapt", "reads console events through page.cdp (egoAutomated.disable, Runtime.enable), task.cdp Target.getTargets and Ego's ledger file"],
  "Page automation hooks": ["page-automation-hooks.mjs", "cdp", "na", "tests Ego's egoAutomated CDP domain"],
  "Page dedicated Worker startup": ["page-workers.mjs", "v2", "run"],
  "Page AudioWorklet startup": ["page-workers.mjs", "v2", "run"],
  "Page SharedWorker startup": ["page-workers.mjs", "v2", "run"],
  "Page Service Worker startup": ["page-workers.mjs", "v2", "differs", "zenius refuses service worker registration in an agent task's pages: the registration would outlive the task and control the user's own tabs on the site; \"zen-eval: a task's service worker is refused\" checks the refusal"],
  "Page API alignment": ["page-api-alignment.mjs", "v2", "run"],
  "Page actionability": ["page-actionability.mjs", "v2", "run"],
  "Page evaluate timeout recovery": ["page-evaluate-timeout.mjs", "v2+obs", "run", "sets EGO_BROWSER_RESPONSE_TIMEOUT_MS, which the zenius SDK reads under that name"],
  "Page pending navigation: same process": ["page-pending-navigation.mjs", "v2+cdp", "adapt", "starts the held navigation with page.cdp Page.navigate; also EGO_BROWSER_RESPONSE_TIMEOUT_MS"],
  "Page pending navigation: fresh process": ["page-pending-navigation.mjs", "v2+obs", "run", "sets EGO_BROWSER_RESPONSE_TIMEOUT_MS, which the zenius SDK reads under that name"],
  "Page pending navigation: evaluate and screenshot": ["page-pending-navigation.mjs", "v2+cdp", "adapt", "starts the held navigation with page.cdp Page.navigate"],
  "Page delayed popup: schedule": ["page-delayed-popup.mjs", "v2+ledger", "adapt", "reads Ego's ledger file to find the late popup"],
  "Page delayed popup: resume": ["page-delayed-popup.mjs", "v2+ledger", "adapt", "reads Ego's ledger file"],
  "v1 and v2 action parity": ["workflow-chains.mjs", "v1", "na", `compares v2 actions with ${HELPERS}, ${NOT_IN_GUIDE}`],
  "portable keyboard workflow": ["workflow-chains.mjs", "v2", "run"],
  "Page keyboard interface": ["page-keyboard.mjs", "v2", "run"],
  "pure CDP workflow": ["workflow-chains.mjs", "cdp", "na", "drives a page only through raw CDP (SPEC §2: no CDP emulation)"],
  "snapshot workflow": ["workflow-chains.mjs", "v2", "run"],
  "visual workflow": ["workflow-chains.mjs", "v2", "run"],
  // zen-eval's own cases (tests/e2e/zen-cases/), not part of Ego's suite.
  "zen-eval: v2 control lifecycle": ["zen-cases/control-lifecycle.mjs", "v2", "run"],
  "zen-eval: v2 checks from N/A cases": ["zen-cases/v2-na-coverage.mjs", "v2", "run"],
  "zen-eval: pdf.js viewer download": ["zen-cases/pdfjs-download.mjs", "gecko", "run", "drives Firefox's pdf.js viewer; zenius only, the counterpart of Ego's Page Chromium PDF viewer download"],
  "zen-eval: a task's service worker is refused": ["zen-cases/service-worker-refused.mjs", "v2", "run", "zenius only, the counterpart of Ego's Page Service Worker startup: zenius refuses service workers and Cache Storage writes in a task's pages"],
};

export function caseInfo(name) {
  const row = table[name];
  if (!row) return { file: "?", category: "unknown", zenius: "run", reason: "not classified yet" };
  const [file, category, zenius, reason] = row;
  return { file, category, zenius, reason };
}

/** Whether rubric A counts the case: neither N/A nor a deliberate difference. */
export function countsForRubric(name) {
  const zenius = table[name]?.[2] ?? "run";
  return zenius !== "na" && zenius !== "differs";
}

export const MANIFEST = table;
