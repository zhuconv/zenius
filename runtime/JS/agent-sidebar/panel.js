/* Agent Sidebar, the panel inside Zen's sidebar. It shows one conversation:
 * the selected tab's (Chat) or a task's (Work), picked with the Chat | Work
 * switch in the question box's bottom row. The header shows only the chat's
 * title: the tab's page, or the task, with the button that opens the list of
 * tasks over the page (directory.sys.mjs). The panel lets the user pick the
 * agent and model (one menu, grouped by agent) and the effort, takes attached
 * files, sends questions through agent-sidebar.uc.js, shows each tool call as
 * a step the user can read, lets the user edit a question and ask again from
 * there, and copies or saves answers. docs/agent-sidebar.md lists the ids
 * that tests go by. */

import { marked } from "./vendor/marked.esm.js";
import { imageFromClipboard, kindOf, readAttachment, Refused } from "./attachments.mjs";
import { copyText, extensionFor, fileName, saveText } from "./saving.mjs";

const { AgentService, MODEL_OPTION, EFFORT_OPTIONS, optionValues, STATE_LABELS, age } = ChromeUtils.importESModule(
  new URL("AgentService.sys.mjs", import.meta.url).href
);
const glue = window.browsingContext.topChromeWindow.ucAgentSidebar;
const parser = Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils);
const BLANK = Services.io.newURI("about:blank");
const PREF_MAX_CHARS = "uc.agent-sidebar.max-page-chars";
const PLACEHOLDERS = {
  chat: "Ask about this page…",
  task: "Describe the task…",
  reply: "Reply to the agent…",
};
const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";
const CTRL_TAB = Services.appinfo.OS === "Darwin" ? "⌃Tab" : "Ctrl+Tab";
// The live card's picture is drawn again this often while the agent works.
const LIVE_EVERY_MS = 2000;

const $ = id => document.getElementById(id);
const els = {
  header: $("header"),
  dir: $("dir"),
  favicon: $("favicon"),
  title: $("title"),
  live: $("live"),
  liveShot: $("live-shot"),
  liveText: $("live-text"),
  watch: $("watch"),
  watchHint: $("watch-hint"),
  takeOver: $("take-over"),
  toChat: $("to-chat"),
  toWork: $("to-work"),
  needs: $("needs"),
  more: $("more"),
  menu: $("menu"),
  newChat: $("new-chat"),
  newTask: $("new-task"),
  removeTask: $("remove-task"),
  messages: $("messages"),
  empty: $("empty"),
  model: $("model"),
  pickDot: $("pick-dot"),
  effort: $("effort"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  chip: $("chip"),
  chipText: $("chip-text"),
  attachments: $("attachments"),
  attach: $("attach"),
  fileInput: $("file-input"),
};

let conv = null;
let unsubscribe = null;
let editing = null; // the question being edited: { message, el }
let waitingFor = null; // the conversation whose files are still being read for a send
let harnesses = AgentService.harnessList();
// Each conversation keeps its own list of message elements while the panel is
// open, so switching tabs swaps lists instead of rendering every answer again.
const lists = new WeakMap(); // conversation -> <div class="list">
const rendered = new WeakMap(); // message -> { el, v }
const messageOf = new WeakMap(); // message element -> message
// While an answer streams, render at most this often (the Markdown of the
// whole answer is parsed again each time).
const RENDER_INTERVAL = 50;
let renderTimer = null;
let lastRender = 0;

// --- Rendering --------------------------------------------------------------

// The attributes an answer's HTML keeps once sanitized. An id or a class
// could pass part of an answer for the panel's own: a look-alike "The agent
// wants to:" line, or a second #send for the tests' hooks (zen-snapshot's red
// team, finding 5). A code block's language stays, for Save as.
const KEPT_ATTRIBUTES = { a: ["href"], ol: ["start"], th: ["align"], td: ["align"], code: ["class"] };

/** Markdown from the model, through Firefox's HTML sanitizer: no scripts,
 * no event handlers, no forms or media; then only KEPT_ATTRIBUTES, and links
 * that show where they go. */
function renderMarkdown(el, markdown) {
  const html = marked.parse(markdown || "", { gfm: true, async: false });
  const fragment = parser.parseFragment(
    html,
    Ci.nsIParserUtils.SanitizerDropForms | Ci.nsIParserUtils.SanitizerDropMedia,
    false,
    BLANK,
    el
  );
  for (const node of fragment.querySelectorAll("*")) {
    const kept = KEPT_ATTRIBUTES[node.localName] ?? [];
    for (const { name } of [...node.attributes]) {
      if (!kept.includes(name)) {
        node.removeAttribute(name);
      }
    }
    if (node.localName === "code" && node.hasAttribute("class") && !/^language-[\w+#.-]{1,32}$/.test(node.className)) {
      node.removeAttribute("class");
    }
  }
  for (const link of fragment.querySelectorAll("a")) {
    showHost(link);
  }
  el.replaceChildren(fragment);
}

/** A web link shows its host after its text, unless the text already names
 * that host, and its address on hover. Any other link becomes its text. */
function showHost(link) {
  let url = null;
  try {
    url = new URL(link.getAttribute("href") ?? "");
  } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) {
    link.replaceWith(...link.childNodes);
    return;
  }
  link.title = url.href;
  const text = link.textContent.trim();
  let named = null;
  try {
    named = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).host;
  } catch {}
  if (named !== url.host) {
    link.append(span("host", url.host));
  }
}

