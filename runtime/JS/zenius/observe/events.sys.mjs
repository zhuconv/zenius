// Per-page event buffers for page.events() (zen-observe).
//
// Ego's page.events() returns the CDP events its session buffered for the
// Page and clears the buffer. We keep the same {method, params} records:
// Page.javascriptDialogOpening/Closed, Page.downloadWillBegin,
// Network.requestWillBeSent/responseReceived/loadingFinished/loadingFailed
// and Runtime.consoleAPICalled. Waits never read these buffers, so they
// never consume an agent's events.

import { capText } from "chrome://userscripts/content/zenius/observe/textcap.sys.mjs";

// Ego's MAX_BUFFERED_EVENTS: the oldest events go first.
const MAX_EVENTS = 10000;
// A page's buffer in bytes (about their length as JSON), so page text can't
// grow the main process: the oldest events go first here too.
const MAX_BYTES = 1024 * 1024;

/**
 * @typedef {object} Buffer
 * @property {Array<{method: string, params: object}>} events
 * @property {number[]} sizes  each event's bytes
 * @property {number} bytes    their sum
 */

/** @type {Map<number, Buffer>} browserId → events */
const buffers = new Map();

/**
 * Buffer an event for the tab's page.events(). Its text is capped
 * (observe/textcap.sys.mjs), and an event that lost some says
 * `truncated: true`.
 */
export function pushEvent(browserId, method, params) {
  if (!browserId) {
    return;
  }
  const capped = capText(params ?? {});
  const value = capped.value && typeof capped.value === "object" && !Array.isArray(capped.value) ? capped.value : {};
  if (capped.truncated) {
    value.truncated = true;
  }
  const size = capped.bytes + method.length + 32;
  let buffer = buffers.get(browserId);
  if (!buffer) {
    buffer = { events: [], sizes: [], bytes: 0 };
    buffers.set(browserId, buffer);
  }
  buffer.events.push({ method, params: value });
  buffer.sizes.push(size);
  buffer.bytes += size;
  while (buffer.events.length > MAX_EVENTS || buffer.bytes > MAX_BYTES) {
    buffer.events.shift();
    buffer.bytes -= buffer.sizes.shift();
  }
}

/** Everything buffered for the tab, oldest first; the buffer is cleared. */
export function drainEvents(browserId) {
  const buffer = buffers.get(browserId);
  buffers.delete(browserId);
  return buffer?.events ?? [];
}

/**
 * Forget the buffers of tabs zenius no longer drives for an agent: closed,
 * or left to the user when their task finished. `keep(browserId)` says
 * which stay; by default, those whose tab still exists.
 */
export function sweepEvents(keep = browserId => !!BrowsingContext.getCurrentTopByBrowserId(browserId)) {
  for (const browserId of buffers.keys()) {
    if (!keep(browserId)) {
      buffers.delete(browserId);
    }
  }
}

/** For tests and the SPI: how much a tab's buffer holds, or null if none. */
export function bufferedEvents(browserId) {
  const buffer = buffers.get(browserId);
  return buffer ? { events: buffer.events.length, bytes: buffer.bytes } : null;
}

/** Seconds, as CDP's MonotonicTime and TimeSinceEpoch. */
export function cdpTime() {
  return { timestamp: ChromeUtils.now() / 1000, wallTime: Date.now() / 1000 };
}
