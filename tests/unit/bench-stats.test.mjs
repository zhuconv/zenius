import assert from "node:assert/strict";
import test from "node:test";

import { stats } from "../bench/bench.mjs";

test("stats interpolates percentiles like numpy's default", () => {
  const s = stats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.p50, 55);
  assert.equal(Math.round(s.p95 * 10) / 10, 95.5);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.n, 10);
});

test("stats handles one sample and none", () => {
  assert.equal(stats([7]).p95, 7);
  assert.equal(stats([]).p50, null);
});
