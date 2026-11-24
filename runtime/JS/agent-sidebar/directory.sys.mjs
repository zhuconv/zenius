/* Agent Sidebar, the directory of tasks: a drawer that slides out from under
 * the sidebar's page-side edge, over the page, so the page doesn't reflow.
 *
 * It lists every task (AgentService.tasks, shared by the windows) in three
 * groups, Needs you, Working and Done, each row with the task's name, one
 * line of status and its age. The tasks the user pinned come first, in
 * Pinned, the last pinned first. The tasks the user archived come last, in
 * Archived: collapsed, with a count, and open while the shown task is one
 * of them; a search shows its matches there too. The current task is
 * expanded to its tabs in the Agents space. '+ New task' and a search field
 * are at the top. A click on a row shows that task in the sidebar; a click
 * outside, or Esc, closes the drawer.
 *
 * A right-click on a row, or the context-menu key or Shift+F10 on the row
 * the arrow keys are on, opens its menu: Pin or
 * Unpin, Rename, then Archive or Unarchive, in the ⋯ menu's words
 * (taskmenu.sys.mjs). Rename makes the row's name a field, as the header's
 * Rename does.
 *
 * The drawer is chrome DOM in the browser window, in #tabbrowser-tabbox with
 * the sidebar, and one per window: agent-sidebar.uc.js makes it the first
 * time the user opens it.
 */

import { AgentService, STATE_LABELS, age, remoteSource, taskName } from "./AgentService.sys.mjs";
import { externalSource, sourceParts } from "./external.sys.mjs";
import { TIPS, archivable, archiveTip } from "./taskmenu.sys.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const SHEET = new URL("directory.css", import.meta.url).href;
const GROUPS = [
  ["needs", "Needs you"],
  ["working", "Working"],
  ["done", "Done"],
];
// The arrow keys' key for an earlier chat's row: this, then the chat's uid.
// A task's row's is its uid.
const CHAT_KEY = "chat:";
const WIDTH = 264;
// How far the drawer reaches under the sidebar, so it seems to come from there.
const TUCK = 14;
const CLOSE_MS = 180;
const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";
const MENU_ID = "zenius-sidebar-directory-menu";

