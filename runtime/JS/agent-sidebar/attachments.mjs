/* Agent Sidebar: files the user attaches in the panel (the 📎 button, a drop
 * or a paste), read into what the agents take:
 *  - images, scaled down to at most 1568 px on the long side (Claude scales
 *    larger ones down to that anyway, and it is plenty for Codex);
 *  - PDFs, as their text, read with Firefox's own pdf.js. Sending the PDF
 *    itself would cost Claude about twice the tokens (it also reads every page
 *    as an image), and Codex cannot read one at all;
 *  - any other file that is UTF-8 text, as its text.
 * Text is cut at the same limit as page text. Anything else (Office
 * documents, archives, scanned PDFs without text) is refused with a reason.
 * Nothing here runs until a file is attached, and pdf.js loads on the first
 * PDF. */

const PDFJS = "resource://pdf.js/build/pdf.mjs";
const PDFJS_WORKER = "resource://pdf.js/build/pdf.worker.mjs";
const PDFJS_WEB = "resource://pdf.js/web/";
const PDF_BATCH = 8; // pages read at once
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_EDGE = 1568;
// Image size limit: Claude takes 5 MB per image, so stay under that once
// base64 has grown the data by a third.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
// Formats both agents read as they are; others are converted to PNG.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const THUMB_EDGE = 96;
const TYPES_BY_EXTENSION = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** A reason the file cannot be attached, shown on its chip. */
export class Refused extends Error {}

