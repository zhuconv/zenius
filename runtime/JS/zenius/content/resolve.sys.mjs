// Portions adapted from citrolabs/ego-lite (MIT License).
//
// The selector engine for page actions (the input layer), following Ego's
// element-resolver.ts: refs (@N, ref=N, N), loc=css:/role:/href:, text=,
// xpath=, raw CSS through open shadow roots, and the Playwright subset (css=,
// terminal :has-text()/:text-is(), >> nth=N). Parsing has no DOM or
// parent-only dependencies, so the parent imports it too; matching runs in
// the document's own process, on Xrays.
//
// Messages are Ego's word for word: its e2e cases match them.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { isWebDocument } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
import * as A from "chrome://userscripts/content/zenius/content/actionability.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  queryLocator: "chrome://userscripts/content/zenius/content/snapshot/aria.sys.mjs",
});

// ---------------------------------------------------------------- refs

/** `@21`, `ref=21` and `21` are refs; returns the digits or null. */
export function parseRef(input) {
  const trimmed = String(input || "").trim();
  const candidates = [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed,
  ];
  return candidates.find(c => c !== null && /^\d+$/.test(c)) ?? null;
}

// ---------------------------------------------------------------- locator grammar

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  return { listboxoption: "option", textfield: "textbox" }[role] || role;
}

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

/** Positions of `token` outside quotes and at bracket and paren depth 0. */
function topLevelTokenPositions(value, token) {
  const positions = [];
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }
    if (bracketDepth === 0 && parenDepth === 0 && value.startsWith(token, index)) {
      positions.push(index);
      index += token.length - 1;
    }
  }
  return positions;
}

function isTopLevelPosition(value, position) {
  let quote;
  let escaped = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < position; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  return !quote && bracketDepth === 0 && parenDepth === 0;
}

function matchingParenPosition(value, open) {
  let quote;
  let escaped = false;
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    }
    if (character === ")" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

/** One CSS string token, with CSS escapes decoded. */
function parseCssString(value) {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) {
    return { valid: false };
  }
  let decoded = "";
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      return index === value.length - 1 ? { valid: true, value: decoded } : { valid: false };
    }
    if (character === "\n" || character === "\r" || character === "\f") {
      return { valid: false };
    }
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= value.length) {
      return { valid: false };
    }
    if (value[index] === "\r" && value[index + 1] === "\n") {
      index += 1;
    }
    if (value[index] === "\n" || value[index] === "\r" || value[index] === "\f") {
      continue;
    }
    const hex = value.slice(index).match(/^[0-9a-fA-F]{1,6}/)?.[0];
    if (!hex) {
      decoded += value[index];
      continue;
    }
    index += hex.length - 1;
    const terminator = value[index + 1];
    if (terminator === "\r") {
      index += value[index + 2] === "\n" ? 2 : 1;
    } else if (terminator === "\n" || terminator === "\f" || terminator === "\t" || terminator === " ") {
      index += 1;
    }
    const codePoint = Number.parseInt(hex, 16);
    decoded += codePoint === 0 || codePoint > 0x10ffff ? "�" : String.fromCodePoint(codePoint);
  }
  return { valid: false };
}

function parseTerminalCssText(selector) {
  const pseudos = [
    { token: ":has-text(", mode: "substring" },
    { token: ":text-is(", mode: "exact" },
  ];
  for (let index = 0; index < selector.length; index += 1) {
    if (!isTopLevelPosition(selector, index)) {
      continue;
    }
    const pseudo = pseudos.find(({ token }) => selector.startsWith(token, index));
    if (!pseudo) {
      continue;
    }
    const open = index + pseudo.token.length - 1;
    const close = matchingParenPosition(selector, open);
    if (close === -1 || selector.slice(close + 1).trim()) {
      return { valid: false };
    }
    const base = selector.slice(0, index).trim();
    const string = parseCssString(selector.slice(open + 1, close).trim());
    if (!base || topLevelTokenPositions(base, ",").length > 0 || !string.valid) {
      return { valid: false };
    }
    return { valid: true, selector: base, mode: pseudo.mode, text: string.value };
  }
  return undefined;
}

