/* Agent Sidebar, the directory of tasks: a drawer that slides out from under
 * the sidebar's page-side edge, over the page, so the page doesn't reflow.
 *
 * It lists every task (AgentService.tasks, shared by the windows) in three
 * groups, Needs you, Working and Done, each row with the task's name, one
 * line of status and its age. The current task is expanded to its tabs in
 * the Agents space. '+ New task' and a search field are at the top. A click
 * on a row shows that task in the sidebar; a click outside, or Esc, closes
 * the drawer.
 *
 * The drawer is chrome DOM in the browser window, in #tabbrowser-tabbox with
 * the sidebar, and one per window: agent-sidebar.uc.js makes it the first
 * time the user opens it.
 */

import { AgentService, STATE_LABELS, age } from "./AgentService.sys.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const SHEET = new URL("directory.css", import.meta.url).href;
const GROUPS = [
  ["needs", "Needs you"],
  ["working", "Working"],
  ["done", "Done"],
];
const WIDTH = 264;
// How far the drawer reaches under the sidebar, so it seems to come from there.
const TUCK = 14;
const CLOSE_MS = 180;
const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

export class Directory {
  /**
   * @param {Window} win  the browser window
   * @param {object} glue  its window.ucAgentSidebar
   */
  constructor(win, glue) {
    this.win = win;
    this.doc = win.document;
    this.glue = glue;
    this.isOpen = false;
    this.active = null; // the row the arrow keys are on: a task's uid
    this.cleanups = [];
    this.closeTimer = null;
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    this.cleanups.push(() => win.windowUtils.removeSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET));
    this.build();
    this.cleanups.push(AgentService.subscribeTasks(() => this.scheduleRender()));
  }

  el(tag, className, text) {
    const el = this.doc.createElementNS(HTML, tag);
    if (className) {
      el.className = className;
    }
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  build() {
    // In browser.xhtml, so its id has the zenius-sidebar- prefix: no clash
    // with Zen's ids or another script's.
    this.layer = this.el("div", "asb-dir-layer");
    this.layer.id = "zenius-sidebar-directory";
    this.layer.hidden = true;
    this.scrim = this.el("div", "asb-dir-scrim");
    this.drawer = this.el("div", "asb-dir");
    this.drawer.setAttribute("role", "dialog");
    this.drawer.setAttribute("aria-label", "Tasks");

    const head = this.el("div", "asb-dir-head");
    head.append(this.el("div", "asb-dir-title", "Work"));
    this.newButton = this.el("button", "asb-dir-new", "+ New task");
    this.newButton.title = "A new task for the agent";
    head.append(this.newButton);

    const search = this.el("label", "asb-dir-search");
    this.input = this.el("input");
    this.input.type = "search";
    this.input.placeholder = "Search tasks";
    this.input.setAttribute("aria-label", "Search tasks");
    search.append(this.el("span", "asb-dir-glass"), this.input);

    this.list = this.el("div", "asb-dir-list");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Tasks");

    this.drawer.append(head, search, this.list);
    this.layer.append(this.scrim, this.drawer);

    const listen = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      this.cleanups.push(() => target.removeEventListener(type, fn, options));
    };
    // A click on the page closes the drawer, and goes no further: it was
    // meant for the drawer, not for a link under it.
    listen(this.scrim, "mousedown", event => {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.win.gBrowser.selectedBrowser.focus();
    });
    // Elsewhere in the window's chrome (the tabs, the toolbar), a click
    // closes it and does what it does. The sidebar's panel closes it itself.
    listen(
      this.win,
      "mousedown",
      event => {
        if (this.isOpen && event.target.ownerDocument === this.doc && !this.layer.contains(event.target)) {
          const box = this.doc.getElementById("sidebar-box");
          if (!box?.contains(event.target)) {
            this.close();
          }
        }
      },
      true
    );
    listen(this.newButton, "click", () => {
      this.close();
      this.glue.newTask();
    });
    listen(this.input, "input", () => {
      this.active = null;
      this.render();
    });
    listen(this.drawer, "keydown", event => this.onKey(event));
    listen(this.list, "click", event => {
      const row = event.target.closest(".asb-dir-row");
      const chip = event.target.closest(".asb-dir-tab");
      if (row && chip?.tabRef) {
        // One of the shown task's tabs: watch the task on it.
        this.close();
        this.glue.watch(row.dataset.task, { tab: chip.tabRef });
      } else if (row) {
        this.pick(row.dataset.task);
      }
    });
    listen(this.win, "resize", () => this.isOpen && this.place());

    this.host().append(this.layer);
    this.resizeObserver = new this.win.ResizeObserver(() => this.isOpen && this.place());
    const box = this.doc.getElementById("sidebar-box");
    if (box) {
      this.resizeObserver.observe(box);
    }
  }

  /** The element the drawer lives in: the sidebar's own container. */
  host() {
    return this.doc.getElementById("tabbrowser-tabbox") ?? this.doc.getElementById("browser");
  }

  /** Put the drawer at the sidebar's page-side edge, as tall as the sidebar. */
  place() {
    const box = this.doc.getElementById("sidebar-box");
    const host = this.layer.parentElement;
    if (!box || !host) {
      return;
    }
    const b = box.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    // The sidebar on the right (Zen's default for reading panels): the drawer
    // comes out of its left edge; on the left, out of its right edge.
    const right = b.left + b.width / 2 > h.left + h.width / 2;
    const width = Math.min(WIDTH, Math.max(200, (right ? b.left - h.left : h.right - b.right) - 8 + TUCK));
    this.drawer.dataset.side = right ? "left" : "right";
    this.drawer.style.top = `${b.top - h.top}px`;
    this.drawer.style.height = `${b.height}px`;
    this.drawer.style.width = `${width}px`;
    this.drawer.style.left = `${right ? b.left - h.left - width + TUCK : b.right - h.left - TUCK}px`;
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    const box = this.doc.getElementById("sidebar-box");
    if (!box || box.hidden || !this.glue.panel) {
      return;
    }
    this.win.clearTimeout(this.closeTimer);
    this.isOpen = true;
    this.active = null;
    box.setAttribute("data-zenius-directory", "");
    this.layer.hidden = false;
    this.place();
    this.render();
    // The next frame, so the drawer slides in from under the sidebar.
    this.win.requestAnimationFrame(() =>
      this.win.requestAnimationFrame(() => this.isOpen && this.drawer.classList.add("open"))
    );
    this.input.focus();
    this.tick = this.win.setInterval(() => this.render(), 30000);
    this.glue.panel?.directoryChanged(true);
  }

  close({ now = false } = {}) {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.win.clearInterval(this.tick);
    this.drawer.classList.remove("open");
    this.glue.panel?.directoryChanged(false);
    const done = () => {
      if (!this.isOpen) {
        this.layer.hidden = true;
        this.doc.getElementById("sidebar-box")?.removeAttribute("data-zenius-directory");
      }
    };
    if (now) {
      done();
    } else {
      this.closeTimer = this.win.setTimeout(done, CLOSE_MS);
    }
  }

  destroy() {
    this.close({ now: true });
    this.resizeObserver?.disconnect();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {}
    }
    this.layer.remove();
  }

  /** Show a task in the sidebar, and close. */
  pick(uid) {
    const conv = AgentService.tasks.get(uid);
    if (!conv) {
      return;
    }
    this.close();
    this.glue.showTask(conv);
    this.glue.panel?.focus();
  }

  scheduleRender() {
    if (this.isOpen && !this.frame) {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }

  /** The tasks that match the search, by group, newest first. */
  groups() {
    const query = this.input.value.trim().toLowerCase();
    const tasks = AgentService.taskList().filter(
      conv => !query || `${conv.title}\n${conv.task.text}`.toLowerCase().includes(query)
    );
    return GROUPS.map(([state, label]) => ({
      state,
      label,
      tasks: tasks
        .filter(conv => (conv.task.state === "new" ? "working" : conv.task.state) === state)
        .sort((a, b) => b.task.since - a.task.since),
    })).filter(group => group.tasks.length);
  }

  render() {
    if (!this.isOpen) {
      return;
    }
    const current = this.glue.mode === "work" ? this.glue.currentTask : null;
    const groups = this.groups();
    const rows = groups.flatMap(group => group.tasks);
    if (this.active && !rows.some(conv => conv.uid === this.active)) {
      this.active = null;
    }
    const parts = [];
    for (const group of groups) {
      const heading = this.el("div", "asb-dir-group", group.label);
      heading.dataset.group = group.state;
      parts.push(heading);
      for (const conv of group.tasks) {
        parts.push(this.row(conv, conv === current));
      }
    }
    if (!parts.length) {
      parts.push(
        this.el(
          "div",
          "asb-dir-empty",
          this.input.value.trim()
            ? "No task matches."
            : "No tasks yet. Start one with + New task, or type > and the task in the address bar."
        )
      );
    }
    this.list.replaceChildren(...parts);
  }

  row(conv, isCurrent) {
    const { state, since, text } = conv.task;
    const row = this.el("div", "asb-dir-row");
    row.dataset.task = conv.uid;
    row.dataset.state = state;
    if (isCurrent) {
      row.dataset.current = "true";
    }
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(isCurrent));
    row.classList.toggle("current", isCurrent);
    row.classList.toggle("active", this.active === conv.uid);
    row.title = `${conv.title}\n${STATE_LABELS[state] ?? ""}${text ? `: ${text}` : ""}`;

    const top = this.el("div", "asb-dir-rt");
    top.append(this.el("span", "asb-dot"), this.el("b", "", conv.title), this.el("span", "asb-dir-age", age(since)));
    row.append(top);
    row.append(this.el("div", "asb-dir-rd", text || STATE_LABELS[state] || ""));
    if (state === "working") {
      row.append(this.el("div", "asb-dir-bar"));
    }
    if (isCurrent) {
      const tabs = AgentService.zenTabs(conv);
      if (tabs.length) {
        const box = this.el("div", "asb-dir-tabs");
        for (const info of tabs) {
          const item = this.el("span", "asb-dir-tab");
          const icon = this.el("img");
          icon.src = info.image || DEFAULT_FAVICON;
          icon.alt = "";
          icon.addEventListener("error", () => (icon.src = DEFAULT_FAVICON), { once: true });
          let host = "";
          try {
            host = Services.io.newURI(info.url).displayHost;
          } catch {}
          item.append(icon, this.el("span", "", host || info.title || info.url));
          item.title = [info.title, info.url, "Click to watch it"].filter(Boolean).join("\n");
          item.tabRef = info.tab;
          box.append(item);
        }
        row.append(box);
      }
    }
    return row;
  }

  onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.glue.panel?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") {
      return;
    }
    const uids = this.groups().flatMap(group => group.tasks.map(conv => conv.uid));
    if (event.key === "Enter") {
      const uid = this.active ?? (this.input.value.trim() ? uids[0] : null);
      if (uid && event.target !== this.newButton) {
        event.preventDefault();
        this.pick(uid);
      }
      return;
    }
    event.preventDefault();
    if (!uids.length) {
      return;
    }
    const i = uids.indexOf(this.active);
    const next = i < 0 ? (event.key === "ArrowDown" ? 0 : uids.length - 1) : (i + (event.key === "ArrowDown" ? 1 : -1) + uids.length) % uids.length;
    this.active = uids[next];
    this.render();
    this.list.querySelector(".asb-dir-row.active")?.scrollIntoView({ block: "nearest" });
  }
}
