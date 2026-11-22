// tests/live/helpers.mjs: Ego's MIT notice for the Skill copy, and changeCount moves by script.
import assert from "node:assert/strict";
import { test } from "node:test";
import { egoNotice, pasteboardMoves } from "../live/helpers.mjs";

test("egoNotice: THIRD_PARTY.md's quoted MIT notice for Ego Lite, unquoted, and nothing after it", () => {
  const notice = egoNotice();
  assert.match(notice, /^MIT License\n\nCopyright \(c\) 2026 CitroLabs\n\nPermission is hereby granted/);
  assert.match(notice, /USE OR OTHER DEALINGS IN THE SOFTWARE\.\n$/);
  assert.doesNotMatch(notice, /^ *>/m);
  const shaped = "- **Other**:\n\n  > Other License\n\n- **Ego Lite**:\n\n  > MIT License\n  >\n  > Copyright (c) 2026 CitroLabs\n\n- **Next**:\n  > not this\n";
  assert.equal(egoNotice(shaped), "MIT License\n\nCopyright (c) 2026 CitroLabs\n");
  assert.throws(() => egoNotice("- **Ego Lite**:\n\n  > Apache License\n"), /no MIT notice/);
  assert.throws(() => egoNotice("nothing here\n"), /no MIT notice/);
});

test("pasteboardMoves: each move next to the latest allowed command before it", () => {
  assert.equal(pasteboardMoves([], [1000]), null);
  assert.deepEqual(pasteboardMoves([{ at: 500, count: 7 }], [1000]), { first: 7, last: 7, moves: [] });
  const seen = [{ at: 500, count: 7 }, { at: 900, count: 8 }, { at: 2500, count: 9 }, { at: 4000, count: 10 }];
  assert.deepEqual(pasteboardMoves(seen, [1000, 2000, 3000]), {
    first: 7,
    last: 10,
    moves: [
      { at: new Date(900).toISOString(), count: 8, script: "before any command" },
      { at: new Date(2500).toISOString(), count: 9, script: "002.sh" },
      { at: new Date(4000).toISOString(), count: 10, script: "003.sh" },
    ],
  });
});
