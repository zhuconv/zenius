// `zenius doctor`: checks Zen, the zenius install in its profile (SPI.md
// "Install layout") and the running instance, and explains each problem.
//
// It only reads. It never writes a file, never edits Zen.app and never
// restarts Zen: putting back what a Zen update deleted, installing, and
// restarting are the user's to do, so doctor says how instead.

import { isProcessAlive, readInstanceRecord, zeniusHome, type InstanceRecord } from "./instance.ts";
import { fs, inSandbox, os, path, url } from "./node.ts";
import { PROTOCOL_VERSION, RpcClient, type Hello } from "./rpc.ts";
import { VERSION } from "./version.ts";
import { SANDBOX_BLOCKED_NEXT } from "./error-guide.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type Check = {
  id: "cli" | "zen" | "autoconfig" | "profile" | "loader" | "runtime" | "instance" | "sidebar" | "mcp" | "daily" | "boundary" | "dns" | "pagecode";
  title: string;
  status: CheckStatus;
  summary: string;
  /** What the problem means and what to do about it, one sentence or command per line. */
  details: string[];
};

export type DoctorReport = { instance: string; ok: boolean; sandboxed?: boolean; checks: Check[] };

export type DoctorOptions = {
  instance: string;
  /** --profile: the profile to check instead of the one doctor finds. */
  profile?: string;
  /** --app: Zen.app, Zen's directory, or the zen binary. */
  app?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** macOS's Applications folder (/Applications), where doctor looks for Zen.app before ~/Applications. */
  applications?: string;
  /**
   * The zenius checkout, or the copy scripts/install-cli.sh made, that this
   * CLI runs from; its vendored fx-autoconfig is the reference copy.
   */
  checkoutRoot?: string;
  /** Whether this Node runs TypeScript sources (process.features.typescript). */
  typescript?: boolean;
  /** The executable of a running process. */
  executableOf?: (pid: number) => string | undefined;
  /** pid of a Zen that holds `profileDir`, if one runs. */
  zenProcessFor?: (profileDir: string) => number | undefined;
  /**
   * Whether this CLI runs in the sandboxed launcher (scripts/install-cli.sh
   * --sandbox), which lets it reach no Zen file or process. By default,
   * whether Node's permission model is on.
   */
  sandboxed?: boolean;
  /** How long `zenius mcp` gets to list its tools (tests shorten it). */
  mcpTimeoutMs?: number;
};

const TESTED_ZEN = "1.24.2b";
const TESTED_GECKO = 160;
const FX_AUTOCONFIG = "fx-autoconfig 0.10.16";
const CALL_TIMEOUT_MS = 3000;
/** How long the sidebar's `zenius mcp` gets to answer initialize and tools/list. */
const MCP_TIMEOUT_MS = 10_000;

type Resolved = Required<Omit<DoctorOptions, "profile" | "app" | "checkoutRoot" | "typescript">> & {
  typescript: boolean;
  profile?: string;
  app?: string;
  checkoutRoot?: string;
  dev: boolean;
};

type App = { root: string; resources: string; how: string; version?: string; gecko?: string; bundle: boolean };

type Live = {
  hello?: Hello;
  version?: { zenVersion?: string; runtimeVersion?: string; install?: { commit?: unknown; installedAt?: unknown } | null };
  health?: {
    pid?: number;
    spaces?: number;
    windows?: number;
    webdriver?: boolean;
    i5?: unknown;
    strayAgentsSpaces?: { uuid?: string; name?: string; tabs?: number; position?: number }[];
    /** network.dns.disableIPv6 in the running Zen. */
    dnsDisableIPv6?: boolean;
  };
  methods?: string[];
  /**
   * zen-ux's ui.sidebarStatus: what the running Zen knows of zenius's sidebar; config is "found", "missing",
   * "none", or "builtin" when there's no config file and its built-in agents can run (builtin says which).
   */
  sidebar?: { loaded?: boolean; windows?: number; config?: string; configPath?: string; error?: string; builtin?: SidebarBuiltin };
  error?: string;
  /** The connect's errno, such as EPERM when a sandbox around doctor blocks the socket. */
  errno?: string;
};

type InstallJson = { runtimeVersion?: unknown; protocol?: unknown; commit?: unknown; installedAt?: unknown; profile?: unknown };

/** 1st, 2nd, 3rd, 4th, ..., 11th, 12th, 13th, 21st, ... */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const o: Resolved = {
    ...options,
    env: options.env ?? process.env,
    platform,
    home,
    applications: options.applications ?? "/Applications",
    checkoutRoot: options.checkoutRoot ?? defaultCheckoutRoot(),
    executableOf: options.executableOf ?? ((pid) => executableOf(pid, platform)),
    zenProcessFor: options.zenProcessFor ?? ((dir) => zenProcessFor(dir, platform, home)),
    typescript: options.typescript ?? Boolean(process.features.typescript),
    sandboxed: options.sandboxed ?? inSandbox(),
    mcpTimeoutMs: options.mcpTimeoutMs ?? MCP_TIMEOUT_MS,
    // The daily Zen is instance "default" (SPI.md); every other name is a dev profile.
    dev: options.instance !== "default",
  };
  const record = readInstanceRecord(o.instance, o.env);
  // In the sandbox Zen's process is out of sight (bubblewrap gives the CLI a
  // PID namespace of its own), so it would always look gone.
  const alive = !o.sandboxed && isProcessAlive(record?.pid);
  const socket = o.env.ZENIUS_SOCKET || record?.socket || path.join(zeniusHome(o.env), "run", `${o.instance}.sock`);
  const live = await probe(socket, o.instance);

  const checks: Check[] = [cliCheck(o)];
  if (o.sandboxed) {
    // The sandbox grants no Zen file, profile or process, by design: only
    // the CLI itself and the instance's socket can be checked from in here.
    const titles = { zen: "Zen", autoconfig: "fx-autoconfig", profile: "profile", loader: "fx-autoconfig loader", runtime: "zenius runtime", sidebar: "zenius sidebar", mcp: "sidebar's zenius mcp" } as const;
    for (const [id, title] of Object.entries(titles) as [keyof typeof titles, string][]) {
      checks.push(skip(check(id, title), "not checked: the sandbox can't read Zen's files"));
    }
    const outside = `node ${path.join(o.checkoutRoot ?? "<the CLI copy>", "sdk", "bin", "zenius")} doctor${o.dev ? ` --instance ${o.instance}` : ""}`;
    checks[1]!.details.push(`The user can check them with \`${outside}\`, which runs outside the sandbox.`);
    checks.push(instanceCheck(o, { record, alive, socket, live }));
    checks.push(dailyCheck(o, undefined, live));
    checks.push(boundaryCheck(o, live));
    checks.push(dnsCheck(o, undefined, live, false));
    checks.push(skip(check("pagecode", "agents' page code"), "not checked: the sandbox can't read the profile"));
    return { instance: o.instance, ok: !checks.some((entry) => entry.status === "fail"), sandboxed: true, checks };
  }
  const found = findApp(o, record, alive);
  checks.push(zenCheck(found));
  checks.push(found.app ? autoconfigCheck(o, found.app) : skip(check("autoconfig", "fx-autoconfig"), "not checked: Zen not found"));

  const profile = findProfile(o, record, alive);
  const profileCheck = check("profile", "profile");
  checks.push(profileCheck);
  let install: InstallJson | undefined;
  const noProfile = () => {
    checks.push(skip(check("loader", "fx-autoconfig loader"), "not checked: no profile"));
    checks.push(skip(check("runtime", "zenius runtime"), "not checked: no profile"));
  };
  if (!profile.dir) {
    fail(profileCheck, "no Zen profile found", profile.tried.length ? [`Looked for ${profile.tried.join(" and ")}.`] : []);
    profileCheck.details.push("Pass --profile <profile directory>.");
    noProfile();
  } else if (!isDirectory(profile.dir)) {
    fail(profileCheck, `${profile.dir} doesn't exist (${profile.how})`);
    noProfile();
  } else {
    profileCheck.summary = `${profile.dir} (${profile.how})`;
    checks.push(loaderCheck(o, profile.dir));
    const runtime = runtimeCheck(o, profile.dir);
    install = runtime.install;
    checks.push(runtime.check);
  }
  checks.push(instanceCheck(o, { record, alive, socket, live, install, app: found.app, profileDir: profile.dir }));
  const profileDir = profile.dir && isDirectory(profile.dir) ? profile.dir : undefined;
  const sidebarInstalled = profileDir !== undefined && installsSidebar(o, profileDir);
  checks.push(sidebarCheck(o, profileDir, live, sidebarInstalled));
  checks.push(await mcpCheck(o, profileDir, sidebarInstalled));
  checks.push(dailyCheck(o, profileDir, live));
  checks.push(boundaryCheck(o, live));
  checks.push(dnsCheck(o, profileDir, live, install !== undefined));
  checks.push(pageCodeCheck(profileDir));
  return { instance: o.instance, ok: !checks.some((entry) => entry.status === "fail"), checks };
}

