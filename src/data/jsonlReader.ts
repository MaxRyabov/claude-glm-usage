import {
  TokenUsage,
  TokenPricing,
  DEFAULT_PRICING,
  PricingContext,
  calculateCost,
  resolvePricing,
  createPricingResolver,
} from './pricing';
import {
  discoverFiles,
  loadEntries,
  getClaudeProjectsDir,
  isSafePath,
  UsageEntry,
} from './entryCache';
import { creditsForEntry } from './credits';
import { isPeakAt } from './peakHours';

// Re-export the pricing primitives so existing importers keep working unchanged.
export { TokenUsage, TokenPricing, DEFAULT_PRICING, PricingContext, calculateCost, resolvePricing };
// Re-export the path helpers (moved to entryCache to break the import cycle) so existing
// importers/tests that pull them from this module keep working unchanged.
export { getClaudeProjectsDir, isSafePath };

export interface AggregatedUsage {
  cost5h: number
  costDay: number
  cost7d: number
  // z.ai credits for the same windows, accumulated in the same pass: only GLM turns
  // contribute (creditsForEntry), off-peak turns at half price by their own timestamp.
  credits5h: number
  creditsDay: number
  credits7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number
}

export async function readAllUsage(ctx: PricingContext = {}): Promise<AggregatedUsage> {
  const now = Date.now();
  // Only the last 7 days matter for any window here, so skip files untouched since then.
  const files = await discoverFiles(now - 7 * 24 * 3600 * 1000);
  const entries = await loadEntries(files);
  return aggregateUsage(entries, now, ctx);
}

/**
 * Pure window aggregation — USD and z.ai credits in one pass over the entries. Split out
 * of readAllUsage so the window arithmetic (5h / since local midnight / 7d, the GLM-only
 * credit filter) is testable against fixed entries instead of the live ~/.claude tree.
 */
export function aggregateUsage(
  entries: ReadonlyArray<UsageEntry>,
  now: number,
  ctx: PricingContext = {},
): AggregatedUsage {
  const window5h = 5 * 3600 * 1000;
  const window7d = 7 * 24 * 3600 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const result: AggregatedUsage = {
    cost5h: 0,
    costDay: 0,
    cost7d: 0,
    credits5h: 0,
    creditsDay: 0,
    credits7d: 0,
    tokensIn5h: 0,
    tokensOut5h: 0,
    tokensCacheRead5h: 0,
    tokensCacheCreate5h: 0,
  };

  const priceFor = createPricingResolver(ctx);

  for (const entry of entries) {
    const ts = entry.timestamp;
    const usage = entry.usage;
    const cost = calculateCost(usage, priceFor(entry.model));
    const credits = creditsForEntry(entry, isPeakAt(ts));

    const age = now - ts;
    if (age <= window7d) {
      result.cost7d += cost;
      result.credits7d += credits;
    }
    if (ts >= startOfToday.getTime()) {
      result.costDay += cost;
      result.creditsDay += credits;
    }
    if (age <= window5h) {
      result.cost5h += cost;
      result.credits5h += credits;
      result.tokensIn5h += usage.input_tokens || 0;
      result.tokensOut5h += usage.output_tokens || 0;
      result.tokensCacheRead5h += usage.cache_read_input_tokens || 0;
      result.tokensCacheCreate5h += usage.cache_creation_input_tokens || 0;
    }
  }

  return result;
}

export async function wasJsonlUpdatedRecently(seconds: number): Promise<boolean> {
  // Reuse the cached directory walk + mtime window from entryCache: any file in the
  // window means there was recent activity.
  const recent = await discoverFiles(Date.now() - seconds * 1000);
  return recent.length > 0;
}
