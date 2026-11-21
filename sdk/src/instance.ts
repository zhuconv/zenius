// Which Zen instance a script talks to, and where its socket is.
//
//   --instance <name>  >  ZENIUS_INSTANCE  >  "default"
//   ZENIUS_SOCKET overrides the socket path outright (tests, unusual setups).
//   ZENIUS_HOME overrides ~/.zenius.

import { fs, os, path } from "./node.ts";

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

export function readInstanceRecord(name: string, env: NodeJS.ProcessEnv = process.env): InstanceRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(zeniusHome(env), "instances", `${name}.json`), "utf8"));
    return record && typeof record === "object" ? { ...record, instance: record.instance || name } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The socket for an instance. The conventional path needs no file read, which
 * keeps the agent's first request off the disk; the registry only matters when
 * the runtime chose another path.
 */
export function socketPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZENIUS_SOCKET) return env.ZENIUS_SOCKET;
  const record = readInstanceRecord(name, env);
  if (record?.socket) return record.socket;
  return path.join(zeniusHome(env), "run", `${name}.sock`);
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
