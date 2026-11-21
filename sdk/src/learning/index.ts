// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Site learnings: notes and small tools for one site, kept in the Skill's
// learnings/<site>/ directory (or $ZENIUS_AGENT_WORKSPACE/learnings). A
// learning's manifest.json names the domains it covers, its notes, and its
// tools. Node tools run in the script against one Page; browser tools run
// inside the Page.
//
// Ego Lite runs these against the "current tab" of its older helper API.
// zenius has no current tab, so every helper takes the Page (or URL) it
// applies to, and Node tools get a context bound to that Page that still has
// the helpers Ego's learnings call.

import { Page } from "../page.ts";
import { fs, os, path, url } from "../node.ts";
import { skillDir } from "../skill-dir.ts";

export type ToolArgSchema = { type: string; required: boolean; description: string };
export type ToolSchema = {
  description: string;
  path: string;
  args: Record<string, ToolArgSchema>;
  returns: { type: string; description: string };
};
export type NodeToolSchema = ToolSchema & { callable: string };
export type LearningManifest = {
  id: string;
  name: string;
  domains: string[];
  notes: string[];
  nodeTools?: Record<string, NodeToolSchema>;
  browserTools?: Record<string, ToolSchema>;
};
export type LearningEntry = {
  id: string;
  name: string;
  path: string;
  domains: string[];
  notes: string[];
  nodeTools: Record<string, NodeToolSchema>;
  browserTools: Record<string, ToolSchema>;
};
export type LearnedToolSignature = {
  siteId: string;
  toolName: string;
  toolType: "node" | "browser";
  description: string;
  args: Record<string, ToolArgSchema>;
  example: string;
};
export type LearnedContext = {
  exists: boolean;
  siteId: string | null;
  siteName: string | null;
  domain: string;
  knowledge: { siteId: string; fileName: string; content: string }[];
  tools: LearnedToolSignature[];
};

/** The directory that holds learnings/: $ZENIUS_AGENT_WORKSPACE, else the Skill. */
export function agentWorkspace(): string {
  const configured = process.env.ZENIUS_AGENT_WORKSPACE;
  if (!configured) return skillDir();
  return path.resolve(configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured);
}

export function learningsRoot(workspace = agentWorkspace()): string {
  return path.join(workspace, "learnings");
}

// ---------------------------------------------------------------------------
// Script API

type Target = Page | string;

/** Learnings whose domains match a Page's URL or a URL. */
export async function siteSkills(target: Target): Promise<LearningEntry[]> {
  return siteSkillsForUrl(await targetUrl("siteSkills", "await siteSkills(pageOrUrl)", target));
}

/** Notes and tools the learnings hold for a Page's site or a URL. */
export async function learnContext(target: Target): Promise<LearnedContext> {
  return loadLearnedContext(await targetUrl("learnContext", "await learnContext(pageOrUrl)", target));
}

/** Run a learning's Node tool against `page`. */
export async function runSiteTool(page: Page, siteId: string, toolName: string, args: unknown = {}): Promise<unknown> {
  checkToolCall("runSiteTool", page, siteId, toolName, args);
  const { siteDir, manifest } = await findSiteSkill(siteId);
  const schema = toolSchemas(manifest, "nodeTools")[toolName] as NodeToolSchema | undefined;
  if (!schema || typeof schema !== "object") {
    throw new Error(`Node tool ${JSON.stringify(toolName)} is not declared by site learning ${JSON.stringify(siteId)}`);
  }
  const toolPath = relativeSitePath(siteDir, schema.path, "Node tool");
  if (typeof schema.callable !== "string" || !schema.callable.trim()) {
    throw new Error(`Node tool ${JSON.stringify(toolName)} must declare a callable`);
  }
  const module = await import(url.pathToFileURL(toolPath).href);
  const tool = module[schema.callable];
  if (typeof tool !== "function") {
    throw new Error(`site learning ${JSON.stringify(siteId)} is missing Node callable ${JSON.stringify(schema.callable)}`);
  }
  return tool(siteToolContext(page), args ?? {});
}

