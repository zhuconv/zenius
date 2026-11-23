// Notices in an agent tab: the takeover prompt, "You're in control", the
// agent's handoff and permission messages. One design: a compact floating
// pill with a status dot, a short title, muted detail (which can count down)
// and up to two buttons.
//
// The pill is drawn in chrome, in a layer inside the tab's .browserStack
// like the agent cursor. So the page can't see it, content screenshots
// don't include it, and it shows only while its tab is on screen: a notice
// can wait in a hidden agent tab without ever appearing over the user's
// Space (I1). Showing one never moves focus.
//
// Keyboard and screen readers: a pill is a group named by its text, which a
// screen reader reads as the user Tabs to its buttons (Tab from the page,
// Shift+Tab from the address bar). It isn't a live region: zenius announces
// the moments that need the user itself (ZeniusUI's #announce). A pill that
// goes while it holds the user's focus hands it back to where it came from.
//
// Firefox's notification bar isn't used: its buttons ignore the first click
// after the window gains focus (notificationbox.js restarts its click-jacking
// delay on every window focus), so a user coming back from another window
// had to click "Hand back" (now "Resume agent") twice.

import { ensureStyles } from "chrome://userscripts/content/zenius/ui/styles.sys.mjs";
import { isTabVisible } from "chrome://userscripts/content/zenius/ui/visibility.sys.mjs";
import { isOneIsolate } from "chrome://userscripts/content/zenius/ui/text.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * Clicks this soon after a pill appears are ignored: the second click of a
 * double click on "Take over" mustn't land on the "Resume agent" that replaces
 * it. Unlike Firefox's delay, it doesn't restart when the window gains focus.
 */
const ARM_MS = 400;
/**
 * While the user is on one of a pill's buttons, its description (the
 * pill's text) changes at most this often: a screen reader may read each
 * change of the focused button's description, every second of a countdown.
 */
const DESC_FOCUSED_MS = 30_000;

/**
 * @typedef {object} NoticeButton
 * @property {string} label
 * @property {boolean} [primary]  the filled button
 * @property {() => void} onClick  the notice closes after it runs, unless
 *   the button `stays`
 * @property {boolean} [stays]  the notice stays after a click
 * @property {"close"} [icon]  drawn as a ✕, the label its name
 *
 * @typedef {object} NoticeOptions
 * @property {string} title  short, e.g. "Agent paused"
 * @property {string} [detail]  muted text; with `until`, "{s}" becomes the
 *   countdown's whole seconds left, and "{t}" its time left in minutes from
 *   a minute up ("10 min"), else in seconds. Without it the text shows as
 *   it is: a detail holding someone else's words stays inert
 * @property {string} [site]  the site the user is on, after the detail and
 *   never cut (the hold cards: Zen's compact mode may hide the URL bar)
 * @property {number} [until]  epoch ms the countdown runs to
 * @property {"agent"|"user"|"attention"} [tone]  the dot's color
 * @property {string} [note]  a line under the title row, cut off at one
 *   line with a '?' that opens the rest
 * @property {string} [more]  more of the note, behind its '?' at any width
 * @property {NoticeButton[]} [buttons]
 * @property {boolean} [stacked]  the buttons go under the note, not beside
 *   the title: for a long title line. A card with a note and three buttons
 *   always does, since they don't fit beside a title in the pill's width.
 */

/**
 * @typedef {object} Shown
 * @property {Element} el
 * @property {NoticeOptions} opts
 * @property {string} key  renderKey(opts) as last shown
 * @property {number} shownAt
 * @property {number} timer  countdown interval
 * @property {Element|null} [focusFrom]  where the user's focus was before it
 *   came to the pill
 * @property {Element} [desc]  the buttons' description: the pill's text
 * @property {string} [label]  the pill's text now, which `desc` may lag
 *   while the user is on a button
 * @property {number} [descAt]  when `desc` last changed
 * @property {ResizeObserver|null} [noteWatch]  tells whether the note is
 *   cut off (watchNote)
 * @property {ResizeObserver|null} [siteWatch]  picks where the site and the
 *   buttons go (watchSite)
 */

