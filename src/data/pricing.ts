// Per-model token pricing.
//
// Claude Code writes the model name into each JSONL entry at `message.model`
// (e.g. "claude-opus-4-7", or "glm-4.6" when Claude Code is pointed at z.ai). This
// module resolves the correct USD rates for a given model so cost is accurate across
// providers, including mixed Claude + GLM usage in the same window.

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface TokenPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreatePerMillion: number
}

// Flat default — Claude Sonnet 4.x rates. Used as the final fallback so behaviour is
// unchanged when no model match and no custom provider are in play.
export const DEFAULT_PRICING: TokenPricing = {
  inputPerMillion: 3.00,
  outputPerMillion: 15.00,
  cacheReadPerMillion: 0.30,
  cacheCreatePerMillion: 3.75,
};

const ZERO_PRICING: TokenPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheCreatePerMillion: 0,
};

// z.ai default tier — GLM-4.7, the model the z.ai coding plan maps the default
// Sonnet/Opus slots to. Used when the provider is z.ai but the model name is unknown
// (e.g. z.ai mapped a "claude-*" name server-side that we don't recognise as GLM).
const ZAI_DEFAULT_PRICING: TokenPricing = {
  inputPerMillion: 0.60,
  outputPerMillion: 2.20,
  cacheReadPerMillion: 0.11,
  cacheCreatePerMillion: 0.60,
};

// Built-in price table (USD per 1M tokens), matched by longest case-insensitive prefix
// of the model name. z.ai figures come from the official pricing page
// (https://docs.z.ai/guides/overview/pricing); `cacheRead` = "Cached Input". z.ai
// publishes no separate cache-write tier, so `cacheCreate` mirrors the input rate.
// Re-verify before release — the GLM lineup changes often (current flagship: GLM-5.1).
export const MODEL_PRICING: Record<string, TokenPricing> = {
  // --- z.ai GLM (text) ---
  'glm-5.1':         { inputPerMillion: 1.40, outputPerMillion: 4.40, cacheReadPerMillion: 0.26, cacheCreatePerMillion: 1.40 },
  'glm-5-turbo':     { inputPerMillion: 1.20, outputPerMillion: 4.00, cacheReadPerMillion: 0.24, cacheCreatePerMillion: 1.20 },
  'glm-5':           { inputPerMillion: 1.00, outputPerMillion: 3.20, cacheReadPerMillion: 0.20, cacheCreatePerMillion: 1.00 },
  'glm-4.7-flashx':  { inputPerMillion: 0.07, outputPerMillion: 0.40, cacheReadPerMillion: 0.01, cacheCreatePerMillion: 0.07 },
  'glm-4.7-flash':   ZERO_PRICING,
  'glm-4.7':         { inputPerMillion: 0.60, outputPerMillion: 2.20, cacheReadPerMillion: 0.11, cacheCreatePerMillion: 0.60 },
  'glm-4.6':         { inputPerMillion: 0.60, outputPerMillion: 2.20, cacheReadPerMillion: 0.11, cacheCreatePerMillion: 0.60 },
  'glm-4.5-airx':    { inputPerMillion: 1.10, outputPerMillion: 4.50, cacheReadPerMillion: 0.22, cacheCreatePerMillion: 1.10 },
  'glm-4.5-air':     { inputPerMillion: 0.20, outputPerMillion: 1.10, cacheReadPerMillion: 0.03, cacheCreatePerMillion: 0.20 },
  'glm-4.5-x':       { inputPerMillion: 2.20, outputPerMillion: 8.90, cacheReadPerMillion: 0.45, cacheCreatePerMillion: 2.20 },
  'glm-4.5-flash':   ZERO_PRICING,
  'glm-4.5':         { inputPerMillion: 0.60, outputPerMillion: 2.20, cacheReadPerMillion: 0.11, cacheCreatePerMillion: 0.60 },
  // --- Anthropic Claude ---
  'claude-opus':     { inputPerMillion: 15.00, outputPerMillion: 75.00, cacheReadPerMillion: 1.50, cacheCreatePerMillion: 18.75 },
  'claude-sonnet':   { inputPerMillion: 3.00,  outputPerMillion: 15.00, cacheReadPerMillion: 0.30, cacheCreatePerMillion: 3.75 },
  'claude-haiku':    { inputPerMillion: 0.80,  outputPerMillion: 4.00,  cacheReadPerMillion: 0.08, cacheCreatePerMillion: 1.00 },
};

