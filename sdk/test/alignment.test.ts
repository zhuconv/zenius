// The guide, the SDK and help() describe one API. Every method the guide names
// exists in the SDK and in the schema behind help(); every public SDK member
// is in that schema; every schema entry is either taught by the guide or
// listed below as help-only; and every runtime method the SDK calls is in
// src/protocol-methods.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { API_SCHEMA, apiEntry } from "../src/api-schema.ts";
import { scriptGlobals } from "../src/cli.ts";
import { taskSpace } from "../src/globals.ts";
import { renderGuide } from "../src/guide.ts";
import { findEntry, helpText } from "../src/help.ts";
import { RUNTIME_METHODS } from "../src/protocol-methods.ts";
import { withMock } from "./helpers.ts";

const SDK = fileURLToPath(new URL("../", import.meta.url));
const GUIDE = renderGuide(readFileSync(join(SDK, "../skill/guide.md"), "utf8"), null);

/** Schema entries the guide leaves to help(), as Ego's guide does. */
const HELP_ONLY = new Set([
  "Download.page", // the Page that started the download
  "FileChooser.isMultiple", // whether the input takes several files
]);

/** TaskSpace fields that mirror listTaskSpaces() entries rather than API. */
const DATA_FIELDS = new Set(["TaskSpace.taskId", "TaskSpace.id", "TaskSpace.createdBy", "TaskSpace.recentTabTitles"]);

const RECEIVERS: Record<string, string> = {
  "page.mouse": "Page.mouse",
  "page.keyboard": "Page.keyboard",
  popupPage: "Page",
  userPage: "Page",
  task: "TaskSpace",
  page: "Page",
  download: "Download",
  chooser: "FileChooser",
  mouse: "Page.mouse",
  keyboard: "Page.keyboard",
};
const GLOBALS = ["taskSpace", "listTaskSpaces", "claimTaskSpace", "takeOverTaskSpace", "profiles"];

type Reference = { name: string; written: string };

