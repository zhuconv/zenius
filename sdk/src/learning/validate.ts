// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Checks a learnings directory: manifest shape, files the manifest names,
// Node tools that import and export their callable, and no snapshot refs
// (they change on every snapshot; learnings need stable locators). The skill
// tests run it over the learnings that ship with zenius.

import { fs, path, url } from "../node.ts";
import { iterLearningDirs, learningsRoot } from "./index.ts";

const TOOL_VALUE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const TEMP_REF_RE = /(?:@\d+\b|\bref=\d+\b)/;

export async function validateLearnings(root = learningsRoot()): Promise<string[]> {
  const errors: string[] = [];
  for (const siteDir of await iterLearningDirs(root)) errors.push(...(await validateLearning(siteDir)));
  return errors;
}

export async function validateLearning(siteDir: string): Promise<string[]> {
  const errors: string[] = [];
  const siteId = path.basename(siteDir);
  let manifest: any;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(siteDir, "manifest.json"), "utf8"));
  } catch (error) {
    return [`${siteId}: invalid or missing manifest.json: ${(error as Error).message}`];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [`${siteId}: manifest.json must contain a JSON object`];
  if (manifest.id !== siteId) errors.push(`${siteId}: manifest id must match directory name`);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push(`${siteId}: name must be a non-empty string`);

  const domains = stringList(manifest, "domains", errors, siteId);
  if (domains.length === 0) errors.push(`${siteId}: domains must not be empty`);
  for (const domain of domains) if (!isValidDomain(domain)) errors.push(`${siteId}: invalid domain ${JSON.stringify(domain)}`);

  for (const note of stringList(manifest, "notes", errors, siteId)) {
    if (!isPathUnder(note, "notes", ".md")) {
      errors.push(`${siteId}: notes must point to notes/*.md: ${JSON.stringify(note)}`);
      continue;
    }
    await requireFile(siteDir, note, `${siteId}: missing note ${JSON.stringify(note)}`, errors);
    await rejectTemporaryRefs(siteDir, note, `${siteId}: note ${JSON.stringify(note)}`, errors);
  }

  for (const [toolName, schema] of Object.entries(toolMap(manifest, "nodeTools", errors, siteId))) {
    if (!schema || typeof schema !== "object" || !isPathUnder(schema.path, "tools", ".js")) continue;
    const toolPath = path.join(siteDir, schema.path);
    if (!fs.existsSync(toolPath)) {
      errors.push(`${siteId}: missing Node tool file ${JSON.stringify(schema.path)} for tool ${JSON.stringify(toolName)}`);
      continue;
    }
    await rejectTemporaryRefs(siteDir, schema.path, `${siteId}: Node tool ${JSON.stringify(toolName)}`, errors);
    try {
      const module = await import(url.pathToFileURL(toolPath).href);
      if (typeof schema.callable === "string" && typeof module[schema.callable] !== "function") {
        errors.push(`${siteId}: missing Node callable ${JSON.stringify(schema.callable)} for tool ${JSON.stringify(toolName)}`);
      }
    } catch (error) {
      errors.push(`${siteId}: cannot import Node tool ${JSON.stringify(schema.path)}: ${(error as Error).message}`);
    }
  }

  for (const [toolName, schema] of Object.entries(toolMap(manifest, "browserTools", errors, siteId))) {
    if (!schema || typeof schema !== "object" || !isPathUnder(schema.path, "browser-tools", ".js")) continue;
    const message = `${siteId}: missing browser tool file ${JSON.stringify(schema.path)} for tool ${JSON.stringify(toolName)}`;
    if (!(await requireFile(siteDir, schema.path, message, errors))) continue;
    await rejectTemporaryRefs(siteDir, schema.path, `${siteId}: browser tool ${JSON.stringify(toolName)}`, errors);
    // A browser tool is one function expression; check it parses as one.
    const source = await fs.promises.readFile(path.join(siteDir, schema.path), "utf8");
    try {
      new Function(`return (${source.trim().replace(/;\s*$/, "")}\n);`);
    } catch (error) {
      errors.push(`${siteId}: browser tool ${JSON.stringify(toolName)} is not a function expression: ${(error as Error).message}`);
    }
  }
  return errors;
}