function containsUnquotedTextPseudo(value) {
  const tokens = [":has-text(", ":text-is("];
  let quote;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (tokens.some(token => value.startsWith(token, index))) {
      return true;
    }
  }
  return false;
}

function parseCssLocator(selector, raw) {
  const trimmed = selector.trim();
  if (!trimmed) {
    return null;
  }
  const text = parseTerminalCssText(trimmed);
  if (text?.valid) {
    return { kind: "cssText", selector: text.selector, mode: text.mode, text: text.text, raw };
  }
  if (text || containsUnquotedTextPseudo(trimmed)) {
    return null;
  }
  return { kind: "css", selector: trimmed, raw };
}

function parseTerminalNth(value) {
  const separators = topLevelTokenPositions(value, ">>");
  if (separators.length === 0) {
    return undefined;
  }
  if (separators.length !== 1) {
    return { valid: false };
  }
  const base = value.slice(0, separators[0]).trim();
  const match = /^nth=(-?\d+)$/.exec(value.slice(separators[0] + 2).trim());
  if (!base || !match) {
    return { valid: false };
  }
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index < -1) {
    return { valid: false };
  }
  return { valid: true, base, index };
}

function parseLocatorCore(value, raw, allowRawCss) {
  if (value.startsWith("css:") || value.startsWith("css=")) {
    return parseCssLocator(value.slice(4), raw);
  }
  if (value.startsWith("href:")) {
    const href = value.slice(5);
    return href ? { kind: "href", href, raw } : null;
  }
  if (value.startsWith("text=")) {
    const body = value.slice(5).trim();
    if (!body) {
      return null;
    }
    const quoted = (body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"));
    const text = quoted ? parseLocatorName(body) : body;
    return normalizeText(text) ? { kind: "text", mode: quoted ? "exact" : "substring", text, raw } : null;
  }
  const roleMatch = /^role:([A-Za-z0-9_-]+)\[name(\*=|=)(.+)\]$/.exec(value);
  if (roleMatch) {
    return {
      kind: "role",
      role: normalizeRole(roleMatch[1]),
      nameMode: roleMatch[2] === "*=" ? "substring" : "exact",
      name: parseLocatorName(roleMatch[3]),
      raw,
    };
  }
  if (allowRawCss || parseTerminalCssText(value)) {
    return parseCssLocator(value, raw);
  }
  return null;
}

export function parseLocator(input) {
  const raw = String(input || "").trim();
  const value = raw.startsWith("loc=") ? raw.slice(4) : raw;
  const nth = parseTerminalNth(value);
  if (nth?.valid) {
    const locator = parseLocatorCore(nth.base, raw, true);
    if (!locator || locator.kind === "role" || locator.kind === "nth") {
      return null;
    }
    return { kind: "nth", locator, index: nth.index, raw };
  }
  if (nth) {
    return null;
  }
  return parseLocatorCore(value, raw, false);
}

const LOCATOR_GRAMMAR =
  'Expected loc=role:<role>[name="<exact name>"], loc=role:<role>[name*="<name part>"], loc=css:<selector>, loc=href:<substring>, text=..., css=..., a terminal :has-text(...) or :text-is(...), or a terminal >> nth=N';

/**
 * What a target string means: {kind: "ref", id}, {kind: "locator", locator},
 * {kind: "xpath", expr, raw} or {kind: "css", selector, raw}. Throws
 * ZEN_INVALID_ARGUMENT for a malformed locator, before any page work.
 */
export function parseTarget(input) {
  const id = parseRef(input);
  if (id) {
    return { kind: "ref", id, raw: String(input).trim() };
  }
  const locator = parseLocator(input);
  if (locator) {
    return { kind: "locator", locator, raw: locator.raw };
  }
  const value = String(input || "").trim();
  if (
    value.startsWith("loc=") ||
    value.startsWith("role:") ||
    value.startsWith("text=") ||
    value.startsWith("css=") ||
    containsUnquotedTextPseudo(value) ||
    topLevelTokenPositions(value, ">>").length > 0
  ) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `Invalid locator: ${value}. ${LOCATOR_GRAMMAR}`, { selector: value });
  }
  const raw = String(input);
  if (raw.startsWith("xpath=")) {
    return { kind: "xpath", expr: raw.slice(6), raw };
  }
  return { kind: "css", selector: raw, raw };
}