/** API names the guide uses: `receiver.member` anywhere, and the bare items of its API lists. */
function guideReferences(): Reference[] {
  const references: Reference[] = [];
  const receivers = Object.keys(RECEIVERS).map((key) => key.replace(".", "\\.")).join("|");
  for (const match of GUIDE.matchAll(new RegExp(`(?<![\\w.])(${receivers})\\.([A-Za-z]+)\\b`, "g"))) {
    references.push({ name: `${RECEIVERS[match[1]!]}.${match[2]}`, written: match[0] });
  }
  for (const name of GLOBALS) {
    if (new RegExp(`(?<![\\w.])${name}\\(`).test(GUIDE)) references.push({ name, written: `${name}()` });
  }
  // Pointing at help("x") teaches x.
  for (const match of GUIDE.matchAll(/help\("([^"]+)"\)/g)) {
    const entry = findEntry(match[1]!);
    if (entry) references.push({ name: entry.name, written: match[0] });
  }
  // "`download.path()` ...; `failure()`, `cancel()`" means download.failure():
  // a bare call belongs to the last receiver named in its paragraph.
  for (const paragraph of GUIDE.split("\n\n")) {
    let owner: string | undefined;
    for (const [, span] of paragraph.matchAll(/`([^`]+)`/g)) {
      const qualified = new RegExp(`^(?:await )?(${receivers})\\.[A-Za-z]+`).exec(span!);
      if (qualified) owner = RECEIVERS[qualified[1]!];
      const bare = /^([A-Za-z]+)\(/.exec(span!);
      if (!qualified && bare && owner && apiEntry(`${owner}.${bare[1]}`)) references.push({ name: `${owner}.${bare[1]}`, written: span! });
    }
  }
  for (const [heading, owner] of [
    ["Supported TaskSpace API:", "TaskSpace"],
    ["Page API:", "Page"],
  ] as const) {
    const list = GUIDE.slice(GUIDE.indexOf(heading)).split("\n\n")[1]!;
    assert.match(list, /^- /, `the ${heading} list follows its heading`);
    for (const line of list.split("\n")) {
      let prefix = "";
      for (const [index, item] of [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).entries()) {
        const path = /^(?:await )?(?:task\.|page\.)?([A-Za-z]+(?:\.[A-Za-z]+)?)/.exec(item)![1]!;
        // "Pointer: `mouse.click()`, `move()`" means mouse.move().
        if (index === 0 && path.includes(".")) prefix = `${path.split(".")[0]}.`;
        const member = path.includes(".") ? path : `${prefix}${path}`;
        references.push({ name: `${owner}.${member}`, written: item });
      }
    }
  }
  return references;
}

/** Every public member the SDK gives a script, keyed by schema-style name. */
async function sdkSurface(): Promise<Map<string, unknown>> {
  const surface = new Map<string, unknown>();
  const add = (owner: string, value: object) => {
    for (const key of publicMembers(value)) surface.set(`${owner}.${key}`, (value as Record<string, unknown>)[key]);
  };
  for (const [name, value] of Object.entries(scriptGlobals())) surface.set(name, value);
  await withMock(async () => {
    const task = await taskSpace("alignment");
    const page = task.page("p1");
    const downloadPromise = page.waitForEvent("download");
    await page.click("a.download");
    const chooserPromise = page.waitForFileChooser();
    await page.click("button.upload");
    add("TaskSpace", task);
    add("Page", page);
    add("Page.mouse", page.mouse);
    add("Page.keyboard", page.keyboard);
    add("Download", (await downloadPromise) as object);
    add("FileChooser", await chooserPromise);
  });
  return surface;
}

function publicMembers(value: object): string[] {
  const names = new Set(Object.keys(value));
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) if (name !== "constructor") names.add(name);
  }
  return [...names];
}

describe("guide, SDK and help() alignment", () => {
  it("every API the guide names exists in the schema, the SDK and help()", async () => {
    const surface = await sdkSurface();
    const problems: string[] = [];
    for (const { name, written } of guideReferences()) {
      if (!apiEntry(name)) problems.push(`${written}: no schema entry ${name}`);
      if (!surface.has(name)) problems.push(`${written}: the SDK has no ${name}`);
    }
    // What an agent copies from the guide into help() resolves.
    for (const match of GUIDE.matchAll(/(?<![\w.])((?:page|task|download|chooser|mouse|keyboard)\.[A-Za-z.]+?)\(/g)) {
      if (!findEntry(match[1]!)) problems.push(`help("${match[1]}") is unknown`);
    }
    assert.deepEqual(problems, []);
  });

  it("every public SDK member is in the schema behind help(), and every schema entry is in the SDK", async () => {
    const surface = await sdkSurface();
    const listed = new Set(API_SCHEMA.map((entry) => entry.name));
    const unlisted = [...surface.keys()].filter(
      (name) => !listed.has(name) && !DATA_FIELDS.has(name) && name !== "help" && name !== "Page.mouse" && name !== "Page.keyboard",
    );
    assert.deepEqual(unlisted, [], "SDK members help() cannot explain");
    assert.deepEqual(
      [...listed].filter((name) => !surface.has(name)),
      [],
      "schema entries the SDK lacks",
    );
  });

  it("the guide teaches every default help() entry except the help-only ones", () => {
    const taught = new Set(guideReferences().map((reference) => reference.name));
    const untaught = API_SCHEMA.filter((entry) => entry.group === undefined && !taught.has(entry.name) && !HELP_ONLY.has(entry.name)).map(
      (entry) => entry.name,
    );
    assert.deepEqual(untaught, []);
    for (const name of HELP_ONLY) assert.ok(apiEntry(name), `${name} is still in the schema`);
    assert.doesNotMatch(helpText(...HELP_ONLY), /Unknown helper/);
  });

  it("every code example in the guide compiles as a zenius script", () => {
    const blocks = [...GUIDE.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(([, language, code]) => ({ language, code: code! }));
    const scripts = blocks.flatMap(({ language, code }) => {
      if (language === "js") return [code];
      const heredoc = /^zenius nodejs <<'EOF'\n([\s\S]*?)^EOF$/m.exec(code);
      return heredoc ? [heredoc[1]!] : [];
    });
    assert.ok(scripts.length >= 15, `${scripts.length} scripts`);
    for (const script of scripts) {
      assert.doesNotThrow(() => new vm.Script(`(async function () {\n${script}\n})`), script);
    }
  });
});

describe("runtime methods", () => {
  const sources = readdirSync(join(SDK, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith("protocol-methods.ts"))
    .map((file) => readFileSync(join(SDK, "src", file), "utf8"))
    .join("\n");

  it("src/protocol-methods.ts lists every method the SDK calls, and only those", () => {
    const called = new Set(
      [...sources.matchAll(/(?:\[REQUEST\]|\.call|#call)(?:<[^(]*>)?\(\s*"([a-zA-Z]+\.[A-Za-z]+)"/g)].map((match) => match[1]!),
    );
    assert.ok(called.size > 20, `found ${called.size} call sites`);
    assert.deepEqual([...called].filter((method) => !(method in RUNTIME_METHODS)), [], "called but not listed");
    assert.deepEqual(
      Object.keys(RUNTIME_METHODS).filter((method) => !sources.includes(`"${method}"`)),
      [],
      "listed but never named in src/",
    );
  });
});
