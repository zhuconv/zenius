// Stopping a page's own runaway script (methods/observe.sys.mjs,
// stopUntilAnswered). Gecko acts on its stop only where the interrupt finds
// the page's own code, so a page that loops making frames, and spends most of
// its time in zenius's guards there, takes many stops, and almost never ends
// if zenius's code runs last before the page's own goes on (a listener at a
// new frame's load or pageshow). They go again until the page answers, then
// one the page never acts on clears what's left.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setup, timed } from "./lib.mjs";

let env;
let site;
// The page's own loop starts LOOP_START_MS after its script: after page.goto
// is done with the page.
const LOOP_START_MS = 500;
const PAGE = `<!doctype html><meta charset=utf-8><title>page stop</title><body><script>
window.__loop = { iters: 0, done: false, last: 0, began: 0 };
window.spin = ms => {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
  window.__spun = true;
};
const kind = new URLSearchParams(location.search).get("loop");
if (kind) {
  setTimeout(() => {
    const s = window.__loop;
    s.began = Date.now();
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const f = document.createElement("iframe");
      document.body.append(f);
      if (kind === "remove") {
        f.remove();
      }
      s.iters++;
      s.last = Date.now();
    }
    s.done = true;
  }, ${LOOP_START_MS});
}
</script>`;

