/* Agent Sidebar: what a task's menus offer and say. The panel's ⋯ menu
 * (panel.js) and All tasks' right-click menu (directory.sys.mjs) share it,
 * so both say the same of the same task.
 */

import { AgentService } from "./AgentService.sys.mjs";
import { PIN_CAP } from "./pins.sys.mjs";

export const TIPS = {
  pin: "Keeps the task in Pinned, at the top of All tasks.",
  unpin: "Takes the task out of Pinned.",
  pinFull: `Pinned holds ${PIN_CAP} tasks at most. Unpin one first.`,
  rename: "Rename the task",
  renameExternal: "Rename the task in the sidebar. The program that runs it keeps its own name.",
  unarchive: "Brings the task back to the list.",
};

/**
 * Can the task go to Archived, or come back? A listed task can, but one
 * another program drives only once it ended: the runtime's feed keeps it,
 * and while it runs it's that program's.
 */
export function archivable(conv) {
  if (conv?.kind !== "work" || !AgentService.isListed(conv)) {
    return false;
  }
  return !conv.external || !!conv.archivedAt || conv.task.state === "done";
}

/**
 * What Archive does, as the user asked to be told: the task goes to
 * Archived, a turn running stops (AgentService.archiveTask), and the task's
 * tabs stay. The tabs are the ones zenius lists for the task now (it
 * forgets a task only once its last tab closed), so with none open the tip
 * leaves them out.
 */
export function archiveTip(conv) {
  if (conv.archivedAt) {
    return TIPS.unarchive;
  }
  const stops = !conv.external && !!conv.busy;
  const tabs = !!AgentService.zenFrontTab(conv);
  return [`Moves the task to Archived, at the bottom of All tasks${stops ? ", and stops its agent" : ""}.`, tabs ? "Its tabs stay open." : ""]
    .filter(Boolean)
    .join(" ");
}
