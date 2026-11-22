// Navigation (zen-observe): goto, reload, the waits for URLs, load states and
// events, and the page gate that holds content-bound calls while a
// navigation is pending or a dialog is open.
// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Semantics follow Ego (page-model.ts, driver/page-waits.ts); the design is
// in docs/research/observe.md §3 and §4. Gecko keeps the old document
// responsive while a navigation is pending, so where Chromium stalls, the
// gate here waits for the commit on purpose and stops the navigation once
// that wait runs out, which gives agents Ego's outcomes.

import { ZenError } from "chrome://userscripts/content/zenius/modules/errors.sys.mjs";
import { log } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { setupObserve } from "chrome://userscripts/content/zenius/observe/setup.sys.mjs";
import {
  trackerFor,
  stripRef,
  errorPageCode,
  settleFreshPopup,
} from "chrome://userscripts/content/zenius/observe/navtracker.sys.mjs";
import { waitForNetworkIdle, resetQuiet, inflight } from "chrome://userscripts/content/zenius/observe/network.sys.mjs";
import { currentDialog, watchDialogs } from "chrome://userscripts/content/zenius/observe/dialogs.sys.mjs";
import { watchRefusals } from "chrome://userscripts/content/zenius/observe/refusals.sys.mjs";
import { syncAudio } from "chrome://userscripts/content/zenius/observe/audio.sys.mjs";
import { agentLoadRefusal } from "chrome://userscripts/content/zenius/observe/localnet.sys.mjs";
import { checkOwnPageLoad } from "chrome://userscripts/content/zenius/observe/pagecode.sys.mjs";
import { noteAgentCode } from "chrome://userscripts/content/zenius/observe/agentcode.sys.mjs";
import { noteMade } from "chrome://userscripts/content/zenius/observe/agentworld.sys.mjs";
import { OUTSIDE_DOCUMENT, agentLoadOptions, checkAgentLoad, checkWebContent, inWebProcess } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";
import {
  prepareBrowser,
  waitForDownload,
  claimDownload,
  onDownload,
} from "chrome://userscripts/content/zenius/observe/downloads.sys.mjs";
import * as msg from "chrome://userscripts/content/zenius/observe/messages.sys.mjs";
import {
  GOTO_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
  NETWORK_IDLE_MS,
  TIMEOUT,
  sleep,
  beforeDeadline,
  timeoutOption,
  responseTimeout,
  markUsed,
  unhandledPopups,
} from "chrome://userscripts/content/zenius/observe/common.sys.mjs";

const { setTimeout, clearTimeout, setInterval, clearInterval } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

setupObserve();

const WAIT_UNTIL = ["commit", "domcontentloaded", "load", "networkidle"];
const FIRST_CHUNK_MS = 250;
// How long a navigation that stopped without a document may wait for the
// download it started to register.
const DOWNLOAD_GRACE_MS = 1000;
// How long a load stopped by a TLS error waits for Firefox's error page.
const ERROR_PAGE_GRACE_MS = 2000;
const LOAD_STATES = new Set(["domcontentloaded", "load", "networkidle"]);

// ---------------------------------------------------------------------------
// Following one navigation

/**
 * Subscribe to the tab's events for the navigation to `spec`, before it
 * starts. `state.committed` is the commit event (or a same-document change
 * to exactly `spec`), `state.ended` a STOP that came without a commit.
 */
function follow(nav, spec) {
  const want = stripRef(spec);
  const state = { started: false, committed: null, ended: null };
  let wake = null;
  const off = nav.listen(ev => {
    if (state.committed) {
      return;
    }
    const ours = !ev.original || stripRef(ev.original) === want;
    if (ev.type === "start" && ours) {
      state.started = true;
    } else if (ev.type === "commit" && !ev.stale) {
      if (ev.errorPage || ours) {
        state.committed = ev;
      }
    } else if (ev.type === "sameDocument" && ev.url === spec) {
      state.committed = { ...ev, sameDocument: true };
    } else if (ev.type === "stop" && ours && state.started) {
      // A STOP before our START belongs to the load ours replaced (Gecko
      // aborts it first), which may have had the same URL (a reload).
      state.ended = ev;
    }
    const w = wake;
    wake = null;
    w?.();
  });
  return {
    state,
    off,
    changed: () => new Promise(resolve => (wake = resolve)),
  };
}

/**
 * After a load that stopped on a TLS error, wait for the error page Firefox
 * shows for it (about:certerror or about:neterror) to commit, so the call
 * fails with the tab already showing it.
 */
async function untilErrorPage(watch, deadline) {
  while (!watch.state.committed?.errorPage) {
    if ((await beforeDeadline(watch.changed(), deadline)) === TIMEOUT) {
      return false;
    }
  }
  return true;
}

