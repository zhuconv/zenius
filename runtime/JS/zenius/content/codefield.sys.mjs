// Code fields: where a sign-in asks for a one-time code (the sign-in rules'
// code measure: content/signinguard.sys.mjs refuseCodeEntry, the parent's
// check in input/codes.sys.mjs). A phishing kit clones or proxies the real
// sign-in, so its field is marked however the real site marks it:
// - the autocomplete token one-time-code;
// - one of several one-character inputs side by side: a code split by digit;
// - a field whose name, id, label or placeholder asks for a code in the
//   words the sidebar's ask checks for (agent-sidebar/AgentService.sys.mjs
//   CREDENTIAL_WORDS), less a password's, a PIN's and a card's, or says
//   just "Code" or "Enter the code", as its CODE_HEADER takes a question
//   headed "Code". A promo, coupon, gift, discount, referral, postal or zip
//   code never counts, nor a card's security code: a field that says card,
//   CVV, CVC or CSC, or whose own autocomplete token, or a field's in its
//   form, is a card's. Form autofill's heuristics aren't asked: they take a
//   field labelled "Verification code" for a card's.
// A custom page's unlabelled plain field gets past (potential-issues.md).

/** Inputs a code is typed into. */
const CODE_TYPES = new Set(["text", "tel", "number", "password", "search"]);
/** How many one-character inputs side by side make a split code. */
const SPLIT_MIN = 4;
/** How far up a split code's boxes may share an ancestor. */
const SPLIT_LEVELS = 3;
/** Each text read of a field, at most. */
const TEXT_MAX = 200;

/**
 * Words that ask for a one-time code, as a field's name, id, label or
 * placeholder says it: "Verification code", "Enter the 6-digit code",
 * otp, mfaCode, sms_code, "One-time password", 验证码.
 */
const CODE_WORDS = [
  /\b(?:otps?|totp|passcodes?|one[- ]?time[- ]?(?:codes?|pass(?:words?|codes?)|pins?|keys?)|(?:verification|verify|security|authentication|auth|confirmation|access|sign[- ]?in|log[- ]?in|login|2fa|mfa|two[- ]?factor|(?:2|two)[- ]?step|sms|text|e-?mail|authenticator)[- ]?codes?|2fa|mfa|two[- ]?factor|(?:2|two)[- ]?step[- ]?verification)\b/i,
  // A code by its digits, at any count; a number only at a code's, so a
  // phone's "10-digit number" or a card's "16-digit number" isn't one.
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]?digits?[- ]?codes?\b|\b(?:[4-8]|four|five|six|seven|eight)[- ]?digits?[- ]?numbers?\b/i,
  // A code by where it came from (the sidebar's words as they are): "the
  // code we sent to your email", "Code sent to your phone", "the code from
  // your authenticator app".
  /\bcodes?\b[^.?!]{0,40}?\b(?:from|in|on|via|by|sent to)\s+(?:(?:your|the|an?|my|that)\s+)?(?:e-?mail|text(?:\s+message)?s?|sms|phone|inbox|authenticator(?:\s+app)?)\b|\bcodes?\s+(?:(?:we|i)\s+(?:just\s+)?(?:e-?mailed|texted|sent)|(?:e-?mailed|texted)\s+to)\b|\b(?:e-?mail|sms|text(?:[-\s]+message)?|inbox|authenticator)\s+codes?\b/i,
  /验证码|校验码|动态码|动态密码|短信码|一次性密码|[0-9０-９一二三四五六七八九十两]+\s*位码|(?<![0-9０-９一二三四五六七八九十两])(?:[4-8４-８]|[四五六七八])\s*位(?:数字|数)/,
];

/**
 * A field that says just "Code", "Enter code" or "Enter the code", as the
 * sidebar's CODE_HEADER takes a question headed "Code": a sign-in's plainest
 * label, which a proxy kit passes through as the real site has it.
 */
const CODE_ALONE = /^\s*(?:enter\s+(?:(?:the|your)\s+)?)?code\s*[:*]?\s*$/i;

/** A card's code, by what its field says. */
const CARD_WORDS = /\b(?:cards?|cvv2?|cvc2?|csc)\b|卡/i;
/** Autocomplete tokens of a card's fields. */
const CARD_TOKENS = new Set(["cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name", "cc-type"]);

