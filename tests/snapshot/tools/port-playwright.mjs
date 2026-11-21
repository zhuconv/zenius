#!/usr/bin/env node
// Regenerates runtime/JS/zenius/content/snapshot/aria.js from Playwright's
// injected domUtils.ts and roleUtils.ts (Apache-2.0), so the port stays
// reproducible: zenius changes go here, never into the generated file.
//
//   node tests/snapshot/tools/port-playwright.mjs [path/to/playwright]
//
// The default source is refs/playwright (gitignored; clone it first). Types
// are stripped with the SDK's TypeScript, comments kept. The changes:
//   - @isomorphic/cssTokenizer is replaced by the small tokenizer below,
//     which covers what parseCSSContentPropertyAsString needs;
//   - both modules become one function scope inside an IIFE, and every
//     export is published as the frozen global __zsAria of the sandbox the
//     script runs in (content/snapshot/sandbox.sys.mjs), never the page;
//   - every DOM access goes through content/snapshot/dom.js, found with the
//     type checker (realmSafe below), so page script never sees an object
//     of ours (docs/research/content-boundary.md, finding 1);
//   - PATCHES below: a secret field's value (a password field's, or one
//     masked with -webkit-text-security) never goes into a name, and two
//     spots the checker can't place are made plain.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PW = resolve(process.argv[2] || join(ROOT, "refs/playwright"));
const SRC = join(PW, "packages/injected/src");
const OUT = join(ROOT, "runtime/JS/zenius/content/snapshot/aria.js");
const ts = createRequire(import.meta.url)(join(ROOT, "sdk/node_modules/typescript"));

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", PW, "log", "-1", "--format=%H"], { encoding: "utf8" }).trim();
} catch {}

const exported = [];

// zenius changes to Playwright's source: [file, from, to], each `from` found
// exactly once, so a Playwright update that moves the code stops the port
// instead of dropping the change.
const SECRET = "isSecretField(element) ? '' : ";
const PATCHES = [
  // An embedded control's value goes into a label's or labelledby's name
  // (accname 2C); a password's never does (snapshot.md section 1.2).
  ["roleUtils.ts",
    "return compositeString((element as HTMLInputElement | HTMLTextAreaElement).value, element",
    `return compositeString(${SECRET}(element as HTMLInputElement | HTMLTextAreaElement).value, element`],
  ["roleUtils.ts",
    "return compositeString(element.textContent, element, options.collectElements);\n      }\n      if (['combobox', 'listbox'].includes(role)) {",
    `return compositeString(${SECRET}element.textContent, element, options.collectElements);\n      }\n      if (['combobox', 'listbox'].includes(role)) {`],
  ["roleUtils.ts",
    "return compositeString((element as HTMLInputElement).value, element, options.collectElements);",
    `return compositeString(${SECRET}(element as HTMLInputElement).value, element, options.collectElements);`],
  ["roleUtils.ts",
    "return compositeString(element.getAttribute('value'), element, options.collectElements);",
    `return compositeString(${SECRET}element.getAttribute('value'), element, options.collectElements);`],
  // `validity` sits behind an `in` check, which hides from the checker that
  // it's a DOM member; the cast lets realmSafe route it.
  ["roleUtils.ts",
    "const validity = element.validity as ValidityState | undefined;",
    "const validity = (element as HTMLInputElement).validity as ValidityState | undefined;"],
  // The Range each document reuses is kept in a map of ours, not as an
  // expando on the page's document, which page script can see and replace.
  ["domUtils.ts",
    "const kTextNodeRange = Symbol('playwrightTextNodeRange');",
    "const textNodeRanges = new WeakMap<Document, Range>();"],
  ["domUtils.ts",
    "const document = node.ownerDocument as Document & { [kTextNodeRange]?: Range };\n  const range = (document[kTextNodeRange] ??= document.createRange());",
    "const document = node.ownerDocument;\n  let range = textNodeRanges.get(document);\n  if (!range)\n    textNodeRanges.set(document, range = document.createRange());"],
];

