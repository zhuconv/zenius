// The evidence flag, parent side (zen-observe).
//
// The defenses (the typing hold, the clean-copy reloads, the hold's COOP and
// muting, the task-end reload, the permission prompts' denial) act only on
// evidence of phishing or danger. Each document (innerWindowId) may have
// reasons, each with a one-line detail:
// - hooked: the agent's code left something that outlives the discard of its
//   world (content/agentworld.sys.mjs, and zen-input's paste);
// - made: a data: or blob: top document the agent opened (noteMade);
// - listed: Gecko's phishing or malware lists name it (zen-core);
// - flagged: the agent flagged it (zen-core's tool).
// The flags are per document, so a reload or a new load starts clean, and
// they're only ever added. Content reads them from sharedData
// (content/evidence.sys.mjs) and tells this module of hooked documents by the
// "zenius:evident" message, which observe/agentworld.sys.mjs listens for
// while tasks need it.

import { EVIDENCE_DOCS_KEY, EVIDENCE_REASONS, evidenceDetail } from "chrome://userscripts/content/zenius/content/worldkeys.sys.mjs";

export { EVIDENCE_DOCS_KEY, EVIDENCE_REASONS };

/** Documents with evidence (innerWindowId) → {browserId, reasons: {reason: detail}}. */
const docs = new Map();
const listeners = new Set();

/** The document (innerWindowId) now in `target`, and its tab's top BrowsingContext. */
function documentOf(target) {
  try {
    if (!target) {
      return null;
    }
    if (WindowGlobalParent.isInstance(target)) {
      return { id: target.innerWindowId, top: target.browsingContext.top };
    }
    const bc = BrowsingContext.isInstance(target) ? target : target.browsingContext?.top;
    const id = bc?.currentWindowGlobal?.innerWindowId;
    return id ? { id, top: bc.top } : null;
  } catch {
    return null;
  }
}

function topOf(target) {
  try {
    const bc = target?.browsingContext ?? target;
    return bc?.top ?? null;
  } catch {
    return null;
  }
}

function publish() {
  for (const [id, entry] of docs) {
    if (!BrowsingContext.getCurrentTopByBrowserId(entry.browserId)) {
      docs.delete(id);
    }
  }
  Services.ppmm.sharedData.set(EVIDENCE_DOCS_KEY, new Map([...docs].map(([id, entry]) => [id, { ...entry.reasons }])));
  Services.ppmm.sharedData.flush();
}

/**
 * Mark the document now in `target` with a reason. The first detail for each
 * reason stays.
 *
 * @param {BrowsingContext|WindowGlobalParent|Element} target  a
 *   BrowsingContext (its current document), a WindowGlobalParent (that
 *   document) or a <browser> (its top document)
 * @param {"hooked"|"made"|"listed"|"flagged"} reason
 * @param {string} [detail]  why, in a line: what the agent left, the list's
 *   name, the agent's own reason
 * @returns {boolean} whether the document gained the reason
 */
export function markEvident(target, reason, detail = "") {
  if (!EVIDENCE_REASONS.includes(reason)) {
    throw new TypeError(`markEvident: unknown reason ${JSON.stringify(reason)}`);
  }
  const doc = documentOf(target);
  if (!doc?.id || !doc.top?.browserId) {
    return false;
  }
  let entry = docs.get(doc.id);
  if (entry && reason in entry.reasons) {
    return false;
  }
  if (!entry) {
    docs.set(doc.id, (entry = { browserId: doc.top.browserId, reasons: {} }));
  }
  const text = evidenceDetail(detail);
  entry.reasons[reason] = text;
  publish();
  const event = { browser: doc.top.embedderElement ?? null, innerWindowId: doc.id, reason, detail: text };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (e) {
      console.error("[zenius] an evidence listener failed", e);
    }
  }
  return true;
}

/**
 * The page's evidence: each reason any of its current documents (the top
 * one, then its frames) has, with the first detail found.
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target  the page's
 *   <browser>, or any document or BrowsingContext in its tree
 * @returns {Record<string, string>} reason → detail; empty without evidence
 */
export function evidenceOf(target) {
  const out = {};
  const top = topOf(target);
  if (!top || !docs.size) {
    return out;
  }
  try {
    for (const bc of top.getAllBrowsingContextsInSubtree()) {
      const reasons = docs.get(bc.currentWindowGlobal?.innerWindowId)?.reasons;
      for (const reason of EVIDENCE_REASONS) {
        if (reasons && reason in reasons && !(reason in out)) {
          out[reason] = reasons[reason];
        }
      }
    }
  } catch {}
  return out;
}

/**
 * Has the page (its top document or a frame's) any evidence?
 *
 * @param {Element|WindowGlobalParent|BrowsingContext} target
 */
export function isEvident(target) {
  const top = topOf(target);
  if (!top || !docs.size) {
    return false;
  }
  try {
    return top.getAllBrowsingContextsInSubtree().some(bc => docs.has(bc.currentWindowGlobal?.innerWindowId));
  } catch {
    return false;
  }
}

/**
 * `fn({browser, innerWindowId, reason, detail})` once for each document and
 * reason, when the document gains it.
 *
 * @returns {() => void} unsubscribe
 */
export function onEvident(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Content's hooked marks ({marks: [[innerWindowId, detail]]}): the sending
 * process's own documents only, and only as hooked, since the other reasons
 * are the parent's to give. A parent message manager's target has no childID
 * in Gecko 160, only osPid; without one, the message counts for nothing.
 */
export function onEvidentMessage(msg) {
  const pid = msg.target?.osPid;
  const marks = msg.data?.marks;
  if (typeof pid !== "number" || !Array.isArray(marks)) {
    return;
  }
  for (const mark of marks.slice(0, 256)) {
    const [id, detail] = Array.isArray(mark) ? mark : [];
    if (!Number.isSafeInteger(id) || id <= 0) {
      continue;
    }
    let wgp = null;
    try {
      wgp = WindowGlobalParent.getByInnerWindowId(id);
    } catch {}
    if (wgp && wgp.domProcess?.osPid === pid) {
      markEvident(wgp, "hooked", typeof detail === "string" ? detail : "");
    }
  }
}
