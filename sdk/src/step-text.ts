// Text the user reads in a step or a result line (zenius mcp): one line,
// without invisible characters, cut where the user would see it cut.

// Steps are lines the user reads, built from what the agent sends and what
// pages say, so nothing in them may read as something else.

/** Characters that change how a line reads without showing: bidi controls, zero-width and other format characters, controls. */
export const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Text on one line, without invisible characters: an RLO copied from a page would reverse what follows it. */
export function clean(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** At most `max` characters, counted as the user sees them (code points), with … where it's cut. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function quoted(text: unknown, max = 60): string {
  return `"${cut(clean(text), max)}"`;
}

/**
 * A file's name as a result line shows it: as a page's element name is in a
 * step (docs/SPI.md, "Each task's steps"), on one line, cleaned, capped at
 * 60 and quoted, its own quote marks made apostrophes. A download's name is
 * the site's, so it may hold anything.
 */
export function quotedName(name: string, max = 60): string {
  return `"${cut(clean(name).replace(/"/g, "'"), max)}"`;
}
