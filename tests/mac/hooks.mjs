// The bundle's test hooks: the names zen-sidebar's docs/agent-sidebar.md
// gives the two-mode sidebar, the '>' dispatch and Watch, which zen-ux keeps
// as a contract. Every Mac test reads them from here, so a
// renamed hook is a one-line change.
//
// The panel is a document of its own, so its ids are bare. The drawer and
// the window's Watch state live in browser.xhtml, so their names carry a
// zenius prefix.

/** The sidebar, as Zen's SidebarController knows it. */
export const SIDEBAR_ID = "viewAgentSidebar";

/** The panel document (panel.html). */
export const PANEL = {
  /** html[data-mode="chat"|"work"] */
  mode: "data-mode",
  header: "#header",
  /** Work only; aria-expanded while the drawer is open. */
  dir: "#dir",
  /** Chat only. */
  favicon: "#favicon",
  title: "#title",
  more: "#more",
  /** The composer's box: #input (two lines when empty), then the row #bar. */
  box: "#box",
  input: "#input",
  /**
   * Two groups: #bar-start ('+', the switch) and #bar-end (the pickers,
   * stop/send). One row where both fit; otherwise #bar-end wraps whole to a
   * second row at the right. Nothing hidden, nothing past #box.
   */
  bar: "#bar",
  barStart: "#bar-start",
  barEnd: "#bar-end",
  attach: "#attach",
  switch: "#switch",
  /** aria-pressed on the selected one. */
  toChat: "#to-chat",
  toWork: "#to-work",
  /** Inside #to-work, hidden at 0. */
  needs: "#needs",
  needsColor: "--needs-color",
  /** The label ("Opus 5.5 · Low") is #pick, which opens #picker: its family
   * bar (#pick-fam, role=tab buttons with data-harness), its rows
   * (.pick-row[data-value], aria-selected on the chat's model) and the
   * efforts' flyout (#pick-fly, .pick-eff[data-value]). */
  pickers: "#pickers",
  pick: "#pick",
  picker: "#picker",
  pickFamilies: "#pick-fam",
  /** Another family's note in a chat with messages: picking there starts a new chat. */
  pickNote: "#pick-note",
  pickRow: "#pick-list .pick-row",
  pickEfforts: "#pick-fly",
  stop: "#stop",
  send: "#send",
  /** data-status = done | running | failed | waiting | stopped */
  step: ".steps > .step",
  /**
   * The live card, the thread's last child, hidden until the task has a tab;
   * data-live="true" while the agent works on the page; data-watching="true"
   * while this window watches the card's task, whoever began the watch;
   * data-drawn counts its pictures, and stays put while the card can't be seen.
   */
  live: "#live",
  /** A canvas. */
  liveShot: "#live-shot",
  /** "Live on <host>", "Waiting for you on <host>", "You have control on <host>", or the host. */
  liveText: "#live-text",
  /** Reads "Watch", with no aria-pressed; hidden while this window watches the task. A click only starts a watch. */
  watch: "#watch",
  /**
   * Shown only while watching, in Watch's place: "⌃Tab back to your tabs"
   * ("Ctrl+Tab" off the Mac), the key in a <kbd>. Not a button: ⌃Tab is the
   * way back.
   */
  watchHint: "#watch-hint",
  /** Shown while the agent has the page. */
  takeOver: "#take-over",
};

/** The directory drawer, in browser.xhtml (hidden while closed). */
export const DRAWER = {
  root: "#zenius-sidebar-directory",
  /** .open while shown; data-side = left | right */
  drawer: ".asb-dir",
  /** data-group = needs | working | done */
  group: ".asb-dir-group",
  /** data-task = <uid>, data-state; data-current="true" on the current task */
  row: ".asb-dir-row",
  tab: ".asb-dir-tab",
  needsColor: "--asb-needs-color",
};

/** The drawer's groups, in order, with the labels the user reads. */
export const GROUPS = [
  ["needs", "Needs you"],
  ["working", "Working"],
  ["done", "Done"],
];

/** startWorkChat(win, { text, source }) -> Promise<uid>; '>' calls it too. */
export const MODULE = "chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs";

/**
 * The 'Ask agent' row. Tests find it by dynamicType and providerName, never
 * by its icon's file name: zen-ux is replacing the icon (and says when).
 */
export const URLBAR = {
  dynamicType: "zeniusAskAgent",
  /** The first row, after a '>' prefix. Other input gets none (since 0.1.8). */
  first: "ZeniusAskAgent",
};

/**
 * Watch. window.ucAgentSidebar: watch(uid, { tab }) and
 * takeOver(uid) resolve to booleans; stopWatching({ back = true }); the
 * `watching` getter (a uid or null). A click on .asb-dir-tab watches the task
 * on that tab. ⌃Tab goes back while watching, and is Zen's otherwise; only
 * trusted keys count, so tests play it through nsITextInputProcessor.
 */
export const WATCH = {
  /** On #main-window: the uid of the task the window watches. */
  attr: "data-zenius-watching",
  /**
   * zenius's watching chip, a div and a pure hint, "Watching <task> [⌃Tab]":
   * in the page area's top left corner, at most 280 px or 40% of the page's
   * width. It shows only while the window watches and the strip can't be read
   * (a collapsed sidebar, compact mode). No buttons, and every click passes
   * through it (pointer-events: none): ⌃Tab is the only way back.
   */
  pill: "#zenius-watch-pill",
  /** The chip's "Watching <b>task</b>", the name cut by an ellipsis. */
  name: ".zenius-watch-name",
  /** The chip's "<kbd>⌃Tab</kbd>", never cut. */
  key: ".zenius-watch-key",
  /** zenius's agents strip: [watching="true"], with the same hint, while the window watches. */
  strip: "#zenius-agents-strip",
  /** The strip's task name while watching, cut by an ellipsis where the strip is narrow. */
  stripName: ".zenius-strip-name",
  /** The strip's " <kbd>⌃Tab</kbd>" while watching, never cut. */
  stripKey: ".zenius-strip-key",
  /**
   * Once the watched task ends, ⌃Tab still goes back: the
   * strip is [watching="done"] and says "Task done, [⌃Tab] back to your
   * tabs", or the chip, where the strip can't be read, is [done] and says the
   * same. "back to your tabs" is cut first, never "Task done" or the key.
   */
  stripText: ".zenius-strip-text",
  /** The strip's "Watching " or, once the task is done, "Task done,". */
  stripLead: ".zenius-strip-lead",
  /** The strip's " back to your tabs" once the task is done. */
  stripRest: ".zenius-strip-rest",
  /** The chip's "back to your tabs" once the task is done; its name then reads "Task done,". */
  rest: ".zenius-watch-rest",
  /** ZeniusUI.watchingDone(win): the ended task's space id while its way back stays, else null. */
  ui: "chrome://userscripts/content/zenius/ui/index.sys.mjs",
};

/** In the profile's root: read once at startup, { version: 1, tasks: [...] }. */
export const TASKS_FILE = "agent-sidebar-tasks.json";

/**
 * Which parts let Zen's window material (the macOS vibrancy) show through.
 * None. The panel's body is solid var(--bg), like the page card beside it,
 * and the drawer is solid too. A see-through panel was tried in the try Zen
 * and dropped, so the look has no switch.
 */
export const MATERIAL = { panel: "solid", header: "solid", box: "solid", drawer: "solid" };
