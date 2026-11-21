#!/usr/bin/env node
// Regenerates sdk/test/fixtures/ego-error-codes.ts, the list of Ego Lite's
// error codes that errors.test.ts checks error-guide.ts against, from a local
// copy of Ego Lite in refs/ego-lite. refs/ is gitignored and missing from most
// checkouts, so the tests read only the generated file, never refs/.
//
//   node sdk/scripts/update-ego-codes.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EGO = join(ROOT, "refs", "ego-lite");
const SRC = join(EGO, "package", "ego-browser", "src");
const BINDINGS = join(EGO, "docs", "native-bindings-api.md");
const OUT = join(ROOT, "sdk", "test", "fixtures", "ego-error-codes.ts");

if (!existsSync(SRC) || !existsSync(BINDINGS)) {
  console.error(`update-ego-codes: no Ego Lite at ${EGO}, so nothing to regenerate from; ${OUT} stays as it is.`);
  process.exit(1);
}

/** Every .ts file under dir. */
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}

// The codes Ego's SDK names, and the native bindings' list in its docs (one code per line).
const codes = new Set();
for (const path of files(SRC)) {
  for (const match of readFileSync(path, "utf8").matchAll(/"(EGO_[A-Z_]+)"/g)) codes.add(match[1]);
}
for (const match of readFileSync(BINDINGS, "utf8").matchAll(/^(EGO_[A-Z_]+)$/gm)) codes.add(match[1]);

let version = "";
try {
  version = JSON.parse(readFileSync(join(EGO, "package", "ego-browser", "package.json"), "utf8")).version ?? "";
} catch {
  // An Ego Lite without the package's manifest: the list still stands.
}

const lines = [
  "// Portions adapted from citrolabs/ego-lite (MIT License).",
  "//",
  `// Ego Lite's error codes${version ? ` (ego-browser ${version})` : ""}: those its SDK names, in`,
  "// package/ego-browser/src, and the native bindings' list in",
  "// docs/native-bindings-api.md. errors.test.ts checks error-guide.ts's ego",
  "// fields against it. Generated from refs/ego-lite by",
  "// sdk/scripts/update-ego-codes.mjs; don't edit by hand.",
  "",
  "export const EGO_ERROR_CODES: readonly string[] = [",
  ...[...codes].sort().map((code) => `  "${code}",`),
  "];",
  "",
];
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(`update-ego-codes: wrote ${codes.size} codes to ${OUT}`);
