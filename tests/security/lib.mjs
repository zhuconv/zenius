// Helpers for the escape suite (SPEC §3.9 I5). Probes drive zenius as an
// agent does: scripts through the CLI and its public SDK, and raw frames on
// the instance's socket for whatever a script could send past the SDK.
// "The user" acts through the dev channel, which only dev profiles have.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";

import { guardHome } from "../lib/scratch-home.mjs";

export const INSTANCE = process.env.ZENIUS_SECURITY_INSTANCE ?? "";
const CLI = process.env.ZENIUS_SECURITY_CLI ?? "";
if (!INSTANCE || !CLI) throw new Error("run tests/security through tests/security/run.sh");
const SOCKET =
  process.env.ZENIUS_SOCKET || join(process.env.ZENIUS_HOME || join(homedir(), ".zenius"), "run", `${INSTANCE}.sock`);

/** The planted secret: no probe's output may ever contain it. */
export const CANARY = `zenius-security-canary-${process.pid}-${Date.now()}`;

/** Files the browser must never show an agent, in a folder outside every grant. */
export function plant() {
  const dir = mkdtempSync(join(tmpdir(), "zenius-security-"));
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, `${CANARY}\n`);
  const archive = join(dir, "secret.zip");
  writeFileSync(archive, zip("secret.txt", Buffer.from(`${CANARY}\n`)));
  return { dir, secret, archive, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Every scheme I5 keeps from an agent's loads, each with a URL that would
 * show something private or privileged if it opened: the probes zen-eval ran
 * on the Mac (docs/eval/live-pilot.md), and the rest of I5's list. `base` is
 * the fixture server's origin; `extension` is a live add-on's page, if any.
 */
export function forbiddenUrls(planted, base, extension) {
  return [
    { scheme: "file:", url: `file://${planted.secret}` },
    { scheme: "about:", url: "about:config" },
    { scheme: "about:", url: "about:logins" },
    { scheme: "about:", url: "about:preferences" },
    { scheme: "chrome:", url: "chrome://browser/content/browser.xhtml" },
    { scheme: "resource:", url: "resource://gre/modules/AppConstants.sys.mjs" },
    { scheme: "jar:", url: `jar:file://${planted.archive}!/secret.txt` },
    { scheme: "view-source:", url: `view-source:file://${planted.secret}` },
    { scheme: "view-source:", url: `view-source:${base}/` },
    { scheme: "moz-extension:", url: extension ?? "moz-extension://00000000-0000-4000-8000-000000000000/manifest.json" },
    // webcompat's page by its about: name: the same document, with the add-on's powers.
    { scheme: "about:", url: "about:compat" },
    { scheme: "javascript:", url: "javascript:document.title='zenius escape'" },
  ];
}

/**
 * The same schemes in spellings a naive check would let through: case,
 * whitespace, a missing slash, nesting, and a bare path that URL fixup
 * would turn into file:.
 */
export function disguisedUrls(planted) {
  return [
    { scheme: "file:", url: `FILE://${planted.secret}` },
    { scheme: "file:", url: `  file://${planted.secret}` },
    { scheme: "file:", url: `file:${planted.secret}` },
    { scheme: "file:", url: planted.secret },
    { scheme: "about:", url: "About:Config" },
    { scheme: "about:", url: "about:config?filter=zenius" },
    { scheme: "about:", url: "about:reader?url=about:config" },
    { scheme: "chrome:", url: "\tchrome://browser/content/browser.xhtml" },
    { scheme: "view-source:", url: "view-source:about:config" },
    { scheme: "moz-icon:", url: "moz-icon://stock/gtk-file?size=16" },
  ];
}

/** The working folder run.sh made, which the dev Zen and the CLI's config name. */
export const WORKING = process.env.ZENIUS_SECURITY_WORKING ?? "";

// Paths compared by what they name, not how they're spelled: the SDK
// returns the paths it resolves, with one slash between parts and none at
// the end, and a folder's name may have either.

/** Whether the absolute paths `a` and `b` name one file. */
export const samePath = (a, b) => typeof a === "string" && typeof b === "string" && resolve(a) === resolve(b);

/** Whether the absolute path `path` names something inside `folder`. */
export const insidePath = (path, folder) => typeof path === "string" && resolve(path).startsWith(`${resolve(folder)}/`);

/**
 * Runs `script` with `zenius nodejs`, as an agent's shell would, in run.sh's
 * scratch home: never the user's ~/.zenius/config.json or ~/zenius-files.
 */
export function zenius(script, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = guardHome({ ...process.env, HOME: process.env.ZENIUS_SECURITY_HOME, ZENIUS_HOME: process.env.ZENIUS_SECURITY_ZHOME }, "tests/security zenius()");
    const child = spawn(process.execPath, [CLI, "nodejs", "--instance", INSTANCE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

/**
 * Runs `body` as a zenius script and returns the JSON it prints last. The
 * script has `task` (a new space, finished afterwards, or the existing
 * `space`), `page` (its p1, sent to `start` first if given), `attempt(fn)`,
 * which turns a call into {ok, value} or {ok: false, code, message}, and
 * `A`, the JSON value of `arg`. Fails if the planted secret shows anywhere
 * in the script's output.
 */
export async function run(body, { name = "probe", space, start, arg = null } = {}) {
  const open = JSON.stringify(space ?? `it security ${name} ${process.pid} ${Date.now()}`);
  const script = `const A = ${JSON.stringify(arg)};
const attempt = async (fn) => {
  try {
    const value = await fn();
    return { ok: true, value: typeof value === "string" ? value.slice(0, 500) : value };
  } catch (error) {
    return { ok: false, code: error?.code ?? error?.name, message: String(error?.message ?? error).slice(0, 500), data: error?.data ?? null };
  }
};
const task = await taskSpace(${open});
const page = task.page("p1");
try {
  ${start ? `await page.goto(${JSON.stringify(start)});` : ""}
  ${body}
} finally {
  ${space === undefined ? "await task.finish({ keep: [] }).catch(() => {});" : ""}
}`;
  const result = await zenius(script);
  const output = `${result.stdout}\n${result.stderr}`;
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (output.includes(CANARY)) {
    const where = parsed === undefined ? [] : leakPaths(parsed);
    throw new Error(`the planted secret reached the agent through ${where.length ? where.join(", ") : "its output"}`);
  }
  if (parsed === undefined) throw new Error(`the probe printed no JSON (exit ${result.code}):\n${output}`);
  return parsed;
}

/** Where in a probe's result the canary shows, as dotted paths ("evaluate.value.passwords"). */
function leakPaths(value, path = []) {
  if (typeof value === "string") return value.includes(CANARY) ? [path.join(".") || "the result"] : [];
  if (!value || typeof value !== "object") return [];
  if (path.length >= 4) return JSON.stringify(value).includes(CANARY) ? [path.join(".")] : [];
  const entries = Array.isArray(value) ? value.map((item) => [null, item]) : Object.entries(value);
  // Array items share their array's path, so a list of leaks reads as one.
  return [...new Set(entries.flatMap(([key, item]) => leakPaths(item, key === null ? path : [...path, key])))];
}

/**
 * A connection to the instance's socket that sends frames as a script could,
 * past the SDK. call() resolves to {result} or {error}, never rejects on an
 * error frame.
 */
export async function connectRaw({ timeoutMs = 60_000 } = {}) {
  const socket = connect(SOCKET);
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  let greet;
  const greeted = new Promise((resolve) => (greet = resolve));
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.event === "hello") greet(frame.params ?? {});
      else if (pending.has(frame.id) && ("result" in frame || "error" in frame)) {
        pending.get(frame.id)(frame.error ? { error: frame.error } : { result: frame.result });
        pending.delete(frame.id);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const hello = await greeted;
  return {
    hello,
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close: () => socket.end(),
  };
}

/** One frame on a connection of its own. */
export async function raw(method, params = {}) {
  const connection = await connectRaw();
  try {
    return await connection.call(method, params);
  } finally {
    connection.close();
  }
}

/** A raw answer in the shape of a script's attempt(): {ok, value} or {ok: false, code, message, data}. */
export const asAttempt = (answer) =>
  answer.error
    ? { ok: false, code: answer.error.code, message: String(answer.error.message ?? ""), data: answer.error.data ?? null }
    : { ok: true, value: answer.result };

/** Like raw(), but returns the result and throws on an error frame. */
export async function call(method, params = {}) {
  const answer = await raw(method, params);
  if (answer.error) throw new Error(`${method}: ${answer.error.code}: ${answer.error.message}`);
  return answer.result;
}

/** A task space for probes that need the user to act between scripts. */
export async function newSpace(name) {
  const created = await call("spaces.create", { name: `it security ${name} ${process.pid} ${Date.now()}` });
  return created.id;
}

export const endSpace = (space) => raw("spaces.finish", { space, keep: [] }).catch(() => {});

/** Chrome JS in the parent through the dev channel; `arg` is passed as is. */
export const chrome = (code, arg) => call("dev.evalChrome", { code, arg });

/**
 * What the user does in an agent's tab: load `url` there with the system
 * principal, as typing it into the address bar does, and wait for it.
 */
export async function userLoads(space, label, url) {
  const P = { space, page: label };
  await chrome(
    `const { browser } = ctx.resolvePage(arg.P);
browser.fixupAndLoadURIString(arg.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
return true;`,
    { P, url },
  );
  await userWaits(P, url);
}

/** The user's Back or Forward button in an agent's tab; waits for `url`. */
export async function userGoes(space, label, direction, url) {
  const P = { space, page: label };
  await chrome(`const { browser } = ctx.resolvePage(arg.P); browser.${direction === "back" ? "goBack" : "goForward"}(); return true;`, { P });
  await userWaits(P, url);
}

async function userWaits(P, url) {
  let now = "";
  for (let end = Date.now() + 15_000; Date.now() < end; await sleep(100)) {
    now = await chrome(
      `const { browser } = ctx.resolvePage(arg);
return browser.webProgress?.isLoadingDocument ? "" : browser.currentURI.spec;`,
      P,
    );
    // A page may add a fragment to its own URL (about:logins selects a login).
    if (now === url || now.startsWith(`${url}#`)) return;
  }
  throw new Error(`the user's load of ${url} didn't finish (the tab shows ${now || "a load in progress"})`);
}

/**
 * A page of an add-on running in the instance: webcompat's about:compat page,
 * whose add-on may read every site's cookies, as on zen-eval's Mac profile.
 * Another add-on's manifest otherwise, or undefined when none runs.
 */
export async function liveExtension() {
  return chrome(`const policies = WebExtensionPolicy.getActiveExtensions();
const webcompat = policies.find((policy) => policy.id === "webcompat@mozilla.org");
if (webcompat) return webcompat.getURL("about-compat/aboutCompat.html");
const other = policies.find((policy) => policy.getURL("").startsWith("moz-extension://"));
return other ? other.getURL("manifest.json") : undefined;`);
}

/**
 * What the user's daily profile holds, seeded here as zen-eval seeded its
 * Mac profile: a saved login and a cookie, both for a site no probe visits,
 * with the canary in their values so a leak of either fails the probe.
 */
export async function seedSecrets() {
  await chrome(
    `const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
const origin = "https://bank.zenius.test";
if (!(await Services.logins.searchLoginsAsync({ origin })).length) {
  await Services.logins.addLoginAsync(new LoginInfo(origin, origin, null, "zenius-user", arg.password, "", ""));
}
// Gecko 160 takes the expiry in ms; a time in seconds expires at once.
Services.cookies.add("bank.zenius.test", "/", "zenius_session", arg.cookie, true, false, false,
  Date.now() + 86_400_000, {}, Ci.nsICookie.SAMESITE_LAX, Ci.nsICookie.SCHEME_HTTPS);
return true;`,
    { password: `${CANARY}-password`, cookie: `${CANARY}-cookie` },
  );
  const seeded = await chrome(`return {
  logins: (await Services.logins.searchLoginsAsync({ origin: "https://bank.zenius.test" })).length,
  cookies: Services.cookies.getCookiesFromHost("bank.zenius.test", {}).length,
};`);
  if (seeded.logins !== 1 || seeded.cookies !== 1) throw new Error(`seeding the profile failed: ${JSON.stringify(seeded)}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The download's bytes: every byte value, so a text conversion would show. */
export const REPORT = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));

/**
 * Loopback web pages for the probes: links and window.open() calls to each
 * forbidden URL, an upload form, and a download.
 */
export function startFixtures() {
  let openerUrls = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const html = (title, body) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`);
    };
    if (path === "/") return html("security fixture", "<h1>a web page</h1>");
    if (path === "/next") return html("security next", "<h1>the next web page</h1>");
    if (path === "/openers") {
      const rows = openerUrls.map((url, i) => {
        const quoted = JSON.stringify(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        return `<p><a id="blank-${i}" href=${quoted} target="_blank">new tab ${i}</a>
<a id="same-${i}" href=${quoted}>same tab ${i}</a>
<button id="open-${i}" onclick="window.open(${quoted})">window.open ${i}</button></p>`;
      });
      return html("security openers", rows.join("\n"));
    }
    if (path === "/upload") {
      return html(
        "security upload",
        `<input id="files" type="file" multiple>
<script>
// What was uploaded, as JSON on <html>: page code runs in zenius's sandbox,
// which sees the DOM but not the page's globals.
document.documentElement.dataset.uploaded = "null";
document.getElementById("files").addEventListener("change", async (event) => {
  const files = await Promise.all([...event.target.files].map(async (file) => ({ name: file.name, type: file.type, size: file.size, text: await file.text() })));
  document.documentElement.dataset.uploaded = JSON.stringify(files);
});
</script>`,
      );
    }
    if (path === "/download") return html("security download", '<a id="get" href="/report.bin">get the report</a>');
    if (path === "/report.bin") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="report.bin"',
        "access-control-allow-origin": "*",
      });
      return response.end(REPORT);
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        base: `http://127.0.0.1:${port}`,
        /** The URLs /openers links to and opens, by index. */
        setOpeners: (urls) => (openerUrls = urls),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A one-file zip archive, stored without compression, for the jar: probe. */
function zip(name, data) {
  const nameBytes = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const entry = Buffer.concat([local, nameBytes, data]);
  const directory = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, end]);
}