before(async () => {
  env = await setup();
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(PAGE);
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  site?.close();
  await env?.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = path => `http://127.0.0.1:${site.address().port}${path}`;
/** The page's own globals, read from chrome: waits until the page answers. */
const pageGlobal = (page, name) =>
  env.call("dev.evalContent", { ...page.P, privileged: true, code: `return JSON.parse(JSON.stringify(Cu.waiveXrays(actor.contentWindow).${name} ?? null));` });
/** Code in a sandbox with the page's principal. */
const pageWorld = (page, code) => env.call("dev.evalContent", { ...page.P, privileged: false, code });
const OBSERVE = `const M = ChromeUtils.importESModule("chrome://userscripts/content/zenius/methods/observe.sys.mjs");
  const browser = ctx.resolvePage(arg).browser;`;

// The call goes this long after the page's loop is due to begin. A busy
// machine can run the page's timer late, and a call that comes before the
// loop isn't held by it at all.
const SLACK_MS = 1500;

/**
 * An evaluate sent while the page's own loop (`kind`) runs: the call's
 * outcome (when the agent's code ran, or the error's code), how long it
 * took, and the loop's record once the page answers. `held` says whether
 * the loop held the call; one whose timer ran past the call didn't, and
 * then the case never happened.
 */
async function overrun(page, kind) {
  await page.goto(url(`/?loop=${kind}`));
  await sleep(LOOP_START_MS + SLACK_MS);
  const t0 = Date.now();
  const { value: outcome, ms } = await timed(() =>
    page.call("page.evaluate", { fn: "Date.now()", isFunction: false, responseTimeout: 2000 }).then(
      v => v,
      e => e.code
    )
  );
  const loop = await pageGlobal(page, "__loop");
  // Held: the agent's code ran only once the loop had begun, or not at all.
  const held = loop.began > 0 && (typeof outcome !== "number" || outcome >= loop.began);
  return { outcome, ms, loop, t0, held };
}

/** What a failure says of the case: the call's outcome and the loop's times, from when the call was sent. */
function told({ outcome, ms, loop, t0 }) {
  const call =
    typeof outcome === "number"
      ? `the agent's code ran at ${outcome - t0} ms and the call took ${Math.round(ms)} ms`
      : `the call gave ${outcome} after ${Math.round(ms)} ms`;
  const began = loop.began ? `began at ${loop.began - t0} ms and ran ${loop.last - loop.began} ms` : "hadn't begun when it was read";
  return `${call}; the page's loop ${began}`;
}
const NOT_HELD = "the page's loop began after the call (its timer ran late), so nothing held the call";

test("an evaluate that overruns while the page's own loop makes frames ends that loop, and the call has its result", () =>
  env.inSpace("page stop frames", async page => {
    const run = await overrun(page, "remove");
    assert.ok(run.held, `${NOT_HELD}: ${told(run)}`);
    assert.equal(typeof run.outcome, "number", told(run));
    assert.ok(run.ms < 2000, told(run));
    assert.equal(run.loop.done, false, `the page's loop ran to its end: ${told(run)}`);
  }));

// Gecko makes a src-less frame's first document whole inside the call that
// made the frame: the frame's load and pageshow, then its load in the page,
// fire before the call returns. A listener of zenius's on one of them runs
// zenius's code right before the page's own goes on, where an interrupt
// otherwise finds the page's: a page that makes frames in a loop then gives a
// stop almost nothing of its own (the media guard's bfcache catch-up, on
// every document, made the next test miss under load).
test("zenius listens to nothing where a frame the page makes ends its first document, so a stop finds the page's own code there", () =>
  env.inSpace("page stop frame end", async page => {
    await page.goto(url("/"));
    const found = await env.call("dev.evalContent", {
      ...page.P,
      privileged: true,
      code: `const els = Cc["@mozilla.org/eventlistenerservice;1"].getService(Ci.nsIEventListenerService);
        const G = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/guards.sys.mjs");
        const doc = actor.document;
        const f = doc.createElement("iframe");
        doc.body.append(f);
        const w = f.contentWindow;
        const of = (target, types) => els.getListenerInfoFor(target).filter(l => types.includes(l.type)).map(l => l.type + (l.capturing ? " (capture)" : ""));
        const found = {
          guarded: G.installed(w.windowGlobalChild.getActor("Zenius")),
          frame: [...of(w, ["load", "pageshow"]), ...of(f.contentDocument, ["load", "pageshow"])],
          page: [...of(actor.contentWindow, ["load"]), ...of(doc, ["load"]), ...of(f, ["load"])],
        };
        f.remove();
        return found;`,
    });
    // guarded: the frame has zenius's guards, so their listeners were there to find.
    assert.deepEqual(found, { guarded: true, frame: [], page: [] });
  }));

test("the stops go on past the call until the page answers: they end a loop that only appends frames, and the frame being made has every guard", () =>
  env.inSpace("page stop appends", async page => {
    // In time for the call or after it: the stops go on for up to 5 s from
    // the first (RESEND_LIMIT_MS), and the first goes out before the call
    // returns. So the loop ends within 5 s of the call's return, plus a
    // margin for the last stops in flight. Counted from the call's start, a
    // slow parent's late deadline and probe would count against the stops.
    const run = await overrun(page, "append");
    const { outcome, loop, t0, ms } = run;
    assert.ok(run.held, `${NOT_HELD}: ${told(run)}`);
    assert.ok(typeof outcome === "number" || outcome === "ZEN_PAGE_EVALUATION_TIMED_OUT", told(run));
    // The loose check on the time from the call: a stop ended the loop
    // before its own end, 15 s after it began.
    assert.equal(loop.done, false, `the page's loop ran to its end: ${told(run)}`);
    const pastReturn = Math.round(loop.last - (t0 + ms));
    assert.ok(pastReturn < 5000 + 500, `the loop ran ${pastReturn} ms past the call's return, past the stops' 5 s: ${told(run)}`);
    // Gecko ends only code whose global is a page's window, and zenius's
    // install runs none: the frame being made when the loop was ended has
    // every guard. Told by how each behaves, with nothing opened, written,
    // asked for or shown (as in agentworld.test.mjs's PAGE_GUARDS).
    const last = await pageWorld(
      page,
      `const w = document.body.lastElementChild.contentWindow;
       let open;
       try {
         Reflect.apply(w.open, {}, ["http://[", "_blank"]);
         open = "returned";
       } catch (e) {
         open = e.name;
       }
       const clipboard = await Reflect.apply(w.Clipboard.prototype.writeText, {}, ["zo"]).then(() => "resolved", e => e.name);
       const read = [];
       const request = {
         get signal() {
           read.push("signal");
           return undefined;
         },
       };
       try {
         await Reflect.apply(w.CredentialsContainer.prototype.get, {}, [request]);
       } catch {}
       const native = ["Notification", "RTCPeerConnection", "SharedWorker", "BroadcastChannel"].filter(n => Function.prototype.toString.call(w[n]).includes(n));
       // quiet: the wrapper (native has none of the four) is its prototype's
       // constructor too, as zen-ux's quiet one makes it.
       return { open, clipboard, passkeys: read[0] ?? "unread", quiet: w.Notification === w.Notification.prototype.constructor, native };`
    );
    assert.deepEqual(last, { open: "SyntaxError", clipboard: "NotAllowedError", passkeys: "signal", quiet: true, native: [] });
  }));

test("no stop is left waiting: one that finds nothing to end would end the page's next long script", () =>
  env.inSpace("page stop cleared", async page => {
    await page.goto(url("/"));
    // The page's own script, 4.5 s: Gecko's watchdog asks for an interrupt
    // once a script has run 2.5 s, and a stop still waiting then ends it.
    const spun = async () => {
      await pageWorld(page, "window.__spun = false; setTimeout(spin, 0, 4500); return true;");
      await sleep(5000);
      return pageGlobal(page, "__spun");
    };
    // One stop while the page is idle finds only zenius's own code, and waits.
    assert.equal(await env.chrome(`${OBSERVE} return M.stopPageScript(browser);`, page.P), true);
    assert.equal(await spun(), false, "the stop left waiting didn't end the page's script");
    // stopUntilAnswered clears what it leaves.
    assert.equal(await env.chrome(`${OBSERVE} return await M.stopUntilAnswered(ctx, browser);`, page.P), true);
    assert.equal(await spun(), true, "a stop was left waiting");
  }));
