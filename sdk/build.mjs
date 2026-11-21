// Bundle the CLI and SDK into one ESM file and copy the usage guide next to
// it, so an installed build always prints the guide it shipped with.
//
// This runs on any Node the CLI supports (22.3 and later), so it imports no
// TypeScript: Node strips types only from 22.18 and 23.6 on, and the Mac's
// default Node is 23.5. esbuild compiles what it needs from src/.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
// ZENIUS_BUILD_DIST builds into a new folder elsewhere, for a suite that runs
// its own copy while others rebuild dist/ (tests/security). It must not exist
// yet, so a wrong value can't delete anything.
const custom = process.env.ZENIUS_BUILD_DIST;
const dist = custom || join(root, "dist");
const forNode = { bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "warning" };
if (custom) {
  mkdirSync(dist);
} else {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
}

await build({
  ...forNode,
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(dist, "zenius.mjs"),
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: "none",
  banner: { js: "// zenius SDK bundle. Portions adapted from citrolabs/ego-lite (MIT License)." },
});

// Fail the build, not an agent's `zenius skill`, when the guide is malformed or
// too long for agents to read in one command output.
const { GUIDE_PLATFORMS, MAX_GUIDE_LENGTH, renderGuide } = await importTypeScript(join(root, "src/guide.ts"));
const guideSource = join(root, "../skill/guide.md");
for (const platform of [null, ...GUIDE_PLATFORMS]) {
  const length = renderGuide(readFileSync(guideSource, "utf8"), platform, guideSource).length;
  if (length > MAX_GUIDE_LENGTH) {
    throw new Error(`the ${platform ?? "all-platform"} guide is ${length} characters; keep it under ${MAX_GUIDE_LENGTH}`);
  }
}
copyFileSync(guideSource, join(dist, "guide.md"));
const size = statSync(join(dist, "zenius.mjs")).size;
const shown = custom ? dist : "dist";
console.log(`built ${shown}/zenius.mjs (${(size / 1024).toFixed(1)} KiB) and ${shown}/guide.md`);

/** A TypeScript module, compiled by esbuild into a scratch file and imported from there. */
async function importTypeScript(file) {
  const scratch = mkdtempSync(join(tmpdir(), "zenius-build-"));
  try {
    const outfile = join(scratch, "module.mjs");
    await build({ ...forNode, entryPoints: [file], outfile });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