/** Wait until the followed navigation commits or ends, or the deadline. */
async function untilCommitted(watch, deadline, interrupt) {
  while (!watch.state.committed && !watch.state.ended) {
    const r = await beforeDeadline(Promise.race([watch.changed(), interrupt]), deadline);
    if (r === TIMEOUT) {
      return false;
    }
    if (r?.interrupted) {
      return r;
    }
  }
  return true;
}

/**
 * Wait in the page for a load state of the document the tab shows. A
 * document replaced on the way (a client redirect) is followed to its
 * successor. Returns {reached, readyState}.
 */
async function untilLoadState(ctx, browser, state, deadline, { idleMs = NETWORK_IDLE_MS } = {}) {
  const nav = trackerFor(browser);
  for (;;) {
    const left = deadline - ChromeUtils.now();
    if (left <= 0) {
      return { reached: false, readyState: await readyStateOf(ctx, browser) };
    }
    if (nav.pending) {
      await nav.waitUntilSettled(left);
      continue;
    }
    try {
      const r = await ctx.content(browser.browsingContext, "nav#waitForReadyState", {
        state: state === "networkidle" ? "load" : state,
        timeoutMs: left,
      });
      if (r.navigated) {
        // The document was replaced; wait on its successor.
        await sleep(10);
        continue;
      }
      if (!r.reached || state !== "networkidle") {
        return r;
      }
      const idle = await waitForNetworkIdle(browser.browserId, { idleMs, timeoutMs: deadline - ChromeUtils.now() });
      return { reached: idle, readyState: r.readyState };
    } catch (e) {
      const reason = e?.data?.reason;
      if (reason !== "context_destroyed" && reason !== "no_window_global") {
        throw e;
      }
      await sleep(10);
    }
  }
}

async function readyStateOf(ctx, browser) {
  try {
    const r = await ctx.content(browser.browsingContext, "nav#documentState", {}, { timeout: 250 });
    return r.readyState;
  } catch {
    return null;
  }
}

// Chromium's net error names for Gecko's error page codes, so agents see the
// text Ego shows them ("page.goto failed: net::ERR_NAME_NOT_RESOLVED").
const NET_ERRORS = {
  connectionFailure: "net::ERR_CONNECTION_REFUSED",
  dnsNotFound: "net::ERR_NAME_NOT_RESOLVED",
  netTimeout: "net::ERR_TIMED_OUT",
  deniedPortAccess: "net::ERR_UNSAFE_PORT",
  netReset: "net::ERR_CONNECTION_RESET",
  netInterrupt: "net::ERR_CONNECTION_CLOSED",
  netOffline: "net::ERR_INTERNET_DISCONNECTED",
  unknownProtocolFound: "net::ERR_UNKNOWN_URL_SCHEME",
  malformedURI: "net::ERR_INVALID_URL",
  fileNotFound: "net::ERR_FILE_NOT_FOUND",
  fileAccessDenied: "net::ERR_ACCESS_DENIED",
  redirectLoop: "net::ERR_TOO_MANY_REDIRECTS",
  nssFailure2: "net::ERR_SSL_PROTOCOL_ERROR",
  nssBadCert: "net::ERR_CERT_INVALID",
  proxyConnectFailure: "net::ERR_PROXY_CONNECTION_FAILED",
  proxyResolveFailure: "net::ERR_PROXY_CONNECTION_FAILED",
  contentEncodingError: "net::ERR_CONTENT_DECODING_FAILED",
  corruptedContentErrorv2: "net::ERR_INVALID_RESPONSE",
  blockedByPolicy: "net::ERR_BLOCKED_BY_ADMINISTRATOR",
  httpErrorPage: "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
};

// Chromium's names for the certificate errors behind Firefox's certificate
// warning (about:certerror, NSS's codes); any other is ERR_CERT_INVALID.
const CERT_ERRORS = {
  SEC_ERROR_UNKNOWN_ISSUER: "net::ERR_CERT_AUTHORITY_INVALID",
  SEC_ERROR_UNTRUSTED_ISSUER: "net::ERR_CERT_AUTHORITY_INVALID",
  SEC_ERROR_CA_CERT_INVALID: "net::ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT: "net::ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_MITM_DETECTED: "net::ERR_CERT_AUTHORITY_INVALID",
  SSL_ERROR_BAD_CERT_DOMAIN: "net::ERR_CERT_COMMON_NAME_INVALID",
  SEC_ERROR_EXPIRED_CERTIFICATE: "net::ERR_CERT_DATE_INVALID",
  SEC_ERROR_EXPIRED_ISSUER_CERTIFICATE: "net::ERR_CERT_DATE_INVALID",
  MOZILLA_PKIX_ERROR_NOT_YET_VALID_CERTIFICATE: "net::ERR_CERT_DATE_INVALID",
  MOZILLA_PKIX_ERROR_NOT_YET_VALID_ISSUER_CERTIFICATE: "net::ERR_CERT_DATE_INVALID",
  SEC_ERROR_REVOKED_CERTIFICATE: "net::ERR_CERT_REVOKED",
  MOZILLA_PKIX_ERROR_INSUFFICIENT_CERTIFICATE_TRANSPARENCY: "net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED",
};

