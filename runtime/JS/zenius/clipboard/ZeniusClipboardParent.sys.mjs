// Parent half of the "ZeniusClipboard" actor (zen-ux): where a clipboard
// write or read made by a page in an agent tab goes.
//
// - The agent's work (its clicks run the page's "Copy" button, its keys
//   select and copy): the Space's own clipboard, never the system one.
// - The user's own use of the agent's page: while the takeover pill is open,
//   while they paused the Space, or right after their own keystroke there
//   (Cmd+C opens no pill). Their copies reach their clipboard as usual.
//
// Only the parent can tell the two apart: it sees the user's real input
// before the page does (ZeniusUI.isUserUsing). The child sends the time of
// the page's call, so a copy the agent made just before the user clicked
// stays the agent's.
//
// Each Space write keeps the writing document's origin, and a page reads
// the Space's clipboard only from that origin (store.sys.mjs). Another
// origin gets NotAllowedError, as after a dismissed paste prompt, and the
// agent a Zenius.refused {kind: "clipboardRead"} event.
//
// Defence in depth (content-boundary audit): only an agent task's pages run
// the guards that send these messages, so messages from anywhere else are
// ignored, and each one's shape is checked, as a compromised content
// process could send anything.

import { SpaceClipboard } from "chrome://userscripts/content/zenius/clipboard/store.sys.mjs";
import { ZeniusService } from "chrome://userscripts/content/zenius/modules/service.sys.mjs";
import { reportRefused } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { ZeniusUI } from "chrome://userscripts/content/zenius/ui/index.sys.mjs";

/** The types the guards send: the text a copy or a write carries. */
const CLIP_TYPES = new Set(["text/plain", "text/html"]);
/** Per type, in UTF-16 units. */
const MAX_CLIP_CHARS = 4 * 1024 * 1024;
/**
 * How far back the time of a page's call may reach: the trip here, also
 * from a busy parent, but never a moment long past when the user was using
 * the page.
 */
const MAX_CALL_AGE_MS = 5000;

export class ZeniusClipboardParent extends JSWindowActorParent {
  receiveMessage(msg) {
    const browser = this.browsingContext.top?.embedderElement ?? null;
    const rec = browser ? (ZeniusService.controlOf(browser)?.space ?? null) : null;
    const body = msg.data;
    if (!rec || !body || typeof body !== "object") {
      // Not a task page's guard: "user" leaves the page's call to Firefox.
      return msg.name === "clip" ? undefined : { route: "user" };
    }
    const now = Date.now();
    const at = Number.isFinite(body.at) ? Math.min(Math.max(body.at, now - MAX_CALL_AGE_MS), now) : now;
    // isUserUsing is also true while the user holds the task.
    const space = ZeniusUI.isUserUsing(browser, at) ? null : rec;
    const origin = this.manager?.documentPrincipal?.origin ?? null;
    switch (msg.name) {
      // A copy or cut event the child cancelled, with what it would have
      // written.
      case "clip": {
        const data = clipDataOf(body.data);
        if (data === undefined) {
          return undefined;
        }
        if (space) {
          SpaceClipboard.write(space.id, data, origin);
        } else if (data) {
          writeSystemClipboard(data, browser);
        }
        return undefined;
      }
      // navigator.clipboard.write() and writeText(): the child calls the
      // native method itself for the user, so images and every other type
      // keep working there.
      case "write": {
        if (!space) {
          return { route: "user" };
        }
        const data = clipDataOf(body.data);
        if (data === undefined) {
          return { route: "refused" };
        }
        SpaceClipboard.write(space.id, data, origin);
        return { route: "space" };
      }
      case "read": {
        if (!space) {
          return { route: "user" };
        }
        const allowed = SpaceClipboard.readFor(space.id, origin);
        if (!allowed) {
          const writer = SpaceClipboard.originOf(space.id);
          reportRefused(
            browser,
            "clipboardRead",
            writer
              ? `The page asked to read the task's clipboard, which holds what ${writer} wrote. Only that site can read it; the agent's own paste still can.`
              : "The page asked to read the task's clipboard, which holds the agent's own copy. Only the agent's own paste can use it.",
            this.manager?.documentURI?.spec
          );
          return { route: "refused" };
        }
        return { route: "space", data: allowed.data };
      }
    }
    return undefined;
  }
}

/**
 * A message's clip data: null stays null; anything but the guards' text
 * types, within the size limit, is undefined.
 *
 * @returns {Object<string, string>|null|undefined}
 */
function clipDataOf(data) {
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const out = {};
  for (const [type, value] of Object.entries(data)) {
    if (!CLIP_TYPES.has(type) || typeof value !== "string" || value.length > MAX_CLIP_CHARS) {
      return undefined;
    }
    out[type] = value;
  }
  return out;
}

/** The user's copy in an agent page: its text types, most preferred first. */
function writeSystemClipboard(data, browser) {
  const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  t.init(browser?.loadContext ?? null);
  let any = false;
  for (const [flavor, value] of Object.entries(data)) {
    if (typeof value !== "string") {
      continue;
    }
    const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    s.data = value;
    t.addDataFlavor(flavor);
    t.setTransferData(flavor, s);
    any = true;
  }
  if (any) {
    Services.clipboard.setData(t, null, Ci.nsIClipboard.kGlobalClipboard);
  }
}