export function formatReport(report: DoctorReport, home = os.homedir()): string {
  const label: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };
  const width = Math.max(...report.checks.map((entry) => entry.title.length));
  const lines = [`zenius doctor, instance "${report.instance}"${report.sandboxed ? ", in the sandbox" : ""}`, ""];
  for (const entry of report.checks) {
    lines.push(`${label[entry.status]}  ${entry.title.padEnd(width)}  ${tildify(entry.summary, home)}`);
    for (const detail of entry.details) lines.push(`      ${detail}`);
  }
  const failures = report.checks.filter((entry) => entry.status === "fail").length;
  const warnings = report.checks.filter((entry) => entry.status === "warn").length;
  lines.push("");
  if (failures === 0 && warnings === 0 && report.sandboxed) lines.push("zenius works from the sandbox. The checks marked -- need doctor outside it.");
  else if (failures === 0 && warnings === 0) lines.push("Everything zenius needs is in place.");
  else {
    const counts = [plural(failures, "problem"), plural(warnings, "warning")].filter(Boolean).join(" and ");
    lines.push(failures > 0 ? `${counts}. zenius can't work until the problems are fixed.` : `${counts}.`);
  }
  return `${lines.join("\n")}\n`;
}

// --- checks -----------------------------------------------------------------

function cliCheck(o: Resolved): Check {
  const entry = check("cli", "zenius CLI");
  const node = process.versions.node;
  const origin = cliOrigin(o);
  let where = "";
  if (origin.kind === "copy") {
    const from = origin.commit ? ` from commit ${showCommit(origin.commit)}` : "";
    where = `, installed in ${o.checkoutRoot}${from}${origin.installedAt ? ` on ${origin.installedAt.slice(0, 10)}` : ""}`;
  } else if (origin.kind === "checkout") {
    where = `, checkout ${o.checkoutRoot}${origin.commit ? ` at ${showCommit(origin.commit)}` : ""}`;
  }
  entry.summary = `${VERSION}, protocol ${PROTOCOL_VERSION}, Node ${node}${where}`;
  // An installed copy only runs its bundle; a checkout falls back to the sources.
  if (origin.kind === "checkout" && !o.typescript) {
    warn(entry, [
      `bin/zenius runs this checkout's TypeScript sources whenever its bundle is older than them (after a git pull), and Node ${node} can't run TypeScript.`,
      "Run `npm run build` in sdk/ after every pull, or use Node 22.18+ or 23.6+. The copy scripts/install-cli.sh installs always runs its bundle.",
    ]);
  }
  return entry;
}

/** Where this CLI runs from: a copy install-cli.sh made (it has install.json), or a checkout. */
function cliOrigin(o: Resolved): { kind: "copy" | "checkout" | "unknown"; commit?: Commit; installedAt?: string } {
  if (!o.checkoutRoot) return { kind: "unknown" };
  const record = readJson<{ commit?: unknown; installedAt?: unknown }>(path.join(o.checkoutRoot, "install.json")).value;
  if (record) {
    return {
      kind: "copy",
      ...optional("commit", parseCommit(record.commit)),
      ...optional("installedAt", typeof record.installedAt === "string" ? record.installedAt : undefined),
    };
  }
  return { kind: "checkout", ...optional("commit", parseCommit(gitHead(o.checkoutRoot))) };
}

type Commit = { hash: string; dirty: boolean };

/** A commit as install records write it: a hash, "<hash>-dirty", or "unknown" (undefined here). */
function parseCommit(value: unknown): Commit | undefined {
  const match = typeof value === "string" ? /^([0-9a-f]{4,40})(-dirty)?$/i.exec(value) : null;
  return match ? { hash: match[1]!.toLowerCase(), dirty: Boolean(match[2]) } : undefined;
}

// A recorded hash prints as recorded: git's --short adds characters when 7
// name more than one commit, and the installers printed it that way. Only a
// full hash (a checkout's HEAD, a release's commit) is cut, to git's 7.
function showCommit(commit: Commit): string {
  return `${commit.hash.length === 40 ? commit.hash.slice(0, 7) : commit.hash}${commit.dirty ? "-dirty" : ""}`;
}

function sameCommit(a: Commit, b: Commit): boolean {
  return a.hash.startsWith(b.hash) || b.hash.startsWith(a.hash);
}

function zenCheck(found: { app?: App; tried: string[] }): Check {
  const entry = check("zen", "Zen");
  const app = found.app;
  if (!app) {
    return fail(entry, "not found", [
      ...(found.tried.length ? [`Looked at ${found.tried.join(", ")}.`] : []),
      "Pass --app <Zen.app, or the directory of the zen binary>.",
    ]);
  }
  entry.summary = `${app.version ?? "version unknown"}${app.gecko ? `, Gecko ${app.gecko}` : ""}, ${app.root} (${app.how})`;
  const gecko = Number.parseInt(app.gecko ?? "", 10);
  if (Number.isFinite(gecko) && gecko !== TESTED_GECKO) {
    warn(entry, [`zenius is tested with Zen ${TESTED_ZEN} (Gecko ${TESTED_GECKO}); this Gecko may break it.`]);
  }
  return entry;
}

function autoconfigCheck(o: Resolved, app: App): Check {
  const entry = check("autoconfig", "fx-autoconfig");
  const files = [
    { name: "config.js", file: path.join(app.resources, "config.js"), vendored: "program/config.js" },
    {
      name: "defaults/pref/config-prefs.js",
      file: path.join(app.resources, "defaults", "pref", "config-prefs.js"),
      vendored: "program/defaults/pref/config-prefs.js",
    },
  ];
  const missing = files.filter((item) => !isFile(item.file));
  if (missing.length > 0) {
    const vendor = vendorDir(o);
    const where = app.bundle ? "Zen.app" : "Zen's directory";
    fail(entry, `${missing.map((item) => item.name).join(" and ")} missing from ${app.resources}`, [
      "A Zen update deletes config.js, and without it Zen loads no userscripts, zenius included.",
      `Putting it back changes ${where}, so it needs the user's OK; zenius never does it.`,
    ]);
    if (vendor) {
      entry.details.push(`With that OK, copy ${FX_AUTOCONFIG}'s program files:`);
      for (const item of missing) {
        const target = path.dirname(item.file);
        if (item.name.includes("/") && !isDirectory(target)) entry.details.push(`  mkdir -p ${quote(target)}`);
        entry.details.push(`  cp ${quote(path.join(vendor, item.vendored))} ${quote(`${target}/`)}`);
      }
    } else {
      entry.details.push(
        `With that OK, copy ${missing.map((item) => item.vendored).join(" and ")} from ${FX_AUTOCONFIG} (github.com/MrOtherGuy/fx-autoconfig) into ${quote(app.resources)}.`,
      );
    }
    if (app.bundle) {
      entry.details.push(
        "If macOS says the terminal was prevented from modifying apps, allow it under System Settings > Privacy & Security > App Management, or copy the files in Finder (Show Package Contents on Zen.app).",
      );
    }
    entry.details.push("Then quit and reopen Zen; zenius never restarts it.");
    return entry;
  }
  entry.summary = `config.js and defaults/pref/config-prefs.js in ${app.resources}`;
  const vendor = vendorDir(o);
  const differ = vendor ? files.filter((item) => !sameContent(item.file, path.join(vendor, item.vendored))) : [];
  if (differ.length > 0) {
    warn(entry, [`${differ.map((item) => item.name).join(" and ")} differ from ${FX_AUTOCONFIG}'s, the version zenius is tested with.`]);
  }
  return entry;
}

function loaderCheck(o: Resolved, profileDir: string): Check {
  const entry = check("loader", "fx-autoconfig loader");
  const utils = path.join(profileDir, "chrome", "utils");
  const missing = ["boot.sys.mjs", "chrome.manifest"].filter((name) => !isFile(path.join(utils, name)));
  const vendor = vendorDir(o);
  if (missing.length > 0) {
    fail(entry, `${missing.map((name) => `chrome/utils/${name}`).join(" and ")} missing from the profile`);
    if (o.dev) {
      entry.details.push(`scripts/zen-dev.sh ${o.instance} start copies it into the dev profile.`);
      return entry;
    }
    entry.details.push(
      "The user installed fx-autoconfig's loader into this profile; zenius never writes it, and putting it back needs the user's OK.",
    );
    if (vendor) {
      entry.details.push("With that OK, copy it back:");
      entry.details.push(`  mkdir -p ${quote(utils)}`);
      entry.details.push(`  cp -R ${quote(path.join(vendor, "profile", "chrome", "utils"))}/. ${quote(`${utils}/`)}`);
    }
    entry.details.push("Then quit and reopen Zen; zenius never restarts it.");
    return entry;
  }
  entry.summary = "chrome/utils/boot.sys.mjs and chrome.manifest";
  if (vendor) {
    const reference = path.join(vendor, "profile", "chrome", "utils");
    const differ = listFiles(reference).filter((name) => !sameContent(path.join(utils, name), path.join(reference, name)));
    if (differ.length > 0) {
      warn(entry, [`chrome/utils differs from ${FX_AUTOCONFIG}'s (${differ.join(", ")}), the version zenius is tested with.`]);
    }
  }
  return entry;
}