/**
 * A load that ended on Firefox's certificate warning: Ego's text with
 * Chromium's name for the error, and what the agent can't do about it. The
 * page's "Accept the Risk" would add a lasting exception to the user's
 * profile, so no agent method acts in that page (I5).
 *
 * @param {string|null} nss  the NSS error, such as SEC_ERROR_UNKNOWN_ISSUER
 */
function certificateWarning(method, uri, nss) {
  const code = CERT_ERRORS[nss] ?? "net::ERR_CERT_INVALID";
  const host = uri.hostPort || uri.spec;
  return msg.navigationFailed(
    method,
    `${code}. Firefox showed a certificate warning for ${host}${nss ? ` (${nss})` : ""}: it can't verify that the site is who it says. An agent can't accept the risk or add an exception; ask the user to check the site.`,
    { url: uri.spec, error: nss ?? "nssBadCert", certificateWarning: true }
  );
}

/**
 * A load stopped by a TLS error: the NSS error's name, and whether it is
 * the certificate kind Firefox shows its warning for (one a user may
 * override); null for any other status.
 */
function securityError(status) {
  const name = /NS_ERROR_MODULE_SECURITY, ([A-Z0-9_]+)\)/.exec(ChromeUtils.getXPCOMErrorName(status))?.[1];
  if (!name) {
    return null;
  }
  let certificate = false;
  try {
    const nss = Cc["@mozilla.org/nss_errors_service;1"].getService(Ci.nsINSSErrorsService);
    certificate = nss.getErrorClass(status) === Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT;
  } catch {}
  return { name, certificate };
}

// The same names for the network errors that end a navigation without an
// error page (Gecko reports some at STOP).
const NET_STATUS = {
  NS_ERROR_CONNECTION_REFUSED: "net::ERR_CONNECTION_REFUSED",
  NS_ERROR_UNKNOWN_HOST: "net::ERR_NAME_NOT_RESOLVED",
  NS_ERROR_NET_TIMEOUT: "net::ERR_TIMED_OUT",
  NS_ERROR_NET_RESET: "net::ERR_CONNECTION_RESET",
  NS_ERROR_NET_INTERRUPT: "net::ERR_CONNECTION_CLOSED",
  NS_ERROR_NET_EMPTY_RESPONSE: "net::ERR_EMPTY_RESPONSE",
  NS_ERROR_NET_PARTIAL_TRANSFER: "net::ERR_CONTENT_LENGTH_MISMATCH",
  NS_ERROR_OFFLINE: "net::ERR_INTERNET_DISCONNECTED",
  NS_ERROR_UNKNOWN_PROTOCOL: "net::ERR_UNKNOWN_URL_SCHEME",
  NS_ERROR_MALFORMED_URI: "net::ERR_INVALID_URL",
  NS_ERROR_FILE_NOT_FOUND: "net::ERR_FILE_NOT_FOUND",
  NS_ERROR_FILE_ACCESS_DENIED: "net::ERR_ACCESS_DENIED",
  NS_ERROR_REDIRECT_LOOP: "net::ERR_TOO_MANY_REDIRECTS",
  NS_ERROR_PORT_ACCESS_NOT_ALLOWED: "net::ERR_UNSAFE_PORT",
  NS_ERROR_PROXY_CONNECTION_REFUSED: "net::ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_UNKNOWN_PROXY_HOST: "net::ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_CORRUPTED_CONTENT: "net::ERR_INVALID_RESPONSE",
  NS_ERROR_INVALID_CONTENT_ENCODING: "net::ERR_CONTENT_DECODING_FAILED",
  NS_BINDING_ABORTED: "net::ERR_ABORTED",
};

// A load kept off the local network that zenius didn't report: Firefox's
// own Local Network Access refused it. zenius's refusals (a redirect there)
// come with their own message in the receipt.
const LOCAL_NETWORK_DENIED = "net::ERR_ACCESS_DENIED. Firefox kept the load off the local network (its Local Network Access check).";

/**
 * goto and reload: start the navigation, follow it to `waitUntil`, and stop
 * it at the timeout if it hasn't committed. Resolves to Ego's receipt: {},
 * {popups} or, when a dialog opened on the way, {dialog}; plus zenius's
 * {refused} for surfaces it refused on the way.
 */
