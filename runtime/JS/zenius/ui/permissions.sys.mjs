// Permission prompts in agent pages (the observe layer's backstops follow the
// same rules):
// - while the agent drives, a page's prompt puts its Space under the user's
//   control with Ego's reason key, and gives it back once it's answered;
// - during the user's hold it's theirs, as on any site: nothing happens here;
// - on evidence of danger in the page (the observe layer's flag), it's cancelled at
//   once, whoever holds the task;
// - the camera, microphone, screen and speakers are never the agent's: while
//   the agent drives, their prompt is cancelled (the observe layer's gate denies
//   them before any prompt). During the hold they're the user's, and
//   the observe layer stops what the user started when the task goes back to the
//   agent.
//
// Firefox shows a tab's permission prompts through
// PopupNotifications.show(browser, id, …), and keeps the ones for background
// tabs until the tab is selected, so the prompt itself already waits for the
// user to open the Space. PopupNotifications announces background prompts
// only through an observer topic without a subject, so we wrap show() in each
// window to learn which browser asked, and the prompt's eventCallback to learn
// when it went away.
//
// The host may refuse a prompt (pages can't hand a task to the user at
// will, ZeniusUI): it's then removed at once without a user response, which
// cancels the page's request and stores nothing (Gecko 160's PermissionUI
// and WebRTCParent both treat such a removal so). The host also learns
// whether a prompt that went away was answered: PopupNotifications says
// whether it was removed without the user's response.

/**
 * PopupNotifications ids of the permission prompts a task's pages hand to the
 * user while the agent drives → Ego's reason keys (its
 * EGO_TASK_SPACE_USER_IN_CONTROL list, which the SDK's guidance follows). An
 * embedded sign-in frame needs storage access during a login; the local
 * network's prompts carry the observe layer's allowlist past top-level loads; the
 * rest a site may need for the task. Persistent storage and XR have no key
 * of their own there, so they take its catch-all, permission_prompt.
 */
const REASONS = {
  "storage-access": "storage_access",
  "local-network": "local_network_access",
  "loopback-network": "local_network_access",
  geolocation: "location",
  "web-notifications": "notifications",
  midi: "midi",
  "webSerial-choosePort": "serial",
  "persistent-storage": "permission_prompt",
  xr: "permission_prompt",
};

/** The camera, microphone, screen and speakers' prompt: never the agent's. */
const DEVICES = new Set(["webRTC-shareDevices"]);

/**
 * Ego's reason key for a prompt a task's page hands to the user, or null
 * (the devices', or not a permission prompt: password saving, add-on
 * progress, …).
 *
 * @param {string} id
 */
export function reasonFor(id) {
  return REASONS[id] ?? null;
}

/**
 * Whether it's the camera, microphone, screen and speakers' prompt.
 *
 * @param {string} id
 */
export function isDevicePrompt(id) {
  return DEVICES.has(id);
}

/**
 * @typedef {object} PermissionHost
 * @property {(browser: Element, reason: string, id: string, origin: string) => boolean|void} onPrompt
 *   false refuses the prompt
 * @property {(browser: Element, reason: string, id: string, answered: boolean) => void} onPromptGone
 * @property {(browser: Element, id: string, origin: string) => boolean} [denies]
 *   true cancels a permission prompt at once, before onPrompt: a task's
 *   page with evidence of danger, or the devices' while the agent drives
 */

const WRAPPED = Symbol("zenius.permissions");
/** On a pending prompt that a new one with the same id replaces. */
const REPLACED = Symbol("zenius.permissions.replaced");

/**
 * Watch one window's PopupNotifications.
 *
 * @param {Window} win
 * @param {PermissionHost} host
 */
export function watchPermissionPrompts(win, host) {
  const pn = win.PopupNotifications;
  if (!pn || pn[WRAPPED]) {
    return;
  }
  const show = pn.show;
  pn[WRAPPED] = show;
  pn.show = function (browser, id, message, anchorID, mainAction, secondaryActions, options) {
    const reason = reasonFor(id);
    let refused = false;
    // show() replaces the browser's pending prompt with the same id (a page
    // asking again): the same handoff goes on, so that removal mustn't give
    // control back.
    const pending = reason ? this.getNotification(id, browser) : null;
    if (reason) {
      if (pending) {
        pending[REPLACED] = true;
      }
      const inner = options?.eventCallback;
      options = {
        ...options,
        // PopupNotifications calls this with the notification as `this` and
        // reads its return value ("showing" may dismiss), so pass both on.
        eventCallback(topic, ...args) {
          if (topic === "removed" && !refused && !this[REPLACED]) {
            // args: nextRemovalReason, withoutUserResponse
            notify(() => host.onPromptGone(browser, reason, id, !args[1]));
          }
          return inner ? inner.call(this, topic, ...args) : undefined;
        },
      };
    }
    let notification;
    try {
      notification = show.call(this, browser, id, message, anchorID, mainAction, secondaryActions, options);
    } catch (e) {
      if (pending) {
        delete pending[REPLACED];
      }
      throw e;
    }
    if ((reason || DEVICES.has(id)) && notification && notify(() => host.denies?.(browser, id, originOf(options, browser))) === true) {
      refused = true;
      this.remove(notification, /* withoutUserResponse */ true);
    } else if (reason && notification && notify(() => host.onPrompt(browser, reason, id, originOf(options, browser))) === false) {
      refused = true;
      this.remove(notification, /* withoutUserResponse */ true);
    }
    return notification;
  };
}

/** Undo watchPermissionPrompts (tests, shutdown). */
export function unwatchPermissionPrompts(win) {
  const pn = win.PopupNotifications;
  if (pn?.[WRAPPED]) {
    pn.show = pn[WRAPPED];
    delete pn[WRAPPED];
  }
}

/**
 * The origin a prompt asks for: the requesting page's, which PermissionUI
 * passes as displayURI (a cross-origin frame's own), else the tab's.
 */
function originOf(options, browser) {
  const uri = options?.displayURI;
  if (uri instanceof Ci.nsIURI) {
    try {
      return uri.prePath;
    } catch {
      // A URI without a host (about:, data:) has no prePath.
    }
  }
  return browser?.contentPrincipal?.originNoSuffix ?? "";
}

function notify(fn) {
  try {
    return fn();
  } catch (e) {
    console.error("[zenius] permission prompt handling failed", e);
    return undefined;
  }
}
