// Content entry points for page.snapshot (methods/snapshot.sys.mjs calls them
// through ctx.content). Each document is walked in its own sandbox
// (walker.js). This side walks the frames that live in this process after
// their parents and splices them in, leaves placeholders for out-of-process
// ones (design §4.4), and counts locator candidates across this process's
// documents (§6). No document's walk ever holds another document's text: a
// page that reached its sandbox would find only its own.

import { load, precompile, sandboxFor, uaLocalId } from "chrome://userscripts/content/zenius/content/snapshot/sandbox.sys.mjs";
import { forgetRoots, generatedBoxes, rootGenerates } from "chrome://userscripts/content/zenius/content/snapshot/generated.sys.mjs";
import { isWebDocument } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";

/**
 * The capture running in this process. Walks are synchronous, so frames met
 * on the way register here: `frames` out of process (the parent fills them
 * in), `local` in this process (walked here once their parent is done).
 *
 * @type {{args: object, docs: Array<object>, frames: Array<{bcId: number, clip: object|null}>,
 *   local: Array<{win: Window, clip: object|null, text: string}>}|null}
 */
let active = null;

/**
 * Every open shadow root in a document, nested ones too, without a sweep
 * over its elements (0.8 ms for MDN's 282 roots, against 39 ms). Ego's
 * locator resolver searches exactly these.
 */
function openShadowRoots(doc) {
  return doc.getConnectedShadowRoots().filter(root => root.mode === "open" && !root.isUAWidget());
}

// Chromium's names for date and time fields, which Ego prints whatever the
// UI language. Gecko's datetimebox.ftl has the same English strings, but
// Fluent sets them as aria-label only later (not yet in a frame that just
// loaded), so the walker names fields by their Fluent id.
const DATETIME_FIELD_NAMES = {
  "datetime-year": "Year",
  "datetime-month": "Month",
  "datetime-day": "Day",
  "datetime-hour": "Hours",
  "datetime-minute": "Minutes",
  "datetime-second": "Seconds",
  "datetime-millisecond": "Milliseconds",
  "datetime-dayperiod": "AM/PM",
};

/**
 * A date or time input's datetimebox, a UA widget the walker doesn't enter:
 * its fields and the separators between them, in the locale's order. Null
 * without a widget (not set up yet, or a type Gecko doesn't implement, like
 * month and week).
 */
function dateTimeItems(entry, el) {
  const root = el.openOrClosedShadowRoot;
  if (!root?.isUAWidget()) {
    return null;
  }
  const items = [];
  const walk = node => {
    for (const kid of node.childNodes) {
      if (kid.nodeType === kid.TEXT_NODE) {
        if (kid.data.trim()) items.push({ text: kid.data });
      } else if (kid.nodeType === kid.ELEMENT_NODE && !kid.hidden && kid.localName !== "button") {
        if (kid.classList.contains("datetime-edit-field")) {
          const label = DATETIME_FIELD_NAMES[kid.getAttribute("data-l10n-id")] ?? kid.getAttribute("aria-label") ?? "";
          items.push({ field: uaLocalId(entry, kid), role: "spinbutton", label, text: kid.textContent });
        } else {
          walk(kid);
        }
      }
    }
  };
  walk(root);
  return items.some(item => item.field) ? items : null;
}

// Chromium's names for its media controls (Ego prints `button "play"`,
// `spinbutton "volume"`, `button "unmute"`, `button "enter full screen"` on
// GitHub's README video). Gecko's controls carry the Fluent id of their
// current state, set at once; the aria-label follows when Fluent runs.
const MEDIA_CONTROL_NAMES = {
  "videocontrols-play-button": "play",
  "videocontrols-pause-button": "pause",
  "videocontrols-mute-button": "mute",
  "videocontrols-unmute-button": "unmute",
  "videocontrols-enterfullscreen-button": "enter full screen",
  "videocontrols-exitfullscreen-button": "exit full screen",
  "videocontrols-volume-control": "volume",
};

