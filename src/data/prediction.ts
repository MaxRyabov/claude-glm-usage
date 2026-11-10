import { calculateCost } from './jsonlReader';
import { discoverFiles, loadEntries } from './entryCache';
import { creditsForEntry } from './credits';
import { isPeakAt } from './peakHours';
import type { QuotaAmounts } from './apiClient';

export type RecommendationKey =
  | 'safe'
  | 'caution'
  | 'warning'
  | 'critical'
  | 'rate-limit-reached'
  | 'survives-reset';

export interface PredictionData {
  estimatedExhaustionTime: Date | null  // null if pace is slow or unknown
  estimatedExhaustionIn: number | null  // seconds, null if safe/unknown
  currentBurnRate: number               // USD/hour (0 if < 2 entries in window)
  // z.ai credits/hour from the same engine and the same 30-min window; 0 when the
  // window holds fewer than 2 turns.
  burnRateCreditsPerHour: number
  // Remaining credits of the live 5h quota when the quota reports absolute amounts
  // (the credit exhaustion path was taken), else null.
  creditsRemaining5h: number | null
  // null — no exhaustion forecast was built; false — the window survives until reset;
  // true — exhaustion is expected, see estimatedExhaustionIn.
  exhaustsBeforeReset: boolean | null
  budgetRemaining: number | null        // null if no budget set
  budgetExhaustionTime: Date | null
  safeToStartHeavyTask: boolean
  recommendation: string        // English fallback (used by tests)
  recommendationKey: RecommendationKey  // i18n key for UI display
}

export interface TimestampedTurn {
  timestamp: number  // ms
  cost: number       // USD
  credits: number    // z.ai credits (0 for non-GLM turns)
}

