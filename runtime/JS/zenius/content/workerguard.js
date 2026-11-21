// The storage refusals in workers (zen-observe): see content/refusals.sys.mjs.
// This classic script runs in the debugger global of a worker that a page of
// an agent task started. Gecko holds the worker until this script reports
// back, so the refusals are in the worker's own realm before its script runs.
// There, serviceWorker.register() and Cache's put, add and addAll reject as
// they do in the page, the site's own service worker is hidden as it is
// from the page (no registration, a ready that never settles, no
// controller, a dropped postMessage, and its messages to the worker never
// arrive), and notifications are refused: new Notification() gives one that
// only errs, and showNotification() rejects. A BroadcastChannel's name gets
// the page's scope, so the worker hears only its task's documents.
//
// A worker with no tab (a task's shared worker, or a worker under one) gets
// its mark too: the workers it starts from a URL carry it in the URL's
// fragment, so their requests' loading principal shows whose they are, and
// the parent keeps them from the site's worker (observe/swbypass.sys.mjs).
// A blob: worker's principal is the origin's, which no mark reaches
// (docs/research/observe.md has what that leaves).
//
// The worker's realm can't call into this global, so a breakpoint at the
// start of the function every refusal calls tells of each one, by its kind.
// The worker stays a debuggee with that one breakpoint; nothing else is
// watched.
"use strict";

// A Notification that only errs, as where the user blocks notifications.
// content/refusals.sys.mjs has the same text for pages (a test compares them).
const FAKE_NOTIFICATION = `function fakeNotification(Native, title, options, newTarget) {
  const n = new EventTarget();
  Object.setPrototypeOf(n, (newTarget && newTarget.prototype) || Native.prototype);
  const o = options !== null && typeof options === "object" ? options : {};
  const fields = {
    title: String(title), dir: o.dir ?? "auto", lang: String(o.lang ?? ""), body: String(o.body ?? ""),
    tag: String(o.tag ?? ""), icon: String(o.icon ?? ""), image: String(o.image ?? ""), badge: String(o.badge ?? ""),
    data: o.data ?? null, silent: o.silent ?? null, requireInteraction: !!o.requireInteraction, renotify: !!o.renotify,
    timestamp: Date.now(), vibrate: [], actions: [],
  };
  for (const key of Object.keys(fields)) {
    Object.defineProperty(n, key, { value: fields[key], configurable: true });
  }
  Object.defineProperty(n, "close", { value: function close() {}, writable: true, configurable: true });
  for (const type of ["click", "show", "error", "close"]) {
    let handler = null;
    n.addEventListener(type, e => { if (typeof handler === "function") handler.call(n, e); });
    Object.defineProperty(n, "on" + type, { get: () => handler, set: v => { handler = typeof v === "function" ? v : null; }, configurable: true });
  }
  setTimeout(() => n.dispatchEvent(new Event("error")), 0);
  return n;
}`;