/** A remote task's address and label, or where an external task is driven from, as a search matches them. */
function sourceWords(conv) {
  if (conv.external) {
    return Object.values(conv.from ?? {}).filter(value => typeof value === "string").join("\n");
  }
  return conv.source === "remote" ? `${conv.remote?.address ?? ""}\n${conv.remote?.label ?? ""}` : "";
}

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
    this.active = null; // the row the arrow keys are on: a task's uid, or CHAT_KEY and an earlier chat's
    this.archivedOpen = false; // Archived shows its rows
    this.menuTask = null; // the uid of the row whose menu shows, or showed last
    this.renaming = null; // the row whose name is a field: {uid, field}
    this.menu = null; // the rows' menu (buildMenu); none in a self-check window
    this.cleanups = [];
    this.closeTimer = null;
    // A self-check window's directory lists its own tasks alone (glue.scope),
    // and has no row menu (build).
    this.scope = glue.scope ?? null;
    win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    this.cleanups.push(() => win.windowUtils.removeSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET));
    this.build();
    this.cleanups.push(AgentService.subscribeTasks(() => this.scheduleRender(), this.scope));
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

  /**
   * A remote task's source line ("From <label> on <address>", remoteSource),
   * its address, the last isolate, set apart as a chip, as in the panel
   * (fillSource, whose note says why the isolate's marks stay outside it).
   * An external task's line (externalSource) chips its terminal, and has no
   * chip without one. The text stays the same.
   */
  source(text, { chip = true } = {}) {
    const line = this.el("div", "asb-dir-src");
    // The address or the terminal is the phrase's last isolate ("From <label>
    // on <address>", "<agent> on <terminal>").
    const end = chip ? text.lastIndexOf("\u2069") : -1;
    const start = end < 0 ? -1 : text.lastIndexOf("\u2068", end);
    if (start < 0) {
      line.textContent = text;
    } else {
      line.append(text.slice(0, start + 1), this.el("span", "asb-dir-addr", text.slice(start + 1, end)), text.slice(end));
    }
    return line;
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
      this.glue.focusPage();
    });
    // Elsewhere in the window's chrome (the tabs, the toolbar), a click
    // closes it and does what it does. The sidebar's panel closes it itself.
    listen(
      this.win,
      "mousedown",
      event => {
        if (this.isOpen && event.target.ownerDocument === this.doc && !this.layer.contains(event.target) && !this.menu?.contains(event.target)) {
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
      if (event.target.closest(".asb-dir-archived")) {
        this.toggleArchived();
        return;
      }
      const row = event.target.closest(".asb-dir-row");
      const chip = event.target.closest(".asb-dir-tab");
      if (row && chip?.tabRef) {
        // One of the shown task's tabs: watch the task on it.
        this.close();
        this.glue.watch(row.dataset.task, { tab: chip.tabRef });
      } else if (row?.dataset.chat) {
        this.openChat(row.dataset.chat);
      } else if (row) {
        this.pick(row.dataset.task);
      }
    });
    listen(this.win, "resize", () => this.isOpen && this.place());
    // A right-click on a row opens its menu; the keys' menu comes from onKey.
    // A self-check window's rows have none: a pin or a name there would go to
    // the user's tasks file.
    if (!this.scope) {
      listen(this.drawer, "contextmenu", event => this.onContextMenu(event));
      this.buildMenu(listen);
    }

    this.host().append(this.layer);
    this.resizeObserver = new this.win.ResizeObserver(() => this.isOpen && this.place());
    const box = this.doc.getElementById("sidebar-box");
    if (box) {
      this.resizeObserver.observe(box);
    }
  }

  /**
   * The rows' menu: a XUL menu, as Zen's own context menus are, so it has
   * their look, keys and accessibility. One per window, in its popup set.
   */
  buildMenu(listen) {
    this.menu = this.doc.createXULElement("menupopup");
    this.menu.id = MENU_ID;
    this.menuItems = {};
    for (const id of ["pin", "rename", "archive"]) {
      const item = this.doc.createXULElement("menuitem");
      item.id = `zenius-sidebar-directory-${id}`;
      item.dataset.command = id;
      this.menuItems[id] = item;
    }
    this.menuSeparator = this.doc.createXULElement("menuseparator");
    this.menu.append(this.menuItems.pin, this.menuItems.rename, this.menuSeparator, this.menuItems.archive);
    (this.doc.getElementById("mainPopupSet") ?? this.doc.documentElement).append(this.menu);
    this.cleanups.push(() => this.menu.remove());
    listen(this.menu, "command", event => this.onMenuCommand(event.target.dataset?.command));
  }

  /**
   * A right-click on a row: its menu where the pointer is. The keys' own
   * contextmenu event (where the platform sends one) goes to the search
   * field, and opens the menu of the row the arrow keys are on, else the
   * field's own. A row's name field keeps its own (cut, copy, paste).
   */
  onContextMenu(event) {
    if (this.menu.state !== "closed") {
      event.preventDefault();
      return;
    }
    if (event.target.closest?.(".asb-dir-rename")) {
      return;
    }
    const row = event.target.closest?.(".asb-dir-row");
    const keys = event.mozInputSource === this.win.MouseEvent.MOZ_SOURCE_KEYBOARD;
    if (row?.dataset.task && !keys) {
      event.preventDefault();
      this.openMenu(row.dataset.task, { x: event.screenX, y: event.screenY });
    } else if (keys && this.active && !this.active.startsWith(CHAT_KEY)) {
      event.preventDefault();
      this.openMenu(this.active);
    }
  }

  /**
   * The menu of task `uid`: at `at` (screen pixels), else under its row.
   * Pin or Unpin, none on an archived task (Archive unpins), and Pin shown
   * disabled once Pinned is full; Rename, the sidebar's own name for a task
   * another program drives; then Archive or Unarchive, as the ⋯ menu has it.
   */
  openMenu(uid, at = null) {
    const conv = AgentService.taskByUid(uid, this.scope);
    if (conv?.kind !== "work") {
      return;
    }
    this.menuTask = uid;
    const { pin, rename, archive } = this.menuItems;
    const full = !conv.pinnedAt && !AgentService.canPin(this.scope);
    pin.hidden = !!conv.archivedAt;
    pin.setAttribute("label", conv.pinnedAt ? "Unpin" : "Pin");
    pin.setAttribute("tooltiptext", conv.pinnedAt ? TIPS.unpin : full ? TIPS.pinFull : TIPS.pin);
    if (full) {
      pin.setAttribute("disabled", "true");
    } else {
      pin.removeAttribute("disabled");
    }
    rename.setAttribute("label", "Rename");
    rename.setAttribute("tooltiptext", conv.external ? TIPS.renameExternal : TIPS.rename);
    archive.hidden = this.menuSeparator.hidden = !archivable(conv);
    archive.setAttribute("label", conv.archivedAt ? "Unarchive" : "Archive");
    archive.setAttribute("tooltiptext", archive.hidden ? "" : archiveTip(conv));
    if (at) {
      this.menu.openPopupAtScreen(at.x, at.y, true);
    } else {
      this.menu.openPopup(this.rowOf(uid), "after_start", 0, 0, true);
    }
  }

  onMenuCommand(command) {
    const conv = AgentService.taskByUid(this.menuTask, this.scope);
    if (!conv) {
      return;
    }
    if (command === "pin") {
      if (conv.pinnedAt) {
        AgentService.unpinTask(conv);
      } else {
        AgentService.pinTask(conv);
      }
    } else if (command === "rename") {
      this.startRename(conv.uid);
    } else if (command === "archive" && archivable(conv)) {
      if (conv.archivedAt) {
        AgentService.unarchiveTask(conv);
        return;
      }
      AgentService.archiveTask(conv);
      // The panel moves on from it, as from the ⋯ menu's Archive.
      if (this.glue.mode === "work" && this.glue.currentTask === conv) {
        this.glue.leaveTask(conv);
      }
    }
  }

  rowOf(uid) {
    return [...this.list.querySelectorAll(".asb-dir-row")].find(row => row.dataset.task === uid) ?? null;
  }

  /**
   * Rename: the row's name becomes a field, as the header's Rename makes
   * its name one. Enter, or a click outside, keeps what it says, and an
   * empty one gives the task its own title back (AgentService.renameTask;
   * labelTask, the sidebar's name only, for a task another program drives);
   * Esc leaves the name as it was. The IME's own keys only compose. The list
   * waits while the field is out, so a task changing meanwhile keeps it.
   */
  startRename(uid) {
    this.endRename({ keep: true });
    const conv = AgentService.taskByUid(uid, this.scope);
    const name = this.rowOf(uid)?.querySelector(".asb-dir-rt > b");
    if (conv?.kind !== "work" || !name) {
      return;
    }
    const field = this.el("input", "asb-dir-rename");
    field.type = "text";
    field.value = taskName(conv);
    // What an empty name goes back to.
    field.placeholder = conv.title || "New task";
    field.setAttribute("aria-label", "Task name");
    this.renaming = { uid, field, start: field.value };
    name.replaceWith(field);
    field.addEventListener("keydown", event => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.endRename({ keep: event.key === "Enter" });
        this.input.focus();
      }
    });
    // A click outside keeps it; the focus stays where the click put it.
    field.addEventListener("blur", () => this.endRename({ keep: true }));
    // Its clicks are the field's, not the row's (which shows the task).
    field.addEventListener("click", event => event.stopPropagation());
    field.focus();
    field.select();
  }

  /**
   * The row's name again, the field's words kept if `keep`. A name left as
   * it was renames nothing: it would make the name it shows the user's own,
   * which a task's later names never change.
   */
  endRename({ keep = false } = {}) {
    const edit = this.renaming;
    if (!edit) {
      return;
    }
    this.renaming = null;
    const conv = keep && edit.field.value !== edit.start ? AgentService.taskByUid(edit.uid, this.scope) : null;
    if (conv?.external) {
      AgentService.labelTask(conv, edit.field.value);
    } else if (conv) {
      AgentService.renameTask(conv, edit.field.value);
    }
    this.render();
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
    // Archived opens only on the task the sidebar shows from there.
    this.archivedOpen = this.glue.mode === "work" && !!this.glue.currentTask?.archivedAt;
    box.setAttribute("data-zenius-directory", "");
    this.layer.hidden = false;
    this.place();
    this.render();
    // The next frame, so the drawer slides in from under the sidebar.
    this.win.requestAnimationFrame(() =>
      this.win.requestAnimationFrame(() => this.isOpen && this.drawer.classList.add("open"))
    );
    // An open address bar closes first, so an IME composes into the search
    // (the glue's releaseAddressBar).
    this.glue.releaseAddressBar?.();
    this.input.focus();
    this.tick = this.win.setInterval(() => this.render(), 30000);
    this.glue.panel?.directoryChanged(true);
  }

  close({ now = false } = {}) {
    if (!this.isOpen) {
      return;
    }
    this.endRename({ keep: true });
    if (this.menu && this.menu.state !== "closed") {
      this.menu.hidePopup();
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
    const conv = AgentService.taskByUid(uid, this.scope);
    if (!conv) {
      return;
    }
    this.close();
    this.glue.showTask(conv);
    this.glue.panel?.focus();
  }

  /** An earlier chat's row: the chat comes back on a tab (the glue's openEarlierChat), and All tasks closes. */
  openChat(uid) {
    this.close();
    if (this.glue.openEarlierChat?.(uid)) {
      this.glue.panel?.focus();
    }
  }

  scheduleRender() {
    if (this.isOpen && !this.frame) {
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }

  /**
   * The tasks that match the search, by group, newest first: Pinned first
   * (the last pinned first), and Archived last (AgentService.archivedTasks:
   * the last archived first). A group shows its rows (`shown`) but
   * Archived, which does while it's open or a search runs. A pinned task
   * keeps its state, so one that needs the user keeps its tint.
   */
  groups() {
    const query = this.input.value.trim().toLowerCase();
    // A task another program drives, renamed here, is found by its program's name too.
    const words = conv => `${taskName(conv)}\n${conv.external ? conv.title : ""}\n${conv.task.text}\n${sourceWords(conv)}`;
    const matches = conv => !query || words(conv).toLowerCase().includes(query);
    const tasks = AgentService.directoryList(this.scope).filter(matches);
    const pinned = tasks.filter(conv => conv.pinnedAt).sort((a, b) => b.pinnedAt - a.pinnedAt);
    const groups = [
      { state: "pinned", label: "Pinned", shown: true, tasks: pinned },
      ...GROUPS.map(([state, label]) => ({
        state,
        label,
        shown: true,
        tasks: tasks
          .filter(conv => !conv.pinnedAt && (conv.task.state === "new" ? "working" : conv.task.state) === state)
          .sort((a, b) => b.task.since - a.task.since),
      })),
    ].filter(group => group.tasks.length);
    // Earlier chats, only while a search runs, as the window's glue finds
    // them: none in a private window, whose glue keeps no chats, nor in the
    // self-check window, which lists its scope alone.
    const chats = query && !this.scope ? (this.glue.earlierChats?.(query) ?? []) : [];
    if (chats.length) {
      groups.push({ state: "chats", label: "Earlier chats", shown: true, tasks: [], chats });
    }
    const archived = AgentService.archivedTasks(this.scope).filter(matches);
    if (archived.length) {
      groups.push({ state: "archived", label: "Archived", shown: this.archivedOpen || !!query, tasks: archived });
    }
    return groups;
  }

  /** The rows the arrow keys go through, in order (this.active's keys). */
  rowKeys(groups = this.groups()) {
    return groups.flatMap(group => (group.shown ? [...group.tasks.map(conv => conv.uid), ...(group.chats ?? []).map(chat => CHAT_KEY + chat.uid)] : []));
  }

  /** Open or close Archived. The keyboard's focus stays on its heading. */
  toggleArchived() {
    const focused = !!this.doc.activeElement?.classList?.contains("asb-dir-archived");
    this.archivedOpen = !this.archivedOpen;
    this.render();
    if (focused) {
      this.list.querySelector(".asb-dir-archived")?.focus();
    }
  }

  /**
   * Archived's heading: a button that opens and closes the group, with its
   * count. While a search runs it shows the matches, and doesn't close.
   */
  archivedHeading(group) {
    const searching = !!this.input.value.trim();
    const heading = this.el("button", "asb-dir-group asb-dir-archived");
    heading.type = "button";
    heading.dataset.group = group.state;
    heading.setAttribute("aria-expanded", String(group.shown));
    heading.disabled = searching;
    if (!searching) {
      heading.title = group.shown ? "Hide the archived tasks" : "Show the archived tasks";
    }
    heading.append(this.el("span", "asb-dir-chevron"), this.el("span", "asb-dir-label", group.label), this.el("span", "asb-dir-count", String(group.tasks.length)));
    return heading;
  }

  render() {
    if (!this.isOpen || this.renaming) {
      return;
    }
    const current = this.glue.mode === "work" ? this.glue.currentTask : null;
    const groups = this.groups();
    if (this.active && !this.rowKeys(groups).includes(this.active)) {
      this.active = null;
    }
    const parts = [];
    for (const group of groups) {
      if (group.state === "archived") {
        parts.push(this.archivedHeading(group));
      } else {
        const heading = this.el("div", "asb-dir-group", group.label);
        heading.dataset.group = group.state;
        parts.push(heading);
      }
      for (const conv of group.shown ? group.tasks : []) {
        parts.push(this.row(conv, conv === current));
      }
      for (const chat of group.shown ? (group.chats ?? []) : []) {
        parts.push(this.chatRow(chat));
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
    // Which of the user's agents sent a remote task, or where a task the
    // sidebar doesn't drive is driven from.
    const from = conv.external ? externalSource(conv) : remoteSource(conv);
    row.title = `${taskName(conv)}\n${from ? `${from}\n` : ""}${STATE_LABELS[state] ?? ""}${text ? `: ${text}` : ""}`;
    if (conv.external) {
      row.dataset.external = "true";
    }
    if (conv.archivedAt) {
      row.dataset.archived = "true";
    }
    if (conv.pinnedAt) {
      row.dataset.pinned = "true";
    }

    const top = this.el("div", "asb-dir-rt");
    top.append(this.el("span", "asb-dot"), this.el("b", "", taskName(conv)), this.el("span", "asb-dir-age", age(since)));
    row.append(top);
    if (from) {
      row.append(this.source(from, { chip: !conv.external || !!sourceParts(conv.from)?.terminal }));
    }
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

  /**
   * An earlier chat's row: its first question as its name, its age, a gray
   * dot where a task's shows its state, and its newest question's page under
   * it.
   */
  chatRow(chat) {
    const row = this.el("div", "asb-dir-row");
    row.dataset.chat = chat.uid;
    row.dataset.state = "chat";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.classList.toggle("active", this.active === CHAT_KEY + chat.uid);
    // Its address as the search reads it (AgentService's pageAddress): no
    // query or fragment, which may hold a token.
    const page = chat.page?.title || chat.page?.address || "";
    row.title = [chat.question, chat.page?.title, chat.page?.address].filter(Boolean).join("\n");
    const top = this.el("div", "asb-dir-rt");
    top.append(this.el("span", "asb-dot"), this.el("b", "", chat.question), this.el("span", "asb-dir-age", age(chat.at)));
    row.append(top, this.el("div", "asb-dir-rd", page));
    return row;
  }

  onKey(event) {
    // The search's IME keys (a composition's Enter, Escape and arrows) only
    // compose, and a row's name field has its own keys (startRename).
    if (event.isComposing || event.target.classList?.contains("asb-dir-rename")) {
      return;
    }
    // The context-menu key and Shift+F10: the menu of the row the arrows are
    // on, in a window that has the menu.
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      if (this.active && !this.active.startsWith(CHAT_KEY) && this.menu?.state === "closed") {
        event.preventDefault();
        this.openMenu(this.active);
      }
      return;
    }
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
    const uids = this.rowKeys();
    if (event.key === "Enter") {
      const uid = this.active ?? (this.input.value.trim() ? uids[0] : null);
      // A button's Enter is its own: '+ New task', Archived's heading.
      if (uid && event.target.localName !== "button") {
        event.preventDefault();
        if (uid.startsWith(CHAT_KEY)) {
          this.openChat(uid.slice(CHAT_KEY.length));
        } else {
          this.pick(uid);
        }
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