async function readRecentTurns(windowMs: number): Promise<TimestampedTurn[]> {
  const now = Date.now();
  const cutoff = now - windowMs;
  const result: TimestampedTurn[] = [];

  // Only files modified within the window can hold entries in it — typically the single
  // active session file, not the whole history. Subagent logs join the same walk, so
  // their GLM turns count towards the burn rate too.
  const files = await discoverFiles(cutoff);
  const entries = await loadEntries(files);
  for (const entry of entries) {
    if (entry.timestamp < cutoff) { continue; }
    const cost = calculateCost(entry.usage);
    const credits = creditsForEntry(entry, isPeakAt(entry.timestamp));
    if (cost > 0 || credits > 0) {
      result.push({ timestamp: entry.timestamp, cost, credits });
    }
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

function burnRatePerHour<T extends { timestamp: number }>(entries: ReadonlyArray<T>, pick: (e: T) => number): number {
  if (entries.length < 2) { return 0; }
  const total = entries.reduce((sum, e) => sum + pick(e), 0);
  const spanMs = Date.now() - entries[0].timestamp;
  const spanHours = spanMs / (1000 * 3600);
  return spanHours > 0 ? total / spanHours : 0;
}

export function calculateBurnRate(entries: ReadonlyArray<{ timestamp: number; cost: number }>): number {
  return burnRatePerHour(entries, (e) => e.cost);
}

/** Credits/hour over the same turns — one engine, two units, so §/h and $/h never diverge. */
export function calculateCreditsBurnRate(entries: ReadonlyArray<{ timestamp: number; credits: number }>): number {
  return burnRatePerHour(entries, (e) => e.credits);
}

export function buildRecommendation(exhaustionIn: number): string {
  if (exhaustionIn < 600)  { return 'Less than 10 min remaining. Save your work and pause.'; }
  if (exhaustionIn < 1800) { return 'Less than 30 min remaining. Wrap up current task.'; }
  if (exhaustionIn < 3600) { return 'About 1 hour remaining. Plan your next task accordingly.'; }
  return 'Plenty of capacity. Safe to start heavy tasks.';
}

export function buildRecommendationKey(exhaustionIn: number): RecommendationKey {
  if (exhaustionIn < 600)  { return 'critical'; }
  if (exhaustionIn < 1800) { return 'warning'; }
  if (exhaustionIn < 3600) { return 'caution'; }
  return 'safe';
}

export interface PredictionInput {
  utilization5h: number
  /** Seconds until the 5h window resets; caps the exhaustion horizon. */
  resetIn5h: number
  /**
   * Window spend in the utilization unit: USD cost5h for claude-ai, locally counted
   * credits5h for z-ai — used by the utilization fallback to estimate capacity.
   */
  spend5h: number
  costToday: number   // USD, for the budget path
  dailyBudget: number | null
  /**
   * Live z.ai quota with absolute credit amounts, when available. The credit
   * exhaustion forecast is built only from it; null → the utilization fallback below.
   * Callers must pass it only for data current enough to act on (actsOnRateData):
   * a stale remainder must not drive a forecast.
   */
  quotaCredits?: QuotaAmounts | null
}

/** Remaining credits of the 5h quota: `remaining` as reported (conservative), else total − used. */
export function quotaCreditsRemaining(quota: QuotaAmounts): number {
  return quota.remaining ?? (quota.total - quota.used);
}

export async function computePrediction(input: PredictionInput): Promise<PredictionData> {
  const turns = await readRecentTurns(30 * 60 * 1000);
  return predictFromTurns(input, turns);
}

/**
 * Pure forecast core over the recent turns — everything computePrediction does after the
 * disk read. Exported so the branch behaviour (quota vs utilization fallback,
 * survives-reset, zero burn) is testable against fixed turns instead of whatever
 * ~/.claude/projects happens to hold during the test run.
 */
export function predictFromTurns(input: PredictionInput, turns: ReadonlyArray<TimestampedTurn>): PredictionData {
  const { utilization5h, resetIn5h, spend5h, costToday, dailyBudget, quotaCredits = null } = input;
  const burnRateUsdPerHour = calculateBurnRate(turns);
  const burnRateCreditsPerHour = calculateCreditsBurnRate(turns);

  // --- Rate limit exhaustion ---
  let estimatedExhaustionTime: Date | null = null;
  let estimatedExhaustionIn: number | null = null;
  let safeToStartHeavyTask = true;
  let recommendation = 'Plenty of capacity. Safe to start heavy tasks.';
  let recommendationKey: RecommendationKey = 'safe';
  let creditsRemaining5h: number | null = null;
  let exhaustsBeforeReset: boolean | null = null;

  if (utilization5h >= 1.0) {
    estimatedExhaustionTime = new Date();
    estimatedExhaustionIn = 0;
    safeToStartHeavyTask = false;
    recommendation = 'Rate limit reached. Wait for reset.';
    recommendationKey = 'rate-limit-reached';
  } else if (quotaCredits) {
    creditsRemaining5h = quotaCreditsRemaining(quotaCredits);
    if (burnRateCreditsPerHour > 0) {
      const secondsUntilExhaustion = (creditsRemaining5h / burnRateCreditsPerHour) * 3600;
      if (secondsUntilExhaustion >= resetIn5h) {
        // The window survives until the reset — say exactly that instead of a time.
        exhaustsBeforeReset = false;
        recommendation = 'The 5h window will not be exhausted before the reset.';
        recommendationKey = 'survives-reset';
      } else {
        // Cap at reset time — exhaustion can't be after the window resets.
        const effectiveSeconds = Math.min(secondsUntilExhaustion, resetIn5h);
        estimatedExhaustionTime = new Date(Date.now() + effectiveSeconds * 1000);
        estimatedExhaustionIn = effectiveSeconds;
        exhaustsBeforeReset = true;
        safeToStartHeavyTask = effectiveSeconds > 1800;
        recommendation = buildRecommendation(effectiveSeconds);
        recommendationKey = buildRecommendationKey(effectiveSeconds);
      }
    }
    // Zero credits burn (no turns in the window) → no exhaustion forecast at all.
  } else if (burnRateUsdPerHour > 0 && utilization5h > 0) {
    // Estimate total capacity: spend5h corresponds to utilization5h fraction used
    const estimatedCapacity = spend5h / utilization5h;
    const remaining = estimatedCapacity * (1.0 - utilization5h);
    const hoursUntilExhaustion = remaining / burnRateUsdPerHour;
    const secondsUntilExhaustion = hoursUntilExhaustion * 3600;
    // Cap at reset time — exhaustion can't be after the window resets
    const effectiveSeconds = Math.min(secondsUntilExhaustion, resetIn5h);

    estimatedExhaustionTime = new Date(Date.now() + effectiveSeconds * 1000);
    estimatedExhaustionIn = effectiveSeconds;
    safeToStartHeavyTask = effectiveSeconds > 1800;
    recommendation = buildRecommendation(effectiveSeconds);
    recommendationKey = buildRecommendationKey(effectiveSeconds);
  }

  // --- Budget exhaustion ---
  let budgetRemaining: number | null = null;
  let budgetExhaustionTime: Date | null = null;

  if (dailyBudget !== null) {
    const remaining = dailyBudget - costToday;
    budgetRemaining = Math.max(0, remaining);
    if (remaining <= 0) {
      budgetExhaustionTime = new Date();
    } else if (burnRateUsdPerHour > 0) {
      const hoursUntil = remaining / burnRateUsdPerHour;
      budgetExhaustionTime = new Date(Date.now() + hoursUntil * 3600 * 1000);
    }
  }

  return {
    estimatedExhaustionTime,
    estimatedExhaustionIn,
    currentBurnRate: burnRateUsdPerHour,
    burnRateCreditsPerHour,
    creditsRemaining5h,
    exhaustsBeforeReset,
    budgetRemaining,
    budgetExhaustionTime,
    safeToStartHeavyTask,
    recommendation,
    recommendationKey,
  };
}
