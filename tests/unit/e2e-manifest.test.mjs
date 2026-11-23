// Every e2e case is classified for rubric A, and N/A always says why.
import assert from "node:assert/strict";
import test from "node:test";

import { e2eCases } from "../e2e/cases/index.mjs";
import { MANIFEST, caseInfo } from "../e2e/manifest.mjs";
import { EGO_API } from "../e2e/parity.mjs";
import { egoSource, toZeniusSource, zeniusNames } from "../e2e/source.mjs";
import { FIXTURE_OBJECTS, ZENIUS_ADAPTATIONS, ZENIUS_FIXTURE_READS, adaptForZenius } from "../e2e/zen-adapt.mjs";
import { zenEvalCases } from "../e2e/zen-cases/index.mjs";

test("the manifest classifies exactly the suite's cases", () => {
  const names = [...e2eCases, ...zenEvalCases].map((c) => c.name);
  assert.equal(e2eCases.length, 83, "Ego v2.2.1 has 83 cases");
  assert.deepEqual(Object.keys(MANIFEST).sort(), [...names].sort());
});

test("N/A and adapt entries carry a reason", () => {
  for (const name of Object.keys(MANIFEST)) {
    const info = caseInfo(name);
    assert.ok(["run", "na", "adapt", "differs"].includes(info.zenius), name);
    if (info.zenius !== "run" || info.category !== "v2") assert.ok(info.reason, `${name} needs a reason`);
  }
});

test("Ego's error codes and names map to zenius's; its knobs keep their names", () => {
  const out = toZeniusSource(
    'EGO_SELECTOR_AMBIGUOUS process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS "[ego-browser:pages]" cliLog("x") /^ego-browser-shot-\\d{6}\\.png$/'
  );
  assert.match(out, /\/\^zenius-shot-/);
  assert.match(out, /ZEN_SELECTOR_AMBIGUOUS/);
  // The zenius SDK reads EGO_BROWSER_* under Ego's names (sdk/src/page.ts).
  assert.match(out, /process\.env\.EGO_BROWSER_RESPONSE_TIMEOUT_MS/);
  assert.match(out, /\[zenius:pages\]/);
  assert.match(out, /__zenEvalLog\("x"\)/);
  assert.ok(!/\bEGO_(?!BROWSER_)/.test(out));
});

test("the parity list matches Ego's 74 public API entries", () => {
  assert.equal(EGO_API.length, 74);
  assert.equal(new Set(EGO_API).size, 74);
});

test("each zenius adaptation patches an adapt case, every patch exactly once", () => {
  for (const [name, adaptation] of Object.entries(ZENIUS_ADAPTATIONS)) {
    const testCase = e2eCases.find((c) => c.name === name);
    assert.ok(testCase, `${name} is a case`);
    assert.equal(caseInfo(name).zenius, "adapt", `${name} is an adapt case`);
    assert.ok(adaptation.reason, `${name} says why`);
    const body = testCase.body();
    for (const [from] of adaptation.patches) assert.equal(body.split(from).length - 1, 1, `${name}: ${from}`);
    assert.notEqual(adaptForZenius(name, body), body);
  }
});

test("zenius sources get the v1 stand-ins and still compile; expected text gets names only", () => {
  const source = toZeniusSource(egoSource('await openOrReuseTab("about:blank"); assert((await listTabs()).length > 0, "x");', {
    taskName: "t",
    target: "zenius",
    zeniusInstance: "zen-eval",
    zeniusRpcModule: "/nowhere/rpc.mjs",
  }));
  for (const name of ["listTabs", "currentTab", "openOrReuseTab", "closeTab", "readPageLedger", "__zenPageWorld", "__zenWaitPageWorld"]) {
    assert.match(source, new RegExp(`async function ${name}\\(`));
  }
  const AsyncFunction = (async () => {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(source));
  assert.equal(zeniusNames("[ego-browser:pages]"), "[zenius:pages]");
});

// The text of each call whose head matches `head` (a global regex ending at
// its "("), through the matching ")". Strings and template literals are
// skipped, which is enough for the cases' code.
function callsIn(body, head) {
  const out = [];
  let m;
  while ((m = head.exec(body))) {
    const open = m.index + m[0].length - 1;
    let depth = 1;
    let i = open + 1;
    for (; i < body.length && depth > 0; i++) {
      const c = body[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < body.length && body[i] !== c; i += body[i] === "\\" ? 2 : 1);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      if (c === ")" || c === "]" || c === "}") depth--;
    }
    out.push(body.slice(m.index, i));
  }
  return out;
}

test("on zenius, the SDK reads of a fixture page's own objects go to the page's world, all of them and only them", () => {
  const fixture = new RegExp(`\\b(${FIXTURE_OBJECTS.join("|")})\\b`);
  const all = [...e2eCases, ...zenEvalCases];
  for (const name of Object.keys(ZENIUS_FIXTURE_READS)) assert.ok(all.some((c) => c.name === name), `${name} is a case`);
  let moved = 0;
  for (const c of all) {
    const body = adaptForZenius(c.name, c.body());
    for (const call of callsIn(body, /[A-Za-z_$][\w$]*\s*\.\s*(?:evaluate|waitForFunction)\s*\(/g)) {
      assert.ok(!fixture.test(call), `${c.name}: an SDK call still reads a fixture object: ${call.slice(0, 100)}`);
    }
    for (const call of callsIn(body, /__zen(?:Wait)?PageWorld\s*\(/g)) {
      assert.ok(fixture.test(call), `${c.name}: a call moved to the page's world reads no fixture object: ${call.slice(0, 100)}`);
      moved++;
    }
  }
  // The fixture reads counted when page code moved to an isolated world.
  assert.equal(moved, 24);
});
