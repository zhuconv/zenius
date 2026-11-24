// The I1/I4 sweep (zen-observe): fire every way a page could reach past its
// agent tab, by an agent action (zen-input's trusted click or key, which
// grants user activation) and by the page's own script, in a hidden agent
// tab and in one the user is watching. Record what changes outside the
// page: windows, dialogs, doorhangers, panels, fullscreen, sound, focus, the
// Space's owner, downloads. Not part of test-all: tests/observe/ and
// tests/observe-vectors/ hold the fixes.
//
//   tests/observe/vectors/run.sh                  every vector
//   tests/observe/vectors/run.sh print auth-nav   some
//   SWEEP_ONLY=hidden|visible SWEEP_TRIGGER=agent|script tests/observe/vectors/run.sh
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../scripts/lib/rpc.mjs";
import { VECTORS, startVectorServer } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WAIT_MS = Number(process.env.SWEEP_WAIT_MS ?? 1500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Browser shortcuts an agent's key press could reach; page script can't press them. */
const KEYS = {
  "key-print": "Control+p",
  "key-new-window": "Control+n",
  "key-new-tab": "Control+t",
  "key-location": "Control+l",
  "key-fullscreen": "F11",
  "key-find": "Control+f",
};

/** Page code that reaches for a camera, microphone, screen, speaker, MIDI device or location. */
const DEVICE_CODE = /getUserMedia|getDisplayMedia|enumerateDevices|selectAudioOutput|requestMIDIAccess|SpeechRecognition|geolocation|devices-frame/i;

const DOWNLOAD_PREFS = {
  "browser.download.useDownloadDir": false,
  "browser.download.always_ask_before_handling_new_types": true,
};

// Chrome code (dev.evalChrome function bodies; `arg` is {space, page, …}).
const OBSERVE = `
  const { tab, browser: b } = ctx.resolvePage({ space: arg.space, page: arg.page });
  // The dev sandbox doesn't see b.ownerGlobal; these instances have one window.
  const w = win;
  const safe = f => { try { return f(); } catch (e) { return "error: " + e.message; } };
  const urlOf = d => String(d?._openedURL ?? d?._frame?.contentWindow?.location?.href ?? "?");
  const box = safe(() => w.gBrowser.getTabDialogBox(b));
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const dir = await Downloads.getPreferredDownloadsDirectory();
  return {
    windows: [...Services.wm.getEnumerator(null)].map(x => ({
      id: x.docShell?.outerWindowID,
      type: x.document?.documentElement?.getAttribute("windowtype") || "",
      url: String(x.location?.href ?? ""),
    })),
    tabDialogs: safe(() => (box.getTabDialogManager()._dialogs ?? []).map(urlOf)),
    contentDialogs: safe(() => (box.getContentDialogManager()._dialogs ?? []).map(urlOf)),
    windowDialog: safe(() => (w.gDialogBox?.isOpen ? urlOf(w.gDialogBox._dialog) : null)),
    doorhangers: safe(() => w.PopupNotifications._currentNotifications.filter(n => n.browser === b).map(n => n.id + (n.dismissed ? " (dismissed)" : ""))),
    doorhangerPanelOpen: safe(() => w.PopupNotifications.isPanelOpen),
    tabBar: safe(() => (w.gBrowser.readNotificationBox(b)?.allNotifications ?? []).map(n => n.getAttribute("value"))),
    windowBar: safe(() => (w.gNotificationBox?.allNotifications ?? []).map(n => n.getAttribute("value"))),
    openPopups: safe(() => [...w.document.querySelectorAll("panel, menupopup")].filter(p => p.state === "open" || p.state === "showing").map(p => p.id || p.localName)),
    fullscreen: safe(() => ({ window: w.fullScreen, dom: !!w.document.fullscreenElement })),
    warnings: safe(() => ["fullscreen-warning", "pointerlock-warning"].filter(id => w.document.getElementById(id)?.hasAttribute("onscreen"))),
    soundPlaying: safe(() => tab.hasAttribute("soundplaying")),
    attention: safe(() => tab.hasAttribute("attention")),
    findBar: safe(() => !!w.gBrowser.isFindBarInitialized?.(tab) && !w.gBrowser.getCachedFindBar(tab)?.hidden),
    focused: safe(() => { const el = Services.focus.focusedElement; return el ? el.localName + (el.id ? "#" + el.id : "") : null; }),
    downloadsPanel: safe(() => !!w.DownloadsPanel?.isPanelShowing),
    userDownloads: {
      list: (await (await Downloads.getList(Downloads.ALL)).getAll()).length,
      files: (await IOUtils.getChildren(dir).catch(() => [])).length,
    },
  };
`;

const SHOW = `
  const { tab, space: rec } = ctx.resolvePage({ space: arg.space, page: arg.page });
  const userWs = win.gZenWorkspaces.activeWorkspace;
  await win.gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
  // A Space shared by tasks (the Agents Space) opens on its last tab, which
  // can be another task's.
  win.gBrowser.selectedTab = tab;
  const end = Date.now() + 3000;
  while (win.gBrowser.selectedTab !== tab) {
    if (Date.now() > end) throw new Error("the agent's tab wasn't selected");
    await new Promise(r => win.setTimeout(r, 25));
  }
  return userWs;
`;

const CLEANUP = `
  const notes = [];
  for (const x of [...Services.wm.getEnumerator(null)]) {
    if (!arg.windowsBefore.includes(x.docShell?.outerWindowID)) {
      notes.push("closed " + (x.document?.documentElement?.getAttribute("windowtype") || x.location?.href));
      x.close();
    }
  }
  let r = null;
  try { r = ctx.resolvePage({ space: arg.space, page: arg.page }); } catch {}
  if (r) {
    const b = r.browser, w = win;
    try { w.gBrowser.getTabDialogBox(b).abortAllDialogs(); } catch {}
    try { for (const n of [...w.PopupNotifications._currentNotifications]) if (n.browser === b) w.PopupNotifications.remove(n); } catch {}
    try { w.gBrowser.readNotificationBox(b)?.removeAllNotifications(true); } catch {}
    try { if (w.document.fullscreenElement) await w.document.exitFullscreen(); } catch {}
    try { if (w.fullScreen) w.fullScreen = false; } catch {}
    try { w.gDialogBox?._dialog?.close(); } catch {}
  }
  for (const [name, value] of Object.entries(arg.prefs ?? {})) {
    if (value === null) Services.prefs.clearUserPref(name); else Services.prefs.setBoolPref(name, value);
  }
  if (arg.permission) {
    Services.perms.removeFromPrincipal(Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg.permission.origin), arg.permission.type);
  }
  if (arg.userWs && win.gZenWorkspaces.activeWorkspace !== arg.userWs) {
    await win.gZenWorkspaces.changeWorkspaceWithID(arg.userWs);
  }
  const rec = ctx.spaces.peek(arg.space);
  if (rec && !rec.gone) {
    for (const t of ctx.pages.inventory(rec)) ctx.pages.closeTab(t.tab);
    ctx.spaces.remove(rec);
  }
  return notes;
`;

const SET_PREFS = `
  const old = {};
  for (const [name, value] of Object.entries(arg)) {
    old[name] = Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : null;
    Services.prefs.setBoolPref(name, value);
  }
  return old;
`;

const GRANT = `
  const p = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arg.origin);
  Services.perms.addFromPrincipal(p, arg.type, Services.perms.ALLOW_ACTION);
  return true;
`;

function differences(before, after) {
  const out = [];
  const b = before.view;
  const a = after.view;
  if (a.activeWindow !== b.activeWindow) out.push(`activeWindow ${b.activeWindow}→${a.activeWindow}`);
  for (const [i, wa] of a.windows.entries()) {
    const wb = b.windows.find(x => x.id === wa.id);
    if (!wb) {
      out.push(`new browser window ${wa.id}`);
      continue;
    }
    for (const k of ["selectedTab", "activeWorkspace", "focusedElement"]) {
      if (wa[k] !== wb[k]) out.push(`window ${i} ${k} ${wb[k]}→${wa[k]}`);
    }
  }
  const ids = new Set(before.obs.windows.map(w => w.id));
  for (const w of after.obs.windows) {
    if (!ids.has(w.id)) out.push(`new window ${w.type || w.url}`);
  }
  return out;
}

/** What the run left outside the page, as short phrases. */
function surfaces(before, after) {
  const o = after.obs;
  const list = v => (Array.isArray(v) ? v : v ? [String(v)] : []);
  const out = [];
  const add = (cond, text) => cond && out.push(text);
  add(o.tabDialogs?.length, `tab dialog ${o.tabDialogs}`);
  add(o.contentDialogs?.length, `content dialog ${o.contentDialogs}`);
  add(o.windowDialog, `window dialog ${o.windowDialog}`);
  add(o.doorhangers?.length, `doorhanger ${o.doorhangers}${o.doorhangerPanelOpen === true ? " (panel open)" : ""}`);
  add(o.tabBar?.length, `tab notification bar ${o.tabBar}`);
  add(o.windowBar?.length, `window notification bar ${o.windowBar}`);
  const popups = list(o.openPopups).filter(p => !list(before.obs.openPopups).includes(p));
  add(popups.length, `open popup ${popups}`);
  add(o.fullscreen?.window || o.fullscreen?.dom, `fullscreen ${JSON.stringify(o.fullscreen)}`);
  add(o.warnings?.length, `warning ${o.warnings}`);
  add(o.soundPlaying === true, "tab plays sound");
  add(o.attention === true && before.obs.attention !== true, "tab flagged for attention");
  add(o.findBar === true, "find bar shown");
  add(o.downloadsPanel === true, "downloads panel");
  add(o.userDownloads.list !== before.obs.userDownloads.list, `user download list ${before.obs.userDownloads.list}→${o.userDownloads.list}`);
  add(o.userDownloads.files !== before.obs.userDownloads.files, `user Downloads folder ${before.obs.userDownloads.files}→${o.userDownloads.files}`);
  return out;
}

const brief = e => (e && typeof e === "object" ? `${e.code ?? "error"}: ${String(e.message ?? "").split("\n")[0].slice(0, 160)}` : String(e));

async function main() {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) throw new Error("ZENIUS_INSTANCE is not set; use tests/observe/vectors/run.sh");
  const client = await connect(instance, { callTimeout: 30000 });
  const call = (m, p = {}) => client.call(m, p);
  const chrome = (code, arg) => call("dev.evalChrome", { code, arg });
  const { server, base } = await startVectorServer();
  const origin = new URL(base).origin;

  // Nothing may launch an external app here: Firefox asks first unless this is off.
  const askFirst = await chrome(`return Services.prefs.getBoolPref("security.external_protocol_requires_permission", true);`);
  const wanted = process.argv.slice(2);
  const all = [...Object.keys(VECTORS), "login", ...Object.keys(KEYS)];
  // Zen on the Mac holds the user's camera, microphone and
  // screen-recording grants, and only fake devices may run there. The
  // sweep has none, so on the Mac it leaves out every vector
  // that reaches for a device, and location (which would ask macOS);
  // the Linux server runs them.
  const device = v => DEVICE_CODE.test(VECTORS[v] ?? "");
  const leftOut = process.platform === "darwin" ? (wanted.length ? wanted : all).filter(device) : [];
  if (leftOut.length) {
    console.error(`sweep: on the Mac, left out (devices): ${leftOut.join(" ")}`);
  }
  const vectors = (wanted.length ? wanted : all).filter(v => (askFirst || !/^(mailto|zoommtg|slack|tel)$/.test(v)) && !leftOut.includes(v));
  const visibilities = process.env.SWEEP_ONLY ? [process.env.SWEEP_ONLY] : ["hidden", "visible"];
  const triggers = process.env.SWEEP_TRIGGER ? [process.env.SWEEP_TRIGGER] : ["agent", "script"];

  const results = [];
  for (const visible of visibilities) {
    for (const vector of vectors) {
      for (const trigger of triggers) {
        if (KEYS[vector] && trigger === "script") continue;
        const r = { vector, trigger, visibility: visible };
        const space = await call("spaces.create", { name: `sweep ${vector} ${Date.now() % 100000}` });
        const P = { space: space.id, page: "p1" };
        const cleanup = { ...P, windowsBefore: [], prefs: null, permission: null, userWs: null };
        try {
          await call("page.goto", { ...P, url: `${base}/vectors` });
          if (vector.startsWith("download-")) cleanup.prefs = await chrome(SET_PREFS, DOWNLOAD_PREFS);
          if (vector === "notify-show") {
            await chrome(GRANT, { origin, type: "desktop-notification" });
            cleanup.permission = { origin, type: "desktop-notification" };
          }
          if (visible === "visible") cleanup.userWs = await chrome(SHOW, P);
          const before = { view: await call("dev.viewState"), obs: await chrome(OBSERVE, P) };
          cleanup.windowsBefore = before.obs.windows.map(w => w.id);
          await call("page.events", P);
          const t0 = Date.now();
          const fire = async () => {
            if (KEYS[vector]) return call("page.keyboard", { ...P, action: "press", key: KEYS[vector] });
            if (vector === "login") {
              if (trigger === "agent") {
                await call("page.fill", { ...P, target: "#username", value: "agent" });
                await call("page.fill", { ...P, target: "#password", value: "secret-password" });
                return call("page.click", { ...P, target: "#submit" });
              }
              return call("page.evaluate", {
                ...P,
                fn: `setTimeout(() => { username.value = "agent"; password.value = "secret-password"; login.requestSubmit(); }, 0); 1`,
                isFunction: false,
              });
            }
            if (trigger === "agent") return call("page.click", { ...P, target: `#v-${vector}`, options: { timeout: 4000 } });
            return call("page.evaluate", { ...P, fn: `setTimeout(() => window.__vectors[${JSON.stringify(vector)}](), 0); 1`, isFunction: false });
          };
          r.receipt = await Promise.race([
            fire().then(v => v, e => ({ error: brief(e) })),
            sleep(6000).then(() => ({ error: "no answer within 6 s" })),
          ]);
          r.receiptMs = Date.now() - t0;
          await sleep(WAIT_MS);
          const after = { view: await call("dev.viewState"), obs: await chrome(OBSERVE, P) };
          r.i1 = differences(before, after);
          r.surfaces = surfaces(before, after);
          r.page = await call("page.evaluate", { ...P, fn: "JSON.stringify(window.__vectorResults ?? null)", isFunction: false, responseTimeout: 1500 }).then(
            v => JSON.parse(v),
            e => ({ evaluate: brief(e) })
          );
          r.url = await call("page.url", P).catch(e => brief(e));
          r.events = (await call("page.events", P).catch(() => []))
            .map(e => e.method)
            .filter(m => !/^(Network|Page\.(frame|lifecycle|domContent|load)|Runtime\.(execution|console))/.test(m));
          r.space = await call("ui.state", { space: space.id }).then(s => `${s.ownership}${s.reason ? " (" + s.reason + ")" : ""}`, e => brief(e));
          if (vector === "beforeunload") {
            r.leave = await call("page.goto", { ...P, url: `${base}/plain`, options: { timeout: 3000 } }).then(v => v, e => ({ error: brief(e) }));
            r.leaveSurfaces = surfaces(before, { view: null, obs: await chrome(OBSERVE, P) });
          }
        } catch (e) {
          r.error = brief(e);
        } finally {
          r.cleanup = await chrome(CLEANUP, cleanup).catch(e => brief(e));
        }
        results.push(r);
        const verdict = r.i1?.length ? `I1 ✗ ${r.i1.join("; ")}` : "I1 ok";
        console.log(
          `${visible.padEnd(7)} ${trigger.padEnd(6)} ${vector.padEnd(20)} ${verdict} | ${(r.surfaces ?? []).join("; ") || "-"} | page ${JSON.stringify(r.page?.[vector] ?? r.page?.evaluate ?? r.page?.frames ?? null)} | receipt ${JSON.stringify(r.receipt)} | space ${r.space}${r.error ? " | ERROR " + r.error : ""}`
        );
      }
    }
  }
  const out = join(here, "..", "out", `vectors-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 1));
  console.log(`wrote ${out}`);
  client.close();
  server.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
