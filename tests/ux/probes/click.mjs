// Click probe (a load test): one task, no load, the baseline
// for the slow clicks seen with ten tasks. Not a test; it prints "# key:
// json" lines.
//
//   ZENIUS_UX_INSTANCE=zen-ux-load tests/ux/run.sh tests/ux/probes/click.mjs
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { setup } from "../lib.mjs";

let h;
let space;
const log = (k, v) => console.log(`# ${k}: ${JSON.stringify(v)}`);
const q = (a, p) => +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1);
const stat = a => ({ n: a.length, p50: q(a, 0.5), p90: q(a, 0.9), p95: q(a, 0.95), max: q(a, 1), over1s: a.filter(x => x > 1000).length });

before(async () => {
  h = await setup();
  ({ id: space } = await h.createSpace({ name: "click probe" }));
});
after(async () => h?.close());

const click = async () => {
  const t0 = performance.now();
  await h.call("page.click", { space, page: "p1", target: "input[type=button]", options: {} });
  return performance.now() - t0;
};

test("click latency: right after a load and fill, and on a settled page", { timeout: 300000 }, async () => {
  const fresh = [];
  for (let i = 0; i < 30; i++) {
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/zoo/forms.html?i=${i}` });
    await h.call("page.fill", { space, page: "p1", target: "#email", value: `a${i}@example.com`, options: {} });
    fresh.push(await click());
  }
  log("afterGotoAndFill", stat(fresh));
  const afterGoto = [];
  for (let i = 0; i < 20; i++) {
    await h.call("page.goto", { space, page: "p1", url: `${h.base}/zoo/forms.html?j=${i}` });
    afterGoto.push(await click());
  }
  log("rightAfterGoto", stat(afterGoto));
  const afterFill = [];
  for (let i = 0; i < 20; i++) {
    await h.call("page.fill", { space, page: "p1", target: "#email", value: `b${i}@example.com`, options: {} });
    afterFill.push(await click());
  }
  log("rightAfterFill", stat(afterFill));
  const settled = [];
  for (let i = 0; i < 30; i++) {
    settled.push(await click());
  }
  log("settledPage", stat(settled));
});
