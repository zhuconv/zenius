// The probe's inspection actor in a tab's content process (probe.sys.mjs,
// inspectTabs): which of zenius's window actors exist for the document, the
// listeners on the tab's chrome event handler (where JSWindowActor events
// listen), the window and the document, and the zenius modules this process
// loaded. "move" sends the document one mouse move, as the user's would.
export class I4ProbeChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    const win = this.contentWindow;
    if (name === "move") {
      try {
        win.synthesizeMouseEvent(
          "mousemove",
          20,
          20,
          { identifier: win.windowUtils.DEFAULT_MOUSE_POINTER_ID, button: 0, buttons: 0, clickCount: 0, modifiers: 0, inputSource: 1 },
          { isDOMEventSynthesized: false, isWidgetEventSynthesized: false, isAsyncEnabled: false }
        );
        return { moved: true };
      } catch (e) {
        return { moved: false, error: e.message };
      }
    }
    if (name !== "inspect") {
      return null;
    }
    const counts = target => {
      const out = {};
      if (!target) {
        return out;
      }
      for (const info of Services.els.getListenerInfoFor(target)) {
        const key = `${info.type}${info.capturing ? " capture" : ""}${info.inSystemEventGroup ? " system" : ""}`;
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    return {
      url: this.document?.documentURI ?? "",
      live: data.names.filter(n => {
        try {
          return !!this.manager.getExistingActor(n);
        } catch {
          return false;
        }
      }),
      chromeHandler: counts(this.docShell?.chromeEventHandler),
      window: counts(win),
      document: counts(this.document),
      modules: Cu.loadedESModules.filter(u => u.startsWith("chrome://userscripts/") && !u.includes("/i4/")),
    };
  }
}