/** Run a learning's browser tool inside `page` and return its result. */
export async function runSiteBrowserTool(page: Page, siteId: string, toolName: string, args: unknown = {}): Promise<unknown> {
  checkToolCall("runSiteBrowserTool", page, siteId, toolName, args);
  const source = await loadBrowserToolSource(siteId, toolName);
  return page.evaluate(wrapBrowserTool(source, args));
}

/**
 * What a Node tool receives: the Page, plus the helpers Ego Lite's learnings
 * call, bound to that Page.
 */
export function siteToolContext(page: Page) {
  return {
    page,
    openOrReuseTab: (target: string, _options?: unknown) => page.goto(target),
    waitForLoad: (options?: { timeout?: number }) =>
      options === undefined ? page.waitForLoadState("load") : page.waitForLoadState("load", options),
    js: (expression: string) => page.evaluate(expression),
  };
}

async function targetUrl(op: string, signature: string, target: unknown): Promise<string> {
  if (target instanceof Page) return target.url();
  if (typeof target === "string" && target.trim()) return target;
  throw new TypeError(`${op} expects a Page or a URL string, got ${describe(target)}. Expected: ${signature}`);
}

function checkToolCall(op: string, page: unknown, siteId: unknown, toolName: unknown, args: unknown): void {
  const signature = `await ${op}(page, siteId, toolName, args?)`;
  if (!(page instanceof Page)) {
    throw new TypeError(`${op} runs a tool against a Page, so its first argument is the Page, got ${describe(page)}. Expected: ${signature}`);
  }
  if (typeof siteId !== "string" || !siteId.trim() || typeof toolName !== "string" || !toolName.trim()) {
    throw new TypeError(`${op} expects a site id and a tool name as non-empty strings. Expected: ${signature}`);
  }
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new TypeError(`${op} expects args as an object. Expected: ${signature}`);
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value !== "object") return String(value);
  return value.constructor?.name ?? "object";
}

// ---------------------------------------------------------------------------
// Discovery

export async function siteSkillsForUrl(target: string, root = learningsRoot()): Promise<LearningEntry[]> {
  const hostname = urlHostname(target);
  if (!hostname) return [];
  const matches: LearningEntry[] = [];
  for (const siteDir of await iterLearningDirs(root)) {
    let manifest: LearningManifest;
    try {
      manifest = await loadLearningManifest(siteDir);
    } catch {
      continue;
    }
    const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
    if (domains.some((domain) => typeof domain === "string" && domainMatches(hostname, domain))) {
      matches.push(learningEntry(siteDir, manifest));
    }
  }
  return matches;
}

export async function loadLearnedContext(target: string, root = learningsRoot()): Promise<LearnedContext> {
  const matches = await siteSkillsForUrl(target, root);
  const domain = urlHostname(target);
  if (matches.length === 0) return { exists: false, siteId: null, siteName: null, domain, knowledge: [], tools: [] };
  const knowledge: LearnedContext["knowledge"] = [];
  const tools: LearnedToolSignature[] = [];
  for (const entry of matches) {
    for (const notePath of entry.notes) {
      if (!isLearningNotePath(entry.path, notePath)) continue;
      let content: string;
      try {
        content = await fs.promises.readFile(notePath, "utf8");
      } catch {
        continue;
      }
      knowledge.push({ siteId: entry.id, fileName: path.basename(notePath), content });
    }
    for (const [toolName, schema] of Object.entries(entry.nodeTools)) {
      tools.push(signature(entry.id, toolName, "node", schema, "runSiteTool"));
    }
    for (const [toolName, schema] of Object.entries(entry.browserTools)) {
      tools.push(signature(entry.id, toolName, "browser", schema, "runSiteBrowserTool"));
    }
  }
  return { exists: true, siteId: matches[0]!.id, siteName: matches[0]!.name, domain, knowledge, tools };
}

function signature(siteId: string, toolName: string, toolType: "node" | "browser", schema: ToolSchema, helper: string): LearnedToolSignature {
  return {
    siteId,
    toolName,
    toolType,
    description: schema.description || "",
    args: schema.args || {},
    example: `await ${helper}(page, ${JSON.stringify(siteId)}, ${JSON.stringify(toolName)}, { ... })`,
  };
}