// Evaluated in the worker's realm, before its own script. It returns the
// function every refusal calls with its kind, for the breakpoint.
const SOURCE = `(() => {
  const apply = Reflect.apply;
  const reject = Promise.reject.bind(Promise);
  const resolve = Promise.resolve.bind(Promise);
  const NativePromise = Promise;
  const Exception = DOMException;
  const Type = TypeError;
  const construct = Reflect.construct;
  const insecure = () => reject(new Exception("The operation is insecure.", "SecurityError"));
  const refused = function zeniusRefused(kind, api) {
    return kind;
  };
  const replace = (proto, name, native, fn) => {
    Object.defineProperty(fn, "length", { value: native.length });
    Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: true, configurable: true });
  };
  const refuse = (proto, name, kind) => {
    const native = proto && proto[name];
    if (typeof native !== "function") {
      return;
    }
    replace(proto, name, native, { [name]() { refused(kind); return insecure(); } }[name]);
  };
  refuse(self.ServiceWorkerContainer && ServiceWorkerContainer.prototype, "register", "serviceWorker");
  // The site's own service worker, registered from the user's tabs, runs
  // for them, outside the task. Its registration would let the worker post
  // to it, and it would do on the task's behalf whatever its code does with
  // a message. To the worker the site has none, as to its page
  // (content/refusals.sys.mjs, guardServiceWorkerAccess).
  const container = self.ServiceWorkerContainer && ServiceWorkerContainer.prototype;
  let swContainer = null;
  if (container) {
    try {
      swContainer = self.navigator && navigator.serviceWorker;
    } catch {}
    const answers = { getRegistration: () => resolve(undefined), getRegistrations: () => resolve([]) };
    for (const name of Object.keys(answers)) {
      const native = container[name];
      if (typeof native === "function") {
        replace(container, name, native, { [name]() { refused("serviceWorkerAccess", name); return answers[name](); } }[name]);
      }
    }
    let pending = null;
    const getters = {
      get ready() { refused("serviceWorkerAccess", "ready"); return pending || (pending = new NativePromise(() => {})); },
      get controller() { refused("serviceWorkerAccess", "controller"); return null; },
    };
    for (const name of Object.keys(getters)) {
      const native = Object.getOwnPropertyDescriptor(container, name);
      if (native && typeof native.get === "function") {
        const get = Object.getOwnPropertyDescriptor(getters, name).get;
        Object.defineProperty(container, name, { get, set: native.set, enumerable: native.enumerable, configurable: true });
      }
    }
  }
  const serviceWorker = self.ServiceWorker && ServiceWorker.prototype;
  if (serviceWorker && typeof serviceWorker.postMessage === "function") {
    replace(serviceWorker, "postMessage", serviceWorker.postMessage, { postMessage() { refused("serviceWorkerAccess", "postMessage"); } }.postMessage);
  }
  // Nor can the site's worker reach the worker first. Its
  // clients.matchAll({ includeUncontrolled: true }) lists a task's workers,
  // and a message it posts can carry a MessagePort that works both ways.
  // The worker's first listener, a capturing one, stops each message and
  // closes its ports, with the natives of now, before the worker's code.
  if (swContainer) {
    const stop = Event.prototype.stopImmediatePropagation;
    const portsOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "ports").get;
    const closePort = MessagePort.prototype.close;
    const drop = function (event) {
      // isTrusted is each event's own, unforgeable: the worker's own dispatched events pass.
      if (event.isTrusted !== true) {
        return;
      }
      apply(stop, event, []);
      let ports = [];
      try {
        ports = apply(portsOf, event, []);
      } catch {}
      for (let i = 0; i < ports.length; i++) {
        try {
          apply(closePort, ports[i], []);
        } catch {}
      }
      refused("serviceWorkerMessage");
    };
    const listen = EventTarget.prototype.addEventListener;
    apply(listen, swContainer, ["message", drop, true]);
    apply(listen, swContainer, ["messageerror", drop, true]);
  }
  for (const name of ["put", "add", "addAll"]) {
    refuse(self.Cache && Cache.prototype, name, "cacheStorage");
  }
  const registration = self.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype;
  if (registration && typeof registration.showNotification === "function") {
    replace(registration, "showNotification", registration.showNotification, {
      showNotification() {
        refused("notification", "showNotification");
        return reject(new Type("Permission to show Notification denied."));
      },
    }.showNotification);
  }
  if (typeof self.Notification === "function") {
    const Native = Notification;
    ${FAKE_NOTIFICATION}
    const wrapped = new Proxy(Native, {
      construct(target, args, newTarget) {
        const nt = newTarget === wrapped ? target : newTarget;
        if (args.length < 1) {
          return construct(target, args, nt);
        }
        const title = String(args[0]);
        refused("notification", "Notification");
        return fakeNotification(Native, title, args[1], nt);
      },
    });
    Object.defineProperty(Native.prototype, "constructor", { value: wrapped, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(self, "Notification", { value: wrapped, writable: true, enumerable: false, configurable: true });
  }
  return refused;
})()`;

