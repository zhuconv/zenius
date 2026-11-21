// Portions adapted from citrolabs/ego-lite (MIT License).
// The patch sources quote package/ego-browser/scripts/real-browser-e2e/cases/ at tag v2.2.1.
// How Ego's "adapt" cases (tests/e2e/manifest.mjs) run on zenius. Ego's v1 tab
// helpers and its ledger file have test-only stand-ins in source.mjs; what
// those can't cover is changed here, case by case, by exact-string patches
// with the reason for each. tests/unit checks that every patch still matches
// its case exactly once, so a changed case can't silently drop a patch.

export const ZENIUS_ADAPTATIONS = {
  "page actions and popup adoption": {
    reason:
      "The case deletes the popup from Ego's Page ledger file, to simulate an action receipt that missed it, and expects task.tabs() to adopt it again. zenius registers popups when their tabs open, and by decision doesn't re-adopt untracked tabs by their opener: that could claim a tab the user opened from an agent page, which finish() would then close (docs/PARITY.md). So on zenius the case skips the simulation and runs its remaining checks on the popup as registered.",
    patches: [
      [
        "    // Simulate the action-receipt window missing this otherwise real popup.\n    // tabs must discover the live target independently and restore a\n    // managed label; popup lifecycle cannot depend on the short receipt diff.\n    const ledgerPath = await pageLedgerPath(task.spaceId);\n    const ledger = JSON.parse(await readFile(ledgerPath, \"utf8\"));\n    delete ledger.pages[popup.label];\n    await writeFile(ledgerPath, JSON.stringify(ledger));",
        "    // zenius registers a popup when its tab opens, not from a receipt diff,\n    // and doesn't re-adopt untracked tabs by their opener (a deliberate\n    // divergence, docs/PARITY.md). So there is no missed popup to simulate:\n    // the checks below run on the popup as zenius registered it.",
      ],
      [
        "assert(Boolean(reconciledPopup?.label), \"tabs adopts a popup missed by action receipts\");",
        "assert(Boolean(reconciledPopup?.label), \"tabs lists the popup as a managed Page\");",
      ],
    ],
  },
  "page basic operations": {
    reason:
      "The case checks page.cdp() and task.cdp() themselves. zenius has no CDP (a PARITY divergence), so on zenius those two checks become: both calls fail with ZEN_UNSUPPORTED.",
    patches: [
      [
        "const cdpTitle = await first.cdp(\n      \"Runtime.evaluate\",\n      { expression: \"document.title\", returnByValue: true },\n      { timeout: 2_000 }\n    );\n    assertEqual(cdpTitle.result.value, \"ego-lite helper e2e\", \"page.cdp uses the addressed Page session\");\n    const targetList = await task.cdp(\"Target.getTargets\", {}, { timeout: 2_000 });\n    assert(Array.isArray(targetList.targetInfos), \"task.cdp sends Target commands inside the task space\");",
        "// zenius has no CDP (a PARITY divergence): page.cdp and task.cdp say so.\n    for (const [label, call] of [\n      [\"page.cdp\", () => first.cdp(\"Runtime.evaluate\", { expression: \"document.title\", returnByValue: true }, { timeout: 2_000 })],\n      [\"task.cdp\", () => task.cdp(\"Target.getTargets\", {}, { timeout: 2_000 })],\n    ]) {\n      let cdpError;\n      try {\n        await call();\n      } catch (error) {\n        cdpError = error;\n      }\n      assertEqual(cdpError?.code, \"ZEN_UNSUPPORTED\", label + \" is not supported on zenius\");\n    }",
      ],
    ],
  },
  "Page JavaScript dialog handling": {
    reason:
      "One of the calls that must name the open dialog is a raw CDP Page.getFrameTree. zenius has no CDP, so that entry is dropped; snapshot and screenshot keep the check.",
    patches: [
      [
        "[\"raw Page.getFrameTree\", () => page.cdp(\"Page.getFrameTree\", {})],",
        "",
      ],
    ],
  },
  "Page snapshot iframe viewport": {
    reason:
      "The cross-origin mode checks with CDP's Target.getTargets that the iframe is an OOPIF. On zenius the check asks the dev runtime whether that frame runs in another process than its Page.",
    patches: [
      [
        "const targets = (await task.cdp(\"Target.getTargets\")).targetInfos;\n          assert(\n            targets.some((target) =>\n              target.type === \"iframe\" &&\n              target.parentId === page.targetId &&\n              target.url.includes(\"/snapshot-subtree-frame-content\")\n            ),\n            \"the cross-origin fixture runs in an OOPIF target\"\n          );",
        "const oopFrame = await __zenFrame(page, \"/snapshot-subtree-frame-content\");\n          assert(oopFrame?.oop === true, \"the cross-origin fixture runs in an OOPIF target\");",
      ],
    ],
  },
  "Page OOPIF actions": {
    reason:
      "The case finds the cross-site iframe with CDP's Target.getTargets and reads its DOM with Ego's js(code, targetId). On zenius both go through the dev runtime: __zenFrame finds the frame by URL and js() runs code in it.",
    patches: [
      [
        "const frame = (await task.cdp(\"Target.getTargets\")).targetInfos.find(\n      (target) =>\n        target.type === \"iframe\" &&\n        target.parentId === page.targetId &&\n        target.url.includes(\"/frame.html\")\n    )?.targetId;",
        "const frame = await __zenFrame(page, \"/frame.html\");",
      ],
    ],
  },
  "Page OOPIF restore and close": {
    reason:
      "The case finds the cross-site iframe with CDP's Target.getTargets and reads its DOM with Ego's js(code, targetId). On zenius both go through the dev runtime: __zenFrame finds the frame by URL and js() runs code in it.",
    patches: [
      [
        "const frame = (await task.cdp(\"Target.getTargets\")).targetInfos.find(\n      (target) =>\n        target.type === \"iframe\" &&\n        target.parentId === page.targetId &&\n        target.url.includes(\"/frame.html\")\n    )?.targetId;",
        "const frame = await __zenFrame(page, \"/frame.html\");",
      ],
    ],
  },
  "Page load states": {
    reason:
      "Three changes. The case turns on console events in Ego's CDP session (egoAutomated.disable, Runtime.enable), which zenius captures without being asked, so those calls go. It finds the slow cross-process iframe with CDP's Target.getTargets; on zenius the dev runtime finds it (__zenFrame), and js() reads its readyState.",
    patches: [
      [
        "await page.cdp(\"egoAutomated.disable\");\n    await page.cdp(\"Runtime.enable\");",
        "// zenius captures console messages without being asked.",
      ],
      [
        "await busyPage.cdp(\"egoAutomated.disable\");\n    await busyPage.cdp(\"Runtime.enable\");\n    await quietPage.cdp(\"Runtime.enable\");",
        "// zenius captures console messages without being asked.",
      ],
      [
        "const slowFrameTarget = (await task.cdp(\"Target.getTargets\")).targetInfos.find(\n      (target) =>\n        target.type === \"iframe\" && target.url.includes(\"/slow-frame?ms=800\")\n    )?.targetId;",
        "const slowFrameTarget = await __zenFrame(oopifPage, \"/slow-frame?ms=800\");",
      ],
    ],
  },
  "Page pending navigation: same process": {
    reason:
      "The case leaves a navigation pending with a raw CDP Page.navigate, which goto never sees. On zenius a script navigation (location.href) does the same: zenius's navigation tracker sees navigations it didn't start.",
    patches: [
      [
        ".cdp(\"Page.navigate\", { url: heldUrl + suffix }, { timeout: 500 })",
        ".evaluate((url) => { location.href = url; }, heldUrl + suffix)",
      ],
      [
        ".cdp(\"Page.navigate\", { url: heldUrl + \"&fresh=1\" }, { timeout: 500 })",
        ".evaluate((url) => { location.href = url; }, heldUrl + \"&fresh=1\")",
      ],
    ],
  },
  "Page pending navigation: evaluate and screenshot": {
    reason:
      "As in the same-process round: a script navigation (location.href) leaves the navigation pending instead of a raw CDP Page.navigate.",
    patches: [
      [
        ".cdp(\"Page.navigate\", { url: heldUrl + suffix }, { timeout: 500 })",
        ".evaluate((url) => { location.href = url; }, heldUrl + suffix)",
      ],
    ],
  },
  "page labels: create": {
    reason:
      "On Ego, the v1 cases (N/A on zenius) create the suite space with useOrCreateTaskSpace, " +
      "which starts no Page ledger, so the first newPage gets p1. On zenius the space comes " +
      "from taskSpace(), which starts it with p1 as Ego's own taskSpace() does, so the case " +
      "takes that p1 as its first managed page.",
    patches: [
      [
        'const page = await newPageAt(task, baseUrl + "/?managed=p1");',
        'const page = task.page("p1");\n    await page.goto(baseUrl + "/?managed=p1");',
      ],
    ],
  },
};

