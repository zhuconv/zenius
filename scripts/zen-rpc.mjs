#!/usr/bin/env node
// Call one zenius RPC method and print the result.
//
//   node scripts/zen-rpc.mjs --instance <name> <method> ['<json params>']
//   node scripts/zen-rpc.mjs --instance <name> --bench 50 browser.version
//
// --timeout ms (default 60000, 0 = none) fails a call that takes longer.
// --instance defaults to $ZENIUS_INSTANCE, then "default". Exit status 1 on an
// RPC error, which is printed as JSON on stderr. --bench N repeats the call N
// times on one connection and prints round-trip percentiles.
import { performance } from "node:perf_hooks";
import { connect } from "./lib/rpc.mjs";

const args = process.argv.slice(2);
let instance = process.env.ZENIUS_INSTANCE || "default";
let bench = 0;
let compact = false;
// A hung call must not block the script that runs it: a run that ends by
// closing a headed window would never get there. 0 waits forever.
let timeout = 60000;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--instance" || a === "-i") instance = args[++i];
  else if (a.startsWith("--instance=")) instance = a.slice(11);
  else if (a === "--bench") bench = Number(args[++i]);
  else if (a === "--timeout") timeout = Number(args[++i]);
  else if (a === "--compact" || a === "-c") compact = true;
  else if (a === "--help" || a === "-h") {
    console.log("usage: zen-rpc.mjs [--instance <name>] [--compact] [--bench N] [--timeout ms] <method> ['<json params>']");
    process.exit(0);
  } else positional.push(a);
}
const [method, rawParams] = positional;
if (!method) {
  console.error("usage: zen-rpc.mjs [--instance <name>] <method> ['<json params>']");
  process.exit(2);
}
let params = {};
if (rawParams !== undefined) {
  try {
    params = JSON.parse(rawParams);
  } catch (e) {
    console.error(`params are not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

let client;
try {
  client = await connect(instance, { callTimeout: timeout });
} catch (e) {
  console.error(`cannot connect to instance "${instance}": ${e.message}`);
  process.exit(3);
}
try {
  if (bench > 0) {
    const times = [];
    for (let i = 0; i < bench; i++) {
      const t0 = performance.now();
      await client.call(method, params);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const pct = p => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2);
    console.log(JSON.stringify({ method, n: bench, p50: +pct(0.5), p95: +pct(0.95), min: +times[0].toFixed(2), max: +times.at(-1).toFixed(2) }));
  } else {
    const result = await client.call(method, params);
    console.log(typeof result === "string" && !compact ? result : JSON.stringify(result, null, compact ? 0 : 2));
  }
} catch (e) {
  console.error(JSON.stringify({ code: e.code ?? "CLIENT_ERROR", message: e.message, data: e.data }, null, 2));
  process.exitCode = 1;
} finally {
  client.close();
}
