// The private clipboard of each agent Space (zen-ux). Agent copy, cut and
// paste never touch the system clipboard, which is the user's. zen-input's
// chords (methods/actions.sys.mjs) and the page guards of the
// ZeniusClipboard actor read and write this store instead, so a page's own
// "Copy" button and the agent's Ctrl/Cmd+V meet here.
//
// Parent process only, in memory only. A Space's entry goes when its task
// finishes or the Space is deleted (clipboard/index.sys.mjs).
//
// Each write keeps the origin of the document that wrote it. A page reads
// the Space's clipboard only from that origin (readFor): without it, what
// the agent copied on one site, any other site in the task would read on
// the agent's next click, with no paste prompt (zen-snapshot's audit,
// docs/research/content-boundary.md). The agent's own paste (read) is the
// agent's choice, like a user's paste, and isn't limited.

/**
 * MIME type → data, most preferred first (zen-input's toClipData and
 * fromClipData convert to and from {text, html}). Text types are strings,
 * others (images) Uint8Array.
 *
 * @typedef {Object<string, string|Uint8Array>} ClipData
 */

/** @type {Map<number, {data: ClipData, origin: string|null}>} spaceId → its clipboard */
const clips = new Map();

export const SpaceClipboard = {
  /**
   * The contents, for the agent's own paste.
   *
   * @param {number} spaceId
   * @returns {ClipData|null} a copy; null while the Space hasn't copied anything
   */
  read(spaceId) {
    const entry = clips.get(spaceId);
    return entry ? copy(entry.data) : null;
  },

  /**
   * The contents for a page: only for the origin that wrote them. An empty
   * clipboard is no one's, and reads as empty.
   *
   * @param {number} spaceId
   * @param {string|null} origin  the reading document's
   * @returns {{data: ClipData|null}|null} null when another origin wrote them
   */
  readFor(spaceId, origin) {
    const entry = clips.get(spaceId);
    if (!entry) {
      return { data: null };
    }
    return entry.origin !== null && entry.origin === origin ? { data: copy(entry.data) } : null;
  },

  /**
   * @param {number} spaceId
   * @param {ClipData|null} data  null empties the Space's clipboard
   * @param {string|null} [origin]  the writing document's; null when unknown,
   *   which no page can read
   */
  write(spaceId, data, origin = null) {
    const d = data ? copy(data) : null;
    if (d && Object.keys(d).length) {
      clips.set(spaceId, { data: d, origin: typeof origin === "string" ? origin : null });
    } else {
      clips.delete(spaceId);
    }
  },

  /**
   * @param {number} spaceId
   * @returns {string|null} the origin that wrote the current contents
   */
  originOf(spaceId) {
    return clips.get(spaceId)?.origin ?? null;
  },

  /** @param {number} spaceId */
  clear(spaceId) {
    clips.delete(spaceId);
  },
};

/**
 * The origin a content call reports for the document its keys copied in,
 * kept only if the call's own process hosts a document of that origin in
 * the tab. A compromised content process could name any site; null means
 * no page may read the copy (the agent's paste still can).
 *
 * @param {BrowsingContext|null} bc  where the content call ran
 * @param {*} origin  what it reported
 * @returns {string|null}
 */
export function hostedOrigin(bc, origin) {
  const pid = bc?.currentWindowGlobal?.osPid;
  if (typeof origin !== "string" || !pid) {
    return null;
  }
  for (const each of bc.top.getAllBrowsingContextsInSubtree()) {
    const wg = each.currentWindowGlobal;
    if (wg?.osPid === pid && wg.documentPrincipal?.origin === origin) {
      return origin;
    }
  }
  return null;
}

/** Its own copy, keeping only strings and bytes, in the same order. */
function copy(data) {
  const out = {};
  for (const [type, value] of Object.entries(data)) {
    if (typeof value === "string") {
      out[type] = value;
    } else if (value instanceof Uint8Array) {
      out[type] = new Uint8Array(value);
    }
  }
  return out;
}
