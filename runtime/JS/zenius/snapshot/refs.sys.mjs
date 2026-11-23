// The parent half of the ref registry (docs/SPI.md, "Refs and locators"):
// one table per tab, keyed by the browser's browserId. The id moves with the
// page's docShell, so the table
// follows the page across process switches and across Zen's window copies
// of its tab, which each keep their own permanentKey (SPI.md, "Windows: a
// page is its sync id").
// A ref names (browsing context, inner window, local id); the node itself is
// held in its document's sandbox.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

const MAX_STALE_REFS = 10_000;

/** @type {Map<number, {nextRef: number, byRef: Map<number, object>, byKey: Map<string, number>}>} */
const tables = new Map();
/** Tables past this many get the closed tabs' dropped. */
let pruneAt = 64;

function tableFor(browser, create) {
  const id = browser.browserId;
  if (!id) {
    return null;
  }
  let table = tables.get(id);
  if (!table && create) {
    if (tables.size >= pruneAt) {
      // An id outlives no browsing context of its own: the tab has closed.
      for (const known of tables.keys()) {
        if (!BrowsingContext.getCurrentTopByBrowserId(known)) tables.delete(known);
      }
      pruneAt = Math.max(64, tables.size * 2);
    }
    table = { nextRef: 1, byRef: new Map(), byKey: new Map() };
    tables.set(id, table);
  }
  return table ?? null;
}

/** False once the ref's document is gone: navigation, reload, replaced frame. */
/**
 * Whether a ref's document is still what its frame shows, in the page the tab
 * shows now. A navigation can swap the tab's top browsing context and keep
 * the old one, document and frames included, alive in the bfcache.
 */
function alive(browser, entry) {
  const bc = BrowsingContext.get(entry.bcId);
  return (
    !!bc &&
    !bc.isDiscarded &&
    !bc.isInBFCache &&
    bc.top === browser.browsingContext &&
    bc.currentWindowGlobal?.innerWindowId === entry.innerWindowId
  );
}

function evict(table) {
  let stale = 0;
  for (const entry of table.byRef.values()) {
    if (!entry.active) stale++;
  }
  // Maps iterate in insertion order, so the oldest refs go first.
  for (const entry of table.byRef.values()) {
    if (stale <= MAX_STALE_REFS) break;
    if (!entry.active) {
      table.byRef.delete(entry.refId);
      table.byKey.delete(entry.key);
      stale--;
    }
  }
}

export const Refs = {
  /** "@21", "ref=21" or "21" → 21, as Ego's parseRef; anything else → null. */
  parse(target) {
    const match = /^\s*(?:@|ref=)?(\d+)\s*$/.exec(String(target ?? ""));
    return match ? Number(match[1]) : null;
  },

  /**
   * Numbers the refs one snapshot printed, in print order. A node printed
   * before keeps its number and becomes active again.
   *
   * @param {Array<{bcId, innerWindowId, localId, role, name}>} printed
   * @param {{replace: boolean}} options replace (full_page): refs not
   *   printed turn stale; otherwise they stay as they are
   * @returns {number[]}
   */
  register(browser, printed, { replace }) {
    const table = tableFor(browser, true);
    for (const entry of table.byRef.values()) {
      if (entry.active && (replace || !alive(browser, entry))) entry.active = false;
    }
    const numbers = [];
    for (const ref of printed) {
      const key = `${ref.innerWindowId}:${ref.localId}`;
      let entry = table.byRef.get(table.byKey.get(key));
      if (entry) {
        Object.assign(entry, ref, { active: true });
      } else {
        entry = { ...ref, refId: table.nextRef++, key, active: true };
        table.byRef.set(entry.refId, entry);
        table.byKey.set(key, entry.refId);
      }
      numbers.push(entry.refId);
    }
    evict(table);
    return numbers;
  },

  /** The numbers register() would give these refs, without registering them. */
  preview(browser, printed) {
    const table = tableFor(browser, false);
    let next = table?.nextRef ?? 1;
    const fresh = new Map();
    return printed.map(ref => {
      const key = `${ref.innerWindowId}:${ref.localId}`;
      const known = table?.byKey.get(key);
      if (known !== undefined && table.byRef.has(known)) {
        return known;
      }
      if (!fresh.has(key)) fresh.set(key, next++);
      return fresh.get(key);
    });
  },

  /**
   * @returns {{refId, browsingContext, innerWindowId, localId, role, name}}
   * @throws {ZenError} ZEN_REF_NOT_FOUND, ZEN_REF_STALE
   */
  resolve(browser, refId) {
    const entry = tableFor(browser, false)?.byRef.get(refId);
    if (!entry) {
      throw new ZenError("ZEN_REF_NOT_FOUND", `Unknown ref: ${refId}; take a new snapshot`, { ref: refId });
    }
    if (entry.active && !alive(browser, entry)) {
      entry.active = false;
    }
    if (!entry.active) {
      throw new ZenError("ZEN_REF_STALE", `Stale ref: @${refId}; take a new snapshot`, { ref: refId });
    }
    return {
      refId,
      browsingContext: BrowsingContext.get(entry.bcId),
      innerWindowId: entry.innerWindowId,
      localId: entry.localId,
      role: entry.role,
      name: entry.name,
    };
  },

  /** After content reported the node gone. */
  markStale(browser, refId) {
    const entry = tableFor(browser, false)?.byRef.get(refId);
    if (entry) entry.active = false;
  },
};