// Gecko's control bar in Chromium's order: the button panel (play, the
// times, volume, mute, captions, full screen), then the timeline. Chromium's
// overflow menu ("show more media controls") has no Gecko counterpart, nor
// Gecko's big play button over the video a second "play" in Chromium.
const MEDIA_CONTROLS = ["playButton", "positionDurationBox", "volumeControl", "muteButton", "closedCaptionButton", "fullscreenButton", "scrubber"];

/**
 * The control bar of a media element with controls (Gecko's videocontrols UA
 * widget): its buttons and sliders and the time it shows. Null when there is
 * no control bar laid out. A bar that faded out (playing, or the media
 * failed) still counts: Chromium's tree keeps its transparent panel too.
 */
function mediaControlItems(entry, el) {
  const root = el.openOrClosedShadowRoot;
  const bar = root?.isUAWidget() ? root.getElementById("controlBar") : null;
  if (!bar?.checkVisibility()) {
    return null;
  }
  const items = [];
  for (const id of MEDIA_CONTROLS) {
    const control = root.getElementById(id);
    if (!control || control.hidden || !control.checkVisibility()) {
      continue;
    }
    if (id === "positionDurationBox") {
      // The Fluent arguments, set with the l10n id (the text comes later).
      let args = null;
      try {
        args = JSON.parse(control.getAttribute("data-l10n-args"));
      } catch {}
      if (args?.position) items.push({ text: args.position });
      if (args?.duration) items.push({ text: `/ ${args.duration}` });
      continue;
    }
    let label;
    if (id === "scrubber") {
      label = `${el.localName} time scrubber`;
    } else if (id === "closedCaptionButton") {
      label = root.getElementById("textTrackListContainer")?.hidden === false ? "hide closed captions menu" : "show closed captions menu";
    } else {
      label = MEDIA_CONTROL_NAMES[control.getAttribute("data-l10n-id")] ?? control.getAttribute("aria-label") ?? "";
    }
    items.push({ field: uaLocalId(entry, control), role: control.localName === "input" ? "spinbutton" : "button", label });
  }
  return items.some(item => item.field) ? items : null;
}

/**
 * The document's walker and the chrome helpers it gets with each capture.
 * The helpers live in the sandbox's compartment but never on its global.
 */
function walkerFor(win) {
  const entry = sandboxFor(win);
  if (!entry.helpers) {
    const helpers = Cu.createObjectIn(entry.sandbox);
    // Closed shadow roots are part of what the user sees (§1.2); UA widgets'
    // roots (form controls, media) are not, the walker prints those itself.
    Cu.exportFunction(
      el => {
        const root = el.openOrClosedShadowRoot;
        return root && !root.isUAWidget() ? root : null;
      },
      helpers,
      { defineAs: "closedShadowRoot" }
    );
    Cu.exportFunction(frameContent, helpers, { defineAs: "frame" });
    // An element's ::before and ::after as Gecko lays them out, as a JSON
    // string: the sandbox can't see the boxes (native anonymous content).
    Cu.exportFunction((el, wantRect) => generatedBoxes(el, wantRect === true), helpers, { defineAs: "generated" });
    // Whether a shadow root's own sheets may give its ::before and ::after
    // text: chrome reads sheets from other origins, the page can't.
    Cu.exportFunction(root => rootGenerates(root), helpers, { defineAs: "rootGenerates" });
    // Controls inside UA widgets (a date input's fields, a media element's
    // control bar) as plain items: {field, role, label, text?} for a control,
    // {text} between them. The sandbox can't hold UA widget nodes, so this
    // side keeps the controls and the items carry local ids (uaLocalId).
    for (const [name, list] of [["dateTimeFields", dateTimeItems], ["mediaControls", mediaControlItems]]) {
      Cu.exportFunction(
        el => {
          const items = list(entry, el);
          return items ? Cu.cloneInto(items, entry.sandbox) : null;
        },
        helpers,
        { defineAs: name }
      );
    }
    Cu.exportFunction(
      doc => Cu.cloneInto(openShadowRoots(doc), entry.sandbox, { wrapReflectors: true }),
      helpers,
      { defineAs: "openShadowRoots" }
    );
    // What hit testing finds in a rect of a document's viewport: `hit`, the
    // elements whose own boxes it finds (Chromium keeps a plain wrapper only
    // when its box is hit in the viewport, §1.2), and with `wantMarks`,
    // `marked`: every hit node with its flattened-tree ancestors (through
    // slots and shadow hosts, closed and UA ones too), so the walker can
    // skip an offscreen subtree with none of these in it (§3.2). Null when
    // hit testing isn't available.
    Cu.exportFunction(
      (doc, clipJSON, wantMarks) => {
        const { l, t, r, b } = JSON.parse(clipJSON);
        let nodes;
        try {
          nodes = doc.defaultView.windowUtils.nodesFromRect(l, t, 0, r - l, b - t, 0, false, true, false);
        } catch {
          return null;
        }
        const hit = [];
        const marked = new Set();
        for (const node of nodes) {
          if (node.nodeType === 1) hit.push(node);
          if (wantMarks) {
            for (let n = node; n && !marked.has(n); n = n.flattenedTreeParentNode) marked.add(n);
          }
        }
        return Cu.cloneInto({ hit, marked: wantMarks ? [...marked] : null }, entry.sandbox, { wrapReflectors: true });
      },
      helpers,
      { defineAs: "onScreen" }
    );
    entry.helpers = helpers;
  }
  return { entry, walker: load(entry, "walker").__zsWalker };
}

