// No tracked code holds a hidden character raw. Editors and diff viewers
// reorder a line around a bidi control ("Trojan Source", CVE-2021-42574), and
// show zero-width and other format characters, look-alike spaces, private-use
// glyphs and stray controls as nothing or as a plain space. So a reviewer
// can't see what the code says, or what a text a model reads (skill/) tells
// it. JavaScript also ends a line at U+2028 and U+2029, so a // comment can
// hide code after one. Write each as an escape of its code point instead.
//
// Every file git tracks under ROOTS counts, except binary ones (git's own
// test: a NUL byte in the first 8000 bytes). Only the FIXTURES listed may
// hold such characters raw. This replaces the core's guard of its own paths
// and keeps its classes. It needs no browser, and builds the extra
// characters from their code points, since an escape typed into a tool call
// can arrive decoded.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["runtime", "sdk", "skill", "scripts", "tests"];
// Paths that may hold hidden characters raw. "dir/*.ext" covers the files
// right in dir that end in .ext. A vendored file (runtime/vendor/) that
// needs one is listed here too, and never edited.
const FIXTURES = [
  // Page text that Ego captured from real sites: no-break and hair spaces,
  // icon fonts' private-use glyphs, word joiners. The snapshot tests match it
  // byte for byte.
  "tests/golden/ego/*.txt",
];
// Blank-looking letters JavaScript accepts in names (the Hangul fillers), and
// the combining grapheme joiner. Unicode files them as a letter and a mark.
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x034f].map(cp => String.fromCodePoint(cp)).join("");
// Format characters (bidi controls and marks, zero-width ones, the soft
// hyphen, tags), line and paragraph separators, private use, controls other
// than tab, LF and CR, spaces other than U+0020, and BLANK.
const HIDDEN = new RegExp(String.raw`[\p{Cf}\p{Zl}\p{Zp}\p{Co}]|[^\P{Cc}\t\n\r]|[^\P{Zs} ]|[${BLANK}]`, "gu");

/** "<line>: U+XXXX, …" for each line of `text` that holds one. */
function hiddenIn(text) {
  const out = [];
  let line = 1;
  let at = 0;
  let last = 0;
  for (const m of text.matchAll(HIDDEN)) {
    for (; at < m.index; at++) {
      if (text.charCodeAt(at) === 10) {
        line++;
      }
    }
    const code = `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    if (line === last) {
      out[out.length - 1] += `, ${code}`;
    } else {
      out.push(`${line}: ${code}`);
      last = line;
    }
  }
  return out;
}

const isFixture = (f, pattern = null) =>
  (pattern ? [pattern] : FIXTURES).some(p => {
    const star = p.indexOf("*");
    if (star < 0) {
      return f === p;
    }
    const dir = p.slice(0, star);
    return f.startsWith(dir) && f.endsWith(p.slice(star + 1)) && !f.slice(dir.length).includes("/");
  });

function trackedTextFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(f => f && existsSync(join(ROOT, f)))
    .map(f => ({ f, data: readFileSync(join(ROOT, f)) }))
    .filter(({ data }) => !data.subarray(0, 8000).includes(0))
    .map(({ f, data }) => ({ f, text: data.toString("utf8") }));
}

test("no tracked code holds a hidden character raw, except the listed fixtures", () => {
  const files = trackedTextFiles();
  assert.ok(files.length > 300, `the premise: git lists the repo's text files (${files.length})`);
  const found = [];
  for (const { f, text } of files) {
    if (!isFixture(f)) {
      for (const where of hiddenIn(text)) {
        found.push(`${f}:${where}`);
      }
    }
  }
  assert.deepEqual(
    found,
    [],
    "write each as an escape of its code point; a fixture that must hold it raw goes in FIXTURES (tests/ux/source.test.mjs)"
  );
});

test("each FIXTURES entry still covers a tracked file that needs it", () => {
  const files = trackedTextFiles();
  const stale = FIXTURES.filter(p => !files.some(({ f, text }) => isFixture(f, p) && hiddenIn(text).length));
  assert.deepEqual(stale, [], "drop these from FIXTURES in tests/ux/source.test.mjs");
});

test("the scan finds each class, by line, and passes tab, CR and plain spaces", () => {
  const ch = cp => String.fromCodePoint(cp);
  const sample = [
    "plain\ttext with spaces\r",
    `a${ch(0x202e)}b`,
    `x${ch(0x200b)}y${ch(0x2069)}`,
    `// c${ch(0x2028)}d`,
    `t${ch(0xe0041)} ${ch(0xe000)}`,
    `${ch(0x1b)}[0m ${ch(0xa0)}`,
    `const ${ch(0x3164)} = 1;`,
    "ok",
  ].join("\n");
  assert.deepEqual(hiddenIn(sample), [
    "2: U+202E",
    "3: U+200B, U+2069",
    "4: U+2028",
    "5: U+E0041, U+E000",
    "6: U+001B, U+00A0",
    "7: U+3164",
  ]);
});
