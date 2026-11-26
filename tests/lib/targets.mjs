// Run a browser script on one of the two targets the eval compares:
//   ego     Ego Lite, through `ego-browser nodejs` (its embedded Node + SDK)
//   zenius  our runtime, through `zenius nodejs --instance <name>` from the SDK
// Both read the script from stdin and expose the same Ego-style globals.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function egoCli() {
  return process.env.EGO_BROWSER_CLI || join(homedir(), ".local", "bin", "ego-browser");
}

/**
 * Node for the zenius CLI. Ego's launcher embeds Node 24, so compare against
 * Node 24 too: ZENIUS_NODE, else Homebrew's keg-only node@24 on the Mac (the
 * PATH node there is 23.5), else the Node running this harness.
 */
export function zeniusNode() {
  if (process.env.ZENIUS_NODE) return process.env.ZENIUS_NODE;
  for (const path of ["/opt/homebrew/opt/node@24/bin/node", join(homedir(), "opt", "node-v24.22.2-linux-x64", "bin", "node")]) {
    if (existsSync(path)) return path;
  }
  return process.execPath;
}

/** The zenius CLI as [command, ...prefixArgs]: sdk/bin/zenius under zeniusNode(). */
export function zeniusCli() {
  if (process.env.ZENIUS_CLI) return process.env.ZENIUS_CLI.split(" ");
  const launcher = join(REPO_ROOT, "sdk", "bin", "zenius");
  if (existsSync(launcher)) return [zeniusNode(), launcher];
  return ["zenius"];
}

export function parseTarget(argv = process.argv) {
  const i = argv.indexOf("--target");
  const target = i > 0 ? argv[i + 1] : process.env.EVAL_TARGET || "ego";
  if (target !== "ego" && target !== "zenius") {
    throw new Error(`--target must be ego or zenius, got ${target}`);
  }
  const j = argv.indexOf("--instance");
  const instance = j > 0 ? argv[j + 1] : process.env.ZENIUS_INSTANCE || "zen-eval";
  return { target, instance };
}

/** Command and args that run a stdin script on the target. */
export function targetCommand({ target, instance, extraArgs = [] }) {
  if (target === "ego") return [egoCli(), ["nodejs", ...extraArgs]];
  const [cmd, ...prefix] = zeniusCli();
  return [cmd, [...prefix, "nodejs", "--instance", instance, ...extraArgs]];
}

/**
 * Run `source` on the target. Resolves with {code, stdout, stderr, ms}; never
 * rejects for a non-zero exit, only for a spawn failure or the timeout.
 */
export function runScript(source, { target = "ego", instance = "zen-eval", timeoutMs = 120_000, echo = false, extraArgs } = {}) {
  const [cmd, args] = targetCommand({ target, instance, extraArgs });
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      const error = new Error(`${target} script timed out after ${timeoutMs} ms`);
      Object.assign(error, { stdout, stderr, timedOut: true });
      reject(error);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    child.stdin.end(source);
  });
}

/** Version info for reports: {target, version, detail}. */
export async function targetVersion(opts) {
  if (opts.target === "ego") {
    const { stdout } = await new Promise((resolve, reject) => {
      // Like script output, the version goes to stderr when stdout isn't a TTY.
      const child = spawn(egoCli(), ["--version"]);
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", reject);
      child.on("close", () => resolve({ stdout: out }));
    });
    const lines = stdout.trim().split("\n").map((s) => s.trim());
    return { target: "ego", version: lines[0]?.split(" ").pop(), detail: lines.slice(1).join(", ") };
  }
  const hello = await readHello(opts.instance).catch(() => null);
  const commit = await new Promise((resolve) => {
    const child = spawn("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]);
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
  return {
    target: "zenius",
    version: hello?.runtimeVersion ?? "unknown",
    detail: [hello ? `zen ${hello.zenVersion}` : "instance not answering", commit && `commit ${commit}`].filter(Boolean).join(", "),
  };
}

/** The runtime's hello frame: {protocol, instance, runtimeVersion, zenVersion}. */
export function readHello(instance) {
  const home = process.env.ZENIUS_HOME || join(homedir(), ".zenius");
  const socket = process.env.ZENIUS_SOCKET || join(home, "run", `${instance}.sock`);
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("no hello within 2 s"));
    }, 2000);
    conn.setEncoding("utf8");
    conn.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      conn.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)).params);
      } catch (error) {
        reject(error);
      }
    });
  });
}
