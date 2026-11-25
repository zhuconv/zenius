// zenius's docs about itself (src/docs.ts). Each topic is built from the
// code that does what it says; the limits and URL rules it states are the
// runtime's own; the skill's references are what the generator writes; and
// the MCP server serves the docs without Zen: as its docs tool, as that tool
// alone (--docs-only, for the agent sidebar's Chat), and as resources.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { apiEntry, normalizeApiName } from "../src/api-schema.ts";
import { DOC_TOPICS, docsText, referenceText, RUNTIME_LIMITS, SKILL_TOPICS, TOOL_CALLS } from "../src/docs.ts";
import { CODE_GUIDE, REFUSAL_GUIDE } from "../src/error-guide.ts";
import { WEB_PROTOCOLS } from "../src/limits.ts";
import { callTool, handle, toolList } from "../src/mcp.ts";
import { VERSION } from "../src/version.ts";
import { runCli } from "./helpers.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(join(REPO, file), "utf8");
type Session = Parameters<typeof callTool>[0];
type Json = Record<string, any>;

/** A session that fails the call if anything reaches for Zen. */
function offline(docsOnly = false): Session {
  const reach = () => {
    throw new Error("the docs reached for Zen");
  };
  return { docsOnly, connect: reach, resume: async () => reach(), drop() {}, ended() {} } as unknown as Session;
}

let id = 0;
async function ask(session: Session, method: string, params?: Json): Promise<Json> {
  const response = (await handle(session, { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) })) as Json;
  return response;
}

describe("zenius docs", () => {
  it("name this version, then the topic; with no topic, the list of topics", () => {
    for (const { name, title } of DOC_TOPICS) {
      const { text, found } = docsText(name);
      assert.equal(found, true, name);
      assert.ok(text.startsWith(`zenius ${VERSION}\n\n# ${title}\n`), name);
    }
    const list = docsText();
    assert.equal(list.found, true);
    assert.deepEqual([...list.text.matchAll(/^- (\w+): /gm)].map((m) => m[1]), DOC_TOPICS.map((t) => t.name));
  });

  it("errors: every code agents read and every refused kind, each with what to do next", () => {
    const { text } = docsText("errors");
    for (const [code, guide] of Object.entries(CODE_GUIDE)) {
      const heading = new RegExp(`^### ${code}\\b`, "m");
      if (guide.unlisted) assert.doesNotMatch(text, heading, `${code} is only the self-check's`);
      else assert.match(text, heading, code);
    }
    for (const kind of Object.keys(REFUSAL_GUIDE)) assert.match(text, new RegExp(`^### ${kind}$`, "m"), kind);
    assert.equal(text.match(/^Next: /gm)?.length, Object.values(CODE_GUIDE).filter((g) => !g.unlisted).length + Object.keys(REFUSAL_GUIDE).length);
    assert.ok(!text.includes("{help}"));
  });

  it("find one code or refused kind by its name in any case, and list the topics for a name they don't know", () => {
    const one = docsText("zen_url_not_allowed");
    assert.equal(one.found, true);
    assert.match(one.text, /^# ZEN_URL_NOT_ALLOWED$/m);
    assert.match(one.text, /^Next: Load a web page instead/m);
    assert.match(docsText("LOCALNETWORK").text, /^# localNetwork$/m);
    for (const [code, guide] of Object.entries(CODE_GUIDE)) {
      if (guide.unlisted) assert.equal(docsText(code).found, false, code);
    }
    const none = docsText("nope");
    assert.equal(none.found, false);
    assert.match(none.text, /^There is no zenius doc named "nope"\.$/m);
    assert.match(none.text, /^- errors: /m);
    // What it echoes can't change how the line reads where a sidebar shows it.
    assert.match(docsText("evil\u202Egnp.exe\nnext").text, /^There is no zenius doc named "evilgnp.exenext"\.$/m);
  });

  it("urls: what agents may load is what the runtime lets them load, and the MCP tools' rule is theirs", () => {
    const source = read("runtime/JS/zenius/observe/webcontent.sys.mjs");
    const words = /^const LOADABLE_TEXT = "([^"]+)";$/m.exec(source)?.[1];
    const schemes = /^const LOADABLE = new Set\(\[([^\]]*)\]\);$/m.exec(source)?.[1]?.match(/[a-z]+/g);
    assert.ok(words && schemes, "webcontent.sys.mjs has LOADABLE and LOADABLE_TEXT");
    assert.deepEqual(words.split(/, | and /), [...schemes.map((s) => `${s}:`), "about:blank"]);
    const { text } = docsText("urls");
    assert.ok(text.includes(`Agents load only ${words} URLs`), "the urls doc names what the runtime loads");
    assert.ok(text.includes(`The MCP tools open and goto take only ${WEB_PROTOCOLS.join(" and ")} URLs`));
  });

  it("limits: each limit the runtime or the launcher sets is the one its source sets", () => {
    for (const [key, limit] of Object.entries(RUNTIME_LIMITS)) {
      const { file, name, value } = limit;
      const source = read(file);
      const set =
        new RegExp(`\\b${name}\\s*=\\s*([0-9_ *]+)`).exec(source)?.[1] ??
        new RegExp(`\\b${name}:\\s*\\{[^}]*\\bvalue:\\s*([0-9_]+)`).exec(source)?.[1];
      assert.ok(set, `${file} sets ${name} (${key})`);
      const product = set.split("*").reduce((n, factor) => n * Number(factor.trim().replaceAll("_", "")), 1);
      assert.equal(product, value, `${file}'s ${name}`);
      const pref = "pref" in limit ? limit.pref : undefined;
      if (pref) {
        assert.ok(source.includes(`"${pref}"`), `${file} names the pref ${pref}`);
        assert.ok(docsText("limits").text.includes(pref), `the limits doc names ${pref}`);
      }
    }
  });

  it("errors: the script calls each MCP tool makes, as the next steps name them", () => {
    const tools = new Set(toolList().map((t) => t.name));
    for (const [names, calls] of TOOL_CALLS) {
      for (const name of names.split(/, | and /)) assert.ok(tools.has(name), `${name} is an MCP tool`);
      for (const call of calls.match(/\b(?:page|task)\.[A-Za-z]+(?=\()/g) ?? []) {
        assert.ok(apiEntry(normalizeApiName(call)), `${call} is in the API`);
      }
    }
  });

  it("script: the script tool's rules and the API without the CLI's task functions, within what both clients keep of a result", () => {
    const { text, found } = docsText("script");
    assert.ok(found);
    // About 8,000 tokens at most, inside Codex's 10,000.
    assert.ok(text.length < 32_000, `${text.length} characters`);
    for (const rule of [
      /end the script with task\.handOff\(\), since its later calls are refused\. Then call the wait tool with user: true/,
      /ZEN_TASK_SPACE_USER_IN_CONTROL\. Let that end the script rather than catching it, then ask the user to press Resume agent/,
      /never with a busy loop/,
      /claimTaskSpace\(\) and takeOverTaskSpace\(\) are refused/,
    ]) {
      assert.match(text, rule);
    }
    // The API's own entries for these would say what the CLI's do.
    for (const name of ["claimTaskSpace", "takeOverTaskSpace", "taskSpace", "profiles"]) assert.doesNotMatch(text, new RegExp(`^${name}$`, "m"), name);
    assert.match(text, /^Page\.click$|^page\.click$/m);
  });

  it("the skill's references are what sdk/scripts/write-references.ts writes", () => {
    assert.deepEqual(SKILL_TOPICS, ["errors", "urls", "files", "limits"], "script is zenius mcp's alone: the skill is the CLI's");
    for (const name of SKILL_TOPICS) {
      const file = `skill/zenius/references/${name}.md`;
      assert.ok(read(file) === referenceText(name), `${file} is out of date: run node sdk/scripts/write-references.ts`);
    }
  });

  it("zenius docs prints them, and fails for a name it doesn't know", async () => {
    const urls = await runCli(["docs", "urls"]);
    assert.equal(urls.code, 0, urls.stderr);
    assert.equal(urls.stdout, `${docsText("urls").text}\n`);
    const none = await runCli(["docs", "nope"]);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /There is no zenius doc named "nope"/);
    assert.equal((await runCli(["docs", "urls", "files"])).code, 2);
  });
});

