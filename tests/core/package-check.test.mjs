// scripts/package-check.pl: what a release package's headers hold besides its
// files. scripts/release.sh runs it on the package it builds, and every .gz's
// header is read with it before it's published. The archives here are built
// byte by byte, plus one pair from the system's tar when it's GNU tar.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts/package-check.pl");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenius-package-check-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const octal = (n, width) => n.toString(8).padStart(width - 1, "0") + "\0";
// A ustar header. The check doesn't read the checksum.
function header({ name, size = 0, mode = 0o644, uid = 0, gid = 0, mtime = 1763700000, type = "0", link = "", uname = "", gname = "" }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, "latin1");
  h.write(octal(mode, 8), 100, "latin1");
  h.write(octal(uid, 8), 108, "latin1");
  h.write(octal(gid, 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(mtime, 12), 136, "latin1");
  h.write(type, 156, "latin1");
  h.write(link, 157, "latin1");
  h.write("ustar\u000000", 257, "latin1");
  h.write(uname, 265, "latin1");
  h.write(gname, 297, "latin1");
  return h;
}
const pad = (b) => Buffer.alloc((512 - (b.length % 512)) % 512);
const entry = (opts, data = Buffer.alloc(0)) => Buffer.concat([header({ ...opts, size: data.length }), data, pad(data)]);
const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);
// A pax record: its length counts its own digits.
function record(key, value) {
  const s = ` ${key}=${value}\n`;
  let n = s.length;
  while (`${n}${s}`.length !== n) n = `${n}${s}`.length;
  return `${n}${s}`;
}
const pax = (records) => entry({ name: "PaxHeader/x", type: "x" }, Buffer.from(records.map(([k, v]) => record(k, v)).join(""), "latin1"));
const files = [
  entry({ name: "zenius-0.1.0/", type: "5", mode: 0o755 }),
  entry({ name: "zenius-0.1.0/RELEASE" }, Buffer.from("version=0.1.0\n")),
  entry({ name: "zenius-0.1.0/install.sh", mode: 0o755 }, Buffer.from("#!/bin/sh\n")),
];

// gzip, with what a header may hold besides the format's own fields.
function gzip(data, { name, time = 0, comment, extra } = {}) {
  const flags = (extra ? 4 : 0) | (name ? 8 : 0) | (comment ? 16 : 0);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0x1f8b, 0);
  head[2] = 8;
  head[3] = flags;
  head.writeUInt32LE(time, 4);
  head[9] = 3;
  const parts = [head];
  if (extra) parts.push(Buffer.from([extra.length & 255, extra.length >> 8]), extra);
  if (name) parts.push(Buffer.from(name + "\0", "latin1"));
  if (comment) parts.push(Buffer.from(comment + "\0", "latin1"));
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(zlib.crc32(data), 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([...parts, zlib.deflateRawSync(data), tail]);
}

let n = 0;
function check(...archives) {
  const paths = archives.map((data) => {
    const p = path.join(dir, `p${++n}.tar.gz`);
    fs.writeFileSync(p, data);
    return p;
  });
  const r = spawnSync("perl", [CHECK, ...paths], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.replaceAll(dir + path.sep, ""), err: r.stderr };
}
// What the check says about one package: the list after "hold", or the line.
function finding(data) {
  const r = check(data);
  assert.equal(r.status, 1, `exit 1, with: ${r.out}${r.err}`);
  const m = r.out.match(/^p\d+\.tar\.gz: besides its files, its headers hold (.*); build it without them\n$/);
  return m ? m[1] : r.out.trim();
}

test("a package with owner and group 0, no names and one time passes, gzipped or not", () => {
  const plain = tar(...files);
  const r = check(gzip(plain), plain, Buffer.concat([gzip(plain.subarray(0, 1024)), gzip(plain.subarray(1024))]));
  assert.deepEqual(r, { status: 0, out: "", err: "" });
  // root's names, as some tars write them with owner 0, pass too.
  assert.equal(check(gzip(tar(entry({ name: "a", uname: "root", gname: "wheel" })))).status, 0);
});

test("an owner, a group, their names or ids stop it, in a header or a pax record", () => {
  assert.equal(finding(gzip(tar(entry({ name: "a", uid: 501, gid: 20, uname: "someone", gname: "staff" })))), "an owner or group other than 0; an owner's or group's name");
  assert.equal(finding(gzip(tar(entry({ name: "a", gname: "lab users" })))), "an owner's or group's name");
  assert.equal(finding(gzip(tar(pax([["uname", "someone"]]), entry({ name: "a" })))), "an owner's or group's name");
  assert.equal(finding(gzip(tar(pax([["gid", "1000"]]), entry({ name: "a" })))), "an owner or group other than 0");
});