function runtimeCheck(o: Resolved, profileDir: string): { check: Check; install?: InstallJson } {
  const entry = check("runtime", "zenius runtime");
  const scripts = path.join(profileDir, "chrome", "JS");
  const missing = ["zenius.uc.js", "zenius/"].filter((name) => !(name.endsWith("/") ? isDirectory(path.join(scripts, name)) : isFile(path.join(scripts, name))));
  if (missing.length > 0) {
    fail(entry, `not installed: chrome/JS/${missing.join(" and chrome/JS/")} missing`);
    entry.details.push(
      o.dev
        ? `scripts/zen-dev.sh ${o.instance} start copies it from the checkout.`
        : "scripts/install.sh in a zenius checkout installs it, with the user's OK; `install.sh --uninstall` removes it again, and both back up the zenius files they change. Then quit and reopen Zen; zenius never restarts it.",
    );
    return { check: entry };
  }
  const file = path.join(scripts, "zenius", "install.json");
  const read = readJson<InstallJson>(file);
  if (!read.value) {
    if (read.error === "missing" && o.dev) {
      entry.summary = "copied from a checkout by scripts/zen-dev.sh (dev profiles have no install.json)";
      return { check: entry };
    }
    warn(entry, [
      read.error === "missing"
        ? "chrome/JS/zenius/install.json is missing, so scripts/install.sh didn't install this runtime."
        : `chrome/JS/zenius/install.json can't be read: ${read.error}.`,
      "Reinstall with scripts/install.sh, with the user's OK.",
    ]);
    entry.summary = "installed, version unknown";
    return { check: entry };
  }
  const install = read.value;
  const version = typeof install.runtimeVersion === "string" ? install.runtimeVersion : "version unknown";
  const commit = parseCommit(install.commit);
  const parts = [version, `protocol ${String(install.protocol ?? "unknown")}`];
  if (commit) parts.push(`commit ${showCommit(commit)}`);
  if (typeof install.installedAt === "string") parts.push(`installed ${install.installedAt}`);
  entry.summary = parts.join(", ");
  if (install.protocol !== PROTOCOL_VERSION) {
    fail(entry, entry.summary, [
      `This CLI speaks protocol ${PROTOCOL_VERSION} and the runtime speaks ${String(install.protocol)}, so every script fails.`,
      "Install the runtime and link the CLI from the same checkout: scripts/install.sh (with the user's OK) and scripts/install-cli.sh.",
    ]);
  } else if (install.runtimeVersion !== VERSION) {
    warn(entry, [
      `This CLI is ${VERSION}. Install the runtime and link the CLI from the same checkout, so the methods one calls are the ones the other has.`,
    ]);
  }
  const disabled = ["user.js", "prefs.js"].filter((name) => scriptsDisabled(path.join(profileDir, name)).includes("zenius.uc.js"));
  if (disabled.length > 0) {
    fail(entry, entry.summary, [
      `The profile's ${disabled.join(" and ")} list${disabled.length === 1 ? "s" : ""} zenius.uc.js in fx-autoconfig's userChromeJS.scriptsDisabled, so Zen doesn't load zenius, and a reinstall doesn't change that. ` +
        "Ask the user whether they turned it off. With their OK, remove zenius.uc.js from that pref in about:config (and from user.js, if it's there); then they quit and reopen Zen.",
    ]);
  }
  if (typeof install.profile === "string" && !samePath(install.profile, profileDir)) {
    warn(entry, [`install.json says it was installed into ${install.profile}, not this profile: reinstall with scripts/install.sh.`]);
  }
  const ours = cliOrigin(o).commit;
  if (commit && ours && !sameCommit(commit, ours)) {
    entry.details.push(`Installed from commit ${showCommit(commit)}; this CLI is from ${showCommit(ours)}.`);
  }
  if (!o.dev) installRecordCheck(o, entry, profileDir);
  return { check: entry, install };
}

/** ~/.zenius/install.json: what install.sh wrote and where it put the backup. */
function installRecordCheck(o: Resolved, entry: Check, profileDir: string): void {
  const read = readJson<{ profile?: unknown; files?: unknown; backup?: unknown }>(path.join(zeniusHome(o.env), "install.json"));
  if (!read.value) return;
  const record = read.value;
  if (typeof record.profile !== "string" || !samePath(record.profile, profileDir)) return;
  const files = Array.isArray(record.files) ? record.files.filter((file): file is string => typeof file === "string") : [];
  const gone = files.filter((file) => !fs.existsSync(file));
  if (gone.length > 0) {
    warn(entry, [`${plural(gone.length, "file")} that scripts/install.sh wrote ${gone.length === 1 ? "is" : "are"} missing (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", …" : ""}): reinstall with scripts/install.sh.`]);
  }
  if (typeof record.backup === "string" && !isDirectory(record.backup)) {
    // Since aedc306 a first install's backup holds only user.js, so say both.
    warn(entry, [`The backup folder ${record.backup} is missing. It held what this install backed up: an earlier version's zenius files and their commit, which going back to that version needs, or, after a first install, a copy of user.js.`]);
  }
}

/**
 * What the sidebar found of its built-in agents, without a config file (zen-ux's builtinStatus): those
 * that can run, the adapters' folder, each agent's CLI and adapter, and its own line when none can run.
 */
type SidebarBuiltin = {
  agents?: unknown;
  folder?: unknown;
  node?: unknown;
  clis?: Record<string, unknown>;
  adapters?: Record<string, unknown>;
  missing?: unknown;
  error?: unknown;
};

const BUILTIN_AGENTS = { claude: "Claude Code", codex: "Codex" } as const;

/** The built-in agents the sidebar can run, by their ids, in BUILTIN_AGENTS' order. */
function builtinAgents(builtin: SidebarBuiltin | undefined): (keyof typeof BUILTIN_AGENTS)[] {
  const agents = Array.isArray(builtin?.agents) ? builtin.agents : [];
  return (Object.keys(BUILTIN_AGENTS) as (keyof typeof BUILTIN_AGENTS)[]).filter((id) => agents.includes(id));
}

/** The lines naming the built-in agents the sidebar runs, and why it doesn't offer the others. */
function builtinLines(builtin: SidebarBuiltin, configPath: string | undefined): string[] {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const folder = text(builtin.folder) ?? "its adapters' folder";
  const runs = builtinAgents(builtin);
  const named = runs.map((id) => `${BUILTIN_AGENTS[id]}${text(builtin.clis?.[id]) ? ` (${text(builtin.clis?.[id])})` : ""}`);
  const lines = [
    `With no config file${configPath ? ` at ${configPath}` : ""}, the sidebar runs ${named.join(" and ")}, through the adapters in ${folder}.`,
  ];
  for (const id of Object.keys(BUILTIN_AGENTS) as (keyof typeof BUILTIN_AGENTS)[]) {
    if (runs.includes(id)) continue;
    const cli = text(builtin.clis?.[id]);
    if (!cli) lines.push(`It doesn't offer ${BUILTIN_AGENTS[id]}, which isn't installed (no ${id} command found).`);
    else if (builtin.adapters?.[id] === false) {
      lines.push(`It doesn't offer ${BUILTIN_AGENTS[id]} (${cli}): its adapter isn't in ${folder}. Running zenius's installer again puts it there.`);
    }
  }
  return lines;
}

/** The fixed line in zenius's agent-sidebar.uc.js, among its first 20 (agreed with zen-ux, 2026-11-21). */
const SIDEBAR_MARKER = "// zenius: agent-sidebar";

/**
 * zenius's sidebar, once scripts/install.sh has put it in the profile
 * (~/.zenius/install.json lists chrome/JS/agent-sidebar.uc.js). The user's
 * own install.sh can put their earlier sidebar back over it, which Zen then
 * loads at its next start, so the file must still carry zenius's marker line.
 * While Zen runs, the runtime's ui.sidebarStatus (zen-ux) says whether
 * zenius's sidebar started and found its config.
 */
