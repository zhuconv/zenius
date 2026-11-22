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

const { AgentService, isCredentialAsk, MODEL_OPTION, EFFORT_OPTIONS, optionValues, concreteModel, modelGeneration, newestModels, STATE_LABELS, age, remoteSource, remoteEnd } = ChromeUtils.importESModule(
  new URL("AgentService.sys.mjs", import.meta.url).href
);
const { ENDED_TEXT, sourceParts } = ChromeUtils.importESModule(new URL("external.sys.mjs", import.meta.url).href);
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
// Steer's keys: Cmd+Enter on a Mac, Ctrl+Enter elsewhere.
const STEER_KEY = Services.appinfo.OS === "Darwin" ? "⌘Enter" : "Ctrl+Enter";
const steerKey = event => (Services.appinfo.OS === "Darwin" ? event.metaKey : event.ctrlKey);
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
  liveSrc: $("live-src"),
  remoteEnd: $("remote-end"),
  arrival: $("arrival"),
  arrivalText: $("arrival-text"),
  arrivalWatch: $("arrival-watch"),
  arrivalStop: $("arrival-stop"),
  arrivalClose: $("arrival-close"),
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
  pick: $("pick"),
  pickModel: $("pick-model"),
  pickDot: $("pick-dot"),
  pickEffort: $("pick-effort"),
  picker: $("picker"),
  pickSearch: $("pick-search"),
  pickFam: $("pick-fam"),
  pickNote: $("pick-note"),
  pickList: $("pick-list"),
  pickFly: $("pick-fly"),
  box: $("box"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  steer: $("steer"),
  queue: $("queue"),
  queueList: $("queue-list"),
  chip: $("chip"),
  chipText: $("chip-text"),
  attachments: $("attachments"),
  attach: $("attach"),
  fileInput: $("file-input"),
  extBar: $("ext-bar"),
  extBarText: $("ext-bar-text"),
  extStop: $("ext-stop"),
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

/**
 * Fill `el` with a remote task's source ("From <address> · <label>",
 * remoteSource), its address, the first isolate, set apart as a chip. The
 * text stays the same. The isolate's marks stay outside the chip: Gecko
 * breaks a line after a leading one even in a nowrap span, which leaves a
 * sliver of the chip on the line before (seen in Zen's narrow sidebar).
 */
function fillSource(el, text) {
  const start = text.indexOf("\u2068");
  const end = start < 0 ? -1 : text.indexOf("\u2069", start);
  if (end < 0) {
    el.textContent = text;
  } else {
    el.replaceChildren(text.slice(0, start + 1), span("addr", text.slice(start + 1, end)), text.slice(end));
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
    list = c.external ? externalView() : div("list");
    lists.set(c, list);
  }
  return list;
}

// --- A task the sidebar doesn't drive (external.sys.mjs) ---------------------
//
// Read-only (the user's ask, docs/briefs/external-tasks.md): where it's driven
// from, its steps from the runtime's own record (zen-input's ring), a card
// while it needs the user, then the live card. Every part from the page or the
// agent goes in as text, and each name a step quotes sits in its own isolate,
// so a step can't pass for a row of the panel's or pull the panel's words
// around (zen-snapshot's points for external tasks).

function externalView() {
  const view = div("list ext-view");
  const src = div("ext-src");
  src.id = "ext-src";
  const steps = div("ext-steps");
  steps.id = "ext-steps";
  view.append(src, steps);
  return view;
}

/** One line of text, at most `max` characters, for what a step or the agent says. */
function plainText(text, max) {
  return typeof text === "string" ? text.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, max) : "";
}

/**
 * A step's text, each double-quoted name in its own isolate (dir="auto"):
 * zen-input quotes a page's names and turns quote marks inside them into
 * apostrophes, so the pairs can't mix ('Drag "Card" to "Done"').
 */
function fillStepText(el, text) {
  const parts = text.split('"');
  const nodes = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1 && i < parts.length - 1) {
      const name = span("ext-name", part);
      name.dir = "auto";
      nodes.push('"', name, '"');
    } else if (part) {
      nodes.push(i % 2 === 1 ? `"${part}` : part);
    }
  });
  el.replaceChildren(...nodes);
}

/** "14:03:27": when a step began. */
function clockTime(at) {
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
}

/** A step's row: its text, its page when the task has more than one, its
 * outcome, its time. `prev` is the step before it: the look shows a page
 * where it changes (data-same-page). */
function stepRow(step, withPage, prev = null) {
  const outcome = step.outcome === "running" ? "running" : step.outcome === "ok" ? "ok" : "failed";
  const row = div("ext-step");
  row.dataset.step = String(step.id);
  row.dataset.outcome = outcome;
  const text = span("ext-text");
  fillStepText(text, plainText(step.text, 300));
  row.append(text);
  if (withPage && step.page) {
    row.append(span("ext-page", plainText(step.page, 40)));
    if (prev?.page === step.page) {
      row.dataset.samePage = "true";
    }
  }
  row.append(span("ext-outcome", outcome === "failed" ? plainText(String(step.outcome ?? ""), 60) : ""), span("ext-time", clockTime(step.at)));
  return row;
}