/** @type {WeakMap<Element, Map<string, Shown>>} keyed by tab */
const shown = new WeakMap();
/** For each pill's id, unique across windows: its buttons' description is under it. */
let cardSeq = 0;

/**
 * Show a notice of type `value` in `tab`, or update the one already there
 * in place. Notices survive navigations; remove them with removeNotice.
 *
 * @param {Element} tab
 * @param {string} value  notice type, one per tab (e.g. "zenius-takeover")
 * @param {NoticeOptions} opts
 * @returns {Element|null} the pill
 */
export function showNotice(tab, value, opts) {
  const browser = tab?.linkedBrowser;
  const stack = browser?.parentElement;
  if (!stack || tab.closing) {
    return null;
  }
  let notices = shown.get(tab);
  if (!notices) {
    notices = new Map();
    shown.set(tab, notices);
  }
  const existing = notices.get(value);
  if (existing?.el.isConnected && existing.el.closest(".browserStack") === stack) {
    existing.opts = opts;
    // An update that changes nothing shown leaves the pill be: a refill
    // replaces its buttons, and would lose a press under way (the handed
    // page asks again at each of its frames' loads). The buttons call the
    // latest opts' handlers.
    const key = renderKey(opts);
    if (existing.key !== key) {
      existing.key = key;
      fill(existing, tab, value);
    }
    return existing.el;
  }
  if (existing) {
    drop(existing);
  }
  const win = stack.ownerDocument.defaultView;
  ensureStyles(win);
  const layer = layerFor(stack);
  const el = stack.ownerDocument.createElementNS(XHTML_NS, "div");
  el.className = "zenius-card";
  el.id = `zenius-card-${++cardSeq}`;
  el.setAttribute("role", "group");
  el.dataset.value = value;
  const entry = { el, opts, key: renderKey(opts), shownAt: Date.now(), timer: 0, focusFrom: null };
  el.addEventListener("focusin", event => {
    const from = event.relatedTarget;
    if (from && !el.contains(from)) {
      entry.focusFrom = from;
    }
  });
  el.addEventListener("focusout", event => {
    // Only a move to somewhere else: the window losing focus, or a button
    // replaced under the focus, keeps the way back.
    const to = event.relatedTarget;
    if (to?.isConnected && !el.contains(to)) {
      entry.focusFrom = null;
    }
    // The description catches up once the user has left the buttons.
    if (!el.contains(to) && entry.desc && entry.desc.textContent !== entry.label) {
      entry.desc.textContent = entry.label;
      entry.descAt = Date.now();
    }
  });
  notices.set(value, entry);
  fill(entry, tab, value);
  layer.append(el);
  return el;
}

/**
 * @param {Element} tab
 * @param {string} value
 * @param {{refocus?: boolean}} [options]  refocus: false leaves the focus
 *   alone, for a pill that moves to another window's copy of its tab
 */
export function removeNotice(tab, value, { refocus = true } = {}) {
  const notices = shown.get(tab);
  const entry = notices?.get(value);
  if (!entry) {
    return;
  }
  notices.delete(value);
  const hadFocus = entry.el.contains(entry.el.ownerDocument.activeElement);
  drop(entry);
  if (hadFocus && refocus) {
    returnFocus(tab, entry.focusFrom);
  }
}

/**
 * Show `from`'s notice `value` on `to` instead, as it is: window sync moved
 * the tab's page to its copy `to` in another window. Its buttons must not
 * act on `from` itself. The focus stays where it is, and the pill arms
 * again there, as a new one would.
 *
 * @param {Element} from
 * @param {Element} to
 * @param {string} value
 * @returns {boolean} whether there was one to move
 */
export function moveNotice(from, to, value) {
  const entry = from === to ? null : shown.get(from)?.get(value);
  if (!entry) {
    return false;
  }
  removeNotice(from, value, { refocus: false });
  return !!showNotice(to, value, entry.opts);
}

