// ui.* methods (zen-ux). Loading this module also starts the UI controller
// (takeover detector, badges, notices) and the per-Space clipboard for the
// service.

import { ZeniusService } from "chrome://userscripts/content/zenius/modules/service.sys.mjs";
import {
  CURSOR_KINDS,
  moveCursor,
} from "chrome://userscripts/content/zenius/ui/cursor.sys.mjs";
import { ZeniusUI } from "chrome://userscripts/content/zenius/ui/index.sys.mjs";
import { startClipboard } from "chrome://userscripts/content/zenius/clipboard/index.sys.mjs";
import { startSystemUi } from "chrome://userscripts/content/zenius/ui/systemui/index.sys.mjs";
import { keepView, stripCanScroll } from "chrome://userscripts/content/zenius/ui/viewkeeper.sys.mjs";
import { sidebarStatus } from "chrome://userscripts/content/zenius/ui/sidebarstatus.sys.mjs";

ZeniusUI.start(ZeniusService);
// The Space's private clipboard for page-initiated copies (zen-ux).
startClipboard(ZeniusService);
startSystemUi(ZeniusService);
// zen-core's tab code wraps every agent change to a strip in keepView, and
// asks stripCanScroll where to put a new page (SPEC §3.5).
ZeniusService.pages.keepView = keepView;
ZeniusService.pages.stripCanScroll = stripCanScroll;

// Gate classes: access for the control gate (I3), i5 for the web-content
// gate (I5).
export const access = {
  "ui.cursor": "mutate",
  "ui.state": "none",
  "ui.sidebarStatus": "none",
};

export const i5 = {
  "ui.cursor": "none",
  "ui.state": "none",
  "ui.sidebarStatus": "none",
};

export const methods = {
  // {space, page, x, y, label?, kind?} → {ok, visible, animated}
  "ui.cursor": async (ctx, params) => {
    const { tab } = ctx.resolvePage(params);
    const x = params.x;
    const y = params.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ctx.ZenError("ZEN_INVALID_ARGUMENT", "ui.cursor needs numeric x and y (viewport CSS px)");
    }
    if (params.label !== undefined && typeof params.label !== "string") {
      throw new ctx.ZenError("ZEN_INVALID_ARGUMENT", "ui.cursor label must be a string");
    }
    const kind = params.kind ?? "move";
    if (!CURSOR_KINDS.has(kind)) {
      throw new ctx.ZenError("ZEN_INVALID_ARGUMENT", `ui.cursor kind must be one of ${[...CURSOR_KINDS].join(", ")}`);
    }
    const r = await moveCursor(tab, { x, y }, { label: params.label, kind });
    // Like a pointer action: the user may have clicked during the flight, so
    // pass the control gate again after the move (SPI "UI hooks").
    await ctx.gate();
    return { ok: true, visible: r.visible, animated: r.animated };
  },

  // {space} → what the user sees of the Space: badge, open prompt, control
  // notice. For tests and tools.
  "ui.state": async (ctx, params) => ZeniusUI.describe(ctx.resolveSpace(params)),
  // For zen-sdk's doctor: whether zenius's agent sidebar is the one running,
  // and how it started in each window.
  "ui.sidebarStatus": async () => sidebarStatus(),
};