test("each file's own time, access or change times, attributes, comments and absolute links stop it", () => {
  assert.equal(finding(gzip(tar(entry({ name: "a" }), entry({ name: "b", mtime: 1763700042 })))), "more than one time: each file's own, not one for the package");
  assert.equal(finding(gzip(tar(pax([["atime", "1763700001.5"], ["ctime", "1763700002"]]), entry({ name: "a" })))), "access or change times");
  assert.equal(finding(gzip(tar(pax([["LIBARCHIVE.xattr.com.apple.provenance", "AQ"]]), entry({ name: "a" })))), "extended attributes");
  assert.equal(finding(gzip(tar(pax([["SCHILY.xattr.user.origin", "x"]]), entry({ name: "a" })))), "extended attributes");
  assert.equal(finding(gzip(tar(pax([["comment", "built on a laptop"]]), entry({ name: "a" })))), "a comment");
  assert.equal(finding(gzip(tar(entry({ name: "a", type: "2", link: "/abs/target" })))), "a link to an absolute path");
  assert.equal(finding(gzip(tar(pax([["linkpath", "/abs/target"]]), entry({ name: "a", type: "2", link: "x" })))), "a link to an absolute path");
  // A relative link, and a pax mtime that matches the header's, pass.
  assert.equal(check(gzip(tar(pax([["mtime", "1763700000"]]), entry({ name: "a", type: "2", link: "../b" })))).status, 0);
});

test("a gzip header's file name, comment, extra field or time stops it, in any member", () => {
  const plain = tar(...files);
  assert.equal(finding(gzip(plain, { name: "zenius-0.1.0.tar", time: 1763700000 })), "a file name in its gzip header; a time in its gzip header");
  assert.equal(finding(gzip(plain, { comment: "made by someone" })), "a comment in its gzip header");
  assert.equal(finding(gzip(plain, { extra: Buffer.from("AP\x02\x00hi", "latin1") })), "an extra field in its gzip header");
  assert.equal(finding(Buffer.concat([gzip(plain.subarray(0, 1024)), gzip(plain.subarray(1024), { name: "part2" })])), "a file name in its gzip header");
});

test("data after its end, a package it can't read and a bad argument", () => {
  const plain = tar(...files);
  assert.equal(finding(Buffer.concat([gzip(plain), Buffer.from("tail")])), "data after its end");
  assert.equal(finding(gzip(Buffer.concat([plain, Buffer.from("leftover")]))), "data after its end");
  for (const other of [Buffer.from("PK\x03\x04rest", "latin1"), Buffer.from("\xfd7zXZ\0rest", "latin1"), Buffer.alloc(2048)]) {
    assert.equal(finding(other), `p${n}.tar.gz: a package this check can't read; use .tar.gz`);
  }
  assert.equal(spawnSync("perl", [CHECK], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("perl", [CHECK, "--all"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("perl", [CHECK, path.join(dir, "missing.tar.gz")], { encoding: "utf8" }).status, 2);
});

// GNU tar's own output: by default it names the account that runs it, and
// with neutral owners and one time it passes, its long-name headers included.
const gnuTar = /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");
test("GNU tar: its default output fails, with neutral owners and one time it passes", { skip: !gnuTar ? "the system's tar isn't GNU tar" : process.getuid?.() === 0 ? "run as root, whose own owner is 0" : false }, () => {
  const src = path.join(dir, "src");
  const deep = path.join(src, "pkg", "d".repeat(60), "e".repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(src, "pkg", "a.txt"), "a\n");
  fs.writeFileSync(path.join(deep, "b.txt"), "b\n");
  const plain = spawnSync("tar", ["-cf", "-", "pkg"], { cwd: src });
  assert.match(finding(gzip(plain.stdout)), /an owner or group other than 0/);
  const neutral = spawnSync("tar", ["--owner=0", "--group=0", "--numeric-owner", "--mtime=@1763700000", "--sort=name", "-cf", "-", "pkg"], { cwd: src });
  assert.equal(neutral.status, 0, String(neutral.stderr));
  assert.deepEqual(check(gzip(neutral.stdout)), { status: 0, out: "", err: "" });
});