/** The external view's source line, steps and needs card, from the task as it stands. */
function renderExternal() {
  if (!conv?.external) {
    return;
  }
  const view = listFor(conv);
  // The task's state, for the look: a running step waits for the user while
  // it needs them, and has stopped once the task ended.
  view.dataset.state = conv.task.state;
  const src = view.querySelector(".ext-src");
  const parts = sourceParts(conv.from);
  const line = `Driven from ${parts ? parts.text : "elsewhere"} · read-only`;
  if (parts?.terminal) {
    fillSource(src, line);
  } else {
    src.textContent = line;
  }
  const steps = AgentService.externalTasks()?.steps(conv) ?? [];
  const withPage = new Set(steps.map(step => step.page).filter(Boolean)).size > 1;
  const box = view.querySelector(".ext-steps");
  const bottom = nearBottom();
  box.replaceChildren(...(steps.length ? steps.map((step, i) => stepRow(step, withPage, steps[i - 1])) : [div("ext-empty", "No steps yet")]));
  view.querySelector(".ext-needs")?.remove();
  if (conv.task.state === "needs") {
    const card = div("ext-needs");
    const text = span("ext-needs-text", conv.task.text);
    text.dir = "auto";
    const watch = document.createElement("button");
    watch.className = "ghost";
    watch.textContent = "Watch";
    watch.addEventListener("click", () => {
      if (conv?.external) {
        glue.watch(conv.uid).then(shown => shown || renderLive());
      }
    });
    card.append(span("ext-needs-title", "Needs you"), text, watch);
    view.append(card);
  }
  if (bottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  renderExternalBar();
}

/** The composer's line for an external task: Stop while it runs, how it ended once done. */
function renderExternalBar() {
  const external = !!conv?.external;
  els.extBar.hidden = !external;
  if (!external) {
    return;
  }
  const done = conv.task.state === "done";
  els.extBarText.textContent = done ? `${ENDED_TEXT[conv.ended] ?? "Ended"} · ${age(conv.endedAt || conv.task.since)}` : "The sidebar can't chat with this agent";
  els.extStop.hidden = done;
  // How it ended, for the look's mark.
  if (done && ENDED_TEXT[conv.ended]) {
    els.extBar.dataset.ended = conv.ended;
  } else {
    delete els.extBar.dataset.ended;
  }
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
  if (message.steered) {
    // Sent into the running turn (Steer, Cmd+Enter): the answer above it was
    // still coming, and it goes on below.
    parts.push(div("src", "steered into the agent's turn"));
  }
  if (message.source === "urlbar") {
    parts.push(div("src", "from the address bar"));
  } else if (message.source === "remote") {
    // Another of the user's agents sent it (remote tasks): which one.
    const from = remoteSource(conv);
    if (from) {
      parts.push(fillSource(div("src"), from));
    }
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

// --- The agent's own question (the explicit ask) ------------------------------
//
// AgentService turns an agent's ask (elicitation/create: Claude Code's
// AskUserQuestion, Codex's request_user_input, an MCP server's form) into
// { role: "ask", title, questions: [{ key, text, header, multi, options:
// [{ value, label, description }], other, secret }], answer }, and answers it
// with answerAsk(conv, message, { [key]: { picks, text } } or null for Skip).
// The card is Needs you's: the question with its options as buttons. With
// one question of one pick, a click answers at once; otherwise the picks wait
// for Send. Words go in the question box (Enter), which answers the first
// question that takes words; a secret one has a masked field of its own in
// the card, since the box's text is the chat's draft, which Stop puts back.
// The card names who asks: the chat's agent, or an MCP server (message.from).
// An ask for a password or a code (AgentService's isCredentialAsk; the
// safety rubric's row on the explicit ask) masks every field of words and
// says in a fixed line where those go: an injected agent can ask, but only
// the prompt kept passwords in the site. AgentService keeps none of its
// answer. A masked question shows its field right under it, and its options
// after the field as quiet pills, each one's description its tooltip.

/** The card's own line on an ask for a password or a code, which nothing the agent sends can change. */
const CREDENTIAL_LINE = "Passwords and codes go into the site itself: use Take over to sign in.";

/** Who asks: an MCP server's name for its form (message.from), else the chat's agent. */
function askerOf(message) {
  return message.from || harnesses.find(h => h.id === conv?.harness)?.name || conv?.harness || "The agent";
}

/** What the user gave each question of an open ask so far: { picks, text } by key. */
const askState = new WeakMap();

function heldFor(message) {
  let held = askState.get(message);
  if (!held) {
    held = new Map(message.questions.map(q => [q.key, { picks: [], text: "" }]));
    askState.set(message, held);
  }
  return held;
}

/** The agent's open ask in `target`, which it waits on: the box answers it. */
function openAsk(target = conv) {
  return target?.busy ? target.messages.findLast(m => m.role === "ask" && m.answer === null) : null;
}

/** One question of one pick, with no masked field: its option's click is the whole answer. */
function answersAtOnce(message) {
  const [q, ...rest] = message.questions;
  return !!q && !rest.length && !q.multi && !masked(message, q) && q.options.length > 0;
}

/** Whether `q` takes words at all: its "other" field, or a question of words only. */
function wordsFor(q) {
  return !!q.other || !q.options.length;
}

/** Whether `q`'s words go in a masked field of the card's own: a secret, or any of an ask for a password or a code. */
function masked(message, q) {
  return q.secret || (wordsFor(q) && isCredentialAsk(message));
}

/** Whether the question box's words can answer `q`. */
function takesWords(message, q) {
  return wordsFor(q) && !masked(message, q);
}

function isAnswered(held) {
  return held.picks.length > 0 || !!held.text.trim();
}

/** Every question has a pick or words: Send may go. */
function askComplete(message) {
  const held = heldFor(message);
  return message.questions.every(q => isAnswered(held.get(q.key)));
}

/** The answers answerAsk takes, from what the card holds. */
function askAnswers(message) {
  const held = heldFor(message);
  const answers = {};
  for (const q of message.questions) {
    const { picks, text } = held.get(q.key);
    if (picks.length || text.trim()) {
      answers[q.key] = { picks: [...picks], text: text.trim() };
    }
  }
  return answers;
}

function sendAsk(message, answers) {
  if (message.answer === null && conv?.messages.includes(message)) {
    AgentService.answerAsk(conv, message, answers);
  }
}

/** Words from the question box for the first question that takes them and has no answer yet: they answer it, and the ask goes once every question has one. */
function askWords(message, words) {
  const held = heldFor(message);
  const q =
    message.questions.find(q => takesWords(message, q) && !isAnswered(held.get(q.key))) ??
    message.questions.find(q => takesWords(message, q));
  if (!q) {
    return false;
  }
  held.get(q.key).text = words;
  if (askComplete(message)) {
    sendAsk(message, askAnswers(message));
  } else {
    const entry = rendered.get(message);
    if (entry) {
      fillAsk(entry.el, message);
    }
  }
  return true;
}

/** The card of an ask: open, its question and options; answered, what the user said. */
function fillAsk(el, message) {
  const first = message.questions[0];
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", `${askerOf(message)} asks: ${first?.text || message.title || ""}`);
  if (message.answer !== null) {
    el.classList.add("answered");
    const { action, summary } = message.answer;
    const said = action === "accept" ? `→ ${summary ?? ""}` : action === "decline" ? "Skipped" : "Not answered";
    // The question it answers: the ask's own title, else its questions'.
    const asked = message.title || message.questions.map(q => q.text).join(" · ");
    el.replaceChildren(div("ask-text", asked), div("ask-answer", said));
    // What the user typed, a secret's too, lives no longer than the card's question.
    askState.delete(message);
    return;
  }
  el.classList.remove("answered");
  const held = heldFor(message);
  // Needs you's dot and color, with the agent that asks: in Work, the user's
  // tasks may run on different agents.
  const parts = [div("ask-title", `${askerOf(message)} asks`)];
  if (isCredentialAsk(message)) {
    parts.push(div("ask-guard", CREDENTIAL_LINE));
  }
  if (message.title) {
    parts.push(div("ask-lead", message.title));
  }
  const send = document.createElement("button");
  send.className = "pill ask-send";
  send.textContent = "Send";
  const update = () => {
    send.disabled = !askComplete(message);
  };
  for (const q of message.questions) {
    const box = div("ask-q");
    if (q.header) {
      box.append(span("ask-header", q.header));
    }
    box.append(div("ask-text", q.text));
    // A masked question's field comes first, since its answer goes there,
    // and its options follow as one row of quiet pills (zen-ux's code card):
    // Claude Code's AskUserQuestion brings 2 to 4 options even for a code.
    const hidden = masked(message, q);
    let list = null;
    if (q.options.length) {
      list = div(hidden ? "ask-pills" : "ask-options");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", q.text);
      const buttons = new Map();
      const press = () => {
        for (const [button, value] of buttons) {
          button.setAttribute("aria-pressed", String(held.get(q.key).picks.includes(value)));
        }
      };
      for (const option of q.options) {
        const button = document.createElement("button");
        if (hidden) {
          button.className = "ask-pill";
          button.textContent = option.label;
          if (option.description) {
            button.title = option.description;
          }
        } else {
          button.className = q.multi ? "ask-opt multi" : "ask-opt";
          button.append(span("label", option.label));
          if (option.description) {
            button.append(span("desc", option.description));
          }
        }
        button.addEventListener("click", () => {
          if (answersAtOnce(message)) {
            sendAsk(message, { [q.key]: { picks: [option.value], text: "" } });
            return;
          }
          const mine = held.get(q.key);
          mine.picks = !q.multi
            ? [option.value]
            : mine.picks.includes(option.value)
              ? mine.picks.filter(value => value !== option.value)
              : [...mine.picks, option.value];
          press();
          update();
        });
        buttons.set(button, option.value);
        list.append(button);
      }
      press();
      if (!hidden) {
        box.append(list);
      }
    }
    if (hidden) {
      const input = document.createElement("input");
      input.type = "password";
      input.className = "ask-secret";
      input.autocomplete = "off";
      input.spellcheck = false;
      // Beside options, the field is the adapter's "Other" box, which is
      // what Claude tells the user to type in ("type the code in Other").
      input.placeholder = q.options.length ? "Other: hidden as you type" : "Hidden as you type. It goes to the agent, not into the chat.";
      input.setAttribute("aria-label", q.text);
      input.value = held.get(q.key).text;
      input.addEventListener("input", () => {
        held.get(q.key).text = input.value;
        update();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          if (askComplete(message)) {
            sendAsk(message, askAnswers(message));
          }
        }
      });
      box.append(input);
      if (list) {
        box.append(list);
      }
    } else if (takesWords(message, q) && held.get(q.key).text) {
      // Words the box gave this question while others still wait.
      box.append(div("ask-words", held.get(q.key).text));
    }
    parts.push(box);
  }
  const actions = div("ask-actions");
  actions.append(
    span("ask-hint", message.questions.some(q => takesWords(message, q)) ? "Or answer in your own words below." : "")
  );
  const skip = document.createElement("button");
  skip.className = "ask-skip";
  skip.textContent = "Skip";
  skip.addEventListener("click", () => sendAsk(message, null));
  actions.append(skip);
  if (!answersAtOnce(message)) {
    send.addEventListener("click", () => sendAsk(message, askAnswers(message)));
    actions.append(send);
  }
  update();
  parts.push(actions);
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

// --- The agent's wait for its first words --------------------------------------
//
// AgentService's thought, from the moment the question goes out until the
// agent's first words, step or question for the user: "Thinking · <what it's
// on> · 12 s" while it lasts (Codex's reasoning titles; Claude Code's
// thinking shows no words), then "Thought for 23 s", which opens to what it
// thought. Codex at a high effort can think for half a minute before its first
// word, which looked like a stall (the user's report, 2026-11-22). A thought
// with nothing to keep goes when it ends (endThought).

let thoughtTimer = null;

function thoughtSeconds(s) {
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * The row's words: "Thinking · <title> · 12 s" while it lasts, "Thought for
 * 23 s" after. "Thinking · <title>" clamps to two lines (zen-ux's call:
 * Claude Code's titles are whole sentences), the seconds stay beside it on
 * the first line, and the whole title is the row's tooltip.
 */
function fillThoughtLine(line, message) {
  const ended = message.ms !== null && message.ms !== undefined;
  const s = ended ? Math.max(1, Math.round(message.ms / 1000)) : Math.floor((Date.now() - message.started) / 1000);
  const label = ended ? `Thought for ${thoughtSeconds(s)}` : "Thinking";
  const title = ended ? "" : message.title || "";
  const time = !ended && s >= 1 ? ` · ${thoughtSeconds(s)}` : "";
  const key = `${label}\n${title}\n${time}`;
  if (line.dataset.key === key) {
    return;
  }
  line.dataset.key = key;
  // The parts keep their elements, and only their words change: a new label
  // each second, or with each new title, would start its pulse over, a
  // blink right where the user looks during the wait.
  if (line.childElementCount !== 2) {
    const head = span("head");
    head.append(span("label"), span("sep"), span("title"));
    line.replaceChildren(head, span("time"));
  }
  const [head, timeEl] = line.children;
  const words = [label, title ? " · " : "", title, time];
  for (const [i, el] of [...head.children, timeEl].entries()) {
    if (el.textContent !== words[i]) {
      el.textContent = words[i];
    }
  }
  if (title) {
    line.title = title;
  } else {
    line.removeAttribute("title");
  }
}

function fillThought(el, message) {
  const ended = message.ms !== null && message.ms !== undefined;
  el.classList.toggle("live", !ended);
  if (message.text?.trim()) {
    let details = el.querySelector(":scope > details");
    if (!details) {
      details = document.createElement("details");
      details.append(document.createElement("summary"), div("body"));
      el.replaceChildren(details);
    }
    fillThoughtLine(details.firstChild, message);
    renderMarkdown(details.lastChild, message.text);
  } else {
    const line = el.querySelector(":scope > .line") ?? div("line");
    fillThoughtLine(line, message);
    if (line.parentNode !== el) {
      el.replaceChildren(line);
    }
  }
}

/** The seconds of a live row go on with no word from the agent, while one shows (renderMessages). */
function tickThoughtsWhileLive() {
  if (!thoughtTimer && els.messages.querySelector(".msg.thought.live")) {
    thoughtTimer = setInterval(tickThoughts, 250);
  }
}

function tickThoughts() {
  const live = [...els.messages.querySelectorAll(".msg.thought.live")];
  for (const el of live) {
    const message = messageOf.get(el);
    const line = el.querySelector(":scope > .line, :scope > details > summary");
    if (message && line) {
      fillThoughtLine(line, message);
    }
  }
  if (!live.length) {
    clearInterval(thoughtTimer);
    thoughtTimer = null;
  }
}

/** The element of a new message, in its place: a tool call joins the steps
 * box of the tool calls right before it. So does a thought that comes after
 * a step, as a line of the box, and the steps after it go on in the same box
 * (zen-ux's call: the box stays one list). */
function placeMessage(message, index, el) {
  const list = listFor(conv);
  if (message.role !== "tool" && message.role !== "thought") {
    list.append(el);
    return;
  }
  let i = index - 1;
  while (i >= 0 && conv.messages[i].hidden) {
    i--;
  }
  const before = conv.messages[i];
  const beforeEl = before?.role === "tool" || before?.role === "thought" ? rendered.get(before)?.el : null;
  let group = beforeEl?.parentElement?.classList.contains("steps") ? beforeEl.parentElement : null;
  if (!group || group !== list.lastElementChild) {
    if (message.role === "thought") {
      list.append(el);
      return;
    }
    group = div("steps");
    list.append(group);
  }
  group.append(el);
}

function renderMessage(message, index) {
  if (message.hidden) {
    // AgentService's HIDDEN_TOOLS, and an ask's own tool call, which the
    // ask's card stands for: hidden once the ask comes (AgentService.onAsk),
    // which may be after the step showed.
    const shown = rendered.get(message);
    if (shown) {
      const group = shown.el.parentElement;
      shown.el.remove();
      rendered.delete(message);
      if (group?.classList.contains("steps") && !group.childElementCount) {
        group.remove();
      }
    }
    return;
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
      // A code block's buttons come once its part of the answer is complete:
      // while it streams, it is parsed again every 50 ms. The answer's own
      // come with the turn's end (renderAnswerActions).
      const body = el.firstChild ?? el.appendChild(div("body"));
      renderMarkdown(body, message.text);
      el.dataset.state = message.state;
      if (message.state !== "streaming") {
        addCodeActions(body);
      }
      break;
    }
    case "tool":
      fillStep(el, message);
      break;
    case "ask":
      fillAsk(el, message);
      break;
    case "thought":
      fillThought(el, message);
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
      } else if (message.replied) {
        // The user wrote back instead of choosing (steer declines it).
        row.textContent = "Declined: you replied";
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
  renderAnswerActions();
  if (stick) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
  tickThoughtsWhileLive();
  renderStatus();
}

/** A turn's answer: its parts, from the question to the next one, without
 * thoughts, steps, asks or notes. A steer starts a turn of its own. */
function turnParts(message) {
  const i = conv.messages.indexOf(message);
  let from = i;
  while (from > 0 && conv.messages[from - 1].role !== "user") {
    from--;
  }
  let to = i;
  while (to + 1 < conv.messages.length && conv.messages[to + 1].role !== "user") {
    to++;
  }
  return conv.messages.slice(from, to + 1).filter(m => m.role === "assistant" && !m.hidden && m.text.trim());
}

/**
 * One copy and save row per turn, on its last part, once the turn has ended
 * (zen-ux's call): the parts between thoughts and steps are one answer, which
 * the row copies and saves whole (act). Code blocks keep their own buttons.
 */
function renderAnswerActions() {
  // The turn the agent is on, steers and all, hasn't ended.
  const going = conv.busy ? conv.messages.findLastIndex(m => m.role === "user" && !m.steered) : conv.messages.length;
  const ends = new Set();
  let last = null;
  conv.messages.forEach((message, i) => {
    if (message.role === "user") {
      if (last && i <= going) {
        ends.add(last);
      }
      last = null;
    } else if (message.role === "assistant" && !message.hidden && message.text.trim()) {
      last = message;
    }
  });
  if (last && !conv.busy) {
    ends.add(last);
  }
  for (const el of listFor(conv).querySelectorAll(":scope > .msg.assistant")) {
    const has = el.querySelector(":scope > .actions");
    const wanted = ends.has(messageOf.get(el));
    if (wanted && !has) {
      el.append(actionRow([["copy", "Copy the Markdown"], ["save", "Save as .md"]]));
    } else if (!wanted && has) {
      has.remove();
    }
  }
}

/**
 * A chat shown again: the panel hears only the chat it shows, so what left
 * it meanwhile (a thought with nothing to keep, endThought) leaves its list
 * now.
 */
function pruneList() {
  const kept = new Set(conv.messages);
  const list = listFor(conv);
  for (const el of list.querySelectorAll(".msg, .step")) {
    const message = messageOf.get(el);
    if (message && !kept.has(message)) {
      el.remove();
    }
  }
  for (const group of list.querySelectorAll(":scope > .steps:empty")) {
    group.remove();
  }
}

function scheduleRender() {
  if (!renderTimer) {
    const wait = Math.max(0, lastRender + RENDER_INTERVAL - Date.now());
    renderTimer = setTimeout(() => window.requestAnimationFrame(renderMessages), wait);
  }
}

/** A task keeps the agent it started with: a session can't move to another. */
function harnessLocked() {
  return conv?.kind === "work" && conv.messages.length > 0;
}

/**
 * An agent's settings as the panel shows them: its session's own, or,
 * before a session exists, the last ones it reported, with the user's
 * choice in them. A pick the session hasn't taken yet shows at once, as
 * one made while the agent answers does until the turn ends
 * (AgentService.pickModel).
 */
function settingsOf(harness) {
  const live = conv?.harness === harness && conv.configOptions;
  const picked = live && conv.pickedModel;
  const options = (live ? conv.configOptions : AgentService.options.get(harness)) ?? [];
  const value = (option, wanted) => (optionValues(option).includes(wanted) ? wanted : option.currentValue);
  const model = options.find(o => o.id === MODEL_OPTION) ?? null;
  const effort = options.find(o => EFFORT_OPTIONS.includes(o.id)) ?? null;
  // Claude Code's "default" shows as the model it runs as (concreteModel).
  const modelValue =
    model && concreteModel(model, picked ? value(model, picked) : live ? model.currentValue : value(model, AgentService.preferredValue(harness, model.id)));
  // Each model keeps its own effort (AgentService.effortFor).
  const effortValue = effort && (live && !picked ? effort.currentValue : value(effort, AgentService.effortFor(harness, effort.id, modelValue)));
  return { model, modelValue, effort, effortValue };
}

/** The name an option gives one of its values. */
function nameOf(option, value) {
  const choice = modelChoices(option).find(o => o.value === value);
  return choice?.name || choice?.value || value || "";
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
 * The composer's label: the chat's model and its effort ("Opus 5.5 · Low"),
 * or the agent's name until it reports its models. It opens the model
 * picker, which redraws with it.
 */
function renderOptions() {
  if (!conv) {
    return;
  }
  const current = settingsOf(conv.harness);
  const agent = harnesses.find(h => h.id === conv.harness)?.name ?? conv.harness;
  const model = current.model ? nameOf(current.model, current.modelValue) : "";
  const effort = current.effort ? nameOf(current.effort, current.effortValue) : "";
  els.pickModel.textContent = model || agent;
  els.pickEffort.textContent = effort;
  els.pickEffort.hidden = els.pickDot.hidden = !effort;
  els.pick.title = `${agent}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""}${harnessLocked() ? " (this task's agent)" : ""}`;
  els.pick.hidden = !harnesses.length;
  if (!els.picker.hidden) {
    renderPicker();
  }
}

// --- The model picker ---------------------------------------------------------
// The user's pick (2026-11-21): a search; a segmented bar of model families,
// one per agent that may run here (Claude: Claude Code's models, GPT:
// Codex's), gone while only one can; the open family's newest generation,
// each model with its own effort and a ✓ on the chat's; and the efforts in a
// flyout beside the row. The search field keeps the focus and drives both
// lists (aria-activedescendant): ↑ ↓ move, → opens the efforts and ← closes
// them, Enter picks, Esc closes, and typing filters.

const picking = { family: null, active: null, flyFor: null, flyActive: null, hover: null };

/** The bar's families: every agent that may run here, and the chat's own.
 * Claude first, then GPT, as the user picked them; other agents after, in
 * config.json's order. */
function families() {
  const rank = f => ["Claude", "GPT"].indexOf(f.name) >>> 0;
  const list = harnesses
    .filter(h => h.id === conv?.harness || availability(h.id).ok)
    .map(h => ({ harness: h.id, agent: h.name, name: AgentService.familyOf(h.id) }))
    .sort((a, b) => rank(a) - rank(b));
  // Two agents of one family go by their own names.
  for (const f of list) {
    if (list.filter(g => g.name === f.name).length > 1) {
      f.name = f.agent;
    }
  }
  return list;
}

/** A family's rows: its newest models, each with the effort it runs with. */
function rowsOf(harness) {
  const { model, modelValue, effort, effortValue } = settingsOf(harness);
  const mine = harness === conv.harness;
  // Every model but Claude Code's "default" (the user's call), of the
  // newest generation.
  const choices = newestModels(modelChoices(model).filter(c => c.value !== "default"), mine ? modelValue : null);
  if (!choices.length) {
    // An agent that hasn't reported its models yet: its name starts it.
    return [{ value: "", name: harnesses.find(h => h.id === harness)?.name ?? harness, effort: "", current: mine }];
  }
  return choices.map(c => {
    let value = "";
    if (effort) {
      value = mine && conv.configOptions && c.value === modelValue ? effortValue : AgentService.effortFor(harness, effort.id, c.value);
      if (!optionValues(effort).includes(value)) {
        value = effort.currentValue;
      }
    }
    return {
      value: c.value,
      name: c.name || c.value,
      effort: value,
      effortName: effort ? nameOf(effort, value) : "",
      current: mine && c.value === modelValue,
      versioned: modelGeneration(c) !== null,
    };
  });
}

function renderPicker() {
  const list = families();
  const locked = harnessLocked();
  // Another family's model starts a new chat (setHarness), which would take
  // the answer the agent is writing with it: while the agent answers, its
  // tab waits, and the picker shows the chat's own family.
  const own = locked || !!conv.busy;
  if (!list.some(f => f.harness === picking.family) || (own && picking.family !== conv.harness)) {
    picking.family = list.some(f => f.harness === conv.harness) ? conv.harness : list[0]?.harness ?? conv.harness;
  }
  els.pickFam.hidden = list.length < 2;
  els.pickFam.replaceChildren(
    ...list.map(f => {
      const tab = document.createElement("button");
      tab.setAttribute("role", "tab");
      tab.dataset.harness = f.harness;
      tab.textContent = f.name;
      tab.title = f.agent;
      const on = f.harness === picking.family;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (locked && f.harness !== conv.harness) {
        tab.disabled = true;
        tab.title = `${f.agent}: a task keeps the agent it started with`;
      } else if (conv.busy && f.harness !== conv.harness) {
        tab.disabled = true;
        tab.title = `${f.agent}: once this answer ends, picking one of its models starts a new chat`;
      } else if (f.harness !== conv.harness && conv.messages.length) {
        tab.title = `${f.agent}: picking one of its models starts a new chat`;
      }
      return tab;
    })
  );
  // A session can't move to another agent, so in a chat with messages
  // another family's model starts the chat over (setHarness). The rows say
  // so, with no question to answer (t10x's call: the user dislikes
  // interruptions).
  const anew = !locked && picking.family !== conv.harness && conv.messages.length > 0;
  els.pickNote.hidden = !anew;
  els.pickNote.textContent = anew ? "Picking a model here starts a new chat" : "";
  // The search field keeps the focus and points at the rows
  // (aria-activedescendant), so a screen reader hears the note from it.
  for (const el of [els.pickList, els.pickSearch]) {
    if (anew) {
      el.setAttribute("aria-describedby", "pick-note");
    } else {
      el.removeAttribute("aria-describedby");
    }
  }
  const words = els.pickSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = rowsOf(picking.family).filter(r => words.every(w => r.name.toLowerCase().includes(w)));
  // Models without a version first, then a rule.
  const ordered = [...rows.filter(r => !r.versioned), ...rows.filter(r => r.versioned)];
  const items = [];
  ordered.forEach((row, i) => {
    if (i > 0 && row.versioned && !ordered[i - 1].versioned) {
      items.push(Object.assign(document.createElement("div"), { className: "pick-rule" }));
    }
    const el = document.createElement("div");
    el.className = "pick-row";
    el.id = `pick-option-${i}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(row.current));
    el.dataset.value = row.value;
    el.dataset.effort = row.effort;
    const end = span("end");
    if (row.current) {
      end.append(span("pick-check"));
    }
    if (row.value && row.effort) {
      end.append(span("more", "›"));
    }
    el.append(span("name", row.name));
    if (row.effortName) {
      el.append(span("eff", row.effortName));
    }
    el.append(end);
    items.push(el);
  });
  if (!ordered.length) {
    items.push(Object.assign(document.createElement("div"), { className: "pick-none", textContent: "No models match" }));
  }
  els.pickList.replaceChildren(...items);
  const values = ordered.map(r => r.value);
  if (!values.includes(picking.active)) {
    picking.active = ordered.find(r => r.current)?.value ?? values[0] ?? null;
  }
  if (picking.flyFor !== null && !values.includes(picking.flyFor)) {
    closeFly();
  }
  showActive();
  if (picking.flyFor !== null) {
    openFly(rowEl(picking.flyFor), { keep: true });
  }
}

const rowEl = value => (value === null ? null : els.pickList.querySelector(`.pick-row[data-value="${CSS.escape(value)}"]`));

/** Mark the active row, or the flyout's active effort, for the keys and for
 * assistive technology. */
function showActive({ scroll = true } = {}) {
  for (const el of els.pickList.querySelectorAll(".pick-row.active")) {
    el.classList.remove("active");
  }
  const row = rowEl(picking.active);
  row?.classList.add("active");
  if (scroll) {
    row?.scrollIntoView({ block: "nearest" });
  }
  let id = row?.id ?? "";
  if (!els.pickFly.hidden) {
    for (const el of els.pickFly.children) {
      el.classList.toggle("active", el.dataset.value === picking.flyActive);
    }
    id = els.pickFly.querySelector(".pick-eff.active")?.id ?? id;
  }
  if (id) {
    els.pickSearch.setAttribute("aria-activedescendant", id);
  } else {
    els.pickSearch.removeAttribute("aria-activedescendant");
  }
}

function placePicker() {
  const box = els.box.getBoundingClientRect();
  const fly = 124;
  const width = Math.min(window.innerWidth - 16, Math.max(208, Math.min(300, window.innerWidth - 16 - fly)));
  els.picker.style.width = `${width}px`;
  els.picker.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 8 - width))}px`;
  els.picker.style.bottom = `${window.innerHeight - box.top + 6}px`;
  els.picker.style.maxHeight = `${Math.max(160, Math.min(480, box.top - 14))}px`;
}

function openPicker() {
  if (!conv) {
    return;
  }
  closeMenu();
  picking.family = conv.harness;
  picking.active = null;
  els.pickSearch.value = "";
  els.picker.hidden = false;
  els.pick.setAttribute("aria-expanded", "true");
  placePicker();
  renderPicker();
  els.pickSearch.focus();
}

function closePicker({ focus = true } = {}) {
  if (els.picker.hidden) {
    return;
  }
  closeFly();
  clearTimeout(picking.hover);
  els.picker.hidden = true;
  els.pick.setAttribute("aria-expanded", "false");
  if (focus) {
    els.input.focus();
  }
}

/** The efforts the agent offers, for one row, beside it. */
function openFly(row, { keep = false } = {}) {
  const option = row?.dataset.value ? AgentService.effortOption(picking.family, conv) : null;
  if (!option) {
    closeFly();
    return;
  }
  const own = row.dataset.effort;
  if (!keep || picking.flyFor !== row.dataset.value) {
    picking.flyActive = own;
  }
  picking.flyFor = row.dataset.value;
  els.pickFly.replaceChildren(
    ...modelChoices(option).map((o, i) => {
      const el = document.createElement("div");
      el.className = "pick-eff";
      el.id = `pick-effort-${i}`;
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(o.value === own));
      el.dataset.value = o.value;
      el.append(span("name", o.name || o.value));
      if (o.value === own) {
        el.append(span("pick-check"));
      }
      return el;
    })
  );
  els.pickFly.setAttribute("aria-label", `Effort for ${row.querySelector(".name")?.textContent ?? ""}`);
  els.pickFly.hidden = false;
  const r = row.getBoundingClientRect();
  const p = els.picker.getBoundingClientRect();
  const w = els.pickFly.offsetWidth;
  const h = els.pickFly.offsetHeight;
  // Beside the list; over its edge where the sidebar has no room.
  const left = Math.max(4, Math.min(p.right + 4, window.innerWidth - 4 - w));
  const top = Math.max(4, Math.min(r.top - 5, window.innerHeight - 4 - h));
  els.pickFly.style.left = `${left}px`;
  els.pickFly.style.top = `${top}px`;
  showActive({ scroll: false });
}

function closeFly() {
  if (els.pickFly.hidden && picking.flyFor === null) {
    return;
  }
  els.pickFly.hidden = true;
  picking.flyFor = null;
  picking.flyActive = null;
  showActive({ scroll: false });
}

/** Pick a model of the open family, with an effort or with its own. Another
 * family's starts its agent: a session can't move. While the agent answers,
 * the pick is the next answer's (AgentService.pickModel). */
async function pickModel(value, effort = null) {
  const harness = picking.family;
  closePicker();
  if (!conv) {
    return;
  }
  if (harness !== conv.harness) {
    if (harnessLocked() || conv.busy) {
      renderOptions();
      return;
    }
    AgentService.setHarness(conv, harness);
  }
  if (value) {
    await AgentService.pickModel(conv, value, effort);
  }
}

function selectFamily(harness, { focusTab = false } = {}) {
  if (harness === picking.family) {
    return;
  }
  picking.family = harness;
  picking.active = null;
  closeFly();
  renderPicker();
  if (focusTab) {
    els.pickFam.querySelector(`[data-harness="${CSS.escape(harness)}"]`)?.focus();
  }
}

/** Move through the rows, or through the efforts while the flyout is open. */
function step(by) {
  if (!els.pickFly.hidden) {
    const values = [...els.pickFly.children].map(el => el.dataset.value);
    const i = values.indexOf(picking.flyActive);
    picking.flyActive = values[Math.max(0, Math.min(values.length - 1, i + by))] ?? null;
    showActive({ scroll: false });
    return;
  }
  const values = [...els.pickList.querySelectorAll(".pick-row")].map(el => el.dataset.value);
  const i = values.indexOf(picking.active);
  picking.active = values[Math.max(0, Math.min(values.length - 1, i < 0 ? 0 : i + by))] ?? null;
  showActive();
}

els.pick.addEventListener("click", () => (els.picker.hidden ? openPicker() : closePicker()));
els.pickSearch.addEventListener("input", () => {
  closeFly();
  picking.active = null;
  renderPicker();
});
els.pickSearch.addEventListener("keydown", event => {
  if (event.isComposing) {
    return;
  }
  const fly = !els.pickFly.hidden;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    step(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "ArrowRight" && !fly && els.pickSearch.selectionStart === els.pickSearch.value.length) {
    const row = rowEl(picking.active);
    if (row?.querySelector(".more")) {
      event.preventDefault();
      openFly(row);
    }
  } else if (event.key === "ArrowLeft" && fly) {
    event.preventDefault();
    closeFly();
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (fly) {
      pickModel(picking.flyFor, picking.flyActive);
    } else if (rowEl(picking.active)) {
      pickModel(picking.active);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (fly) {
      closeFly();
    } else {
      closePicker();
    }
  }
});
els.pickFam.addEventListener("click", event => {
  const tab = event.target.closest?.("button[role='tab']");
  if (tab && !tab.disabled) {
    selectFamily(tab.dataset.harness);
    els.pickSearch.focus();
  }
});
els.pickFam.addEventListener("keydown", event => {
  const tabs = [...els.pickFam.querySelectorAll("button:not(:disabled)")];
  const i = tabs.indexOf(document.activeElement);
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const next = tabs[(i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    if (next) {
      selectFamily(next.dataset.harness, { focusTab: true });
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.pickSearch.focus();
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Typing anywhere in the picker filters.
    event.preventDefault();
    els.pickSearch.focus();
    els.pickSearch.setRangeText(event.key, els.pickSearch.value.length, els.pickSearch.value.length, "end");
    els.pickSearch.dispatchEvent(new Event("input"));
  }
});
// The pointer: a row it rests on opens its efforts; a click picks.
els.pickList.addEventListener("mousedown", event => event.preventDefault());
els.pickFly.addEventListener("mousedown", event => event.preventDefault());
els.pickList.addEventListener("pointermove", event => {
  const row = event.target.closest?.(".pick-row");
  if (!row) {
    return;
  }
  if (picking.active !== row.dataset.value) {
    picking.active = row.dataset.value;
    showActive({ scroll: false });
  }
  if (picking.flyFor !== row.dataset.value) {
    clearTimeout(picking.hover);
    picking.hover = setTimeout(() => {
      if (!els.picker.hidden && picking.active === row.dataset.value) {
        openFly(row);
      }
    }, 160);
  }
});
els.pickList.addEventListener("click", event => {
  const row = event.target.closest?.(".pick-row");
  if (row) {
    pickModel(row.dataset.value);
  }
});
els.pickFly.addEventListener("pointermove", event => {
  clearTimeout(picking.hover);
  const option = event.target.closest?.(".pick-eff");
  if (option && picking.flyActive !== option.dataset.value) {
    picking.flyActive = option.dataset.value;
    showActive({ scroll: false });
  }
});
els.pickFly.addEventListener("click", event => {
  const option = event.target.closest?.(".pick-eff");
  if (option) {
    pickModel(picking.flyFor, option.dataset.value);
  }
});
els.pickList.addEventListener("scroll", () => closeFly());
window.addEventListener("resize", () => closePicker({ focus: false }));

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
  document.documentElement.dataset.external = String(!!conv?.external);
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
  // A remote task that ended says why under its last answer (zen-observe's
  // stop reasons).
  const ended = work && !conv.busy ? remoteEnd(conv) : null;
  els.remoteEnd.hidden = !ended;
  els.remoteEnd.textContent = ended ?? "";
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
    if (!els.picker.hidden && !event.target.closest?.("#picker, #pick-fly, #pick")) {
      closePicker({ focus: false });
    }
  },
  true
);

// --- The ⋯ menu -------------------------------------------------------------------

function renderMenu() {
  const work = conv?.kind === "work";
  els.newChat.hidden = work;
  // An external task leaves the list once it ended; the runtime's feed keeps it.
  els.removeTask.hidden = !work || !AgentService.isListed(conv) || (!!conv.external && conv.task.state !== "done");
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

/** What the idle box says, longest first (hintsFor). */
function placeholders() {
  const available = conv ? availability(conv.harness) : { ok: true };
  if (!available.ok) {
    return [available.reason, "This agent isn't available"].filter(Boolean);
  }
  if (conv?.kind === "work") {
    return [conv.messages.length ? PLACEHOLDERS.reply : PLACEHOLDERS.task];
  }
  return [PLACEHOLDERS.chat];
}

/**
 * What the empty box says, longest first: it shows the first that fits its
 * two lines (fitHint). At Zen's narrowest sidebar a busy chat's
 * "<status> · Enter queues, ⌘Enter steers" takes three, so there it says
 * only what Enter and Steer do.
 */
function hintsFor(busy) {
  if (!busy) {
    return waitingFor && waitingFor === conv ? ["Reading the files…"] : placeholders();
  }
  const ask = openAsk();
  if (ask) {
    return ask.questions.some(q => takesWords(ask, q))
      ? ["Answer in your own words, or pick above…", "Type an answer, or pick above…"]
      : ["Answer the agent's question above, or Skip", "Answer above, or Skip"];
  }
  if (openPermission()) {
    return ["Reply to decline, and say what to do instead…", "Reply to decline…"];
  }
  const keys = `Enter queues, ${STEER_KEY} steers`;
  return thinkingRow() ? [keys] : [`${conv.status || "Working…"} · ${keys}`, keys];
}

/** The empty box's words, longest first (hintsFor). */
let hints = [];

function setHints(texts) {
  if (texts.length === hints.length && texts.every((text, i) => text === hints[i])) {
    return;
  }
  hints = texts;
  fitHint();
}

/**
 * The box shows the first hint that fits its two lines, else the last.
 * Gecko counts an empty box's placeholder in scrollHeight, so one that
 * doesn't fit reads as a scrollHeight past clientHeight. Words in the box
 * hide the placeholder: it fits again once they go (autoGrow), and when the
 * box's width changes.
 */
function fitHint() {
  const input = els.input;
  for (const [i, text] of hints.entries()) {
    input.placeholder = text;
    if (input.value || i === hints.length - 1 || input.scrollHeight <= input.clientHeight + 1) {
      return;
    }
  }
}

/** The agent's open permission request, which a message sent now declines
 * (AgentService.steer): the user wrote back instead of choosing. */
function openPermission(target = conv) {
  return target?.busy ? target.messages.findLast(m => m.role === "permission" && m.answer === null) : null;
}

/** While the agent works, the empty question box says what it is doing and
 * what Enter and Steer do, and Send turns into Stop. */
function renderStatus() {
  // For every chat, since it hides the bar too: called only for a task
  // another agent drives, it left "Finished · now" on the next chat shown
  // (the user's bug in 5ca03b1).
  renderExternalBar();
  if (conv?.external) {
    // Read-only: no question box, no Send, Steer or Stop of the chat's.
    els.send.hidden = true;
    els.stop.hidden = true;
    els.steer.hidden = true;
    els.empty.hidden = true;
    document.body.classList.remove("busy");
    return;
  }
  const busy = !!conv?.busy;
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  setHints(hintsFor(busy));
  document.body.classList.toggle("busy", busy);
  els.empty.hidden = !!conv?.messages.length;
  updateSend();
}

/**
 * Whether the chat ends in a thought row that's still live (fillThought): it
 * already says the agent is thinking, so the busy box leaves its status out
 * (the relay's polish). A later wait has no row, and the box says it.
 */
function thinkingRow() {
  const last = conv?.messages.findLast(m => !m.hidden);
  return last?.role === "thought" && (last.ms === null || last.ms === undefined);
}

/** Send is dimmed while there is nothing to send. While the agent works,
 * Steer shows beside Stop once there is: Enter queues the message, and Steer
 * sends it into the running turn. With a permission open, Enter sends it at
 * once as well (openPermission), so Steer would only repeat it. */
function updateSend() {
  const draft = conv?.draft;
  const empty = !els.input.value.trim() && !draft?.selection && !draft?.attachments?.length;
  els.send.disabled = empty;
  els.steer.hidden = empty || !conv?.busy || !!conv.external || !!openPermission() || !!openAsk();
  els.steer.title = `Send it now, into the agent's turn (${STEER_KEY}). Enter queues it for when the turn ends.`;
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
  pruneList();
  renderExternal();
  renderBinding();
  renderOptions();
  renderChip();
  renderAttachments();
  renderQueue();
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
    renderExternal();
  } else if (change.type === "steps") {
    renderExternal();
  } else if (change.type === "queue") {
    renderQueue();
  } else if (change.type === "draft") {
    // Stop, or a failed turn, put the queued messages back in the box.
    loadDraft();
  } else {
    scheduleRender();
  }
}

// --- Composer ---------------------------------------------------------------

/** The box grows with what the user types. Empty, it keeps its two lines
 * (rows, min-height), and its hint fits them (fitHint): Gecko counts an
 * empty box's placeholder in scrollHeight, so a busy chat's that wrapped
 * past two lines at Zen's narrowest sidebar sized the box, and the next
 * chat's too, since show() grows the box before that chat's placeholder
 * goes in (zen-eval's look run on 4f97629). */
function autoGrow() {
  els.input.style.height = "auto";
  if (els.input.value) {
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  } else {
    fitHint();
  }
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
  if (!conv || conv.external || !files.length) {
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

/** The box's message for `target` once its files are read, and the box
 * emptied; null when there is nothing to send, or another tab is shown by
 * then (the files stay with this one). Files that Stop put back in the box
 * (AgentService's queue) are read already and have no state. */
async function composed(target) {
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
      return null;
    }
    renderStatus();
  }
  const selection = target.draft?.selection ?? "";
  const attachments = items
    .filter(item => (item.state ?? "ready") === "ready")
    .map(({ state, error, ready, ...attachment }) => attachment);
  const question = els.input.value.trim() || (selection || attachments.length ? glue.defaultQuestion() : "");
  if (!question) {
    return null;
  }
  els.input.value = "";
  autoGrow();
  target.draft = null;
  renderChip();
  renderAttachments();
  return { question, selection, attachments };
}

/** Send the box's message. While the agent works, Enter queues it for when
 * the turn ends, and Steer (or Cmd+Enter) sends it into the running turn;
 * with a permission open, it goes at once and declines the request. Whether
 * the agent works is decided once the files are read. */
async function submit({ steer = false } = {}) {
  if (!conv || conv.external || waitingFor === conv) {
    return;
  }
  const target = conv;
  const ask = openAsk(target);
  if (ask) {
    // The agent waits on its question: the box's words answer it. What
    // else the box holds (the selection, files) stays for the next message.
    const words = els.input.value.trim();
    if (words && askWords(ask, words)) {
      els.input.value = "";
      autoGrow();
      saveDraft();
      updateSend();
    }
    return;
  }
  const message = await composed(target);
  if (!message) {
    return;
  }
  if (!target.busy) {
    await glue.submit(target, message);
  } else if (steer || openPermission(target)) {
    await glue.steer(target, message);
  } else {
    glue.enqueue(target, message);
  }
}

/** The box shows the conversation's draft again: Stop, or a failed turn, put
 * the queued messages back in it (AgentService.cancel). */
function loadDraft() {
  els.input.value = conv?.draft?.text ?? "";
  autoGrow();
  renderChip();
  renderAttachments();
  updateSend();
}

/** The messages waiting for the agent's turn to end, oldest first, each on
 * one line with its files' count, Steer (send it now) and ✕. */
function renderQueue() {
  const items = conv && !conv.external ? (conv.queue ?? []) : [];
  els.queue.hidden = !items.length;
  els.queueList.replaceChildren(
    ...items.map(item => {
      const row = document.createElement("li");
      row.append(div("text", item.question));
      const files = item.files?.length ?? item.attachments?.length ?? 0;
      if (files) {
        row.append(div("count", files === 1 ? "1 file" : `${files} files`));
      }
      const steer = document.createElement("button");
      steer.className = "pill";
      steer.textContent = "Steer";
      steer.title = "Send it now, into the agent's turn";
      steer.addEventListener("click", () => {
        const target = conv;
        AgentService.dequeue(target, item.id);
        glue.steer(target, item);
      });
      const remove = document.createElement("button");
      remove.className = "icon";
      remove.textContent = "✕";
      remove.title = "Don't send it";
      remove.setAttribute("aria-label", "Don't send it");
      remove.addEventListener("click", () => AgentService.dequeue(conv, item.id));
      row.append(steer, remove);
      return row;
    })
  );
}

// The box's width follows the sidebar's: its words take their lines again,
// and its hint fits again. A frame later, since growing the box in the
// observer's own callback is a resize loop the observer reports.
let inputWidth = -1;
new ResizeObserver(() => {
  if (els.input.clientWidth !== inputWidth) {
    inputWidth = els.input.clientWidth;
    requestAnimationFrame(autoGrow);
  }
}).observe(els.input);

/** Typing a question starts the agent and the session if they were stopped
 * (after sitting unused) or closed, so they are ready by the time it is sent. */
function warmUp() {
  if (conv && !conv.busy && (!conv.sessionId || !conv.conn || conv.conn.exited)) {
    AgentService.prewarm(conv);
  }
}

els.input.addEventListener("input", () => {
  autoGrow();
  // The draft stays current, so that Stop's putting the queue back in the
  // box (AgentService.cancel) keeps what is typed.
  saveDraft();
  updateSend();
  warmUp();
});
els.input.addEventListener("focus", warmUp);
els.input.addEventListener("keydown", event => {
  // A key the user's IME takes (a Chinese or Japanese composition's Enter or
  // Escape) only commits or cancels the composition, whichever way the
  // platform's keydown reads.
  if (event.isComposing) {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit({ steer: steerKey(event) });
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (glue.directoryOpen) {
      glue.closeDirectory();
    } else {
      glue.focusPage();
    }
  }
});
els.send.addEventListener("click", () => submit());
els.steer.addEventListener("click", () => submit({ steer: true }));
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


// --- A remote task's arrival ---------------------------------------------------

let arrivalActions = null;
let arrivalTimer = null;

/** The arrival card: `text`, with Watch and Stop, for `ms`. It takes no focus. */
function showArrival(text, actions, ms) {
  fillSource(els.arrivalText, text);
  els.arrival.setAttribute("aria-label", text);
  els.arrival.hidden = false;
  arrivalActions = actions;
  armArrival(ms);
}

/** Go after `ms`, but not from under the pointer or the keyboard's focus. */
function armArrival(ms) {
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => (els.arrival.matches(":hover, :focus-within") ? armArrival(ms) : hideArrival()), ms);
}

function hideArrival() {
  clearTimeout(arrivalTimer);
  arrivalTimer = null;
  arrivalActions = null;
  els.arrival.hidden = true;
}

for (const [button, name] of [
  [els.arrivalWatch, "watch"],
  [els.arrivalStop, "stop"],
]) {
  button.addEventListener("click", () => {
    const actions = arrivalActions;
    hideArrival();
    actions?.[name]?.();
  });
}
els.arrivalClose.addEventListener("click", hideArrival);

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
  // The same round Send as the question box's.
  const send = document.createElement("button");
  send.className = "send round";
  send.title = "Send (Enter)";
  send.setAttribute("aria-label", "Send");
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
    // As in the question box: the IME's own keys only compose.
    if (event.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
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
  // The edit is the user's own words, even of a question another of their
  // agents sent (a remote task's): it doesn't keep that source.
  glue.submit(conv, { question, selection: message.selection, attachments, replace: message, source: message.source === "remote" ? null : message.source });
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
    text = turnParts(message)
      .map(m => m.text.trim())
      .join("\n\n");
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
// The task whose page the card's picture is of; null: the card is blank. The
// card keeps a picture only for its own task: drawPicture paints a page only
// while the agent has it, so a finished task's card would keep the last
// task's picture, another task's page.
let livePictureOf = null;

/**
 * A blank card, until a picture of the shown task's page comes. While the
 * agent isn't on the page, none comes, so the card shows only its foot
 * (data-pictured, panel.css).
 */
function clearLive() {
  const canvas = els.liveShot;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  livePictureOf = null;
  els.live.dataset.pictured = "false";
}

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
  if (livePictureOf !== conv.uid) {
    clearLive();
  }
  const host = hostOf(tab);
  const watching = glue.watching === conv.uid;
  els.live.dataset.live = String(live);
  els.live.dataset.watching = String(watching);
  // A remote task's card says which of the user's agents sent it.
  const from = remoteSource(conv);
  els.liveSrc.hidden = !from;
  fillSource(els.liveSrc, from ?? "");
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
 * while the user holds the task, the card keeps its last picture of that task
 * (livePictureOf), or stays blank.
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
  const of = conv?.uid ?? null;
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
    if (tab !== liveTab || (conv?.uid ?? null) !== of) {
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
    livePictureOf = of;
    els.live.dataset.pictured = "true";
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

els.extStop.addEventListener("click", () => {
  if (conv?.external) {
    AgentService.stopExternal(conv);
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
    closePicker({ focus: false });
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
  /** A remote task just started (the glue's arrival): its card, with Watch and Stop, for `ms`. */
  arrive(text, actions, ms) {
    showArrival(text, actions, ms);
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