// The isolated world. In the candidate, the agent's page code (page.evaluate,
// page.waitForFunction) runs in a sandbox that sees the page's DOM but not its
// JavaScript objects, as a WebExtension content script does. These cases read
// a fixture page's own objects, which tests/fixtures/server.mjs sets, only to
// observe the fixture. They don't test the API. So on zenius those reads run in
// the page's own world through the dev runtime: __zenPageWorld and
// __zenWaitPageWorld in tests/e2e/source.mjs, as Ego's v1 js() already does.
// Ego runs the cases unchanged.
//
// Each entry is [the start of the call, how many times it occurs in the case
// body]. Only the call's head changes: `<page>.evaluate(` becomes
// `__zenPageWorld(<page>, ` and `<page>.waitForFunction(` becomes
// `__zenWaitPageWorld(<page>, `. tests/unit checks three things:
// - every SDK call that reads one of FIXTURE_OBJECTS is moved;
// - every moved call reads one;
// - there are 24 of them.
//
// The one call that wraps a page prototype ("page actions and popup adoption",
// Element.prototype.scrollIntoView) needs no move. It checks that actions
// don't call the site's implementation, which holds in either world.
export const FIXTURE_OBJECTS = [
  "__fixtureState",
  "__mediaWorkbench",
  "__pointerWorkbench",
  "__wheelEvents",
  "__visualClicks",
  "__visualTrusted",
  "__clicked",
];