/**
 * Is `uri` on the page's site: its document's (an opaque document's maker's,
 * an about:blank's opener's), or the one its URL shows (an error page's)?
 * A reload always is.
 */
function sameSite(uri, browser) {
  const siteOf = principal => {
    if (principal?.isNullPrincipal) {
      principal = principal.precursorPrincipal;
    }
    return principal?.isContentPrincipal ? principal.siteOriginNoSuffix : null;
  };
  const ssm = Services.scriptSecurityManager;
  try {
    const target = siteOf(ssm.createContentPrincipal(uri, {}));
    if (!target) {
      return false;
    }
    if (target === siteOf(browser.browsingContext?.currentWindowGlobal?.documentPrincipal ?? null)) {
      return true;
    }
    return !!browser.currentURI && target === siteOf(ssm.createContentPrincipal(browser.currentURI, {}));
  } catch {
    return false;
  }
}

async function navigate(ctx, params, method) {
  const isGoto = method === "page.goto";
  const { browser, page, space } = ctx.resolvePage(params);
  markUsed(page);
  const options = params.options ?? {};
  const timeoutMs = timeoutOption(options, GOTO_TIMEOUT_MS);
  const waitUntil = options.waitUntil ?? "load";
  if (!WAIT_UNTIL.includes(waitUntil)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `${method} waitUntil must be one of ${WAIT_UNTIL.join(", ")}`);
  }
  if (isGoto && (typeof params.url !== "string" || !params.url)) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", "page URL must be a non-empty string");
  }
  let uri;
  try {
    uri = isGoto ? Services.io.newURI(params.url) : browser.currentURI;
  } catch {
    throw msg.navigationFailed(method, "Cannot navigate to invalid URL", { url: params.url });
  }
  // I5: only web URLs, whoever put the current one in the tab.
  checkAgentLoad(uri, method);
  // The user's page-code setting: under "never", not the agent's own page.
  checkOwnPageLoad({ method, page, uri });
  // Nor the local network: the parent would cancel the load anyway.
  const local = agentLoadRefusal(uri);
  if (local) {
    throw msg.navigationFailed(method, local, { url: uri.spec, error: "localNetwork" });
  }
  // Closed groups (item 1, decision 2): in a page that shares a window group
  // with a window outside the task, the agent's own page (data:, blob:)
  // doesn't load, nor does another site, whose code could reach that
  // window. The page's site and about:blank still do. Asked only while the
  // page shows a document in a web content process: from an add-on's or the
  // browser's own page, a load to the web lands in a new group
  // (inWebProcess), and an answer there would stick.
  const refusal = inWebProcess(browser.browsingContext) ? ctx.pages.codeRefusal(space, page) : null;
  if (refusal) {
    if (uri.scheme === "data" || uri.scheme === "blob") {
      throw msg.agentCodeRefused(method, page.label, refusal, "agentPage");
    }
    if ((uri.scheme === "http" || uri.scheme === "https") && !sameSite(uri, browser)) {
      throw msg.agentCodeRefused(method, page.label, refusal, "site");
    }
  }
  let referrerInfo;
  if (isGoto && options.referer !== undefined) {
    if (typeof options.referer !== "string" || !options.referer) {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "page.goto referer must be a non-empty string");
    }
    referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
    referrerInfo.init(Ci.nsIReferrerInfo.UNSAFE_URL, true, Services.io.newURI(options.referer));
  }

  const nav = trackerFor(browser);
  prepareBrowser(browser);
  // A hidden agent tab is muted before its new page can play anything.
  syncAudio(browser);
  const deadline = ChromeUtils.now() + timeoutMs;
  const watch = follow(nav, uri.spec);
  const dialogs = watchDialogs(browser);
  const refusals = watchRefusals(browser);
  const popups = ctx.watchPopups(space.id, page.label);
  let downloaded = false;
  let sawDownload;
  const downloadSeen = new Promise(resolve => (sawDownload = resolve));
  const offDownload = onDownload(entry => {
    if (entry.browserId === browser.browserId) {
      downloaded = true;
      sawDownload();
    }
  });
  // Firefox's question before a reload sends a form again: answered Cancel
  // (observe/dialogs.sys.mjs), the reload never starts.
  const dialogOpened = dialogs.opened.then(() => ({ interrupted: "dialog" }));
  const question = refusals.first("browserConfirmation").then(r => ({ interrupted: "question", refused: r }));
  const interrupt = Promise.race([dialogOpened, question]);
  const receipt = () => {
    const opened = popups.stop();
    for (const p of opened) {
      markUsed(ctx.pages.peek(space.id, p.label));
    }
    const out = opened.length ? { popups: opened } : {};
    // What zenius refused on the way (an HTTP sign-in, a print dialog).
    const refused = refusals.stop();
    if (refused.length) {
      out.refused = refused;
    }
    return out;
  };
  try {
    resetQuiet(browser.browserId);
    // A data: page's reload below is a load of its URL, which stays in the
    // document when the URL has a fragment, as a goto's may.
    nav.markPending(uri.spec, { reload: !isGoto && uri.scheme !== "data" });
    if (isGoto) {
      // Never the system principal: Firefox's own load checks apply, as for
      // a page's links (observe/webcontent.sys.mjs).
      browser.loadURI(uri, {
        ...agentLoadOptions(uri, browser),
        ...(referrerInfo ? { referrerInfo } : {}),
      });
    } else if (uri.scheme === "data") {
      // Firefox refuses a top-level data: reload that the system principal
      // didn't start (NS_ERROR_DOM_BAD_URI). The same URL loaded in place of
      // the current entry is the same document, as Ego's reload gives.
      const { triggeringPrincipal, loadFlags } = agentLoadOptions(uri, browser);
      browser.loadURI(uri, { triggeringPrincipal, loadFlags: loadFlags | Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY });
    } else {
      browser.reload();
    }

    let settled = await untilCommitted(watch, deadline, interrupt);
    if (settled?.interrupted === "question") {
      if (!watch.state.started) {
        nav.pending = null;
        throw msg.navigationFailed(method, settled.refused.message, { url: uri.spec, refused: [settled.refused] });
      }
      // A question about something else while the load goes on.
      settled = await untilCommitted(watch, deadline, dialogOpened);
    }
    if (settled?.interrupted === "dialog") {
      // A dialog (beforeunload, or an alert while loading) holds the
      // navigation. Report it, as Ego's action boundary does; the agent
      // answers it and continues.
      if (!watch.state.started) {
        nav.pending = null;
      }
      return { dialog: dialogs.stop() };
    }
    if (!settled) {
      log(`${method} to ${uri.spec} did not commit; recent events: ${JSON.stringify(nav.history.slice(-12))}`);
      nav.stop();
      if (isGoto) {
        throw msg.gotoTimeout({ timeoutMs, waitUntil, committed: false, stopped: true, requestedUrl: uri.spec });
      }
      throw msg.reloadTimeout({ timeoutMs, waitUntil, committed: false, stopped: true });
    }
    const { committed, ended } = watch.state;
    if (!committed) {
      nav.pending = null;
      // The Download object is created a little after the navigation stops
      // (DownloadIntegration is async); a 204 or 205 is never a download.
      // A stop with NS_OK and no response status is a load handed to the
      // download manager, whose Download may come after the stop.
      const maybeDownload = ended.httpStatus ? ended.httpStatus !== 204 && ended.httpStatus !== 205 : ended.status === 0;
      if (!downloaded && maybeDownload) {
        await beforeDeadline(downloadSeen, Math.min(deadline, ChromeUtils.now() + DOWNLOAD_GRACE_MS));
      }
      if (downloaded) {
        throw msg.navigationFailed(method, "navigation started a download", { url: uri.spec });
      }
      // zenius refused where it led (an add-on install): say so.
      const refused = refusals.seen;
      if (refused.length) {
        throw msg.navigationFailed(method, refused.map(r => r.message).join(" "), { url: uri.spec, refused: [...refused] });
      }
      // A TLS error stops the load, and then Firefox's warning page commits
      // under the site's URL.
      const tls = Components.isSuccessCode(ended.status) ? null : securityError(ended.status);
      if (tls) {
        await untilErrorPage(watch, Math.min(deadline, ChromeUtils.now() + ERROR_PAGE_GRACE_MS));
        if (tls.certificate) {
          throw certificateWarning(method, uri, tls.name);
        }
        throw msg.navigationFailed(method, "net::ERR_SSL_PROTOCOL_ERROR", { url: uri.spec, error: tls.name });
      }
      // Chromium reports a navigation that ends without a document (a 204,
      // or one something else stopped) as aborted.
      const name = Components.isSuccessCode(ended.status) ? "NS_BINDING_ABORTED" : ChromeUtils.getXPCOMErrorName(ended.status);
      if (name === "NS_ERROR_LOCAL_NETWORK_ACCESS_DENIED") {
        throw msg.navigationFailed(method, LOCAL_NETWORK_DENIED, { url: uri.spec, error: name });
      }
      throw msg.navigationFailed(method, NET_STATUS[name] ?? name, { url: uri.spec, error: name });
    }
    // A data: or blob: page is the agent's own code, as page.evaluate's is
    // (user-tab-reach.md, Fix, item 1): mark the document it committed, a
    // reload's too. pages.new with a url comes here through page.goto.
    if (!committed.sameDocument && !committed.errorPage && (uri.scheme === "data" || uri.scheme === "blob")) {
      noteAgentCode(space, browser.browsingContext);
      noteMade(browser.browsingContext);
    }
    if (committed.errorPage) {
      if (browser.documentURI?.spec.startsWith("about:certerror")) {
        const nss = await ctx.content(browser.browsingContext, "nav#certificateError", {}, { timeout: 1000 }).catch(() => null);
        throw certificateWarning(method, uri, nss);
      }
      const code = errorPageCode(browser) ?? "unknown";
      throw msg.navigationFailed(method, NET_ERRORS[code] ?? code, { url: uri.spec, error: code });
    }
    if (waitUntil === "commit" && !committed.sameDocument && !committed.errorPage) {
      // Chromium hands the renderer the first chunk with the commit, so
      // Ego's next call sees its inline scripts' work. Gecko commits before
      // parsing, so wait briefly for the first chunk too. A document without
      // a declared charset isn't parsed before 1024 bytes or its end
      // (encoding prescan), hence the cap: commit mustn't turn into load.
      try {
        await ctx.content(browser.browsingContext, "nav#firstChunk", {
          timeoutMs: Math.max(0, Math.min(FIRST_CHUNK_MS, deadline - ChromeUtils.now())),
        });
      } catch {}
    }
    if (waitUntil !== "commit" && !committed.sameDocument) {
      const r = await Promise.race([untilLoadState(ctx, browser, waitUntil, deadline), dialogOpened]);
      if (r?.interrupted) {
        return { dialog: dialogs.stop() };
      }
      if (!r.reached) {
        if (isGoto) {
          throw msg.gotoTimeout({
            timeoutMs,
            waitUntil,
            committed: true,
            stopped: false,
            url: nav.currentURL,
            readyState: r.readyState,
          });
        }
        throw msg.reloadTimeout({ timeoutMs, waitUntil, committed: true, stopped: false });
      }
    }
    return receipt();
  } finally {
    watch.off();
    dialogs.stop();
    refusals.stop();
    popups.stop();
    offDownload();
  }
}

