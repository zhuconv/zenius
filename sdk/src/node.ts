// Node built-ins, loaded through require().
//
// Importing a built-in as ESM builds a namespace facade over all its exports,
// which costs milliseconds per module on every CLI start (node:util ~5 ms,
// node:fs ~4 ms, node:crypto ~8 ms on the Linux server). require() returns the module the
// bootstrap already loaded. Every agent script pays this, so it matters.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const fs: typeof import("node:fs") = require("node:fs");
export const os: typeof import("node:os") = require("node:os");
export const path: typeof import("node:path") = require("node:path");
export const url: typeof import("node:url") = require("node:url");
export const util: typeof import("node:util") = require("node:util");
export const vm: typeof import("node:vm") = require("node:vm");

/**
 * Whether this process runs under Node's permission model, as the sandboxed
 * launcher (scripts/install-cli.sh --sandbox) starts it.
 */
export function inSandbox(): boolean {
  return typeof (process as { permission?: unknown }).permission === "object";
}

/**
 * Whether this process runs under the sandboxed launcher itself: Node's
 * permission model is on, and the launcher's own variable is there
 * (ZENIUS_NODE_MAJOR, which only sdk/sandbox/launcher.sh sets). zenius mcp
 * offers its script tool only then: unsandboxed, a script would have the
 * user's whole account.
 */
export function underLauncher(env: NodeJS.ProcessEnv = process.env): boolean {
  return inSandbox() && typeof env.ZENIUS_NODE_MAJOR === "string" && env.ZENIUS_NODE_MAJOR !== "";
}

/** node:net takes ~3 ms to load, so only scripts that reach the browser pay for it. */
export function net(): typeof import("node:net") {
  return require("node:net");
}

export function tty(): typeof import("node:tty") {
  return require("node:tty");
}

/** For zenius mcp alone: its tool calls (rpc.ts withSignal) and its scripts' rounds (round.ts); a `zenius nodejs` run never loads it. */
export function asyncHooks(): typeof import("node:async_hooks") {
  return require("node:async_hooks");
}

/** For zenius mcp's scripts alone (mcp-script.ts: a script's empty stdin). */
export function stream(): typeof import("node:stream") {
  return require("node:stream");
}