/**
 * The user's focus was on a pill that went: they pressed one of its buttons,
 * or it was answered elsewhere or timed out under them. Hand the focus back
 * to where it came from (the page, the address bar), else to the page of the
 * tab, if it's still on screen, rather than leave it on nothing. Only a
 * focus the user put on the pill moves.
 *
 * @param {Element} tab
 * @param {Element|null} from
 */
function returnFocus(tab, from) {
  if (from?.isConnected && from.ownerDocument === tab.ownerDocument) {
    from.focus();
    return;
  }
  if (tab.isConnected && !tab.closing && isTabVisible(tab)) {
    tab.linkedBrowser.focus();
  }
}

/**
 * The notice's text as shown, or null: its title and its detail, which the
 * card sets apart, then the site as the card writes it ("Agent paused ·
 * resumes in 8 s", "Agent needs you · <task> on <site>").
 *
 * @param {Element} tab
 * @param {string} value
 */
export function noticeText(tab, value) {
  const entry = shown.get(tab)?.get(value);
  if (!entry?.el.isConnected) {
    return null;
  }
  const text = [entry.opts.title, detailText(entry.opts)].filter(Boolean).join(" · ");
  return entry.opts.site ? `${text} on ${entry.opts.site}` : text;
}

/**
 * The pill element, for tests and screenshots.
 *
 * @param {Element} tab
 * @param {string} value
 */
export function noticeElement(tab, value) {
  const el = shown.get(tab)?.get(value)?.el;
  return el?.isConnected ? el : null;
}

/** @param {Element} stack */
function layerFor(stack) {
  let layer = stack.querySelector(":scope > .zenius-card-layer");
  if (!layer) {
    layer = stack.ownerDocument.createElementNS(XHTML_NS, "div");
    layer.className = "zenius-card-layer";
    stack.append(layer);
  }
  return layer;
}

/**
 * Render `entry.opts` into its pill, reusing the pill so an update (a new
 * countdown, the typed state) doesn't replay the entrance.
 *
 * @param {Shown} entry
 * @param {Element} tab
 * @param {string} value
 */
