// The sign of the observe layer's mute on an agent tab (ui/muted.sys.mjs and
// zenius-ux.css): a muted-speaker badge on the tab's icon and a tooltip line,
// once a page the user can't see has played sound, gone once they see it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prelude, setup } from "./lib.mjs";

let h;
let space;
let P;
let userView;

// A short silent WAV (8 kHz, 0.2 s): playing it counts as sound.
const SILENT_WAV = (() => {
  const samples = 1600;
  const b = Buffer.alloc(44 + samples);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return `data:audio/wav;base64,${b.toString("base64")}`;
})();

before(async () => {
  h = await setup();
  userView = await h.call("dev.viewState");
  ({ id: space } = await h.createSpace({ name: "UI muted test" }));
  await h.call("page.goto", { space, page: "p1", url: `${h.base}/` });
  await h.call("page.evaluate", {
    space,
    page: "p1",
    isFunction: false,
    fn: `(() => {
      const b = document.createElement("button");
      b.id = "play";
      b.textContent = "play";
      // An <audio> in the page: the observe layer hears its "playing" event.
      const audio = document.createElement("audio");
      audio.src = ${JSON.stringify(SILENT_WAV)};
      b.onclick = () => audio.play().then(() => (window.__r = "playing"), e => (window.__r = "ERR " + e.name));
      document.body.append(b, audio);
      return true;
    })()`,
  });
  P = `${prelude(space)}
    const Pages = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/pages.sys.mjs");
    const { MUTED_TOOLTIP } = ChromeUtils.importESModule("chrome://userscripts/content/zenius/ui/muted.sys.mjs");
    const userWs = ${JSON.stringify(userView.windows[0].activeWorkspace)};
    const badge = () => {
      const stack = tab.querySelector(".tab-icon-stack");
      const cs = win.getComputedStyle(stack, "::after");
      return { content: cs.content, width: cs.width, image: /tab-audio-muted/.test(cs.backgroundImage), events: cs.pointerEvents, stack: win.getComputedStyle(stack).display };
    };
    const tooltipSays = () => gBrowser.getTabTooltip(tab).includes(MUTED_TOOLTIP);
  `;
});

after(async () => {
  await h?.chrome(`${P}
    tab.removeAttribute("zenius-muted-sound");
    if (gZenWorkspaces.activeWorkspace !== userWs) await gZenWorkspaces.changeWorkspaceWithID(userWs);
  `).catch(() => {});
  await h?.close();
});

test("zenius-muted-sound puts a muted badge on the tab's icon and a line in its tooltip; without it, neither", async () => {
  const out = await h.chrome(`${P}
    tab.setAttribute("zenius-muted-sound", "");
    const on = { badge: badge(), tooltip: tooltipSays() };
    tab.removeAttribute("zenius-muted-sound");
    const off = { badge: badge(), tooltip: tooltipSays() };
    return { on, off };
  `);
  assert.deepEqual(out.on, { badge: { content: '""', width: "11px", image: true, events: "none", stack: "grid" }, tooltip: true });
  assert.equal(out.off.badge.content, "none");
  assert.equal(out.off.tooltip, false);
});

test("with the observe layer's mute: a page the user can't see plays sound, the badge shows, and goes when they look", async () => {
  await h.call("page.click", { space, page: "p1", target: "#play" });
  const out = await h.chrome(`${P}
    await until(() => tab.hasAttribute("zenius-muted-sound"), 5000);
    const hidden = { muted: tab.hasAttribute("zenius-muted"), badge: badge().content !== "none", tooltip: tooltipSays() };
    // The user opens the agent's page.
    Pages.landOn(tab);
    await gZenWorkspaces.changeWorkspaceWithID(rec.uuid);
    await until(() => gBrowser.selectedTab === tab);
    await until(() => !tab.hasAttribute("zenius-muted-sound"), 5000);
    const seen = { muted: tab.hasAttribute("zenius-muted"), badge: badge().content !== "none", tooltip: tooltipSays() };
    await gZenWorkspaces.changeWorkspaceWithID(userWs);
    return { hidden, seen };
  `);
  assert.deepEqual(out.hidden, { muted: true, badge: true, tooltip: true });
  assert.deepEqual(out.seen, { muted: false, badge: false, tooltip: false });
});

test("the user's view ends as it started", async () => {
  const view = await h.call("dev.viewState");
  assert.equal(view.windows[0].activeWorkspace, userView.windows[0].activeWorkspace);
  assert.equal(view.windows[0].selectedTab, userView.windows[0].selectedTab);
});
