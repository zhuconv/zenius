// browser.* and profiles.* methods (zen-core).

import { RUNTIME_VERSION, zenVersion } from "chrome://userscripts/content/zenius/modules/util.sys.mjs";
import { listProfiles } from "chrome://userscripts/content/zenius/modules/spaces.sys.mjs";
import { hostWindow } from "chrome://userscripts/content/zenius/modules/windows.sys.mjs";
import { i5Status } from "chrome://userscripts/content/zenius/observe/webcontent.sys.mjs";

// Gate classes (SPI.md, "Dispatch"): access for the control gate (I3), i5
// for the web-content gate (I5).
// None of these names a space or acts on one: no control gate applies.
export const access = {
  "browser.version": "none",
  "browser.health": "none",
  "browser.methods": "none",
  "profiles.list": "none",
};

export const i5 = {
  "browser.version": "none",
  "browser.health": "none",
  "browser.methods": "none",
  "profiles.list": "none",
};

export const methods = {
  "browser.version": async ctx => ({
    zenVersion: zenVersion(),
    runtimeVersion: RUNTIME_VERSION,
    updateAvailable: false,
    install: ctx.service.install ?? null,
  }),

  // webdriver: what pages would see as navigator.webdriver (true while
  // Marionette or the Remote Agent runs), read from a browser window so
  // zenius doctor can check I4 without opening a page. i5: zen-observe's
  // I5 status, for doctor's check of the agent boundary. strayAgentsSpaces:
  // Spaces zenius made as its Agents Space that a start left as they were,
  // since they hold tabs, for doctor to list. dnsDisableIPv6: the one pref
  // install.sh sets, the user's choice (no IPv6 lookups), as Zen has it now.
  "browser.health": async ctx => ({
    ok: true,
    windows: ctx.spaces.windowCount,
    spaces: ctx.spaces.refresh().length,
    pid: Services.appinfo.processID,
    webdriver: !!hostWindow()?.navigator.webdriver,
    i5: await i5Status(ctx.service.i5Hooks()),
    strayAgentsSpaces: ctx.spaces.strayAgentsSpaces(),
    dnsDisableIPv6: Services.prefs.getBoolPref("network.dns.disableIPv6", false),
  }),

  "browser.methods": async ctx => ({ methods: ctx.service.methodNames }),

  // The default profile plus Zen's containers; a space's profileId picks
  // the container its tabs open in.
  "profiles.list": async () => ({ profiles: listProfiles() }),
};