function stringList(manifest: any, key: string, errors: string[], siteId: string): string[] {
  const value = manifest[key] || [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    errors.push(`${siteId}: ${key} must be a list of non-empty strings`);
    return [];
  }
  return value;
}

function toolMap(manifest: any, key: string, errors: string[], siteId: string): Record<string, any> {
  const value = manifest[key] || {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${siteId}: ${key} must be an object keyed by tool name`);
    return {};
  }
  for (const [toolName, schema] of Object.entries(value)) validateToolSchema(siteId, key, toolName, schema, errors);
  return value;
}

function validateToolSchema(siteId: string, key: string, toolName: string, schema: any, errors: string[]): void {
  const prefix = `${siteId}: ${key}.${toolName}`;
  if (!toolName || /[\\/]/.test(toolName) || toolName.includes("..") || toolName === ".") {
    errors.push(`${siteId}: ${key} contains invalid tool name ${JSON.stringify(toolName)}`);
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${prefix}: schema must be an object`);
    return;
  }
  if (typeof schema.description !== "string" || !schema.description.trim()) errors.push(`${prefix}: description must be a non-empty string`);
  if (key === "nodeTools") {
    if (!isPathUnder(schema.path, "tools", ".js")) errors.push(`${prefix}: path must be a relative tools/*.js path`);
    if (typeof schema.callable !== "string" || !schema.callable.trim()) errors.push(`${prefix}: callable must be a non-empty string`);
  } else if (!isPathUnder(schema.path, "browser-tools", ".js")) {
    errors.push(`${prefix}: path must be a relative browser-tools/*.js path`);
  }
  if (!schema.args || typeof schema.args !== "object" || Array.isArray(schema.args)) {
    errors.push(`${prefix}: args must be an object`);
  } else {
    for (const [argName, argSchema] of Object.entries(schema.args)) {
      validateValueSchema(`${prefix}.args.${argName}`, argSchema, errors, true, "arg");
    }
  }
  if (!schema.returns || typeof schema.returns !== "object" || Array.isArray(schema.returns)) {
    errors.push(`${prefix}: returns must be an object`);
  } else {
    validateValueSchema(`${prefix}.returns`, schema.returns, errors, false, "return");
  }
}

function validateValueSchema(prefix: string, schema: any, errors: string[], requireRequired: boolean, typeLabel: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${prefix}: schema must be an object`);
    return;
  }
  if (!TOOL_VALUE_TYPES.has(schema.type)) errors.push(`${prefix}: invalid ${typeLabel} type ${JSON.stringify(schema.type)}`);
  if (requireRequired && typeof schema.required !== "boolean") errors.push(`${prefix}: required must be a boolean`);
  if (typeof schema.description !== "string" || !schema.description.trim()) errors.push(`${prefix}: description must be a non-empty string`);
}

function isValidDomain(pattern: string): boolean {
  if (!pattern || pattern.includes("://") || pattern.includes("/") || pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("*")) return pattern.startsWith("*.") && pattern.indexOf("*") === pattern.lastIndexOf("*") && pattern.length > 2;
  return true;
}

function isPathUnder(target: unknown, folder: string, extension: string): boolean {
  if (typeof target !== "string" || !target || target.includes("\\") || path.isAbsolute(target)) return false;
  const parts = target.split("/");
  if (!parts.every((part) => part && part !== "." && part !== "..")) return false;
  return parts.length === 2 && parts[0] === folder && parts[1]!.endsWith(extension);
}

async function requireFile(siteDir: string, relativePath: string, message: string, errors: string[]): Promise<boolean> {
  if (fs.existsSync(path.join(siteDir, relativePath))) return true;
  errors.push(message);
  return false;
}

async function rejectTemporaryRefs(siteDir: string, relativePath: string, prefix: string, errors: string[]): Promise<void> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(siteDir, relativePath), "utf8");
  } catch {
    return;
  }
  if (TEMP_REF_RE.test(text)) errors.push(`${prefix}: contains temporary snapshot ref; use stable locators instead`);
}
