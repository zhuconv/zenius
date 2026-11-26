// Child half of the "ZeniusSystemUi" actor (the UI): page APIs that would
// open the operating system's UI over the user's view, in a tab the agent
// drives.
//
// - Passkeys (navigator.credentials.create() and get() with publicKey). On
//   the Mac, macOS shows its passkey sheet on the window. The call waits,
//   and the Space goes to the user as for a permission prompt
//   (permission_prompt). The native call runs once the user holds the Space
//   and looks at this tab, so the sheet opens in front of them. If they hand
//   back first, the page gets NotAllowedError, as when a user cancels.
//   Conditional requests (passkey autofill) need the user's own focus on a
//   field and pass through.
// - Notifications (new Notification(), registration.showNotification())
//   with permission already granted. On the Mac, a macOS notification. None
//   is shown. The page gets an ordinary-looking Notification (its show
//   event, close()), and the agent a Zenius.notification event with the
//   title and body.
//
// The guards install in every document of an agent task's tabs and decide
// per call, so a tab the user holds behaves natively.
//
// The core's Zenius actor makes this one only in a task's documents, at its
// DOMWindowCreated, and calls installGuards(). Its helpers load on first use,
// so nothing of the UI loads in a user's tab (the core's I4).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  isAgentDriven: "chrome://userscripts/content/zenius/content/taskset.sys.mjs",
  isAgentTaskPage: "chrome://userscripts/content/zenius/content/taskset.sys.mjs",
  pageError: "chrome://userscripts/content/zenius/ui/pagecall.sys.mjs",
  settle: "chrome://userscripts/content/zenius/ui/pagecall.sys.mjs",
});

const ACTOR = "ZeniusSystemUi";
let nextRequest = 1;
/**
 * Documents already guarded: each gets its guards once. Keyed by the
 * document, since contentWindow is the tab's WindowProxy, one object for
 * every document the tab loads in this process.
 */
const guarded = new WeakSet();

export class ZeniusSystemUiChild extends JSWindowActorChild {
  receiveMessage({ name }) {
    // The core asks when a tab joins a task after its document started.
    if (name === "installGuards") {
      this.installGuards();
    }
    return null;
  }

  /**
   * Guard this document if it's a task's: from the Zenius actor's
   * DOMWindowCreated, and when a tab joins a task after its document
   * started.
   * @returns {boolean} whether the guards went in now
   */
  installGuards() {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc || guarded.has(doc) || !lazy.isAgentTaskPage(this.browsingContext)) {
      return false;
    }
    guarded.add(doc);
    for (const guard of [guardPasskeys, guardNotifications]) {
      try {
        guard(win);
      } catch (e) {
        console.error(`[zenius] ${guard.name} failed`, e);
      }
    }
    return true;
  }
}

/** @param {Window} win */
function actorOf(win) {
  return win.windowGlobalChild?.getActor(ACTOR) ?? null;
}

// ---------------------------------------------------------------- passkeys

/** @param {Window} win */
function guardPasskeys(win) {
  const proto = Cu.waiveXrays(win).CredentialsContainer?.prototype;
  if (!proto) {
    // Not a secure context: no WebAuthn here.
    return;
  }
  const bc = win.browsingContext;
  const native = { create: proto.create, get: proto.get };
  const nativeCall = (name, self, args) => Reflect.apply(native[name], Cu.waiveXrays(self), args);

  const held = (name, self, args) => {
    const options = args.length ? Cu.waiveXrays(args[0]) : null;
    const signal = options?.signal;
    if (!lazy.isAgentDriven(bc) || !options?.publicKey || options.mediation === "conditional" || signal?.aborted) {
      return nativeCall(name, self, args);
    }
    const id = `${bc.browserId}:${nextRequest++}`;
    return lazy.settle(win, async () => {
      const actor = actorOf(win);
      let done = false;
      // How it ended, for the parent's count of requests left unanswered.
      let outcome = "error";
      const finish = () => {
        if (!done) {
          done = true;
          try {
            actor?.sendAsyncMessage("passkeyDone", { id, outcome });
          } catch {
            // The document is going away; the parent drops the hold then.
          }
        }
      };
      try {
        const aborted = new Promise(resolve => {
          signal?.addEventListener("abort", Cu.exportFunction(() => resolve(true), win), { once: true });
        });
        const answer = await Promise.race([actor.sendQuery("passkey", { id, op: name }), aborted]);
        if (answer === true) {
          outcome = "abort";
          throw { pageError: signal.reason };
        }
        if (!answer?.go) {
          throw lazy.pageError(win, "NotAllowedError", "The operation either timed out or was not allowed.");
        }
        // The user holds the Space and sees this tab: the OS sheet, if any,
        // opens in front of them.
        const credential = await nativeCall(name, self, args);
        outcome = "ok";
        return credential;
      } catch (e) {
        if (signal?.aborted) {
          outcome = "abort";
        }
        throw e;
      } finally {
        finish();
      }
    });
  };

  for (const name of ["create", "get"]) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof desc?.value !== "function") {
      continue;
    }
    const fn = {
      [name]() {
        return held(name, this, Array.from(arguments));
      },
    }[name];
    Object.defineProperty(proto, name, {
      value: Cu.exportFunction(fn, win),
      writable: desc.writable,
      enumerable: desc.enumerable,
      configurable: desc.configurable,
    });
  }
}

// ---------------------------------------------------------------- notifications