// Keys sorted longest-first so the most specific prefix wins (e.g. "glm-4.5-air"
// before "glm-4.5", "glm-5-turbo" before "glm-5").
const MODEL_PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

export interface PricingContext {
  /** User per-model overrides from `claudeStatus.pricing.models` (keyed by model name/prefix). */
  userOverrides?: Record<string, TokenPricing>
  /** Detected provider, used for the provider-default tier when the model is unknown. */
  providerType?: string
  /** Final fallback when nothing else matches (defaults to {@link DEFAULT_PRICING}). */
  fallback?: TokenPricing
}

function matchLongestPrefix(
  normalizedModel: string,
  table: Record<string, TokenPricing> | undefined,
  presortedKeys?: string[],
): TokenPricing | undefined {
  if (!table) { return undefined; }
  const keys = presortedKeys ?? Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalizedModel.startsWith(key.toLowerCase())) {
      return table[key];
    }
  }
  return undefined;
}

/**
 * Resolve the {@link TokenPricing} for a model name. Precedence:
 *   1. user override (`pricing.models`) — longest prefix
 *   2. built-in table — longest prefix
 *   3. provider default (z-ai → GLM-4.7)
 *   4. fallback (flat `config.tokenPricing`, default Claude Sonnet)
 * `<synthetic>`, empty/undefined models, and free flash tiers resolve to zero.
 */
export function resolvePricing(model: string | undefined, ctx: PricingContext = {}): TokenPricing {
  const fallback = ctx.fallback ?? DEFAULT_PRICING;
  const norm = (model ?? '').trim().toLowerCase();

  if (!norm || norm === '<synthetic>') { return ZERO_PRICING; }

  // Merge onto the fallback so a partial user override (e.g. only inputPerMillion —
  // the pricing.models schema marks no field required) never leaves a rate undefined,
  // which would multiply into NaN in calculateCost and poison every downstream total.
  const override = matchLongestPrefix(norm, ctx.userOverrides);
  if (override) { return { ...fallback, ...override }; }

  const builtin = matchLongestPrefix(norm, MODEL_PRICING, MODEL_PRICING_KEYS);
  if (builtin) { return builtin; }

  if (ctx.providerType === 'z-ai') { return ZAI_DEFAULT_PRICING; }

  return fallback;
}

/**
 * Build a memoized pricing resolver for one aggregation pass. Resolving a model's
 * pricing walks the prefix table; in a pass that touches thousands of entries the same
 * handful of model names repeat constantly, so caching by model name avoids redundant
 * lookups. (Technique borrowed from the CodeDash project's `findModelPricing`.)
 */
export function createPricingResolver(
  ctx: PricingContext = {},
): (model: string | undefined) => TokenPricing {
  const memo = new Map<string, TokenPricing>();
  return (model: string | undefined): TokenPricing => {
    const key = model ?? '';
    let pricing = memo.get(key);
    if (pricing === undefined) {
      pricing = resolvePricing(model, ctx);
      memo.set(key, pricing);
    }
    return pricing;
  };
}

export function calculateCost(usage: TokenUsage, pricing: TokenPricing = DEFAULT_PRICING): number {
  return (
    ((usage.input_tokens || 0) / 1_000_000) * pricing.inputPerMillion +
    ((usage.output_tokens || 0) / 1_000_000) * pricing.outputPerMillion +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheReadPerMillion +
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cacheCreatePerMillion
  );
}