/** `Selector <raw>` or `Locator <raw>`, Ego's message subject. */
export function subjectOf(target) {
  return target.kind === "locator" ? `Locator ${target.locator.raw}` : `Selector ${target.raw}`;
}

// ---------------------------------------------------------------- matching in one document

/** querySelectorAll in the document, then in each open shadow root (Ego's order). */
export function queryAllOpenShadow(doc, selector) {
  const matches = [];
  const roots = [doc];
  while (roots.length) {
    const root = roots.pop();
    const found = root.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) {
      matches.push(found[i]);
    }
    const all = root.querySelectorAll("*");
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const shadowRoot = all[i].shadowRoot;
      if (shadowRoot) {
        roots.push(shadowRoot);
      }
    }
  }
  return matches;
}

function isButtonInput(el) {
  const type = String(el.getAttribute?.("type") || "").toLowerCase();
  return el.tagName === "INPUT" && (type === "button" || type === "submit");
}

const TEXT_EXCLUDED_TAGS = new Set(["HEAD", "NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE", "TITLE"]);
const TEXT_EXCLUDED_SELECTOR = [...TEXT_EXCLUDED_TAGS].join(",").toLowerCase();

/**
 * textContent without the text of the elements text= never matches. Ego
 * reads textContent itself, so a page whose script, style or title holds
 * the text matched its <body> or <html>: a wait for "Order confirmed" sitting
 * in a page's JSON passed at once, and a click hit the body. Playwright's
 * text and Ego's own :has-text() leave that text out, as here.
 *
 * @param {Element} el
 * @param {Map<Element, string>} cache
 */
function matchableText(el, cache) {
  let text = cache.get(el);
  if (text === undefined) {
    if (!el.querySelector(TEXT_EXCLUDED_SELECTOR)) {
      text = el.textContent;
    } else {
      text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === 3 || child.nodeType === 4) {
          text += child.nodeValue;
        } else if (child.nodeType === 1 && !TEXT_EXCLUDED_TAGS.has(child.tagName)) {
          text += matchableText(child, cache);
        }
      }
    }
    cache.set(el, text);
  }
  return text;
}

function isComposedDescendant(ancestor, node) {
  for (let current = node; current; ) {
    if (current === ancestor) {
      return true;
    }
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode?.();
    current = root && root.nodeType === 11 && root.host ? root.host : null;
  }
  return false;
}

/** text=: substring of the text, or exact own text; deepest matches only. */
function textElements(doc, locator) {
  const expected = normalizeText(locator.text);
  const lower = expected.toLowerCase();
  const cache = new Map();
  const fullText = el => normalizeText(isButtonInput(el) ? el.value : matchableText(el, cache));
  const immediateText = el => {
    if (isButtonInput(el)) {
      return normalizeText(el.value);
    }
    const parts = [];
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
      }
    }
    return normalizeText(parts.join(" "));
  };
  const matches = queryAllOpenShadow(doc, "*").filter(
    el =>
      !TEXT_EXCLUDED_TAGS.has(el.tagName) &&
      (locator.mode === "exact" ? immediateText(el) === expected : fullText(el).toLowerCase().includes(lower))
  );
  return matches.filter(el => !matches.some(other => other !== el && isComposedDescendant(el, other)));
}

function hrefElements(doc, href) {
  return queryAllOpenShadow(doc, "a[href]").filter(el => {
    try {
      const u = new URL(el.href, doc.location.href);
      return u.pathname + u.search + u.hash === href || u.href === href;
    } catch {
      return false;
    }
  });
}

function cssTextNormalize(value) {
  return String(value ?? "")
    .replace(/[\u200b\xad]/g, "")
    .replace(/[\r\n\s\t]+/g, " ")
    .trim();
}