/**
 * Walks one document into the active capture; returns its lines. Walks
 * don't nest (frames wait for their parent), so the document's index is
 * the next one.
 */
function walkDocument(win, options) {
  const { entry, walker } = walkerFor(win);
  const docIndex = active.docs.length;
  forgetRoots();
  const result = walker.capture(win.document, JSON.stringify({ ...options, docIndex }), entry.helpers);
  const meta = JSON.parse(String(result.meta));
  active.docs.push({ innerWindowId: entry.innerWindowId, bcId: win.browsingContext.id, win, refs: meta.refs ?? [], meta });
  return String(result.text);
}

/**
 * helpers.frame(iframe, optionsJSON): a placeholder for the frame's lines,
 * or "" for none. \u0005i\u0006 is local[i], walked in this process once
 * its parent is done; \u0003f\u0004 is frames[f], out of process.
 */
function frameContent(el, optionsJSON) {
  const bc = el.browsingContext;
  if (!bc || !active) {
    return "";
  }
  const { clip } = JSON.parse(optionsJSON);
  const doc = el.contentDocument;
  // I5 (the observe layer glue): a frame that isn't web content (an error page)
  // prints as an empty frame.
  if (doc && !isWebDocument(doc)) {
    return "";
  }
  if (doc?.defaultView) {
    active.local.push({ win: doc.defaultView, clip, text: "" });
    return `\u0005${active.local.length - 1}\u0006`;
  }
  active.frames.push({ bcId: bc.id, clip });
  return `\u0003${active.frames.length - 1}\u0004`;
}

/** Walks the in-process frames, nested ones too, each after its parent. */
function walkLocalFrames() {
  for (let i = 0; i < active.local.length; i++) {
    const frame = active.local[i];
    try {
      frame.text = walkDocument(frame.win, { ...active.args, rootLocalId: null, topLevel: false, clip: frame.clip });
    } catch (e) {
      // One frame that can't be walked (a page that throws from its own
      // getters) prints empty; the rest of the snapshot stands.
      console.error("zenius snapshot: frame walk failed", e);
    }
  }
}

/** The text with each in-process frame's lines in place of its placeholder, at its indent. */
function spliceLocalFrames(text) {
  if (!active.local.length) {
    return text;
  }
  const out = [];
  const expand = (body, pad) => {
    for (const line of body.split("\n")) {
      const frame = /^( *)\u0005(\d+)\u0006$/.exec(line);
      if (frame) {
        const { text: lines } = active.local[Number(frame[2])];
        if (lines) expand(lines, pad + frame[1]);
        continue;
      }
      out.push(pad + line);
    }
  };
  expand(text, "");
  return out.join("\n");
}

/**
 * Matches of each locator text across these documents (0, 1, or 2 for
 * many, summed). Counting needs only locators.js, not the walker, so a frame
 * the snapshot didn't walk sets up just that.
 */
