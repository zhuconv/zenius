// The tab's sign of zen-observe's mute (observe/audio.sys.mjs). An agent tab
// the user can't see is muted through its MediaController, which leaves the
// tab's own speaker button alone. Once its page has played sound in that
// time, the tab has the attribute zenius-muted-sound. zenius-ux.css draws a
// muted-speaker badge on its icon; this adds a line to its tooltip. Both go
// when the user looks at the tab, which unmutes it.

export const MUTED_TOOLTIP = "Sound muted while you can't see this tab";
const WRAPPED = Symbol("zenius.mutedTooltip");

/** @param {Window} win  a browser window */
export function watchMutedTabs(win) {
  const gb = win.gBrowser;
  if (typeof gb?.getTabTooltip !== "function" || gb.getTabTooltip[WRAPPED]) {
    return;
  }
  const original = gb.getTabTooltip;
  const getTabTooltip = function (tab, ...rest) {
    const text = original.call(this, tab, ...rest);
    return tab?.hasAttribute?.("zenius-muted-sound") ? `${text}\n${MUTED_TOOLTIP}` : text;
  };
  getTabTooltip[WRAPPED] = true;
  gb.getTabTooltip = getTabTooltip;
}