/** Text for :has-text()/:text-is(): own runs, children, and the open shadow root. */
function elementText(element, doc) {
  const tag = element.tagName;
  if (tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "STYLE" || (element.nodeType === 1 && doc.head?.contains(element))) {
    return { full: "", immediate: [] };
  }
  if (element.nodeType === 1 && isButtonInput(element)) {
    const value = String(element.value || "");
    return { full: value, immediate: [value] };
  }
  let full = "";
  let current = "";
  const immediate = [];
  const flush = () => {
    if (current) {
      immediate.push(current);
    }
    current = "";
  };
  for (const child of element.childNodes) {
    if (child.nodeType === 3) {
      full += child.nodeValue || "";
      current += child.nodeValue || "";
    } else if (child.nodeType !== 8) {
      flush();
      if (child.nodeType === 1) {
        full += elementText(child, doc).full;
      }
    }
  }
  flush();
  if (element.shadowRoot) {
    full += elementText(element.shadowRoot, doc).full;
  }
  return { full, immediate };
}

function cssTextElements(doc, locator) {
  const expected = cssTextNormalize(locator.text);
  return queryAllOpenShadow(doc, locator.selector).filter(el => {
    const text = elementText(el, doc);
    if (locator.mode === "exact") {
      return (expected === "" && text.immediate.length === 0) || text.immediate.some(v => cssTextNormalize(v) === expected);
    }
    return cssTextNormalize(text.full).toLowerCase().includes(expected.toLowerCase());
  });
}

function locatorElements(doc, locator) {
  switch (locator.kind) {
    case "css":
      return queryAllOpenShadow(doc, locator.selector);
    case "text":
      return textElements(doc, locator);
    case "href":
      return hrefElements(doc, locator.href);
    case "cssText":
      return cssTextElements(doc, locator);
    case "nth": {
      const values = locatorElements(doc, locator.locator);
      const index = locator.index === -1 ? values.length - 1 : locator.index;
      return index >= 0 && index < values.length ? [values[index]] : [];
    }
    case "role":
      return Array.from(
        lazy.queryLocator(doc, {
          kind: "role",
          role: locator.role,
          name: locator.name,
          nameMode: locator.nameMode,
          raw: locator.raw,
        })
      );
  }
  throw new ZenError("ZEN_INTERNAL", `unsupported locator kind ${locator.kind}`);
}

function numericCssIdHint(raw) {
  const value = String(raw || "").trim();
  const prefix = value.startsWith("loc=css:") ? "loc=css:" : value.startsWith("css:") ? "css:" : "";
  const match = /^#([0-9][A-Za-z0-9_-]*)$/.exec(value.slice(prefix.length));
  return match ? `CSS ids beginning with a digit must be escaped; use ${prefix}[id=${JSON.stringify(match[1])}]` : undefined;
}

function invalidSelector(target, e) {
  const exc = e?.message || String(e) || "evaluation error";
  if (e instanceof ZenError) {
    return e;
  }
  if (target.kind === "locator") {
    return new ZenError("ZEN_INVALID_ARGUMENT", `Invalid selector: ${target.locator.raw}: ${exc}`, { selector: target.raw });
  }
  const hint = numericCssIdHint(target.raw);
  return new ZenError("ZEN_INVALID_ARGUMENT", `Invalid selector: ${target.raw}${hint ? `. ${hint}` : ""}: ${exc}`, {
    selector: target.raw,
  });
}

/** Every match of a parsed target in one document (no frames), in Ego's order. */
export function elementsIn(doc, target) {
  try {
    if (target.kind === "css") {
      return queryAllOpenShadow(doc, target.selector);
    }
    if (target.kind === "xpath") {
      const result = doc.evaluate(target.expr, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      const out = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node?.nodeType !== 1) {
          throw new Error("XPath result is not an element");
        }
        out.push(node);
      }
      return out;
    }
    return locatorElements(doc, target.locator);
  } catch (e) {
    throw invalidSelector(target, e);
  }
}

// ---------------------------------------------------------------- per-document summaries

