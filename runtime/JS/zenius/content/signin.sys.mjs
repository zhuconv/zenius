// The two sign-in rules: pages that stay the user's, whoever drives the tab.
//
// 1. A sign-in result. A document whose URL carries an OAuth authorization
//    response, or whose referrer did, is off-limits to agent methods: no
//    reading and no acting there. An agent that opened an authorize link
//    with its own PKCE verifier would otherwise read the code after the
//    user's approval, and with its verifier that is the user's account.
//    `state` doesn't matter: it is optional in OAuth, and the agent writes
//    the authorize request. An access_token or id_token counts at any
//    length, in the query too: OAuth puts them in the fragment, but a
//    provider could put them in the query. A `code` counts from 16
//    characters (RFC 6749 10.10 asks for codes that are hard to guess;
//    GitHub's 20 hex characters are the shortest known), so product and
//    promo pages with a short `?code=` stay readable. The provider makes
//    the code, so the agent can't shorten it.
// 2. A device-login page. On a major provider's page for typing a device
//    code, agents may read but not act, so an attacker's code can't be typed
//    or clicked through (device-code phishing).
//
// Both refuse with ZEN_SIGN_IN_PAGE. Wherever such a URL travels to the
// agent (lists, events, headers, titles, errors), the socket cuts it to its
// scheme, host and path (redactText).
//
// A leaf that imports nothing: the parent (the socket's redaction, the
// methods' checks) and the Zenius actor in a task's documents both load it.
// A user's document never does (I4).

/** The shortest value of `code` that counts as an authorization code. */
const MIN_CODE_LENGTH = 16;
/** The tokens of the implicit and hybrid flows (RFC 6749 4.2.2, OIDC): any length counts, in a fragment or a query. */
const TOKEN_KEYS = ["access_token", "id_token"];

/**
 * Device-login pages: a host, and a path prefix of whole segments (`/device`
 * and `/device/...`, not `/devices`), or a host alone. The list holds each
 * provider's own addresses and where they land: microsoft.com/devicelogin,
 * aka.ms/devicelogin and login.microsoft.com/device land on
 * login.microsoftonline.com's deviceauth (Microsoft's other work and
 * school sign-in hosts serve it too), microsoft.com/link on its personal
 * accounts' device page at login.live.com, and google.com/device on
 * accounts.google.com's usercode page. Pages are added on evidence.
 */
const MICROSOFT = "Microsoft's device sign-in page";
// Microsoft's work and school sign-in hosts, which serve the same pages.
const MICROSOFT_LOGIN = /^login\.(?:microsoftonline\.com|microsoft\.com|windows\.net)$/;
const GOOGLE = "Google's device sign-in page";
const DEVICE_PAGES = [
  { host: /^github\.com$/, path: "/login/device", label: "GitHub's device sign-in page" },
  { host: /^(?:www\.)?microsoft\.com$/, path: "/devicelogin", label: MICROSOFT },
  { host: /^(?:www\.)?microsoft\.com$/, path: "/link", label: MICROSOFT },
  { host: /^login\.microsoft\.com$/, path: "/device", label: MICROSOFT },
  { host: /^aka\.ms$/, path: "/devicelogin", label: MICROSOFT },
  { host: MICROSOFT_LOGIN, path: /^\/[^/]+\/oauth2(?:\/v2\.0)?\/deviceauth(?:\/|$)/, label: MICROSOFT },
  { host: /^login\.live\.com$/, path: "/oauth20_remoteconnect.srf", label: MICROSOFT },
  { host: /^(?:www\.)?google\.com$/, path: "/device", label: GOOGLE },
  { host: /^accounts\.google\.com$/, path: "/device", label: GOOGLE },
  { host: /^accounts\.google\.com$/, path: "/o/oauth2/device/usercode", label: GOOGLE },
  { host: /^(?:www\.)?facebook\.com$/, path: "/device", label: "Facebook's device sign-in page" },
  { host: /^(?:www\.)?twitch\.tv$/, path: "/activate", label: "Twitch's device sign-in page" },
];

