// Every error code and refused kind an agent can get has a help entry that
// says what to do next, and every error's message carries that next step.
// The scans read the runtime's sources, so a new code or kind can't skip
// sdk/src/error-guide.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CODE_GUIDE, REFUSAL_GUIDE, codeHelp, nextStep, SANDBOX_BLOCKED_NEXT } from "../src/error-guide.ts";
import { fromWireError, isHardStopCode, ZEN_ERROR_CODES, ZeniusError } from "../src/errors.ts";
import { helpText } from "../src/help.ts";
import { hasHardStop } from "../src/output.ts";
import { EGO_ERROR_CODES } from "./fixtures/ego-error-codes.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNTIME = join(ROOT, "runtime", "JS", "zenius");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ext) : ext.test(name) ? [path] : [];
  });
}

const runtimeSources = files(RUNTIME, /\.m?js$/).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const sdkSources = files(join(ROOT, "sdk", "src"), /\.ts$/).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** The runtime's ErrorCodes list (modules/errors.sys.mjs). */
function runtimeCodes(): string[] {
  const text = readFileSync(join(RUNTIME, "modules", "errors.sys.mjs"), "utf8");
  const list = /export const ErrorCodes = [\s\S]*?\]\.map/.exec(text)?.[0] ?? "";
  return [...list.matchAll(/"(ZEN_[A-Z_]+)"/g)].map((match) => match[1]!);
}

/** Codes named where an error is made: new ZenError("…"), plain("…"), new ZeniusError("…"). */
function raisedCodes(sources: { text: string }[], pattern: RegExp): Set<string> {
  return new Set(sources.flatMap(({ text }) => [...text.matchAll(pattern)].map((match) => match[1]!)));
}

