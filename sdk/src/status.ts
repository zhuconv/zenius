// `zenius status`: which Zen instances are registered and whether they answer.

import { instanceName, isProcessAlive, listInstanceRecords, socketPath, type InstanceRecord } from "./instance.ts";
import { net } from "./node.ts";
import { PROTOCOL_VERSION, type Hello } from "./rpc.ts";

const PROBE_TIMEOUT_MS = 500;

export async function statusText(selectedFlag: string | undefined): Promise<string> {
  const selected = instanceName(selectedFlag);
  const records = listInstanceRecords();
  if (!records.some((record) => record.instance === selected)) {
    records.push({ instance: selected, socket: socketPath(selected) });
  }
  const rows = await Promise.all(records.map((record) => describe(record, selected)));
  return [`selected instance: ${selected}`, ...rows].join("\n");
}

async function describe(record: InstanceRecord, selected: string): Promise<string> {
  const socket = record.socket || socketPath(record.instance);
  const hello = await probe(socket);
  const alive = record.pid === undefined ? undefined : isProcessAlive(record.pid);
  let state: string;
  if (hello) {
    state = hello.protocol !== undefined && hello.protocol !== PROTOCOL_VERSION ? `protocol ${hello.protocol} (CLI speaks ${PROTOCOL_VERSION})` : "ready";
  } else if (alive) {
    state = "not answering";
  } else if (record.pid !== undefined) {
    state = "stale (process gone)";
  } else {
    state = "not running";
  }
  const parts = [`${record.instance === selected ? "*" : " "} ${record.instance}`, state];
  if (record.pid !== undefined) parts.push(`pid ${record.pid}`);
  const zen = hello?.zenVersion ?? record.zenVersion;
  const runtime = hello?.runtimeVersion ?? record.runtimeVersion;
  if (zen) parts.push(`zen ${zen}`);
  if (runtime) parts.push(`runtime ${runtime}`);
  parts.push(`socket ${socket}`);
  if (record.profileDir) parts.push(`profile ${record.profileDir}`);
  if (record.startedAt) parts.push(`started ${record.startedAt}`);
  return parts.join("  ");
}

/** Connect, read the hello frame, and hang up. */
function probe(path: string): Promise<Hello | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    const socket = net().createConnection(path);
    const done = (hello?: Hello) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(hello);
    };
    const timer = setTimeout(() => done(undefined), PROBE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("error", () => done(undefined));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = JSON.parse(buffer.slice(0, newline));
        done(frame?.event === "hello" ? (frame.params ?? {}) : {});
      } catch {
        done({});
      }
    });
  });
}
