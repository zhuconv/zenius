// Chrome helpers for dev/zs eval -f: `S` holds them. Loaded before each scene.
const S = {
  sleep: ms => new Promise(r => win.setTimeout(r, ms)),
  async until(fn, ms = 10000) {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try { v = await fn(); } catch {}
      if (v || Date.now() > end) return v;
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
