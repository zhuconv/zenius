// ==UserScript==
// @name           Agent Sidebar
// @description    Select text, press Cmd+Shift+A, and ask your local Codex or Claude Code about it in a sidebar that sees the page.
// @include        main
// @author         zhuconv
// zenius: agent-sidebar
// ==/UserScript==

/* Window side of the agent sidebar:
 *  - registers the sidebar panel (agent-sidebar/panel.html) and the shortcut;
 *  - gives each tab its own conversation in AgentService (Chat mode);
 *  - keeps which task this window's Work mode shows, and starts work chats:
 *    the address bar's '>' (agent-urlbar calls AgentSidebar.sys.mjs's
 *    startWorkChat, which comes here) and '+ New task';
 *  - draws the directory of tasks (agent-sidebar/directory.sys.mjs) over the
 *    page;
 *  - Watch: shows a task's tabs in this window, with a pill over the page,
 *    and goes back to the user's tabs on ⌃Tab;
 *  - reads the selection and the page text from the tab when asked.
 * Prefs: uc.agent-sidebar.shortcut ("accel,shift+A"; Zen's own key for it is
 *        switched off while the script runs),
 *        uc.agent-sidebar.max-page-chars (120000),
 *        uc.agent-sidebar.default-question;
 *        AgentService.sys.mjs reads the others.
 */
