// Pure, side-effect-free rate-limit notification decision logic.
//
// Notifications are driven by the actual remaining quota fraction (utilization5h /
// utilization7d), NOT by a time-to-exhaustion prediction. This keeps the trigger
// provider-agnostic (claude.ai and z.ai both expose utilization windows) and avoids
// the false positives the old burn-rate model produced near a window reset.
//
// The function is deliberately free of any `vscode` import so it can be unit-tested
// without the Electron host — see prediction.ts / statusBar.ts for the same pattern.

import type { ClaudeProvider } from './apiClient';
import { DataSource, actsOnRateData } from './pollOutcome';

export type NotifySeverity = 'warning' | 'error';

export interface RateLimitNotification {
  /** Dedup key, scoped per window + bucket: '5h-92', '7d-85'. */
  key: string;
  window: '5h' | '7d';
  severity: NotifySeverity;
  /** Reached bucket as an integer percent (90, 92, … / 80, 85, 90). */
  percentUsed: number;
  /** Seconds until that window resets (passed through for the message text). */
  resetIn: number;
  /** True only when the 5h limit is fully consumed (100%). */
  reached: boolean;
}

export interface RateLimitThresholds {
  fiveHourStartPercent: number;  // default 90
  fiveHourStepPercent: number;   // default 2
  sevenDayStartPercent: number;  // default 80
  sevenDayEndPercent: number;    // default 90
  sevenDayStepPercent: number;   // default 5
}

/**
 * How far the observed window end may move forward without counting as a rollover.
 *
 * The end is estimated as `now + resetIn`, and that estimate wobbles between polls: reset
 * headers are whole seconds, a cached reset is read against a later clock, and a window that
 * already ended reports resetIn 0, so its estimate creeps forward with the clock. A rollover
 * moves the end by a whole window — five hours at the least — so an hour sits far above the
 * wobble and far below the jump. Zero would turn every wobble into a rollover and re-arm
 * warnings already shown.
 */
const ROLLOVER_TOLERANCE_SEC = 3600;

/**
 * Whether a quota window has rolled over since the previous live observation.
 *
 * Compares absolute window ends (epoch seconds), not the remaining seconds: notifications only
 * act on live data, so observations can be hours apart. With remaining seconds, a gap that
 * spans a rollover and ends deep into the next window leaves the new remainder below the old
 * one, the rollover goes unseen, and the new window never re-arms its warnings. An absolute
 * end stays constant within a window and jumps by a whole window at a rollover, however long
 * the gap. The first observation has nothing to compare with and is not a rollover. The end must
 * move by more than ROLLOVER_TOLERANCE_SEC to count.
 */
export function windowRolledOver(prevEndAt: number | null, resetIn: number, nowSec: number): boolean {
  if (prevEndAt === null) { return false; }
  return nowSec + resetIn > prevEndAt + ROLLOVER_TOLERANCE_SEC;
}

/**
 * The utilization and reset times notifications may act on, or null when they are not current.
 *
 * Without live data (a refused key, cost-only mode) the numbers are an old cache or zeros.
 * 'stale' is excluded too: the startup snapshot's reset times are as old as the snapshot (see
 * actsOnRateData).
 * Acting on them raised "92% used" for a window nobody could see, and a switch from zeros back
 * to real reset times looked like a window rollover, re-arming notifications already shown.
 */
export function rateSignalsFor(
  data: RateLimitUsage & { providerType: ClaudeProvider; dataSource: DataSource },
): RateLimitUsage | null {
  if (!actsOnRateData(data.providerType, data.dataSource)) { return null; }
  const { utilization5h, utilization7d, resetIn5h, resetIn7d, has7dLimit } = data;
  return { utilization5h, utilization7d, resetIn5h, resetIn7d, has7dLimit };
}

export interface RateLimitUsage {
  utilization5h: number;  // fraction 0..1
  utilization7d: number;  // fraction 0..1
  resetIn5h: number;      // seconds
  resetIn7d: number;      // seconds
  has7dLimit: boolean;
}

/**
 * Highest step bucket reached for a utilization percentage, or null when below the
 * start threshold. `cap` clamps the bucket to a maximum (used for the 7d window).
 *
 * Examples (start=90, step=2): 91 → 90, 99 → 98, 100 → 100.
 * Examples (start=80, step=5, cap=90): 84 → 80, 85 → 85, 92 → 90.
 */
export function bucketFor(
  percent: number,
  start: number,
  step: number,
  cap?: number,
): number | null {
  if (step <= 0) { return null; }
  // Guard against malformed utilization (NaN / Infinity) so we never emit a
  // '5h-NaN' bucket or a nonsensical notification.
  if (!Number.isFinite(percent)) { return null; }
  // utilization*100 introduces float error (e.g. 0.98*100 = 97.9999…); nudge by a tiny
  // epsilon so values sitting on a step boundary land in the correct bucket.
  const EPS = 1e-9;
  if (percent < start - EPS) { return null; }
  // Uncapped window (5h) fully consumed → always surface a clean 100 bucket, regardless
  // of whether `step` evenly divides 100. Otherwise a custom step (e.g. 3) would floor
  // percent=100 down to 99 and the "5h rate limit reached" alert would never fire.
  if (cap === undefined && percent >= 100 - EPS) { return 100; }
  const capped = cap !== undefined ? Math.min(percent, cap) : percent;
  // Anchor buckets to `start` (not 0) so arbitrary user-configured start/step combos still
  // land on the intended step sequence and never report a bucket below the configured start.
  return start + Math.floor((capped - start + EPS) / step) * step;
}

/**
 * Decide which rate-limit notifications should fire for the current usage snapshot.
 * Only buckets NOT present in `alreadyNotified` are returned. Utilization is monotonic
 * within a window, so only the current (highest) bucket per window is emitted — skipped
 * intermediate steps from a coarse poll interval are intentionally not back-filled.
 */
export function decideRateLimitNotifications(
  usage: RateLimitUsage,
  thresholds: RateLimitThresholds,
  alreadyNotified: ReadonlySet<string>,
): RateLimitNotification[] {
  const out: RateLimitNotification[] = [];

  // --- 5h window ---
  const pct5h = usage.utilization5h * 100;
  const bucket5h = bucketFor(
    pct5h,
    thresholds.fiveHourStartPercent,
    thresholds.fiveHourStepPercent,
  );
  if (bucket5h !== null) {
    const key = `5h-${bucket5h}`;
    if (!alreadyNotified.has(key)) {
      const reached = bucket5h >= 100;
      out.push({
        key,
        window: '5h',
        severity: reached ? 'error' : 'warning',
        percentUsed: bucket5h,
        resetIn: usage.resetIn5h,
        reached,
      });
    }
  }

  // --- 7d window (only when the provider/plan exposes one) ---
  if (usage.has7dLimit && usage.utilization7d > 0) {
    const pct7d = usage.utilization7d * 100;
    const bucket7d = bucketFor(
      pct7d,
      thresholds.sevenDayStartPercent,
      thresholds.sevenDayStepPercent,
      thresholds.sevenDayEndPercent,
    );
    if (bucket7d !== null) {
      const key = `7d-${bucket7d}`;
      if (!alreadyNotified.has(key)) {
        out.push({
          key,
          window: '7d',
          severity: 'warning',
          percentUsed: bucket7d,
          resetIn: usage.resetIn7d,
          reached: false,
        });
      }
    }
  }

  return out;
}
