// A scene with every state, live (chrome.mjs scene-build.js): the article in a
// tab with its chat, and six tasks across Needs you, Working and Done, on the
// mock agent (config.mjs), whose scenarios hold each state; serve.mjs must be
// up. With a real "claude" agent in the config, the tab's chat and the shown
// task run on it instead (the sidebar's shots), which takes the network. It
// starts everything and returns; scene-ready.js says when the scene is done.
const g = win.ucAgentSidebar, A = g.AgentService;
const W = "http://127.0.0.1:47231";
const REAL = A.config?.agents?.claude ? "claude" : "mock";
const tab = await S.openTab(`${W}/article.html`);
await S.openPanel();
g.setMode("chat");
const chat = g.conversationFor(tab);
A.setHarness(chat, REAL);
await S.ask(REAL === "mock" ? "SUMMARY What does this article say, in three points?" : "What does this article say, in three points?", chat);
const mock = (text, title) => {
  const c = A.createTask({ source: "new", harness: "mock" });
  A.send(c, { question: text });
  if (title) c.title = title;
  return c;
};
mock("Save that Gecko article for the weekend SCENARIO:weather");
mock("Summarize the PriorTune paper SUMMARY", "Paper summary");
mock("Track the Lumen X100 price at four shops SCENARIO:prices");
mock("Plan my Tokyo trip from my saved trips SCENARIO:trip");
mock("Find a hotel near Shibuya QUESTION", "Shibuya hotel");
win.gBrowser.selectedTab = tab;
// The shown task: started as the address bar's '>' starts one. On the mock it
// stays Working (SCENARIO:flights holds its last step).
const uid = await g.startWorkChat(
  `Compare the nonstop flights from SFO to Tokyo on ${W}/flights.html and tell me the cheapest.${REAL === "mock" ? " SCENARIO:flights" : ""}`,
  { source: "urlbar" }
);
return { uid, real: REAL };
