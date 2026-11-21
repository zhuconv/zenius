/* Copying and saving what an agent wrote: a whole answer as Markdown, or one
 * code block as a file of its language. A saved file goes where Firefox puts
 * downloads, or where the user picks if Firefox is set to ask, and shows in
 * the downloads panel like any other download.
 *
 * The file is written here rather than downloaded from a data: URL: that
 * takes 5 ms instead of about 100, and a script (.sh, .py) is not held up by
 * the download reputation check.
 *
 * It's written in the step that makes it (IOUtils mode "create", which is
 * exclusive), never into a path that's already there. An agent whose sandbox
 * writes the Downloads folder could plant a link at the name, or swap the
 * file for one between two steps. The answer, which the agent wrote, would
 * then go over whatever the link points to (zen-snapshot's sweep,
 * 2026-11-21). A link at the name only takes that name. */

import { marked } from "./vendor/marked.esm.js";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DownloadLastDir: "resource://gre/modules/DownloadLastDir.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

// A code block's language -> the extension it is saved with (else .txt).
const EXTENSIONS = {
  markdown: "md", md: "md",
  python: "py", py: "py", python3: "py",
  javascript: "js", js: "js", typescript: "ts", ts: "ts", jsx: "jsx", tsx: "tsx",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", html: "html", css: "css",
  latex: "tex", tex: "tex", bibtex: "bib", bib: "bib",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
  c: "c", cpp: "cpp", "c++": "cpp", java: "java", go: "go", rust: "rs", rs: "rs",
  ruby: "rb", swift: "swift", kotlin: "kt", r: "r", julia: "jl", matlab: "m",
  sql: "sql", csv: "csv", diff: "diff",
};

export function extensionFor(language) {
  return EXTENSIONS[(language || "").toLowerCase()] ?? "txt";
}

/** Put text on the clipboard. */
export function copyText(window, text) {
  Cc["@mozilla.org/widget/clipboardhelper;1"]
    .getService(Ci.nsIClipboardHelper)
    .copyString(text, window.browsingContext?.currentWindowContext ?? null);
}

/**
 * A file name: Markdown is named after its first heading; anything else, or
 * Markdown without one, after `fallback` (the page's title).
 */
export function fileName(text, extension, fallback) {
  let base = "";
  if (extension === "md") {
    base = marked.lexer(text).find(token => token.type === "heading")?.text ?? "";
    base = base.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "");
  }
  base = base.trim() || (fallback ?? "").replace(/\.(pdf|html?)$/i, "").trim() || "Answer";
  base = [...base.replace(/\s*:\s*/g, " - ").replace(/[/\\]/g, "-")].slice(0, 80).join("");
  return lazy.DownloadPaths.sanitize(`${base.replace(/[\s.]+$/, "")}.${extension}`);
}

/**
 * Save text as a file named `name`. `source` is the page the answer was
 * about, shown in the downloads panel as where the file came from. Returns
 * the file's path, or null when the user cancels the file dialog.
 */
export async function saveText(window, { name, text, source }) {
  const top = window.browsingContext.topChromeWindow;
  const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(top);
  let saved;
  if (Services.prefs.getBoolPref("browser.download.useDownloadDir", true)) {
    saved = await writeNew(await lazy.Downloads.getPreferredDownloadsDirectory(), name, text);
  } else {
    const file = await askWhere(top, name);
    if (!file) {
      return null;
    }
    saved = await writeReplacing(file.path, text);
  }
  const { path, bytes } = saved;
  try {
    const download = await lazy.Downloads.createDownload({
      source: {
        url: /^https?:/.test(source ?? "") ? source : `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
        isPrivate,
      },
      target: path,
      succeeded: true,
      totalBytes: bytes,
      contentType: mimeTypeOf(name),
      startTime: new Date(),
    });
    await download.refresh();
    const list = await lazy.Downloads.getList(isPrivate ? lazy.Downloads.PRIVATE : lazy.Downloads.PUBLIC);
    await list.add(download);
  } catch (e) {
    console.error("[agent-sidebar] saved, but could not list the file in the downloads panel", e);
  }
  return path;
}

/** Whether a write in mode "create" found something at its path: a file, or a link, even one to nowhere. */
function taken(error) {
  return error?.name === "NoModificationAllowedError";
}

/**
 * Write `text` as a new file in `dir`, named `name`. If that's taken, it's
 * named "name(1).ext" and on, as Firefox names downloads. A link at a name
 * takes the name, and is never written through.
 *
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function writeNew(dir, name, text) {
  const [base, extension] = lazy.DownloadPaths.splitBaseNameAndExtension(name);
  for (let i = 0; i < 10000; i++) {
    const path = PathUtils.join(dir, i ? `${base}(${i})${extension}` : name);
    try {
      return { path, bytes: await IOUtils.writeUTF8(path, text, { mode: "create" }) };
    } catch (e) {
      if (!taken(e)) {
        throw e;
      }
    }
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

/**
 * Write `text` where the user picked in the Save As dialog, which asked them
 * before replacing a file there. What's there goes first: a link goes itself,
 * never what it points to. Then the new file is made. One planted again in
 * between takes the name, and the save fails rather than follow it.
 *
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function writeReplacing(path, text) {
  for (let tries = 0; tries < 3; tries++) {
    await IOUtils.remove(path, { ignoreAbsent: true });
    try {
      return { path, bytes: await IOUtils.writeUTF8(path, text, { mode: "create" }) };
    } catch (e) {
      if (!taken(e)) {
        throw e;
      }
    }
  }
  throw new Error(`Something keeps taking ${path}`);
}

/** The Save As dialog, opened where the last one was. */
async function askWhere(top, name) {
  const lastDir = new lazy.DownloadLastDir(top);
  let dir = await lastDir.getFileAsync(null);
  if (!dir || !(await IOUtils.exists(dir.path))) {
    dir = new lazy.FileUtils.File(await lazy.Downloads.getPreferredDownloadsDirectory());
  }
  let title = "Save As";
  try {
    title = Services.strings
      .createBundle("chrome://global/locale/contentAreaCommands.properties")
      .GetStringFromName("SaveLinkTitle");
  } catch {}
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  picker.init(top.browsingContext, title, Ci.nsIFilePicker.modeSave);
  picker.displayDirectory = dir;
  picker.defaultString = name;
  const extension = name.slice(name.lastIndexOf(".") + 1);
  picker.defaultExtension = extension;
  picker.appendFilter(`*.${extension}`, `*.${extension}`);
  picker.appendFilters(Ci.nsIFilePicker.filterAll);
  const result = await new Promise(resolve => picker.open(resolve));
  if (result === Ci.nsIFilePicker.returnCancel || !picker.file) {
    return null;
  }
  lastDir.setFile(null, picker.file.parent);
  return picker.file;
}

function mimeTypeOf(name) {
  try {
    return Cc["@mozilla.org/mime;1"]
      .getService(Ci.nsIMIMEService)
      .getTypeFromExtension(name.slice(name.lastIndexOf(".") + 1));
  } catch {
    return "text/plain";
  }
}
