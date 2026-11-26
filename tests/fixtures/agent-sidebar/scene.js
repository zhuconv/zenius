// Chrome helpers for dev/zs eval -f: `S` holds them. Loaded before each scene.
const S = {
  sleep: ms => new Promise(r => win.setTimeout(r, ms)),
  // fn()'s first truthy value, asked every 50 ms (a throw counts as no).
  // At `ms` it throws, naming fn, so a wait that never came fails where it
  // stood instead of letting the scene go on. A wait meant to end either
  // way says so at its call, { soft: true }, and gets fn()'s last value.
  async until(fn, ms = 10000, { soft = false } = {}) {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try { v = await fn(); } catch {}
      if (v) return v;
      if (Date.now() > end) {
        if (soft) return v;
        throw new Error(`S.until: nothing after ${ms} ms from ${String(fn).replace(/\s+/g, " ").slice(0, 240)}`);
      }
      await S.sleep(50);
    }
  },
  panelDoc: () => win.document.getElementById("sidebar")?.contentDocument,
  async openTab(url) {
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
    await S.until(() => tab.linkedBrowser.currentURI.spec === url && !tab.hasAttribute("busy"));
    await S.sleep(300);
    return tab;
  },
  async openPanel() {
    if (!(win.SidebarController.isOpen && win.SidebarController.currentID === "viewAgentSidebar")) {
      await win.SidebarController.show("viewAgentSidebar");
    }
    await S.until(() => win.ucAgentSidebar.panel);
    return win.ucAgentSidebar.panel;
  },
  async ask(text, conv) {
    const g = win.ucAgentSidebar;
    conv ??= g.mode === "work" ? g.currentTask : g.conversationFor(win.gBrowser.selectedTab);
    await g.submit(conv, { question: text, selection: "", attachments: [] });
    return conv;
  },
  state: conv => ({ kind: conv.kind, title: conv.title, task: conv.task, zen: conv.zen, busy: conv.busy,
    messages: conv.messages.map(m => ({ role: m.role, text: m.text?.slice(0, 80), step: m.step, status: m.status, zen: m.zen })) }),
};