/**
 * Matches in one document checked against an actionability level (null for
 * none): every match, the actionable ones, and the first blocker, with its
 * data (a covered point's, for ZEN_NOT_ACTIONABLE). `spot`: the point a
 * pointer level tests (actionabilityBlocker).
 */
export function summarize(elements, level, spot) {
  const actionable = [];
  let blocker = null;
  let blockerData;
  for (const el of elements) {
    const b = level ? A.actionabilityBlocker(el, level, spot) : null;
    if (!b) {
      actionable.push(el);
    } else if (!blocker) {
      blocker = b.text;
      blockerData = b.data;
    }
  }
  return { count: elements.length, actionable, blocker, blockerData };
}

/** Ego's ambiguity diagnostics for some matches. */
export function diagnostics(elements) {
  const normalize = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const visible = el => !el.closest?.("[hidden], [inert]") && A.isCountedVisible(el);
  const candidates = elements.slice(0, 3).map(el => {
    const name = normalize(
      el.getAttribute?.("aria-label") || el.getAttribute?.("alt") || el.getAttribute?.("title") || el.value || el.innerText || el.textContent
    ).slice(0, 80);
    return {
      tag: String(el.tagName || "element").toLowerCase(),
      role: el.getAttribute?.("role") || undefined,
      name: name || undefined,
      visible: visible(el),
      disabled: A.isActionTargetDisabled(el),
    };
  });
  const visibleCount = elements.filter(visible).length;
  return { visible: visibleCount, hidden: elements.length - visibleCount, candidates };
}

/** Merge per-context diagnostics the way Ego does (at most 3 candidates). */
export function mergeDiagnostics(list) {
  const combined = { visible: 0, hidden: 0, candidates: [] };
  for (const d of list) {
    if (!d) {
      continue;
    }
    combined.visible += d.visible;
    combined.hidden += d.hidden;
    combined.candidates.push(...d.candidates.slice(0, 3 - combined.candidates.length));
  }
  return combined.visible + combined.hidden > 0 ? combined : undefined;
}

function formatCandidate(c) {
  const tag = c?.tag || "element";
  const role = c?.role ? ` role=${c.role}` : "";
  const name = c?.name ? ` ${JSON.stringify(c.name)}` : "";
  const states = [c?.visible === false ? "hidden" : "visible"];
  if (c?.disabled) {
    states.push("disabled");
  }
  return `${tag}${role}${name} (${states.join(", ")})`;
}

// ---------------------------------------------------------------- errors

const REASONS = [
  [/detached from the DOM|no browsing context|is not connected/, "detached"],
  [/is disabled/, "disabled"],
  [/intercepts pointer events/, "covered"],
  [/hidden or inert|zero-sized|display: none|visibility: hidden|no actionable point|not visible/, "hidden"],
];

/** ZEN_NOT_ACTIONABLE's data.reason for an Ego blocker text. */
export function reasonOf(text) {
  return REASONS.find(([re]) => re.test(text))?.[1];
}

export function notFoundError(target) {
  return new ZenError("ZEN_SELECTOR_NOT_FOUND", `${subjectOf(target)} matched 0 elements`, { matches: 0, transient: true });
}

/** `blockerData`: the blocker's own, such as a covered point's cover, position and end. */
export function noneActionableError(target, total, blocker, blockerData) {
  const data = { matches: total, ...blockerData, transient: true };
  const reason = blocker ? reasonOf(blocker) : undefined;
  if (reason) {
    data.reason = reason;
  }
  return new ZenError(
    "ZEN_NOT_ACTIONABLE",
    `${subjectOf(target)} matched ${total} elements, but none can receive input${blocker ? `; ${blocker}` : ""}`,
    data
  );
}

