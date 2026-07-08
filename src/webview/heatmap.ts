import { calculateCost, PricingContext, createPricingResolver } from '../data/pricing';
import { discoverFiles, loadEntries } from '../data/entryCache';

export interface DailyUsage {
  date: string        // "YYYY-MM-DD" local time
  cost: number        // USD
  sessionCount: number
  tokensTotal: number
}

export interface HourlyUsage {
  hour: number        // 0–23 (local time)
  avgCost: number     // USD average per entry
  count: number       // total entries at this hour
}

export interface HeatmapData {
  daily: DailyUsage[]
  hourly: HourlyUsage[]
  generatedAt: Date
}

export interface EntryForHeatmap {
  timestamp: number   // ms
  cost: number        // USD
  tokens: number      // input + output tokens
  hour: number        // 0–23 local
}

// ---- helpers ----------------------------------------------------------------

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---- aggregation (exported for tests) --------------------------------------

export function aggregateByDay(entries: EntryForHeatmap[], days: number): DailyUsage[] {
  const byDate = new Map<string, DailyUsage>();
  for (const e of entries) {
    const key = toLocalDateKey(e.timestamp);
    const d = byDate.get(key) ?? { date: key, cost: 0, sessionCount: 0, tokensTotal: 0 };
    d.cost += e.cost;
    d.tokensTotal += e.tokens;
    d.sessionCount++;
    byDate.set(key, d);
  }

  // Fill every day in the window, including zero-activity days
  const result: DailyUsage[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = toLocalDateKey(now - i * 24 * 3600 * 1000);
    result.push(byDate.get(key) ?? { date: key, cost: 0, sessionCount: 0, tokensTotal: 0 });
  }
  return result;
}

export function aggregateByHour(entries: EntryForHeatmap[], days: number): HourlyUsage[] {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, totalCost: 0, count: 0 }));

  for (const e of entries) {
    if (e.timestamp < cutoff) { continue; }
    byHour[e.hour].totalCost += e.cost;
    byHour[e.hour].count++;
  }

  return byHour.map(h => ({
    hour: h.hour,
    avgCost: h.count > 0 ? h.totalCost / h.count : 0,
    count: h.count,
  }));
}

// ---- main entry point -------------------------------------------------------

export async function getHeatmapData(days = 90, ctx: PricingContext = {}): Promise<HeatmapData> {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const priceFor = createPricingResolver(ctx);

  // Files modified within the window, from the shared cache (parsed once across consumers).
  const files = await discoverFiles(cutoff);
  const entries = await loadEntries(files);

  const allEntries: EntryForHeatmap[] = [];
  for (const e of entries) {
    if (e.timestamp < cutoff) { continue; }
    allEntries.push({
      timestamp: e.timestamp,
      cost: calculateCost(e.usage, priceFor(e.model)),
      tokens: (e.usage.input_tokens || 0) + (e.usage.output_tokens || 0),
      hour: new Date(e.timestamp).getHours(),
    });
  }

  return {
    daily: aggregateByDay(allEntries, days),
    hourly: aggregateByHour(allEntries, 30),   // always use last 30 days for hourly
    generatedAt: new Date(),
  };
}