// ---------------------------------------------------------------------------
// The page gate (docs/SPI.md "Dispatch"): zen-core's dispatcher runs it after
// the ownership gate for every page.* method.

/**
 * Methods that never wait for a pending navigation or fail for a dialog:
 * navigation itself, what the parent answers alone, and waiters that must be
 * armed before the next frame's action runs. Exported for the registry test,
 * which fails for a name here that no method has.
 */
export const UNGATED = new Set([
  "page.goto",
  "page.reload",
  "page.events",
  "page.waitForURL",
  "page.waitForLoadState",
  "page.waitForEvent",
  "page.acceptDialog",
  "page.dismissDialog",
]);

/**
 * Ego drops raw input silently while a dialog is open (#runRawAction), so
 * the dialog check leaves these to their handler, which skips sending.
 */
const RAW_INPUT = /^page\.(mouse|keyboard)(\.|$)/;

/**
 * Reads: an open dialog doesn't fail them (the URL and title don't change
 * under it, and info reports it), but a pending navigation holds them like
 * any call, so they answer from the document the agent's action led to: Ego
 * reads them in the renderer, which answers nothing until the commit.
 */
const READS = new Set(["page.url", "page.title", "page.info"]);

/**
 * Waits that poll the page themselves: they run on whatever document the tab
 * shows and follow it through a commit, so they don't wait for a pending
 * navigation here (their own timeout bounds them). A dialog still fails them.
 */
