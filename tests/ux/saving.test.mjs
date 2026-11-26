// Saving an answer (runtime/JS/agent-sidebar/saving.mjs) never writes through
// a link an agent planted. An agent whose sandbox writes the Downloads folder
// could plant one at the name the save uses, or swap the file for one between
// two steps. The answer, which the agent wrote, would then go over whatever
// the link points to: here a "victim" outside the folder. Each save gets a
// link planted at its path just before its bytes are written (the module's
// IOUtils, wrapped), and a Save As replaces a name that's a link.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

const ANSWER = "#!/bin/sh\necho the agent's answer\n";
const VICTIM = "echo the user's own file\n";
let h;
let root;
let downloads;

/** A file of the user's outside the Downloads folder, one for each test. */
function newVictim(name) {
  const path = join(root, name);
  writeFileSync(path, VICTIM);
  return path;
}

/** The saving prefs' own values, as found before the tests, to put back after. */
const SAVING_PREFS = ["browser.download.useDownloadDir", "browser.download.folderList", "browser.download.dir", "browser.download.lastDir"];
let found;

before(async () => {
  h = await setup();
  // A dev profile sets its own downloads folder (zen-dev.sh): it stays after.
  found = await h.chrome(`
    const prefs = Services.prefs;
    return Object.fromEntries(${JSON.stringify(SAVING_PREFS)}.map(name => {
      if (!prefs.prefHasUserValue(name)) return [name, null];
      const type = prefs.getPrefType(name);
      return [name, type === prefs.PREF_BOOL ? prefs.getBoolPref(name) : type === prefs.PREF_INT ? prefs.getIntPref(name) : prefs.getStringPref(name)];
    }));
  `);
  root = mkdtempSync(join(tmpdir(), "zen-ux-saving-"));
  downloads = join(root, "Downloads");
  mkdirSync(downloads);
  mkdirSync(join(root, "staged"));
});

