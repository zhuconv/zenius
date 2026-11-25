// Cmd+T '>', headless. The user's keys are played
// through nsITextInputProcessor, so Zen's own shortcut and the URL bar's own
// input handling run, as for a person:
// - with a '>' prefix, 'Ask agent' is the first row, and Enter starts a work
//   chat with the rest of the text, without loading anything in a tab;
// - without '>', the address bar searches as usual, with no 'Ask agent'
//   row (since 0.1.8).
// The row is found by its dynamicType and providerName (hooks.mjs), never by
// its icon's file name, which zen-ux is changing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setup } from "./lib.mjs";

let h;
const created = [];

/** Cmd+T, then arg.text typed key by key; the URL bar's rows once its query is done. */
const TYPE_AND_READ = `
  const gb = win.gBrowser;
  win.focus();
  gb.selectedBrowser.focus();
  await T.sleep(100);
  T.press("t", [T.accel()]);
  await T.until(() => win.gURLBar.focused, 5000, "the URL bar's focus after Cmd+T");
  T.type(arg.text);
  await T.until(() => win.gURLBar.value === arg.text, 5000, "the typed text in the URL bar");
  await win.gURLBar.lastQueryContextPromise;
  await T.until(() => win.gURLBar.view.isOpen, 5000, "the URL bar's results");
  await T.sleep(200);
  return [...win.gURLBar.view.panel.querySelectorAll(".urlbarView-row")].filter(r => T.visible(r)).map(r => {
    const icon = [...r.querySelectorAll("img")].find(img => T.visible(img));
    return {
      provider: r.result?.providerName ?? null,
      heuristic: !!r.result?.heuristic,
      dynamicType: r.getAttribute("dynamicType"),
      text: r.textContent.replace(/\\s+/g, " ").trim().slice(0, 80),
      icon: !!icon && !!icon.getAttribute("src"),
    };
  });
`;

/** Closes the URL bar's view and any floating URL bar Cmd+T opened. */
const LEAVE = `
  for (let i = 0; i < 3 && (win.gURLBar.view.isOpen || win.gURLBar.focused); i++) {
    T.press("Escape");
    await T.sleep(150);
  }
  if (win.gURLBar.focused) win.gBrowser.selectedBrowser.focus();
  return true;
`;

before(async () => {
  h = await setup("urlbar");
});

after(async () => {
  if (h) {
    await h.chrome(`
      ${LEAVE.replace("return true;", "")}
      const A = T.glue()?.AgentService;
      for (const uid of arg) {
        const c = A?.tasks.get(uid);
        if (c) A.removeTask(c);
      }
      return true;
    `, created).catch(e => console.log(`# cleanup: ${e.message}`));
    await h.close();
  }
});

test("Cmd+T then '>': 'Ask agent' is the first row, and Enter starts a work chat", async () => {
  const question = "what does the test page say about tabs";
  const was = await h.chrome(`
    return { tasks: [...T.glue().AgentService.tasks.keys()], urls: win.gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec) };
  `);
  const rows = await h.chrome(TYPE_AND_READ, { text: `> ${question}` });
  const all = JSON.stringify(rows);
  assert.ok(rows.length >= 1, "no row showed for '>'");
  assert.equal(rows[0].provider, "ZeniusAskAgent", `the first row: ${all}`);
  assert.equal(rows[0].dynamicType, "zeniusAskAgent", `the first row: ${all}`);
  assert.ok(rows[0].heuristic, `the first row isn't the one Enter picks: ${all}`);
  assert.match(rows[0].text, /Ask agent/i, `the first row: ${all}`);
  assert.ok(rows[0].icon, `the first row shows no icon: ${all}`);

  const r = await h.chrome(`
    T.press("Enter");
    const g = T.glue(), known = new Set(arg.tasks);
    const uid = await T.until(() => [...g.AgentService.tasks.keys()].find(k => !known.has(k)), 10000, "a new work chat");
    await T.until(() => {
      const doc = T.panelDoc();
      return win.SidebarController.isOpen && win.SidebarController.currentID === H.SIDEBAR_ID &&
        doc?.documentElement.getAttribute(H.PANEL.mode) === "work";
    }, 10000, "the sidebar, in Work");
    await T.sleep(500);
    const conv = g.AgentService.tasks.get(uid);
    return {
      uid,
      question: conv.messages.find(m => m.role === "user")?.text ?? null,
      shown: g.currentTask?.uid === uid,
      urlbarOpen: win.gURLBar.view.isOpen,
      urls: win.gBrowser.tabs.map(t => t.linkedBrowser.currentURI.spec),
    };
  `, was);
  created.push(r.uid);
  assert.equal(r.question, question, "the work chat didn't start with the text after '>'");
  assert.ok(r.shown, "the sidebar doesn't show the new work chat");
  assert.equal(r.urlbarOpen, false, "the URL bar's results stayed open");
  const loaded = r.urls.filter(u => !was.urls.includes(u) && /^https?:/.test(u));
  assert.deepEqual(loaded, [], "Enter loaded a page instead of only starting a work chat");
  await h.chrome(LEAVE);
});

test("Without '>': the search stays Zen's, and no row is 'Ask agent'", async () => {
  try {
    const rows = await h.chrome(TYPE_AND_READ, { text: "weather in tokyo" });
    const all = JSON.stringify(rows);
    assert.ok(rows.length >= 1, `no rows: ${all}`);
    assert.ok(rows[0].heuristic, `the first row isn't the URL bar's own (search) row: ${all}`);
    const ours = rows.filter(r => r.dynamicType === "zeniusAskAgent" || /^ZeniusAskAgent/.test(r.provider ?? "") || /Ask agent/i.test(r.text));
    assert.deepEqual(ours, [], `a row of the sidebar's without '>': ${all}`);
  } finally {
    // Leave without searching, so nothing loads from the network.
    await h.chrome(LEAVE);
  }
});