function div(className, text) {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

const FILE_ICONS = { image: "🖼", pdf: "📕", text: "📄" };

/** An attached file: its thumbnail, or an icon for its kind. */
function fileBadge(file, className) {
  const el = div(className);
  el.title = file.info ? `${file.name} · ${file.info}` : file.name;
  if (file.thumb) {
    const img = document.createElement("img");
    img.src = file.thumb;
    img.alt = "";
    el.append(img);
  } else {
    el.append(div("icon", FILE_ICONS[file.kind] ?? FILE_ICONS.text));
  }
  return el;
}

function listFor(c) {
  let list = lists.get(c);
  if (!list) {
    list = div("list");
    lists.set(c, list);
  }
  return list;
}

/** Icon buttons, [action, title] each: copy and save for a whole answer or one
 * code block, edit for a question. */
function actionRow(buttons) {
  const row = div("actions");
  for (const [action, title] of buttons) {
    const button = document.createElement("button");
    button.className = `icon ${action}`;
    button.dataset.action = action;
    button.title = title;
    button.setAttribute("aria-label", title);
    row.append(button);
  }
  return row;
}

function languageOf(code) {
  return code?.className.match(/(?:^|\s)language-(\S+)/)?.[1] ?? "";
}

/** Give each code block of a finished answer its own buttons. */
function addCodeActions(body) {
  for (const pre of body.querySelectorAll("pre")) {
    const block = div("code");
    pre.replaceWith(block);
    const extension = extensionFor(languageOf(pre.querySelector("code")));
    block.append(pre, actionRow([["copy", "Copy the code"], ["save", `Save as .${extension}`]]));
  }
}

/** A question: where it came from, the passage it is about, its files, its
 * text, and a button to edit it. */
function fillQuestion(el, message) {
  const parts = [];
  if (message.source === "urlbar") {
    parts.push(div("src", "from the address bar"));
  }
  if (message.selection) {
    parts.push(div("selection", message.selection));
  }
  if (message.files?.length) {
    const row = div("files");
    for (const file of message.files) {
      const badge = fileBadge(file, `file ${file.kind}`);
      badge.append(div("name", file.name));
      row.append(badge);
    }
    parts.push(row);
  }
  parts.push(div("text", message.text));
  if (message.attached) {
    const what = message.attached.kind === "pdf" ? "PDF" : "Page";
    const how = message.attached.update ? "updated" : "attached";
    const cut = message.attached.truncated ? " (truncated)" : "";
    parts.push(div("meta", `${what} ${how}${cut} · ${message.page?.title ?? ""}`));
  }
  parts.push(actionRow([["edit", "Edit"]]));
  el.replaceChildren(...parts);
}

/** How a step's mark shows: done ✓, running, failed, or waiting for the user. */
function stepStatus(message) {
  if (message.status === "failed") {
    // Cut short when the user stopped the agent: not a failure of the step.
    return message.cut && conv?.stopped ? "stopped" : "failed";
  }
  if (message.status === "completed") {
    return "done";
  }
  if (message.zen === "wait" && message.args?.user) {
    return "waiting";
  }
  return conv?.busy ? "running" : "stopped";
}

/**
 * A tool call as a step the user can read (AgentService's describeTool): a
 * zenius tool's step as its result starts, or the agent's description of a
 * command with the command folded under it. finish's kept tabs are lines
 * under its step.
 */
function fillStep(el, message) {
  el.dataset.status = stepStatus(message);
  const [first, ...more] = String(message.step || message.title || "Tool").split("\n");
  const line = [span("mark"), span("label", first)];
  const sub = more.map(text => div("sub", text.trim()));
  // A step the user stopped folds nothing: the agent's note on the stop
  // ("The user doesn't want to proceed…") is for the agent.
  if (message.detail && el.dataset.status !== "stopped") {
    const wasOpen = !!el.querySelector(":scope > details")?.open;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.append(...line);
    const pre = document.createElement("pre");
    pre.textContent = message.detail;
    details.append(summary, ...sub, pre);
    details.open = wasOpen;
    el.replaceChildren(details);
  } else {
    el.replaceChildren(div("line"), ...sub);
    el.firstChild.append(...line);
  }
  el.title = message.step?.includes("\n") ? message.step : "";
}

/** The element of a new message, in its place: a tool call joins the steps
 * box of the tool calls right before it. */
function placeMessage(message, index, el) {
  const list = listFor(conv);
  if (message.role !== "tool") {
    list.append(el);
    return;
  }
  let i = index - 1;
  while (i >= 0 && conv.messages[i].hidden) {
    i--;
  }
  const before = conv.messages[i];
  const beforeEl = before?.role === "tool" ? rendered.get(before)?.el : null;
  let group = beforeEl?.parentElement?.classList.contains("steps") ? beforeEl.parentElement : null;
  if (!group || group !== list.lastElementChild) {
    group = div("steps");
    list.append(group);
  }
  group.append(el);
}

function renderMessage(message, index) {
  if (message.hidden) {
    return; // AgentService's HIDDEN_TOOLS
  }
  let entry = rendered.get(message);
  if (!entry) {
    entry = { el: div(message.role === "tool" ? "step" : `msg ${message.role}`), v: 0 };
    rendered.set(message, entry);
    messageOf.set(entry.el, message);
    placeMessage(message, index, entry.el);
  }
  if (entry.v === message.v && message.role !== "tool") {
    return;
  }
  const status = message.role === "tool" ? stepStatus(message) : null;
  if (entry.v === message.v && entry.status === status) {
    return;
  }
  entry.v = message.v;
  entry.status = status;
  const { el } = entry;
  switch (message.role) {
    case "user":
      if (editing?.message !== message) {
        fillQuestion(el, message); // an open editor shows it again when it closes
      }
      break;
    case "assistant": {
      // The buttons come once the answer is complete: while it streams, it
      // is parsed again every 50 ms.
      const body = el.firstChild ?? el.appendChild(div("body"));
      renderMarkdown(body, message.text);
      el.dataset.state = message.state;
      if (message.state !== "streaming") {
        addCodeActions(body);
        if (!body.nextSibling) {
          el.append(actionRow([["copy", "Copy the Markdown"], ["save", "Save as .md"]]));
        }
      }
      break;
    }
    case "tool":
      fillStep(el, message);
      break;
    case "permission": {
      const row = div("options");
      if (message.answer === null) {
        for (const option of message.options) {
          const button = document.createElement("button");
          button.textContent = option.name;
          button.dataset.kind = option.kind;
          button.addEventListener("click", () => AgentService.answerPermission(conv, message, option.id));
          row.append(button);
        }
      } else {
        const chosen = message.options.find(o => o.id === message.answer);
        row.textContent = chosen ? `→ ${chosen.name}` : "Not allowed";
      }
      el.replaceChildren(div("title", `The agent wants to: ${message.title}`), row);
      break;
    }
    default:
      el.textContent = message.text;
  }
}

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 40;
}

