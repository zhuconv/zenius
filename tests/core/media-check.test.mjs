// scripts/media-check.pl: what an image or a movie holds besides its pixels.
// Every image is checked with it before it's published, and the release runs
// it on every media file it carries. The files here are built byte by byte,
// so the test needs no image or video tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts/media-check.pl");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenius-media-check-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const bytes = (s) => Buffer.from(s, "latin1");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

// PNG: chunks after the signature. The check doesn't read the CRCs.
const chunk = (type, data = Buffer.alloc(0)) => Buffer.concat([u32(data.length), bytes(type), data, u32(0)]);
const png = (...extra) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.alloc(13)), chunk("gAMA", Buffer.alloc(4)), ...extra, chunk("IDAT", Buffer.from([1, 2, 3])), chunk("IEND"),
]);

// GIF: a 1x1 screen with a 2-color table, the looping block ffmpeg and
// browsers write, one frame, then the trailer.
const gif = (...extra) => Buffer.concat([
  bytes("GIF89a"), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.alloc(6),
  Buffer.from([0x21, 0xff, 11]), bytes("NETSCAPE2.0"), Buffer.from([3, 1, 0, 0, 0]),
  ...extra,
  Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]),
  Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0]),
  Buffer.from([0x3b]),
]);
const gifComment = Buffer.concat([Buffer.from([0x21, 0xfe, 4]), bytes("name"), Buffer.from([0])]);

// JPEG: segments, the scan, its data (an FF byte stuffed with 00), the end.
const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
const jpeg = (...extra) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.concat([bytes("JFIF\0"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
  ...extra,
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34]),
  Buffer.from([0xff, 0xd9]),
]);
const exif = seg(0xe1, Buffer.concat([bytes("Exif\0\0MM\0*"), Buffer.alloc(8)]));

// WebP: RIFF chunks, each padded to an even length.
const wchunk = (type, data) => Buffer.concat([bytes(type), le32(data.length), data, Buffer.alloc(data.length & 1)]);
const webp = (...chunks) => {
  const body = Buffer.concat([bytes("WEBP"), ...chunks]);
  return Buffer.concat([bytes("RIFF"), le32(body.length), body]);
};
const vp8l = wchunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]));

// MP4: boxes. udta holds an empty meta, as ffmpeg writes it with
// -map_metadata -1 -fflags +bitexact (checked against ffmpeg's own files).
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), bytes(type), body]); };
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const times = (t) => Buffer.concat([u32(t), u32(t)]);
const hdlr = full("hdlr", 0, u32(0), bytes("mdirappl"), Buffer.alloc(9));
const emptyUdta = box("udta", full("meta", 0, hdlr, box("ilst")));
const selfRef = full("url ", 1);
const movie = ({ t = 0, udta = emptyUdta, ref = selfRef, free = box("free"), after = [] } = {}) => Buffer.concat([
  box("ftyp", bytes("isom"), u32(512), bytes("isomiso2avc1mp41")),
  free,
  box("mdat", Buffer.from([1, 2, 3, 4])),
  box("moov",
    full("mvhd", 0, times(t), u32(1000), u32(1000), Buffer.alloc(80)),
    box("trak",
      full("tkhd", 3, times(t), u32(1), Buffer.alloc(72)),
      box("mdia", full("mdhd", 0, times(t), u32(1000), u32(1000), Buffer.alloc(4)),
        box("minf", box("dinf", full("dref", 0, u32(1), ref))))),
    udta),
  ...after,
]);

let n = 0;
function check(...files) {
  const paths = files.map((data) => {
    const p = path.join(dir, `f${++n}`);
    fs.writeFileSync(p, data);
    return p;
  });
  const r = spawnSync("perl", [CHECK, ...paths], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.replaceAll(dir + path.sep, ""), err: r.stderr };
}
// What the check says about one file: the list after "it has", or the line.
function finding(data) {
  const r = check(data);
  assert.equal(r.status, 1, `exit 1, with: ${r.out}${r.err}`);
  const m = r.out.match(/^f\d+: besides its pixels, it has (.*); save it without them\n$/);
  return m ? m[1] : r.out.trim();
}

