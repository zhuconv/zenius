// Helpers for zen-ux's page guards (content process): a guarded page API
// answers with the page's own promises and errors, so the page can't tell it
// from the native one.

/**
 * A promise of the page's own, settled by `fn`. Errors that aren't the
 * page's become NotAllowedError, as for any refused browser call.
 *
 * @param {Window} win
 * @param {() => Promise<any>} fn
 */
export function settle(win, fn) {
  return new win.Promise((resolve, reject) => {
    fn().then(resolve, e => {
      if (e && typeof e === "object" && "pageError" in e) {
        reject(e.pageError);
      } else if (e instanceof Error || !e || typeof e !== "object") {
        reject(new win.DOMException(String(e?.message ?? e ?? "The request is not allowed."), "NotAllowedError"));
      } else {
        // Already the page's (a native method's rejection).
        reject(e);
      }
    });
  });
}

/**
 * An error for settle() to hand the page as it is.
 *
 * @param {Window} win
 * @param {string} name     "TypeError", or a DOMException name
 * @param {string} message
 */
export function pageError(win, name, message) {
  return { pageError: name === "TypeError" ? new win.TypeError(message) : new win.DOMException(message, name) };
}