/** Does `path` (normalPath's) start with `prefix` by whole segments? "/" matches every path. */
function underPath(path, prefix) {
  if (typeof prefix !== "string") {
    return prefix.test(path);
  }
  if (prefix === "/") {
    return true;
  }
  return path === prefix || path === `${prefix}/` || path.startsWith(`${prefix}/`);
}

/**
 * A path as the list matches it: each escape of an ASCII character decoded
 * on its own, so a malformed one elsewhere in the path doesn't keep the
 * rest encoded, and again while that changes it, up to three passes, for a
 * path encoded more than once; then runs of "/" collapsed, and lower case.
 * Providers serve a device page under all of these spellings
 * (/common/OAUTH2/DEVICEAUTH, /common/oauth2/%64eviceauth,
 * //common/oauth2/deviceauth). Decoding can only add matches, which refuse
 * acting on that page and nothing more. The list's paths are ASCII, so
 * other escapes can't make one.
 */
function normalPath(pathname) {
  let path = pathname;
  for (let pass = 0; pass < 3; pass++) {
    const decoded = path.replace(/%[0-7][0-9a-f]/gi, escape => String.fromCharCode(parseInt(escape.slice(1), 16)));
    if (decoded === path) {
      break;
    }
    path = decoded;
  }
  return path.replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * sharedData: the tests' extra device-login pages, as URL prefixes. The
 * parent publishes it only in a dev launcher's profile (zenius.dev with
 * devMode()), from pref zenius.signIn.devicePages.
 */
export const DEVICE_PAGES_KEY = "zenius:signInDevicePages";

/**
 * sharedData: the sign-in pages the Zenius actor found, published by the
 * parent (observe/signin.sys.mjs): a Map of innerWindowId to {reason,
 * page}. A frame's process reads its top document's flag here when that
 * document is in another process.
 */
export const SIGN_IN_DOCS_KEY = "zenius:signInDocs";

/** The reasons a document is a sign-in page: ZEN_SIGN_IN_PAGE's data.reason. */
export const SIGN_IN_REASONS = Object.freeze(["authorization_response", "device_login"]);

/**
 * How the sign-in rules check agent method calls, by the method's declared
 * classes (SPI.md, "Dispatch"): "read" or "act" for a method that reads or
 * acts in documents (I5 class document or frames; act when its access is
 * mutate, page.evaluate and page.fetch among them), null for the rest. A
 * sign-in result refuses reads and acts; a device-login page refuses acts.
 * Navigation (class outside), the hand-off and closing (class none) stay
 * open on both, and a method added later is covered by its classes.
 *
 * @param {string|null} i5
 * @param {string} access
 * @returns {"read"|"act"|null}
 */
export function signInGateFor(i5, access) {
  if (i5 !== "document" && i5 !== "frames") {
    return null;
  }
  return access === "mutate" ? "act" : "read";
}

/**
 * ZEN_SIGN_IN_PAGE's message and data for agent method `method` refused on
 * a page with sign-in flag `flag`. The callers make the error: this leaf
 * imports nothing.
 *
 * @param {string} method
 * @param {{reason: string, page: string}} flag
 * @param {boolean} [frame]  the call was for a frame of the flagged page
 * @returns {{message: string, data: object}}
 */
export function signInRefusal(method, flag, frame = false) {
  const where = `${frame ? "a frame of " : ""}${flag.page}`;
  const data = { reason: flag.reason, page: flag.page, method };
  if (frame) {
    data.frame = true;
  }
  if (flag.reason === "device_login") {
    return {
      message: `${method} refused: this is ${where}, where only the user types a device code and approves it. Reading the page, going elsewhere and handing it to the user (task.handOff()) still work.`,
      data,
    };
  }
  return {
    message: `${method} refused: this is ${where}. Its address or referrer carries the code of a sign-in, so only the user reads or acts there. Hand the page to the user (task.handOff()), or go to the app's own URL again.`,
    data,
  };
}

