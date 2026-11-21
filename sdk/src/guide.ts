// Portions adapted from citrolabs/ego-lite (MIT License).
//
// `zenius skill`: print the usage guide that matches this SDK build.
//
// The source is skill/guide.md; the build copies it next to the bundle, so an
// installed CLI prints the guide it shipped with. Passages between marker
// lines reach only the guides for the platforms they name:
//
//   <!-- platform: macos -->
//   ...Markdown only the macOS guide keeps...
//   <!-- /platform -->
//
// The guide for any other platform keeps every block. Marker lines never reach
// the output, and soft-wrapped prose is joined into one line per paragraph,
// which renders the same in fewer lines.

import { fs, url } from "./node.ts";

export const GUIDE_TAG = "[zenius:skill]";
export const GUIDE_PLATFORMS = ["macos", "linux"] as const;
export type GuidePlatform = (typeof GUIDE_PLATFORMS)[number];
/** Claude Code keeps 30,000 characters of command output; leave headroom. */
export const MAX_GUIDE_LENGTH = 25_000;

const PLATFORM_OPEN = /^\s*<!--\s*platform:\s*([a-z, ]+?)\s*-->\s*$/;
const PLATFORM_CLOSE = /^\s*<!--\s*\/platform\s*-->\s*$/;

export function guideCandidates(): string[] {
  return [
    url.fileURLToPath(new URL("./guide.md", import.meta.url)),
    url.fileURLToPath(new URL("../../skill/guide.md", import.meta.url)),
  ];
}

export function platformName(platform: NodeJS.Platform = process.platform): GuidePlatform | null {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return null;
}

/** The guide for `platform`, or for every platform when it is null. */
export function renderGuide(source: string, platform: GuidePlatform | null = null, name = "guide"): string {
  if (platform !== null && !GUIDE_PLATFORMS.includes(platform)) {
    throw new Error(`unknown guide platform ${JSON.stringify(platform)}`);
  }
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  const version = match ? /^version: "([^"]+)"$/m.exec(match[1]!)?.[1] : undefined;
  if (!match || !version) throw new Error(`${name} needs frontmatter with a version`);
  const label = platform ? `v${version} (${platform})` : `v${version}`;
  return [
    `${GUIDE_TAG} zenius usage guide ${label}`,
    "",
    unwrapProse(selectPlatform(match[2]!, platform, name).trim()),
    "",
    `${GUIDE_TAG} end of guide v${version}`,
    "",
  ].join("\n");
}

/** Drop the platform blocks that do not apply, and every marker line. */
export function selectPlatform(markdown: string, platform: GuidePlatform | null, name = "guide"): string {
  const lines: string[] = [];
  let keep: boolean | null = null; // null outside a block
  let openedAt = 0;
  markdown.split("\n").forEach((line, index) => {
    const open = PLATFORM_OPEN.exec(line);
    if (open) {
      if (keep !== null) throw new Error(`${name}:${index + 1}: platform blocks do not nest (opened at line ${openedAt})`);
      const platforms = open[1]!.split(",").map((entry) => entry.trim());
      for (const entry of platforms) {
        if (!(GUIDE_PLATFORMS as readonly string[]).includes(entry)) {
          throw new Error(`${name}:${index + 1}: unknown platform ${JSON.stringify(entry)}; use ${GUIDE_PLATFORMS.join(", ")}`);
        }
      }
      keep = platform === null || platforms.includes(platform);
      openedAt = index + 1;
      return;
    }
    if (PLATFORM_CLOSE.test(line)) {
      if (keep === null) throw new Error(`${name}:${index + 1}: platform block closed twice`);
      keep = null;
      return;
    }
    if (keep !== false) lines.push(line);
  });
  if (keep !== null) throw new Error(`${name}:${openedAt}: platform block is never closed`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Join soft-wrapped Markdown lines with a space. Code fences, headings, list
 * items, tables and blockquotes still start new lines.
 */
export function unwrapProse(markdown: string): string {
  const startsBlock = /^\s*(```|#|[-*+] |\d+\. |\||>)/;
  const lines: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const fence = /^\s*```/.test(line);
    const previous = lines.at(-1);
    if (!inFence && !fence && line.trim() && previous?.trim() && !startsBlock.test(line) && !/^\s*(```|#|\|)/.test(previous)) {
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
    } else {
      lines.push(line);
    }
    if (fence) inFence = !inFence;
  }
  return lines.join("\n");
}

export function readGuide(): { text?: string; checked: string[] } {
  const checked = guideCandidates();
  for (const path of checked) {
    let source: string;
    try {
      source = fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }
    return { text: renderGuide(source, platformName(), path), checked };
  }
  return { checked };
}
