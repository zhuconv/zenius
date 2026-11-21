// Portions adapted from citrolabs/ego-lite (MIT License).
//
// help() text, built from the API schema. Formatting is Ego's: name, a blank
// line, the summary with its options, a blank line, the signature.

import { API_SCHEMA, apiEntry, normalizeApiName, type ApiEntry } from "./api-schema.ts";
import { codeHelp, errorsHelp } from "./error-guide.ts";

export function helpText(...names: unknown[]): string {
  if (names.length === 0) return [...defaultEntries().map(formatEntry), ERRORS_POINTER].join("\n\n");
  return names
    .map((name) => {
      if (typeof name === "string" && name.trim() === "errors") return errorsHelp();
      const code = typeof name === "string" ? codeHelp(name.trim()) : undefined;
      if (code) return code;
      const group = typeof name === "string" ? groupEntries(name.trim()) : [];
      if (group.length > 0) return group.map(formatEntry).join("\n\n");
      const entry = typeof name === "string" ? findEntry(name) : undefined;
      return entry ? formatEntry(entry) : `Unknown helper: ${String(name)}`;
    })
    .join("\n\n");
}

const ERRORS_POINTER = 'help("errors") lists every error code and refused kind, with what to do next.';

/** What help() lists by default: everything outside a group. */
export function defaultEntries(): ApiEntry[] {
  return API_SCHEMA.filter((entry) => entry.group === undefined);
}

function groupEntries(group: string): ApiEntry[] {
  return API_SCHEMA.filter((entry) => entry.group === group);
}

export function findEntry(name: string): ApiEntry | undefined {
  const trimmed = name.trim();
  const normalized = normalizeApiName(trimmed);
  return (
    apiEntry(normalized) ??
    apiEntry(trimmed) ??
    // A bare method name ("click") is unambiguous for most of the surface.
    apiEntry(`Page.${trimmed}`) ??
    apiEntry(`TaskSpace.${trimmed}`)
  );
}

export function formatEntry(entry: ApiEntry): string {
  const options = entry.options
    ? Object.entries(entry.options)
        .map(([name, option]) => `${name}${option.values ? ` (${option.values.join(" | ")})` : ""}: ${option.description}`)
        .join(" ")
    : "";
  const description = options ? `${entry.summary} Options: ${options}` : entry.summary;
  return [entry.name, "", description, "", entry.signature].join("\n");
}