const POLLING = new Set(["page.waitForFunction", "page.waitForSelector"]);

/**
 * Plain function: returns nothing when the page is ready, a promise only
 * when it must wait (so handlers start in frame order).
 */
export function pageReadyGate(ctx, params, method) {
  const { browser, page } = ctx.resolvePage(params);
  markUsed(page);
  if (UNGATED.has(method)) {
    return undefined;
  }
  // The SDK's waitForURL(predicate) polls the URL with this: it must never
  // wait, or its own wait would stop a slow navigation it is waiting for.
  if (method === "page.url" && params.poll === true) {
    return undefined;
  }
  prepareBrowser(browser);
  const dialog = currentDialog(browser);
  if (dialog && READS.has(method)) {
    return undefined;
  }
  if (dialog && !RAW_INPUT.test(method)) {
    throw msg.dialogOpened({ method, dialog });
  }
  const nav = trackerFor(browser);
  if (nav.awaitingFirstStart()) {
    // A popup moments old: its first navigation is about to start.
    return nav.firstStart().then(() =>
      nav.pending && !POLLING.has(method) ? waitForPendingNavigation(params, method, nav, page.label) : undefined
    );
  }
  if (!nav.pending || POLLING.has(method)) {
    return undefined;
  }
  return waitForPendingNavigation(params, method, nav, page.label);
}

