// Turn arbitrary values (chrome objects, Xray-wrapped page objects, DOM nodes)
// into plain JSON-safe data for a response frame. Used in both processes.

const MAX_DEPTH = 8;

/**
 * A result JSON can't carry. A handler returns `new Unserializable("NaN")`
 * and the dispatcher sends `{id, result: null, unserializable: "NaN"}`; the
 * SDK decodes it. Texts: NaN, Infinity, -Infinity, -0, "123n" for a BigInt,
 * and undefined (for evaluate, where Ego tells undefined from null). The
 * dispatcher also converts a raw top-level NaN, ±Infinity, -0 or BigInt.
 */
export class Unserializable {
  /** @param {string} text */
  constructor(text) {
    this.text = String(text);
  }
}
const MAX_ITEMS = 1000;

/**
 * A value with more items than a result carries. It fails the call instead
 * of coming back cut: a cut that says nothing misled a test (a read of a
 * page's log came back cut mid-move), and a mark inside an array is lost to
 * a filter or a count.
 */
export class TooManyItems extends Error {
  /**
   * @param {string} what  "an array", "a Map", …
   * @param {string} path  where in the result, as `result.log[3]`
   * @param {number} count
   */
  constructor(what, path, count) {
    super(
      `${path} is ${what} of ${count} items, more than the ${MAX_ITEMS} a result carries; ` +
        "return it in parts (a slice at a time)"
    );
    this.name = "TooManyItems";
  }
}

/**
 * @param {any} value
 * @returns {any} JSON-safe copy; undefined becomes null. A top-level NaN,
 *   ±Infinity, -0 or BigInt stays as it is: actor messages carry it, and the
 *   dispatcher sends it as the frame's `unserializable` (PROTOCOL "Frames").
 *   Inside objects they follow JSON: null, 0, and "123n" for a BigInt.
 * @throws {TooManyItems} for an array, Set, Map, typed array or object of
 *   more than MAX_ITEMS items, anywhere in `value`
 */
export function toJSONSafe(value) {
  const out = walk(value, 0, new Set(), "result");
  return out === undefined ? null : out;
}

function checkCount(what, path, count) {
  if (count > MAX_ITEMS) {
    throw new TooManyItems(what, path, count);
  }
}

function walk(value, depth, seen, path) {
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "string":
    case "boolean":
      return value;
    case "number":
      if (depth === 0) {
        return value;
      }
      return Number.isFinite(value) ? value + 0 : null;
    case "bigint":
      return depth === 0 ? value : `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[function ${value.name || "anonymous"}]`;
  }
  if (value === null) {
    return null;
  }
  let obj = value;
  try {
    // Page objects reach chrome code behind Xrays, which hide expando
    // properties; waive them so we see what the page sees.
    obj = Cu.waiveXrays(value);
  } catch {}
  if (seen.has(obj)) {
    return "[circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[max depth]";
  }
  try {
    if (typeof obj.nodeType === "number" && typeof obj.nodeName === "string") {
      return describeNode(obj);
    }
    if (obj.window === obj && typeof obj.location === "object") {
      return `[window ${safe(() => String(obj.location.href))}]`;
    }
  } catch {}
  seen.add(obj);
  // Never call the page's own methods with chrome callbacks (page.map(cb)
  // throws "Permission denied to pass object to privileged code", and a page
  // may have replaced them anyway): read elements by index instead.
  try {
    if (Array.isArray(obj)) {
      const out = [];
      const n = obj.length >>> 0;
      checkCount("an array", path, n);
      for (let i = 0; i < n; i++) {
        const w = walk(safe(() => obj[i]), depth + 1, seen, `${path}[${i}]`);
        out.push(w === undefined ? null : w);
      }
      return out;
    }
    const tag = Object.prototype.toString.call(obj);
    if (tag === "[object Error]" || obj instanceof Error) {
      return { name: safe(() => String(obj.name)), message: safe(() => String(obj.message)), stack: safe(() => String(obj.stack)) };
    }
    if (tag === "[object Date]") {
      const time = Date.prototype.getTime.call(obj);
      return Number.isNaN(time) ? null : new Date(time).toISOString();
    }
    if (tag === "[object RegExp]") {
      return RegExp.prototype.toString.call(obj);
    }
    if (tag === "[object Map]") {
      checkCount("a Map", path, Reflect.get(Map.prototype, "size", obj));
      const out = {};
      for (const [k, v] of Map.prototype.entries.call(obj)) {
        const w = walk(v, depth + 1, seen, `${path}.get(${JSON.stringify(String(k))})`);
        if (w !== undefined) {
          out[String(k)] = w;
        }
      }
      return out;
    }
    if (tag === "[object Set]") {
      checkCount("a Set", path, Reflect.get(Set.prototype, "size", obj));
      const out = [];
      for (const v of Set.prototype.values.call(obj)) {
        const w = walk(v, depth + 1, seen, `${path}[${out.length}]`);
        out.push(w === undefined ? null : w);
      }
      return out;
    }
    if (ArrayBuffer.isView(obj)) {
      const out = [];
      const n = obj.length >>> 0;
      checkCount("a typed array", path, n);
      for (let i = 0; i < n; i++) {
        out.push(Number(obj[i]));
      }
      return out;
    }
    if (typeof obj.toJSON === "function") {
      return walk(obj.toJSON(), depth + 1, seen, path);
    }
    const result = {};
    const keys = Object.keys(obj);
    checkCount("an object", path, keys.length);
    for (const key of keys) {
      const w = walk(safe(() => obj[key]), depth + 1, seen, /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
      if (w !== undefined) {
        result[key] = w;
      }
    }
    return result;
  } catch (e) {
    if (e instanceof TooManyItems) {
      throw e;
    }
    return `[unserializable: ${e.message}]`;
  } finally {
    seen.delete(obj);
  }
}

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return `[threw: ${e.message}]`;
  }
}

function describeNode(node) {
  if (node.nodeType === 1) {
    const id = node.id ? `#${node.id}` : "";
    const cls = typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\s+/).join(".") : "";
    return `<${node.localName}${id}${cls}>`;
  }
  if (node.nodeType === 3) {
    return `#text ${JSON.stringify(String(node.data).slice(0, 80))}`;
  }
  if (node.nodeType === 9) {
    return `#document ${safe(() => node.URL)}`;
  }
  return `[node ${node.nodeName}]`;
}