function renderMessages() {
  clearTimeout(renderTimer);
  renderTimer = null;
  lastRender = Date.now();
  if (!conv) {
    return;
  }
  const stick = nearBottom();
  conv.messages.forEach((message, i) => renderMessage(message, i));
  if (stick) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  renderStatus();
}

function scheduleRender() {
  if (!renderTimer) {
    const wait = Math.max(0, lastRender + RENDER_INTERVAL - Date.now());
    renderTimer = setTimeout(() => window.requestAnimationFrame(renderMessages), wait);
  }
}

/** Fill a <select> from an ACP config option (flat or grouped values). */
function fillSelect(select, option, value) {
  select.replaceChildren();
  const add = (parent, o) => {
    const el = document.createElement("option");
    el.value = o.value;
    el.textContent = o.name || o.value;
    parent.append(el);
  };
  for (const o of option.options ?? []) {
    if (Array.isArray(o.options)) {
      const group = document.createElement("optgroup");
      group.label = o.name;
      o.options.forEach(x => add(group, x));
      select.append(group);
    } else {
      add(select, o);
    }
  }
  select.value = value;
  select.dataset.optionId = option.id;
  select.title = `${option.name || option.id}: ${select.selectedOptions[0]?.textContent ?? value}`;
}

/** A task keeps the agent it started with: a session can't move to another. */
function harnessLocked() {
  return conv?.kind === "work" && conv.messages.length > 0;
}

/**
 * An agent's settings as the panel shows them: its session's own, or,
 * before a session exists, the last ones it reported, with the user's
 * choice in them.
 */
function settingsOf(harness) {
  const live = conv?.harness === harness && conv.configOptions;
  const options = (live ? conv.configOptions : AgentService.options.get(harness)) ?? [];
  const value = option => {
    const wanted = live ? option.currentValue : AgentService.preferredValue(harness, option.id);
    return optionValues(option).includes(wanted) ? wanted : option.currentValue;
  };
  const model = options.find(o => o.id === MODEL_OPTION) ?? null;
  const effort = options.find(o => EFFORT_OPTIONS.includes(o.id)) ?? null;
  return { model, modelValue: model && value(model), effort, effortValue: effort && value(effort) };
}

/** A model option's flat list of { value, name } (ACP may group them). */
function modelChoices(option) {
  return (option?.options ?? []).flatMap(o => (Array.isArray(o.options) ? o.options : [o]));
}

/**
 * Whether an agent can run here: AgentService.harnessAvailable (the process
 * side's, zen-observe's) says, with the reason when it can't, such as Codex
 * until it can be held to the browser. Without it, every agent can.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function availability(harness) {
  try {
    return AgentService.harnessAvailable?.(harness) ?? { ok: true };
  } catch {
    return { ok: true };
  }
}

/**
 * The agent and model, as one menu grouped by agent (the row reads "Opus 5.5
 * · Low"), and the effort. An option's value is "<harness>/<model>"; an agent
 * that hasn't reported its models yet is one option, its name. A task keeps
 * its agent, so the other agents' groups are off there; an agent that can't
 * run here is off everywhere, its group saying why.
 */
function renderOptions() {
  if (!conv) {
    return;
  }
  const locked = harnessLocked();
  const groups = [];
  for (const h of harnesses) {
    const { model, modelValue } = settingsOf(h.id);
    const group = document.createElement("optgroup");
    const available = availability(h.id);
    group.label = available.ok ? h.name : `${h.name}: ${available.reason || "not available"}`;
    group.dataset.harness = h.id;
    group.disabled = (locked && h.id !== conv.harness) || !available.ok;
    if (!available.ok) {
      group.dataset.unavailable = "true";
    }
    const choices = modelChoices(model);
    for (const choice of choices.length ? choices : [{ value: "", name: h.name }]) {
      const el = document.createElement("option");
      el.value = `${h.id}/${choice.value}`;
      el.dataset.harness = h.id;
      el.textContent = choice.name || choice.value;
      el.selected = h.id === conv.harness && (choice.value === (modelValue ?? "") || !choices.length);
      group.append(el);
    }
    groups.push(group);
  }
  els.model.replaceChildren(...groups);
  // A model the agent no longer offers: its first one, never another agent's.
  if (!els.model.value.startsWith(`${conv.harness}/`)) {
    const first = els.model.querySelector(`option[data-harness="${CSS.escape(conv.harness)}"]`);
    if (first) {
      first.selected = true;
    }
  }
  els.model.hidden = !groups.length;
  const current = settingsOf(conv.harness);
  const agent = harnesses.find(h => h.id === conv.harness)?.name ?? conv.harness;
  els.model.title = `${agent}${current.model ? ` · ${els.model.selectedOptions[0]?.textContent ?? ""}` : ""}${
    locked ? " (this task's agent)" : ""
  }`;

  els.effort.hidden = !current.effort;
  els.pickDot.hidden = !current.effort;
  if (current.effort) {
    fillSelect(els.effort, current.effort, current.effortValue);
  }
  disableOptions();
}

