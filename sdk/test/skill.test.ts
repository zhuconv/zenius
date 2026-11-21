// The Skill agents read: the guide `zenius skill` prints, the entry SKILL.md
// and its references, and the site learnings with their helpers.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { taskSpace } from "../src/globals.ts";
import { GUIDE_PLATFORMS, MAX_GUIDE_LENGTH, renderGuide, selectPlatform, type GuidePlatform } from "../src/guide.ts";
import { helpText } from "../src/help.ts";
import { learnContext, runSiteBrowserTool, runSiteTool, siteSkills, wrapBrowserTool } from "../src/learning/index.ts";
import { validateLearnings } from "../src/learning/validate.ts";
import { skillDir } from "../src/skill-dir.ts";
import { withMock } from "./helpers.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SKILL = join(REPO, "skill/zenius");
const SOURCE = readFileSync(join(REPO, "skill/guide.md"), "utf8");
const VERSION = /^version: "([^"]+)"$/m.exec(SOURCE)![1]!;
const SOURCE_BODY = SOURCE.replace(/^---\n[\s\S]*?\n---\n/, "");
const ALL = renderGuide(SOURCE, null);

const words = (markdown: string) => markdown.split(/\s+/).filter(Boolean);
const codeFences = (markdown: string) => markdown.match(/^```[^\n]*\n[\s\S]*?^```$/gm);
const bodyOf = (guide: string) => guide.trimEnd().split("\n").slice(2, -2).join("\n");
const section = (guide: string, heading: string) => new RegExp(`^## ${heading}$[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m").exec(guide)?.[0] ?? "";

describe("the usage guide", () => {
  for (const platform of [null, ...GUIDE_PLATFORMS] as (GuidePlatform | null)[]) {
    it(`renders the ${platform ?? "all-platform"} guide: the source unwrapped, between version and end markers`, () => {
      const guide = renderGuide(SOURCE, platform);
      const lines = guide.trimEnd().split("\n");
      assert.equal(lines[0], `[zenius:skill] zenius usage guide v${VERSION}${platform ? ` (${platform})` : ""}`);
      assert.equal(lines.at(-1), `[zenius:skill] end of guide v${VERSION}`);
      const expected = selectPlatform(SOURCE_BODY, platform).trim();
      const body = bodyOf(guide);
      assert.deepEqual(words(body), words(expected));
      assert.deepEqual(codeFences(body), codeFences(expected));
      assert.ok(body.split("\n").length < expected.split("\n").length, "prose is unwrapped");
      assert.ok(!/^ {2,}\S/m.test(body.replace(/^```[\s\S]*?^```$/gm, "")), "no soft-wrapped continuation lines remain");
      assert.ok(!/<!--/.test(guide));
      assert.ok(guide.length <= MAX_GUIDE_LENGTH, `${guide.length} characters`);
    });
  }

  it("says paste uses the task space's own clipboard, on every platform", () => {
    const visual = /^### Visual pages:[\s\S]*?(?=^### )/m.exec(ALL)?.[0] ?? "";
    assert.match(visual, /Each task space has a clipboard of its own, separate from the user's system clipboard/);
    assert.match(visual, /a site's own Copy button copies there too, and none of it reads or replaces what the user copied/);
    assert.match(visual, /To give the user text to paste, put it in your reply/);
    assert.equal(bodyOf(renderGuide(SOURCE, "macos")), bodyOf(renderGuide(SOURCE, "linux")), "no platform-specific passages today");
  });

  it("says what zenius refuses, and that the user's saved passwords never fill agent Pages", () => {
    assert.match(
      section(ALL, "Action receipts, popups, and dialogs"),
      /lists each refusal in `receipt\.refused` as `\{ kind, message \}`, and `page\.events\(\)` records it as a `Zenius\.refused` event/,
    );
    assert.match(
      section(ALL, "User control"),
      /zenius never fills the user's saved passwords into your Pages, so a login on a site where the user has no session means `handOff\(\)`/,
    );
  });

  it("says where else zenius differs: icon buttons' names, and unfinished spaces closing after 3 days", () => {
    assert.match(section(ALL, "Page operations"), /such as an icon button, is listed with its accessible name \(its hidden label, else its `title`\)/);
    assert.match(
      section(ALL, "Starting and ending a reply"),
      /A task space that is never finished does not stay: once no script has used it for 3 days, zenius closes it with its tabs/,
    );
  });

  it("speaks zenius: no Ego names, and CDP only as unsupported", () => {
    assert.doesNotMatch(ALL, /ego-browser|EGO_|Ego Lite|egoAutomated|\[ego/i);
    const cdpParagraphs = bodyOf(ALL)
      .split("\n\n")
      .filter((paragraph) => /cdp\(|CDP|DevTools/.test(paragraph));
    assert.equal(cdpParagraphs.length, 1, cdpParagraphs.join("\n---\n"));
    assert.match(cdpParagraphs[0]!, /`page\.cdp\(\)` and `task\.cdp\(\)` throw `ZEN_UNSUPPORTED`/);
  });

  it("hands login, verification and manual steps back to the user", () => {
    const rule = section(ALL, "User control")
      .split("\n\n")
      .find((paragraph) => paragraph.includes("task.handOff("));
    assert.ok(rule);
    for (const trigger of [/login/i, /CAPTCHA/, /human verification/i, /2FA/, /manual step/i]) assert.match(rule, trigger);
    assert.match(rule, /work around it silently/);
    // Credentials the user supplied for the task stay usable.
    assert.match(rule, /credentials the user\s+gave/);
  });

  it("explains Spaces, watching and takeover in Zen terms", () => {
    assert.match(ALL, /Each task space is a set of tabs in the Agents Space, one Zen Space that all\s+agents' tasks share in the user's window/);
    assert.match(ALL, /never switches the user's Space or tab/);
    assert.match(ALL, /watch your cursor/);
    const control = section(ALL, "User control");
    // zen-ux's approved text (docs/research/ux.md §7a) and the ignored-prompt rule.
    assert.match(control, /pauses your next browser action and asks them whether to take over/);
    assert.match(control, /only clicked and leave the question unanswered for 10 seconds, the action runs/);
    assert.match(control, /type into the page and leave the question unanswered, the call fails with `ZEN_TASK_SPACE_USER_IN_CONTROL` and reason `manual_takeover`/);
    assert.match(control, /resume with `takeOverTaskSpace\(id\)`/);
    // After the flip (1e32f75) the badge is the Agents Space's (SPEC §3.8 "The badge").
    assert.match(control, /`handOff\(\)` badges the Agents Space[^\n]*nothing notifies the user outside the browser/);
  });

  it("matches what `zenius skill` prints", async () => {
    const { runCli } = await import("./helpers.ts");
    const result = await runCli(["skill"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, renderGuide(SOURCE, process.platform === "darwin" ? "macos" : "linux"));
  });
});

describe("renderGuide", () => {
  const source = [
    "---",
    'version: "9.9.9"',
    "---",
    "Shared start.",
    "<!-- platform: linux -->",
    "Linux only, same paragraph.",
    "<!-- /platform -->",
    "",
    "<!-- platform: macos -->",
    "## macOS heading",
    "<!-- /platform -->",
    "",
    "<!-- platform: macos, linux -->",
    "Both.",
    "<!-- /platform -->",
    "",
  ].join("\n");
  const body = (platform: GuidePlatform | null) => renderGuide(source, platform).trim().split("\n").slice(2, -2).join("\n");

  it("selects platform blocks and strips the markers", () => {
    assert.equal(body("linux"), "Shared start. Linux only, same paragraph.\n\nBoth.");
    assert.equal(body("macos"), "Shared start.\n\n## macOS heading\n\nBoth.");
    assert.equal(body(null), "Shared start. Linux only, same paragraph.\n\n## macOS heading\n\nBoth.");
    assert.match(renderGuide(source, "macos"), /^\[zenius:skill\] zenius usage guide v9\.9\.9 \(macos\)\n/);
    assert.match(renderGuide(source), /^\[zenius:skill\] zenius usage guide v9\.9\.9\n/);
    assert.throws(() => renderGuide(source, "windows" as GuidePlatform), /unknown guide platform/);
    assert.throws(() => renderGuide("no frontmatter"), /needs frontmatter with a version/);
  });

  it("rejects malformed platform blocks", () => {
    assert.throws(() => selectPlatform("<!-- platform: linux -->\nx", "macos"), /never closed/);
    assert.throws(() => selectPlatform("x\n<!-- /platform -->", "macos"), /closed twice/);
    assert.throws(
      () => selectPlatform("<!-- platform: linux -->\n<!-- platform: macos -->\n<!-- /platform -->\n<!-- /platform -->", "macos"),
      /do not nest/,
    );
    assert.throws(() => selectPlatform("<!-- platform: windows -->\n<!-- /platform -->", "macos"), /unknown platform "windows"/);
  });
});

describe("the entry Skill", () => {
  const entry = readFileSync(join(SKILL, "SKILL.md"), "utf8");

  it("defers usage to zenius skill and names the guide's end marker", () => {
    assert.match(entry, /^name: zenius$/m);
    assert.match(entry, /^\s+bootstrap: "true"$/m);
    assert.match(entry, /^zenius skill$/m);
    assert.ok(entry.includes("`[zenius:skill] end of guide`"));
    assert.ok(ALL.trimEnd().split("\n").at(-1)!.startsWith("[zenius:skill] end of guide"));
    assert.equal(/^\s+version: "([^"]+)"$/m.exec(entry)?.[1], VERSION, "SKILL.md and the guide carry one version");
  });

  it("links references that exist", () => {
    const links = [...entry.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]!);
    assert.deepEqual(links.sort(), ["references/clearing-state.md", "references/install.md"]);
    for (const link of links) assert.ok(existsSync(join(SKILL, link)), link);
    assert.ok(existsSync(join(SKILL, "agents/openai.yaml")));
    assert.equal(resolve(skillDir()), resolve(SKILL));
  });

  it("the clearing-state reference keeps clears to one origin and sends sign-in walls to the user", () => {
    const reference = readFileSync(join(SKILL, "references/clearing-state.md"), "utf8");
    assert.match(reference, /sign-in wall[^\n]*task\.handOff\(\)/i);
    assert.doesNotMatch(reference, /page\.cdp|\bNetwork\.|\bStorage\.clear/);
    assert.match(reference, /whole profile/);
  });

  it("the install reference names the skill directories install-cli.sh links, for Claude Code and Codex", () => {
    const reference = readFileSync(join(SKILL, "references/install.md"), "utf8");
    const script = readFileSync(join(REPO, "scripts/install-cli.sh"), "utf8");
    assert.match(script, /ZENIUS_SKILL_DIRS:-\$HOME\/\.claude\/skills \$HOME\/\.agents\/skills\}/);
    assert.ok(reference.includes("Claude Code reads `~/.claude/skills/<name>/SKILL.md`"), reference);
    assert.ok(reference.includes("Codex reads `~/.agents/skills/<name>/SKILL.md`"), reference);
    // On the Mac a bare `codex` can be the user's shell function.
    assert.match(reference, /^command codex debug prompt-input hi/m);
  });

  it("the install reference never has the agent restart the user's Zen", () => {
    const reference = readFileSync(join(SKILL, "references/install.md"), "utf8");
    assert.match(reference, /zenius status/);
    assert.match(reference, /ZEN_BROWSER_UNAVAILABLE/);
    assert.match(reference, /Never start, restart, or quit the user's Zen yourself/);
    assert.match(reference, /scripts\/install\.sh[^\n]*only when the user asks/);
    // zenius never restarts Zen: the user quits and reopens it.
    assert.match(reference, /zenius doctor/);
    assert.doesNotMatch(reference, /install\.sh[^\n]*restarts Zen/);
  });
});

describe("site learnings", () => {
  it("every learning that ships with zenius is well formed", async () => {
    assert.deepEqual(await validateLearnings(join(SKILL, "learnings")), []);
  });

  it("the validator reports what it checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "zenius-learnings-"));
    try {
      mkdirSync(join(root, "bad/notes"), { recursive: true });
      writeFileSync(join(root, "bad/notes/n.md"), "click @12 first");
      writeFileSync(
        join(root, "bad/manifest.json"),
        JSON.stringify({ id: "other", name: "", domains: ["https://x.com"], notes: ["notes/n.md", "../escape.md"], nodeTools: { t: { path: "x.js" } } }),
      );
      const errors = await validateLearnings(root);
      for (const expected of [
        /manifest id must match/,
        /name must be a non-empty string/,
        /invalid domain/,
        /temporary snapshot ref/,
        /notes must point to notes\/\*\.md/,
        /path must be a relative tools\/\*\.js path/,
        /callable must be a non-empty string/,
      ]) {
        assert.ok(errors.some((error) => expected.test(error)), `${expected}: ${errors.join("; ")}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("match by domain, wildcards included", async () => {
    const ids = async (target: string) => (await siteSkills(target)).map((entry) => entry.id);
    assert.deepEqual(await ids("https://www.google.com/search?q=zen"), ["google"]);
    assert.deepEqual(await ids("https://gist.github.com/someone"), ["github"]);
    assert.deepEqual(await ids("twitter.com"), ["x-com"]);
    assert.deepEqual(await ids("https://example.com/"), []);
    const context = await learnContext("https://x.com/home");
    assert.equal(context.exists, true);
    assert.equal(context.siteId, "x-com");
    assert.deepEqual(
      context.knowledge.map((note) => note.fileName),
      ["overview.md", "timeline.md"],
    );
    assert.deepEqual(
      context.tools.map((tool) => tool.example),
      [
        'await runSiteTool(page, "x-com", "get_timeline_posts", { ... })',
        'await runSiteTool(page, "x-com", "search_users", { ... })',
        'await runSiteBrowserTool(page, "x-com", "post_from_active_element", { ... })',
      ],
    );
    assert.deepEqual(await learnContext("https://example.com/"), {
      exists: false,
      siteId: null,
      siteName: null,
      domain: "example.com",
      knowledge: [],
      tools: [],
    });
  });

  it("run their tools against a Page", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "zenius-workspace-"));
    const site = join(workspace, "learnings/fixture");
    mkdirSync(join(site, "tools"), { recursive: true });
    mkdirSync(join(site, "browser-tools"), { recursive: true });
    mkdirSync(join(site, "notes"), { recursive: true });
    writeFileSync(join(workspace, "learnings/package.json"), '{ "type": "module" }\n');
    writeFileSync(join(site, "notes/overview.md"), "# Fixture\n");
    writeFileSync(
      join(site, "tools/visit.js"),
      `export async function visit(ctx, args = {}) {
  await ctx.openOrReuseTab("https://example.com/" + args.path, { wait: true });
  await ctx.waitForLoad();
  return { title: await ctx.js("document.title"), label: ctx.page.label };
}\n`,
    );
    writeFileSync(join(site, "browser-tools/echo.js"), "// A browser tool.\nasync function (args) {\n  return { title: document.title, args };\n}\n");
    const tool = { args: { path: { type: "string", required: true, description: "Path." } }, returns: { type: "object", description: "Result." } };
    writeFileSync(
      join(site, "manifest.json"),
      JSON.stringify({
        id: "fixture",
        name: "Fixture",
        domains: ["example.com"],
        notes: ["notes/overview.md"],
        nodeTools: { visit: { description: "Visit a path.", path: "tools/visit.js", callable: "visit", ...tool } },
        browserTools: { echo: { description: "Echo.", path: "browser-tools/echo.js", ...tool } },
      }),
    );
    const previous = process.env.ZENIUS_AGENT_WORKSPACE;
    process.env.ZENIUS_AGENT_WORKSPACE = workspace;
    try {
      assert.deepEqual(await validateLearnings(join(workspace, "learnings")), []);
      await withMock(async () => {
        const task = await taskSpace("learnings");
        const page = task.page("p1");
        assert.deepEqual(await runSiteTool(page, "fixture", "visit", { path: "a" }), { title: "Title of https://example.com/a", label: "p1" });
        assert.deepEqual((await siteSkills(page)).map((entry) => entry.id), ["fixture"]);
        assert.equal((await learnContext(page)).knowledge[0]?.content, "# Fixture\n");
        assert.deepEqual(await runSiteBrowserTool(page, "fixture", "echo", { n: 1 }), {
          title: "Title of https://example.com/a",
          args: { n: 1 },
        });
        await assert.rejects(runSiteTool("fixture" as never, "visit", {} as never), /first argument is the Page.*Expected: await runSiteTool\(page, siteId, toolName, args\?\)/);
        await assert.rejects(siteSkills(42 as never), /siteSkills expects a Page or a URL string, got 42\. Expected: await siteSkills\(pageOrUrl\)/);
        await assert.rejects(runSiteTool(page, "nope", "visit"), /site learning not found: "nope"\n {2}searched: /);
        await assert.rejects(runSiteBrowserTool(page, "fixture", "missing"), /browser tool "missing" is not declared by site learning "fixture"/);
      });
    } finally {
      if (previous === undefined) delete process.env.ZENIUS_AGENT_WORKSPACE;
      else process.env.ZENIUS_AGENT_WORKSPACE = previous;
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("wrap browser tools so a leading comment or trailing semicolon still parses", () => {
    const expression = wrapBrowserTool("// note\nasync function (args) { return args.x * 2; };\n", { x: 21 });
    assert.equal(typeof new Function(`return ${expression};`), "function");
  });

  it("stay out of the default help() listing", () => {
    assert.doesNotMatch(helpText(), /runSiteTool|learnContext/);
    const group = helpText("learnings");
    for (const name of ["siteSkills", "learnContext", "runSiteTool", "runSiteBrowserTool"]) assert.match(group, new RegExp(`^${name}$`, "m"));
    assert.match(helpText("runSiteTool"), /^runSiteTool\n\nRun a site learning's Node tool/);
  });
});