/** A URL object for `url` (a string, nsIURI or URL), or null. */
function parse(url) {
  try {
    if (typeof url === "string") {
      return new URL(url);
    }
    if (url && typeof url.spec === "string") {
      return new URL(url.spec);
    }
    if (url instanceof URL) {
      return url;
    }
  } catch {}
  return null;
}

/**
 * Does `part` (a query or fragment, without its ? or #) carry a response:
 * a `code` of at least MIN_CODE_LENGTH characters, or an access_token or
 * id_token of any length?
 */
function carries(part) {
  if (!part || !(part.includes("code") || part.includes("_token"))) {
    return false;
  }
  try {
    for (const [key, value] of new URLSearchParams(part)) {
      if (key === "code" ? value.length >= MIN_CODE_LENGTH : value && TOKEN_KEYS.includes(key)) {
        return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Does the URL carry an authorization response: a `code`, `access_token` or
 * `id_token` in its query or its fragment (see carries)? A fragment that
 * holds a route and its own query (`#/cb?code=...`, as a
 * hash router reads it) counts too. Any scheme: a native app's redirect
 * (`com.example.app:/cb?code=...`, RFC 8252 7.1) carries one as well.
 *
 * @param {string|nsIURI|URL} url
 */
export function carriesAuthorizationResponse(url) {
  const u = parse(url);
  if (!u) {
    return false;
  }
  if (carries(u.search.slice(1))) {
    return true;
  }
  const hash = u.hash.slice(1);
  if (!hash) {
    return false;
  }
  if (carries(hash)) {
    return true;
  }
  const q = hash.indexOf("?");
  return q !== -1 && carries(hash.slice(q + 1));
}

/**
 * The URL without its query and fragment: what the agent sees of a URL
 * that carries an authorization response. The text is cut as it is, not
 * normalized, so the rest of what the agent reads stays the same.
 *
 * @param {string|nsIURI|URL} url
 * @returns {string}
 */
export function cutURL(url) {
  const text = typeof url === "string" ? url : String(url?.spec ?? url?.href ?? "");
  return text.replace(/[?#][\s\S]*$/, "");
}

/**
 * The device-login page `url` is, by its label, or null. `extra` holds the
 * tests' URL prefixes (DEVICE_PAGES_KEY).
 *
 * @param {string|nsIURI|URL} url
 * @param {string[]} [extra]
 * @returns {string|null}
 */
export function deviceLoginPage(url, extra = []) {
  const u = parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
    return null;
  }
  if (u.protocol === "https:" && !u.port) {
    // One trailing dot names the same host (github.com.).
    const host = u.hostname.replace(/\.$/, "");
    const path = normalPath(u.pathname);
    for (const page of DEVICE_PAGES) {
      if (page.host.test(host) && underPath(path, page.path)) {
        return page.label;
      }
    }
  }
  for (const prefix of extra) {
    if (typeof prefix === "string" && prefix && u.href.startsWith(prefix)) {
      return "a device sign-in page";
    }
  }
  return null;
}

/**
 * Why a document that loaded `url`, with `referrer`, is a sign-in page, or
 * null. Only http(s) documents count: no other scheme loads a document an
 * agent can reach.
 *
 * @param {string|nsIURI|URL} url  the document's URL at load: its channel's, after redirects
 * @param {string} [referrer]  document.referrer at load
 * @param {string[]} [extra]  the tests' device-login prefixes
 * @returns {{reason: "authorization_response"|"device_login", page: string}|null}
 */
export function signInPageOf(url, referrer = "", extra = []) {
  const u = parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
    return null;
  }
  if (carriesAuthorizationResponse(u)) {
    return { reason: "authorization_response", page: "a sign-in result" };
  }
  // On a same-origin redirect Firefox sends the full URL as the referrer:
  // the page after the callback carries the code in document.referrer.
  if (referrer && carriesAuthorizationResponse(referrer)) {
    return { reason: "authorization_response", page: "the page right after a sign-in result" };
  }
  const device = deviceLoginPage(u, extra);
  return device ? { reason: "device_login", page: device } : null;
}

// URLs in a frame's JSON text: a scheme, then anything up to a quote,
// backslash (an escape), space or angle bracket. Cheap to find, and each
// candidate is parsed before anything is cut.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,31}:[^\s"'<>\\`]+/gi;
// A URL that starts inside another one, unencoded (`?next=https://...`).
const INNER_URL = /[=?&#/]([a-z][a-z0-9+.-]{1,31}:)/gi;
// What a response's URL has to contain, checked first so most frames cost
// one scan: code=, access_token= or id_token=, or the same with its = encoded.
const RESPONSE_HINT = /(?:code|access_token|id_token)(?:=|%3[dD])/;

/**
 * Does `candidate` carry an authorization response, or hold a URL that
 * does: one that starts inside it unencoded, or one percent-encoded in a
 * parameter, as Firefox's error page holds the address that failed to load
 * (`about:neterror?e=connectionFailure&u=http%3A//localhost...`). One level
 * of encoding only.
 *
 * @param {string} candidate
 * @param {boolean} [decoded]  a parameter's value already decoded once
 */
function carriesAnywhere(candidate, decoded = false) {
  if (carriesAuthorizationResponse(candidate)) {
    return true;
  }
  for (const m of candidate.matchAll(INNER_URL)) {
    if (carriesAuthorizationResponse(candidate.slice(m.index + 1))) {
      return true;
    }
  }
  if (decoded || !/%3[dD]/.test(candidate)) {
    return false;
  }
  const u = parse(candidate);
  for (const part of u ? [u.search.slice(1), u.hash.slice(1)] : []) {
    try {
      for (const [, value] of new URLSearchParams(part)) {
        if (value.includes(":") && RESPONSE_HINT.test(value) && carriesAnywhere(value, true)) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * `text` with every URL that carries an authorization response, or holds
 * one (carriesAnywhere), cut at its query (cutURL). The socket runs it on
 * each frame's JSON text, results and events alike: the callback's URL also
 * travels as a Referer header, a Location header, the next page's referrer,
 * a download's URL, an error page's address and in titles.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== "string" || !RESPONSE_HINT.test(text)) {
    return text;
  }
  return text.replace(URL_IN_TEXT, match => (RESPONSE_HINT.test(match) && carriesAnywhere(match) ? cutURL(match) : match));
}

// A token in a header value that could be a URL reference: no space,
// quote, angle bracket, semicolon, comma or backslash.
const REFERENCE = /[^\s<>"'`;,\\]+/g;

/**
 * `value` (an HTTP header's) with every URL reference in it that carries an
 * authorization response cut at its query, a relative one included: a
 * Location of `/cb?code=...`, a Refresh's `url=...`, a Link's `<...>`.
 * Each is resolved against `base`, the request's URL. The socket's
 * redaction (redactText) finds only absolute URLs.
 *
 * @param {string} value
 * @param {string} base
 * @returns {string}
 */
export function redactReferences(value, base) {
  if (typeof value !== "string" || !RESPONSE_HINT.test(value)) {
    return value;
  }
  return value.replace(REFERENCE, token => {
    if (!RESPONSE_HINT.test(token) || !/[?#]/.test(token)) {
      return token;
    }
    const ref = token.replace(/^url=/i, "");
    let resolved;
    try {
      resolved = new URL(ref, base).href;
    } catch {
      return token;
    }
    return carriesAnywhere(resolved) || carriesAnywhere(ref) ? cutURL(token) : token;
  });
}
