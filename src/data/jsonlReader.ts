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
} from './entryCache';

// Re-export the pricing primitives so existing importers keep working unchanged.
export { TokenUsage, TokenPricing, DEFAULT_PRICING, PricingContext, calculateCost, resolvePricing };
// Re-export the path helpers (moved to entryCache to break the import cycle) so existing
// importers/tests that pull them from this module keep working unchanged.
export { getClaudeProjectsDir, isSafePath };

export interface AggregatedUsage {
  cost5h: number
  costDay: number
  cost7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number
}

export async function readAllUsage(ctx: PricingContext = {}): Promise<AggregatedUsage> {
  const now = Date.now();
  const window5h = 5 * 3600 * 1000;
  const window7d = 7 * 24 * 3600 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const result: AggregatedUsage = {
    cost5h: 0,
    costDay: 0,
    cost7d: 0,
    tokensIn5h: 0,
    tokensOut5h: 0,
    tokensCacheRead5h: 0,
    tokensCacheCreate5h: 0,
  };

  // Only the last 7 days matter for any window here, so skip files untouched since then.
  const files = await discoverFiles(now - window7d);
  const entries = await loadEntries(files);
  const priceFor = createPricingResolver(ctx);

  for (const entry of entries) {
    const ts = entry.timestamp;
    const usage = entry.usage;
    const cost = calculateCost(usage, priceFor(entry.model));

    const age = now - ts;
    if (age <= window7d) {
      result.cost7d += cost;
    }
    if (ts >= startOfToday.getTime()) {
      result.costDay += cost;
    }
    if (age <= window5h) {
      result.cost5h += cost;
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
