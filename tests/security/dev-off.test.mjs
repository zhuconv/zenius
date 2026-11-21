// SPEC §3.9 I5: dev.* methods exist only on dev profiles. tests/security/run.sh
// runs this after restarting its instance with ZENIUS_DEV_METHODS=0, which
// sets zenius.dev to false, as live runs and the user's daily Zen have it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as S from "./lib.mjs";

// Every dev method the runtime defines, so one added later is probed too.
const source = readFileSync(new URL("../../runtime/JS/zenius/methods/dev.sys.mjs", import.meta.url), "utf8");
const DEV_METHODS = [...new Set([...source.matchAll(/^\s*"(dev\.[A-Za-z0-9]+)"\s*:/gm)].map((match) => match[1]))];

test("the probe finds the runtime's dev methods", () => {
  assert.ok(DEV_METHODS.includes("dev.evalChrome") && DEV_METHODS.includes("dev.evalContent"), `found ${DEV_METHODS.join(", ")}`);
});

test("no dev.* method answers while zenius.dev is off", async () => {
  assert.ok((await S.call("browser.version")).runtimeVersion, "the instance answers other methods");
  const space = await S.newSpace("dev off");
  try {
    for (const method of [...DEV_METHODS, "dev.anything"]) {
      const answer = S.asAttempt(await S.raw(method, { code: "return Services.appinfo.name", space, page: "p1" }));
      assert.equal(answer.ok, false, `${method} must not exist with zenius.dev off, but it returned ${JSON.stringify(answer.value)}`);
      assert.equal(answer.code, "ZEN_UNSUPPORTED", `${method}: ${answer.code} ${answer.message}`);
    }
  } finally {
    await S.endSpace(space);
  }
});

test("without the dev channel, goto still refuses forbidden schemes", async () => {
  const planted = S.plant();
  try {
    const out = await S.run(
      `console.log(JSON.stringify(await Promise.all(A.urls.map((url) => attempt(() => page.goto(url, { timeout: 5000 }))))));`,
      { name: "dev off goto", arg: { urls: [`file://${planted.secret}`, "about:config", "chrome://browser/content/browser.xhtml"] } },
    );
    for (const result of out) assert.equal(result.code, "ZEN_URL_NOT_ALLOWED", `${result.code}: ${result.message}`);
  } finally {
    planted.cleanup();
  }
});