function sidebarCheck(o: Resolved, profileDir: string | undefined, live: Live, installed: boolean): Check {
  const entry = check("sidebar", "zenius sidebar");
  if (o.dev) return skip(entry, `not checked: ${o.instance} is a dev instance`);
  if (!profileDir) return skip(entry, "not checked: no profile");
  const file = path.join(profileDir, "chrome", "JS", "agent-sidebar.uc.js");
  if (!installed) return skip(entry, "not installed: this profile's install has no zenius sidebar");
  const problems: string[] = [];
  // Information that goes with the check whatever its status: the built-in agents.
  const notes: string[] = [];
  // install.sh keeps a copy the user put back as theirs: Undo restores it (zen-core's f02a91c).
  const restore = "With the user's OK, reinstall with scripts/install.sh, which keeps the copy it replaces as the user's own for Undo; then the user quits and reopens Zen.";
  const present = isFile(file);
  const marked = present && hasSidebarMarker(file);
  if (!present) {
    problems.push(`chrome/JS/agent-sidebar.uc.js is missing, so Zen starts without zenius's sidebar. ${restore}`);
  } else if (!marked) {
    problems.push(
      `chrome/JS/agent-sidebar.uc.js isn't zenius's sidebar: another install, such as the user's own install.sh, put its copy back, and Zen loads that one at its next start. ${restore}`,
    );
  }
  const disabled = ["user.js", "prefs.js"].filter((name) => scriptsDisabled(path.join(profileDir, name)).includes("agent-sidebar.uc.js"));
  if (disabled.length > 0) {
    problems.push(
      `The profile's ${disabled.join(" and ")} list${disabled.length === 1 ? "s" : ""} agent-sidebar.uc.js in fx-autoconfig's userChromeJS.scriptsDisabled, so Zen doesn't load the sidebar. ` +
        "Ask the user whether they turned it off. With their OK, remove it from that pref in about:config (and from user.js, if it's there); then they quit and reopen Zen.",
    );
  }
  const status = live.sidebar;
  let running = "Zen isn't running";
  if (live.hello && !status) {
    // A runtime from before ui.sidebarStatus: the runtime check already says to reopen Zen.
    running = "the running runtime doesn't report the sidebar";
  } else if (status) {
    if (typeof status.error === "string" && status.error) {
      problems.push(`zenius's sidebar failed to start in the running Zen: ${status.error}`);
    } else if (status.loaded !== true && marked && disabled.length === 0) {
      problems.push("The running Zen hasn't loaded zenius's sidebar, which is installed: the user quits and reopens Zen to load it.");
    }
    const at = typeof status.configPath === "string" && status.configPath ? ` at ${status.configPath}` : "";
    const builtin = status.builtin;
    if (status.config === "missing" && typeof builtin?.error === "string" && builtin.error) {
      problems.push(`The sidebar has no config file${at}, and looking for its built-in agents failed: ${builtin.error}`);
    } else if (status.config === "missing" && typeof builtin?.missing === "string" && builtin.missing) {
      // The sidebar's own line says what to install.
      problems.push(`The sidebar has no config file${at} and no built-in agent it can run, so it offers no agent. ${builtin.missing}`);
    } else if (status.config === "missing") {
      // A path the pref names that is missing (built-in agents run only without the pref), or a runtime from before them.
      const where = at ? at.slice(4) : "its config file";
      problems.push(`The sidebar has no config at ${where}, so it offers no agent. The user's own sidebar setup made that file; the pref uc.agent-sidebar.config can name another.`);
    } else if (status.config === "builtin" && builtin) {
      notes.push(...builtinLines(builtin, at ? at.slice(4) : undefined));
    }
    const windows = typeof status.windows === "number" ? ` in ${plural(status.windows, "window")}` : "";
    // "none" is uc.agent-sidebar.config = none, as zen-dev.sh sets it in dev profiles: no agent, on purpose.
    const config =
      status.config === "none"
        ? ", agents are off in this profile (uc.agent-sidebar.config = none)"
        : status.config === "found" && typeof status.configPath === "string"
          ? `, config ${status.configPath}`
          : status.config === "builtin"
            ? `, built-in agents (${builtinAgents(status.builtin).map((id) => BUILTIN_AGENTS[id]).join(", ")})`
            : "";
    running = status.loaded === true ? `loaded${windows}${config}` : "not loaded";
  }
  // Codex is on by default (the user's call, 2026-11-21), and off is the user's choice: information,
  // not a warning. The lines say what holds Codex and the one read path no Codex setting removes, which
  // the user accepted. A profile with no agents (config none or missing) runs no Codex either, nor do
  // built-in agents without Codex.
  const noAgents =
    status?.config === "none" || status?.config === "missing" || (status?.config === "builtin" && !builtinAgents(status.builtin).includes("codex"));
  const codexOff = profilePref(profileDir, "zenius.agentSidebar.allowCodex") === "false";
  const codex = noAgents ? "" : codexOff ? "; Codex is off (zenius.agentSidebar.allowCodex = false)" : "; Codex can run, within the limits below";
  const codexLines = noAgents || codexOff ? [] : CODEX_LIMITS;
  if (problems.length > 0) return warn(entry, [...problems, ...notes, ...codexLines], `${plural(problems.length, "problem")}${codex}`);
  entry.summary = `zenius's on disk; ${running}${codex}`;
  entry.details.push(...notes, ...codexLines);
  return entry;
}

/** Whether scripts/install.sh put zenius's sidebar in this profile: ~/.zenius/install.json lists it. */
function installsSidebar(o: Resolved, profileDir: string): boolean {
  const file = path.join(profileDir, "chrome", "JS", "agent-sidebar.uc.js");
  const record = readJson<{ profile?: unknown; files?: unknown }>(path.join(zeniusHome(o.env), "install.json")).value;
  return (
    typeof record?.profile === "string" &&
    samePath(record.profile, profileDir) &&
    Array.isArray(record.files) &&
    record.files.some((name) => typeof name === "string" && samePath(name, file))
  );
}

/**
 * The sidebar gives its agents zenius's browser tools by starting
 * `~/.local/bin/zenius mcp` (or the CLI that uc.agent-sidebar.zenius-cli
 * names) on this Zen's instance (zen-sidebar's AgentRules). A CLI from
 * before `zenius mcp`, such as the first daily install's, can't, and the
 * agents then have no browser. So doctor starts the same command, as the
 * sidebar would, and asks for its tools: it answers without Zen and writes
 * nothing.
 */
async function mcpCheck(o: Resolved, profileDir: string | undefined, installed: boolean): Promise<Check> {
  const entry = check("mcp", "sidebar's zenius mcp");
  if (o.dev) return skip(entry, `not checked: ${o.instance} is a dev instance`);
  if (!profileDir || !installed) return skip(entry, "not checked: no zenius sidebar installed");
  const cli = prefString(profilePref(profileDir, "uc.agent-sidebar.zenius-cli")) || path.join(o.home, ".local", "bin", "zenius");
  const instance = prefString(profilePref(profileDir, "zenius.instance")) || "default";
  const fix = "Reinstall the CLI from the checkout the runtime came from, with Node 24 in front: scripts/install-cli.sh --skill (Updating later, step 2).";
  if (!fs.existsSync(cli)) {
    return warn(entry, [`The sidebar starts its agents' browser tools with ${cli} mcp, and there's nothing at ${cli}, so its agents get no browser. ${fix}`], "no CLI");
  }
  const answer = await askMcp(cli, { ...process.env, ...o.env, ZENIUS_INSTANCE: instance }, o.mcpTimeoutMs);
  if ("error" in answer) {
    return warn(entry, [`${cli} mcp ${answer.error}, so the sidebar's agents get no browser tools. ${fix}`], "doesn't answer");
  }
  const names = answer.tools.slice(0, 4).join(", ") + (answer.tools.length > 4 ? ", …" : "");
  entry.summary = `${cli} mcp answers: ${plural(answer.tools.length, "tool")} (${names})`;
  return entry;
}

/** A string pref's value as prefs.js writes it (JSON), or undefined. */
function prefString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Start `<cli> mcp` and ask for its tools as an MCP client does: their names, or what went wrong. */
function askMcp(cli: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ tools: string[] } | { error: string }> {
  const { spawn } = require_("node:child_process") as typeof import("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cli, ["mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => done({ error: `didn't list its tools within ${timeoutMs / 1000} s` }), timeoutMs);
    function done(result: { tools: string[] } | { error: string }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(result);
    }
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    // An early exit breaks the pipe; the close handler says why.
    child.stdin.on("error", () => {});
    child.on("error", (error) => done({ error: `couldn't start (${error.message})` }));
    child.on("close", (code, signal) => {
      const last = stderr.trim().split("\n").pop()?.trim();
      done({ error: `ended (${signal ?? `exit ${code}`}) before listing its tools${last ? `: ${last}` : ""}` });
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: { tools?: { name?: unknown }[] }; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          done({ error: `wrote something other than JSON on stdout (${line.slice(0, 80)})` });
          return;
        }
        if (message.error) {
          done({ error: `refused ${message.id === 1 ? "initialize" : "tools/list"} (${String(message.error.message)})` });
        } else if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          const tools = Array.isArray(message.result?.tools) ? message.result.tools.map((tool) => String(tool?.name ?? "")).filter(Boolean) : [];
          done(tools.length > 0 ? { tools } : { error: "listed no tools" });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zenius-doctor", version: VERSION } } });
  });
}

