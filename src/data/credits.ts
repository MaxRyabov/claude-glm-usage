// z.ai coding-plan credits (§) for a single assistant turn.
//
// The z.ai coding plan bills usage in credits, not USD: one turn costs
// (input × m.input + cache_read × m.cacheRead + output × m.output) / 10000 credits,
// with the multiplier set by the model tier and halved outside peak hours
// (weekdays 06:00–10:00 UTC — see peakHours.ts). cache_creation is not billed
// separately: z.ai folds cache writes into the input term. Billing follows the spec
// filter (design.md): a model is billed when its name contains "glm" or "flash"
// (the GLM family, including flash tiers); claude-* and unknown models contribute
// nothing.
import { TokenUsage } from './pricing';

export interface CreditMultipliers {
  input: number
  cacheRead: number
  output: number
}

// GLM-5.3 base tier (quota handbook multipliers; see add-statusbar-peak-ctx-units D7).
export const GLM_CREDIT_MULTIPLIERS: CreditMultipliers = { input: 6.9, cacheRead: 1.7, output: 24 };
// Flash tier carries the triple discount, matching the published price ratio.
export const GLM_FLASH_CREDIT_MULTIPLIERS: CreditMultipliers = { input: 2.3, cacheRead: 0.56, output: 8 };

export const CREDITS_DIVISOR = 10_000;
export const OFF_PEAK_FACTOR = 0.5;

/** Whether a model is billed in z.ai credits (GLM family, incl. every flash tier). */
export function isCreditModel(model: string | undefined): boolean {
  const name = (model ?? '').toLowerCase();
  return name.includes('glm') || name.includes('flash');
}

/** Flash models get the discounted multiplier tier, everything else the base one. */
export function creditMultipliersFor(model: string | undefined): CreditMultipliers {
  return (model ?? '').toLowerCase().includes('flash')
    ? GLM_FLASH_CREDIT_MULTIPLIERS
    : GLM_CREDIT_MULTIPLIERS;
}

export interface CreditEntry {
  model?: string
  usage: TokenUsage
}

/**
 * Credits charged for one assistant turn. `peakActive` must be computed from the
 * turn's own timestamp — isPeakAt(turn.timestamp) on the UsageEntry this record
 * came from — not the current moment: an off-peak turn stays half-price after the
 * window closes. Non-GLM turns cost 0 credits.
 */
export function creditsForEntry(entry: CreditEntry, peakActive: boolean): number {
  if (!isCreditModel(entry.model)) { return 0; }
  const m = creditMultipliersFor(entry.model);
  const weighted =
    (entry.usage.input_tokens || 0) * m.input +
    (entry.usage.cache_read_input_tokens || 0) * m.cacheRead +
    (entry.usage.output_tokens || 0) * m.output;
  const credits = weighted / CREDITS_DIVISOR;
  return peakActive ? credits : credits * OFF_PEAK_FACTOR;
}