test("images with only their pixels pass: PNG, GIF, JPEG and WebP", () => {
  const r = check(png(), gif(), jpeg(), webp(vp8l), webp(wchunk("VP8X", Buffer.alloc(10)), wchunk("ICCP", Buffer.alloc(4)), vp8l));
  assert.deepEqual(r, { status: 0, out: "", err: "" });
});

test("an image's text, EXIF or XMP stops it, and so does data after its end", () => {
  assert.equal(finding(png(chunk("tEXt", bytes("Author\0someone")), chunk("iTXt", bytes("XML:com.adobe.xmp\0")))), "a tEXt chunk; an iTXt chunk");
  assert.equal(finding(png(chunk("eXIf", bytes("MM\0*")))), "an eXIf chunk");
  // aCropalypse: the uncropped original's tail stays after IEND.
  assert.equal(finding(Buffer.concat([png(), chunk("IDAT", Buffer.from([9, 9]))])), "data after its end");
  assert.equal(finding(gif(gifComment)), "a comment");
  const xmp = Buffer.concat([Buffer.from([0x21, 0xff, 11]), bytes("XMP DataXMP"), Buffer.from([1, 0x3c, 0])]);
  assert.equal(finding(gif(xmp)), "application data (XMP DataXMP)");
  assert.equal(finding(Buffer.concat([gif(), bytes("tail")])), "data after its end");
  assert.equal(finding(jpeg(exif)), "an APP1 segment (EXIF or XMP)");
  assert.equal(finding(jpeg(seg(0xfe, bytes("made by someone")))), "a comment");
  assert.equal(finding(Buffer.concat([jpeg(), jpeg(exif)])), "data after its end");
  assert.equal(finding(webp(wchunk("VP8X", Buffer.alloc(10)), vp8l, wchunk("EXIF", bytes("MM\0*")))), "an EXIF chunk");
  assert.equal(finding(Buffer.concat([webp(vp8l), bytes("tail")])), "data after its end");
});

test("a movie with only its frames passes, an empty udta as ffmpeg writes it included", () => {
  const r = check(movie(), movie({ udta: Buffer.alloc(0) }));
  assert.deepEqual(r, { status: 0, out: "", err: "" });
});

test("a movie's tags, place, times, XMP, padding, references or leftovers stop it", () => {
  const tag = (type) => box(type, box("data", u32(1), u32(0), bytes("x")));
  const tags = box("udta", full("meta", 0, hdlr, box("ilst", tag("\xa9too"), tag("\xa9nam"))));
  assert.equal(finding(movie({ udta: tags })), "tags ((c)too, (c)nam)");
  assert.equal(finding(movie({ udta: box("udta", box("\xa9xyz", bytes("+00.00+000.00/"))) })), "user data ((c)xyz)");
  assert.equal(finding(movie({ udta: box("udta", box("loci", Buffer.alloc(20))) })), "user data (loci)");
  // QuickTime's meta isn't a full box, and its tags are numbered keys.
  const keys = box("meta", box("hdlr", Buffer.alloc(24)), box("keys", u32(0), u32(1)), box("ilst", tag("\0\0\0\x01")));
  assert.equal(finding(movie({ udta: keys })), "metadata (keys); tags (key 1)");
  assert.equal(finding(movie({ t: 3878100000 })), "a creation or modification time");
  assert.equal(finding(movie({ after: [box("uuid", Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex"), bytes("<x:xmpmeta/>"))] })), "a uuid box (XMP or a vendor's data)");
  assert.equal(finding(movie({ free: box("free", bytes("old title")) })), "padding that holds data");
  assert.equal(finding(movie({ ref: full("url ", 0, bytes("file:///somewhere/take1.mov\0")) })), "a reference to another file");
  assert.equal(finding(movie({ after: [box("pnot", Buffer.alloc(12))] })), "a box movies don't need (pnot)");
  assert.equal(finding(Buffer.concat([movie(), bytes("left")])), "a box it can't read, or data after its end");
});

test("anything it can't read stops it, and a bad argument exits 2", () => {
  assert.equal(finding(Buffer.concat([bytes("BM"), Buffer.alloc(60)])), "f" + n + ": a format this check can't read; use PNG, GIF, JPEG, WebP or MP4");
  assert.equal(spawnSync("perl", [CHECK], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("perl", [CHECK, "--all"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("perl", [CHECK, path.join(dir, "missing.mp4")], { encoding: "utf8" }).status, 2);
});
