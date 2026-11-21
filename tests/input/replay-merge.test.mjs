// The clean copy's replay puts the parent's record of the keys it routed to
// a held tab together with what the content guards logged
// (content/typingkeys.sys.mjs's mergedInput). Plain node: no Zen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergedInput } from "../../runtime/JS/zenius/content/typingkeys.sys.mjs";

// "\n" stands for an end (Enter, Tab, a press elsewhere), "!" for a void (a
// shortcut, a paste, a drop).
function entry(c, t) {
  return c === "\n" ? { end: true, t } : c === "!" ? { void: true, t } : { key: c, code: "", keyCode: 0, t };
}
/** The parent's record: [char, t] pairs. */
const routed = (...pairs) => pairs.map(([c, t]) => entry(c, t));
/** A content guard's key. */
const key = (c, t) => ({ ...entry(c, t), src: "key" });
/** What only content sees: a press, a paste, a drop. */
const other = (c, t) => entry(c, t);
const text = entries => entries.map(e => (e.end ? "\n" : e.void ? "!" : e.key)).join("");

test("a key both the parent and content have counts once", () => {
  const out = mergedInput(routed(["a", 100], ["b", 150], ["c", 200]), [key("a", 103), key("b", 152), key("c", 204)]);
  assert.equal(text(out), "abc");
  assert.equal(out[0].t, 100, "a key's time is the parent's, when the user typed it");
});

test("content far behind the parent still counts each key once", () => {
  // A busy content process (the clean copy loading) logs keys long after
  // the parent routed them.
  const out = mergedInput(routed(["a", 100], ["b", 110], ["c", 120]), [key("a", 300), key("b", 310), key("c", 320)]);
  assert.equal(text(out), "abc");
});

test("the key no document got, typed as the clean copy committed, comes back in its place", () => {
  const out = mergedInput(routed(["a", 100], ["b", 150], ["c", 200], ["d", 250]), [key("a", 102), key("b", 152), key("d", 252)]);
  assert.equal(text(out), "abcd");
});

test("keys content logged before the parent's record began come first", () => {
  // The trigger's key: content logs it, then tells the parent, which only
  // then starts its record.
  const out = mergedInput(routed(["a", 150], ["b", 200]), [key("x", 90), key("a", 152), key("b", 202)]);
  assert.equal(text(out), "xab");
});

test("the trigger's letter typed again, then a key no document got, keep their order", () => {
  // The logged "a" at 90 came before the parent's record, so it can't be
  // the parent's "a" at 130, which content logged at 140.
  const out = mergedInput(routed(["a", 130], ["c", 160]), [key("a", 90), key("a", 140)]);
  assert.equal(text(out), "aac");
});

test("one of three same letters lost at the swap comes back", () => {
  const out = mergedInput(routed(["a", 100], ["a", 150], ["a", 200]), [key("a", 102), key("a", 203)]);
  assert.equal(text(out), "aaa");
});

test("an Enter no document got ends the replay before the keys typed after it", () => {
  // The parent's record stops at an end; the keys after it are content's.
  const out = mergedInput(routed(["a", 100], ["b", 150], ["\n", 200]), [key("a", 102), key("b", 152), key("c", 260), key("d", 300)]);
  assert.equal(text(out), "ab\ncd");
});

test("a press elsewhere before a key no document got stays before it", () => {
  const out = mergedInput(routed(["a", 100], ["c", 250]), [key("a", 102), other("\n", 180)]);
  assert.equal(text(out), "a\nc");
});

test("a paste in the clean copy after a key no document got stays after it", () => {
  const out = mergedInput(routed(["a", 100], ["b", 150]), [key("a", 102), other("!", 240)]);
  assert.equal(text(out), "ab!");
});

test("a shortcut content never got, kept by the parent, voids where it came", () => {
  const out = mergedInput(routed(["a", 100], ["!", 150], ["b", 200]), [key("a", 102), key("b", 203)]);
  assert.equal(text(out), "a!b");
});

test("either side alone stands as it is", () => {
  assert.equal(text(mergedInput([], [key("a", 100), other("!", 120), key("b", 140)])), "a!b");
  assert.equal(text(mergedInput(routed(["a", 100], ["b", 140]), [])), "ab");
  assert.deepEqual(mergedInput([], []), []);
});
