/* Agent Sidebar's live card, the parent's side: asks the page's own process
 * for a picture of the part of the agent's page the card shows
 * (AgentSidebarPictureChild.sys.mjs says why it is painted there). The
 * parent's main thread only sends the ask and takes back the raw pixels,
 * which the panel copies into the card: nothing that process made goes
 * through an image decoder here.
 *
 * It paints only an agent's page of the chat's own zenius task, while the
 * agent has the task (paintable): never a user's tab, a tab the user opened
 * in the task, another task's page, or the task's pages while the user holds
 * them in a hand-off or Take over, where they may type a password. The check
 * comes before the actor is made, so a user's document never gets one. The
 * pictures go only to the panel.
 */

import { AgentService } from "./AgentService.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const ACTOR = "AgentSidebarPicture";
// A page's process that hasn't answered by then is too busy to paint. The
// panel times the whole ask, so this counts as a very slow picture there:
// the card keeps what it has, and doesn't ask the busy page again.
const PICTURE_TIMEOUT_MS = 5000;
const PREF_TIMEOUT = "uc.agent-sidebar.picture-timeout";

let registered = false;

/** The actor, registered once in this process on first use. */
function register() {
  if (registered) {
    return;
  }
  registered = true;
  try {
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: import.meta.url },
      child: { esModuleURI: new URL("AgentSidebarPictureChild.sys.mjs", import.meta.url).href },
      allFrames: false,
      messageManagerGroups: ["browsers"],
      // Without this the actor is refused in web and file content processes.
      safeForUntrustedWebProcess: true,
    });
  } catch (e) {
    if (!/already/i.test(String(e))) {
      registered = false;
      throw e;
    }
  }
}

export class AgentSidebarPictureParent extends JSWindowActorParent {}

/**
 * May the card paint `tab` for `conv`? Only a page zenius keeps for the work
 * chat's own task (the agent's page: a tab the user opened in the task has
 * none), among the task's tabs and not the user's own, while the task is
 * live and the agent has it.
 *
 * @param {object} conv  the chat (AgentService's Conversation)
 * @param {Element} tab
 * @returns {boolean}
 */
export function paintable(conv, tab) {
  if (conv?.kind !== "work" || !tab?.linkedBrowser || tab.closing) {
    return false;
  }
  // Null once the task has ended: its kept tabs are the user's.
  const rec = AgentService.zenRecord(conv);
  const pages = rec && AgentService.zenius()?.pages;
  if (!pages || rec.kind !== "task" || rec.ownership !== "agent") {
    return false;
  }
  try {
    return pages.forTab(tab)?.spaceId === rec.id && !pages.isUserOwn(tab) && pages.tabsOf(rec).includes(tab);
  } catch {
    return false;
  }
}

/**
 * A picture of the top of `tab`'s page, `width` device pixels wide and at
 * most `height` tall, drawn in the page's process. Null when there is none
 * to have: the tab isn't one the card may paint (paintable), the page isn't
 * in a content process (its paint would run in the parent), it is between
 * documents, its process didn't answer within PICTURE_TIMEOUT_MS, or what
 * came back isn't pixels of the size asked.
 *
 * @param {object} conv  the chat whose card asks
 * @param {Element} tab
 * @param {{width: number, height: number}} size
 * @returns {Promise<{width: number, height: number, pixels: Uint8Array}|null>} RGBA rows
 */
export async function drawPicture(conv, tab, { width, height }) {
  width = Math.round(width);
  height = Math.round(height);
  const browser = tab?.linkedBrowser;
  if (!paintable(conv, tab) || !browser?.isRemoteBrowser) {
    return null;
  }
  register();
  let actor;
  try {
    actor = browser.browsingContext?.currentWindowGlobal?.getActor(ACTOR);
  } catch {
    return null;
  }
  if (!actor) {
    return null;
  }
  let timer;
  let picture;
  try {
    const ms = Services.prefs.getIntPref(PREF_TIMEOUT, 0) || PICTURE_TIMEOUT_MS;
    picture = await Promise.race([
      actor.sendQuery("AgentSidebarPicture:draw", { width, height }),
      new Promise(resolve => (timer = setTimeout(() => resolve(null), ms))),
    ]);
  } catch {
    // The page went to another document meanwhile.
    return null;
  } finally {
    clearTimeout(timer);
  }
  // The user may have taken the page over while it was painted.
  if (!picture || !paintable(conv, tab)) {
    return null;
  }
  // It comes from the page's process: only pixels exactly as wide as asked,
  // no taller, and as many bytes as that takes.
  const pixels = picture.pixels;
  const tall = picture.height;
  if (
    picture.width !== width ||
    !Number.isInteger(tall) ||
    tall < 1 ||
    tall > height ||
    !(pixels instanceof Uint8Array) ||
    pixels.byteLength !== width * tall * 4
  ) {
    return null;
  }
  return { width, height: tall, pixels };
}
