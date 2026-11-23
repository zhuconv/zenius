/* Agent Sidebar, content side. agent-sidebar.uc.js asks a tab for:
 *
 *   GetSelection  the text the user selected in this frame (or in a focused
 *                 text field).
 *   GetPageText   the page's text as the user sees it (#visibleText), with
 *                 the text it lays out where the user can't see it marked as
 *                 hidden, and the links the user can see (#links). In
 *                 Firefox's PDF viewer this is the PDF's text, page by page.
 *
 * Nothing here runs until the parent asks.
 */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// PDF pages asked of pdf.js at once: one round trip per batch, not per page.
const PDF_BATCH = 8;
// How long pdf.js gets to open a PDF. The parent stops waiting sooner
// (pageOf); this only ends the wait here.
const PDF_OPEN_MS = 30000;
// The parts of a page that belong to the site rather than to the page: its
// navigation, and the header and footer of the whole page. The header and
// footer of an article or section stay (#isSitePart).
const SITE_PARTS = "nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]";
// Text that is laid out but that the user can't read comes marked as hidden
// (#hidden): a page could hide instructions for the agent in it. It was
// left out until the user's pass on defenses (2026-11-21): trust the agent,
// and let it see what the user can't, marked so. Hidden is text smaller
// than this,
const MIN_FONT_PX = 4;
// squeezed or clipped into a box thinner than this (screen-reader-only
// text's 1 px box, a transform),
const MIN_BOX_PX = 2;
// or this close to the color behind it, as WCAG measures contrast (1: the
// same color; black on white is 21). White on white is 1.
const MIN_CONTRAST = 1.2;
// What can sit between a background and a text and make it readable,
// whatever their colors.
const MEDIA = "img, picture, video, canvas, svg, iframe, embed, object";
// Elements whose content innerText leaves out (form controls, and what is
// never rendered), so the text read child by child leaves it out too.
const NOT_TEXT = new Set(["script", "style", "template", "textarea", "select", "datalist", "option", "optgroup"]);
// Firefox's Canvas color in the dark, behind a page that paints no
// background of its own.
const DARK_CANVAS = { r: 28, g: 27, b: 34, a: 1 };
const LIGHT_CANVAS = { r: 255, g: 255, b: 255, a: 1 };
// The page's links a read returns (#links): at most this many, each URL at
// most this long, each name at most this long.
const MAX_LINKS = 200;
const MAX_LINK_CHARS = 2000;
const MAX_LINK_NAME = 80;

/**
 * Text the user can't see, as the agent reads it: marked, and quoted as a
 * JSON string, so a page can't end the mark inside its own hidden text and
 * pass the rest off as shown.
 */
function hidden(text) {
  return `[hidden: ${JSON.stringify(text)}]`;
}

/** A computed color as {r, g, b, a}, or null for one this can't read. */
function parseColor(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value ?? "");
  if (!m) {
    return value === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  }
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