export function ambiguityError(target, count, diag) {
  const role = target.kind === "locator" && target.locator.kind === "role";
  const d = role ? undefined : diag;
  const visibility = d ? ` (${d.visible} visible, ${d.hidden} hidden)` : "";
  const candidates = d?.candidates?.length ? ` Candidates: ${d.candidates.map((c, i) => `${i + 1}. ${formatCandidate(c)}`).join("; ")}.` : "";
  const data = { matches: count };
  if (d) {
    Object.assign(data, { visible: d.visible, hidden: d.hidden, candidates: d.candidates });
  }
  return new ZenError(
    "ZEN_SELECTOR_AMBIGUOUS",
    `${subjectOf(target)} matched ${count} elements${visibility}.${candidates} Use a current snapshot ref or a more specific role, text, or CSS selector.`,
    data
  );
}

// ---------------------------------------------------------------- contexts

/**
 * The documents of this page that live in this process, from `win` down, in
 * frame-tree preorder; an out-of-process frame is a placeholder {remote: bcId}
 * at its place in the order.
 */
export function contextsFrom(win) {
  const out = [{ win }];
  const visit = bc => {
    for (const child of bc.children) {
      if (child.docShell) {
        const w = child.docShell.domWindow;
        // I5 (the observe layer glue): never into a document that isn't web
        // content (an error page).
        if (w?.document && !isWebDocument(w.document)) {
          continue;
        }
        if (w?.document) {
          out.push({ win: w });
        }
        visit(child);
      } else {
        out.push({ remote: child.id });
      }
    }
  };
  visit(win.browsingContext);
  return out;
}

/**
 * Summaries of every in-process context under `win` (the first is `win`'s
 * own document), with placeholders for out-of-process frames. Diagnostics are
 * included only where something matched.
 */
export function summarizeContexts(win, target, level, { skipFirst = false, spot } = {}) {
  const out = [];
  const ctxs = contextsFrom(win);
  for (let i = 0; i < ctxs.length; i++) {
    const c = ctxs[i];
    if (c.remote) {
      out.push({ remote: c.remote });
      continue;
    }
    if (i === 0 && skipFirst) {
      continue;
    }
    const elements = elementsIn(c.win.document, target);
    const s = summarize(elements, level, spot);
    out.push({
      bcId: c.win.browsingContext.id,
      count: s.count,
      actionable: s.actionable.length,
      blocker: s.blocker,
      blockerData: s.blockerData,
      diag: s.count ? diagnostics(elements) : undefined,
    });
  }
  return out;
}

/**
 * Ego's choice over every context in order (main first): one actionable main
 * match wins; several are ambiguous; otherwise the frames decide.
 *
 * @param {object[]} list  summaries, main first, no placeholders
 * @returns {{bcId: number}} the context holding the target
 */
export function decide(target, list, level) {
  const [main, ...frames] = list;
  if (main.actionable === 1) {
    return { bcId: main.bcId };
  }
  if (main.actionable > 1 || (!level && main.count > 1)) {
    throw ambiguityError(target, main.count, main.diag);
  }
  if (!level && main.count === 1) {
    return { bcId: main.bcId };
  }
  let total = main.count;
  let act = 0;
  const hits = [];
  for (const f of frames) {
    total += f.count;
    if (!f.count) {
      continue;
    }
    if (level) {
      act += f.actionable;
      if (f.actionable > 0) {
        hits.push(f);
      }
    } else {
      act += f.count;
      hits.push(f);
    }
  }
  if (total === 0) {
    throw notFoundError(target);
  }
  if (act === 1) {
    return { bcId: hits[0].bcId };
  }
  if (act === 0) {
    const blocked = list.find(s => s.blocker);
    throw noneActionableError(target, total, blocked?.blocker ?? null, blocked?.blockerData);
  }
  throw ambiguityError(target, total, mergeDiagnostics(hits.map(h => h.diag)));
}

/** The element an action uses in this document: its first actionable match. */
export function pickIn(doc, target, level, spot) {
  const s = summarize(elementsIn(doc, target), level, spot);
  if (s.actionable.length) {
    return s.actionable[0];
  }
  if (!s.count) {
    throw new ZenError("ZEN_SELECTOR_NOT_FOUND", `Element not found: ${target.raw}`, { matches: 0, transient: true });
  }
  throw noneActionableError(target, s.count, s.blocker, s.blockerData);
}
