import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CrashSignature =
  | "empty_pickers_after_color"
  | "cloudflare_challenge"
  | "execution_context_destroyed"
  | "configurator_did_not_boot"
  | "missing_radios"
  | "heartbeat_stall"
  | "profile_lock"
  | "unknown";

export interface DenylistEntry {
  key: string;
  until: string;
  signature: CrashSignature;
  reason: string;
}

export interface SignatureStats {
  count: number;
  lastAt: string;
  playbook: string;
}

export interface HealState {
  denylist: DenylistEntry[];
  signatures: Record<string, SignatureStats>;
  deaths: { at: string; signature: CrashSignature; modelId: string }[];
}

const HOUR_MS = 60 * 60 * 1000;
const LEAF_DENY_TTL_MS = HOUR_MS;

export const LEAF_GROUP_IDS = ["grades", "battery", "storage", "dual_sim", "color"] as const;

export function isLeafPath(path: Record<string, string>): boolean {
  return LEAF_GROUP_IDS.every((id) => typeof path[id] === "string" && path[id].length > 0);
}

export function healStatePath(dataDir: string): string {
  return join(dataDir, "heal-state.json");
}

export function pathKey(path: Record<string, string>): string {
  return JSON.stringify(path);
}

export async function loadHealState(dataDir: string): Promise<HealState> {
  try {
    const raw = JSON.parse(await readFile(healStatePath(dataDir), "utf8")) as HealState;
    return {
      denylist: raw.denylist ?? [],
      signatures: raw.signatures ?? {},
      deaths: raw.deaths ?? [],
    };
  } catch {
    return { denylist: [], signatures: {}, deaths: [] };
  }
}

export async function saveHealState(dataDir: string, state: HealState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(healStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function pruneHealState(state: HealState, now = Date.now()): HealState {
  const untilOk = state.denylist.filter((entry) => Date.parse(entry.until) > now);
  const deaths = state.deaths.filter((death) => now - Date.parse(death.at) < HOUR_MS * 6);
  return { ...state, denylist: untilOk, deaths };
}

export function isDenylisted(state: HealState, path: Record<string, string>, now = Date.now()): boolean {
  const key = pathKey(path);
  return state.denylist.some((entry) => entry.key === key && Date.parse(entry.until) > now);
}

export function classifyText(text: string): CrashSignature {
  const blob = text.toLowerCase();
  if (blob.includes("existing browser session") || blob.includes("profile is already in use") || blob.includes("processsingleton")) {
    return "profile_lock";
  }
  if (blob.includes("heartbeat_stall") || blob.includes("heartbeat stall")) {
    return "heartbeat_stall";
  }
  if (blob.includes("just a moment") || blob.includes("cdn-cgi") || blob.includes("testchallengepage")) {
    return "cloudflare_challenge";
  }
  if (blob.includes("now {}") || blob.includes("now {} ()") || /now \{\s*\}/.test(text)) {
    return "empty_pickers_after_color";
  }
  if (blob.includes("execution context was destroyed") || blob.includes("frame was detached") || blob.includes("target closed")) {
    return "execution_context_destroyed";
  }
  if (blob.includes("configurator did not boot")) {
    return "configurator_did_not_boot";
  }
  if (blob.includes("waiting for") && blob.includes("step-grades")) {
    return "missing_radios";
  }
  return "unknown";
}

export function playbookFor(signature: CrashSignature): string {
  switch (signature) {
    case "empty_pickers_after_color":
      return "reload_hub_log_empty_settled_no_deny";
    case "cloudflare_challenge":
      return "wait_headed_profile_no_fast_restart";
    case "execution_context_destroyed":
      return "wait_settle_retry_click";
    case "configurator_did_not_boot":
      return "reopen_product";
    case "missing_radios":
      return "reload_hub";
    case "heartbeat_stall":
      return "kill_tree_and_resume";
    case "profile_lock":
      return "kill_profile_chrome_retry";
    default:
      return "resume_only";
  }
}

export async function denyLeafPath(
  dataDir: string,
  path: Record<string, string>,
  reason = "settled empty leaf after reload",
): Promise<boolean> {
  if (!isLeafPath(path)) return false;
  let state = pruneHealState(await loadHealState(dataDir));
  const key = pathKey(path);
  state.denylist = state.denylist.filter((entry) => entry.key !== key);
  state.denylist.push({
    key,
    until: new Date(Date.now() + LEAF_DENY_TTL_MS).toISOString(),
    signature: "empty_pickers_after_color",
    reason,
  });
  await saveHealState(dataDir, state);
  return true;
}

export async function rememberSignature(
  dataDir: string,
  signature: CrashSignature,
  extra?: { path?: Record<string, string>; modelId?: string; death?: boolean },
): Promise<HealState> {
  let state = pruneHealState(await loadHealState(dataDir));
  const now = new Date().toISOString();
  const stats = state.signatures[signature] ?? { count: 0, lastAt: now, playbook: playbookFor(signature) };
  stats.count += 1;
  stats.lastAt = now;
  stats.playbook = playbookFor(signature);
  state.signatures[signature] = stats;

  if (signature === "empty_pickers_after_color" && extra?.path && Object.keys(extra.path).length > 0) {
    // P1: never denylist non-leaf paths. Transient empty reads during SPA
    // navigation must not poison coverage. Leaf-only denial goes through
    // denyLeafPath() after settled + reloaded verification.
    if (isLeafPath(extra.path)) {
      const key = pathKey(extra.path);
      state.denylist = state.denylist.filter((entry) => entry.key !== key);
      state.denylist.push({
        key,
        until: new Date(Date.now() + LEAF_DENY_TTL_MS).toISOString(),
        signature,
        reason: "settled empty leaf after reload",
      });
    }
  }

  if (extra?.death) {
    state.deaths.push({ at: now, signature, modelId: extra.modelId ?? "" });
  }

  await saveHealState(dataDir, state);
  return state;
}

export function deathsInWindow(state: HealState, modelId: string, windowMs = HOUR_MS, now = Date.now()): number {
  return state.deaths.filter((death) => death.modelId === modelId && now - Date.parse(death.at) < windowMs).length;
}

export function signatureHitsInWindow(
  state: HealState,
  signature: CrashSignature,
  windowMs: number,
  minCount: number,
  now = Date.now(),
): boolean {
  const stats = state.signatures[signature];
  if (!stats) return false;
  if (now - Date.parse(stats.lastAt) > windowMs) return false;
  return stats.count >= minCount;
}

export function extractWantedPath(coverageLine: string): Record<string, string> | null {
  const match = coverageLine.match(/wanted (\{.*?\}) now /);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as Record<string, string>;
  } catch {
    return null;
  }
}

export function backoffMs(deathCount: number): number {
  if (deathCount <= 1) return 5_000;
  if (deathCount === 2) return 15_000;
  if (deathCount === 3) return 30_000;
  return 60_000;
}
