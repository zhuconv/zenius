// Text that zenius builds from strings it doesn't control: task, Space and
// client names, the agent's state text and action labels, page titles,
// hosts.

/** Embeddings, overrides and isolates: a name could escape its isolate. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Wrap a name in a first-strong isolate, as Fluent does for every
 * placeable. A right-to-left name keeps its own order (the "!" of
 * "הזמנת שולחן 4!" stays at its left end), and can't pull zenius's words
 * around it ("· closes when you leave this tab") into its run.
 *
 * Its own bidi controls go first, so an unmatched PDI can't end the isolate
 * early and an override can't run on past it. Control characters become a
 * space, so a name can't add lines to a tooltip.
 *
 * Isolate each raw part, then join the parts: an isolate around zenius's
 * own words would take its direction from the first name inside.
 *
 * @param {unknown} text
 * @returns {string} "" for an empty name
 */
export function isolate(text) {
  const clean = String(text ?? "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\p{Cc}+/gu, " ");
  return clean ? `\u2068${clean}\u2069` : "";
}

const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);

/**
 * Whether `text` is one isolate() result and nothing else: a line holding a
 * single name or text, which can take its own direction (dir="auto") so a
 * clipped right-to-left one keeps its start. A line that also holds
 * zenius's words must stay left to right, or the words would swap sides
 * with the name.
 *
 * @param {string} text
 */
export function isOneIsolate(text) {
  return text.length > 2 && text.startsWith(FSI) && text.endsWith(PDI) && !text.slice(1, -1).includes(FSI);
}
