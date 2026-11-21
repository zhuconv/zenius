// The directory's tasks, written into a profile before its Zen starts
// (AgentService reads agent-sidebar-tasks.json from the profile once, at
// startup). Every state but Working, which needs a live run (the mock's
// SCENARIO:flights holds its last step running). Ages are fixed relative to
// the time this runs, so run it just before the start.
//   node tests/fixtures/agent-sidebar/fixture-tasks.mjs <profile dir>
//
//   Needs you  Shibuya hotel    its answer ends with a question
//   Needs you  Trip planner     Zen quit while its agent worked (saved busy)
//   Done       Weekend reading  finished, with the zenius steps it took
//   Done       Paper summary    answered
//   Done       Camera price     stopped by the user
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv[2];
if (!profile) {
  console.error("usage: fixture-tasks.mjs <profile dir>");
  process.exit(2);
}
const now = Date.now();
const ago = minutes => now - minutes * 60000;
let n = 0;
const user = text => ({ role: "user", text, selection: "", files: [], page: null, attached: null, source: "new", after: null });
const answer = text => ({ role: "assistant", text, state: "done", session: null, messageId: null });
const step = (zen, text, status = "completed") => ({
  role: "tool", id: `fixture-${++n}`, kind: "other", status, step: text, zen, cut: false, args: null, rawTitle: "", detail: "",
});
const task = (title, minutes, messages, extra = {}) => ({
  uid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  title, named: true, source: "new", harness: "mock",
  createdAt: ago(minutes + 1), task: { state: "done", text: "", since: ago(minutes) },
  zen: null, stopped: false, busy: false, interrupted: false, session: null,
  instructed: true, instructedBy: "systemPrompt", lineage: [], lastUsed: ago(minutes), messages, ...extra,
});
const tasks = [
  task("Shibuya hotel", 3, [user("Find a hotel near Shibuya"), answer("I found two hotels under $200 near the station. Do you want the quieter one or the cheaper one?")]),
  task("Trip planner", 12, [user("Plan my Tokyo trip from my saved trips"), step("open", "Open 127.0.0.1:47231/signin.html")], { busy: true }),
  task("Weekend reading", 62, [
    user("Save that Gecko article for the weekend"),
    step("open", "Open 127.0.0.1:47231/article.html"),
    step("read_page", "Read the page"),
    step("finish", "Finish, keeping 1 tab\n  \"Gecko's sandboxes, explained\" — 127.0.0.1:47231"),
    answer("Saved the article for the weekend: it's open in your Agents space."),
  ]),
  task("Paper summary", 185, [user("Summarize the PriorTune paper"), answer("PriorTune meta-tunes hyperparameters on synthetic priors alone.")]),
  task("Camera price", 300, [user("What does the Lumen X100 cost?"), step("open", "Open 127.0.0.1:47231/shop.html", "failed")], { stopped: true }),
];
const path = join(profile, "agent-sidebar-tasks.json");
// The file keeps tasks in the order they were made, the oldest first.
writeFileSync(path, JSON.stringify({ version: 1, tasks: tasks.reverse() }));
console.log(path);
