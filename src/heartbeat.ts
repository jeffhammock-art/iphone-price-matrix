import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface Heartbeat {
  ts: string;
  modelId: string;
  captured: number;
  skipped: number;
  lastEvent: string;
  pid: number;
}

export function heartbeatPath(dataDir: string): string {
  return join(dataDir, ".heartbeat.json");
}

export async function writeHeartbeat(dataDir: string, heartbeat: Omit<Heartbeat, "ts" | "pid"> & { pid?: number }): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const payload: Heartbeat = {
    ts: new Date().toISOString(),
    pid: heartbeat.pid ?? process.pid,
    modelId: heartbeat.modelId,
    captured: heartbeat.captured,
    skipped: heartbeat.skipped,
    lastEvent: heartbeat.lastEvent,
  };
  await writeFile(heartbeatPath(dataDir), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readHeartbeat(dataDir: string): Promise<Heartbeat | null> {
  try {
    return JSON.parse(await readFile(heartbeatPath(dataDir), "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}