export async function findSiteSkill(siteId: string, root = learningsRoot()): Promise<{ siteDir: string; manifest: LearningManifest }> {
  for (const siteDir of await iterLearningDirs(root)) {
    let manifest: LearningManifest;
    try {
      manifest = await loadLearningManifest(siteDir);
    } catch {
      continue;
    }
    if (manifest.id === siteId) return { siteDir, manifest };
  }
  throw new Error(
    [
      `site learning not found: ${JSON.stringify(siteId)}`,
      `  searched: ${root}`,
      `  ZENIUS_AGENT_WORKSPACE: ${process.env.ZENIUS_AGENT_WORKSPACE || "unset"}`,
    ].join("\n"),
  );
}

export async function loadBrowserToolSource(siteId: string, toolName: string, root = learningsRoot()): Promise<string> {
  const { siteDir, manifest } = await findSiteSkill(siteId, root);
  const schema = toolSchemas(manifest, "browserTools")[toolName];
  if (!schema || typeof schema !== "object") {
    throw new Error(`browser tool ${JSON.stringify(toolName)} is not declared by site learning ${JSON.stringify(siteId)}`);
  }
  return fs.promises.readFile(relativeSitePath(siteDir, schema.path, "browser tool"), "utf8");
}

/** An expression that runs a browser tool's function source with `args`. */
export function wrapBrowserTool(source: string, args: unknown = {}): string {
  return `(async () => { const __zeniusBrowserTool = ${source.trim().replace(/;\s*$/, "")}\n; return await __zeniusBrowserTool(${JSON.stringify(args ?? {})}); })()`;
}

export async function iterLearningDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export async function loadLearningManifest(siteDir: string): Promise<LearningManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(path.join(siteDir, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`site learning ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`site learning ${JSON.stringify(siteDir)} manifest must be an object`);
  }
  return parsed as LearningManifest;
}

export function learningEntry(siteDir: string, manifest: LearningManifest): LearningEntry {
  const base = path.basename(siteDir);
  const notes = Array.isArray(manifest.notes) ? manifest.notes : [];
  return {
    id: manifest.id || base,
    name: manifest.name || manifest.id || base,
    path: siteDir,
    domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
    notes: notes.map((note) => path.join(siteDir, note)),
    nodeTools: toolSchemas(manifest, "nodeTools") as Record<string, NodeToolSchema>,
    browserTools: toolSchemas(manifest, "browserTools"),
  };
}

export function urlHostname(target: unknown): string {
  try {
    const text = String(target);
    const parsed = text.includes("://") ? new URL(text) : new URL(`https://${text}`);
    return (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function domainMatches(hostname: string, pattern: string): boolean {
  const normalized = String(pattern || "").toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("*.")) return hostname.endsWith(`.${normalized.slice(2)}`);
  return hostname === normalized;
}

function toolSchemas(manifest: LearningManifest, key: "nodeTools" | "browserTools"): Record<string, ToolSchema> {
  const value = manifest[key];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function isLearningNotePath(siteDir: string, notePath: string): boolean {
  const parts = path.relative(path.resolve(siteDir), path.resolve(notePath)).split(/[\\/]/);
  return parts.length === 2 && parts[0] === "notes" && parts[1]!.endsWith(".md") && parts.every((part) => part && part !== "." && part !== "..");
}

function relativeSitePath(siteDir: string, manifestPath: unknown, label: string): string {
  if (typeof manifestPath !== "string" || !manifestPath.trim()) throw new Error(`${label} path must be a non-empty relative path`);
  if (manifestPath.includes("\\") || path.isAbsolute(manifestPath) || manifestPath.split("/").includes("..")) {
    throw new Error(`${label} path must be relative to the site learning directory`);
  }
  const resolved = path.resolve(siteDir, manifestPath);
  const siteRoot = path.resolve(siteDir);
  if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}${path.sep}`)) {
    throw new Error(`${label} path must stay inside the site learning directory`);
  }
  return resolved;
}