function extension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What the file is: "image", "pdf" or "text" (text is checked when read). */
export function kindOf(file) {
  const type = file.type || TYPES_BY_EXTENSION[extension(file.name)] || "";
  if (type === "application/pdf") {
    return "pdf";
  }
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    return "image";
  }
  return "text";
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function size(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function chars(n) {
  return n < 1000 ? plural(n, "char") : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k chars`;
}

/**
 * Read one File. Returns { kind, name, uri, info, thumb?, mimeType, data? }
 * for an image (data is base64) and { kind, name, uri, info, text, truncated,
 * pages?, pagesRead? } for a PDF or a text file. Throws an Error whose message
 * says why the file cannot be attached.
 */
export async function readAttachment(file, { maxChars }) {
  const name = file.name || "file";
  if (file.size > MAX_FILE_BYTES) {
    throw new Refused(`too big (${size(file.size)}; the limit is 50 MB)`);
  }
  // The file's path when it has one (picked, dropped, or copied in Finder),
  // so the agent knows which file it is.
  let path = "";
  try {
    path = file.mozFullPath || "";
  } catch {}
  const uri = path ? PathUtils.toFileURI(path) : `attachment:${encodeURIComponent(name)}`;
  const base = { name, uri };
  switch (kindOf(file)) {
    case "image":
      return { ...base, ...(await readImage(file)) };
    case "pdf":
      return { ...base, ...(await readPdf(file, maxChars)) };
    default:
      return { ...base, ...(await readText(file, maxChars)) };
  }
}

// --- Images --------------------------------------------------------------------

/**
 * The image in a paste (a screenshot, or "Copy Image"), as a File. The
 * browser's own documents get pasted images as image data rather than as
 * files. A big image is scaled while it is encoded, so a 5K screenshot is
 * never encoded at full size. Returns null when the paste holds no image.
 */
export function imageFromClipboard(data) {
  const type = [...data.types].find(t => t.startsWith("image/"));
  if (!type) {
    return null;
  }
  let value = data.mozGetDataAt(type, 0);
  let mimeType = type;
  if (value instanceof Ci.imgIContainer) {
    const tools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    const scale = Math.min(1, MAX_EDGE / Math.max(value.width, value.height));
    value = tools.encodeScaledImage(value, "image/png", Math.round(value.width * scale), Math.round(value.height * scale));
    mimeType = "image/png";
  }
  if (!(value instanceof Ci.nsIInputStream)) {
    return null;
  }
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const bytes = NetUtil.readInputStream(value, value.available());
  return new File([bytes], `pasted.${mimeType.split("/")[1]}`, { type: mimeType });
}

async function encode(bitmap, width, height, type, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (type === "image/jpeg") {
    context.fillStyle = "#fff"; // JPEG has no transparency
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type, quality });
}

async function base64(blob) {
  return new Uint8Array(await blob.arrayBuffer()).toBase64();
}

async function readImage(file) {
  const type = file.type || TYPES_BY_EXTENSION[extension(file.name)];
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Refused("not an image Firefox can open");
  }
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let blob = file;
    let mimeType = type;
    if (scale < 1 || !IMAGE_TYPES.has(type) || file.size > MAX_IMAGE_BYTES) {
      mimeType = type === "image/jpeg" ? "image/jpeg" : "image/png";
      blob = await encode(bitmap, w, h, mimeType, 0.9);
      if (blob.size > MAX_IMAGE_BYTES) {
        mimeType = "image/jpeg";
        blob = await encode(bitmap, w, h, mimeType, 0.85);
      }
    }
    const t = Math.min(1, THUMB_EDGE / Math.max(width, height));
    const thumb = await encode(bitmap, Math.max(1, Math.round(width * t)), Math.max(1, Math.round(height * t)), "image/png");
    return {
      kind: "image",
      mimeType,
      data: await base64(blob),
      thumb: `data:image/png;base64,${await base64(thumb)}`,
      info: `${w}×${h}`,
    };
  } finally {
    bitmap.close();
  }
}

// --- PDFs --------------------------------------------------------------------------

let pdfjs = null;

async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = import(PDFJS).then(module => {
      module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return module;
    });
    pdfjs.catch(() => (pdfjs = null));
  }
  return pdfjs;
}

/** A page's text: its text items in order, with line ends where pdf.js found them. */
async function pageText(pdf, number) {
  const page = await pdf.getPage(number);
  try {
    const content = await page.getTextContent();
    return content.items.map(item => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
  } finally {
    page.cleanup();
  }
}

async function readPdf(file, maxChars) {
  let module;
  try {
    module = await loadPdfJs();
  } catch (e) {
    console.error("[agent-sidebar] pdf.js did not load:", e);
    throw new Refused("Firefox's PDF reader did not load");
  }
  const task = module.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${PDFJS_WEB}cmaps/`,
    standardFontDataUrl: `${PDFJS_WEB}standard_fonts/`,
    isEvalSupported: false,
    disableFontFace: true,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    throw new Refused(e?.name === "PasswordException" ? "the PDF has a password" : "not a PDF Firefox can read");
  }
  try {
    const pages = pdf.numPages;
    const parts = [];
    let length = 0;
    let pagesRead = 0;
    let truncated = false;
    let found = false;
    for (let first = 1; first <= pages && !truncated; first += PDF_BATCH) {
      const batch = [];
      for (let n = first; n < first + PDF_BATCH && n <= pages; n++) {
        batch.push(pageText(pdf, n));
      }
      for (const [i, text] of (await Promise.all(batch)).entries()) {
        found ||= !!text.trim();
        const part = `[page ${first + i}]\n${text}`;
        pagesRead = first + i;
        if (length + part.length > maxChars) {
          parts.push(part.slice(0, Math.max(0, maxChars - length)));
          truncated = true;
          break;
        }
        parts.push(part);
        length += part.length + 2;
      }
    }
    if (!found) {
      throw new Refused("no text in this PDF (a scan?); paste a screenshot of the page instead");
    }
    return {
      kind: "pdf",
      text: parts.join("\n\n"),
      pages,
      pagesRead,
      truncated,
      info: truncated ? `${plural(pages, "page")}, first ${pagesRead} read` : plural(pages, "page"),
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// --- Text files ------------------------------------------------------------------

async function readText(file, maxChars) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {}
  if (text === null || text.includes("\u0000")) {
    const ext = extension(file.name);
    throw new Refused(`${ext ? `.${ext} files` : "this kind of file"} can't be read; attach images, PDFs or text files`);
  }
  if (!text.trim()) {
    throw new Refused("the file is empty");
  }
  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars);
  }
  return {
    kind: "text",
    text,
    truncated,
    info: truncated ? `${chars(text.length)}, truncated` : chars(text.length),
  };
}
