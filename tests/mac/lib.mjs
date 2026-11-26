// Shared setup for zen-eval's Mac tests of the bundle. tests/mac/run.sh
// starts a dev Zen whose agent sidebar talks to the mock agents, in a scratch
// HOME and ZENIUS_HOME, and sets ZENIUS_INSTANCE; the tests drive it over RPC
// and check the chrome through dev.evalChrome. Each chrome check gets `H`
// (the hooks in hooks.mjs) and `T` (the helpers below) in scope.
import { connect } from "../../scripts/lib/rpc.mjs";
import { closeFixtureServer, startFixtureServer } from "../fixtures/server.mjs";
import { guardHome } from "../lib/scratch-home.mjs";
import * as HOOKS from "./hooks.mjs";

/** A visible window: the look, as the user sees it. */
export const HEADED = process.env.ZENIUS_MAC_HEADED === "1";

/** zen-sidebar's test pages (run.sh serves them on 127.0.0.1). */
export const WWW = process.env.ZENIUS_MAC_WWW || "";

const HELPERS = `
const H = ${JSON.stringify(HOOKS)};
const XHTML = "http://www.w3.org/1999/xhtml";
const T = {
  sleep: ms => new Promise(r => win.setTimeout(r, ms)),
  /** fn's first truthy value; throws after ms. */
  async until(fn, ms = 10000, what = "the condition") {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch {}
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out after " + ms + " ms waiting for " + what);
      await T.sleep(50);
    }
  },
  glue: () => win.ucAgentSidebar,
  panelDoc: () => win.document.getElementById("sidebar")?.contentDocument,
  /** Opens the agent sidebar if it isn't, and returns its document once it has a mode. */
  async openPanel() {
    const S = win.SidebarController;
    if (!(S.isOpen && S.currentID === H.SIDEBAR_ID)) await S.show(H.SIDEBAR_ID);
    return T.until(() => {
      const d = T.panelDoc();
      return d?.readyState === "complete" && d.documentElement.hasAttribute(H.PANEL.mode) && d;
    }, 15000, "the agent sidebar's panel");
  },
  // (ownerDocument.defaultView, not ownerGlobal: the panel's nodes are
  // content nodes, whose chrome-only members the wrapper hides.)
  visible(el) {
    if (!el || el.hidden || !el.isConnected) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  /** el's rect as a plain object, moved by (dx, dy). */
  box(el, dx = 0, dy = 0) {
    const r = el.getBoundingClientRect();
    return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy, width: r.width, height: r.height };
  },
  /** Where the panel's document sits in the window, to turn its rects into the window's. */
  panelOffset() {
    const r = win.document.getElementById("sidebar").getBoundingClientRect();
    return [r.left, r.top];
  },
  lineHeight(el) {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  },
  /** A CSS color as [r, g, b, a] (0-255), drawn on a canvas, so any color syntax works. */
  rgba(css) {
    const c = win.document.createElementNS(XHTML, "canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data];
  },
  /**
   * The color a custom property resolves to inside el, as [r, g, b, a]. Inside
   * el, since a stylesheet may define it on that element rather than the root.
   */
  cssVar(el, name) {
    const doc = el.ownerDocument ?? el;
    const probe = doc.createElementNS(XHTML, "span");
    probe.style.color = "var(" + name + ")";
    probe.style.position = "absolute";
    (el.ownerDocument ? el : doc.documentElement).append(probe);
    const color = doc.defaultView.getComputedStyle(probe).color;
    probe.remove();
    return T.rgba(color);
  },
  /** [hue 0-360, saturation 0-1, lightness 0-1] of [r, g, b]. */
  hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  },
  // Keys as the user plays them: nsITextInputProcessor sends trusted events
  // through Zen's own handlers (shortcuts, the URL bar, ⌃Tab).
  MOD: { Meta: ["MetaLeft", 224], Control: ["ControlLeft", 17], Shift: ["ShiftLeft", 16], Alt: ["AltLeft", 18] },
  KEYS: { Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], ArrowDown: ["ArrowDown", 40], Backspace: ["Backspace", 8], " ": ["Space", 32], ">": ["Period", 190] },
  press(key, mods = []) {
    T.tip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
    if (!T.tip.beginInputTransactionForTests(win)) throw new Error("no input transaction for the window");
    const ev = (k, code, keyCode) => new win.KeyboardEvent("", { key: k, code, keyCode });
    for (const m of mods) T.tip.keydown(ev(m, ...T.MOD[m]));
    let code = "", keyCode = 0;
    if (T.KEYS[key]) [code, keyCode] = T.KEYS[key];
    else if (/^[a-z]$/i.test(key)) [code, keyCode] = ["Key" + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
    else if (/^[0-9]$/.test(key)) [code, keyCode] = ["Digit" + key, key.charCodeAt(0)];
    const e = ev(key, code, keyCode);
    T.tip.keydown(e);
    T.tip.keyup(e);
    for (const m of [...mods].reverse()) T.tip.keyup(ev(m, ...T.MOD[m]));
  },
  type(text) {
    for (const ch of text) T.press(ch);
  },
  /** Cmd on the Mac, Ctrl elsewhere: Zen's accel key. */
  accel: () => (Services.appinfo.OS === "Darwin" ? "Meta" : "Control"),
  /** The window drawn by Gecko at scale over backdrop: { width, height, data }. */
  async pixels(scale, backdrop) {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(
      new win.DOMRect(0, 0, win.innerWidth, win.innerHeight), scale, backdrop);
    const c = win.document.createElementNS(XHTML, "canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const g = c.getContext("2d");
    g.drawImage(bitmap, 0, 0);
    return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data, canvas: c };
  },
  /** A PNG of the window at the screen's pixel ratio, written to path. */
  async shot(path, backdrop) {
    const { canvas } = await T.pixels(win.devicePixelRatio || 1, backdrop);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  },
};
`;

