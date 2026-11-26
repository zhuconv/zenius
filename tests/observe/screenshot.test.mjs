// page.screenshot as Ego's captureScreenshot: PNG in CSS pixels, the
// viewport at its scroll offset, the whole document, or a clip in document
// coordinates; and its option checks. I5: the runtime returns the bytes
// ({mimeType, base64}) and writes no file; the client writes path.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./lib.mjs";

let env;
before(async () => {
  env = await setup();
});
after(() => env.close());

/** The PNG page.screenshot returns, with its IHDR's width and height. */
async function shot(page, options) {
  const result = await page.call("page.screenshot", options ? { options } : {});
  assert.deepEqual(Object.keys(result).sort(), ["base64", "mimeType"]);
  assert.equal(result.mimeType, "image/png");
  const bytes = Buffer.from(result.base64, "base64");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", "the bytes are a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}

const TALL = `data:text/html,<title>tall</title><body style="margin:0"><div style="height:3000px;width:100%25;background:linear-gradient(red,blue)"></div>`;

test("the viewport and the full page in CSS pixels", () =>
  env.inSpace("screenshot sizes", async page => {
    await page.goto(TALL);
    const info = await page.call("page.info");
    const v = await shot(page);
    assert.deepEqual([v.width, v.height], [info.w, info.h]);

    const f = await shot(page, { fullPage: true });
    assert.deepEqual([f.width, f.height], [info.pw, info.ph]);
    assert.ok(f.height >= 3000, `full page is ${f.height} px tall`);
  }));

// Classic scrollbars: macOS's overlay thumb shows on the first scroll and
// then fades, so the viewport shot and the same clip taken after it could
// differ by the thumb (on the Mac, in 3 runs of 7; 24 of 24 with classic).
test("a clip is in document coordinates, scaled as CDP's", () =>
  env.inSpace("screenshot clip", page => classicScrollbars(async () => {
    await page.goto(TALL);
    await page.evaluate("scrollTo(0, 1000)");
    const info = await page.call("page.info");
    assert.equal(info.sy, 1000);
    const viewport = await shot(page);
    // The viewport of a scrolled page is the clip at its scroll offset...
    const atScroll = await shot(page, { clip: { x: 0, y: info.sy, width: info.w, height: info.h } });
    assert.ok(viewport.bytes.equals(atScroll.bytes), "clip at the scroll offset matches the viewport");
    // ...and a clip at the top shows the top of the document.
    const top = await shot(page, { clip: { x: 0, y: 0, width: info.w, height: info.h } });
    assert.ok(!top.bytes.equals(viewport.bytes), "clip at y=0 differs from the scrolled viewport");

    const small = await shot(page, { clip: { x: 10, y: 20, width: 120, height: 80 } });
    assert.deepEqual([small.width, small.height], [120, 80]);
    const dpr = await page.evaluate("devicePixelRatio");
    const scaled = await shot(page, { clip: { x: 0, y: 0, width: 50, height: 40, scale: 2 } });
    assert.deepEqual([scaled.width, scaled.height], [100 * dpr, 80 * dpr]);
  })));

/** The RGB of one pixel of a screenshot, decoded by Gecko's own PNG decoder. */
const pixel = (s, x, y) =>
  env.chrome(
    `const img = new win.Image();
     img.src = "data:image/png;base64," + arg.b64;
     await img.decode();
     const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
     c.width = img.width;
     c.height = img.height;
     const g = c.getContext("2d");
     g.drawImage(img, 0, 0);
     return [...g.getImageData(arg.x, arg.y, 1, 1).data].slice(0, 3).join(",");`,
    { b64: s.bytes.toString("base64"), x, y }
  );

// The eval harness's page for Ego's rule (2026-11-20): a green page, scrolled, with a
// classic scrollbar in magenta (the Linux server's headless Zen has a 12 px one too).
const BARRED = `data:text/html,<title>bar</title><html style="scrollbar-color:magenta magenta"><body style="margin:0;background:green"><div style="height:3000px"></div>`;
const MAGENTA = "255,0,255";
const GREEN = "0,128,0";

/**
 * Classic scrollbars for `fn`, which take room and are always drawn: macOS
 * draws overlay ones by default, which take none and fade (the eval harness's Mac
 * runs of 2026-11-21). A function declaration, so the clip case above can
 * use it.
 */
async function classicScrollbars(fn) {
  await env.chrome(`Services.prefs.setIntPref("ui.useOverlayScrollbars", 0); return true;`);
  try {
    return await fn();
  } finally {
    await env.chrome(`Services.prefs.clearUserPref("ui.useOverlayScrollbars"); return true;`);
  }
}

