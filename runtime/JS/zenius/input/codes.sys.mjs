// The sign-in rules' code measure (SPI "The sign-in rules"): the agent's
// entry into a one-time-code field (content/codefield.sys.mjs) by fill, a
// typed or pressed key, or a paste goes ahead only on a site the user
// visited before the task began. The page's process refuses each such entry
// the parent hasn't checked (content/signinguard.sys.mjs refuseCodeEntry).
// Here the parent checks the tab's site in the user's history, once per task
// and site, and either has the call made again or refuses it for good, which
// leaves the field's document, and its tab's top document in that process,
// to the agent to read but not act on, until it goes or the user hands back.
//
// The tab's site, not the field's frame's: a fresh phishing page that frames
// a hosted form from a big site is still caught. Task pages write no history
// (modules/history.sys.mjs), so a visit is the user's own. Places is read
// only here, and only after such a refusal: elsewhere this costs nothing.

import { codeEntryRefusal } from "chrome://userscripts/content/zenius/content/signin.sys.mjs";
import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

/** How many times one call's entry may be checked and made again. */
const MAX_TRIES = 2;

/**
 * Per task: "<since>|<site>" to whether the user visited the site before
 * `since` (a promise, so calls at once share one query). A visit from before
 * the task can't appear later, so an answer holds for the task.
 *
 * @type {WeakMap<object, Map<string, Promise<boolean>>>}
 */
const answers = new WeakMap();

/** Is `e` the page's process refusing a code entry the parent hasn't checked? */
export function isCodeRefusal(e) {
  return e?.code === "ZEN_SIGN_IN_PAGE" && e.data?.reason === "one_time_code" && !!e.data?.codeCheck;
}

/** The site whose visits count for `uri`: its registrable domain, or its host where it has none (an IP address, localhost). */
function siteOf(uri) {
  if (!uri || (uri.scheme !== "http" && uri.scheme !== "https")) {
    return null;
  }
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch {
    // An IP address, or a host with no registrable domain.
  }
  try {
    return uri.asciiHost || null;
  } catch {
    return null;
  }
}

/**
 * Did the user visit `site` or a host under it before `since` (epoch ms)?
 * One read-only query: Places keeps each host reversed with a trailing dot
 * (moc.elpmaxe. for example.com), so the site and its subdomains are the
 * hosts from that string up to the one with its dot raised to a slash.
 * Downloads and framed links aren't visits to the site's pages.
 */
async function visitedBefore(site, since) {
  const rev = `${[...site].reverse().join("")}.`;
  const T = lazy.PlacesUtils.history.TRANSITIONS;
  const db = await lazy.PlacesUtils.promiseDBConnection();
  const rows = await db.executeCached(
    `SELECT 1 FROM moz_places h JOIN moz_historyvisits v ON v.place_id = h.id
     WHERE h.rev_host >= :rev AND h.rev_host < :end AND v.visit_date < :since
       AND v.visit_type NOT IN (${T.EMBED}, ${T.DOWNLOAD}, ${T.FRAMED_LINK})
     LIMIT 1`,
    { rev, end: `${rev.slice(0, -1)}/`, since: since * 1000 }
  );
  return rows.length > 0;
}

function visited(rec, site, since) {
  let byKey = answers.get(rec);
  if (!byKey) {
    byKey = new Map();
    answers.set(rec, byKey);
  }
  const key = `${since}|${site}`;
  if (!byKey.has(key)) {
    const answer = visitedBefore(site, since).catch(e => {
      // Unknown counts as no visit: the user enters the code.
      console.error("[zenius] the one-time code check couldn't read history", e);
      byKey.delete(key);
      return false;
    });
    byKey.set(key, answer);
  }
  return byKey.get(key);
}

/**
 * After the page's process refused the agent's entry into a code field
 * (isCodeRefusal): the innerWindowId of the tab's top document, for the
 * call to be made again with (`codeOk`), when the tab's site had a visit
 * before the task began. Else, or past MAX_TRIES, it refuses for good:
 * the field's document is marked, then ZEN_SIGN_IN_PAGE is thrown.
 *
 * @param {object} ctx  the method's context
 * @param {{space: object, browsingContext: BrowsingContext}} rp  the page
 * @param {ZenError} e  the page's process's refusal
 * @param {string} method
 * @param {number} tries  how many times this call was refused so far, this one included
 * @returns {Promise<number>}
 */
export async function settleCodeRefusal(ctx, rp, e, method, tries) {
  const rec = rp.space;
  let top = 0;
  let uri = null;
  try {
    const wg = rp.browsingContext.currentWindowGlobal;
    top = wg?.innerWindowId ?? 0;
    uri = wg?.documentURI ?? null;
  } catch {}
  const site = siteOf(uri);
  // A claimed Space of the user's begins at its claim.
  const since = rec?.claimedAt ?? rec?.createdAt ?? Date.now();
  // An answer is cached for the task, so a call past MAX_TRIES reads no more.
  const found = !!(top && site && rec) && (await visited(rec, site, since));
  if (found && tries <= MAX_TRIES) {
    return top;
  }
  // Past MAX_TRIES with a visit found, the page's top document changed under each try.
  const { message, data, page } = codeEntryRefusal(method, site, found);
  const doc = e.data.codeCheck.doc;
  let bc = null;
  try {
    bc = rp.browsingContext.getAllBrowsingContextsInSubtree().find(b => b.currentWindowGlobal?.innerWindowId === doc) ?? null;
  } catch {}
  if (bc) {
    // Marked before the refusal goes out, so the agent's next call finds it.
    try {
      await ctx.content(bc, "signinguard#markCode", { page });
    } catch (err) {
      console.error("[zenius] marking a code refusal's page failed", err);
    }
  }
  throw new ZenError("ZEN_SIGN_IN_PAGE", message, data);
}

/** The key steps a refused call didn't run (codeCheck.left), for the call made again. */
export function stepsLeft(steps, e) {
  const left = e?.data?.codeCheck?.left;
  return Array.isArray(steps) && Number.isInteger(left) && left >= 0 && left <= steps.length ? steps.slice(steps.length - left) : steps;
}