/**
 * Ego's one bounded wait: Chromium answers nothing while a main-frame
 * navigation is pending, so Ego waits one response timeout, stops the
 * navigation and says what the Page shows. Gecko would answer from the old
 * document; waiting for the commit gives the agent the document it asked
 * for, and the stop keeps Ego's outcome when it never comes.
 */
async function waitForPendingNavigation(params, method, nav, label) {
  const ms = responseTimeout(params);
  if (await nav.waitUntilSettled(ms)) {
    return;
  }
  nav.stop();
  const url = nav.currentURL;
  if (method === "page.evaluate") {
    throw msg.evaluationPendingNavigation({ apiName: method, label, timeoutMs: ms, url });
  }
  throw msg.pageUnresponsive({ label, url, method, waitedMs: ms });
}

/**
 * I5 (SPEC §3.9): a method that acts in or reads the document runs only in
 * web content (observe/webcontent.sys.mjs). It runs after pageReadyGate, so
 * it checks the document a pending navigation leads to.
 */
export function webContentGate(ctx, params, method) {
  // The method's declared I5 class, from zen-core's dispatch (ctx.i5); a ctx
  // without one goes by the method's name.
  if ((ctx.i5 ?? (OUTSIDE_DOCUMENT.has(method) ? "outside" : "document")) === "outside") {
    return undefined;
  }
  const { browser, page } = ctx.resolvePage(params);
  checkWebContent(browser, { method, label: page.label });
  return undefined;
}

export const pageGates = [pageReadyGate, webContentGate];

// ---------------------------------------------------------------------------
// Methods

// Gate classes (docs/research/method-boundary.md): access for the control
// gate (I3), i5 for the web-content gate (I5).
export const access = {
  "page.goto": "mutate",
  "page.reload": "mutate",
  "page.url": "read",
  "page.title": "read",
  "page.waitForLoadState": "read",
  "page.waitForURL": "read",
  "page.waitForEvent": "read",
};

export const i5 = {
  "page.goto": "outside",
  "page.reload": "outside",
  "page.url": "outside",
  "page.title": "document",
  "page.waitForLoadState": "outside",
  "page.waitForURL": "outside",
  "page.waitForEvent": "outside",
};

