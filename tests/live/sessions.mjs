// What a `claude -p` run leaves in ~/.claude though its session isn't kept
// (--no-session-persistence), removed after the run: the agents' runs and the
// judge's (run.mjs, judge.mjs). Each removes only the run's own files.
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The process's entry in ~/.claude/sessions, once the process has ended and only if it ran in cwd. */
export function removeStaleSessionFiles(pid, cwd) {
  const dir = join(homedir(), ".claude", "sessions");
  const file = join(dir, `${pid}.json`);
  if (!existsSync(file)) return 0;
  try {
    if (JSON.parse(readFileSync(file, "utf8")).cwd !== cwd) return 0;
    process.kill(pid, 0);
    return 0; // still running: not ours to touch
  } catch (error) {
    if (error.code !== "ESRCH") return 0;
  }
  const files = readdirSync(dir).filter((f) => f === `${pid}.json` || (f.startsWith(`${pid}.`) && f.endsWith(".key")));
  for (const f of files) rmSync(join(dir, f));
  return files.length;
}

/** The run's own folder in ~/.claude/projects, named after its working folder. */
export function removeRunProjectDir(cwd) {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The session's folder in ~/.claude/session-env, only if it's empty. */
export function removeEmptySessionEnv(sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId ?? "")) return false;
  try {
    rmdirSync(join(homedir(), ".claude", "session-env", sessionId)); // fails unless empty
    return true;
  } catch {
    return false;
  }
}