(function agentSidebar() {
  "use strict";
  if (window.ucAgentSidebar) {
    return;
  }
  // zenius's doctor learns how each window's sidebar started (zen-ux's
  // ui.sidebarStatus, agreed with zen-sdk): its error, if the start threw.
  // A property of the window, not a call into zenius: the sidebar loads no
  // zenius module at its start, which I4 counts. The user's own copy of the
  // sidebar never sets it.
  let error = null;
  try {
    startSidebar();
  } catch (e) {
    error = String(e?.message ?? e);
    console.error("[agent-sidebar]", e);
  }
  window.zeniusSidebarStart = Object.freeze({ error });

  function startSidebar() {
    const SCRIPT_URL = Components.stack.filename.split(" -> ").pop();
    const BASE = SCRIPT_URL.slice(0, SCRIPT_URL.lastIndexOf("/") + 1) + "agent-sidebar/";
    const { AgentService, remoteSource } = ChromeUtils.importESModule(BASE + "AgentService.sys.mjs");
    AgentService.init(BASE);
    const { Directory } = ChromeUtils.importESModule(BASE + "directory.sys.mjs");
    const { registerSidebar, unregisterSidebar } = ChromeUtils.importESModule(BASE + "AgentSidebar.sys.mjs");

    const PANEL = "viewAgentSidebar";
    const ACTOR = "AgentSidebar";
    const PREF_SHORTCUT = "uc.agent-sidebar.shortcut";
    const PREF_MAX_CHARS = "uc.agent-sidebar.max-page-chars";
    // How long a question waits for the page's text, by kind: a page that
    // never finishes (a PDF that never loads) can't hold it up (zen-snapshot's
    // red team, finding 4). The pref, in ms, is for tests.
    const READ_TIMEOUT_MS = { html: 5000, pdf: 30000 };
    const PREF_READ_TIMEOUT = "uc.agent-sidebar.page-read-timeout";
    const PREF_PLACED = "uc.agent-sidebar.placed-right";
    // The panel's width as the user last dragged it (px), and the first one.
    const PREF_WIDTH = "uc.agent-sidebar.width";
    const PANEL_WIDTH = 420;
    // Narrower than any sidebar Zen allows: not a width the user chose.
    const MIN_KEPT_WIDTH = 120;
    // How long a remote task's arrival card stays (ms); the pref is for tests.
    const ARRIVAL_MS = 10000;
    const PREF_ARRIVAL_MS = "uc.agent-sidebar.arrival-ms";
    // A remote task restored at startup, or older than this, arrives quietly.
    const ARRIVAL_FRESH_MS = 30000;
    const STYLE = `data:text/css,${encodeURIComponent(
      [
        // The panel draws its own header, so hide the sidebar's while it is open.
        "#sidebar-box[agent-sidebar] #sidebar-header { display: none !important; }",
        // The page and the panel sit one --zen-element-separation apart, as two
        // panes of a Zen split do (--zen-split-row-gap). Zen's margins on the
        // splitter leave 4 px plus the splitter's width there, whatever the
        // separation, and Firefox pads the box's start (var(--space-small),
        // inline). So the splitter takes back the tabbox's gap on one side and
        // its own width, and the panel fills the box. In a split with the box
        // on the right ([sidebar-positionend]), the splitter takes back the
        // last pane's right margin too (on the left, the first pane has none).
        "#sidebar-box[agent-sidebar] ~ #sidebar-splitter { margin-inline: calc((var(--splitter-width, 2px) + var(--zen-element-separation)) / -2) !important; }",
        "#tabbrowser-tabbox[zen-split-view='true'] > #sidebar-box[agent-sidebar][sidebar-positionend] ~ #sidebar-splitter { margin-inline: calc((var(--splitter-width, 2px) + var(--zen-element-separation) + var(--zen-split-row-gap, 0px)) / -2) !important; }",
        // In a split, Zen pulls the tabbox's right edge out by
        // --zen-split-column-gap (its margin-right), meant for the last pane's
        // margin. With the box on the right, that put the box past the window's
        // edge, so the box takes it back: its right edge stays where it is
        // outside a split.
        "#tabbrowser-tabbox[zen-split-view='true'] > #sidebar-box[agent-sidebar][sidebar-positionend] { margin-right: var(--zen-split-column-gap) !important; }",
        "#sidebar-box[agent-sidebar] { padding: 0 !important; }",
        // One area, like the page's box beside it: the panel's background
        // (panel.css's --bg) edge to edge, with the page's corner and shadow
        // (Zen's rule for .browserSidebarContainer) in place of Zen's
        // sidebar's own (a radius 1.3 times larger, as a squircle).
        "#sidebar-box[agent-sidebar] { background-color: light-dark(#fbfbfc, #1f1f23) !important; }",
        ":root:not([zen-no-padding='true']) #sidebar-box[agent-sidebar] { corner-shape: round !important; border-radius: calc(var(--zen-native-inner-radius) / var(--zen-squircle-value)) !important; box-shadow: var(--zen-big-shadow) !important; }",
        ":root[zen-no-padding='true'] #sidebar-box[agent-sidebar] { border-radius: 0 !important; box-shadow: none !important; }",
      ].join("\n")
    )}`;

    const conversations = new WeakMap(); // tab -> Conversation
    const cleanups = [];
    let panel = null; // the open panel's API, set by panel.js
    let panelWaiters = [];
    // What the panel shows in this window: "chat", the selected tab's chat, or
    // "work", a task's (currentTask). A task stays while the user switches tabs.
    let mode = "chat";
    let currentTask = null;
    let draft = null; // '+ New task' before its first question: in no directory yet
    let directory = null;

    function conversationFor(tab) {
      let conv = conversations.get(tab);
      if (!conv) {
        conv = AgentService.createConversation();
        conversations.set(tab, conv);
      }
      return conv;
    }

    function tabOf(conv) {
      return gBrowser.tabs.find(tab => conversations.get(tab) === conv) ?? null;
    }

    // --- Tasks (Work mode) --------------------------------------------------------

    /** A new task to type into; an empty one that's waiting is used again. */
    function newDraft() {
      if (!draft || AgentService.tasks.has(draft.uid) || draft.messages.length || draft.busy) {
        draft = AgentService.createTask({ source: "new" });
      }
      return draft;
    }

    /** The task Work mode shows: the one picked last, else the newest, else a new one. */
    function workConversation() {
      const listed = AgentService.isListed(currentTask);
      if (!listed && currentTask !== draft) {
        currentTask = AgentService.taskList()[0] ?? null;
      }
      currentTask ??= newDraft();
      return currentTask;
    }

    function shownConversation() {
      return mode === "work" ? workConversation() : conversationFor(gBrowser.selectedTab);
    }

    /** @param {"chat"|"work"} next */
    function setMode(next) {
      mode = next === "work" ? "work" : "chat";
      panel?.show(shownConversation());
    }

    /**
     * Work mode on a task (a row of the directory).
     *
     * @param {string|object} task  its uid, or its conversation
     */
    function showTask(task) {
      const conv = typeof task === "string" ? AgentService.taskByUid(task) : task;
      if (!conv) {
        return;
      }
      mode = "work";
      currentTask = conv;
      panel?.show(conv);
    }

    /**
     * The sidebar open on a task (zenius's tasks panel, for a task that
     * needs the user with no zenius task saying so).
     *
     * @param {string} uid
     */
    async function openTask(uid) {
      const conv = AgentService.taskByUid(uid);
      if (!conv) {
        return;
      }
      showTask(conv);
      (await openPanel()).show(conv);
    }

    /** '+ New task': Work mode on a new task, ready to type. */
    async function newTask() {
      const conv = newDraft();
      mode = "work";
      currentTask = conv;
      const api = await openPanel();
      api.compose(conv, { selection: "" });
      return conv;
    }

    /**
     * Start a work chat with a request (AgentSidebar.sys.mjs's startWorkChat:
     * the address bar's '>' row). The sidebar opens on the new task in Work
     * mode, and the user goes on with their page. Resolves to the task's uid
     * once it shows, without waiting for the agent.
     *
     * @param {string} text  the request; with none, the task waits to be typed
     * @param {{source?: "urlbar"|"new"}} [options]
     * @returns {Promise<string>}
     */
    async function startWorkChat(text, { source = "urlbar" } = {}) {
      if (!text?.trim()) {
        return (await newTask()).uid;
      }
      const conv = AgentService.createTask({ source });
      mode = "work";
      currentTask = conv;
      const api = await openPanel();
      api.show(conv);
      AgentService.send(conv, { question: text, source }).catch(e => console.error("[agent-sidebar]", e));
      gBrowser.selectedBrowser.focus();
      return conv.uid;
    }

    // --- A remote task's arrival ---------------------------------------------
    //
    // Another of the user's agents started a task (remote tasks; the user's
    // call "可以弹一个卡片但是不需要同意": a card pops up, with no approval). A
    // small card says "Task from <address> · <label>", with Watch and Stop:
    // in the agent sidebar if it's open in this window, else over zenius's
    // strip in Zen's own sidebar, where zenius tells the user a task needs
    // them. It takes no focus, opens nothing and selects nothing (I1), and
    // goes after ARRIVAL_MS, or when dismissed. Only the front window shows
    // it, and only for a task that just started.

    const arrived = new Set(AgentService.tasks.keys());
    cleanups.push(
      AgentService.subscribeTasks(conv => {
        if (!conv || conv.source !== "remote" || arrived.has(conv.uid) || !AgentService.tasks.has(conv.uid)) {
          return;
        }
        arrived.add(conv.uid);
        if (Date.now() - (conv.createdAt ?? 0) > ARRIVAL_FRESH_MS) {
          return;
        }
        if (Services.wm.getMostRecentWindow("navigator:browser") === window) {
          showArrival(conv);
        }
      })
    );

    function showArrival(conv) {
      const text = remoteSource(conv, "Task from");
      if (!text) {
        return;
      }
      const ms = Services.prefs.getIntPref(PREF_ARRIVAL_MS, ARRIVAL_MS);
      const actions = { watch: () => watchArrival(conv), stop: () => AgentService.cancel(conv) };
      if (panel && panelIsOpen()) {
        panel.arrive(text, actions, ms);
      } else {
        AgentService.zeniusUI()?.remoteArrival?.(window, { text, ...actions, ms });
      }
    }

    /** The arrival card's Watch, the user's click: the task's page if it has one yet, else the task in the sidebar. */
    async function watchArrival(conv) {
      if (!AgentService.tasks.has(conv.uid)) {
        return;
      }
      if (AgentService.zenRecord(conv) && (await watch(conv))) {
        return;
      }
      showTask(conv);
      (await openPanel()).show(conv);
    }

    // --- Watch: a task's tabs in this window, and ⌃Tab back ------------------
    //
    // zenius's watch (ZeniusUI.watch, ui/watch.sys.mjs): every way to an
    // agent's task shows it in the window, remembers where the user was, and
    // ⌃Tab goes back there. The sidebar's ways in are its live card's Watch
    // and Take over and its directory's tabs, and it shows the task in the
    // panel first. zenius tells the window when a watch begins or ends,
    // whoever began it ("zenius-watch"): the card and the root's
    // data-zenius-watching follow, with nothing of zenius's loading at the
    // sidebar's start.

    /** The uid of the chat whose task this window watches, else null. */
    let watchingUid = null;

    function taskOf(task) {
      return typeof task === "string" ? AgentService.taskByUid(task) : (task ?? null);
    }

    /** The listed task that follows zenius task `id`, if any: a chat's, or one the sidebar doesn't drive. */
    function chatOfTask(id) {
      return AgentService.taskOfSpace(id);
    }

    function onWatchChanged(event) {
      const id = event.detail?.space;
      watchingUid = typeof id === "number" ? (chatOfTask(id)?.uid ?? null) : null;
      if (watchingUid) {
        document.documentElement.setAttribute("data-zenius-watching", watchingUid);
      } else {
        document.documentElement.removeAttribute("data-zenius-watching");
      }
      panel?.watchChanged();
    }

    /**
     * Watch a task: its Space and tabs in this window, on `tab` if given,
     * with the panel on the task.
     *
     * @param {string|object} task  its uid, or its conversation
     * @param {{tab?: Element}} [options]
     * @returns {Promise<boolean>} whether the window shows it
     */
    async function watch(task, { tab = null } = {}) {
      const conv = taskOf(task);
      const rec = conv && AgentService.zenRecord(conv);
      const ui = rec && AgentService.zeniusUI();
      if (!ui) {
        return false;
      }
      showTask(conv);
      try {
        return await ui.watch(rec, window, { tab });
      } catch (e) {
        console.error("[agent-sidebar] could not show the task's tabs", e);
        return false;
      }
    }

    /**
     * End this window's watch. With `back` (as ⌃Tab), the window goes back
     * to where the user was.
     *
     * @param {{back?: boolean}} [options]
     * @returns {Promise<boolean>} whether a watch ended
     */
    async function stopWatching({ back = true } = {}) {
      return (await AgentService.zeniusUI()?.stopWatching(window, { back })) ?? false;
    }

    /**
     * Take a task's page over from the agent, as zenius's tasks panel does,
     * and watch it. The agent waits until the user hands it back with
     * zenius's Resume agent.
     *
     * @param {string|object} task  its uid, or its conversation
     * @returns {Promise<boolean>} whether the user has it
     */
    async function takeOver(task) {
      const conv = taskOf(task);
      const rec = conv && AgentService.zenRecord(conv);
      const ui = AgentService.zeniusUI();
      if (!rec || !ui || rec.ownership !== "agent") {
        return false;
      }
      const taking = Promise.resolve(ui.takeOverByUser(rec)).catch(e => console.error("[agent-sidebar] take over failed", e));
      await watch(conv);
      await taking;
      AgentService.refreshTask(conv);
      return AgentService.isHeld(conv) === "takeover";
    }

    /** The selected tab, as the Chat header shows it. */
    function pageInfo(tab = gBrowser.selectedTab) {
      const uri = tab.linkedBrowser?.currentURI;
      const spec = uri?.spec ?? "";
      let host = "";
      try {
        host = uri?.displayHost || "";
      } catch {}
      if (!host) {
        host = /^about:/.test(spec) ? spec.split(/[?#]/)[0] : uri?.scheme === "file" ? "File" : "";
      }
      return { title: tab.label || spec || "New Tab", host, image: tab.image || "", url: spec };
    }

    // --- The sidebar panel ----------------------------------------------------

    function registerPanel() {
      const sidebars = SidebarController.sidebars;
      if (!sidebars.has(PANEL)) {
        sidebars.set(
          PANEL,
          SidebarController.makeSidebar(
            {
              elementId: "agent-sidebar-title",
              url: BASE + "panel.html",
              title: "Agent",
              iconUrl: "chrome://global/skin/icons/highlights.svg",
              hasCustomHeader: true,
            },
            PANEL
          )
        );
      }
      // Reading panels belong on the right, away from Zen's tab sidebar. Only
      // once, so a later change back to the left sticks.
      if (!Services.prefs.getBoolPref(PREF_PLACED, false)) {
        Services.prefs.setBoolPref(PREF_PLACED, true);
        Services.prefs.setBoolPref("sidebar.position_start", false);
      }
    }

    function panelIsOpen() {
      return SidebarController.isOpen && SidebarController.currentID === PANEL;
    }

    /** The panel's width: as the user last dragged it, else 420 px (the
     * browser's default is too narrow for answers). */
    function panelWidth() {
      const kept = Services.prefs.getIntPref(PREF_WIDTH, 0);
      return kept >= MIN_KEPT_WIDTH ? kept : PANEL_WIDTH;
    }

    /** A width the box took while the panel shows (the user's drag) is kept
     * for the next open and the next start: the browser keeps the box's
     * width only while the window lives. */
    function keepWidth(box) {
      const width = Math.round(Number.parseFloat(box.style.width));
      if (width >= MIN_KEPT_WIDTH && width !== Services.prefs.getIntPref(PREF_WIDTH, 0)) {
        Services.prefs.setIntPref(PREF_WIDTH, width);
      }
    }

    // The box takes the panel's look (no browser header, the panel's
    // background) and the panel's width as the browser shows it, before its
    // first paint, on every open. In attachPanel, once panel.html had
    // loaded, both came frames late: every open painted the browser's own
    // "Agent ×" header first, a profile's first open its default 216 px, and
    // after a restart the box stayed at 216 px, its widening done once per
    // profile through an inline width that doesn't outlive the window
    // (zen-eval's take-6 captures and probe). The browser unhides the box
    // and sets "checked" on each show, and the panel's id with them; the
    // observer runs before the next paint.
    function fitBox(records) {
      const box = document.getElementById("sidebar-box");
      if (!box) {
        return;
      }
      const ours = panelIsOpen();
      box.toggleAttribute("agent-sidebar", ours);
      if (!ours) {
        return;
      }
      if (records.some(r => r.attributeName !== "style")) {
        const width = `${panelWidth()}px`;
        if (box.style.width !== width) {
          box.style.width = width;
        }
      } else {
        keepWidth(box);
      }
    }
    const sidebarBox = document.getElementById("sidebar-box");
    if (sidebarBox) {
      const boxObserver = new MutationObserver(fitBox);
      boxObserver.observe(sidebarBox, { attributes: true, attributeFilter: ["hidden", "checked", "style"] });
      cleanups.push(() => boxObserver.disconnect());
    }

    async function openPanel() {
      if (panel && panelIsOpen()) {
        return panel;
      }
      const ready = new Promise(resolve => panelWaiters.push(resolve));
      if (!panelIsOpen()) {
        await SidebarController.show(PANEL);
      }
      return panel ?? ready;
    }

    // --- Reading the tab --------------------------------------------------------

    function actor(browsingContext) {
      return browsingContext?.currentWindowGlobal?.getActor(ACTOR);
    }

    function withTimeout(promise, ms) {
      return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
    }

    /** The text the user selected in the tab: in the frame they last used (the
     * focused one), else in the page itself. Other frames are not asked: one
     * that is busy (an ad, a tracker, a bot check) held the shortcut up for as
     * long as a second, and a selection is made where the focus is. */
    async function selectionIn(tab) {
      const top = tab.linkedBrowser.browsingContext;
      if (!top) {
        return "";
      }
      const focused = Services.focus.focusedContentBrowsingContext;
      const contexts = focused && focused !== top && focused.top === top ? [focused, top] : [top];
      for (const context of contexts) {
        try {
          const result = await withTimeout(actor(context).sendQuery("GetSelection"), 1000);
          if (result?.selection) {
            return result.selection;
          }
        } catch {}
      }
      return "";
    }

    function pageOf(tab) {
      const browser = tab.linkedBrowser;
      const url = browser.currentURI?.spec ?? "";
      if (!/^(https?|file):/.test(url)) {
        return null;
      }
      const kind = browser.documentContentType === "application/pdf" ? "pdf" : "html";
      return {
        url,
        title: tab.label,
        kind,
        // The child takes the PDF viewer's path only for the kind seen here.
        // {timedOut: true} when the page took too long.
        getText: () => {
          const ms = Services.prefs.getIntPref(PREF_READ_TIMEOUT, 0) || READ_TIMEOUT_MS[kind];
          return Promise.race([
            actor(browser.browsingContext).sendQuery("GetPageText", {
              maxChars: Services.prefs.getIntPref(PREF_MAX_CHARS, 120000),
              kind,
            }),
            new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), ms)),
          ]);
        },
      };
    }

    // --- Actions ----------------------------------------------------------------

    function panelHasFocus() {
      return !!SidebarController.browser?.contentDocument?.hasFocus();
    }

    /**
     * The shortcut opens and closes the panel. With the panel open, newly
     * selected text on the page goes into the composer instead of closing it,
     * so "select, press, ask" works the same whether the panel is open or not.
     */
    async function toggle() {
      const tab = gBrowser.selectedTab;
      const conv = conversationFor(tab);
      if (panel && panelIsOpen()) {
        const selection = panelHasFocus() ? "" : await selectionIn(tab);
        if (selection && selection !== conv.lastSelection) {
          conv.lastSelection = selection;
          mode = "chat";
          getReady(conv, tab);
          panel.compose(conv, { selection });
        } else {
          SidebarController.hide();
          gBrowser.selectedBrowser.focus();
        }
        return;
      }
      // ⌘⇧A opens the tab's chat ("select, press, ask"); the switch goes to Work.
      mode = "chat";
      // Ask the page for its selection while the panel opens.
      const selecting = selectionIn(tab);
      const api = await openPanel();
      const selection = await selecting;
      getReady(conv, tab);
      conv.lastSelection = selection;
      api.compose(conv, { selection });
    }

    /** While the user types: start the agent and its session, and read the page. */
    function getReady(conv, tab) {
      AgentService.prewarm(conv);
      AgentService.prefetchPage(conv, pageOf(tab));
    }

    /** Called by the panel when the user sends a question, or an edited one
     * (`replace`: the question it replaces). */
    function submit(conv, { question, selection, attachments, replace, source = null }) {
      if (conv.kind === "work") {
        return AgentService.send(conv, { question, selection, attachments, replace, source });
      }
      const tab = tabOf(conv) ?? gBrowser.selectedTab;
      return AgentService.send(conv, { question, selection, attachments, replace, source, page: pageOf(tab) });
    }

    /** A message the user sent while the agent worked (zen-ux's queue and
     * steer). Enter queues it: a Chat one goes with its tab's page as it is
     * when it goes out, so `page` is a function AgentService calls then.
     * Steer sends it into the running turn, with the page as it is now. */
    function enqueue(conv, { question, selection, attachments }) {
      const page = conv.kind === "work" ? null : () => pageOf(tabOf(conv) ?? gBrowser.selectedTab);
      return AgentService.enqueue(conv, { question, selection, attachments, page });
    }

    function steer(conv, { question, selection, attachments }) {
      const page = conv.kind === "work" ? null : pageOf(tabOf(conv) ?? gBrowser.selectedTab);
      return AgentService.steer(conv, { question, selection, attachments, page });
    }

    function normalizeModifiers(modifiers) {
      const isMac = AppConstants.platform === "macosx";
      return (modifiers || "")
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(m => (m === "accel" ? (isMac ? "meta" : "control") : m))
        .sort()
        .join(",");
    }

    function shortcutSpec() {
      const spec = Services.prefs.getStringPref(PREF_SHORTCUT, "accel,shift+A");
      const plus = spec.lastIndexOf("+");
      return { modifiers: plus > 0 ? spec.slice(0, plus) : "", key: spec.slice(plus + 1) };
    }

    /** Switch off whatever else has the same keys (Cmd+Shift+A is Zen's
     * "search tabs"); uninit gives it back. Zen adds some keys late in
     * startup, so this runs again then. */
    const disabledKeys = new Set();
    function disableConflictingKeys() {
      const { modifiers, key } = shortcutSpec();
      const wanted = `${normalizeModifiers(modifiers)}+${key.toUpperCase()}`;
      for (const other of document.querySelectorAll("key")) {
        const otherKey = (other.getAttribute("key") || "").toUpperCase();
        if (
          other.id !== "key_agentSidebarToggle" &&
          otherKey &&
          `${normalizeModifiers(other.getAttribute("modifiers"))}+${otherKey}` === wanted &&
          other.getAttribute("disabled") !== "true"
        ) {
          other.setAttribute("disabled", "true");
          disabledKeys.add(other);
        }
      }
    }
    cleanups.push(() => {
      for (const key of disabledKeys) {
        key.removeAttribute("disabled");
      }
      disabledKeys.clear();
    });

    function installShortcut() {
      const { modifiers, key } = shortcutSpec();
      disableConflictingKeys();

      const commandset = document.createXULElement("commandset");
      commandset.id = "agent-sidebar-commands";
      const command = document.createXULElement("command");
      command.id = "cmd_agentSidebarToggle";
      command.addEventListener("command", () => toggle().catch(e => console.error("[agent-sidebar]", e)));
      commandset.append(command);

      const keyset = document.createXULElement("keyset");
      keyset.id = "agent-sidebar-keys";
      const keyElement = document.createXULElement("key");
      keyElement.id = "key_agentSidebarToggle";
      keyElement.setAttribute("modifiers", modifiers);
      keyElement.setAttribute(key.length === 1 ? "key" : "keycode", key);
      keyElement.setAttribute("command", command.id);
      keyset.append(keyElement);

      document.documentElement.append(commandset, keyset);
      cleanups.push(() => {
        commandset.remove();
        keyset.remove();
      });
    }

    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    }

    function onTabSelect() {
      if (mode === "chat") {
        panel?.show(conversationFor(gBrowser.selectedTab));
      }
      panel?.pageChanged();
    }

    function onTabAttrModified(event) {
      if (event.target === gBrowser.selectedTab) {
        panel?.pageChanged();
      }
    }

    // The selected tab went to another page: the Chat header says so.
    const progressListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(webProgress) {
        if (webProgress?.isTopLevel) {
          panel?.pageChanged();
        }
      },
    };

    function onTabClose(event) {
      const conv = conversations.get(event.target);
      if (conv) {
        conversations.delete(event.target);
        AgentService.forget(conv);
      }
    }

    function uninit() {
      // The watch is zenius's, and goes on: only the sidebar's mark of it goes.
      document.documentElement.removeAttribute("data-zenius-watching");
      watchingUid = null;
      unregisterSidebar(window);
      directory?.destroy();
      directory = null;
      if (panelIsOpen()) {
        SidebarController.hide();
      }
      SidebarController.sidebars.delete(PANEL);
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      delete window.ucAgentSidebar;
    }

    window.ucAgentSidebar = {
      AgentService,
      toggle,
      submit,
      enqueue,
      steer,
      uninit,
      get mode() {
        return mode;
      },
      setMode,
      get currentTask() {
        return mode === "work" ? workConversation() : currentTask;
      },
      showTask,
      openTask,
      newTask,
      startWorkChat,
      watch,
      stopWatching,
      takeOver,
      /** The uid of the task this window watches, else null. */
      get watching() {
        return watchingUid;
      },
      pageInfo,
      /** The directory of tasks, over the page beside the sidebar. */
      toggleDirectory() {
        directory ??= new Directory(window, window.ucAgentSidebar);
        directory.toggle();
      },
      closeDirectory() {
        directory?.close();
      },
      get directoryOpen() {
        return !!directory?.isOpen;
      },
      attachPanel(api) {
        panel = api;
        // fitBox set it as the box showed; this is for a panel the browser
        // loaded some other way.
        document.getElementById("sidebar-box")?.setAttribute("agent-sidebar", "");
        for (const resolve of panelWaiters.splice(0)) {
          resolve(api);
        }
        api.show(shownConversation());
      },
      detachPanel(api) {
        if (panel === api) {
          panel = null;
          directory?.close({ now: true });
          document.getElementById("sidebar-box")?.removeAttribute("agent-sidebar");
        }
      },
      closePanel() {
        SidebarController.hide();
      },
      focusPage() {
        gBrowser.selectedBrowser.focus();
      },
      openLink(url) {
        if (/^https?:/.test(url)) {
          openWebLinkIn(url, "tab");
        }
      },
      defaultQuestion() {
        return Services.prefs.getStringPref("uc.agent-sidebar.default-question", "解释一下这段内容。");
      },
      get panel() {
        return panel;
      },
      conversationFor,
    };

    registerSidebar(window, window.ucAgentSidebar);
    registerPanel();
    installShortcut();
    window.delayedStartupPromise?.then(() => setTimeout(disableConflictingKeys, 1000));
    windowUtils.loadSheetUsingURIString(STYLE, windowUtils.AUTHOR_SHEET);
    cleanups.push(() => windowUtils.removeSheetUsingURIString(STYLE, windowUtils.AUTHOR_SHEET));
    listen(gBrowser.tabContainer, "TabSelect", onTabSelect);
    listen(gBrowser.tabContainer, "TabClose", onTabClose);
    listen(gBrowser.tabContainer, "TabAttrModified", onTabAttrModified);
    // zenius's watch begins and ends here (ZeniusUI.watch).
    listen(window, "zenius-watch", onWatchChanged);
    gBrowser.addProgressListener(progressListener);
    cleanups.push(() => gBrowser.removeProgressListener(progressListener));
  }
})();