function disableOptions() {
  const busy = !!conv?.busy;
  els.model.disabled = busy;
  els.effort.disabled = busy;
}

// --- The header (the chat's title) and the Chat | Work switch ---------------------

function setFavicon(src) {
  const url = src || DEFAULT_FAVICON;
  if (els.favicon.getAttribute("src") !== url) {
    els.favicon.src = url;
  }
}
els.favicon.addEventListener("error", () => {
  if (els.favicon.getAttribute("src") !== DEFAULT_FAVICON) {
    els.favicon.src = DEFAULT_FAVICON;
  }
});

function renderBinding() {
  const work = conv?.kind === "work";
  document.documentElement.dataset.mode = work ? "work" : "chat";
  els.toChat.setAttribute("aria-pressed", String(!work));
  els.toWork.setAttribute("aria-pressed", String(work));
  els.dir.hidden = !work;
  els.favicon.hidden = work;
  if (work) {
    // The task's state is the directory's to show; hovering the title says it too.
    const { state, since, text } = conv.task;
    const name = conv.title || "New task";
    els.title.textContent = name;
    els.title.title = state === "new" ? name : `${name}\n${STATE_LABELS[state]} · ${age(since)}${text ? `: ${text}` : ""}`;
  } else {
    const info = glue.pageInfo();
    els.title.textContent = info.title;
    els.title.title = info.url ? `${info.title}\n${info.url}` : info.title;
    setFavicon(info.image);
  }
  renderNeeds();
  renderMenu();
  renderLive();
}

/** The Work switch's orange count: the tasks that need the user. */
function renderNeeds() {
  const n = AgentService.needsCount();
  els.needs.hidden = n === 0;
  els.needs.textContent = String(n);
  els.toWork.title = n
    ? `Your tasks: ${n === 1 ? "1 needs" : `${n} need`} you`
    : "Your tasks, whichever tab you're on";
}

let bindingFrame = 0;
function scheduleBinding() {
  if (!bindingFrame) {
    bindingFrame = window.requestAnimationFrame(() => {
      bindingFrame = 0;
      renderBinding();
    });
  }
}

els.toChat.addEventListener("click", () => {
  if (conv?.kind === "work") {
    glue.setMode("chat");
  }
  els.input.focus();
});
els.toWork.addEventListener("click", () => {
  if (conv?.kind !== "work") {
    glue.setMode("work");
  } else {
    glue.toggleDirectory();
  }
  els.input.focus();
});
els.dir.addEventListener("click", () => glue.toggleDirectory());

// A click anywhere in the panel is outside the directory (but its button).
document.addEventListener(
  "mousedown",
  event => {
    if (glue.directoryOpen && !event.target.closest?.("#dir, #to-work")) {
      glue.closeDirectory();
    }
    if (!els.menu.hidden && !event.target.closest?.("#menu, #more")) {
      closeMenu();
    }
  },
  true
);

// --- The ⋯ menu -------------------------------------------------------------------

function renderMenu() {
  const work = conv?.kind === "work";
  els.newChat.hidden = work;
  els.removeTask.hidden = !work || !AgentService.tasks.has(conv?.uid);
}

function closeMenu() {
  els.menu.hidden = true;
  els.more.setAttribute("aria-expanded", "false");
}

els.more.addEventListener("click", () => {
  if (els.menu.hidden) {
    renderMenu();
    els.menu.hidden = false;
    els.more.setAttribute("aria-expanded", "true");
    els.menu.querySelector("button:not([hidden])")?.focus();
  } else {
    closeMenu();
  }
});
els.menu.addEventListener("keydown", event => {
  const items = [...els.menu.querySelectorAll("button:not([hidden])")];
  const i = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
    els.more.focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
});
els.newChat.addEventListener("click", () => {
  closeMenu();
  if (conv && conv.kind !== "work") {
    AgentService.reset(conv);
    els.input.value = "";
    autoGrow();
    els.input.focus();
  }
});
els.newTask.addEventListener("click", () => {
  closeMenu();
  glue.newTask();
});
els.removeTask.addEventListener("click", () => {
  closeMenu();
  if (conv?.kind === "work") {
    AgentService.removeTask(conv);
    glue.setMode("work");
  }
});
$("close").addEventListener("click", () => {
  closeMenu();
  glue.closePanel();
});

// --- The composer --------------------------------------------------------------

function placeholder() {
  const available = conv ? availability(conv.harness) : { ok: true };
  if (!available.ok) {
    return available.reason || "This agent isn't available";
  }
  if (conv?.kind === "work") {
    return conv.messages.length ? PLACEHOLDERS.reply : PLACEHOLDERS.task;
  }
  return PLACEHOLDERS.chat;
}

/** While the agent works, the empty question box says what it is doing and
 * Send turns into Stop. */
function renderStatus() {
  const busy = !!conv?.busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.input.placeholder = busy
    ? conv.status || "Working…"
    : waitingFor && waitingFor === conv
      ? "Reading the files…"
      : placeholder();
  document.body.classList.toggle("busy", busy);
  els.empty.hidden = !!conv?.messages.length;
  disableOptions();
  updateSend();
}

