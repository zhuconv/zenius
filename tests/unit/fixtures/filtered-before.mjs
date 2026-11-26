// For tests/unit/filtered-run.test.mjs: a file whose before hook opens
// something late, as a suite's setup() connects to Zen, and whose after hook
// closes it.
import { after, before, test } from "node:test";

let hold = null;
before(async () => {
  await new Promise(resolve => setTimeout(resolve, 1000));
  // Stands in for a socket or a server: it keeps the process alive. A timer
  // ends by itself, so a run that never closes it still ends.
  hold = setTimeout(() => {}, 1500);
  console.log("zz: the before finished");
});
after(() => {
  console.log(`zz: the after hooks ran, ${hold ? "after" : "before"} the before finished`);
  clearTimeout(hold);
});
test("zz-selected", () => {});
