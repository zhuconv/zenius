/* Agent Sidebar, its entry points for other scripts: plain functions behind
 * one module URL,
 *   chrome://userscripts/content/agent-sidebar/AgentSidebar.sys.mjs
 * so the address bar's '>' (agent-urlbar) and tests call the sidebar without
 * reaching into a window global. agent-sidebar.uc.js registers each browser
 * window's sidebar here as the window opens, and removes it as it closes.
 *
 * docs/agent-sidebar.md lists these with the panel's and the directory's
 * stable ids, which tests go by.
 */

/** @type {WeakMap<Window, object>} each window's sidebar (its window.ucAgentSidebar) */
const sidebars = new WeakMap();

/**
 * agent-sidebar.uc.js, when a browser window's sidebar is ready.
 *
 * @param {Window} win
 * @param {object} sidebar  the window's window.ucAgentSidebar
 */
export function registerSidebar(win, sidebar) {
  sidebars.set(win, sidebar);
}

/** @param {Window} win */
export function unregisterSidebar(win) {
  sidebars.delete(win);
}

/**
 * Start a work chat: a new task, with `text` as its first request. The
 * window's sidebar opens in Work mode on it, and the user stays on their
 * page while the agent works in the Agents space. With no text, the new
 * task waits in the sidebar for the user to type it.
 *
 * Resolves as soon as the sidebar shows the task, not when the agent
 * answers, to the task's id: its uid, which the directory's row carries as
 * data-task and AgentService.tasks is keyed by.
 *
 * @param {Window} win  a browser window
 * @param {object} [options]
 * @param {string} [options.text]  the request
 * @param {"urlbar"|"new"} [options.source]  where it came from: "urlbar"
 *   puts "from the address bar" over the request
 * @returns {Promise<string>} the task's id
 */
export async function startWorkChat(win, { text = "", source = "urlbar" } = {}) {
  const sidebar = sidebars.get(win);
  if (!sidebar) {
    throw new Error("This window has no agent sidebar");
  }
  return sidebar.startWorkChat(text, { source });
}