/** @param {Window} win */
function guardNotifications(win) {
  const page = Cu.waiveXrays(win);
  const Native = page.Notification;
  if (typeof Native !== "function") {
    // Not a secure context: no notifications here.
    return;
  }
  const bc = win.browsingContext;
  // The site's grant, through the native getter of now: the page can
  // redefine Notification.permission, which would turn the quiet path off.
  const permissionOf = Object.getOwnPropertyDescriptor(Native, "permission")?.get;
  const granted = () => {
    try {
      return typeof permissionOf === "function" && Reflect.apply(permissionOf, Native, []) === "granted";
    } catch {
      return false;
    }
  };
  const quiet = () => lazy.isAgentDriven(bc) && granted();

  // A Proxy keeps Notification.permission, requestPermission(), prototype and
  // instanceof as they are; only construction changes. Chrome's own Reflect:
  // the page's could be replaced, and would be handed the constructor beneath.
  const construct = (target, args, newTarget) => {
    const list = Cu.waiveXrays(args);
    if (!list.length || !quiet()) {
      return Reflect.construct(Native, list, Cu.waiveXrays(newTarget));
    }
    return quietNotification(win, Native, list[0], list[1]);
  };
  // A handler without a prototype: the page's Object.prototype can't add
  // traps to it or reach construct through an accessor.
  const handler = page.Object.create(null);
  handler.construct = Cu.exportFunction(construct, win);
  const proxy = new page.Proxy(Native, handler);
  const own = Object.getOwnPropertyDescriptor(page, "Notification");
  Object.defineProperty(page, "Notification", {
    value: proxy,
    writable: own?.writable ?? true,
    enumerable: own?.enumerable ?? false,
    configurable: own?.configurable ?? true,
  });
  // As the page guards do: Notification.prototype.constructor is the Proxy
  // too. Left as the one beneath, the page's own call through it would skip
  // the quiet path.
  Object.defineProperty(Native.prototype, "constructor", { value: proxy, writable: true, enumerable: false, configurable: true });

  // registration.showNotification() from this page (a service worker's own
  // calls run outside any page and aren't covered).
  const swProto = page.ServiceWorkerRegistration?.prototype;
  const desc = swProto && Object.getOwnPropertyDescriptor(swProto, "showNotification");
  if (typeof desc?.value === "function") {
    const nativeShow = desc.value;
    function showNotification() {
      const args = Array.from(arguments);
      if (!args.length || !quiet()) {
        return Reflect.apply(nativeShow, Cu.waiveXrays(this), args);
      }
      const options = args[1] ? Cu.waiveXrays(args[1]) : null;
      report(win, String(args[0]), options);
      return page.Promise.resolve();
    }
    Object.defineProperty(swProto, "showNotification", {
      value: Cu.exportFunction(showNotification, win),
      writable: desc.writable,
      enumerable: desc.enumerable,
      configurable: desc.configurable,
    });
  }
}

/** Tell the agent what the page wanted to show. */
function report(win, title, options) {
  const text = v => (v === undefined || v === null ? "" : String(v));
  try {
    actorOf(win)?.sendAsyncMessage("notification", {
      title,
      body: text(options?.body),
      tag: text(options?.tag),
      url: win.location.href,
    });
  } catch {
    // The document is going away.
  }
}

/**
 * A Notification the page can use as usual, with nothing shown: its own
 * fields, on* handlers, close(), and a show event as a shown one would fire.
 */
function quietNotification(win, Native, rawTitle, rawOptions) {
  const page = Cu.waiveXrays(win);
  const title = String(rawTitle);
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const text = v => (v === undefined || v === null ? "" : String(v));
  let icon = text(options.icon);
  try {
    icon = icon ? new win.URL(icon, win.location.href).href : "";
  } catch {}
  report(win, title, options);

  const n = new page.EventTarget();
  Object.setPrototypeOf(n, Native.prototype);
  const fields = {
    title,
    dir: text(options.dir) || "auto",
    lang: text(options.lang),
    body: text(options.body),
    tag: text(options.tag),
    icon,
    badge: "",
    image: "",
    data: options.data ?? null,
    requireInteraction: !!options.requireInteraction,
    silent: options.silent ?? null,
    renotify: !!options.renotify,
    timestamp: Number(options.timestamp ?? Date.now()),
    vibrate: Cu.cloneInto([], win),
    actions: Cu.cloneInto([], win),
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(n, key, { value, enumerable: true, configurable: true });
  }
  // on* handlers as listeners of the page's own function, like the native ones.
  for (const type of ["show", "click", "close", "error"]) {
    let handler = null;
    Object.defineProperty(n, `on${type}`, {
      get: Cu.exportFunction(() => handler, win),
      set: Cu.exportFunction(f => {
        if (handler) {
          n.removeEventListener(type, handler);
        }
        handler = typeof f === "function" ? f : null;
        if (handler) {
          n.addEventListener(type, handler);
        }
      }, win),
      enumerable: true,
      configurable: true,
    });
  }
  let closed = false;
  Object.defineProperty(n, "close", {
    value: Cu.exportFunction(function close() {
      if (!closed) {
        closed = true;
        n.dispatchEvent(new page.Event("close"));
      }
    }, win),
    writable: true,
    configurable: true,
  });
  win.setTimeout(() => {
    if (!closed) {
      n.dispatchEvent(new page.Event("show"));
    }
  }, 0);
  return n;
}