function fill(entry, tab, value) {
  const { el, opts } = entry;
  const doc = el.ownerDocument;
  el.setAttribute("tone", opts.tone ?? "agent");
  const parts = [];
  const dot = doc.createElementNS(XHTML_NS, "span");
  dot.className = "zenius-card-dot";
  const title = doc.createElementNS(XHTML_NS, "span");
  title.className = "zenius-card-title";
  title.textContent = opts.title;
  parts.push(dot, title);
  const detail = doc.createElementNS(XHTML_NS, "span");
  detail.className = "zenius-card-detail";
  detail.textContent = detailText(opts);
  // One text alone (a state text, a host) takes its own direction, so a
  // clipped right-to-left one keeps its start. A line with zenius's words in
  // it ("<name>, closes when you leave this tab") stays left to right.
  if (isOneIsolate(detail.textContent)) {
    detail.dir = "auto";
  }
  parts.push(detail);
  // The site the user is on: after the detail, which gives way first.
  if (opts.site) {
    const site = doc.createElementNS(XHTML_NS, "span");
    site.className = "zenius-card-site";
    site.textContent = opts.site;
    parts.push(site);
  }
  el.toggleAttribute("has-site", !!opts.site);
  // The user's layout (2026-11-20): one line of small text under the title
  // row, cut off with a '?' that opens the rest. `more` waits behind the
  // '?' at any width.
  let note = null;
  if (opts.note) {
    const row = doc.createElementNS(XHTML_NS, "span");
    row.className = "zenius-card-noterow";
    note = doc.createElementNS(XHTML_NS, "span");
    note.className = "zenius-card-note";
    note.append(opts.note);
    if (opts.more) {
      const more = doc.createElementNS(XHTML_NS, "span");
      more.className = "zenius-card-note-more";
      more.textContent = opts.more;
      note.append(" ", more);
    }
    row.append(note, moreIcon(el));
    parts.push(row);
    el.setAttribute("has-note", "true");
  } else {
    el.removeAttribute("has-note");
  }
  el.toggleAttribute("has-more", !!opts.note && !!opts.more);
  const buttons = opts.buttons ?? [];
  if (buttons.length) {
    const box = doc.createElementNS(XHTML_NS, "span");
    box.className = "zenius-card-buttons";
    for (const [i, b] of buttons.entries()) {
      const button = doc.createElementNS(XHTML_NS, "button");
      button.className = "zenius-card-button";
      if (b.icon === "close") {
        // A ✕, drawn: its label stays its name, for a screen reader and
        // Voice Control, out of sight.
        const label = doc.createElementNS(XHTML_NS, "span");
        label.className = "zenius-card-button-label";
        label.textContent = b.label;
        button.setAttribute("icon", "close");
        button.append(closeIcon(doc), label);
      } else {
        button.textContent = b.label;
      }
      // VoiceOver reads a focused button's own name, not its group's (the
      // user's check, 2026-11-20). So the pill's text, countdown included,
      // is each button's description, which VoiceOver reads after the
      // button. The button keeps its short name, for Voice Control.
      button.setAttribute("aria-describedby", `${el.id}-desc`);
      if (b.primary) {
        button.setAttribute("primary", "true");
      }
      button.addEventListener("click", event => {
        if (Date.now() - entry.shownAt < ARM_MS) {
          return;
        }
        // The same button in the latest opts, which an unchanged update
        // brought without a refill.
        const now = entry.opts.buttons?.[i] ?? b;
        try {
          // The click itself, for an action only the user's own click may
          // take (Add to allowlist).
          now.onClick(event);
        } catch (e) {
          console.error("[zenius] notice button failed", e);
        }
        if (!now.stays && shown.get(tab)?.get(value) === entry) {
          removeNotice(tab, value);
        }
      });
      box.append(button);
    }
    parts.push(box);
  }
  // The description: a hidden copy of the pill's name, which a screen
  // reader reads from it all the same. Its own element, so it can lag the
  // name while the user is on a button (DESC_FOCUSED_MS).
  const desc = doc.createElementNS(XHTML_NS, "span");
  desc.className = "zenius-card-desc";
  desc.id = `${el.id}-desc`;
  desc.hidden = true;
  desc.style.display = "none";
  parts.push(desc);
  el.toggleAttribute("stacked", !!opts.note && buttons.length > 0 && (!!opts.stacked || buttons.length >= 3));
  // An update keeps the user's focus on the button it was on, or on the
  // pill's first one.
  const focused = el.contains(doc.activeElement) ? doc.activeElement.textContent : null;
  el.replaceChildren(...parts);
  if (focused !== null) {
    const again = [...el.querySelectorAll("button")];
    (again.find(b => b.textContent === focused) ?? again[0])?.focus();
    if (!again.length) {
      returnFocus(tab, entry.focusFrom);
    }
  }
  entry.label = labelFor(opts, detail.textContent);
  el.setAttribute("aria-label", entry.label);
  desc.textContent = entry.label;
  entry.desc = desc;
  entry.descAt = Date.now();
  watchNote(entry, note);
  watchSite(entry);

  lazy.clearInterval(entry.timer);
  entry.timer = 0;
  if (opts.until && /\{[st]\}/.test(opts.detail ?? "")) {
    entry.timer = lazy.setInterval(() => {
      if (!el.isConnected) {
        lazy.clearInterval(entry.timer);
        return;
      }
      const next = detailText(opts);
      if (next !== detail.textContent) {
        detail.textContent = next;
        // A screen reader names the pill by what it shows now, not the
        // countdown it started with.
        entry.label = labelFor(opts, next);
        el.setAttribute("aria-label", entry.label);
        // Its buttons' description follows, but not every second under the
        // user's focus.
        const now = Date.now();
        if (!el.contains(doc.activeElement) || now - entry.descAt >= DESC_FOCUSED_MS) {
          desc.textContent = entry.label;
          entry.descAt = now;
        }
      }
    }, 250);
  }
}