/** Whether a sidebar file is zenius's: its marker line, among the first 20. */
function hasSidebarMarker(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").split("\n", 20).some((line) => line.trim() === SIDEBAR_MARKER);
  } catch {
    return false;
  }
}

function instanceCheck(
  o: Resolved,
  state: { record?: InstanceRecord; alive: boolean; socket: string; live: Live; install?: InstallJson; app?: App; profileDir?: string },
): Check {
  const entry = check("instance", "instance");
  const { record, alive, socket, live } = state;
  const spoken = live.hello?.protocol;
  if (spoken !== undefined && spoken !== PROTOCOL_VERSION) {
    return fail(entry, `running, but its runtime speaks protocol ${String(spoken)} and this CLI speaks ${PROTOCOL_VERSION}`, [
      "Every script fails until they match. Install the runtime and link the CLI from the same checkout: scripts/install.sh (with the user's OK) and scripts/install-cli.sh.",
    ]);
  }
  if (live.error || !live.hello) {
    // The system refused the connection, so Zen may well be running: a sandbox
    // around doctor hides its process too, and "not running" would be wrong.
    if (live.errno === "EPERM" || live.errno === "EACCES") {
      return fail(entry, `blocked: this process may not connect to ${socket} (${live.errno})`, [
        "A sandbox around it blocks the socket (Codex's does while its network access is off), or the socket's permissions do. Zen may well be running.",
        SANDBOX_BLOCKED_NEXT,
      ]);
    }
    if (o.sandboxed) {
      return warn(
        entry,
        [
          ...(live.error ? [live.error] : []),
          "From the sandbox doctor can't see Zen's process, so it can't tell whether Zen is closed or not answering.",
          o.dev ? `If it isn't running, start it with scripts/zen-dev.sh ${o.instance} start.` : "If Zen is closed, ask the user to open it.",
        ],
        "not answering",
      );
    }
    if (alive) {
      return fail(entry, `pid ${record!.pid} is registered but doesn't answer on ${socket}`, [
        ...(live.error ? [live.error] : []),
        "Zen may still be starting, or hung, or zenius failed while starting: the Browser Console (Tools > Browser Tools) shows [zenius] lines.",
      ]);
    }
    const running = state.profileDir ? o.zenProcessFor(state.profileDir) : undefined;
    if (running !== undefined) {
      return fail(entry, `Zen is running (pid ${running}) but zenius didn't start in it`, [
        "Fix the problems above, if any, then quit and reopen Zen; zenius never restarts it.",
        "If nothing above is wrong, the Browser Console (Tools > Browser Tools) shows why zenius didn't start: look for [zenius] and userChromeJS lines.",
      ]);
    }
    const stale = record?.pid !== undefined ? ` (the registry still names pid ${record.pid}, which is gone)` : "";
    return warn(entry, [o.dev ? `Start it with scripts/zen-dev.sh ${o.instance} start.` : "Zen is closed. Ask the user to open it."], `not running${stale}`);
  }
  const hello = live.hello;
  const pid = live.health?.pid ?? record?.pid;
  const parts = ["running"];
  if (pid !== undefined) parts.push(`pid ${pid}`);
  parts.push(`Zen ${hello.zenVersion ?? live.version?.zenVersion ?? "?"}`, `runtime ${hello.runtimeVersion ?? live.version?.runtimeVersion ?? "?"}`, `protocol ${hello.protocol ?? "?"}`);
  if (live.methods) parts.push(`${live.methods.length} methods`);
  // browser.health counts every Space but the Agents Space, the user's own too.
  const spaces = live.health?.spaces;
  if (typeof spaces === "number") parts.push(`${spaces} Space${spaces === 1 ? "" : "s"} besides the Agents Space`);
  entry.summary = parts.join(", ");
  // Agents Spaces zenius made earlier (by its mark) and left at a start,
  // since they hold tabs: the user looks and decides (SPI "The Agents
  // Space's mark").
  // Its place in Zen's Space switcher, next to its name, points the user to
  // it (no tab titles: agents run doctor too).
  const strays = live.health?.strayAgentsSpaces;
  if (Array.isArray(strays)) {
    for (const space of strays) {
      const tabs = space.tabs ?? 0;
      const place = Number.isInteger(space.position) && space.position! > 0 ? ` the ${ordinal(space.position!)} Space in Zen's switcher,` : "";
      warn(entry, [
        `An earlier Agents Space, "${space.name ?? ""}",${place} is still in Zen with ${tabs} tab${tabs === 1 ? "" : "s"}: zenius doesn't remove one that holds tabs or that a window shows. The user can look at it, then remove the Space in Zen.`,
      ]);
    }
  }
  socketModeCheck(entry, socket);
  const installed = state.install?.runtimeVersion;
  if (typeof installed === "string" && hello.runtimeVersion && hello.runtimeVersion !== installed) {
    warn(entry, [`Zen runs runtime ${hello.runtimeVersion}, but ${installed} is installed: quit and reopen Zen to load it.`]);
  } else if (state.install) {
    // The runtime reads install.json once, at startup: a reinstall since then
    // shows as a different record, even when runtimeVersion didn't change.
    const loaded = live.version && "install" in live.version ? live.version.install : record && "install" in record ? record.install : undefined;
    if (loaded === null) {
      warn(entry, [`Zen started before this runtime was installed (${describeInstall(state.install)}), so it runs the files it found then: quit and reopen Zen to load it.`]);
    } else if (loaded && !sameInstall(loaded, state.install)) {
      warn(entry, [`Zen still runs an earlier install (${describeInstall(loaded)}), not the profile's (${describeInstall(state.install)}): quit and reopen Zen to load it.`]);
    }
  }
  const onDisk = state.app?.version;
  if (onDisk && hello.zenVersion && hello.zenVersion !== onDisk) {
    warn(entry, [
      `Zen ${hello.zenVersion} is running, but ${onDisk} is on disk: Zen updated itself, and a Zen update deletes config.js. Run zenius doctor again after Zen restarts.`,
    ]);
  }
  if (record?.profileDir && state.profileDir && !samePath(record.profileDir, state.profileDir)) {
    entry.details.push(`It runs on ${record.profileDir}, not the profile checked above.`);
  }
  return entry;
}

function sameInstall(a: { commit?: unknown; installedAt?: unknown }, b: { commit?: unknown; installedAt?: unknown }): boolean {
  return String(a.commit ?? "") === String(b.commit ?? "") && String(a.installedAt ?? "") === String(b.installedAt ?? "");
}

function describeInstall(install: { commit?: unknown; installedAt?: unknown }): string {
  const commit = parseCommit(install.commit);
  const parts = [commit ? `commit ${showCommit(commit)}` : "commit unknown"];
  if (typeof install.installedAt === "string" && install.installedAt) parts.push(`installed ${install.installedAt}`);
  return parts.join(", ");
}

function socketModeCheck(entry: Check, socket: string): void {
  let mode: number;
  let dirMode: number;
  try {
    mode = fs.statSync(socket).mode & 0o777;
    dirMode = fs.statSync(path.dirname(socket)).mode & 0o777;
  } catch {
    return;
  }
  if (mode & 0o077) {
    warn(entry, [`${socket} has mode ${octal(mode)}: other users can connect to it. The runtime creates it 0600.`]);
  }
  if (dirMode & 0o077) {
    warn(entry, [`${path.dirname(socket)} has mode ${octal(dirMode)}: the runtime keeps its socket directory 0700.`]);
  }
}

/** I4 (SPEC §3): a daily Zen shows no sign of automation and runs no dev code. */
/**
 * Prefs only tests set, each with the value that turns a protection off:
 * zenius never writes them outside tests, so one in the daily profile is a
 * test's leftover or a change by hand.
 * - zenius.handoff.quietReload false (zen-core) turns off the quiet
 *   reloads: a written page's before the user types in it, those of written
 *   pages in a held page's window group, and Resume's of a page the user
 *   typed a secret into (zen-ux).
 * - zenius.test.pageWorldEvaluate true (zen-observe) runs the agent's page
 *   code in the page's own JavaScript instead of its sandbox.
 * - zenius.test.loopCounterOff true (zen-observe) runs it without the
 *   world's loop counter, which stops a loop that calls no built-in at its
 *   deadline.
 * - zenius.agentSidebar.allowUnknownAgents true (zen-observe) lets the agent
 *   sidebar start an agent that is neither Claude Code nor Codex, such as
 *   the tests' mock agent. zenius can't hold such an agent to the browser,
 *   so it runs with none of zenius's limits.
 */
