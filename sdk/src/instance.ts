// Which Zen instance a script talks to, and where its socket is.
//
//   --instance <name>  >  ZENIUS_INSTANCE  >  "default"
//   ZENIUS_SOCKET overrides the socket path outright (tests, unusual setups).
//   ZENIUS_HOME overrides ~/.zenius.

import { ZeniusError } from "./errors.ts";
import { fs, os, path } from "./node.ts";

/**
 * Instance names as the launcher takes them (sdk/sandbox/launcher.sh): with no
 * '/', no name leaves the folder it's joined to, run/, instances/ or
 * selfcheck/. So `--instance ../selfcheck/default` can't turn the agents'
 * socket into the self-check's (zen-observe's review of the self-check).
 */
const INSTANCE_NAME = /^[A-Za-z0-9._-]+$/;

export function isInstanceName(name: string): boolean {
  return INSTANCE_NAME.test(name);
}

/** What a refused name is told, with nothing in it that could act on the terminal. */
export function instanceNameRule(name: string): string {
  const shown = JSON.stringify(name).replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return `an instance name has only letters, digits, '.', '_' and '-': ${shown}`;
}

function checkedName(name: string): string {
  if (!isInstanceName(name)) throw new ZeniusError("ZEN_INVALID_ARGUMENT", instanceNameRule(name));
  return name;
}

export type InstanceRecord = {
  instance: string;
  pid?: number;
  socket?: string;
  profileDir?: string;
  zenVersion?: string;
  runtimeVersion?: string;
  /** {commit, installedAt} of the install.json the runtime loaded at startup; null without one. */
  install?: { commit?: string; installedAt?: string } | null;
  startedAt?: string | number;
};

export function zeniusHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZENIUS_HOME || path.join(os.homedir(), ".zenius");
}

export function instanceName(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return flag || env.ZENIUS_INSTANCE || "default";
}

/** An instance's registry record; none for a name the launcher wouldn't take, by its file's name or its own. */
export function readInstanceRecord(name: string, env: NodeJS.ProcessEnv = process.env): InstanceRecord | undefined {
  if (!isInstanceName(name)) return undefined;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(zeniusHome(env), "instances", `${name}.json`), "utf8"));
    if (!record || typeof record !== "object") return undefined;
    const instance = typeof record.instance === "string" && record.instance ? record.instance : name;
    return isInstanceName(instance) ? { ...record, instance } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The socket for an instance. The conventional path needs no file read, which
 * keeps the agent's first request off the disk; the registry only matters when
 * the runtime chose another path. A name the launcher wouldn't take is refused
 * here, whoever the caller.
 */
export function socketPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  checkedName(name);
  if (env.ZENIUS_SOCKET) return env.ZENIUS_SOCKET;
  const record = readInstanceRecord(name, env);
  if (record?.socket) return record.socket;
  return path.join(zeniusHome(env), "run", `${name}.sock`);
}

/**
 * The self-check's socket (docs/research/selfcheck.md), from the name alone:
 * never ZENIUS_SOCKET or the registry's path, and outside run/, of which
 * zenius's sandbox reaches only the one socket.
 */
export function selfcheckSocket(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(zeniusHome(env), "selfcheck", `${checkedName(name)}.sock`);
}

export function listInstanceRecords(env: NodeJS.ProcessEnv = process.env): InstanceRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(zeniusHome(env), "instances"));
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readInstanceRecord(file.slice(0, -".json".length), env))
    .filter((record): record is InstanceRecord => Boolean(record));
}

export function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