function countIn(docs, texts) {
  const totals = new Array(texts.length).fill(0);
  if (!texts.length) {
    return totals;
  }
  const json = JSON.stringify(texts);
  for (const { win } of docs) {
    const entry = sandboxFor(win);
    const locators = load(entry, "locators").__zsLocators;
    const doc = win.document;
    const roots = Cu.cloneInto([doc, ...openShadowRoots(doc)], entry.sandbox, { wrapReflectors: true });
    JSON.parse(locators.countTexts(doc, roots, json)).forEach((n, i) => (totals[i] += n));
  }
  return totals;
}

/**
 * Snapshots the actor's document and the frames in this process.
 *
 * @param {object} args {scope, topLevel, topOrigin, locators, rootLocalId?, clip?}
 * @returns {{text, docs, frames, metrics, stats, stale?}}
 *   text: ref placeholders \u0001d:k\u0002 for docs[d].refs[k], and lines
 *   \u0003f\u0004 for frames[f], out-of-process frames the parent fills in.
 *   docs[d].refs[k] = [localId, role, name, locator, url, total] where total
 *   counts the locator's matches in this process when it matched its own node
 *   exactly once in its document, else 0.
 */
export async function capture(actor, args) {
  await precompile();
  const t0 = ChromeUtils.now();
  const previous = active;
  active = { args, docs: [], frames: [], local: [] };
  try {
    const topText = walkDocument(actor.contentWindow, args);
    const top = active.docs[0].meta;
    if (top.stale) {
      return { stale: true };
    }
    walkLocalFrames();
    const text = spliceLocalFrames(topText);
    const t1 = ChromeUtils.now();
    // Locators must be unique across documents. Each walk found its own
    // candidates exactly once, on their own nodes; count each one in the
    // other documents walked here (the parent adds other processes).
    const owners = new Map();
    active.docs.forEach((doc, d) => {
      for (const ref of doc.refs) {
        if (!ref[3] || !ref[5]) continue;
        let set = owners.get(ref[3]);
        if (!set) owners.set(ref[3], (set = new Set()));
        set.add(d);
      }
    });
    const totals = new Map(Array.from(owners, ([text, set]) => [text, set.size]));
    if (active.docs.length > 1) {
      active.docs.forEach((doc, d) => {
        const texts = [];
        for (const [text, set] of owners) {
          if (!set.has(d) && totals.get(text) === 1) texts.push(text);
        }
        countIn([doc], texts).forEach((n, i) => totals.set(texts[i], totals.get(texts[i]) + n));
      });
    }
    const docs = active.docs.map(doc => ({
      innerWindowId: doc.innerWindowId,
      bcId: doc.bcId,
      refs: doc.refs.map(([localId, role, name, loc, url, self]) => [localId, role, name, loc, url, loc && self ? totals.get(loc) : 0]),
    }));
    const stats = { elements: 0, texts: 0, rects: 0, styleReads: 0, pruned: 0, refs: 0, walkMs: 0, locMs: 0, pseudoQueries: 0 };
    for (const doc of active.docs) {
      for (const key of Object.keys(stats)) stats[key] += doc.meta.stats?.[key] ?? 0;
    }
    return {
      text,
      docs,
      frames: active.frames,
      metrics: top.metrics ?? null,
      stats: { ...stats, docs: docs.length, countMs: ChromeUtils.now() - t1, contentMs: ChromeUtils.now() - t0 },
    };
  } finally {
    active = previous;
  }
}

/**
 * Matches of each locator text in the actor's document alone (0, 1, or 2
 * for many). The parent asks every frame that didn't walk the text.
 */
export async function countLocators(actor, { texts }) {
  await precompile();
  return countIn([{ win: actor.contentWindow }], texts);
}

/** What a ref resolves to, as plain data (tests and debugging). */
export async function describeRef(actor, args) {
  const { resolveRef } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/content/snapshot/registry.sys.mjs");
  const el = resolveRef(actor, args);
  return { tag: el.localName, id: el.id, text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) };
}
