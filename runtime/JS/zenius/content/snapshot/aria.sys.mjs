// Locators, ARIA roles and accessible names for content code: zen-input's
// selector engine and the snapshot walker resolve `loc=` the same way.
// The SPI is in docs/SPI.md, "Refs and locators (zen-snapshot)"; keep these
// exports stable and tell zen-input before changing them.
//
// The work runs in the document's sandbox (sandbox.sys.mjs): Playwright's
// role and name code (aria.js) and Ego's locator rules (locators.js).
// Elements come back as chrome sees them, through Xrays.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { load, sandboxFor } from "chrome://userscripts/content/zenius/content/snapshot/sandbox.sys.mjs";

/** @typedef {{kind: "css", selector: string, raw: string}
 *   | {kind: "href", href: string, raw: string}
 *   | {kind: "role", role: string, name: string, nameMode: "exact"|"substring", raw: string}} Locator */

function locatorsFor(node) {
  const doc = node.nodeType === 9 ? node : node.ownerDocument;
  return load(sandboxFor(doc.defaultView), "locators").__zsLocators;
}

// Ego's parseLocatorName: a JSON string, a single-quoted string, or bare text.
function parseLocatorName(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses the locator forms snapshots print (with or without `loc=`).
 *
 * @param {string} input
 * @returns {Locator|null} null for anything else (text=, raw CSS, …)
 */
export function parseLocator(input) {
  const raw = String(input ?? "").trim();
  const value = raw.startsWith("loc=") ? raw.slice(4) : raw;
  if (value.startsWith("css:") || value.startsWith("css=")) {
    const selector = value.slice(4).trim();
    return selector ? { kind: "css", selector, raw } : null;
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw } : null;
  }
  const role = /^role:([A-Za-z0-9_-]+)\[name(\*=|=)(.+)\]$/.exec(value);
  if (role) {
    return {
      kind: "role",
      role: role[1].toLowerCase(),
      name: parseLocatorName(role[3]),
      nameMode: role[2] === "*=" ? "substring" : "exact",
      raw,
    };
  }
  return null;
}

/**
 * Elements of one document (open shadow roots included, other frames not)
 * that a locator matches, in Ego's order: the document's matches, then each
 * open shadow root's, depth first.
 *
 * @param {Document} doc
 * @param {string|Locator} locator
 * @returns {Element[]}
 */
export function queryLocator(doc, locator) {
  const parsed = typeof locator === "string" ? parseLocator(locator) : locator;
  if (!parsed) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `Invalid locator: ${locator}`);
  }
  const value = parsed.kind === "css" ? parsed.selector : parsed.kind === "href" ? parsed.href : parsed.role;
  let found;
  try {
    found = locatorsFor(doc).query(doc, parsed.kind, value, parsed.name ?? "", parsed.nameMode ?? "exact");
  } catch (e) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `Invalid selector: ${parsed.raw}: ${e?.message ?? e}`);
  }
  return Array.from(Cu.unwaiveXrays(found));
}

/** The element's ARIA role, explicit or implicit, or null. */
export function ariaRole(element) {
  return locatorsFor(element).role(element);
}

/** The element's accessible name, whitespace collapsed and trimmed. */
export function accessibleName(element) {
  return locatorsFor(element).name(element);
}