const TEST_ONLY_PREFS: readonly { pref: string; bad: "true" | "false"; off: string }[] = [
  {
    pref: "zenius.handoff.quietReload",
    bad: "false",
    off: "the hand-off's and Resume's quiet reloads are off: a page the agent's code wrote into isn't loaded afresh before the user types there, nor a page the user typed a secret into at Resume agent",
  },
  {
    pref: "zenius.test.pageWorldEvaluate",
    bad: "true",
    off: "the agent's page code runs in the page's own JavaScript, not in its sandbox, where a page can see and change what it does",
  },
  {
    pref: "zenius.test.loopCounterOff",
    bad: "true",
    off: "the agent's page code runs without its sandbox's loop counter: a loop that calls no built-in isn't stopped at its time limit",
  },
  {
    pref: "zenius.agentSidebar.allowUnknownAgents",
    bad: "true",
    off: "the agent sidebar starts agents other than Claude Code and Codex, such as the tests' mock agent, which zenius can't hold to the browser: they run with none of its limits",
  },
];

function dailyCheck(o: Resolved, profileDir: string | undefined, live: Live): Check {
  const entry = check("daily", "daily-driver (I4)");
  if (o.dev) return skip(entry, `not checked: ${o.instance} is a dev instance`);
  const problems: string[] = [];
  const warnings: string[] = [];
  const turnedOff: string[] = [];
  const checked: string[] = [];
  const unchecked: string[] = [];
  if (profileDir) {
    for (const { pref, bad, off } of TEST_ONLY_PREFS) {
      const files = ["user.js", "prefs.js"].filter((name) => readPrefs(path.join(profileDir, name)).get(pref) === bad);
      if (files.length === 0) continue;
      turnedOff.push(`${pref} ${bad}`);
      warnings.push(
        `The profile's ${files.join(" and ")} set${files.length === 1 ? "s" : ""} ${pref} to ${bad}, so ${off}. ` +
          "Only tests set it, and zenius never writes it outside them: ask the user whether they did. " +
          "Reset it in about:config (and remove it from user.js, if it's there).",
      );
    }
    for (const name of ["user.js", "prefs.js"]) {
      const instance = readPrefs(path.join(profileDir, name)).get("zenius.instance");
      if (instance !== undefined && instance !== '"default"') {
        problems.push(
          `The profile's ${name} sets zenius.instance to ${instance}, so zenius in this Zen answers as that instance, not "default", where agents and doctor look for the user's Zen. ` +
            "Reset it in about:config (and remove it from user.js, if it's there); then the user quits and reopens Zen.",
        );
      }
    }
    const dev = ["prefs.js", "user.js"].find((name) => readPrefs(path.join(profileDir, name)).get("zenius.dev") === "true");
    if (dev) problems.push(`The profile's ${dev} sets pref zenius.dev, which turns on the dev.* methods. Reset it in about:config (and remove it from user.js, if it's there); then the user quits and reopens Zen.`);
    else checked.push("no zenius.dev pref");
    const links = linksIn(profileDir);
    for (const link of links) {
      problems.push(`chrome/${link.path} is a link to ${link.target}. scripts/install.sh copies files, and a daily profile must not link into a checkout: reinstall with scripts/install.sh.`);
    }
    if (links.length === 0) checked.push("no links into a checkout");
  } else {
    unchecked.push(o.sandboxed ? "prefs and links (the sandbox can't read the profile)" : "prefs and links (no profile)");
  }
  if (live.methods) {
    const dev = live.methods.filter((method) => method.startsWith("dev."));
    if (dev.length > 0) problems.push(`The runtime registers ${plural(dev.length, "dev.* method")} (${dev.slice(0, 3).join(", ")}…), so it runs in dev mode.`);
    else checked.push("no dev.* methods");
  } else {
    unchecked.push("dev.* methods (Zen isn't answering)");
  }
  const webdriver = live.health?.webdriver;
  if (webdriver === true) {
    problems.push(
      "navigator.webdriver is true: Marionette or the Remote Agent is running, which sites can detect. Start Zen without --marionette or --remote-debugging-port.",
    );
  } else if (webdriver === false) {
    checked.push("navigator.webdriver false");
  } else {
    unchecked.push(live.health ? "navigator.webdriver (this runtime doesn't report it)" : "navigator.webdriver (Zen isn't answering)");
  }
  if (problems.length > 0) {
    fail(entry, plural(problems.length, "problem"), problems);
  } else if (checked.length === 0) {
    return skip(entry, `not checked: ${unchecked.join("; ")}`);
  } else {
    entry.summary = checked.join(", ");
  }
  if (warnings.length > 0) {
    // The summary step 6 quotes stays as it is when nothing is turned off.
    warn(entry, warnings, problems.length > 0 ? undefined : `${entry.summary}; ${turnedOff.join(", ")}`);
  }
  if (unchecked.length > 0) entry.details.push(`Not checked: ${unchecked.join("; ")}.`);
  return entry;
}

/**
 * What an agent may load (I5): observe/webcontent.sys.mjs's LOADABLE plus
 * about:blank, as browser.health's i5.loads lists them. A runtime that
 * lists more lets agents into browser or local pages; one that lists less
 * refuses pages this CLI's scripts expect to load.
 */
const I5_LOADS = ["http:", "https:", "data:", "blob:", "about:blank"] as const;

/**
 * I5 (SPEC §3.9): the browser is no way out of an agent's sandbox. The
 * runtime reports in browser.health, which opens nothing, what its URL policy
 * allows and whether its gates hold. Each flag is computed, and a self-test
 * that throws reports false. A runtime that doesn't report comes from before
 * the report, so an install from a stale commit can't pass.
 */
function boundaryCheck(o: Resolved, live: Live): Check {
  const entry = check("boundary", "agent boundary (I5)");
  if (live.error || !live.hello) return skip(entry, "not checked: Zen isn't answering");
  if (live.hello.protocol !== undefined && live.hello.protocol !== PROTOCOL_VERSION) return skip(entry, "not checked: the runtime speaks another protocol");
  const fix = o.dev
    ? `Restart it with scripts/zen-dev.sh ${o.instance} restart, so it loads the checkout's runtime.`
    : "Install the runtime from this CLI's checkout (scripts/install.sh, with the user's OK), then the user quits and reopens Zen.";
  const i5 = live.health?.i5;
  if (!i5 || typeof i5 !== "object" || Array.isArray(i5)) {
    return fail(entry, live.health ? "the runtime doesn't report it" : "Zen didn't answer browser.health", [
      "So the runtime predates the report: it comes from an older commit than this CLI, and its URL policy and page gate can't be trusted.",
      fix,
    ]);
  }
  const report = i5 as Record<string, unknown>;
  const problems: string[] = [];
  const loads = Array.isArray(report.loads) ? report.loads.filter((item): item is string => typeof item === "string") : undefined;
  if (!loads) {
    problems.push("It doesn't list what agents may load.");
  } else {
    const extra = loads.filter((item) => !(I5_LOADS as readonly string[]).includes(item));
    const missing = I5_LOADS.filter((item) => !loads.includes(item));
    if (extra.length > 0) problems.push(`It lets agents load ${listed(extra)} URLs, where only ${listed(I5_LOADS)} are allowed.`);
    if (missing.length > 0) problems.push(`It refuses ${listed(missing)}, which this CLI's scripts expect to load.`);
  }
  if (report.pageGate !== true) problems.push("Its page gate isn't on, so page methods could act in browser, local and add-on pages.");
  if (report.contentGate !== true) problems.push("Its content-call check failed its self-test: a content call could reach the browser window's own document.");
  if (report.refuses !== true) problems.push("Its refusal self-test failed: it should refuse about:config, file:/// and the browser window's own document.");
  if (problems.length > 0) {
    return fail(entry, plural(problems.length, "problem"), [
      ...problems,
      fix,
      "Until it passes, agents must not work in this Zen: if the fix doesn't help, send `zenius doctor --json` to whoever installed zenius.",
    ]);
  }
  entry.summary = `agents load only ${listed(I5_LOADS)}; page gate on; self-tests refused about:config, file:/// and a browser document`;
  return entry;
}

// --- finding Zen and the profile -------------------------------------------

function findApp(o: Resolved, record: InstanceRecord | undefined, alive: boolean): { app?: App; tried: string[] } {
  const candidates: { at: string; how: string }[] = [];
  if (o.app) {
    candidates.push({ at: o.app, how: "from --app" });
  } else {
    const pid = record?.pid;
    if (alive && pid !== undefined) {
      const exe = o.executableOf(pid);
      if (exe) candidates.push({ at: exe, how: `from the running instance, pid ${pid}` });
    }
    if (o.env.ZEN_BIN) candidates.push({ at: o.env.ZEN_BIN, how: "from $ZEN_BIN" });
    if (o.platform === "darwin") {
      candidates.push({ at: path.join(o.applications, "Zen.app"), how: "the default location" });
      candidates.push({ at: path.join(o.home, "Applications", "Zen.app"), how: "the default location" });
    } else {
      const onPath = which("zen", o.env.PATH);
      if (onPath) candidates.push({ at: onPath, how: "zen on PATH" });
      const opt = path.join(o.home, "opt");
      for (const name of listDir(opt).filter((entry) => /^zen\b/i.test(entry)).sort().reverse()) {
        candidates.push({ at: path.join(opt, name), how: "found in ~/opt" });
      }
    }
  }
  const tried: string[] = [];
  for (const candidate of candidates) {
    const app = appAt(candidate.at);
    if (app) return { app: { ...app, how: candidate.how }, tried };
    tried.push(candidate.at);
  }
  return { tried };
}