/** WCAG's contrast ratio of two opaque colors. */
function contrast(x, y) {
  const lum = ({ r, g, b }) => {
    const c = v => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` painted at its alpha over the opaque `bg`. */
function over(fg, bg) {
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** The element `el` is laid out in: its slot when it is slotted, else its
 * parent, or the host when its parent is a shadow root. */
function flatParent(el) {
  return el.openOrClosedAssignedSlot ?? el.parentElement ?? el.parentNode?.host ?? null;
}

function overlap(a, b) {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

export class AgentSidebarChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    switch (name) {
      case "GetSelection":
        return this.#selection();
      case "GetPageText":
        return this.#pageText(data ?? {});
    }
    return null;
  }

  #selection() {
    const win = this.contentWindow;
    if (!win) {
      return { selection: "" };
    }
    const text = win.getSelection()?.toString().trim();
    if (text) {
      return { selection: text };
    }
    // Text selected inside an <input> or <textarea> is not part of the
    // document selection.
    const field = this.document.activeElement;
    try {
      const { selectionStart: start, selectionEnd: end, value } = field ?? {};
      if (typeof value === "string" && end > start) {
        return { selection: value.slice(start, end).trim() };
      }
    } catch {}
    return { selection: "" };
  }

  /**
   * @param {{maxChars?: number, kind?: "html"|"pdf"}} options  kind: what the
   *   parent saw the document as (pageOf)
   */
  async #pageText({ maxChars = 120000, kind = "html" }) {
    const win = this.contentWindow;
    if (!win || !this.document) {
      return null;
    }
    // Firefox's PDF viewer only, on an application/pdf document, which the
    // parent saw as one too. Any page can define a PDFViewerApplication, and
    // the agent then got the page's chosen text as the PDF's.
    if (kind === "pdf" && this.document.contentType === "application/pdf") {
      const viewer = Cu.waiveXrays(win).PDFViewerApplication;
      if (viewer) {
        return this.#pdfText(viewer, maxChars);
      }
    }
    return this.#htmlText(maxChars);
  }

  async #until(fn, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      if (!this.contentWindow) {
        return null;
      }
      let value;
      try {
        value = fn();
      } catch {}
      if (value || Date.now() > end) {
        return value || null;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async #pdfText(viewer, maxChars) {
    const opened = await Promise.race([
      Promise.resolve(viewer.initializedPromise).then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), PDF_OPEN_MS)),
    ]);
    const pdf = opened && (await this.#until(() => viewer.pdfDocument, PDF_OPEN_MS));
    if (!pdf) {
      return null;
    }
    const pages = pdf.numPages;
    let text = "";
    let pagesRead = 0;
    for (let first = 1; first <= pages && text.length < maxChars; first += PDF_BATCH) {
      const numbers = [];
      for (let n = first; n < first + PDF_BATCH && n <= pages; n++) {
        numbers.push(n);
      }
      const batch = await Promise.all(numbers.map(n => this.#pdfPageText(pdf, n)));
      for (const pageText of batch) {
        if (text.length >= maxChars) {
          break;
        }
        pagesRead++;
        text += `\n\n[page ${pagesRead}]\n${pageText}`;
      }
    }
    return {
      kind: "pdf",
      text: text.trim().slice(0, maxChars),
      pages,
      pagesRead,
      truncated: text.length > maxChars || pagesRead < pages,
    };
  }

  async #pdfPageText(pdf, number) {
    // Values that come back through the viewer's promises are wrapped
    // again, which hides pdf.js's own methods; waive each one.
    const page = Cu.waiveXrays(await pdf.getPage(number));
    const content = Cu.waiveXrays(await page.getTextContent());
    let text = "";
    for (const item of content.items) {
      if (typeof item.str === "string") {
        text += item.str + (item.hasEOL ? "\n" : "");
      }
    }
    return text.trim();
  }

  /**
   * The page as it is rendered: the text the user can see, without the
   * site's navigation, header and footer. Reader mode's Readability would
   * keep only what it takes for the article, and drop comments, reviews and
   * replies.
   */
  #htmlText(maxChars) {
    const body = this.document.body;
    // innerText of an element that isn't rendered is all of its text.
    if (!body || !this.#rendered(body)) {
      return null;
    }
    const seen = this.#visibleText(body);
    const parts = [];
    this.#renderedText(body, parts, seen);
    let text = "";
    for (let i = 0; i < parts.length; i++) {
      if (i) {
        text += parts[i - 1].inline && parts[i].inline ? " " : "\n";
      }
      text += parts[i].hidden ? hidden(parts[i].text) : parts[i].text;
    }
    text = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      kind: "html",
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      links: this.#links(seen),
    };
  }

  /**
   * The links the user can see, for Chat's fetch (the user's call): Chat
   * opens only a URL from its sources, the page's links among them. Each is a
   * link with text the user can see (#visibleText), outside the site's
   * navigation, http(s) only, to another page than this one, once, in page
   * order: {url, name}. A link the page hides, or one without text, isn't one
   * the user could follow, so it stays out; its name is only the text the
   * user can see in it, so no hidden text goes unmarked.
   *
   * @param {{shown: Set<Text>, lit: Set<Element>}} seen
   * @returns {Array<{url: string, name: string}>}
   */
  #links(seen) {
    const links = [];
    const here = this.document.URL.replace(/#.*$/s, "");
    const known = new Set();
    for (const a of this.document.links) {
      if (links.length >= MAX_LINKS) {
        break;
      }
      if (!seen.lit.has(a)) {
        continue;
      }
      let url = "";
      try {
        url = new URL(a.href).href;
      } catch {}
      // A link within this page fetches the same document.
      if (!/^https?:\/\//i.test(url) || url.length > MAX_LINK_CHARS || url.replace(/#.*$/s, "") === here || known.has(url)) {
        continue;
      }
      known.add(url);
      links.push({ url, name: this.#shownText(a, seen) });
    }
    return links;
  }

  /** The text the user can see in `el`, on one line, cut to MAX_LINK_NAME. */
  #shownText(el, seen) {
    let text = "";
    const walker = this.document.createTreeWalker(el, this.contentWindow.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && text.length < MAX_LINK_NAME * 4; node = walker.nextNode()) {
      if (seen.shown.has(node)) {
        text += node.data;
      }
    }
    return text.replace(/\s+/g, " ").trim().slice(0, MAX_LINK_NAME);
  }

  /** Whether an element has a box, or lays out its children in its parent's
   * (display: contents). */
  #rendered(el) {
    return el.checkVisibility() || this.contentWindow.getComputedStyle(el).display === "contents";
  }

  /** Whether an element belongs to the site rather than the page. A header or
   * footer inside an article or section is that article's own. */
  #isSitePart(el) {
    if (!el.matches(SITE_PARTS)) {
      return false;
    }
    if ((el.localName === "header" || el.localName === "footer") && !el.hasAttribute("role")) {
      return !el.parentElement?.closest("article, aside, main, nav, section");
    }
    return true;
  }

  /**
   * Which of the page's text the user can see. innerText leaves out what
   * isn't rendered (display: none, visibility: hidden, a closed <details>)
   * but keeps text rendered where nobody can see it: at opacity 0, off the
   * page, clipped to nothing (screen-reader-only text), too small to read,
   * or in the color of what's behind it. The snapshot hides what its
   * viewport clips (walker.js) and this page-wide read leaves those out the
   * same way, plus what no scrolling reaches.
   *
   * @param {Element} root
   * @returns {{shown: Set<Text>, hidden: Set<Text>, mixed: Set<Element>, lit: Set<Element>, siteIn: Set<Element>, site: Set<Element>}}
   *   the text the user can see, and the text laid out where they can't; the
   *   elements around hidden text or a site part, which #renderedText reads
   *   child by child; those around text the user can see, and around a site
   *   part; and the site parts
   */
  #visibleText(root) {
    const win = this.contentWindow;
    const doc = this.document;
    const seen = { shown: new Set(), hidden: new Set(), mixed: new Set(), lit: new Set(), siteIn: new Set(), site: new Set() };
    const up = (set, el) => {
      for (let p = el; p && !set.has(p); p = p === root ? null : p.parentElement) {
        set.add(p);
      }
    };
    const markUp = el => up(seen.mixed, el);
    const styles = new Map();
    const scheme = win.getComputedStyle(doc.documentElement).colorScheme;
    const dark = /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || win.matchMedia("(prefers-color-scheme: dark)").matches);
    const ctx = {
      style: el => {
        let s = styles.get(el);
        if (!s) {
          s = win.getComputedStyle(el);
          styles.set(el, s);
        }
        return s;
      },
      range: doc.createRange(),
      clipped: new Map(),
      media: new Map(),
      // The part of the page scrolling reaches, in page coordinates.
      sx: win.scrollX,
      sy: win.scrollY,
      width: Math.max(doc.documentElement.scrollWidth, root.scrollWidth),
      height: Math.max(doc.documentElement.scrollHeight, root.scrollHeight),
      canvas: dark ? DARK_CANVAS : LIGHT_CANVAS,
    };
    const { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP, SHOW_ELEMENT, SHOW_TEXT } = win.NodeFilter;
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode: node => {
        if (node.nodeType === node.TEXT_NODE) {
          return /\S/.test(node.data) ? FILTER_ACCEPT : FILTER_SKIP;
        }
        if (NOT_TEXT.has(node.localName) || !this.#rendered(node)) {
          return FILTER_REJECT;
        }
        if (this.#isSitePart(node)) {
          seen.site.add(node);
          markUp(node.parentElement);
          up(seen.siteIn, node.parentElement);
          return FILTER_REJECT;
        }
        return FILTER_SKIP;
      },
    });
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const visible = this.#textVisible(text, ctx);
      if (visible) {
        seen.shown.add(text);
        up(seen.lit, text.parentElement);
      } else if (visible === false) {
        seen.hidden.add(text);
        markUp(text.parentElement);
      }
    }
    return seen;
  }

  /**
   * Whether the user can see a text node: true, false when it is rendered
   * where they can't see it, null when it isn't rendered at all (innerText
   * leaves it out too).
   */
  #textVisible(text, ctx) {
    const el = text.parentElement;
    if (!el) {
      return null;
    }
    const style = ctx.style(el);
    if (style.visibility !== "visible" || style.contentVisibility === "hidden") {
      return null;
    }
    ctx.range.selectNodeContents(text);
    if (!ctx.range.getClientRects().length) {
      return null;
    }
    const rect = ctx.range.getBoundingClientRect();
    if (rect.width < MIN_BOX_PX || rect.height < MIN_BOX_PX || parseFloat(style.fontSize) < MIN_FONT_PX) {
      return false;
    }
    let box = el;
    while (box && ctx.style(box).display === "contents") {
      box = flatParent(box);
    }
    if (box && !box.checkVisibility({ opacityProperty: true })) {
      return false;
    }
    // Off the page, where no scrolling reaches (left: -9999px, a text-indent
    // of -9999px).
    const left = rect.left + ctx.sx;
    const top = rect.top + ctx.sy;
    if (left + rect.width <= 0 || top + rect.height <= 0 || left >= ctx.width || top >= ctx.height) {
      return false;
    }
    return !this.#clippedAway(el, ctx) && this.#legible(el, style, rect, ctx);
  }

  /** Whether `el` or a box it is laid out in clips it to nothing. */
  #clippedAway(el, ctx) {
    if (!el) {
      return false;
    }
    let clipped = ctx.clipped.get(el);
    if (clipped === undefined) {
      clipped = this.#clipsToNothing(el, ctx) || this.#clippedAway(flatParent(el), ctx);
      ctx.clipped.set(el, clipped);
    }
    return clipped;
  }

  /** Screen-reader-only text's box (1 px, overflow hidden, clip: rect(0 0 0
   * 0) or clip-path: inset(50%)), or a box collapsed to nothing with its
   * overflow hidden. Content that only overflows a box of some size (a
   * carousel's other slides) stays, as the user can bring it into view. */
  #clipsToNothing(el, ctx) {
    const style = ctx.style(el);
    if (style.display === "contents") {
      return false;
    }
    if (style.clip !== "auto" && (style.position === "absolute" || style.position === "fixed")) {
      const m = /^rect\((-?[\d.]+)px,? (-?[\d.]+)px,? (-?[\d.]+)px,? (-?[\d.]+)px\)$/.exec(style.clip);
      if (m && (m[3] - m[1] < MIN_BOX_PX || m[2] - m[4] < MIN_BOX_PX)) {
        return true;
      }
    }
    if (/^inset\((5\d|[6-9]\d|100)(\.\d+)?%/.test(style.clipPath) || /^(circle|ellipse)\(0(px)?[ )]/.test(style.clipPath)) {
      return true;
    }
    // The root's and the body's overflow is the viewport's, and an inline
    // box clips nothing.
    if (el.localName === "html" || el.localName === "body" || style.display === "inline") {
      return false;
    }
    if (style.overflowX === "visible" && style.overflowY === "visible") {
      return false;
    }
    return el.clientWidth < MIN_BOX_PX || el.clientHeight < MIN_BOX_PX;
  }

  /** Whether a text's ink differs enough from what's behind it: not
   * transparent, and not the color of its background (white on white),
   * unless something between them (a picture, a gradient) could carry it. */
  #legible(el, style, rect, ctx) {
    // Glyphs filled with the background (a gradient heading), outlined or
    // shadowed show whatever their fill.
    if (/\btext\b/.test(style.backgroundClip) || style.textShadow !== "none" || parseFloat(style.webkitTextStrokeWidth) > 0) {
      return true;
    }
    const fill = parseColor(style.webkitTextFillColor || style.color);
    if (!fill) {
      return true;
    }
    if (fill.a < 0.05) {
      return false;
    }
    let behind = null;
    let holder = null;
    for (let p = el; p; p = flatParent(p)) {
      const s = ctx.style(p);
      if (s.backgroundImage !== "none") {
        return true;
      }
      const color = parseColor(s.backgroundColor);
      if (color && color.a >= 0.5) {
        behind = { ...color, a: 1 };
        holder = p;
        break;
      }
    }
    behind ??= ctx.canvas;
    holder ??= this.document.documentElement;
    if (contrast(over(fill, behind), behind) >= MIN_CONTRAST) {
      return true;
    }
    let media = ctx.media.get(holder);
    if (!media) {
      media = [...holder.querySelectorAll(MEDIA)].map(m => m.getBoundingClientRect());
      ctx.media.set(holder, media);
    }
    return media.some(r => overlap(r, rect));
  }

  /** The rendered text of `el` as parts: read whole (innerText) when nothing
   * in it is hidden or belongs to the site, or when all of it is hidden (one
   * hidden part), else child by child. Inline parts are joined by a space,
   * others by a line break. */
  #renderedText(el, parts, seen) {
    const mixed = seen.mixed.has(el);
    if (!mixed || (!seen.lit.has(el) && !seen.siteIn.has(el))) {
      const text = el.innerText?.trim();
      if (text) {
        // Hidden text out of the flow reads in the line it sits in:
        // screen-reader-only text is positioned absolutely, which makes it
        // a block.
        const style = this.contentWindow.getComputedStyle(el);
        const inline = style.display.startsWith("inline") || (mixed && /^(absolute|fixed)$/.test(style.position));
        parts.push({ text, inline, hidden: mixed });
      }
      return;
    }
    for (const child of el.childNodes) {
      if (child.nodeType === child.TEXT_NODE) {
        const hidden = seen.hidden.has(child);
        if (hidden || seen.shown.has(child)) {
          const pre = /^(pre|break-spaces)/.test(this.contentWindow.getComputedStyle(el).whiteSpace);
          const text = pre ? child.data.replace(/^\n+|\s+$/g, "") : child.data.replace(/\s+/g, " ").trim();
          if (text) {
            parts.push({ text, inline: true, hidden });
          }
        }
      } else if (child.nodeType === child.ELEMENT_NODE && !NOT_TEXT.has(child.localName) && !seen.site.has(child) && this.#rendered(child)) {
        this.#renderedText(child, parts, seen);
      }
    }
  }
}