// Evaluated in the realm of a worker with no tab, with zeniusMark bound,
// before the worker's own script: the workers it starts from a URL get the
// mark in the URL's fragment, as a task page's shared workers do
// (content/refusals.sys.mjs, guardSharedWorkers). The natives are taken now.
const WORKER_MARK = `(() => {
  const Native = self.Worker;
  if (typeof Native !== "function") {
    return true;
  }
  const mark = zeniusMark;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const toString = String;
  const sliceOf = String.prototype.slice;
  const NativeURL = URL;
  const accessor = name => Object.getOwnPropertyDescriptor(NativeURL.prototype, name);
  const hrefOf = accessor("href").get;
  const protocolOf = accessor("protocol").get;
  const hashOf = accessor("hash").get;
  const setHash = accessor("hash").set;
  // The worker's URL is read when it starts a worker: before its script has
  // loaded, its location reads empty, and stays so once read.
  const global = self;
  const locationOf = Object.getOwnPropertyDescriptor(WorkerGlobalScope.prototype, "location").get;
  const locationHref = Object.getOwnPropertyDescriptor(WorkerLocation.prototype, "href").get;
  const wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const nt = newTarget === wrapped ? target : newTarget;
      if (args.length < 1) {
        return construct(target, args, nt);
      }
      let url = toString(args[0]);
      let parsed = null;
      try {
        parsed = construct(NativeURL, [url, apply(locationHref, apply(locationOf, global, []), [])]);
      } catch {}
      // A blob: or data: worker's principal isn't made from its URL.
      const protocol = parsed ? apply(protocolOf, parsed, []) : "";
      if (parsed && protocol !== "blob:" && protocol !== "data:") {
        const hash = apply(hashOf, parsed, []);
        apply(setHash, parsed, [hash ? apply(sliceOf, hash, [1]) + "&" + mark : mark]);
        url = apply(hrefOf, parsed, []);
      }
      return construct(target, args.length > 1 ? [url, args[1]] : [url], nt);
    },
  });
  Object.defineProperty(Native.prototype, "constructor", { value: wrapped, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(self, "Worker", { value: wrapped, writable: true, enumerable: false, configurable: true });
  return true;
})()`;

(function guardWorker() {
  const state = { ready: true };
  let worker = null;
  try {
    const dbg = new Debugger();
    worker = dbg.addDebuggee(global);
    const completion = worker.executeInGlobal(SOURCE);
    if (!completion || !("return" in completion) || !(completion.return instanceof Debugger.Object)) {
      throw new Error(completion && "throw" in completion ? `the guard threw: ${String(completion.throw)}` : "the guard didn't run");
    }
    const script = completion.return.script;
    const [offset] = script.getPossibleBreakpointOffsets();
    script.setBreakpoint(offset, {
      hit(frame) {
        const [kind, api] = frame.arguments;
        if (typeof kind === "string") {
          try {
            postMessage(JSON.stringify({ refused: kind, api: typeof api === "string" ? api : undefined }));
          } catch {}
        }
        return undefined;
      },
    });
  } catch (e) {
    state.ready = false;
    state.error = String(e);
  }
  // Then the worker's BroadcastChannel, scoped as its page's, and for a
  // worker with no tab its mark (content/refusals.sys.mjs sends the wrapper,
  // the scope and the mark right after starting this script). Only then is
  // the worker told it may run.
  const onScope = event => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch {}
    if (!message || typeof message.channelScope !== "string" || typeof message.channelGuard !== "string") {
      return;
    }
    removeEventListener("message", onScope);
    if (state.ready) {
      try {
        const completion = worker.executeInGlobal(
          `(() => {
            const wrapped = (${message.channelGuard})(self.BroadcastChannel, () => ${JSON.stringify(message.channelScope)});
            if (wrapped) {
              Object.defineProperty(self, "BroadcastChannel", { value: wrapped, writable: true, enumerable: false, configurable: true });
            }
            return true;
          })()`
        );
        if (!completion || !("return" in completion)) {
          throw new Error(completion && "throw" in completion ? `the channel guard threw: ${String(completion.throw)}` : "the channel guard didn't run");
        }
        if (typeof message.workerMark === "string") {
          const marked = worker.executeInGlobalWithBindings(WORKER_MARK, { zeniusMark: message.workerMark });
          if (!marked || !("return" in marked)) {
            throw new Error(marked && "throw" in marked ? `the worker mark threw: ${String(marked.throw)}` : "the worker mark didn't run");
          }
        }
      } catch (e) {
        state.ready = false;
        state.error = String(e);
      }
    }
    postMessage(JSON.stringify(state));
  };
  addEventListener("message", onScope);
})();