// Appended to roleUtils.ts, so it's exported (and the walker reaches it).
const SECRET_FIELD = `
// zenius: the fields whose value Chromium's page content leaves out once they
// hold anything (ai_page_content_agent.cc, kRedacted_*), so Ego never prints
// it, not even as bullets: a password field, one that was a password field
// before a show-password toggle (Gecko's chrome-only hasBeenTypePassword,
// which content/snapshot/sandbox.sys.mjs exposes as __zsPasswordInput while
// this script loads, then takes off the sandbox's global), and one masked
// with -webkit-text-security.
const passwordInput = (globalThis as any).__zsPasswordInput as ((element: Element) => boolean) | undefined;
export function isSecretField(element: Element): boolean {
  if (elementSafeTagName(element) === 'INPUT' && (element as HTMLInputElement).type === 'password')
    return true;
  if (typeof passwordInput === 'function' && passwordInput(element))
    return true;
  const security = getElementComputedStyle(element)?.getPropertyValue('-webkit-text-security');
  return !!security && security !== 'none';
}
`;

function patched(file, source) {
  for (const [target, from, to] of PATCHES) {
    if (target !== file) continue;
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`${file}: patch target found ${count} times:\n${from}`);
    source = source.replace(from, () => to);
  }
  return file === "roleUtils.ts" ? source + SECRET_FIELD : source;
}

// ---- realmSafe: every DOM access through content/snapshot/dom.js ----
// aria.js shares the page's principal, so a page that replaces a DOM member
// sees whatever we pass it, and from any object of ours it reaches the
// sandbox's global. The type checker finds each member access declared by
// lib.dom.d.ts, and the rewrite turns it into a dom.js accessor:
// `el.parentElement` -> `$g_parentElement(el)`, `el.getAttribute(n)` ->
// `$c_getAttribute(el, n)`. An accessor calls the sandbox's own copy for
// Node, Element, Document and Range members and sanitizes what any other
// member returns, by its declared type. Anything else that touches the DOM
// (a non-DOM member on a DOM value, a DOM global, an index into a DOM
// object, an argument that isn't a primitive or a node) stops the port.

const FILES = ["domUtils.ts", "roleUtils.ts"];
const DOM_LIB = /[\\/]lib\.dom(\.iterable)?\.d\.ts$/;
// The sandbox prototypes (dom.js owners) that hold each interface's members.
const OWNERS = {
  Node: ["Node"],
  Element: ["Element"], ARIAMixin: ["Element"], Slottable: ["Element"], InnerHTML: ["Element"],
  Animatable: ["Element"], ChildNode: ["Element"], NonDocumentTypeChildNode: ["Element"],
  ParentNode: ["Element", "Document"],
  Document: ["Document"], DocumentOrShadowRoot: ["Document"], NonElementParentNode: ["Document"],
  Range: ["Range"], AbstractRange: ["Range"],
};
// Members lib.dom redeclares on subtypes that Gecko keeps on Node.prototype.
const NODE_MEMBERS = new Set(["nodeType", "nodeName", "ownerDocument", "parentNode", "parentElement",
  "firstChild", "nextSibling", "textContent", "contains", "getRootNode"]);
const NODE_TYPES = /^(Node|ChildNode|ParentNode|Element|Document|DocumentFragment|ShadowRoot|Text|CharacterData|HTML\w*Element|SVG\w*Element)$/;
const COLLECTIONS = new Set(["NodeList", "NodeListOf", "HTMLCollection", "HTMLCollectionOf", "HTMLOptionsCollection"]);
// DOM objects kept as they are: each of their members goes through an accessor too.
const KEPT = new Set(["CSSStyleDeclaration", "DOMRect", "DOMRectReadOnly", "Window", "ValidityState", "Range"]);
// `x instanceof HTMLFooElement` names the page's HTMLFooElement; isHtml checks the node instead.
const INSTANCEOF = { HTMLFormElement: "form", HTMLLabelElement: "label" };
// The sandbox's own globals (wantGlobalProperties), which the page can't touch.
const OWN_GLOBALS = new Set(["Element", "Node", "Document", "NodeFilter", "Range", "CSS", "URL"]);
// The one any-typed read: the chrome helper isSecretField captures at load.
const ANY_ALLOWED = new Set(["(globalThis as any).__zsPasswordInput"]);

