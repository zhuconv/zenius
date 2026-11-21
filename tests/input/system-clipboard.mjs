// The system clipboard, for the checks that agent input never reaches it.
// This is the only file in tests/input that may touch it: run.sh refuses to
// run when any other does.
//
// A visible Zen on the Mac shares the user's pasteboard. So on the Mac this
// only ever reads NSPasteboard's change count, headed or headless: never its
// contents, and never a write. The count also moves whenever the user or
// another app copies (about once every 10 s on the user's Mac), so a check
// covers one step, not a test: a sampler timestamps the count every 20 ms,
// and a step fails only on a change between its start and shortly after its
// end. A headless Zen on Linux has an in-memory clipboard of its own, where a
// sentinel is safe. Anywhere else (a visible Zen on Linux) nothing is
// touched or checked.
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";

const SAMPLE_MS = 20;
// A step's copy reaches the pasteboard before its RPC returns (the content
// process sends it ahead of the action's reply); this covers sampling and
// scheduling slop.
const SLACK_MS = 100;
const READING_TIMEOUT_MS = 10_000;
const SENTINEL = "ZEN-INPUT-SENTINEL";

// Prints "<epoch ms> <change count>" every SAMPLE_MS. Quits by itself after
// argv[0] seconds, so a crashed run can't leave it polling.
const SAMPLER_JXA = `ObjC.import("AppKit");
function run(argv) {
  const end = Date.now() + Number(argv[0]) * 1000;
  while (Date.now() < end) {
    console.log(Date.now() + " " + $.NSPasteboard.generalPasteboard.changeCount);
    delay(${SAMPLE_MS / 1000});
  }
}`;

/**
 * Which check this machine allows.
 *
 * @param {boolean} headless the runtime's MOZ_HEADLESS
 * @returns {"changeCount" | "sentinel" | "none"}
 */
export function clipboardMode(headless) {
  if (process.platform === "darwin") {
    return "changeCount";
  }
  if (process.platform === "linux" && headless && process.env.ZENIUS_INPUT_HEADED !== "1") {
    return "sentinel";
  }
  return "none";
}

/**
 * @param {{headless: boolean, call: (method: string, params?: object) => Promise<any>, lifetimeMs: number}} options
 */
export function systemClipboard({ headless, call, lifetimeMs }) {
  const mode = clipboardMode(headless);
  const stats = { mode, checked: 0, unchecked: 0 };
  /** @type {PasteboardSampler | null} */
  let sampler = null;

  // Linux, headless Zen only. The runtime refuses too, in case this module's
  // idea of headless is ever wrong.
  const TRANSFERABLE = `if (Services.env.get("MOZ_HEADLESS") !== "1") throw new Error("not headless: the system clipboard is off limits");
    const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    t.init(null);
    t.addDataFlavor("text/plain");`;
  const sentinelOnly = () => {
    if (mode !== "sentinel") {
      throw new Error(`the system clipboard is off limits here (${mode})`);
    }
  };
  const writeText = text => {
    sentinelOnly();
    return call("dev.evalChrome", {
      arg: text,
      code: `${TRANSFERABLE}
        const s = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
        s.data = arg;
        t.setTransferData("text/plain", s);
        Services.clipboard.setData(t, null, Ci.nsIClipboard.kGlobalClipboard);
        return true;`,
    });
  };
  const readText = () => {
    sentinelOnly();
    return call("dev.evalChrome", {
      code: `${TRANSFERABLE}
        Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard);
        const o = {};
        try { t.getTransferData("text/plain", o); return o.value.QueryInterface(Ci.nsISupportsString).data; } catch { return null; }`,
    });
  };

  const clipboard = {
    stats,

    /**
     * Run one step that might write the system clipboard (a copy or cut),
     * and fail if it did.
     *
     * @template T
     * @param {string} label
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async step(label, fn) {
      if (mode === "none") {
        stats.unchecked++;
        return fn();
      }
      if (mode === "sentinel") {
        await writeText(SENTINEL);
        const result = await fn();
        stats.checked++;
        nodeAssert.equal(await readText(), SENTINEL, `${label} reached the system clipboard (headless Zen's in-memory clipboard lost its sentinel)`);
        return result;
      }
      sampler ??= new PasteboardSampler(lifetimeMs);
      await sampler.reading();
      const from = Date.now();
      const result = await fn();
      const to = Date.now() + SLACK_MS;
      const w = await sampler.window(from, to);
      stats.checked++;
      if (w.changedAt !== null) {
        nodeAssert.fail(
          `${label}: the macOS pasteboard's change count went from ${w.before} to ${w.after} during this step ` +
            `(first change ${w.changedAt - from} ms after it began, in a ${to - from} ms window). Either Zen wrote ` +
            `the user's pasteboard, or the user or another app copied just then: rerun to tell.`
        );
      }
      return result;
    },

    /**
     * Linux headless only: a deliberate write inside a step must fail it,
     * so a passing check means something.
     *
     * @returns {Promise<boolean|null>} null where a write isn't allowed
     */
    async selfCheck() {
      if (mode !== "sentinel") {
        return null;
      }
      try {
        await clipboard.step("self-check", () => writeText("written by the self-check"));
        return false;
      } catch (e) {
        return e instanceof nodeAssert.AssertionError;
      }
    },

    stop() {
      sampler?.stop();
      sampler = null;
    },
  };
  return clipboard;
}