/** Zen.app (or anything inside it), a directory holding application.ini, or a binary beside one. */
function appAt(at: string): Omit<App, "how"> | undefined {
  let real: string;
  try {
    real = fs.realpathSync(at);
  } catch {
    return undefined;
  }
  const bundle = /^(.*?\.app)(?:\/|$)/.exec(real)?.[1];
  const resources = bundle ? path.join(bundle, "Contents", "Resources") : isDirectory(real) ? real : path.dirname(real);
  const application = readIni(path.join(resources, "application.ini"));
  if (!application) return undefined;
  const platform = readIni(path.join(resources, "platform.ini"));
  return {
    root: bundle ?? resources,
    resources,
    bundle: Boolean(bundle),
    ...optional("version", application.get("App")?.get("Version")),
    ...optional("gecko", platform?.get("Build")?.get("Milestone")),
  };
}

function findProfile(o: Resolved, record: InstanceRecord | undefined, alive: boolean): { dir?: string; how: string; tried: string[] } {
  if (o.profile) return { dir: path.resolve(o.profile), how: "from --profile", tried: [] };
  if (record?.profileDir) {
    return { dir: record.profileDir, how: alive ? "from the running instance" : "from the instance registry; Zen isn't running", tried: [] };
  }
  if (o.dev) {
    const dir = path.join(o.env.ZENIUS_DEV_HOME || path.join(o.home, ".zenius-dev"), "profiles", o.instance);
    return isDirectory(dir) ? { dir, how: "zen-dev.sh's profile for this instance", tried: [] } : { how: "", tried: [dir] };
  }
  const installed = readJson<{ profile?: unknown }>(path.join(zeniusHome(o.env), "install.json")).value?.profile;
  if (typeof installed === "string") return { dir: installed, how: "from ~/.zenius/install.json", tried: [] };
  const tried: string[] = [];
  for (const ini of profilesIni(o)) {
    tried.push(ini);
    const dir = defaultProfile(ini);
    if (dir) return { dir, how: `the default profile in ${tildify(ini, o.home)}`, tried };
  }
  return { how: "", tried };
}

/** Where Zen keeps profiles.ini: Firefox's places, with Zen's name. */
function profilesIni(o: Resolved): string[] {
  if (o.platform === "darwin") return [path.join(o.home, "Library", "Application Support", "zen", "profiles.ini")];
  const xdg = o.env.XDG_CONFIG_HOME || path.join(o.home, ".config");
  // An install that predates Gecko's move to XDG keeps ~/.zen.
  return [path.join(o.home, ".zen", "profiles.ini"), path.join(xdg, "zen", "profiles.ini")];
}

/** Firefox launches the [Install…] section's Default; older files only mark a [Profile…] Default=1. */
export function defaultProfile(iniFile: string): string | undefined {
  const ini = readIni(iniFile);
  if (!ini) return undefined;
  const base = path.dirname(iniFile);
  const profiles = [...ini].filter(([name]) => /^Profile\d+$/.test(name)).map(([, section]) => section);
  const resolve = (value: string) => {
    const entry = profiles.find((section) => section.get("Path") === value);
    const relative = entry ? entry.get("IsRelative") !== "0" : !path.isAbsolute(value);
    return relative ? path.join(base, value) : value;
  };
  for (const [name, section] of ini) {
    const value = section.get("Default");
    if (name.startsWith("Install") && value) return resolve(value);
  }
  const marked = profiles.find((section) => section.get("Default") === "1") ?? (profiles.length === 1 ? profiles[0] : undefined);
  const value = marked?.get("Path");
  return value ? resolve(value) : undefined;
}

// --- the running instance -----------------------------------------------------

/** Ask the runtime who it is, read-only: browser.* calls never touch a task space. */
async function probe(socket: string, instance: string): Promise<Live> {
  try {
    if (!fs.statSync(socket).isSocket()) return { error: `${socket} is not a socket` };
  } catch {
    return { error: `nothing at ${socket}` };
  }
  const client = new RpcClient({ socketPath: socket, instance });
  const call = <T>(method: string) => client.call<T>(method, {}, { safetyTimeoutMs: CALL_TIMEOUT_MS });
  try {
    const version = await call<Live["version"]>("browser.version");
    const [health, methods] = await Promise.all([
      call<Live["health"]>("browser.health").catch(() => undefined),
      call<{ methods?: string[] }>("browser.methods").catch(() => undefined),
    ]);
    const methodList = Array.isArray(methods?.methods) ? methods.methods : undefined;
    // Asked only of a runtime that has it: an older one would answer with an error.
    const sidebar = methodList?.includes("ui.sidebarStatus") ? await call<Live["sidebar"]>("ui.sidebarStatus").catch(() => undefined) : undefined;
    return {
      ...optional("hello", client.hello),
      ...optional("version", version ?? undefined),
      ...optional("health", health ?? undefined),
      ...optional("methods", methodList),
      ...optional("sidebar", sidebar ?? undefined),
    };
  } catch (error) {
    // The hello may have come before the failure: it names the protocol it speaks.
    const errno = (error as { data?: { errno?: unknown } }).data?.errno;
    return { error: (error as Error).message, ...optional("hello", client.hello), ...optional("errno", typeof errno === "string" ? errno : undefined) };
  } finally {
    client.close();
  }
}

function executableOf(pid: number, platform: NodeJS.Platform): string | undefined {
  if (platform === "linux") {
    try {
      // A binary replaced on disk while it runs reads "<path> (deleted)".
      return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    } catch {
      return undefined;
    }
  }
  const out = run("ps", ["-o", "comm=", "-p", String(pid)]);
  return out?.startsWith("/") ? out : undefined;
}

/** The Zen that holds a profile, found without asking it anything. */
function zenProcessFor(profileDir: string, platform: NodeJS.Platform, home: string): number | undefined {
  try {
    // On Linux the profile lock is a link to "<address>:+<pid>" while Zen runs.
    const pid = Number(/:\+(\d+)$/.exec(fs.readlinkSync(path.join(profileDir, "lock")))?.[1]);
    if (pid && isProcessAlive(pid)) return pid;
  } catch {
    // no lock link
  }
  if (platform !== "darwin") return undefined;
  // The Mac's lock file stays after quit, so look for the app instead. A Zen
  // started from the Dock runs the default profile without --profile, and
  // dev Zens always pass one, so this only answers for the default profile.
  const daily = defaultProfile(path.join(home, "Library", "Application Support", "zen", "profiles.ini"));
  if (!daily || !samePath(daily, profileDir)) return undefined;
  for (const line of (run("ps", ["-axo", "pid=,args="]) ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && /\/Zen\.app\/Contents\/MacOS\/zen(\s|$)/.test(match[2]!) && !/-contentproc|--profile/.test(match[2]!)) return Number(match[1]);
  }
  return undefined;
}

// --- helpers ------------------------------------------------------------------

function check(id: Check["id"], title: string): Check {
  return { id, title, status: "ok", summary: "", details: [] };
}

function fail(entry: Check, summary: string, details: string[] = []): Check {
  entry.status = "fail";
  entry.summary = summary;
  entry.details.push(...details);
  return entry;
}

function warn(entry: Check, details: string[], summary?: string): Check {
  if (entry.status !== "fail") entry.status = "warn";
  if (summary !== undefined) entry.summary = summary;
  entry.details.push(...details);
  return entry;
}

function skip(entry: Check, summary: string): Check {
  entry.status = "skip";
  entry.summary = summary;
  return entry;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function defaultCheckoutRoot(): string | undefined {
  // src/doctor.ts and dist/zenius.mjs both sit two levels below the checkout.
  const root = url.fileURLToPath(new URL("../../", import.meta.url));
  return isDirectory(path.join(root, "runtime")) ? path.resolve(root) : undefined;
}

function vendorDir(o: Resolved): string | undefined {
  const dir = o.checkoutRoot && path.join(o.checkoutRoot, "runtime", "vendor", "fx-autoconfig");
  return dir && isDirectory(dir) ? dir : undefined;
}

/** HEAD of a checkout, read from .git without running git. */
export function gitHead(root: string): string | undefined {
  try {
    let gitDir = path.join(root, ".git");
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"))?.[1];
      if (!pointer) return undefined;
      gitDir = path.resolve(root, pointer.trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
    const ref = head.slice(5);
    let common = gitDir;
    try {
      common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // not a linked worktree
    }
    for (const dir of [gitDir, common]) {
      try {
        return fs.readFileSync(path.join(dir, ref), "utf8").trim();
      } catch {
        // packed
      }
    }
    const line = fs
      .readFileSync(path.join(common, "packed-refs"), "utf8")
      .split("\n")
      .find((entry) => entry.endsWith(` ${ref}`));
    return line?.split(" ")[0];
  } catch {
    return undefined;
  }
}

function readIni(file: string): Map<string, Map<string, string>> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1]!, current);
      continue;
    }
    const equals = line.indexOf("=");
    if (current && equals > 0) current.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return sections;
}