/** Codes that are never a sign-in's. */
const NOT_CODES = /\b(?:promo(?:tion(?:al)?)?|coupons?|gift|discount|referrals?|vouchers?|postal|post[- ]?codes?|zip(?:[- ]?codes?)?)\b|优惠码|兑换码|邀请码|推荐码|邮编|邮政编码/i;

/** A name or id as words: verificationCode, OTPCode, sms_code and one-time-code become "verification Code", "OTP Code", "sms code", "one time code". */
function identifierWords(value) {
  return String(value ?? "")
    .slice(0, TEXT_MAX)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.:[\]]+/g, " ");
}

function textOf(node) {
  try {
    return String(node?.textContent ?? "").slice(0, TEXT_MAX);
  } catch {
    return "";
  }
}

/** What a field says it's for: its name, id, placeholder, aria-label, title, and its labels' text. */
function fieldTexts(el) {
  const texts = [identifierWords(el.getAttribute("name")), identifierWords(el.id)];
  for (const attr of ["placeholder", "aria-label", "title"]) {
    texts.push(String(el.getAttribute(attr) ?? "").slice(0, TEXT_MAX));
  }
  const doc = el.ownerDocument;
  for (const id of String(el.getAttribute("aria-labelledby") ?? "").split(/\s+/).slice(0, 5)) {
    if (id) {
      texts.push(textOf(doc.getElementById(id)));
    }
  }
  try {
    for (const label of el.labels ?? []) {
      texts.push(textOf(label));
    }
  } catch {}
  return texts.filter(Boolean);
}

function oneTimeCodeToken(el) {
  try {
    if (el.getAutocompleteInfo?.()?.fieldName === "one-time-code") {
      return true;
    }
  } catch {}
  return /(^|\s)one-time-code(\s|$)/i.test(el.getAttribute("autocomplete") ?? "");
}

const isBox = el => HTMLInputElement.isInstance(el) && el.maxLength === 1 && CODE_TYPES.has(el.type);

/** One of SPLIT_MIN or more one-character inputs under a near ancestor. */
function splitCode(el) {
  if (!isBox(el)) {
    return false;
  }
  let node = el.parentElement;
  for (let level = 0; node && level < SPLIT_LEVELS; level++, node = node.parentElement) {
    let boxes = 0;
    for (const input of node.querySelectorAll("input")) {
      if (isBox(input) && ++boxes >= SPLIT_MIN) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Is `el` a field for a one-time code? Only inputs a code is typed into
 * count; the card check runs only for a field whose words ask for a code.
 *
 * @param {Element} el
 */
export function isCodeField(el) {
  if (!HTMLInputElement.isInstance(el) || !CODE_TYPES.has(el.type)) {
    return false;
  }
  if (oneTimeCodeToken(el) || splitCode(el)) {
    return true;
  }
  const texts = fieldTexts(el);
  if (!texts.some(text => CODE_ALONE.test(text) || CODE_WORDS.some(re => re.test(text))) || texts.some(text => NOT_CODES.test(text))) {
    return false;
  }
  return !cardCode(el, texts);
}

/** A card's security code: its field says so, or it or a field in its form is a card's by its autocomplete token. */
function cardCode(el, texts) {
  if (texts.some(text => CARD_WORDS.test(text))) {
    return true;
  }
  for (const field of [el, ...(el.form?.elements ?? [])]) {
    try {
      if (CARD_TOKENS.has(field.getAutocompleteInfo?.()?.fieldName)) {
        return true;
      }
    } catch {}
  }
  return false;
}

/**
 * Does key step `s` (methods/actions.sys.mjs's steps) put text into the
 * focused field or take it out: text, a paste, Backspace or Delete. Enter,
 * Tab and the arrows don't, so a code the user typed can still be sent.
 */
export function entersText(s) {
  if (s?.k === "insert") {
    return true;
  }
  const key = s?.k === "down" ? s.def?.key : null;
  return typeof key === "string" && (printable(s.text) || key.length === 1 || key === "Backspace" || key === "Delete");
}

/** Text with a character that shows: Enter's carriage return and Tab's tab don't. */
function printable(text) {
  return typeof text === "string" && [...text].some(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
}
