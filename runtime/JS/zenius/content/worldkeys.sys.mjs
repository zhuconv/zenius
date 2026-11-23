// The names the agent's world shares between the content and parent
// processes (zen-observe). They have a module of their own, so the parent
// needn't evaluate content/agentworld.sys.mjs (its setup source and tables)
// to read them.

/** sharedData: the documents (innerWindowId) the agent's world wrote into. */
export const WRITTEN_DOCS_KEY = "zenius:writtenDocs";
/** sharedData: the top documents (innerWindowId) the agent made, from data: or blob:. */
export const MADE_DOCS_KEY = "zenius:madeDocs";

/** The file name of the agent's code in its world: its frames are known on any stack by it. */
export const WORLD_URL = "zenius://agent-world";

/**
 * sharedData: the documents with evidence of phishing or danger, which the
 * defenses read: a Map of innerWindowId → {reason: detail}.
 * observe/evidence.sys.mjs publishes it, content/evidence.sys.mjs reads it.
 */
export const EVIDENCE_DOCS_KEY = "zenius:evidenceDocs";

/**
 * Why a document has evidence:
 * - hooked: the agent's code left something there that outlives the discard
 *   of its world: code in the page's own realm, or a change that redirects
 *   what the user types next;
 * - made: a data: or blob: top document the agent opened;
 * - listed: Gecko's phishing or malware lists name it (zen-core);
 * - flagged: the agent flagged it (zen-core's tool).
 */
export const EVIDENCE_REASONS = Object.freeze(["hooked", "made", "listed", "flagged"]);

/** A reason's detail as it's kept: one line of at most 200 characters. */
export function evidenceDetail(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
