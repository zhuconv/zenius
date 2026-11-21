// After scene-build.js (chrome.mjs scene-ready.js, until ready): true once
// every task stands where the scene wants it; then the mock's keywords leave
// the questions and the ages move a few minutes on, as a real directory would
// show them.
const g = win.ucAgentSidebar, A = g.AgentService;
const tasks = A.taskList();
const REAL = A.config?.agents?.claude ? "claude" : "mock";
const by = re => tasks.find(c => re.test(c.messages.find(m => m.role === "user")?.text ?? ""));
const want = {
  weather: [by(/SCENARIO:weather|weekend/), "done"],
  paper: [by(/PriorTune/), "done"],
  prices: [by(/Lumen X100 price/), "working"],
  trip: [by(/saved trips/), "needs"],
  hotel: [by(/Shibuya/), "needs"],
  flights: [by(/flights from SFO/), REAL === "mock" ? "working" : "done"],
};
const chat = g.conversationFor(win.gBrowser.selectedTab);
const pending = Object.entries(want).filter(([, [c, state]]) => !c || c.task.state !== state).map(([k]) => k);
if (chat.busy || !chat.messages.some(m => m.role === "assistant")) pending.push("chat");
for (const key of ["prices", "flights"]) {
  const c = want[key][0];
  if (c && want[key][1] === "working" && !c.messages.some(m => m.role === "tool" && m.status === "completed")) pending.push(`${key}-step`);
}
if (pending.length) return { ready: false, pending };
for (const c of [...A.tasks.values(), chat]) {
  for (const m of c.messages) {
    if (m.role === "user" && /SCENARIO:|SUMMARY|QUESTION/.test(m.text)) {
      m.text = m.text.replace(/\s*SCENARIO:\w+|\s*\b(SUMMARY|QUESTION)\b\s*/g, " ").trim();
      c.touch(m);
    }
  }
}
const ago = min => Date.now() - min * 60000;
want.weather[0].task.since = ago(62);
want.paper[0].task.since = ago(185);
want.prices[0].task.since = ago(5);
want.trip[0].task.since = ago(0.2);
want.hotel[0].task.since = ago(3);
want.flights[0].task.since = ago(1);
A.tasksChanged(null, { now: true });
g.showTask(want.flights[0].uid);
g.setMode("chat");
return { ready: true, tasks: A.taskList().map(c => [c.title, c.task.state]) };
