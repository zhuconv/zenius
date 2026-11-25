// zen-observe's Mac checks: screenshots in CSS pixels on a Retina display,
// and no download or dialog UI for agent tabs. zen-eval runs them on the
// Mac in a visible dev Zen:
//
//   ZENIUS_OBSERVE_HEADED=1 tests/observe/run.sh tests/observe/mac/mac.test.mjs
//
// They pass headless on Linux too (devicePixelRatio 1), which keeps them
// working between Mac runs; only the Mac run checks Retina.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setup } from "../lib.mjs";

let env;
let dir;
before(async () => {
  env = await setup();
  await mkdir(join(import.meta.dirname, "..", "out"), { recursive: true });
  dir = await mkdtemp(join(import.meta.dirname, "..", "out", "mac-"));
});
// run.sh stops the visible Zen on any exit and after its time limit; this
// only has to release what the tests hold, even when before() failed.
after(async () => {
  try {
    env?.close();
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** page.screenshot's bytes (I5: the runtime writes no file), written here as the SDK would. */
async function saveShot(page, path, options = {}) {
  const { base64 } = await page.call("page.screenshot", { options });
  await writeFile(path, Buffer.from(base64, "base64"));
}

async function pngSize(path) {
  const bytes = await readFile(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}

// Three color bands and a tall body, so the full page is taller than the window.
const BANDS =
  "data:text/html,<title>bands</title><body style='margin:0'>" +
  "<div style='height:200px;background:rgb(255,0,0)'></div>" +
  "<div style='height:200px;background:rgb(0,128,0)'></div>" +
  "<div style='height:2600px;background:rgb(0,0,255)'></div>";

/** RGBA of PNG pixels at CSS points, decoded by the page itself. */
function pixels(page, path, points) {
  return readFile(path).then(bytes =>
    page.evaluate(
      async ({ b64, points }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return points.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data));
      },
      { b64: bytes.toString("base64"), points }
    )
  );
}

test("screenshots are CSS pixels with exact colors at the display's scale", () =>
  env.inSpace("mac screenshot", async page => {
    await page.goto(BANDS);
    const dpr = await page.evaluate("devicePixelRatio");
    if (process.platform === "darwin") {
      assert.equal(dpr, 2, "a Retina display (run headed on the Mac)");
    }
    const info = await page.call("page.info");
    const viewport = join(dir, "viewport.png");
    await saveShot(page, viewport);
    const v = await pngSize(viewport);
    assert.deepEqual([v.width, v.height], [info.w, info.h], `viewport at DPR ${dpr} is CSS px`);
    assert.deepEqual(await pixels(page, viewport, [[10, 100], [10, 300], [10, 500]]), [
      [255, 0, 0, 255],
      [0, 128, 0, 255],
      [0, 0, 255, 255],
    ]);

    const full = join(dir, "full.png");
    await saveShot(page, full, { fullPage: true });
    const f = await pngSize(full);
    assert.deepEqual([f.width, f.height], [info.pw, info.ph], "full page is CSS px");

    const clip = join(dir, "clip.png");
    await saveShot(page, clip, { clip: { x: 0, y: 150, width: 100, height: 100 } });
    const c = await pngSize(clip);
    assert.deepEqual([c.width, c.height], [100, 100]);
    // The clip straddles the red and green bands at y = 200 (document coordinates).
    assert.deepEqual(await pixels(page, clip, [[50, 25], [50, 75]]), [
      [255, 0, 0, 255],
      [0, 128, 0, 255],
    ]);
  }));

test("an agent's download shows no UI and stays out of the user's downloads", () =>
  env.inSpace("mac download", async page => {
    await page.goto(`${env.base}/nav-target`);
    // Watch what the user's downloads UI watches: the public list Zen's
    // animation and the downloads button listen to.
    await env.chrome(
      `const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
       const list = await Downloads.getList(Downloads.ALL);
       // dev.evalChrome runs each call in a fresh scope; keep state on the window.
       const seen = (win.__zoMacSeen = []);
       win.__zoMacView = { onDownloadAdded: d => seen.push(d.source.url) };
       await list.addView(win.__zoMacView);
       win.__zoMacAnimations = win.document.querySelectorAll("zen-download-animation").length;
       return true;`
    );
    const waiting = page.call("page.waitForEvent", { event: "download", options: { timeout: 5000 } });
    await page.evaluate(`location.href = ${JSON.stringify(`${env.base}/api/download`)}`);
    const d = await waiting;
    assert.equal(d.suggestedFilename, "ego-download.txt");
    // The finished file, in the dev profile's working folder.
    const { path } = await env.call("download.path", { download: d.download });
    assert.equal(await readFile(path, "utf8"), "ego-browser download fixture\n");
    await sleep(500); // the animation would have started by now
    const ui = await env.chrome(
      `const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
       const list = await Downloads.getList(Downloads.ALL);
       await list.removeView(win.__zoMacView);
       const button = win.document.getElementById("downloads-button");
       const panel = win.document.getElementById("downloadsPanel");
       const dir = await Downloads.getPreferredDownloadsDirectory();
       return {
         added: win.__zoMacSeen,
         animations: win.document.querySelectorAll("zen-download-animation").length - win.__zoMacAnimations,
         buttonAttention: !!button?.hasAttribute("attention") || !!button?.hasAttribute("notification"),
         panelOpen: panel?.state === "open" || panel?.state === "showing",
         inUserDownloads: await IOUtils.exists(PathUtils.join(dir, arg)),
       };`,
      "ego-download.txt"
    );
    assert.deepEqual(ui, { added: [], animations: 0, buttonAttention: false, panelOpen: false, inUserDownloads: false });
    await env.call("download.delete", { download: d.download });
  }));

test("an agent's JS dialog shows no UI and asks for no attention", () =>
  env.inSpace("mac dialog", async page => {
    await page.goto(`${env.base}/nav-target`);
    await env.chrome(
      `win.__zoMacAttention = 0;
       win.__zoMacGetAttention = win.getAttention;
       win.getAttention = function () { win.__zoMacAttention++; return win.__zoMacGetAttention.call(this); };
       return true;`
    );
    try {
      for (const [script, type] of [
        ["alert('mac alert')", "alert"],
        ["confirm('mac confirm')", "confirm"],
        ["prompt('mac prompt', 'x')", "prompt"],
      ]) {
        await page.evaluate(`setTimeout(() => { window.answer = ${script} }, 0)`);
        let info;
        for (let i = 0; i < 100 && !info?.dialog; i++) {
          info = await page.call("page.info");
          await sleep(20);
        }
        assert.equal(info.dialog?.type, type);
        const ui = await env.chrome(
          `const { browser } = ctx.resolvePage(arg);
           const box = win.gBrowser.getTabDialogBox?.(browser);
           const tabModal = (box?._contentDialogManager?._dialogs?.length ?? 0) + (box?._tabDialogManager?._dialogs?.length ?? 0);
           const windowModal = [...Services.wm.getEnumerator(null)].filter(w => w.document?.documentElement?.id === "commonDialogWindow").length;
           return { tabModal, windowModal, attention: win.__zoMacAttention };`,
          page.P
        );
        assert.deepEqual(ui, { tabModal: 0, windowModal: 0, attention: 0 }, `${type} showed UI`);
        assert.equal(await page.call("page.dismissDialog"), true);
      }
    } finally {
      await env.chrome(`win.getAttention = win.__zoMacGetAttention; return true;`);
    }
  }));