export const methods = {
  "page.goto": (ctx, params) => navigate(ctx, params, "page.goto"),

  "page.reload": (ctx, params) => navigate(ctx, params, "page.reload"),

  // Both run after the page gate, which waits for a pending navigation, so
  // they read the document the tab shows now, as Ego's location.href and
  // document.title do (a fresh popup's first navigation included).
  "page.url": (ctx, params) => {
    const { browser, page } = ctx.resolvePage(params);
    markUsed(page);
    return browser.currentURI?.spec ?? "";
  },

  "page.title": async (ctx, params) => {
    const { browser, browsingContext, page } = ctx.resolvePage(params);
    markUsed(page);
    // The parent's copy of the title lags a fresh commit (it comes with
    // DOMTitleChanged), and right after a click it's what the agent reads.
    // Under a dialog the page answers nothing; its title is settled there.
    if (currentDialog(browser)) {
      return browser.contentTitle ?? "";
    }
    try {
      const state = await ctx.content(browsingContext, "nav#documentState", {}, { timeout: responseTimeout(params) });
      return state?.title ?? "";
    } catch (e) {
      if (e?.data?.reason) {
        return browser.contentTitle ?? "";
      }
      throw e;
    }
  },

  "page.waitForLoadState": async (ctx, params) => {
    const { browser, page } = ctx.resolvePage(params);
    markUsed(page);
    const state = params.state ?? "load";
    if (!LOAD_STATES.has(state)) {
      throw new ZenError(
        "ZEN_INVALID_ARGUMENT",
        'page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"'
      );
    }
    const timeoutMs = timeoutOption(params.options, WAIT_TIMEOUT_MS);
    const idleMs = timeoutOption(params.options, NETWORK_IDLE_MS, "idleMs");
    const dialog = currentDialog(browser);
    if (dialog) {
      throw msg.dialogOpened({ method: "page.waitForLoadState", dialog });
    }
    const r = await untilLoadState(ctx, browser, state, ChromeUtils.now() + timeoutMs, { idleMs });
    if (!r.reached) {
      throw msg.loadStateTimeout({ state, timeoutMs, inflight: inflight(browser.browserId) });
    }
  },

  "page.waitForURL": async (ctx, params) => {
    const { browser, page } = ctx.resolvePage(params);
    markUsed(page);
    const matcher = compileMatcher(params.matcher);
    const timeoutMs = timeoutOption(params.options, WAIT_TIMEOUT_MS);
    const deadline = ChromeUtils.now() + timeoutMs;
    const nav = trackerFor(browser);
    let wake = null;
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const offNav = nav.listen(poke);
    // Popups' URLs change without events on this tab; poll them as Ego does.
    const ticker = setInterval(poke, 100);
    try {
      for (;;) {
        const url = nav.currentURL;
        if (matcher.test(url)) {
          return;
        }
        // Ego's matchingPopupWaitError: the URL opened in a popup of this
        // page that the agent hasn't used, maybe before this call.
        const popup = unhandledPopups(ctx, page).find(p => matcher.test(p.url));
        if (popup) {
          throw msg.urlOpenedInPopup({ opener: page.label, lastUrl: url, popup: popup.label, popupUrl: popup.url });
        }
        if ((await beforeDeadline(new Promise(resolve => (wake = resolve)), deadline)) === TIMEOUT) {
          throw msg.urlTimeout({ timeoutMs, description: matcher.description, lastUrl: nav.currentURL });
        }
      }
    } finally {
      offNav();
      clearInterval(ticker);
    }
  },

  "page.waitForEvent": (ctx, params) => {
    // Everything up to the first await runs as the frame arrives: the SDK
    // sends this wait before the action that triggers the event.
    const { browser, page, space } = ctx.resolvePage(params);
    markUsed(page);
    const event = params.event;
    if (event === "filechooser") {
      // zen-input's chooser interception (the SDK's page.waitForFileChooser),
      // armed here before the next frame's action runs.
      const { waitForChooser } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/input/filechooser.sys.mjs");
      return waitForChooser(browser, timeoutOption(params.options, WAIT_TIMEOUT_MS), ctx.conn);
    }
    if (event !== "popup" && event !== "download") {
      throw new ZenError("ZEN_INVALID_ARGUMENT", "page.waitForEvent only supports the popup and download events");
    }
    const timeoutMs = timeoutOption(params.options, WAIT_TIMEOUT_MS);
    if (event === "download") {
      prepareBrowser(browser);
      const w = waitForDownload(browser.browserId, timeoutMs);
      return w.promise.then(entry => {
        if (!entry) {
          throw msg.eventTimeout({ event, timeoutMs });
        }
        if (entry.refused) {
          throw msg.downloadFailed(entry.refused, { refused: true });
        }
        claimDownload(entry, ctx.conn);
        return { download: entry.id, url: entry.url, suggestedFilename: entry.suggestedFilename };
      });
    }
    return new Promise((resolve, reject) => {
      const off = ctx.service.addEventListener((name, p) => {
        if (name === "popup" && p.space === space.id && p.opener === page.label) {
          finish();
          const popup = ctx.pages.peek(space.id, p.page);
          markUsed(popup);
          // Return once its first navigation has started, as a Chromium
          // target is attached with it pending: the Page reads as its URL.
          const popupBrowser = popup ? ctx.pages.tabFor(popup)?.linkedBrowser : null;
          const settled = popupBrowser ? settleFreshPopup(popupBrowser) : Promise.resolve();
          settled.then(() => resolve({ label: p.page, openedBy: page.label, targetId: p.tab }));
        }
      });
      const timer = setTimeout(() => {
        finish();
        reject(msg.eventTimeout({ event, timeoutMs }));
      }, timeoutMs);
      const finish = () => {
        off();
        clearTimeout(timer);
      };
    });
  },
};

/** The SDK's URL matcher: a glob compiled to `regex` (anchored), or a RegExp (unanchored). */
function compileMatcher(m) {
  let re;
  let description;
  try {
    if (m?.type === "glob" && typeof m.regex === "string") {
      re = new RegExp(m.regex);
      description = JSON.stringify(m.value ?? m.regex);
    } else if (m?.type === "regex" && typeof m.value === "string") {
      const flags = typeof m.flags === "string" ? m.flags : "";
      re = new RegExp(m.value, flags);
      description = re.toString();
    } else if (m?.type === "string" && typeof m.value === "string") {
      return { test: url => url === m.value, description: JSON.stringify(m.value) };
    }
  } catch (e) {
    throw new ZenError("ZEN_INVALID_ARGUMENT", `page.waitForURL matcher is not a valid pattern: ${e.message}`);
  }
  if (!re) {
    throw new ZenError(
      "ZEN_INVALID_ARGUMENT",
      'page.waitForURL needs matcher {type: "glob", value, regex} or {type: "regex", value, flags}'
    );
  }
  return {
    test(url) {
      re.lastIndex = 0;
      return re.test(url);
    },
    description,
  };
}

