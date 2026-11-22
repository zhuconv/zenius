/* Agent Sidebar: the agents it offers when the user has no config.json of
 * their own (the manager's release blocker, 2026-11-21: on a fresh install
 * the sidebar offered no agent). zen-ux wrote it, with zen-sidebar's notes
 * on the config's shape and the adapters, and zen-sdk's installer.
 *
 * zenius's installer puts the two ACP adapters in ~/.zenius/agents, pinned
 * by runtime/agents/package-lock.json (npm ci --omit=dev --omit=optional
 * --ignore-scripts), with `node` there a link to the user's Node 22.3 or
 * later. The adapters run the user's own CLIs, so the user's sign-in and
 * version apply: claude-agent-acp through CLAUDE_CODE_EXECUTABLE, codex-acp
 * through CODEX_PATH (which also turns on its lean settings). The SDKs'
 * bundled CLIs are optional packages the installer leaves out, so an agent
 * whose CLI isn't found isn't offered.
 *
 * AgentService.loadConfig uses these only when the user's own config.json
 * doesn't exist and uc.agent-sidebar.config is unset ("builtin" asks for
 * them in tests): a config of the user's own always wins, one that can't be
 * read fails as before, and so does a missing path the pref names, so a
 * test's or a dev Zen's never runs the user's Claude Code. Nothing here
 * writes a file. A Zen started from the Dock has a
 * bare PATH, so every command is an absolute path, and the agent's PATH puts
 * Node's folder and the CLI's first.
 */

/** Test-only: the adapters' folder instead of ~/.zenius/agents. */
const PREF_ROOT = "uc.agent-sidebar.builtin-root";
/** Test-only: the folders to look in for the CLIs, ":"-separated, instead of the usual ones. */
const PREF_SEARCH = "uc.agent-sidebar.builtin-search";

const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    cli: "claude",
    variable: "CLAUDE_CODE_EXECUTABLE",
    adapter: ["node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"],
  },
  {
    id: "codex",
    name: "Codex",
    cli: "codex",
    variable: "CODEX_PATH",
    adapter: ["node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"],
  },
];

/** Where the system's own commands are, after the agent's folders. */
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function home() {
  return Services.dirsvc.get("Home", Ci.nsIFile).path;
}

/** The adapters' folder: ~/.zenius/agents. */
export function agentsFolder() {
  return Services.prefs.getStringPref(PREF_ROOT, "") || PathUtils.join(home(), ".zenius", "agents");
}

/** `~/…` for a path in the home folder, as the user would type it. */
function tilde(path) {
  const h = home();
  return path === h || path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

/** Whether `path` is a file anyone may run, through a link too (a dangling one isn't). */
async function runnable(path) {
  try {
    const info = await IOUtils.stat(path);
    return info.type === "regular" && (info.permissions & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The folders where Claude Code's and Codex's installers put their command, in order. */
async function searchFolders() {
  const set = Services.prefs.getStringPref(PREF_SEARCH, "");
  if (set) {
    return set.split(":").filter(Boolean);
  }
  const h = home();
  // npm's global folder under each nvm Node, the newest first.
  let nvm = [];
  try {
    const versions = PathUtils.join(h, ".nvm", "versions", "node");
    nvm = (await IOUtils.getChildren(versions))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map(dir => PathUtils.join(dir, "bin"));
  } catch {}
  const fromPath = (Services.env.get("PATH") || "").split(":").filter(dir => dir.startsWith("/"));
  return [
    ...new Set([
      // Claude Code's own installer, and its older local install.
      PathUtils.join(h, ".local", "bin"),
      PathUtils.join(h, ".claude", "local"),
      // Homebrew, and npm's global folder with Homebrew's or the system's Node.
      "/opt/homebrew/bin",
      "/usr/local/bin",
      PathUtils.join(h, ".npm-global", "bin"),
      PathUtils.join(h, ".volta", "bin"),
      PathUtils.join(h, ".bun", "bin"),
      ...nvm,
      ...fromPath,
    ]),
  ];
}

async function findCommand(name, folders) {
  for (const dir of folders) {
    const path = PathUtils.join(dir, name);
    if (await runnable(path)) {
      return path;
    }
  }
  return null;
}

/** The folder Node's link points into, for the agent's PATH (an npm-installed CLI runs `env node`). */
function realFolder(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.normalize();
    return file.parent?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * The agents this machine can run without a config.json, as config.json
 * would name them, and what's missing.
 *
 * - config: `{default, agents}` (the shape AgentService reads), or null when
 *   none can run;
 * - found: per agent, its CLI and adapter (null where missing);
 * - missing: one line saying what's missing when none can run, else null;
 * - folder: the adapters' folder.
 *
 * @returns {Promise<{config: object|null, found: Record<string, {cli: string|null, adapter: string|null}>, node: string|null, missing: string|null, folder: string}>}
 */
export async function builtinAgents() {
  const folder = agentsFolder();
  const node = PathUtils.join(folder, "node");
  const hasNode = await runnable(node);
  const folders = await searchFolders();
  const agents = {};
  const found = {};
  for (const spec of AGENTS) {
    const cli = await findCommand(spec.cli, folders);
    const adapter = PathUtils.join(folder, ...spec.adapter);
    const hasAdapter = await IOUtils.exists(adapter).catch(() => false);
    found[spec.id] = { cli, adapter: hasAdapter ? adapter : null };
    if (cli && hasAdapter && hasNode) {
      const path = [folder, realFolder(node), PathUtils.parent(cli), ...SYSTEM_PATH].filter(Boolean);
      agents[spec.id] = {
        name: spec.name,
        command: node,
        args: [adapter],
        env: { [spec.variable]: cli, PATH: [...new Set(path)].join(":") },
      };
    }
  }
  const ids = Object.keys(agents);
  if (ids.length) {
    return { config: { default: ids[0], agents }, found, node: hasNode ? node : null, missing: null, folder };
  }
  // One line: what the user can do about each missing piece.
  const parts = [];
  const withCli = AGENTS.filter(spec => found[spec.id].cli);
  if (!withCli.length) {
    parts.push("install Claude Code (claude) or Codex (codex)");
  }
  if (!Object.values(found).some(f => f.adapter)) {
    parts.push(`run zenius's installer again, for its agent adapters in ${tilde(folder)}`);
  } else if (!hasNode) {
    parts.push(`run zenius's installer again, since its link to Node (${tilde(node)}) is missing or broken`);
  } else if (withCli.length) {
    // A CLI, and adapters, but not that CLI's.
    parts.push(`run zenius's installer again, for the adapter of ${withCli.map(spec => spec.name).join(" and ")} in ${tilde(folder)}`);
  }
  return { config: null, found, node: hasNode ? node : null, missing: `No agent to offer: ${parts.join("; ")}.`, folder };
}