/** NSPasteboard's change count over time, from a JXA loop. Mac only. */
export class PasteboardSampler {
  /** @type {Array<[number, number]>} [epoch ms, change count], oldest first */
  samples = [];
  failure = null;
  stopped = false;
  #wake = new Set();
  #child;
  #onExit = () => this.stop();

  /**
   * @param {number} lifetimeMs how long the run may last; the sampler quits a minute later regardless
   * @param {string[]} [command] tests only: a stand-in for osascript
   */
  constructor(lifetimeMs, command) {
    const seconds = String(Math.ceil(lifetimeMs / 1000) + 60);
    const [file, ...args] = command ?? ["osascript", "-l", "JavaScript", "-e", SAMPLER_JXA];
    this.#child = spawn(file, [...args, seconds], { stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    // JXA's console.log writes to stderr; read both.
    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        for (const line of lines) {
          const m = /^(\d+) (\d+)$/.exec(line.trim());
          if (m) {
            this.samples.push([Number(m[1]), Number(m[2])]);
          } else if (line.trim()) {
            said = line.trim();
          }
        }
        if (this.samples.length > 6000) {
          this.samples.splice(0, 3000);
        }
        this.#notify();
      });
      stream.unref?.();
    }
    this.#child.on("error", e => this.#fail(`osascript didn't start: ${e.message}`));
    this.#child.on("exit", (code, signal) => this.#fail(`osascript exited (${signal ?? code})${said ? `: ${said}` : ""}`));
    this.#child.unref();
    process.once("exit", this.#onExit);
  }

  /** Resolves once the sampler has given a reading. */
  reading() {
    return this.#until(0);
  }

  /**
   * The count just before `from` and at `to`, and when it first changed in
   * between. Waits for a reading taken at or after `to`.
   *
   * @returns {Promise<{before: number, after: number, changedAt: number|null}>}
   */
  async window(from, to) {
    await this.#until(to);
    const s = this.samples;
    const i = Math.max(0, s.findLastIndex(([t]) => t <= from));
    const j = s.findIndex(([t]) => t >= to);
    const before = s[i][1];
    const change = s.slice(i + 1, j + 1).find(([, count]) => count !== before);
    return { before, after: s[j][1], changedAt: change ? change[0] : null };
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    process.off("exit", this.#onExit);
    this.#child.kill();
  }

  #until(t) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn, value) => {
        clearTimeout(timer);
        this.#wake.delete(check);
        fn(value);
      };
      const check = () => {
        if (this.samples.length && this.samples.at(-1)[0] >= t) {
          settle(resolve);
        } else if (this.failure) {
          settle(reject, new Error(`no pasteboard reading: ${this.failure}`));
        }
      };
      timer = setTimeout(() => settle(reject, new Error(`no pasteboard reading in ${READING_TIMEOUT_MS} ms`)), READING_TIMEOUT_MS);
      this.#wake.add(check);
      check();
    });
  }

  #notify() {
    for (const check of [...this.#wake]) {
      check();
    }
  }

  #fail(why) {
    if (!this.stopped) {
      this.failure = why;
      this.#notify();
    }
  }
}
