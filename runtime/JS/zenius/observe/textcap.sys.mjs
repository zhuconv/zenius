// Caps on the page text zenius carries (zen-observe; docs/research/
// content-boundary.md, finding 3). Page script decides what a console call,
// an alert, a notification or a URL holds, and it all ends up in the main
// process, where running out of memory takes every window with it. Content
// modules cut what they send, and the parent cuts again whatever it buffers,
// since a page's own process is no judge of its text. No parent-only API
// here: content modules import it too.

/** Characters of text one event carries in all. */
export const EVENT_TEXT = 8 * 1024;
/** Characters one string in an event carries. */
export const STRING_TEXT = 4 * 1024;
/** Elements of an array, or keys of an object, kept at each level. */
const ENTRIES = 64;
/** Levels of nesting kept. */
const DEPTH = 8;
/** Characters of an object key. */
const KEY_TEXT = 256;

/**
 * `s` cut to at most `n` characters, never between a surrogate pair's
 * halves. The result is a copy: SpiderMonkey's slice() of a long string
 * points into it and keeps all of it alive, which would make the cap save
 * nothing. A JSON round trip copies it and keeps lone surrogates as they are.
 */
export function cut(s, n) {
  if (s.length <= n) {
    return s;
  }
  let end = Math.max(0, n);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return JSON.parse(JSON.stringify(s.slice(0, end)));
}

/**
 * A copy of `value` within the caps, and its size, about its length as JSON.
 * Strings are cut to `string` characters each and `text` in all, in the
 * order they come; an array or object keeps 64 entries, and nesting 8
 * levels. Values JSON can't carry (functions, symbols, bigints) are left out.
 *
 * @param {any} value  structured-clonable
 * @returns {{value: any, bytes: number, truncated: boolean}}
 */
export function capText(value, { text = EVENT_TEXT, string = STRING_TEXT } = {}) {
  const state = { left: text, string, bytes: 0, truncated: false };
  const out = copy(value, 0, state);
  return { value: out, bytes: state.bytes, truncated: state.truncated };
}

function copy(v, depth, st) {
  switch (typeof v) {
    case "string": {
      const n = Math.min(v.length, st.string, st.left);
      const s = n < v.length ? cut(v, n) : v;
      if (s.length < v.length) {
        st.truncated = true;
      }
      st.left -= s.length;
      st.bytes += s.length + 2;
      return s;
    }
    case "number":
    case "boolean":
      st.bytes += 8;
      return v;
    case "undefined":
      return undefined;
    case "object":
      break;
    default:
      st.truncated = true;
      return undefined;
  }
  if (v === null) {
    st.bytes += 4;
    return null;
  }
  st.bytes += 2;
  if (depth >= DEPTH) {
    st.truncated = true;
    return Array.isArray(v) ? [] : {};
  }
  if (Array.isArray(v)) {
    const n = Math.min(v.length, ENTRIES);
    if (n < v.length) {
      st.truncated = true;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = copy(v[i], depth + 1, st);
      st.bytes += 1;
    }
    return out;
  }
  const out = {};
  let n = 0;
  // for…in stops early, where Object.keys would list a huge object first.
  for (const key in v) {
    if (!Object.hasOwn(v, key)) {
      continue;
    }
    if (n++ >= ENTRIES || st.left <= 0) {
      st.truncated = true;
      break;
    }
    const k = cut(key, Math.min(KEY_TEXT, st.left));
    if (k.length < key.length) {
      st.truncated = true;
    }
    st.left -= k.length;
    st.bytes += k.length + 4;
    const value = copy(v[key], depth + 1, st);
    if (value !== undefined) {
      out[k] = value;
    }
  }
  return out;
}