describe("zenius mcp docs", () => {
  it("is a read-only tool that answers while Zen is closed", async () => {
    const docs = toolList().find((t) => t.name === "docs");
    assert.deepEqual(docs?.annotations, { title: "Read zenius's docs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const { name } of DOC_TOPICS) assert.ok(String(docs.description).includes(name), name);
    const result = await callTool(offline(), "docs", { topic: "urls" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, `Read zenius's docs: "urls"\n${docsText("urls").text}`);
    assert.equal((await callTool(offline(), "docs", {})).content[0]!.text, `Read zenius's docs\n${docsText().text}`);
  });

  it("is in the instructions, and the server offers resources", async () => {
    const init = (await ask(offline(), "initialize", { protocolVersion: "2025-06-18" })).result;
    assert.match(init.instructions, /call docs with a topic\.$/);
    assert.deepEqual(init.capabilities, { tools: { listChanged: false }, resources: { listChanged: false } });
  });

  it("with --docs-only, is the server's only tool, and nothing reaches Zen", async () => {
    const session = offline(true);
    const init = (await ask(session, "initialize", { protocolVersion: "2025-06-18" })).result;
    assert.match(init.instructions, /zenius's docs only, and no browser tools/);
    assert.deepEqual((await ask(session, "tools/list")).result.tools.map((t: Json) => t.name), ["docs"]);
    for (const name of toolList().map((t) => String(t.name))) {
      if (name === "docs") continue;
      const refused = await callTool(session, name, { url: "https://example.com" });
      assert.equal(refused.isError, true, name);
      assert.equal(refused.content[0]!.text, `There is no tool named "${name}".`);
    }
    assert.equal((await callTool(session, "docs", { topic: "errors" })).isError, undefined);
  });

  it("serves each topic as a resource, and any doc the tool finds by its URI", async () => {
    const session = offline();
    const { resources } = (await ask(session, "resources/list")).result;
    assert.deepEqual(
      resources.map((r: Json) => [r.uri, r.name, r.mimeType]),
      DOC_TOPICS.map((t) => [`zenius://docs/${t.name}`, t.name, "text/markdown"]),
    );
    const limits = (await ask(session, "resources/read", { uri: "zenius://docs/limits" })).result;
    assert.deepEqual(limits, { contents: [{ uri: "zenius://docs/limits", mimeType: "text/markdown", text: docsText("limits").text }] });
    const code = (await ask(session, "resources/read", { uri: "zenius://docs/ZEN_URL_NOT_ALLOWED" })).result;
    assert.equal(code.contents[0].text, docsText("ZEN_URL_NOT_ALLOWED").text);
    for (const uri of ["zenius://docs/nope", "zenius://docs/", "zenius://docs/%E0%A4%A", "https://example.com/", 42]) {
      assert.equal((await ask(session, "resources/read", { uri })).error?.code, -32002, String(uri));
    }
    const [template] = (await ask(session, "resources/templates/list")).result.resourceTemplates;
    assert.equal(template.uriTemplate, "zenius://docs/{topic}");
  });
});