test("a shot shows what's on screen, as Ego's: a clip inside the viewport has the scrollbar, one beyond it doesn't", () =>
  env.inSpace("screenshot scrollbar", page => classicScrollbars(async () => {
    await page.goto(BARRED);
    await page.evaluate("scrollTo(0, 1000)");
    const info = await page.call("page.info");
    const bar = await page.evaluate("innerWidth - document.documentElement.clientWidth");
    if (bar === 0) {
      // Overlay scrollbars all the same: no scrollbar to find in a shot, so
      // only what doesn't need one is checked.
      console.log("[screenshot] overlay scrollbars here, even with ui.useOverlayScrollbars = 0: the scrollbar's pixels aren't checked");
      const viewport = await shot(page);
      const visible = await shot(page, { clip: { x: 0, y: info.sy, width: info.w, height: info.h } });
      assert.ok(visible.bytes.equals(viewport.bytes), "the visible region, clipped, is the viewport shot");
      assert.equal(await page.evaluate("scrollY"), 1000, "no shot scrolled the page");
      return;
    }
    const edge = info.w - Math.ceil(bar / 2);

    const viewport = await shot(page);
    assert.equal(await pixel(viewport, edge, 100), MAGENTA, "the viewport has its scrollbar");
    assert.equal(await pixel(viewport, 50, 100), GREEN);
    const visible = await shot(page, { clip: { x: 0, y: info.sy, width: info.w, height: info.h } });
    assert.ok(visible.bytes.equals(viewport.bytes), "the visible region, clipped, is the viewport shot");
    const corner = await shot(page, { clip: { x: info.w - 40, y: info.sy + 10, width: 40, height: 30 } });
    assert.deepEqual([corner.width, corner.height], [40, 30]);
    assert.equal(await pixel(corner, 40 - Math.ceil(bar / 2), 20), MAGENTA, "a small clip on screen has the scrollbar");
    assert.equal(await pixel(corner, 5, 20), GREEN);
    const doubled = await shot(page, { clip: { x: info.w - 40, y: info.sy + 10, width: 40, height: 30, scale: 2 } });
    const dpr = await page.evaluate("devicePixelRatio");
    assert.deepEqual([doubled.width, doubled.height], [80 * dpr, 60 * dpr]);
    assert.equal(await pixel(doubled, (80 - bar) * dpr, 40 * dpr), MAGENTA);

    const above = await shot(page, { clip: { x: 0, y: 0, width: info.w, height: info.h } });
    assert.equal(await pixel(above, edge, 100), GREEN, "a clip off screen is the document, no scrollbar");
    // One that leaves the viewport is drawn from the document as a whole.
    const across = await shot(page, { clip: { x: 0, y: info.sy + info.h - 50, width: info.w, height: 100 } });
    assert.equal(await pixel(across, edge, 10), GREEN, "a clip across the viewport's edge is the document");
    assert.equal(await page.evaluate("scrollY"), 1000, "no shot scrolled the page");
  })));

test("a path is refused: the runtime writes no file an agent names (I5)", () =>
  env.inSpace("screenshot path", async page => {
    await page.goto(`${env.base}/nav-target`);
    for (const path of ["/tmp/zenius-i5-shot.png", "shot.png"]) {
      const e = await page.fail("page.screenshot", { options: { path } });
      assert.equal(e.code, "ZEN_INVALID_ARGUMENT");
      assert.match(e.message, /^page\.screenshot takes no path: it returns the image's bytes/);
    }
  }));

test("options outside Ego's are refused", () =>
  env.inSpace("screenshot options", async page => {
    await page.goto(`${env.base}/nav-target`);
    const type = await page.fail("page.screenshot", { options: { type: "jpeg" } });
    assert.equal(type.code, "ZEN_INVALID_ARGUMENT");
    assert.match(type.message, /^page\.screenshot received unknown option: type\./);
    const scale = await page.fail("page.screenshot", { options: { scale: "device" } });
    assert.equal(scale.message, "page.screenshot scale must be one of css");
    const clip = await page.fail("page.screenshot", { options: { clip: { x: 0, y: 0, width: 0, height: 10 } } });
    assert.equal(clip.message, "page.screenshot clip must be clip");
    // raw is accepted and, as in Ego, changes nothing.
    const info = await page.call("page.info");
    const raw = await shot(page, { raw: true });
    assert.deepEqual([raw.width, raw.height], [info.w, info.h]);
  }));
