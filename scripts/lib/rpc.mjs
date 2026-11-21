// Minimal NDJSON client for a zenius instance (dev tooling and tests).
// The real SDK lives in sdk/; this stays dependency-free on purpose.

import net from "node:net";
import os from "node:os";
import path from "node:path";

export function zeniusHome() {
  return process.env.ZENIUS_HOME || path.join(os.homedir(), ".zenius");
}

export function socketPath(instance) {
  return path.join(zeniusHome(), "run", `${instance}.sock`);
}

export class RpcError extends Error {
  constructor(error, method) {
    super(`${method}: ${error.code}: ${error.message}`);
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

/**
 * Connect and wait for the hello frame.
 *
 * @param {string} instance
 * @param {{timeout?: number, callTimeout?: number}} [opts]
 *   callTimeout: default per-call limit in ms (0 = none); a call that runs
 *   longer rejects with code CLIENT_TIMEOUT instead of waiting forever.
 */
export async function connect(instance, { timeout = 5000, callTimeout = 0, pageBudget } = {}) {
  const sock = net.createConnection(socketPath(instance));
  const client = new Client(sock, { callTimeout, pageBudget });
  await client.ready(timeout);
  return client;
}

export class Client {
  #sock;
  /** Pieces of a frame whose newline hasn't arrived yet. */
  #pieces = [];
  /** Sent with every request when set, as the SDK does for EGO_BROWSER_PAGE_BUDGET. */
  #pageBudget;
  #nextId = 1;
  #pending = new Map();
  #hello;
  #helloWaiters = [];
  #eventListeners = new Set();
  #progressListeners = new Set();
  #closedError = null;

  #callTimeout;

  constructor(sock, { callTimeout = 0, pageBudget } = {}) {
    this.#pageBudget = pageBudget;
    this.#sock = sock;
    this.#callTimeout = callTimeout;
    sock.setEncoding("utf8");
    sock.setNoDelay?.(true);
    sock.on("data", chunk => this.#onData(chunk));
    sock.on("error", err => this.#fail(err));
    sock.on("close", () => this.#fail(new Error("connection closed")));
  }

  get hello() {
    return this.#hello;
  }

  ready(timeout) {
    if (this.#hello) {
      return Promise.resolve(this.#hello);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no hello frame within ${timeout}ms`)), timeout);
      this.#helloWaiters.push({
        resolve: h => {
          clearTimeout(timer);
          resolve(h);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{timeout?: number}} [opts]  overrides the client's callTimeout
   */
  call(method, params = {}, { timeout = this.#callTimeout } = {}) {
    if (this.#closedError) {
      return Promise.reject(this.#closedError);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        if (timeout > 0) {
          timer = setTimeout(() => {
            this.#pending.delete(id);
            const err = new Error(`${method}: no response within ${timeout} ms`);
            err.code = "CLIENT_TIMEOUT";
            reject(err);
          }, timeout);
        }
      };
      const done = fn => value => {
        clearTimeout(timer);
        fn(value);
      };
      // A call held at a takeover prompt hasn't started: its timer stops
      // while held and starts afresh at release (PROTOCOL "Frames").
      const onHeld = held => (held ? clearTimeout(timer) : arm());
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject), method, onHeld });
      arm();
      this.#sock.write(JSON.stringify({ id, method, params, progress: true, pageBudget: this.#pageBudget }) + "\n");
    });
  }

  /** Progress frames ({id, held, reason}) of this client's calls. */
  onProgress(listener) {
    this.#progressListeners.add(listener);
    return () => this.#progressListeners.delete(listener);
  }

  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  close() {
    this.#sock.end();
    this.#sock.destroy();
  }

  // Frames can be many MiB (snapshots, screenshots). Growing one string and
  // searching it from the start on every chunk is quadratic, so search only
  // the new chunk and join a frame's pieces once its newline arrives.
  #onData(chunk) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf("\n", start)) !== -1) {
      this.#pieces.push(chunk.slice(start, nl));
      const line = this.#pieces.join("");
      this.#pieces = [];
      start = nl + 1;
      if (line.trim()) {
        this.#onFrame(JSON.parse(line));
      }
    }
    if (start < chunk.length) {
      this.#pieces.push(chunk.slice(start));
    }
  }

  #onFrame(frame) {
    if (frame.event === "hello") {
      this.#hello = frame.params;
      this.#helloWaiters.splice(0).forEach(w => w.resolve(frame.params));
      return;
    }
    if (frame.event) {
      this.#eventListeners.forEach(l => l(frame.event, frame.params));
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      return;
    }
    if (!("result" in frame) && !("error" in frame)) {
      if ("held" in frame) {
        pending.onHeld(frame.held);
      }
      this.#progressListeners.forEach(l => l(frame));
      return;
    }
    this.#pending.delete(frame.id);
    if (frame.error) {
      pending.reject(new RpcError(frame.error, pending.method));
    } else if (typeof frame.unserializable === "string") {
      pending.resolve(decodeUnserializable(frame.unserializable));
    } else {
      pending.resolve(frame.result);
    }
  }

  #fail(err) {
    this.#closedError ??= err;
    this.#helloWaiters.splice(0).forEach(w => w.reject(err));
    for (const p of this.#pending.values()) {
      p.reject(err);
    }
    this.#pending.clear();
  }
}

/** NaN, ±Infinity, -0 and BigInt results arrive as strings in `unserializable`. */
export function decodeUnserializable(text) {
  switch (text) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    case "undefined":
      return undefined;
  }
  if (/^-?\d+n$/.test(text)) {
    return BigInt(text.slice(0, -1));
  }
  return text;
}