/** A ✕ for a close button, centred in its 14 px box. */
function closeIcon(doc) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const cross = doc.createElementNS(SVG_NS, "path");
  cross.setAttribute("d", "M3.5 3.5l7 7M10.5 3.5l-7 7");
  cross.setAttribute("class", "zenius-card-close-mark");
  svg.append(cross);
  return svg;
}

/**
 * The '?' at the end of a note cut off at its line: a click opens the
 * rest, and another closes it. An icon drawn centred in its 14 px circle:
 * a text glyph sat off-centre at that size (the user's check, 2026-11-20).
 *
 * It's for the pointer alone, so it's hidden from a screen reader and out
 * of the tab order: a screen reader reads the whole note in the pill's
 * name and in each button's description, and the note opens whenever the
 * keyboard's focus is in the pill (CSS :has(:focus-visible); a mouse press
 * on a button focuses it too, and a pill that reflowed under the pointer
 * would lose the click). The main button stays the first stop.
 *
 * @param {Element} el  the pill
 */
function moreIcon(el) {
  const doc = el.ownerDocument;
  const more = doc.createElementNS(XHTML_NS, "span");
  more.className = "zenius-card-more";
  more.setAttribute("aria-hidden", "true");
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  // A question mark whose ink box is centred on (7, 7): the hook's bowl
  // (r 1.75 about 7, 5.22) and its 1.5 stroke reach up to y 2.72, the dot
  // down to 11.25, and x runs 4.5 to 9.5.
  const hook = doc.createElementNS(SVG_NS, "path");
  hook.setAttribute("d", "M5.25 5.25a1.75 1.75 0 1 1 2.6 1.5c-.55.3-.85.7-.85 1.3");
  hook.setAttribute("class", "zenius-card-more-hook");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "7");
  dot.setAttribute("cy", "10.4");
  dot.setAttribute("r", ".85");
  dot.setAttribute("class", "zenius-card-more-dot");
  svg.append(hook, dot);
  more.append(svg);
  more.addEventListener("click", () => el.toggleAttribute("note-open"));
  return more;
}

/**
 * Whether the note is cut off at its one line, which shows the '?'
 * (note-cut). Measured as the pill lays out and whenever the note's box
 * changes size (a narrower window, a new text). An open note, or one the
 * focus opened, keeps the last answer, so its '?' stays to close it.
 *
 * @param {Shown} entry
 * @param {Element|null} note
 */
function watchNote(entry, note) {
  entry.noteWatch?.disconnect();
  entry.noteWatch = null;
  const { el } = entry;
  if (!note) {
    el.removeAttribute("note-cut");
    el.removeAttribute("note-open");
    return;
  }
  const measure = () => {
    if (!note.isConnected || el.hasAttribute("note-open") || el.matches(":has(:focus-visible)")) {
      return;
    }
    el.toggleAttribute("note-cut", note.scrollWidth > note.clientWidth + 1);
  };
  const win = el.ownerDocument.defaultView;
  if (win?.ResizeObserver) {
    entry.noteWatch = new win.ResizeObserver(measure);
    entry.noteWatch.observe(note);
  }
  measure();
}

/** The buttons' margin and gap, and the pill's widest, as zenius-ux.css sets them. */
const BUTTONS_MARGIN = 6;
const BUTTONS_GAP = 4;
const CARD_MAX = 560;

/**
 * Whether the title row holds the site whole: the user always sees where
 * they are. When the buttons can't sit beside the title and the site (a
 * long registrable domain, a narrow page), they go under the note, or
 * under the title row with no note (site-stacked). When even the title
 * and the site can't share a row, the site takes a row of its own under
 * it, and wraps there (site-alone). Measured from the parts' own one-line
 * widths and the gaps every layout has, so the answer doesn't change with
 * the layout it picks, and can't flip back and forth.
 *
 * @param {Shown} entry
 */
