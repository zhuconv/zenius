/* Agent Sidebar: the panel and All tasks as a script reads and drives them.
 * The post-install self-check's scenarios (selfcheck.sys.mjs) and the tests
 * (tests/ux) share it, so both go by one set of the sidebar's ids and classes
 * (the scenarios' private helpers, lifted here by zen-ux at zen-core's ask).
 *
 * sidebarView(win) works in a browser window, whose glue is
 * agent-sidebar.uc.js's, and in the self-check's window, which
 * selfcheck.sys.mjs's prepare gives a glue of its own and the same parts:
 * the panel's browser (#sidebar) in #sidebar-box, and All tasks' layer
 * (#zenius-sidebar-directory). Its waits throw when they run out, and stop
 * when `signal` aborts.
 */

// How long a wait goes on before it fails.
const WAIT_MS = 15000;
// The most a frame is waited for: the self-check's window may paint none
// (behind the user's, or offscreen), and its checks still get on.
const FRAME_MS = 100;

/** A run its signal stopped. */
export class Stopped extends Error {
  constructor() {
    super("the self-check stopped");
    this.name = "Stopped";
  }
}

export function stopIfAborted(signal) {
  if (signal?.aborted) {
    throw new Stopped();
  }
}

/** Poll `fn` on the window's clock until it's true, `ms` passes or the run stops. */
export async function waitFor(fn, { win, ms = WAIT_MS, signal = null, what = "the sidebar" } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    stopIfAborted(signal);
    let value = false;
    try {
      value = await fn();
    } catch {}
    if (value) {
      return value;
    }
    if (Date.now() > end || win.closed) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise(resolve => win.setTimeout(resolve, 25));
  }
}

/** An element's box in its window, in whole CSS pixels, as a shot takes it. */
export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

/** The box that holds both. */
export function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The sidebar of window `win`: its panel (in its own document) and All
 * tasks' drawer (in the window's).
 *
 * @param {Window} win
 * @param {{signal?: AbortSignal, frameMs?: number|null}} [options]
 *   frameMs: the most each of frames()'s frames is waited for; null waits
 *   for the frame itself, as a test that reads what a frame drew needs.
 */
export function sidebarView(win, { signal = null, frameMs = FRAME_MS } = {}) {
  const glue = () => win.ucAgentSidebar;
  const browser = () => win.document.getElementById("sidebar");
  const v = {
    win,
    pdoc: () => browser()?.contentDocument ?? null,
    $: id => v.pdoc()?.getElementById(id) ?? null,
    /** The conversation the panel shows: Work's task, or the tab's chat. */
    conv: () => (glue().mode === "work" ? glue().currentTask : glue().conversationFor(win.gBrowser?.selectedTab)),
    mode: () => glue().mode,

    until: (fn, what, ms = WAIT_MS) => waitFor(fn, { win, ms, signal, what }),
    sleep: ms => new Promise(resolve => win.setTimeout(resolve, ms)),
    /** `n` of the panel's frames, each waited for at most `frameMs`. */
    async frames(n) {
      const pwin = v.pdoc()?.defaultView ?? win;
      for (let i = 0; i < n; i++) {
        stopIfAborted(signal);
        await new Promise(resolve => {
          pwin.requestAnimationFrame(() => resolve());
          if (frameMs != null) {
            win.setTimeout(resolve, frameMs);
          }
        });
      }
    },

    visible(el) {
      return !!el && !el.hidden && el.ownerDocument.defaultView.getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
    },
    click(el) {
      if (!el) {
        throw new Error("expected an element to click");
      }
      el.click();
    },

    // --- The question box and the chat ---

    /** Words in the box, as the user types them. */
    type(text) {
      const input = v.$("input");
      input.value = text;
      input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
    },
    /** Type into the box and press Enter, as the user sends. */
    send(text) {
      v.type(text);
      const input = v.$("input");
      input.dispatchEvent(new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    },
    lastAnswer: () => v.conv().messages.findLast(m => m.role === "assistant")?.text ?? "",
    lastUser: () => [...v.pdoc().querySelectorAll(".msg.user")].at(-1) ?? null,
    /** Is the chat at its end, as the panel's following has it? */
    atEnd() {
      const m = v.$("messages");
      return m.scrollHeight - m.scrollTop - m.clientHeight < 2;
    },
    inView(el) {
      if (!el) {
        return false;
      }
      const box = v.$("messages").getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    },
    /**
     * Scroll the chat as the user does. A user's scroll sends its scroll
     * events as it goes, and the panel takes one up from the end as theirs
     * (panel.js's following); one assignment's event comes a frame later,
     * after an answer's render may have taken the view back to the end.
     */
    async scrollTo(top) {
      const m = v.$("messages");
      m.scrollTop = top;
      m.dispatchEvent(new (m.ownerDocument.defaultView.Event)("scroll"));
      await v.frames(3);
    },

    // --- The ⋯ menu ---

    /** The ⋯ menu's items as it shows them, by id: words, key hint and tooltip. */
    async openMenu() {
      if (v.$("menu").hidden) {
        v.click(v.$("more"));
      }
      await v.until(() => !v.$("menu").hidden, "the ⋯ menu");
      const items = {};
      for (const button of v.$("menu").querySelectorAll("button:not([hidden])")) {
        items[button.id] = {
          label: [...button.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim(),
          kbd: button.querySelector(".kbd")?.textContent ?? null,
          tip: button.title,
        };
      }
      return items;
    },
    closeMenu() {
      if (!v.$("menu").hidden) {
        v.click(v.$("more"));
      }
    },

    // --- All tasks ---

    /** All tasks' layer, hidden while closed. */
    drawer: () => win.document.getElementById("zenius-sidebar-directory"),
    /** A task's row, by its uid or the task. */
    row(task) {
      const uid = typeof task === "string" ? task : task?.uid;
      return uid ? (v.drawer()?.querySelector(`.asb-dir-row[data-task="${uid}"]`) ?? null) : null;
    },
    /** The group a row is under: the heading before it. */
    groupOf(row) {
      let el = row?.previousElementSibling ?? null;
      while (el && !el.classList.contains("asb-dir-group")) {
        el = el.previousElementSibling;
      }
      return el?.dataset.group ?? null;
    },
    /** Open All tasks from the panel's button, and wait out its slide in (directory.css). */
    async openDirectory() {
      if (!glue().directoryOpen) {
        v.click(v.$("dir"));
      }
      await v.until(() => glue().directoryOpen && v.drawer()?.querySelector(".asb-dir")?.classList.contains("open"), "All tasks");
      await v.sleep(250);
    },

    // --- Where things are, for a shot ---

    panelRect: () => rectOf(win.document.getElementById("sidebar-box")),
    directoryRect: () => union(rectOf(v.drawer().querySelector(".asb-dir")), v.panelRect()),
  };
  return v;
}
