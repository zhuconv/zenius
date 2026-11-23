// Files in and out (zen-observe): page.fetch and the Download methods.
// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Semantics follow Ego (page-model.ts page.fetch, driver/downloads.ts). I5
// (SPEC §3.9): the runtime reads or writes no file an agent names. Bodies
// and downloads leave as bytes, and the client writes saveAs and path
// targets itself.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { setupObserve } from "chrome://userscripts/content/zenius/observe/setup.sys.mjs";
import {
  getDownload,
  whenStopped,
  failureOf,
  finishedFile,
  cancelDownload,
  deleteDownload,
} from "chrome://userscripts/content/zenius/observe/downloads.sys.mjs";
import * as msg from "chrome://userscripts/content/zenius/observe/messages.sys.mjs";
import { FETCH_TIMEOUT_MS, timeoutOption, toBase64 } from "chrome://userscripts/content/zenius/observe/common.sys.mjs";

setupObserve();

function downloadFor(params) {
  const entry = getDownload(params.download);
  if (!entry) {
    throw new ZenError("ZEN_DOWNLOAD_FAILED", `unknown download ${JSON.stringify(params.download)}; it may have been deleted`, {
      download: params.download ?? null,
    });
  }
  return entry;
}

/** A call's whole result stays under Playwright's remote limit, as uploads do (zen-input). */
const MAX_BYTES = 50 * 1024 * 1024;
/** download.read's largest chunk. */
const MAX_CHUNK = 8 * 1024 * 1024;

/** The finished file's path, or Ego's "download failed: …". */
async function finishedPath(entry) {
  await whenStopped(entry);
  // finishedFile fails the download when its file isn't zenius's own any more.
  const path = failureOf(entry) ? null : finishedFile(entry);
  const failure = failureOf(entry);
  if (failure) {
    throw msg.downloadFailed(`download failed: ${failure}`, { failure });
  }
  return path;
}

// ---------------------------------------------------------------------------
// page.fetch

// Ego's fetch options: its timeout, binary (the SDK's form of saveAs), and
// the RequestInit keys that survive JSON.
const FETCH_OPTIONS = new Set([
  "timeout",
  "binary",
  "method",
  "headers",
  "body",
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
]);

function fetchOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.fetch options must be an object");
  }
  if (options.saveAs !== undefined) {
    throw new ZenError(
      "ZEN_INVALID_ARGUMENT",
      "page.fetch takes no saveAs path: send binary: true, and the client writes bodyBase64 to the file"
    );
  }
  for (const key of Object.keys(options)) {
    if (!FETCH_OPTIONS.has(key)) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `page.fetch received unknown option: ${key}. Expected: await page.fetch(url, options?)`);
    }
  }
  const { headers, binary } = options;
  if (
    headers !== undefined &&
    (headers === null || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== "string"))
  ) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.fetch headers must be an object with string values");
  }
  if (binary !== undefined && typeof binary !== "boolean") {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page.fetch binary must be a boolean");
  }
}


/**
 * Ego's page.fetch: window.fetch in the page's main world, so the page's
 * cookies, CORS and service workers apply. HTTP errors resolve; network
 * failures and the timeout throw plain Errors.
 */
async function pageFetch(ctx, params) {
  const { browsingContext } = ctx.resolvePage(params);
  if (typeof params.url !== "string" || !params.url) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page URL must be a non-empty string");
  }
  const options = params.options ?? {};
  fetchOptions(options);
  const timeoutMs = timeoutOption(options, FETCH_TIMEOUT_MS);
  const { timeout: _timeout, binary, ...init } = options;
  const payload = { url: params.url, options: init, timeoutMs, responseType: binary ? "base64" : "text" };
  // The page's own timer ends the fetch; the transport allows 1 s more.
  const response = await ctx.content(browsingContext, "evaluate#fetch", payload, { timeout: timeoutMs + 1000 });
  if (response?.fetchError) {
    throw msg.fetchFailed(response.fetchError);
  }
  if (binary && typeof response?.bodyBase64 !== "string") {
    throw msg.fetchFailed("page.fetch received no binary response body");
  }
  const size = binary ? Math.floor((response.bodyBase64.length * 3) / 4) : (response?.body?.length ?? 0);
  if (size > MAX_BYTES) {
    throw msg.fetchFailed(
      `page.fetch: the response body is ${(size / 1048576).toFixed(1)} MB, over the 50 MB one call may return. Download it instead (a link click or page.goto, then the Download's bytes).`
    );
  }
  return response;
}

/**
 * I3: cancel and delete change a download, so they act only while the agent
 * controls the task it came from, and wait at a takeover prompt (class
 * mutate). They name a download, not a space, so the dispatcher's gate
 * hasn't run: run it for the download's task.
 */
async function gateDownload(ctx, entry) {
  if (entry.spaceId !== undefined) {
    await ctx.gate(entry.spaceId);
  }
}

/** No Download method takes or returns a path any more (I5). */
function noPaths(method) {
  return new ZenError(
    "ZEN_INVALID_ARGUMENT",
    `${method} takes and returns no path: read the file's bytes with download.read {download, offset, length}, and the client writes them`
  );
}

// ---------------------------------------------------------------------------
// Methods

// Gate classes: access for the control gate (I3), i5 for the web-content
// gate (I5). The Download methods touch only the agent's own temporary
// files. Reading them changes nothing; cancel and delete change them, so
// they run the control gate for the download's task themselves (they name
// no space).
export const access = {
  "page.fetch": "mutate",
  "download.read": "read",
  "download.saveAs": "read",
  "download.path": "read",
  "download.failure": "read",
  "download.cancel": "mutate",
  "download.delete": "mutate",
};

export const i5 = {
  "page.fetch": "document",
  "download.read": "none",
  "download.saveAs": "none",
  "download.path": "none",
  "download.failure": "none",
  "download.cancel": "none",
  "download.delete": "none",
};

export const methods = {
  "page.fetch": pageFetch,

  // Once the download has finished: bytes [offset, offset + length) of its
  // file, at most 8 MiB. The SDK's saveAs() and path() write them out.
  "download.read": async (_ctx, params) => {
    const entry = downloadFor(params);
    const offset = params.offset ?? 0;
    const length = params.length ?? MAX_CHUNK;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "download.read offset must be a non-negative integer");
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_CHUNK) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", `download.read length must be an integer from 1 to ${MAX_CHUNK}`);
    }
    const source = await finishedPath(entry);
    const { size } = await IOUtils.stat(source);
    const bytes = offset < size ? await IOUtils.read(source, { offset, maxBytes: Math.min(length, size - offset) }) : new Uint8Array();
    return { base64: toBase64(bytes), size, eof: offset + bytes.length >= size };
  },

  "download.saveAs": async () => {
    throw noPaths("download.saveAs");
  },

  "download.path": async () => {
    throw noPaths("download.path");
  },

  "download.failure": async (_ctx, params) => {
    const entry = downloadFor(params);
    await whenStopped(entry);
    return failureOf(entry);
  },

  "download.cancel": async (ctx, params) => {
    const entry = downloadFor(params);
    await gateDownload(ctx, entry);
    await cancelDownload(entry);
    return { ok: true };
  },

  "download.delete": async (ctx, params) => {
    const entry = downloadFor(params);
    await whenStopped(entry);
    // After the wait, which can be long: control may have changed meanwhile.
    await gateDownload(ctx, entry);
    await deleteDownload(entry);
    return { ok: true };
  },
};