function watchSite(entry) {
  entry.siteWatch?.disconnect();
  entry.siteWatch = null;
  const { el } = entry;
  const site = el.querySelector(":scope > .zenius-card-site");
  // Read the site's width on one line again, for its new text.
  el.removeAttribute("site-alone");
  if (!site) {
    el.removeAttribute("site-stacked");
    return;
  }
  const box = el.querySelector(":scope > .zenius-card-buttons");
  const win = el.ownerDocument.defaultView;
  let layer = null;
  let oneLine = 0;
  const px = value => parseFloat(value) || 0;
  // Layout widths: the pill's entrance moves it, never scales it.
  const width = node => node?.getBoundingClientRect().width ?? 0;
  const measure = () => {
    if (!site.isConnected) {
      return;
    }
    // The room is the layer's, which a wider page gives back.
    if (!layer && el.parentElement) {
      layer = el.parentElement;
      entry.siteWatch?.observe(layer);
    }
    if (!el.hasAttribute("site-alone")) {
      oneLine = site.scrollWidth;
    }
    const cs = win.getComputedStyle(el);
    const gap = px(cs.columnGap) || 8;
    // The dot, the title and the task's name: two gaps. The site follows the
    // name after a word's space of its own (" on ", zenius-ux.css).
    const row =
      px(cs.paddingInlineStart) +
      px(cs.paddingInlineEnd) +
      px(cs.borderInlineStartWidth) +
      px(cs.borderInlineEndWidth) +
      width(el.querySelector(":scope > .zenius-card-dot")) +
      (el.querySelector(":scope > .zenius-card-title")?.scrollWidth ?? 0) +
      oneLine +
      2 * gap;
    const buttons = box
      ? gap + BUTTONS_MARGIN + [...box.children].reduce((sum, b) => sum + width(b), 0) + BUTTONS_GAP * Math.max(0, box.children.length - 1)
      : 0;
    const ls = layer ? win.getComputedStyle(layer) : null;
    const room = Math.min(CARD_MAX, layer ? layer.clientWidth - px(ls.paddingInlineStart) - px(ls.paddingInlineEnd) : CARD_MAX);
    el.toggleAttribute("site-stacked", !!box && row + buttons > room + 0.5);
    el.toggleAttribute("site-alone", row > room + 0.5);
  };
  if (win?.ResizeObserver) {
    entry.siteWatch = new win.ResizeObserver(measure);
    entry.siteWatch.observe(el);
  }
  measure();
}

/**
 * The pill's name for a screen reader: its title, detail and note, as one
 * line.
 *
 * @param {NoticeOptions} opts
 * @param {string} detail  as the pill shows it now
 */
function labelFor(opts, detail) {
  const label = `${detail ? `${opts.title}, ${detail}` : opts.title}${opts.site ? `, on ${opts.site}` : ""}`;
  return opts.note ? `${label}. ${[opts.note, opts.more].filter(Boolean).join(" ")}` : label;
}

/**
 * Everything of `opts` a pill shows, to tell an update that changes it.
 *
 * @param {NoticeOptions} opts
 */
function renderKey(opts) {
  return JSON.stringify([
    opts.tone ?? "agent",
    opts.title,
    opts.detail ?? "",
    opts.site ?? "",
    opts.until ?? 0,
    opts.note ?? "",
    (opts.buttons ?? []).map(b => [b.label, !!b.primary, !!b.stays, b.icon ?? ""]),
    opts.more ?? "",
    !!opts.stacked,
  ]);
}

/** @param {NoticeOptions} opts */
function detailText(opts) {
  const detail = opts.detail ?? "";
  if (typeof opts.until !== "number" || !/\{[st]\}/.test(detail)) {
    return detail;
  }
  const s = Math.max(0, Math.ceil(((opts.until ?? Date.now()) - Date.now()) / 1000));
  const t = s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
  return detail.replaceAll("{s}", String(s)).replaceAll("{t}", t);
}

/** @param {Shown} entry */
function drop(entry) {
  lazy.clearInterval(entry.timer);
  entry.noteWatch?.disconnect();
  entry.noteWatch = null;
  entry.siteWatch?.disconnect();
  entry.siteWatch = null;
  const layer = entry.el.parentElement;
  entry.el.remove();
  if (layer && !layer.children.length) {
    layer.remove();
  }
}
