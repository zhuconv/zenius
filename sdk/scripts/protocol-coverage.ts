// Which runtime methods the SDK needs that an instance does not register yet.
//
//   node sdk/scripts/protocol-coverage.ts [--instance <name>] [--json]
//
// Exit 0 when every method is there, 1 when some are missing, 2 when the
// instance cannot be reached.

import { instanceName, socketPath } from "../src/instance.ts";
import { RUNTIME_METHODS } from "../src/protocol-methods.ts";
import { RpcClient } from "../src/rpc.ts";

const argv = process.argv.slice(2);
const flag = argv.includes("--instance") ? argv[argv.indexOf("--instance") + 1] : undefined;
const instance = instanceName(flag);
const client = new RpcClient({ socketPath: socketPath(instance), instance });
let registered: string[];
try {
  const result = await client.call<{ methods: string[] }>("browser.methods", {}, { safetyTimeoutMs: 5000 });
  registered = result.methods;
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
} finally {
  client.close();
}
const have = new Set(registered);
const needed = Object.keys(RUNTIME_METHODS);
const missing = needed.filter((method) => !have.has(method));
const extra = registered.filter((method) => !RUNTIME_METHODS[method] && !method.startsWith("dev.") && !method.startsWith("browser."));
if (argv.includes("--json")) {
  console.log(JSON.stringify({ instance, needed: needed.length, present: needed.length - missing.length, missing, unusedBySdk: extra }, null, 2));
} else {
  console.log(`instance ${instance}: ${needed.length - missing.length}/${needed.length} methods the SDK uses are registered`);
  for (const method of missing) console.log(`  missing  ${method.padEnd(24)} needed by ${RUNTIME_METHODS[method]!.join(", ")}`);
  for (const method of extra) console.log(`  unused   ${method}`);
}
process.exit(missing.length > 0 ? 1 : 0);
