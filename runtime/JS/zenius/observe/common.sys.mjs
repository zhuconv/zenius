// Shared by zen-observe's method modules: Ego's defaults, deadlines and
// option checks, and which pages the agent has used.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { displayURL } from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

// Ego's defaults (page-model.ts, driver/page-waits.ts, browser-runtime.ts).
export const GOTO_TIMEOUT_MS = 15000;
export const WAIT_TIMEOUT_MS = 10000;
export const RESPONSE_TIMEOUT_MS = 15000;
export const NETWORK_IDLE_MS = 500;
export const FETCH_TIMEOUT_MS = 20000;
export const POLL_MS = 100;

export const TIMEOUT = Symbol("timeout");

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/** `promise`, or TIMEOUT once `deadline` (on the ChromeUtils.now() clock) passes. */
export function beforeDeadline(promise, deadline) {
  const left = deadline - ChromeUtils.now();
  if (left <= 0) {
    return Promise.race([promise, Promise.resolve(TIMEOUT)]);
  }
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => {
      timer = setTimeout(() => resolve(TIMEOUT), left);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A positive number of milliseconds from `options[name]`, else `fallback`. */
export function timeoutOption(options, fallback, name = "timeout") {
  const t = options?.[name];
  if (t === undefined || t === null) {
    return fallback;
  }
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${name} must be a positive number of milliseconds`);
  }
  return t;
}

/**
 * How long one call may wait for the page: the SDK sends Ego's
 * EGO_BROWSER_RESPONSE_TIMEOUT_MS as `responseTimeout`; 15000 otherwise.
 */
export function responseTimeout(params) {
  const t = params?.responseTimeout;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : RESPONSE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Pages the agent has used, for Ego's "unhandled popup" checks: a popup is
// unhandled until a call addresses it or a popup wait returns it.

const usedPages = new WeakSet();

export function markUsed(page) {
  if (page?.key) {
    usedPages.add(page.key);
  }
}

/** Popups opened by `page` that the agent hasn't used yet, oldest first. */
export function unhandledPopups(ctx, page) {
  const out = [];
  for (const p of ctx.pages.list(page.spaceId)) {
    if (p.opener === page.label && !usedPages.has(p.key)) {
      const browser = ctx.pages.tabFor(p)?.linkedBrowser;
      out.push({ label: p.label, url: browser ? displayURL(browser) : "" });
    }
  }
  return out;
}

/** Base64 of bytes, in slices: String.fromCharCode takes only so many arguments. */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