/**
 * Connects to the dev Zen and serves the test pages.
 *
 * @param {string} name  the suite's name, for the fixture server
 */
export async function setup(name) {
  const instance = process.env.ZENIUS_INSTANCE;
  if (!instance) {
    throw new Error("ZENIUS_INSTANCE is not set; run tests/mac/run.sh");
  }
  // run.sh runs the tests with the scratch HOME and ZENIUS_HOME it gave the
  // dev Zen. Run another way, they could drive a Zen that keeps its socket,
  // state and self-check in the account's own ~/.zenius: refuse that.
  guardHome(process.env, "tests/mac (run it through tests/mac/run.sh)");
  const client = await connect(instance, { callTimeout: 120000 });
  const fixture = await startFixtureServer(`zen-eval mac ${name}`);
  return {
    client,
    base: fixture.baseUrl,
    call: (method, params) => client.call(method, params),
    /** Chrome JS (a function body, with `win`, `arg`, `H` and `T`); see dev.evalChrome. */
    chrome: (code, arg) => client.call("dev.evalChrome", { code: `${HELPERS}\n${code}`, arg }),
    async close() {
      client.close();
      await closeFixtureServer(fixture.server);
    },
  };
}

/** The prefs a theme sets, in the dev profile only. */
const THEME_PREFS = ["zen.view.window.scheme", "ui.systemUsesDarkTheme"];

/**
 * Runs body in Zen's own Light or Dark (zen.view.window.scheme, its Settings'
 * choice, with the color scheme pages and chrome read), and puts both prefs
 * back as they were in a finally. As tests/ux/mac/look.test.mjs does.
 *
 * @param {ReturnType<typeof setup> extends Promise<infer X> ? X : never} h
 * @param {"light"|"dark"} theme
 * @param {() => Promise<any>} body
 */
export async function inTheme(h, theme, body) {
  const was = await h.chrome(`
    const was = {};
    for (const p of ${JSON.stringify(THEME_PREFS)}) {
      was[p] = Services.prefs.prefHasUserValue(p) ? Services.prefs.getIntPref(p) : null;
    }
    Services.prefs.setIntPref("zen.view.window.scheme", ${theme === "dark" ? 0 : 1});
    Services.prefs.setIntPref("ui.systemUsesDarkTheme", ${theme === "dark" ? 1 : 0});
    await T.sleep(600);
    return was;
  `);
  try {
    return await body();
  } finally {
    await h.chrome(`
      for (const [p, v] of Object.entries(arg)) {
        if (v === null) Services.prefs.clearUserPref(p);
        else Services.prefs.setIntPref(p, v);
      }
      return true;
    `, was);
  }
}

/** What drawSnapshot paints under Zen's transparent window, per theme (as look.test.mjs). */
export const BACKDROP = { light: "white", dark: "#1e1e20" };