// Type stubs for imports outside packages/injected (the tokenizer is replaced anyway).
const STUBS = {
  "/zenius-stubs/cssTokenizer.ts": `export class CSSParserToken {}
    export class WhitespaceToken extends CSSParserToken {} export class CloseParenToken extends CSSParserToken {}
    export class DelimToken extends CSSParserToken { value: string } export class StringToken extends CSSParserToken { value: string }
    export class IdentToken extends CSSParserToken { value: string } export class FunctionToken extends CSSParserToken { value: string }
    export function tokenize(s: string): CSSParserToken[] { return []; }`,
  "/zenius-stubs/ariaSnapshot.ts": "export type AriaRole = string;",
};
const STUB_MODULES = { "@isomorphic/cssTokenizer": "/zenius-stubs/cssTokenizer.ts", "@isomorphic/ariaSnapshot": "/zenius-stubs/ariaSnapshot.ts" };
const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  removeComments: false,
  verbatimModuleSyntax: false,
  skipLibCheck: true,
  noEmitOnError: false,
};

function makeProgram() {
  const sources = new Map(FILES.map(file => [join(SRC, file), patched(file, readFileSync(join(SRC, file), "utf8"))]));
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile.bind(host);
  const text = name => sources.get(name) ?? STUBS[name];
  host.getSourceFile = (name, language) =>
    text(name) !== undefined ? ts.createSourceFile(name, text(name), language, true) : getSourceFile(name, language);
  host.fileExists = name => text(name) !== undefined || ts.sys.fileExists(name);
  host.readFile = name => text(name) ?? ts.sys.readFile(name);
  host.resolveModuleNames = (names, containing) =>
    names.map(name =>
      STUB_MODULES[name]
        ? { resolvedFileName: STUB_MODULES[name], extension: ts.Extension.Ts }
        : ts.resolveModuleName(name, containing, OPTIONS, host).resolvedModule
    );
  return ts.createProgram([...sources.keys()], OPTIONS, host);
}

const program = makeProgram();
const checker = program.getTypeChecker();
/** Accessor key -> {name, part, member, owners, kind}, in first-use order. */
const accessors = new Map();

