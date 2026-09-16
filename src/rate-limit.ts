/**
 * Adaptive request pacing + rate-limit trip detection.
 *
 * The crawl is browser-driven and already settles ~1.5s per navigation, but
 * parallel tabs + retry loops can still burst hundreds of page loads and trip
 * the edge WAF. This module:
 *   - enforces a minimum wall-clock gap between real page loads (with jitter),
 *   - escalates to exponential backoff when a 403/429/challenge is seen,
 *   - trips a run-wide abort once sustained blocking is detected, so we STOP
 *     and surface "cooldown needed" instead of silently retry-looping.
 */

const BASE_PACE_MS = 1500; // overlaps settle; keeps a gentle floor on bursts
const JITTER_MS = 700;
const BACKOFF_STEPS_MS = [3_000, 6_000, 12_000, 20_000, 30_000];
const ABORT_AFTER_NAV_HITS = 6; // run-wide challenge/block signals before abort

let outboundNavs = 0;
let blockHits = 0;
let backoffIndex = 0;

/**
 * Per-browser-instance last-navigation timestamps.
 * Each parallel worker gets its own slot so they don't serialize on a global lock.
 * Browser IDs are created lazily in paceNetwork().
 */
const lastNavPerBrowser = new Map<string, number>();

/**
 * Per-page-instance last-navigation timestamps.
 * Each parallel tab gets its own slot so they don't serialize on each other.
 * Pages are tagged with a unique ID when created (see setPagePaceId in crawl.ts).
 */
const lastNavPerPage = new Map<string, number>();

/** Assign a unique pacing ID to a page/tab. Call once per page, e.g. on creation. */
export function setPagePaceId(page: any, id: string): void {
  if (page && typeof page === 'object') page._paceId = id;
}

/** Read the pacing ID from a page, falling back to browser-based ID for legacy callers. */
export function pagePaceId(page: Page): string {
  if (page && (page as any)._paceId) return String((page as any)._paceId);
  // Legacy fallback: derive from browser (single-tab runs only).
  if (page && typeof page === 'object' && 'browser' in page) {
    return browserId((page as any).browser());
  }
  return Math.random().toString(36).slice(2, 11);
}

/** Simple hash of a browser instance to get a stable ID. */
export function browserId(browser: any): string {
  if (browser && typeof browser === 'object' && '__id' in browser) return String((browser as any).__id);
  return Math.random().toString(36).slice(2, 11);
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Backoff we must use for the *next* network call, if any. */
function currentBackoffMs(): number {
  return backoffIndex >= BACKOFF_STEPS_MS.length
    ? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]
    : BACKOFF_STEPS_MS[backoffIndex];
}

/**
 * Call before every real page load (page.goto). Returns ms actually slept.
 * Uses a per-browser timestamp so parallel workers don't serialize on each other.
 * @param bid Unique identifier for this browser instance (e.g. from browserId()).
 */
export async function paceNetwork(page: Page): Promise<number> {
  const bid = pagePaceId(page);
  const now = Date.now();
  const jitter = Math.floor(Math.random() * JITTER_MS);
  const wanted = (backoffIndex > 0 ? currentBackoffMs() : BASE_PACE_MS) + jitter;
  const lastNavAt = lastNavPerPage.get(bid) || 0;
  let slept = 0;
  if (lastNavAt > 0) {
    const gap = now - lastNavAt;
    if (gap < wanted) {
      slept = wanted - gap;
      await new Promise((resolve) => setTimeout(resolve, slept));
    }
  }
  lastNavPerPage.set(bid, Date.now());
  outboundNavs += 1;
  return slept;
}

/**
 * Register a block/challenge signal (403, 429, Cloudflare challenge, or the
 * /en-gb/help || /p/gb/ bounce). Escalates backoff; throws RateLimitError once
 * sustained blocking is confirmed so the run aborts with a clean message.
 */
export function registerBlock(signal: string): void {
  blockHits += 1;
  if (backoffIndex < BACKOFF_STEPS_MS.length) backoffIndex += 1;
  if (blockHits >= ABORT_AFTER_NAV_HITS) {
    const wait = currentBackoffMs();
    throw new RateLimitError(
      `Sustained blocking detected (${blockHits} hits, last: ${signal}). ` +
        `Cooldown needed. Wait at least 5 minutes, then re-run single model.`,
    );
  }
}

/** Non-fatal backoff used inside the openProduct retry loop. */
export async function backoffOnBlock(): Promise<number> {
  registerBlock("open");
  const ms = currentBackoffMs();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms;
}

/** Hook for a single model to track consecutive stall events. */
export const STALL_ABORT_AFTER = 8;

export function addOutboundNav(): void {
  outboundNavs += 1; // eslint-disable-line no-unused-expressions
}

export function stats(): { outboundNavs: number; blockHits: number; backoffIndex: number } {
  return { outboundNavs, blockHits, backoffIndex };
}

/** Reset between runs (mainly tests); keeps module-level counters sane. */
export function reset(): void {
  lastNavPerPage.clear();
  outboundNavs = 0;
  blockHits = 0;
  backoffIndex = 0;
}