/** Every literal kind the runtime reports: reportRefused(browser, "kind", …), a ternary of kinds, and content's report("kind", …). */
function refusedKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const { path, text } of runtimeSources) {
    for (const match of text.matchAll(/reportRefused\(\s*[^,()]+,\s*([^,]+),/g)) {
      for (const literal of match[1]!.matchAll(/"([a-zA-Z]+)"/g)) kinds.add(literal[1]!);
    }
    if (path.endsWith(join("content", "refusals.sys.mjs"))) {
      for (const match of text.matchAll(/\breport\(\s*"([a-zA-Z]+)"/g)) kinds.add(match[1]!);
    }
  }
  return kinds;
}

const missing = (names: Iterable<string>, table: Record<string, unknown>) => [...names].filter((name) => !Object.hasOwn(table, name)).sort();

describe("help(\"errors\")", () => {
  it("has an entry for every code the runtime lists or raises and every code the SDK raises", () => {
    const listed = runtimeCodes();
    assert.ok(listed.length > 30, `found only ${listed.length} codes in errors.sys.mjs`);
    const raised = raisedCodes(runtimeSources, /(?:new ZenError|plain)\(\s*"(ZEN_[A-Z_]+)"/g);
    const sdk = raisedCodes(sdkSources, /new ZeniusError\(\s*"(ZEN_[A-Z_]+)"/g);
    assert.ok(raised.size > 20 && sdk.size > 3);
    const hint = "add it to CODE_GUIDE in sdk/src/error-guide.ts: what happened and what to do next";
    assert.deepEqual(missing(listed, CODE_GUIDE), [], `codes in errors.sys.mjs without a help entry: ${hint}`);
    assert.deepEqual(missing(raised, CODE_GUIDE), [], `codes the runtime raises without a help entry: ${hint}`);
    assert.deepEqual(missing(sdk, CODE_GUIDE), [], `codes the SDK raises without a help entry: ${hint}`);
    // A code the runtime raises but doesn't list turns into ZEN_INTERNAL.
    assert.deepEqual([...raised].filter((code) => !listed.includes(code)), []);
    assert.deepEqual([...ZEN_ERROR_CODES], Object.keys(CODE_GUIDE));
  });

  it("has an entry for every kind of UI the runtime refuses", () => {
    const kinds = refusedKinds();
    assert.ok(kinds.size > 15, `found only ${[...kinds].join(", ")}`);
    assert.deepEqual(missing(kinds, REFUSAL_GUIDE), [], "refused kinds without a help entry: add them to REFUSAL_GUIDE in sdk/src/error-guide.ts");
  });

  it("uses Ego's code wherever Ego has the same failure", () => {
    // Ego's codes, vendored: refs/ is gitignored, so no test reads it
    // (sdk/scripts/update-ego-codes.mjs regenerates the list from it).
    const ego = new Set(EGO_ERROR_CODES);
    assert.ok(ego.size > 20, `only ${ego.size} Ego codes in fixtures/ego-error-codes.ts`);
    for (const [code, guide] of Object.entries(CODE_GUIDE)) {
      if (guide.ego) {
        assert.ok(ego.has(guide.ego), `${code}'s Ego code ${guide.ego} isn't one of Ego's`);
        assert.equal(guide.ego, code.replace(/^ZEN_/, "EGO_"));
      }
      // An Ego code that zenius has too must say so.
      if (ego.has(code.replace(/^ZEN_/, "EGO_"))) assert.ok(guide.ego, `${code} is Ego's ${code.replace(/^ZEN_/, "EGO_")}`);
    }
  });

  it("lists every code and refused kind, each with what to do next, and prints one code alone", () => {
    const text = helpText("errors");
    for (const [code, guide] of Object.entries(CODE_GUIDE)) {
      const entry = new RegExp(`^${code}(?: \\(.*\\))?\\n  .+\\n  Next: .+$`, "m");
      assert.match(text, entry, code);
      assert.ok(guide.what.length > 0 && guide.next.length > 0);
    }
    for (const kind of Object.keys(REFUSAL_GUIDE)) assert.match(text, new RegExp(`^${kind}\\n  .+\\n  Next: .+$`, "m"), kind);
    assert.equal(
      helpText("ZEN_REF_STALE"),
      "ZEN_REF_STALE\n  The ref came from a snapshot of a document that's gone: the page navigated or re-rendered.\n  Next: Take a new snapshot() and use its refs.",
    );
    assert.match(helpText("ZEN_PAGE_UNRESPONSIVE"), /^ZEN_PAGE_UNRESPONSIVE \(Ego: EGO_PAGE_UNRESPONSIVE\)\n/);
    assert.match(helpText(), /help\("errors"\) lists every error code and refused kind/);
  });
});

describe("an error's message", () => {
  it("says what happened, then what to do next on a line of its own", () => {
    const error = fromWireError({ code: "ZEN_SELECTOR_NOT_FOUND", message: 'selector "#x" matched 0 elements' }, "page.click") as ZeniusError;
    assert.equal(error.code, "ZEN_SELECTOR_NOT_FOUND");
    assert.equal(
      error.message,
      'page.click: selector "#x" matched 0 elements\nTake a snapshot() and target what it shows, by ref or by role and name; if the element is still to come, waitForSelector() first.',
    );
    // An argument error points at the failed method's help.
    assert.equal(
      fromWireError({ code: "ZEN_INVALID_ARGUMENT", message: "timeout must be a number" }, "page.click").message,
      'page.click: timeout must be a number\nFix the call: help("page.click") prints its signature and options.',
    );
  });

  it("after a dialog that opened during the call, says to check before repeating; before the call, nothing more", () => {
    // The runtime's two messages (observe/messages.sys.mjs dialogOpened), word for word.
    const during =
      'a JavaScript alert dialog ("saved") opened while page.selectOption was running; handle it with page.acceptDialog() or page.dismissDialog() before continuing';
    assert.equal(
      fromWireError({ code: "ZEN_PAGE_DIALOG_OPENED", message: during }, "page.selectOption").message,
      `page.selectOption: ${during}\nWhat the call did before the dialog opened took effect: after you handle it, check the page with snapshot() before you repeat anything.`,
    );
    const before =
      'page.mouse.click cannot run while a JavaScript alert dialog ("saved") is open; handle it with page.acceptDialog() or page.dismissDialog() before continuing';
    assert.equal(nextStep("ZEN_PAGE_DIALOG_OPENED", before), undefined);
  });

  it("adds nothing when the runtime's message already says what to do, or for the hard stops", () => {
    const stale = "Stale ref: @e5; take a new snapshot";
    assert.equal(fromWireError({ code: "ZEN_REF_STALE", message: stale }, "page.click").message, `page.click: ${stale}`);
    const allowed = "page.goto can't open about:config, an about: URL: agents load only … URLs. If the task needs this page, ask the user to open it.";
    assert.equal(fromWireError({ code: "ZEN_URL_NOT_ALLOWED", message: allowed }, "page.goto").message, allowed);
    const stop = fromWireError({ code: "ZEN_TASK_SPACE_INACTIVE", message: "ended" }, "page.click", false);
    assert.match(stop.message, /^page\.click: This task space is no longer assigned to the agent/);
    assert.ok(!stop.message.includes("A hard stop"), "Ego's own wording only");
    // The user's Stop in Zen (docs/briefs/external-tasks.md) says so, still a hard stop;
    // the agent's own finish() and a closed last tab keep Ego's words.
    for (const reason of ["finished", "closed", undefined]) {
      const ended = fromWireError({ code: "ZEN_TASK_SPACE_INACTIVE", message: "ended", data: { reason } }, "page.click", false);
      assert.match(ended.message, /^page\.click: This task space is no longer assigned to the agent/, String(reason));
    }
    const stopped = fromWireError({ code: "ZEN_TASK_SPACE_INACTIVE", message: "The user stopped this task in Zen.", data: { reason: "stopped" } }, "page.click", false);
    assert.match(stopped.message, /^page\.click: The user stopped this task in Zen\. This is a hard stop/);
    assert.match(stopped.message, /don't retry, and don't start another task for the same goal/);
    assert.match(stopped.message, /claimTaskSpace\(spaceId\)/);
    assert.equal(isHardStopCode("ZEN_TASK_SPACE_INACTIVE", { reason: "stopped" }), true);
    // A wrapped message keeps one next step.
    const inner = new ZeniusError("ZEN_INTERNAL", "boom");
    assert.equal(new ZeniusError("ZEN_INTERNAL", inner.message).message, inner.message);
    // Codes it doesn't know pass through unchanged.
    assert.equal(fromWireError({ code: "ZEN_SOMETHING_NEW", message: "new" }, "page.x").message, "page.x: new");
  });

  it("keeps Ego's plain Error and its text, with the next step after it; a certificate warning means handOff", () => {
    const text = "page.goto failed: net::ERR_CERT_AUTHORITY_INVALID. Firefox showed a certificate warning for expired.example (SEC_ERROR_EXPIRED_CERTIFICATE): it can't verify that the site is who it says. An agent can't accept the risk or add an exception; ask the user to check the site.";
    const error = fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: text, data: { plain: true, certificateWarning: true } }, "page.goto");
    assert.equal(error.constructor, Error);
    assert.equal((error as Error & { code?: string }).code, undefined);
    assert.ok(error.message.startsWith(`${text}\n`), error.message);
    assert.match(error.message.split("\n")[1]!, /^Call task\.handOff\(\) and end the round: tell the user which site showed the warning\./);
    // A goto onto a file: the download goes on, so wait for it.
    assert.match(
      fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: "page.goto failed: navigation started a download", data: { plain: true } }, "page.goto").message,
      /^page\.goto failed: navigation started a download\nThis URL downloads a file instead of opening a page: start page\.waitForEvent\("download"\) before page\.goto\(\)/,
    );
    // A load zenius refused: its words say what to do, and the site isn't down.
    const local = "page.goto failed: net::ERR_ACCESS_DENIED. http://172.31.254.1 is a private address on the local network. A task's pages never reach the local network: macOS asks the user before an app does, for their whole browser. If the task needs this host, hand off and ask the user to open it in this tab (task.handOff({ message })), or ask them to do that step in their own tab.";
    assert.equal(fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: local, data: { plain: true, url: "http://172.31.254.1/", error: "localNetwork" } }, "page.goto").message, local);
    const addon = "page.goto failed: The page tried to install an add-on. zenius refused it.";
    const refused = [{ kind: "addonInstall", message: "The page tried to install an add-on. zenius refused it." }];
    assert.equal(fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: addon, data: { plain: true, url: "https://example.test/x.xpi", refused } }, "page.goto").message, addon);
    // Any other failed load: check the URL.
    assert.match(fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: "page.goto failed: net::ERR_NAME_NOT_RESOLVED", data: { plain: true } }, "page.goto").message, /\nCheck the URL\./);
    assert.match(fromWireError({ code: "ZEN_NAVIGATION_FAILED", message: "page.goto failed: net::ERR_NAME_NOT_RESOLVED", data: { plain: true, refused: [] } }, "page.goto").message, /\nCheck the URL\./);
  });

  it("tells takeOver's wait after the user's input from the hard stop: the runtime's words, then wait and retry once", () => {
    const text = "The user is working in task space 7: their last input there was 3.2 s ago, and it stays theirs until 10 s after it.";
    const data = { space: 7, reason: "manual_takeover", userInputMsAgo: 3204, retryAfterMs: 6796 };
    const error = fromWireError({ code: "ZEN_TASK_SPACE_USER_IN_CONTROL", message: text, data }, "takeOverTaskSpace") as ZeniusError;
    assert.equal(error.code, "ZEN_TASK_SPACE_USER_IN_CONTROL");
    assert.equal(
      error.message,
      `takeOverTaskSpace: ${text}\nWait 7 s (error.retryAfterMs), then make the same call once more. ` +
        "If it's refused again, the user is still working there: end the round and tell them what you'll do once they're done.",
    );
    assert.equal((error as ZeniusError & { retryAfterMs?: number }).retryAfterMs, 6796);
    // No hard stop: the round neither records one nor counts the space as ended.
    assert.equal(hasHardStop(), false);
    assert.equal(isHardStopCode(error.code, error.data), false);
    assert.equal(isHardStopCode("ZEN_TASK_SPACE_USER_IN_CONTROL", { reason: "manual_takeover" }), true);
  });

  it("tells the agent's code refused during a hold to wait for the hand back, not to open a new Page", () => {
    const text = "page.evaluate: the user holds a page in this page's window group.";
    const hold = fromWireError({ code: "ZEN_AGENT_CODE_REFUSED", message: text, data: { method: "page.evaluate", page: "p1", reason: "hold", windows: 1 } }, "page.evaluate");
    assert.match(hold.message, /\nThe user holds a page in this window group after your handOff\(\): wait for the hand back with task\.waitForControl\(\), then retry\.$/);
    assert.doesNotMatch(hold.message, /new Page/);
    const group = fromWireError({ code: "ZEN_AGENT_CODE_REFUSED", message: text, data: { method: "page.evaluate", page: "p1", reason: "group", windows: 1 } }, "page.evaluate");
    assert.match(group.message, /task\.newPage\(\)/);
  });

  it("describes no pageWorld refusal: since zen-observe's 95c15a4, code the agent hands the page runs there", () => {
    assert.doesNotMatch(CODE_GUIDE.ZEN_AGENT_CODE_REFUSED!.what, /pageWorld|script element|\beval\b|string timer/);
    const error = fromWireError({ code: "ZEN_AGENT_CODE_REFUSED", message: "page.evaluate: refused.", data: { method: "page.evaluate", page: "p1", reason: "pageWorld" } }, "page.evaluate");
    assert.doesNotMatch(error.message, /Each route has a form that stays in your function/);
  });

  it("tells page code that read a page global to read the DOM instead", () => {
    const error = fromWireError(
      // zen-observe's words, which already say to read the DOM: only the markup tip is added.
      { code: "ZEN_PAGE_GLOBAL_HIDDEN", message: "page.evaluate: the agent's code read appState, which is the page's own JavaScript. zenius runs the agent's code in an isolated world that shares only the page's DOM, so it can't see the page's globals. Read what you need from the DOM: text, attributes, form values.", data: { name: "appState" } },
      "page.evaluate",
    );
    assert.equal((error as ZeniusError).code, "ZEN_PAGE_GLOBAL_HIDDEN");
    assert.match(error.message, /form values\.\nData the page keeps in its markup counts too, such as JSON in a <script> element: JSON\.parse of its textContent\.$/);
    // Words that don't say it get the whole next step.
    const bare = fromWireError({ code: "ZEN_PAGE_GLOBAL_HIDDEN", message: "page.evaluate: the agent's code read appState.", data: { name: "appState" } }, "page.evaluate");
    assert.match(bare.message, /\nRead the DOM instead: text, attributes, form state/);
    assert.match(CODE_GUIDE.ZEN_PAGE_GLOBAL_HIDDEN!.what, /sees the page.s DOM but not its JavaScript/);
  });

  it("passes the user's page-code refusals on as zen-observe words them, with their data on the error", () => {
    // zen-observe's five messages (observe/pagecode.sys.mjs), each with its next step.
    const site = "https://shop.example.com";
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["ZEN_PAGE_CODE_OFF", "page.evaluate: the user has turned off agents' page code in this Zen, so zenius runs none. Read the page and act through clicks, fills and keys instead.", { method: "page.evaluate", page: "p1", setting: "never" }],
      ["ZEN_PAGE_CODE_OFF", "page.goto: the user has turned off agents' page code in this Zen, and a data: page is the agent's own code, so zenius doesn't load it. Use the site's own pages.", { method: "page.goto", page: "p1", setting: "never" }],
      ["ZEN_PAGE_CODE_ASKED", `page.evaluate: the user hasn't allowed agents' page code on ${site}. zenius asked them in this tab. Carry on with clicks, fills and reading the page. If the task can't go on without page code, hand it to the user saying why, and try again after they resume you.`, { method: "page.evaluate", page: "p1", setting: "ask", site, asked: true }],
      ["ZEN_PAGE_CODE_ASKED", `page.waitForFunction: the user declined agents' page code on ${site} for this task. Don't ask again or hand the task over for it: carry on with clicks, fills and reading the page.`, { method: "page.waitForFunction", page: "p2", setting: "ask", site, asked: false, declined: true }],
      ["ZEN_PAGE_CODE_ASKED", "page.evaluate: the user runs agents' page code only on sites they allow, and this page has no site to allow, so zenius runs none here. Read the page and act through clicks, fills and keys instead.", { method: "page.evaluate", page: "p1", setting: "ask", site: null, asked: false }],
    ];
    for (const [code, message, data] of cases) {
      const error = fromWireError({ code, message, data }, String(data.method)) as ZeniusError & Record<string, unknown>;
      assert.equal(error.code, code);
      // The message already says what to do, so the SDK adds nothing: zenius mcp's evaluate shows it as it is.
      assert.equal(error.message, message);
      for (const [key, value] of Object.entries(data)) assert.equal(error[key], value, key);
      assert.equal(isHardStopCode(code, data), false, "the task goes on without page code");
    }
    // Words that don't say it get the guide's next step.
    const bare = fromWireError({ code: "ZEN_PAGE_CODE_ASKED", message: "page.evaluate: not allowed here.", data: { site, asked: false, declined: true } }, "page.evaluate");
    assert.match(bare.message, /\nCarry on with snapshot\(\), clicks, fills and keys\..*After data\.declined, don't ask or hand off for it again\.$/);
    assert.match(codeHelp("ZEN_PAGE_CODE_OFF") ?? "", /^ZEN_PAGE_CODE_OFF\n  The user turned off agents' page code/);
  });

  it("says what to do for each reason a hand-off is refused, once", () => {
    // zen-core's messages, which each name their next step.
    const messages: [string, string][] = Object.entries({
      agentPage:
        "p1 is a page the agent made (a data: or blob: URL, or an about:blank the agent wrote into), where nothing the user types is safe. Load the site's own page with page.goto() and hand that off.",
      reachable:
        "Another of the task's pages on the same site may still hold the agent's code and could reach the page. Close the task's other pages on that site (page.close()), then call task.handOff() again.",
      reloadFailed:
        "The page didn't load afresh (it stayed on its document). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.",
      discardFailed:
        "The agent's code in the task's pages didn't stop (a content process didn't answer within 10 s). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.",
    });
    // Another window's failed load names that window.
    messages.push([
      "reloadFailed",
      "p2, which may hold the agent's code, didn't load afresh (it stayed on its document). Call task.handOff() again once; if it fails again, tell the user in your reply and go on without the hand-off.",
    ]);
    for (const [reason, text] of messages) {
      const error = fromWireError({ code: "ZEN_HANDOFF_REFUSED", message: text, data: { page: "p1", reason, reloaded: ["p3"] } }, "task.handOff");
      assert.equal((error as ZeniusError).code, "ZEN_HANDOFF_REFUSED");
      assert.equal(error.message, `task.handOff: ${text}`, `${reason}: no next step said twice`);
      assert.equal(isHardStopCode((error as ZeniusError).code, (error as ZeniusError).data), false, "the task stays the agent's");
    }
    assert.match(CODE_GUIDE.ZEN_HANDOFF_REFUSED!.what, /Except after agentPage, zenius has already discarded your page code's sandboxes/);
    // A message without its next step gets the guide's, for every reason.
    const bare = fromWireError({ code: "ZEN_HANDOFF_REFUSED", message: "p1 can't be handed off.", data: { page: "p1", reason: "agentPage" } }, "task.handOff");
    assert.match(bare.message, /\ndata\.reloaded names the Pages that had already loaded afresh: .* agentPage: load the site's own page and hand that off\. reloadFailed or discardFailed: .*reachable: close your other Pages on that site/);
  });

  it("tells a wait for control that ran out from one on the page, and from a runtime that didn't answer", () => {
    assert.match(nextStep("ZEN_TIMEOUT", "task.waitForControl timed out after 1000ms", { ownership: "agentDelegatedToUser" })!, /^The user still has control: end the round/);
    assert.match(nextStep("ZEN_TIMEOUT", "page.waitForSelector: Timeout 1000ms exceeded.", { plain: true })!, /^Look at the page with snapshot\(\)/);
    assert.match(nextStep("ZEN_TIMEOUT", "page.click: no response from the zenius runtime after 150ms", { reason: "no_response" })!, /^Zen may be busy or hung/);
  });

  it("tells a socket the system refuses (a sandbox's EPERM, or EACCES) from a Zen that isn't running", () => {
    for (const errno of ["EPERM", "EACCES"]) assert.equal(nextStep("ZEN_BROWSER_UNAVAILABLE", "taskSpace: blocked", { errno }), SANDBOX_BLOCKED_NEXT);
    assert.match(SANDBOX_BLOCKED_NEXT, /^Don't start or restart Zen\. .*sandbox_permissions "require_escalated"/);
    assert.match(nextStep("ZEN_BROWSER_UNAVAILABLE", "taskSpace: not running", { errno: "ECONNREFUSED" })!, /^Run `zenius doctor`/);
  });
});