/** Send is dimmed while there is nothing to send. */
function updateSend() {
  const draft = conv?.draft;
  els.send.disabled = !els.input.value.trim() && !draft?.selection && !draft?.attachments?.length;
}

function renderChip() {
  const selection = conv?.draft?.selection ?? "";
  els.chip.hidden = !selection;
  els.chipText.textContent = selection;
  updateSend();
}

/** The files waiting in the composer, each with a ✕ to take it out. */
function renderAttachments() {
  const items = conv?.draft?.attachments ?? [];
  els.attachments.hidden = !items.length;
  updateSend();
  els.attachments.replaceChildren(
    ...items.map(item => {
      const el = fileBadge(item, `attachment ${item.state}`);
      if (item.error) {
        el.title = `${item.name}: ${item.error}`;
      }
      const label = div("label");
      label.append(div("name", item.name), div("info", item.state === "reading" ? "Reading…" : item.error || item.info));
      const remove = document.createElement("button");
      remove.className = "icon remove";
      remove.title = "Remove";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        const list = conv?.draft?.attachments ?? [];
        if (list.includes(item)) {
          list.splice(list.indexOf(item), 1);
        }
        renderAttachments();
        els.input.focus();
      });
      el.append(label, remove);
      return el;
    })
  );
}

function renderAll() {
  els.messages.replaceChildren(listFor(conv), els.live);
  renderBinding();
  renderOptions();
  renderChip();
  renderAttachments();
  renderMessages();
  els.messages.scrollTop = els.messages.scrollHeight;
}

function onChange(change) {
  if (change.type === "reset") {
    editing = null;
    listFor(conv).replaceChildren();
    renderAll();
  } else if (change.type === "truncate") {
    // An edited question: it and what came after it go.
    for (const message of change.dropped) {
      rendered.get(message)?.el.remove();
    }
    for (const group of listFor(conv).querySelectorAll(":scope > .steps:empty")) {
      group.remove();
    }
  } else if (change.type === "session" || change.type === "options") {
    renderOptions();
  } else if (change.type === "status" || change.type === "busy") {
    if (conv?.busy) {
      stopEditing();
    }
    renderStatus();
    if (change.type === "busy") {
      scheduleRender(); // steps stop running with the turn
      renderOptions();
      renderLive();
    }
  } else if (change.type === "task" || change.type === "zen") {
    scheduleBinding();
  } else {
    scheduleRender();
  }
}

// --- Composer ---------------------------------------------------------------

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

function saveDraft() {
  if (conv) {
    const text = els.input.value;
    const selection = conv.draft?.selection ?? "";
    const attachments = conv.draft?.attachments ?? [];
    conv.draft = text || selection || attachments.length ? { text, selection, attachments } : null;
  }
}

/** Attach files to the shown conversation's next question. They are read
 * right away, while the user types. */
function addFiles(files) {
  if (!conv || !files.length) {
    return;
  }
  const target = conv;
  target.draft = { text: els.input.value, selection: "", ...target.draft };
  target.draft.attachments ??= [];
  const maxChars = Services.prefs.getIntPref(PREF_MAX_CHARS, 120000);
  for (const file of files) {
    const item = { name: file.name || "file", kind: kindOf(file), state: "reading", info: "", error: "" };
    item.ready = readAttachment(file, { maxChars })
      .then(
        read => Object.assign(item, read, { state: "ready" }),
        e => {
          if (!(e instanceof Refused)) {
            console.error("[agent-sidebar] could not read", item.name, e);
          }
          Object.assign(item, { state: "error", error: e instanceof Refused ? e.message : "could not read it" });
        }
      )
      .then(() => conv === target && renderAttachments());
    target.draft.attachments.push(item);
  }
  renderAttachments();
}

async function submit() {
  if (!conv || conv.busy || waitingFor === conv) {
    return;
  }
  const target = conv;
  const items = target.draft?.attachments ?? [];
  if (items.some(item => item.state === "reading")) {
    waitingFor = target;
    renderStatus();
    try {
      await Promise.all(items.map(item => item.ready));
    } finally {
      waitingFor = null;
    }
    if (conv !== target) {
      return; // another tab is shown now; the files stay with this one
    }
    renderStatus();
    if (target.busy) {
      return;
    }
  }
  const selection = target.draft?.selection ?? "";
  const attachments = items
    .filter(item => item.state === "ready")
    .map(({ state, error, ready, ...attachment }) => attachment);
  const question = els.input.value.trim() || (selection || attachments.length ? glue.defaultQuestion() : "");
  if (!question) {
    return;
  }
  els.input.value = "";
  autoGrow();
  target.draft = null;
  renderChip();
  renderAttachments();
  await glue.submit(target, { question, selection, attachments });
}

/** Typing a question starts the agent and the session if they were stopped
 * (after sitting unused) or closed, so they are ready by the time it is sent. */
function warmUp() {
  if (conv && !conv.busy && (!conv.sessionId || !conv.conn || conv.conn.exited)) {
    AgentService.prewarm(conv);
  }
}

els.input.addEventListener("input", () => {
  autoGrow();
  updateSend();
  warmUp();
});
els.input.addEventListener("focus", warmUp);
els.input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (glue.directoryOpen) {
      glue.closeDirectory();
    } else {
      glue.focusPage();
    }
  }
});
els.send.addEventListener("click", submit);
els.stop.addEventListener("click", () => conv && AgentService.cancel(conv));
$("chip-remove").addEventListener("click", () => {
  if (conv?.draft) {
    conv.draft.selection = "";
  }
  renderChip();
  els.input.focus();
});