const typeName = t => (t.aliasSymbol ?? t.symbol)?.name ?? "";
const nonNullish = t =>
  (t.isUnion() ? t.types : [t]).filter(p => !(p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
const isNodeType = t => (t.isIntersection() ? t.types.some(isNodeType) : NODE_TYPES.test(typeName(t)));
const isKept = t => (t.isIntersection() ? t.types.some(isKept) : KEPT.has(typeName(t)));
function isCollection(t) {
  const name = typeName(t);
  if (COLLECTIONS.has(name)) return true;
  return (name === "Array" || name === "ReadonlyArray") && checker.getTypeArguments(t).every(a => nonNullish(a).every(isNodeType));
}
// A DOM value: a node, a DOM collection or a kept DOM object. An array of
// nodes is ours (a spread copy, or what an accessor returns), not DOM.
const isDomTyped = t =>
  t.isUnion() || t.isIntersection() ? t.types.some(isDomTyped) : isNodeType(t) || COLLECTIONS.has(typeName(t)) || isKept(t);
const isPrimitive = t => nonNullish(t).every(p => p.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));

/** How dom.js sanitizes a value of this declared type. */
function kindOf(type, where) {
  const parts = nonNullish(type);
  if (!parts.length) return "raw";
  const every = test => parts.every(test);
  if (every(p => p.flags & ts.TypeFlags.StringLike)) return "str";
  if (every(p => p.flags & ts.TypeFlags.NumberLike)) return "num";
  if (every(p => p.flags & ts.TypeFlags.BooleanLike)) return "bool";
  if (every(isNodeType)) return "node";
  if (every(isCollection)) return "nodes";
  if (every(isKept)) return "raw";
  throw new Error(`${where}: no sanitizer for a DOM value of type ${checker.typeToString(type)}`);
}

/** The DOM member a property access names, with the owners that hold it, or null. */
function domMember(access) {
  const decls = (checker.getSymbolAtLocation(access.name)?.declarations ?? []).filter(d => DOM_LIB.test(d.getSourceFile().fileName));
  if (!decls.length) return null;
  const name = access.name.text;
  const owners = NODE_MEMBERS.has(name)
    ? ["Node"]
    : [...new Set(decls.flatMap(d => OWNERS[d.parent?.name?.text ?? ""] ?? []))];
  return { name, owners };
}

function accessorFor(part, member, kind) {
  const key = `${part}:${member.name}:${member.owners.join("+")}:${kind}`;
  let entry = accessors.get(key);
  if (!entry) {
    const base = `$${part === "getter" ? "g" : "c"}_${member.name}`;
    let name = base;
    for (let i = 2; [...accessors.values()].some(other => other.name === name); i++) name = `${base}_${i}`;
    entry = { name, part, member: member.name, owners: member.owners, kind };
    accessors.set(key, entry);
  }
  return entry.name;
}

/** The ts.transform step: see realmSafe above. */
function realmSafe(context) {
  const f = context.factory;
  const call = (fn, args) => f.createCallExpression(f.createIdentifier(fn), undefined, args);
  return sourceFile => {
    const where = node => `${sourceFile.fileName.split("/").pop()}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const fail = (node, why) => {
      throw new Error(`${where(node)}: ${why}: ${node.getText().slice(0, 100)}`);
    };
    // The `?.` must end its chain here: a longer optional chain can't be split.
    const checkChainEnd = (node, outer) => {
      const parent = outer.parent;
      if ((parent.flags & ts.NodeFlags.OptionalChain) && parent.expression === outer) fail(node, "optional chain continues past a DOM member");
    };
    const checkArguments = node => {
      for (const arg of node.arguments) {
        const type = checker.getTypeAtLocation(arg);
        if (!isPrimitive(type) && !nonNullish(type).every(isNodeType)) fail(arg, "a DOM call gets something that isn't a primitive or a node");
      }
    };
    const access = (node, isCall) => {
      if (ts.isIdentifier(node.expression) && OWN_GLOBALS.has(node.expression.text)) return null;
      const member = domMember(node);
      const receiverType = checker.getTypeAtLocation(node.expression);
      if (!member) {
        if (receiverType.flags & ts.TypeFlags.Any && !ANY_ALLOWED.has(node.getText())) fail(node, "member of an any-typed value");
        if (isDomTyped(receiverType)) fail(node, "non-DOM member on a DOM value");
        return null;
      }
      const outer = isCall ? node.parent : node;
      const parent = outer.parent;
      if ((ts.isBinaryExpression(parent) && parent.left === outer && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isDeleteExpression(parent) ||
        ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
          (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))) {
        fail(node, "writes a DOM member");
      }
      if (!isCall && ts.isMethodSignature(checker.getSymbolAtLocation(node.name).declarations[0])) fail(node, "DOM method used as a value");
      if ((node.flags & ts.NodeFlags.OptionalChain) && !node.questionDotToken && !(isCall && node.parent.questionDotToken)) {
        fail(node, "DOM member inside an optional chain");
      }
      return member;
    };
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
        const decl = checker.getSymbolAtLocation(node.right)?.declarations?.[0];
        if (decl && DOM_LIB.test(decl.getSourceFile().fileName)) {
          const tag = INSTANCEOF[node.right.getText()];
          if (!tag) fail(node, "instanceof a DOM interface realmSafe doesn't map");
          return call("$isHtml", [ts.visitNode(node.left, visit), f.createStringLiteral(tag)]);
        }
      }
      if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !ts.isTypeNode(node.parent)) {
        const decl = checker.getSymbolAtLocation(node)?.declarations?.[0];
        if (decl && DOM_LIB.test(decl.getSourceFile().fileName) && !OWN_GLOBALS.has(node.text) && !ts.isTypeReferenceNode(node.parent) &&
          !ts.isExpressionWithTypeArguments(node.parent) && !ts.isQualifiedName(node.parent)) {
          fail(node, "uses a DOM global, which page script can replace");
        }
      }
      if (ts.isElementAccessExpression(node) && isDomTyped(checker.getTypeAtLocation(node.expression)) &&
        !COLLECTIONS.has(typeName(checker.getTypeAtLocation(node.expression)))) {
        fail(node, "indexes a DOM object");
      }
      if ((ts.isForOfStatement(node) || ts.isSpreadElement(node)) && isDomTyped(checker.getTypeAtLocation(node.expression))) {
        // Iterating is fine once the collection is ours: only a sanitized DOM read may be iterated.
        let inner = node.expression;
        while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) ||
          (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
          inner = ts.isBinaryExpression(inner) ? inner.left : inner.expression;
        }
        const read = ts.isCallExpression(inner) ? inner.expression : inner;
        if (!ts.isPropertyAccessExpression(read) || !domMember(read)) fail(node, "iterates a DOM value that isn't a fresh DOM read");
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const member = access(node.expression, true);
        if (member) {
          checkArguments(node);
          const name = accessorFor("method", member, kindOf(checker.getTypeAtLocation(node), where(node)));
          const receiver = ts.visitNode(node.expression.expression, visit);
          const args = node.arguments.map(arg => ts.visitNode(arg, visit));
          if (node.expression.questionDotToken || node.questionDotToken) {
            checkChainEnd(node.expression, node);
            if (!node.arguments.every(arg => ts.isIdentifier(arg) || ts.isLiteralExpression(arg))) {
              fail(node, "an optional DOM call evaluates its arguments");
            }
            return call("$optCall", [receiver, f.createIdentifier(name), ...args]);
          }
          return call(name, [receiver, ...args]);
        }
      }
      if (ts.isPropertyAccessExpression(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        const member = access(node, false);
        if (member) {
          const name = accessorFor("getter", member, kindOf(checker.getTypeAtLocation(node), where(node)));
          const receiver = ts.visitNode(node.expression, visit);
          if (node.questionDotToken) {
            checkChainEnd(node, node);
            return call("$opt", [receiver, f.createIdentifier(name)]);
          }
          return call(name, [receiver]);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(sourceFile, visit);
  };
}

/** The accessors the rewrite used, as aria.js declares them before the modules. */
function accessorPrelude() {
  const lines = [...accessors.values()].map(
    a => `const ${a.name} = $dom.${a.part}(${JSON.stringify(a.member)}, ${JSON.stringify(a.owners)}, ${JSON.stringify(a.kind)});`
  );
  return `// ---- zenius: realm-safe DOM access (content/snapshot/dom.js) ----
// Every DOM access below goes through one of these, placed by the type
// checker (tests/snapshot/tools/port-playwright.mjs, realmSafe).
const $dom = globalThis.__zsDom;
const { opt: $opt, optCall: $optCall, isHtml: $isHtml } = $dom;
${lines.join("\n")}
`;
}

function port(file) {
  let js;
  const result = program.emit(
    program.getSourceFile(join(SRC, file)),
    (name, text) => {
      if (name.endsWith(".js")) js = text;
    },
    undefined,
    false,
    { before: [realmSafe] }
  );
  if (result.emitSkipped || js === undefined) throw new Error(`${file}: emit failed`);
  // Drop the license block (the combined header below keeps the notice).
  js = js.replace(/^\/\*\*[\s\S]*?Licensed under the Apache License[\s\S]*?\*\/\s*/, "");
  js = js.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*\n/gm, "");
  const names = [];
  js = js.replace(/^export (async function|function|const|let|class) ([A-Za-z0-9_$]+)/gm, (_, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(js)) {
    throw new Error(`${file}: unhandled import or export:\n${js.match(/^\s*(import|export)\b.*$/m)[0]}`);
  }
  exported.push(...names);
  // Each module keeps its private names in its own scope; its exports become
  // constants of the shared scope, where the next module imports them.
  return `// ---- ${file} ----\n\nconst { ${names.join(", ")} } = (() => {\n${js.trim()}\n\nreturn { ${names.join(", ")} };\n})();\n`;
}

const tokenizer = `// ---- zenius: stand-in for @isomorphic/cssTokenizer ----
// Tokenizes a computed \`content\` value just far enough for
// parseCSSContentPropertyAsString: strings, identifiers, functions, ")" and
// delimiters. Anything else becomes a DelimToken, and that parser then
// ignores the value, as it does for values it can't read.
const css = (() => {
  class CSSParserToken {}
  class WhitespaceToken extends CSSParserToken {}
  class CloseParenToken extends CSSParserToken {}
  class ValueToken extends CSSParserToken {
    constructor(value) {
      super();
      this.value = value;
    }
  }
  class DelimToken extends ValueToken {}
  class StringToken extends ValueToken {}
  class IdentToken extends ValueToken {}
  class FunctionToken extends ValueToken {}
  const isSpace = c => c === " " || c === "\\t" || c === "\\n" || c === "\\r" || c === "\\f";
  const isHex = c => /^[0-9A-Fa-f]$/.test(c);
  const isNameStart = c => /^[A-Za-z_\\u0080-\\uffff]$/.test(c);
  const isName = c => /^[A-Za-z0-9_\\-\\u0080-\\uffff]$/.test(c);
  function tokenize(input) {
    const tokens = [];
    const n = input.length;
    let i = 0;
    const validEscape = at => input[at] === "\\\\" && at + 1 < n && input[at + 1] !== "\\n";
    const escape = () => {
      i++;
      if (isHex(input[i])) {
        let hex = "";
        while (i < n && hex.length < 6 && isHex(input[i])) hex += input[i++];
        if (isSpace(input[i])) i++;
        const cp = parseInt(hex, 16);
        return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\\ufffd" : String.fromCodePoint(cp);
      }
      return input[i++];
    };
    while (i < n) {
      const c = input[i];
      if (isSpace(c)) {
        while (i < n && isSpace(input[i])) i++;
        tokens.push(new WhitespaceToken());
      } else if (c === '"' || c === "'") {
        let value = "";
        i++;
        while (i < n && input[i] !== c) {
          if (input[i] === "\\n") throw new Error("Unterminated string");
          if (input[i] !== "\\\\") value += input[i++];
          else if (input[i + 1] === "\\n") i += 2;
          else if (i + 1 < n) value += escape();
          else i++;
        }
        i++;
        tokens.push(new StringToken(value));
      } else if (isNameStart(c) || validEscape(i) || (c === "-" && (isNameStart(input[i + 1]) || input[i + 1] === "-" || validEscape(i + 1)))) {
        let name = "";
        while (i < n) {
          if (isName(input[i])) name += input[i++];
          else if (validEscape(i)) name += escape();
          else break;
        }
        if (input[i] === "(") {
          i++;
          tokens.push(new FunctionToken(name));
        } else {
          tokens.push(new IdentToken(name));
        }
      } else if (c === ")") {
        i++;
        tokens.push(new CloseParenToken());
      } else {
        i++;
        tokens.push(new DelimToken(c));
      }
    }
    return tokens;
  }
  return { tokenize, WhitespaceToken, CloseParenToken, DelimToken, StringToken, IdentToken, FunctionToken };
})();
`;

// Ported first: the rewrite collects the accessors the prelude declares.
const ported = FILES.map(port);
const body = [tokenizer, accessorPrelude(), ...ported].join("\n");
const header = `/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Portions adapted from microsoft/playwright (Apache License 2.0):
// packages/injected/src/domUtils.ts and roleUtils.ts at ${commit}.
// GENERATED by tests/snapshot/tools/port-playwright.mjs: types stripped,
// the CSS tokenizer replaced, both modules wrapped into one sandbox script,
// every DOM access routed through content/snapshot/dom.js (page script
// never sees an object of ours), and secret fields' values kept out of
// names (isSecretField, zenius's). Don't edit by hand; change the tool and
// rerun it.
//
// zenius runs this in a per-document sandbox (content/snapshot/sandbox.sys.mjs)
// and calls it through content/snapshot/aria.sys.mjs.
`;
const out = `${header}
"use strict";
(function () {
${body}
Object.defineProperty(globalThis, "__zsAria", {
  value: Object.freeze({ ${exported.join(", ")} }),
});
})();
`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${out.split("\n").length} lines, ${exported.length} exports, playwright ${commit.slice(0, 12)}`);
