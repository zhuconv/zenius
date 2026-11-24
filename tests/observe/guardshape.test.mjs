// The four constructor guards (content/refusals.sys.mjs: Notification,
// RTCPeerConnection, SharedWorker and BroadcastChannel) keep the native
// constructor's shape, in a task page's own scripts and in the agent's world
// (page.evaluate). That covers its name and length, its own prototype (that
// of an interface object no guard wraps, Worker), prototype.constructor, its
// instances' prototype chain, instanceof, a native toString with no trace of
// the wrapper, and subclassing. A subclass is no way around a guard: it
// constructs as the guard does, refused where the guard refuses.
// BroadcastChannel is scoped, not refused, so it builds either way.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env?.close();
});

const NAMES = ["Notification", "RTCPeerConnection", "SharedWorker", "BroadcastChannel"];
const LENGTH = { Notification: 1, RTCPeerConnection: 0, SharedWorker: 1, BroadcastChannel: 1 };
/**
 * What making each gives in each realm while the agent drives, with the
 * arguments shapes() passes: "made", or the refusal's error. A task's page
 * without evidence makes its notifications as any site does; the agent's
 * world never does. A data: shared worker is refused in both.
 */
const MAKES = {
  page: { Notification: "made", RTCPeerConnection: "NotAllowedError", SharedWorker: "SecurityError", BroadcastChannel: "made" },
  world: { Notification: "NotAllowedError", RTCPeerConnection: "NotAllowedError", SharedWorker: "SecurityError", BroadcastChannel: "made" },
};

/** `code`, an expression, run as the page's own script; its value, as JSON. */
const asPage = (page, code) =>
  page.call("dev.evalContent", {
    privileged: false,
    code: `const s = document.createElement("script");
      s.textContent = "window.__zoOut = JSON.stringify(" + ${JSON.stringify(code)} + ");";
      document.documentElement.append(s);
      s.remove();
      return JSON.parse(window.__zoOut);`,
  });

/**
 * Each constructor's shape, and what making one gives, directly and through
 * a subclass: "made", or the error's name. It runs in the realm under test,
 * as that realm's own code.
 */
function shapes(names) {
  // An interface object no guard wraps: what a native's own prototype is.
  // Gecko's WebIDL constructors don't have Function.prototype there.
  const nativeOwnProto = Object.getPrototypeOf(window.Worker);
  const args = { Notification: ["zo"], RTCPeerConnection: [], SharedWorker: ["data:,0"], BroadcastChannel: ["zo"] };
  const outcome = make => {
    try {
      make();
      return "made";
    } catch (e) {
      return e?.name ?? String(e);
    }
  };
  const out = {};
  for (const name of names) {
    const X = window[name];
    const source = Function.prototype.toString.call(X);
    let Sub = null;
    try {
      Sub = class extends X {};
    } catch {}
    out[name] = {
      name: X.name,
      length: X.length,
      ownProto: Object.getPrototypeOf(X) === nativeOwnProto,
      protoConstructor: X.prototype.constructor === X,
      instanceProto: Object.getPrototypeOf(X.prototype) === window.EventTarget.prototype,
      instanceOf: Object.create(X.prototype) instanceof X,
      nativeMarker: /\[native code\]/.test(source),
      noWrapper: !/Proxy|=>|\{\s*return|handler|trap/.test(source),
      subclass: !!Sub && Object.getPrototypeOf(Sub) === X && Object.getPrototypeOf(Sub.prototype) === X.prototype,
      direct: outcome(() => new X(...args[name])),
      viaSubclass: Sub ? outcome(() => new Sub(...args[name])) : "no subclass",
    };
  }
  return out;
}

test("the four guarded constructors keep the native shape in a task page's own scripts and in the agent's world, and a subclass makes what the guard does", async () => {
  await env.inSpace("guard shape", async page => {
    await page.goto(`${env.base}/nav-target?guard-shape`);
    const realms = {
      page: await asPage(page, `(${shapes})(${JSON.stringify(NAMES)})`),
      world: await page.evaluate(shapes, NAMES),
    };
    for (const [realm, got] of Object.entries(realms)) {
      for (const name of NAMES) {
        const r = got[name];
        const where = `${name} in ${realm === "page" ? "the page's own scripts" : "the agent's world"}`;
        const { direct, viaSubclass, ...shape } = r;
        // toString has the native marker, and not the interface's name: that
        // was so before the guards were made in chrome, too.
        assert.deepEqual(
          shape,
          {
            name,
            length: LENGTH[name],
            ownProto: true,
            protoConstructor: true,
            instanceProto: true,
            instanceOf: true,
            nativeMarker: true,
            noWrapper: true,
            subclass: true,
          },
          where
        );
        // BroadcastChannel builds: it's scoped, not refused.
        const makes = MAKES[realm][name];
        assert.deepEqual({ direct, viaSubclass }, { direct: makes, viaSubclass: makes }, `${where}: a subclass makes what the guard does`);
      }
    }
  });
});