// Files: the + button, a paste (a screenshot, or files copied in Finder), or
// a drop anywhere on the panel.
els.attach.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  addFiles([...els.fileInput.files]);
  els.fileInput.value = "";
  els.input.focus();
});
els.input.addEventListener("paste", event => {
  const data = event.clipboardData;
  if (!data) {
    return;
  }
  let files = [...data.files]; // files copied in Finder
  // An image, unless the paste is really text that also has a picture of
  // itself (some apps add one). "Copy Image" adds the image's URL as text.
  const text = data.getData("text/plain");
  if (!files.length && (!text.trim() || /^\s*(https?|data|blob|file):\S*\s*$/.test(text))) {
    try {
      const image = imageFromClipboard(data);
      files = image ? [image] : [];
    } catch (e) {
      console.error("[agent-sidebar] could not read the pasted image", e);
    }
  }
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});
let dragDepth = 0;
const carriesFiles = event => [...(event.dataTransfer?.types ?? [])].includes("Files");
function endDrag() {
  dragDepth = 0;
  document.body.classList.remove("dragging");
}
document.addEventListener("dragenter", event => {
  if (carriesFiles(event)) {
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
document.addEventListener("dragover", event => {
  if (carriesFiles(event)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("dragleave", event => {
  if (carriesFiles(event) && --dragDepth <= 0) {
    endDrag();
  }
});
document.addEventListener("drop", event => {
  if (carriesFiles(event)) {
    event.preventDefault();
    endDrag();
    addFiles([...event.dataTransfer.files]);
    els.input.focus();
  }
});

// The agent and model menu: another agent's model starts that agent (a
// session can't move), with the model as its pick.
els.model.addEventListener("change", () => {
  if (!conv) {
    return;
  }
  const value = els.model.value;
  const cut = value.indexOf("/");
  const harness = value.slice(0, cut);
  const model = value.slice(cut + 1);
  if (harness !== conv.harness) {
    if (harnessLocked()) {
      renderOptions();
      return;
    }
    AgentService.setHarness(conv, harness);
  }
  if (model) {
    AgentService.setOption(conv, MODEL_OPTION, model);
  }
  els.input.focus();
});
els.effort.addEventListener("change", () => {
  if (conv && els.effort.dataset.optionId) {
    AgentService.setOption(conv, els.effort.dataset.optionId, els.effort.value);
  }
});

// --- Editing a question -------------------------------------------------------

/** Edit a question in place. Sending it asks again from there: the question
 * and everything after it go, and the agent forgets them (AgentService.send).
 * The passage and the files go with it as they were. */
function startEditing(el) {
  const message = messageOf.get(el);
  if (!conv || conv.busy || !message) {
    return;
  }
  stopEditing();
  editing = { message, el };
  const box = document.createElement("textarea");
  box.rows = 1;
  box.value = message.text;
  box.setAttribute("aria-label", "Edit the question");
  const cancel = document.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = "Cancel";
  const send = document.createElement("button");
  send.className = "send";
  send.textContent = "Send";
  const buttons = div("buttons");
  buttons.append(cancel, send);
  const editor = div("editor");
  editor.append(box, buttons);
  el.querySelector(":scope > .text").replaceWith(editor);
  el.querySelector(":scope > .meta")?.remove();
  el.querySelector(":scope > .actions")?.remove();
  el.classList.add("editing");
  const grow = () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 300)}px`;
  };
  box.addEventListener("input", grow);
  box.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendEdit(box.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      stopEditing();
      els.input.focus();
    }
  });
  cancel.addEventListener("click", () => {
    stopEditing();
    els.input.focus();
  });
  send.addEventListener("click", () => sendEdit(box.value));
  grow();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

/** Close the editor; the question shows as it was. */
function stopEditing() {
  if (!editing) {
    return;
  }
  const { message, el } = editing;
  editing = null;
  el.classList.remove("editing");
  fillQuestion(el, message);
}

function sendEdit(text) {
  const message = editing?.message;
  if (!message || !conv || conv.busy) {
    return;
  }
  const attachments = message.attachments ?? [];
  const question = text.trim() || (message.selection || attachments.length ? glue.defaultQuestion() : "");
  if (!question) {
    return;
  }
  editing = null; // the question's element goes with it
  els.input.focus();
  glue.submit(conv, { question, selection: message.selection, attachments, replace: message, source: message.source });
}

// --- Copying and saving answers ---------------------------------------------

/** The page of the question an answer replies to. */
function pageBefore(message) {
  const i = conv?.messages.indexOf(message) ?? -1;
  return i < 0 ? null : (conv.messages.slice(0, i).findLast(m => m.role === "user")?.page ?? null);
}

const feedbackTimers = new WeakMap();

/** Say what a button did, next to it, for a moment. A check mark replaces
 * its icon unless it failed. */
function flash(row, action, text, failed = false) {
  clearTimeout(feedbackTimers.get(row));
  if (failed) {
    delete row.dataset.done;
  } else {
    row.dataset.done = action;
  }
  row.dataset.feedback = text;
  row.classList.toggle("failed", failed);
  feedbackTimers.set(
    row,
    setTimeout(() => {
      delete row.dataset.done;
      delete row.dataset.feedback;
      row.classList.remove("failed");
    }, 2500)
  );
}

/** Copy or save an answer's Markdown, or one of its code blocks. */
async function act(button) {
  const row = button.closest(".actions");
  const message = messageOf.get(row.closest(".msg"));
  const block = row.closest(".code");
  const action = button.dataset.action;
  let text, extension;
  if (block) {
    const code = block.querySelector("pre code") ?? block.querySelector("pre");
    text = code.textContent.replace(/\n$/, "");
    extension = extensionFor(languageOf(code));
  } else {
    text = message.text.trim();
    extension = "md";
  }
  try {
    if (action === "copy") {
      copyText(window, text);
      flash(row, action, "Copied");
    } else {
      const page = pageBefore(message);
      const path = await saveText(window, {
        name: fileName(text, extension, page?.title ?? (conv?.kind === "work" ? conv.title : undefined)),
        text: `${text}\n`,
        source: page?.url,
      });
      if (path) {
        flash(row, action, `Saved “${PathUtils.filename(path)}”`);
      }
    }
  } catch (e) {
    console.error(`[agent-sidebar] could not ${action} it`, e);
    flash(row, action, action === "copy" ? "Could not copy it" : "Could not save it", true);
  }
}

els.messages.addEventListener("click", event => {
  const button = event.target.closest(".actions button");
  if (button) {
    if (button.dataset.action === "edit") {
      startEditing(button.closest(".msg"));
    } else {
      act(button);
    }
    return;
  }
  // Links in answers open in a new tab, never inside the panel, and only on
  // the user's own click.
  const link = event.target.closest("a[href]");
  if (link) {
    event.preventDefault();
    if (event.isTrusted) {
      glue.openLink(link.href);
    }
  }
});

// --- The page the agent is on (Work) -----------------------------------------
//
// The card is drawn only while the user can see it, and only on a timer: one
// picture when it appears (or its task moves to another tab), then one every
// 2 s while the agent works there. Each picture is painted in the page's own
// process, only the part the card shows and at the card's own scale
// (AgentSidebarPictureParent.sys.mjs), so a page that is costly to paint
// can't stall the user's browser through the card: the parent only copies
// the pixels in. A costly page is drawn less often, and after a very slow
// picture the card keeps it until the card appears again.

const { drawPicture } = ChromeUtils.importESModule(new URL("AgentSidebarPictureParent.sys.mjs", import.meta.url).href);
// After a picture that took longer than LIVE_SLOW_MS to come (timed here, so
// the page's process can't say it was quick), the next waits 40 times as long
// (at most LIVE_MAX_MS); past LIVE_STOP_MS the card keeps the picture it has.
const LIVE_SLOW_MS = 50;
const LIVE_STOP_MS = 1000;
const LIVE_MAX_MS = 30000;

let liveTimer = null;
let liveSeen = false; // some of the card is on screen (liveObserver)
let liveDrawing = false;
let liveAgain = false; // the card's tab changed during a picture: one more
let liveTab = null; // the tab the card's picture is of; null: draw one once it can be seen
let liveEvery = LIVE_EVERY_MS;
let liveKept = false; // a picture was too slow to paint again: the card keeps it

/**
 * The card is drawn only while the user can see it: some of it on screen
 * (the implicit root clips by the thread's scroll, the sidebar's frame and
 * the window), and the panel's document shown. A closed sidebar unloads the
 * panel, which stops it too.
 */
function liveVisible() {
  return liveSeen && !els.live.hidden && !document.hidden;
}

const liveObserver = new IntersectionObserver(entries => {
  liveSeen = entries.at(-1).isIntersecting;
  if (liveSeen) {
    liveTab = null; // it appears: one picture now
    renderLive();
  } else {
    stopLive();
  }
});
liveObserver.observe(els.live);

/** The host a tab's page is on, as the card names it. */
function hostOf(tab) {
  const uri = tab.linkedBrowser?.currentURI;
  let host = "";
  try {
    host = uri?.displayHost || "";
  } catch {}
  return host || uri?.spec || tab.label || "";
}

/** The shown task's tab for the card, and whether the agent works on it; null without one. */
function liveState() {
  const rec = conv?.kind === "work" ? AgentService.zenRecord(conv) : null;
  const tab = rec ? AgentService.zenFrontTab(conv) : null;
  if (!tab) {
    return null;
  }
  const held = AgentService.isHeld(conv);
  return { rec, tab, held, live: !!conv.busy && !held && rec.ownership === "agent" };
}

/**
 * The card at the end of a work chat: the page the agent is on (its zenius
 * task's front tab), with Watch (while this window watches the task, "⌃Tab
 * back to your tabs" in its place: ⌃Tab is the way back, the user's design)
 * and Take over (while the agent has the page, unless zenius reports the
 * Take over refused). Hidden until the task has a tab. Its line and buttons
 * follow every change; its picture doesn't (see above).
 */
function renderLive() {
  const state = liveState();
  els.live.hidden = !state;
  if (!state) {
    liveTab = null;
    stopLive();
    return;
  }
  const { rec, tab, held, live } = state;
  const host = hostOf(tab);
  const watching = glue.watching === conv.uid;
  els.live.dataset.live = String(live);
  els.live.dataset.watching = String(watching);
  els.liveText.textContent =
    held === "takeover" ? `You have control · ${host}` : held ? `Waiting for you · ${host}` : live ? `Live · ${host}` : host;
  els.liveText.title = [tab.label, tab.linkedBrowser?.currentURI?.spec].filter(Boolean).join("\n");
  els.watch.hidden = watching;
  els.watchHint.hidden = !watching;
  // After a refusal, zenius's card on the page holds the user's choices, with
  // Try again only where it can work: pressed here, Take over would fail the
  // same way (zen-snapshot).
  els.takeOver.hidden = rec.ownership !== "agent" || AgentService.takeOverRefused(conv);
  if (!liveVisible()) {
    stopLive();
    return;
  }
  if (tab !== liveTab) {
    // The card appeared, or the task moved to another tab: one picture now,
    // and the pace starts over.
    liveTab = tab;
    liveEvery = LIVE_EVERY_MS;
    liveKept = false;
    els.live.dataset.every = String(liveEvery);
    drawLive(tab);
  }
  if (live && !liveKept) {
    scheduleLive();
  } else {
    stopLive();
  }
}

/** The next picture, liveEvery from now, while the card is seen and the agent works. */
function scheduleLive() {
  if (liveTimer) {
    return;
  }
  liveTimer = setTimeout(async () => {
    liveTimer = null;
    const state = liveVisible() ? liveState() : null;
    if (!state?.live || liveKept) {
      return;
    }
    if (state.tab !== liveTab) {
      renderLive();
      return;
    }
    await drawLive(state.tab);
    if (liveVisible() && liveState()?.live && !liveKept) {
      scheduleLive();
    }
  }, liveEvery);
}

function stopLive() {
  clearTimeout(liveTimer);
  liveTimer = null;
}

/**
 * One picture of the top of `tab`'s page, as wide as the card, painted in
 * the page's process; the panel copies its pixels in. The picture is for the
 * user's eyes only and never goes to the agent. drawPicture paints only an
 * agent's page of the chat's own task while the agent has it: otherwise, as
 * while the user holds the task, the card keeps its last picture.
 */
async function drawLive(tab) {
  const canvas = els.liveShot;
  if (liveDrawing) {
    liveAgain = true;
    return;
  }
  if (!liveVisible() || !canvas.clientWidth) {
    return;
  }
  liveDrawing = true;
  try {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    // Timed here, the whole ask: the page's process can only make it longer,
    // and an ask it never answers (drawPicture gives up after 5 s) counts as
    // a very slow picture.
    const asked = performance.now();
    const picture = await drawPicture(conv, tab, { width, height });
    const ms = performance.now() - asked;
    if (tab !== liveTab) {
      return;
    }
    if (ms > LIVE_SLOW_MS) {
      liveEvery = Math.min(LIVE_MAX_MS, Math.max(liveEvery, Math.round(ms * 40)));
    }
    if (ms > LIVE_STOP_MS) {
      liveKept = true;
      stopLive();
    }
    // The wait for the next picture ("kept" after a very slow one): tests
    // check it.
    els.live.dataset.every = liveKept ? "kept" : String(liveEvery);
    if (!picture || !liveVisible()) {
      return;
    }
    // A copy in this document's own compartment, of exactly the picture's
    // bytes, so ImageData takes it whole.
    const copy = structuredClone(picture.pixels);
    const pixels = new Uint8ClampedArray(copy.buffer, copy.byteOffset, copy.byteLength);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.putImageData(new ImageData(pixels, picture.width, picture.height), 0, 0);
    // How many pictures the card has drawn: tests count them.
    els.live.dataset.drawn = String(Number(els.live.dataset.drawn ?? 0) + 1);
  } catch (e) {
    // A page between documents has nothing to draw; the next round does.
    if (Services.prefs.getBoolPref("uc.agent-sidebar.debug", false)) {
      console.debug("[agent-sidebar] no live picture:", e.message);
    }
  } finally {
    liveDrawing = false;
    if (liveAgain) {
      liveAgain = false;
      if (liveTab && liveTab !== tab) {
        drawLive(liveTab);
      }
    }
  }
}

els.watch.title = `Show the task's tabs here; ${CTRL_TAB} brings you back`;
els.watchHint.replaceChildren(Object.assign(document.createElement("kbd"), { textContent: CTRL_TAB }), " back to your tabs");
els.watch.addEventListener("click", () => {
  if (conv && glue.watching !== conv.uid) {
    glue.watch(conv.uid).then(shown => shown || renderLive());
  }
});

els.takeOver.addEventListener("click", () => {
  if (conv) {
    glue.takeOver(conv.uid).then(() => renderLive());
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopLive();
  } else {
    liveTab = null; // it appears again: one picture now
    renderLive();
  }
});

// --- Wiring to the window -----------------------------------------------------

const api = {
  /** Show a conversation: the selected tab's, or a task's. */
  show(next) {
    if (conv === next) {
      renderBinding();
      return;
    }
    stopEditing();
    saveDraft();
    unsubscribe?.();
    conv = next;
    unsubscribe = conv.subscribe(onChange);
    els.input.value = conv.draft?.text ?? "";
    autoGrow();
    renderAll();
  },
  /** Show the conversation with the selection ready, and the cursor in the box. */
  compose(next, { selection }) {
    this.show(next);
    if (selection) {
      conv.draft = { ...conv.draft, text: els.input.value, selection };
      renderChip();
    }
    els.input.focus();
  },
  /** The selected tab changed or went to another page: the Page header follows. */
  pageChanged() {
    if (conv?.kind !== "work") {
      scheduleBinding();
    }
  },
  /** The directory opened or closed (its button shows it). */
  directoryChanged(open) {
    els.dir.classList.toggle("on", open);
    els.dir.setAttribute("aria-expanded", String(open));
  },
  /** Put the cursor in the question box. */
  focus() {
    els.input.focus();
  },
  /** The window started or stopped watching a task (the live card's Watch says Back). */
  watchChanged() {
    renderLive();
  },
};

const unsubscribeTasks = AgentService.subscribeTasks(() => scheduleBinding());

window.addEventListener("unload", () => {
  stopLive();
  liveObserver.disconnect();
  saveDraft();
  unsubscribe?.();
  unsubscribeTasks();
  glue?.detachPanel(api);
});

AgentService.harnesses()
  .then(list => {
    harnesses = list;
    renderOptions();
  })
  .catch(e => console.error("[agent-sidebar]", e));

glue?.attachPanel(api);