/**
 * What holds Codex in the sidebar: codexEnvironment's limits
 * (runtime/JS/agent-sidebar/workspace.sys.mjs, with ce1e535's), as zen-eval's
 * probes of Codex 0.169 found them. Code Mode's exec reaches nothing by
 * itself, and apply_patch can't write, but its check reads the target first
 * and says which case it found.
 */
const CODEX_LIMITS = [
  "Codex runs read-only: no shell, no writes, and no network outside zenius and its hosted web search, live in Work and cached in Chat. Its sub-agents are off, and the sidebar refuses every approval it asks for.",
  "One read path is left: apply_patch's check can tell Codex whether a file exists, or whether it holds a given line, though not what the file says.",
  "Setting zenius.agentSidebar.allowCodex to false in about:config turns Codex off, with no restart.",
];

const DNS_PREF = "network.dns.disableIPv6";

/**
 * No IPv6 lookups in Zen is an install's option: scripts/install.sh
 * --disable-ipv6 (the user's choice for their own install, 2026-11-20; opt-in
 * since 77d83f5) puts network.dns.disableIPv6 true in the profile's user.js,
 * under a "// zenius" comment, and Zen applies user.js at each start. Without
 * the flag, install leaves user.js as it is, so false or unset is fine: only
 * zenius's line with the running value false is worth a warning. The running
 * Zen's value comes from browser.health; with Zen closed, or a runtime from
 * before that report, from user.js.
 */
function dnsCheck(o: Resolved, profileDir: string | undefined, live: Live, installed: boolean): Check {
  const entry = check("dns", "DNS");
  if (o.dev) return skip(entry, `not checked: ${o.instance} is a dev instance`);
  const userJs = profileDir ? dnsInUserJs(path.join(profileDir, "user.js")) : undefined;
  const byInstall = userJs?.zenius ? ", set by install.sh at the user's request" : "";
  const optIn = "scripts/install.sh --disable-ipv6 turns them off";
  const running = live.health?.dnsDisableIPv6;
  if (running === true) {
    entry.summary = `${DNS_PREF}: true${byInstall} (no IPv6 lookups in Zen)`;
  } else if (running === false && userJs?.zenius) {
    warn(
      entry,
      [
        "zenius's install sets it to true at the user's request, and someone turned it off in about:config: ask the user whether they did.",
        "Zen's next start sets it to true again, from the profile's user.js.",
      ],
      `${DNS_PREF}: false, so Zen looks up IPv6 addresses`,
    );
  } else if (running === false) {
    entry.summary = `${DNS_PREF}: false (Zen looks up IPv6 addresses; ${optIn})`;
  } else if (!userJs) {
    skip(entry, `not checked: ${live.health ? "this runtime doesn't report it" : "Zen isn't answering"}, and ${o.sandboxed ? "the sandbox can't read the profile" : "there's no profile"}`);
  } else if (userJs.value === "true") {
    entry.summary = `${DNS_PREF}: true in the profile's user.js${byInstall} (no IPv6 lookups in Zen)`;
  } else if (installed) {
    entry.summary = `${DNS_PREF} isn't true in the profile's user.js (Zen looks up IPv6 addresses; ${optIn})`;
  } else {
    skip(entry, "not checked: zenius isn't installed in this profile");
  }
  return entry;
}

/**
 * network.dns.disableIPv6 as user.js sets it: the last line wins, as at Zen's
 * start. zenius: install.sh's own line, under its "// zenius" comment.
 */
function dnsInUserJs(file: string): { value?: string; zenius: boolean } {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { zenius: false };
  }
  let value: string | undefined;
  for (const match of text.matchAll(/^\s*user_pref\(\s*"network\.dns\.disableIPv6"\s*,\s*(.*?)\s*\)\s*;/gm)) value = match[1];
  const zenius = /^\/\/ zenius\b.*\n\s*user_pref\(\s*"network\.dns\.disableIPv6"\s*,\s*true\s*\)\s*;/m.test(text);
  return { value, zenius: zenius && value === "true" };
}

/**
 * The user's setting for agents' page code (zen-observe's
 * observe/pagecode.sys.mjs). zenius.agentTabs.pageCode is always (the
 * default), ask or never, and any other value acts as ask.
 * zenius.agentTabs.pageCodeSites lists the sites the user allowed. Only the
 * user sets them, so doctor reports them and never warns (the manager).
 */
function pageCodeCheck(profileDir: string | undefined): Check {
  const entry = check("pagecode", "agents' page code");
  if (!profileDir) return skip(entry, "not checked: no profile");
  const raw = profilePref(profileDir, "zenius.agentTabs.pageCode");
  const mode = prefString(raw)?.trim().toLowerCase();
  const setting =
    raw === undefined
      ? "always (the default)"
      : mode === "always" || mode === "ask" || mode === "never"
        ? mode
        : `ask (zenius.agentTabs.pageCode is ${raw}, which acts as ask)`;
  const sites = (prefString(profilePref(profileDir, "zenius.agentTabs.pageCodeSites")) ?? "").split(",").filter((site) => site.trim()).length;
  entry.summary = `${setting}; ${sites === 0 ? "no allowed sites listed" : `${plural(sites, "allowed site")} listed`}`;
  return entry;
}

/** zenius.* prefs from prefs.js or user.js, values as written. */
function readPrefs(file: string): Map<string, string> {
  const prefs = new Map<string, string>();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return prefs;
  }
  for (const match of text.matchAll(/^\s*user_pref\(\s*"(zenius\.[^"]*)"\s*,\s*(.*?)\s*\)\s*;/gm)) {
    prefs.set(match[1]!, match[2]!);
  }
  return prefs;
}

/** One pref's raw value in a prefs.js or user.js (the last line wins), or undefined. */
function readPref(file: string, name: string): string | undefined {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let value: string | undefined;
  for (const match of text.matchAll(new RegExp(`^\\s*user_pref\\(\\s*"${escaped}"\\s*,\\s*(.*?)\\s*\\)\\s*;`, "gm"))) value = match[1];
  return value;
}

/** A pref's raw value as Zen starts with it: user.js first, since Zen applies it over prefs.js at every start. */
function profilePref(profileDir: string, name: string): string | undefined {
  return readPref(path.join(profileDir, "user.js"), name) ?? readPref(path.join(profileDir, "prefs.js"), name);
}

/** The scripts fx-autoconfig's userChromeJS.scriptsDisabled names in prefs.js or user.js (the last line wins). */
function scriptsDisabled(file: string): string[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let value: string | undefined;
  for (const match of text.matchAll(/^\s*user_pref\(\s*"userChromeJS\.scriptsDisabled"\s*,\s*("(?:[^"\\]|\\.)*")\s*\)\s*;/gm)) value = match[1];
  if (value === undefined) return [];
  try {
    return String(JSON.parse(value)).split(",").map((name) => name.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Links where install.sh writes copies, and in fx-autoconfig's loader. */
function linksIn(profileDir: string): { path: string; target: string }[] {
  const chrome = path.join(profileDir, "chrome");
  const links: { path: string; target: string }[] = [];
  const visit = (relative: string, depth: number) => {
    const full = path.join(chrome, relative);
    let stat: import("node:fs").Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      let target = "?";
      try {
        target = fs.readlinkSync(full);
      } catch {
        // unreadable link
      }
      links.push({ path: relative, target });
      return;
    }
    if (stat.isDirectory() && depth < 8 && links.length < 20) {
      for (const name of listDir(full)) visit(path.join(relative, name), depth + 1);
    }
  };
  for (const relative of ["JS/zenius.uc.js", "JS/zenius", "utils"]) visit(relative, 0);
  // chrome/ and chrome/JS themselves, without walking the user's other scripts.
  for (const relative of [".", "JS"]) {
    try {
      const full = path.join(chrome, relative);
      if (fs.lstatSync(full).isSymbolicLink()) links.push({ path: relative === "." ? "" : relative, target: fs.readlinkSync(full) });
    } catch {
      // absent
    }
  }
  return links;
}

function readJson<T>(file: string): { value?: T; error?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { error: "missing" };
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { error: "not a JSON object" };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function which(name: string, searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

function run(command: string, args: string[]): string | undefined {
  try {
    const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
    return execFileSync(command, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function require_(id: string): unknown {
  return process.getBuiltinModule(id);
}

function sameContent(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const real = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return real(a) === real(b);
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  return listDir(dir).filter((name) => isFile(path.join(dir, name)));
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function tildify(value: string, home: string): string {
  return home && home !== "/" ? value.split(`${home}/`).join("~/") : value;
}

function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

/** "a, b and c" */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(count: number, noun: string): string {
  if (count === 0) return "";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
