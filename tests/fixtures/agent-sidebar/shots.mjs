// The user's shots of the real sidebar, drawn by Zen itself (drawSnapshot of
// the browser window, at 2x; no screen capture): Chat mode, Work mode, and
// Work with the directory open, in light and dark. Run once the scene is
// built (scene-build.js, then scene-ready.js says ready).
//   node tests/fixtures/agent-sidebar/shots.mjs --instance <name> <out dir> [scale]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { connect } = await import(new URL("../../../scripts/lib/rpc.mjs", import.meta.url).href);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { instance: { type: "string" } } });
const [dir, scale = "2"] = positionals;
mkdirSync(dir, { recursive: true });
const client = await connect(values.instance || process.env.ZENIUS_INSTANCE || "zen-sidebar", { callTimeout: 60000 });
const helpers = readFileSync(new URL("./scene.js", import.meta.url), "utf8");
const chrome = (code, arg) => client.call("dev.evalChrome", { code: `${helpers}\n${code}`, arg });
const shot = async name => {
  const url = await chrome(`
    await S.sleep(700);
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, arg.scale, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvas.toDataURL("image/png");`, { scale: Number(scale) });
  const path = join(dir, `${name}.png`);
  writeFileSync(path, Buffer.from(url.split(",")[1], "base64"));
  console.log(path);
};
for (const [theme, dark] of [["dark", 1], ["light", 0]]) {
  await chrome(`Services.prefs.setIntPref("ui.systemUsesDarkTheme", arg); await S.sleep(800);`, dark);
  await chrome(`win.ucAgentSidebar.closeDirectory(); win.ucAgentSidebar.setMode("chat"); win.gBrowser.selectedBrowser.focus();`);
  await shot(`chat-${theme}`);
  await chrome(`win.ucAgentSidebar.setMode("work"); win.gBrowser.selectedBrowser.focus();`);
  await shot(`work-${theme}`);
  await chrome(`win.ucAgentSidebar.toggleDirectory();`);
  await shot(`directory-${theme}`);
  await chrome(`win.ucAgentSidebar.closeDirectory();`);
}
await chrome(`Services.prefs.clearUserPref("ui.systemUsesDarkTheme");`);
client.close?.();
