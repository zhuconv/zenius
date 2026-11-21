// Runs chrome JS in a dev Zen (the dev runtime's dev.evalChrome, so dev
// profiles only) with scene.js's helpers (`S`) bound first, and prints what
// it returns as JSON. `win`, `ctx` and `service` are bound as dev.evalChrome
// binds them.
//   node tests/fixtures/agent-sidebar/chrome.mjs --instance <name> <file.js | -e code>
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const here = dirname(new URL(import.meta.url).pathname);
const { connect } = await import(join(resolve(here, "../../.."), "scripts/lib/rpc.mjs"));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { instance: { type: "string" }, e: { type: "string" }, timeout: { type: "string" } },
});
const code = values.e ?? (positionals[0] && readFileSync(resolve(here, positionals[0]), "utf8"));
if (!values.instance || !code) {
  console.error("usage: chrome.mjs --instance <name> <file.js | -e code> [--timeout ms]");
  process.exit(2);
}
const client = await connect(values.instance, { callTimeout: Number(values.timeout ?? 120000) });
try {
  const result = await client.call("dev.evalChrome", { code: `${readFileSync(join(here, "scene.js"), "utf8")}\n${code}` });
  console.log(JSON.stringify(result, null, 2));
} finally {
  client.close?.();
}