after(async () => {
  await h
    ?.chrome(`
      const found = ${JSON.stringify(found ?? {})};
      for (const pref of ${JSON.stringify(SAVING_PREFS)}) {
        const value = found[pref];
        if (value === undefined || value === null) Services.prefs.clearUserPref(pref);
        else if (typeof value === "boolean") Services.prefs.setBoolPref(pref, value);
        else if (typeof value === "number") Services.prefs.setIntPref(pref, value);
        else Services.prefs.setStringPref(pref, value);
      }
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      const list = await Downloads.getList(Downloads.PUBLIC);
      for (const d of await list.getAll()) {
        if (d.target.path.startsWith(${JSON.stringify(root ?? "/nonexistent")})) await list.remove(d);
      }
      return true;
    `)
    .catch(() => {});
  await h?.close();
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Chrome code that loads saving.mjs and wraps the IOUtils it writes with:
 * the first write under the Downloads folder finds a link to the victim
 * planted at its path just before (a link staged at `staged`, moved there).
 */
const PLANTING = staged => `
  const Saving = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/saving.mjs");
  const io = Cu.getGlobalForObject(Saving).IOUtils;
  const real = { writeUTF8: io.writeUTF8, write: io.write };
  const planted = [];
  const plant = async path => {
    if (!planted.length && path.startsWith(${JSON.stringify(downloads)})) {
      planted.push(PathUtils.filename(path));
      await IOUtils.remove(path, { ignoreAbsent: true });
      await IOUtils.move(${JSON.stringify(staged)}, path);
    }
  };
  io.writeUTF8 = async (path, ...rest) => { await plant(path); return real.writeUTF8(path, ...rest); };
  io.write = async (path, ...rest) => { await plant(path); return real.write(path, ...rest); };
  const unwrap = () => Object.assign(io, real);
`;

const kind = path => {
  try {
    const s = lstatSync(path);
    return s.isSymbolicLink() ? `link to ${readlinkSync(path)}` : s.isFile() ? "file" : "other";
  } catch {
    return "none";
  }
};

test("saving to the Downloads folder: a link planted at the save's name, just before its bytes are written, only takes that name", async () => {
  const victim = newVictim("victim-1.sh");
  const staged = join(root, "staged", "link-1");
  symlinkSync(victim, staged);
  const out = await h.chrome(`${PLANTING(staged)}
    Services.prefs.setBoolPref("browser.download.useDownloadDir", true);
    Services.prefs.setIntPref("browser.download.folderList", 2);
    Services.prefs.setStringPref("browser.download.dir", ${JSON.stringify(downloads)});
    try {
      const first = await Saving.saveText(win, { name: "Answer.sh", text: ${JSON.stringify(ANSWER)}, source: "https://example.com/" });
      unwrap();
      const second = await Saving.saveText(win, { name: "Answer.sh", text: ${JSON.stringify(ANSWER)}, source: "https://example.com/" });
      return { planted, first: PathUtils.filename(first), second: PathUtils.filename(second) };
    } finally {
      unwrap();
    }
  `);
  assert.deepEqual(out.planted, ["Answer.sh"], "the premise: a link was planted at the save's path");
  assert.equal(readFileSync(victim, "utf8"), VICTIM, "the answer never went through the link");
  assert.equal(kind(join(downloads, "Answer.sh")), `link to ${victim}`, "the link keeps its name");
  assert.equal(out.first, "Answer(1).sh", "the save took the next name");
  assert.equal(kind(join(downloads, out.first)), "file");
  assert.equal(readFileSync(join(downloads, out.first), "utf8"), ANSWER);
  assert.equal(out.second, "Answer(2).sh", "names go on as Firefox's do");
  assert.equal(readFileSync(join(downloads, out.second), "utf8"), ANSWER);
});

test("Save As, replacing a name that's a link: the link goes, never what it points to, and the answer is a new file there", async () => {
  const victim = newVictim("victim-2.sh");
  const picked = join(downloads, "picked.sh");
  symlinkSync(victim, picked);
  const out = await h.chrome(`
    const Saving = ChromeUtils.importESModule("chrome://userscripts/content/agent-sidebar/saving.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    // The Save As dialog, where the user picks picked.sh and confirms
    // replacing it (as nsIFilePicker's returnReplace).
    const CONTRACT = "@mozilla.org/filepicker;1";
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    const oldCID = registrar.contractIDToCID(CONTRACT);
    const newCID = Services.uuid.generateUUID();
    const factory = {
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
      createInstance(iid) {
        return {
          QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
          displayDirectory: null,
          defaultString: "",
          defaultExtension: "",
          init() {},
          appendFilter() {},
          appendFilters() {},
          get file() {
            return new FileUtils.File(${JSON.stringify(picked)});
          },
          open(callback) {
            Services.tm.dispatchToMainThread(() =>
              typeof callback === "function" ? callback(Ci.nsIFilePicker.returnReplace) : callback.done(Ci.nsIFilePicker.returnReplace)
            );
          },
        }.QueryInterface(iid);
      },
    };
    registrar.registerFactory(newCID, "UI saving test picker", CONTRACT, factory);
    Services.prefs.setBoolPref("browser.download.useDownloadDir", false);
    try {
      const path = await Saving.saveText(win, { name: "picked.sh", text: ${JSON.stringify(ANSWER)}, source: "https://example.com/" });
      return { saved: PathUtils.filename(path) };
    } finally {
      registrar.unregisterFactory(newCID, factory);
      registrar.registerFactory(oldCID, "", CONTRACT, null);
      Services.prefs.clearUserPref("browser.download.useDownloadDir");
    }
  `);
  assert.equal(out.saved, "picked.sh");
  assert.equal(readFileSync(victim, "utf8"), VICTIM, "the answer never went through the link");
  assert.equal(kind(picked), "file", "the link went, and the answer is a file in its place");
  assert.equal(readFileSync(picked, "utf8"), ANSWER);
});