export const ZENIUS_FIXTURE_READS = {
  "page labels: restore and reuse": [
    ['page.evaluate("window.__fixtureState.', 3],
    ['page.evaluate(() => {\n      const select = document.createElement("select");', 1],
  ],
  "page basic operations": [['first.evaluate("window.__fixtureState.', 1]],
  "Page drag and canvas drawing": [["page.evaluate(() => window.__pointerWorkbench.read()", 2]],
  "Page media playback": [
    ["page.evaluate(() => window.__mediaWorkbench.read()", 6],
    ["page.waitForFunction(\n      () => window.__mediaWorkbench.read()", 2],
  ],
  "Page snapshot subtree": [['page.evaluate("window.__fixtureState.', 1]],
  "Page auto-scroll past a wheel trap": [
    [
      'page.evaluate(() => ({\n        scrollY,\n        value: document.querySelector("#target").value,\n        wheelEvents: window.__wheelEvents,',
      1,
    ],
  ],
  "Page Playwright selector compatibility": [["page.evaluate(() => window.__fixtureState.", 2]],
  "snapshot workflow": [
    ['first.evaluate("window.__fixtureState.', 1],
    ['second.evaluate("window.__fixtureState.', 2],
  ],
  "visual workflow": [["page.evaluate(() => ({\n      clicks: window.__visualClicks,", 1]],
  "zen-eval: v2 checks from N/A cases": [["page.evaluate((k) => window.__fixtureState[k]", 1]],
};

/** `<page>.evaluate(…` → `__zenPageWorld(<page>, …`, and the same for waitForFunction. */
export function toPageWorldCall(from) {
  const m = /^([A-Za-z_$][\w$]*)\.(evaluate|waitForFunction)\(/.exec(from);
  if (!m) throw new Error(`a fixture read starts with <page>.evaluate( or <page>.waitForFunction(: ${from.slice(0, 80)}`);
  const head = m[2] === "evaluate" ? "__zenPageWorld" : "__zenWaitPageWorld";
  return `${head}(${m[1]}, ${from.slice(m[0].length)}`;
}

/** The case body to run on zenius: patched if the case has an adaptation, and its fixture reads moved. */
export function adaptForZenius(name, body) {
  let out = body;
  for (const [from, to] of ZENIUS_ADAPTATIONS[name]?.patches ?? []) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`zenius adaptation for "${name}" matches ${count} times: ${from.slice(0, 80)}`);
    out = out.replace(from, () => to);
  }
  for (const [from, times] of ZENIUS_FIXTURE_READS[name] ?? []) {
    const count = out.split(from).length - 1;
    if (count !== times) throw new Error(`zenius fixture read for "${name}" matches ${count} times, not ${times}: ${from.slice(0, 80)}`);
    out = out.replaceAll(from, () => toPageWorldCall(from));
  }
  return out;
}
