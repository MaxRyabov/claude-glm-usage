# Design: add-zai-provider-support

## Context

The extension reads Claude Code usage from `~/.claude/projects/**/*.jsonl` and computes cost
with a single hardcoded Claude tier. Third-party Anthropic-compatible providers (z.ai/GLM,
and others reached via a custom `ANTHROPIC_BASE_URL`) write the same JSONL but bill at very
different rates, and their config lives in `~/.claude/settings.json` rather than the extension
host's `process.env`. Two capabilities are addressed: **cost-pricing** (per-model rates) and
**provider-detection** (recognise non-Anthropic endpoints).

## Decisions

### 1. Per-model pricing resolver (`src/data/pricing.ts`)
`TokenPricing` + `DEFAULT_PRICING` move into `pricing.ts`; `jsonlReader.ts` re-exports them so
existing imports keep working. A built-in `MODEL_PRICING` table maps a normalised model key to
`TokenPricing`. Matching is **longest-prefix-wins** on a lower-cased model string so
`glm-4.5-air` beats `glm-4.5` and `glm-5-turbo` beats `glm-5`.

`resolvePricing(model, { providerType, userOverrides, fallback })` precedence:
1. `userOverrides[model]` (the `claudeStatus.pricing.models` map, matched case-insensitively by
   longest prefix) →
2. built-in `MODEL_PRICING` longest-prefix match →
3. provider default — `z-ai` → GLM-4.7 rates (the coding-plan default model mapping) →
4. `fallback` (today's flat `config.tokenPricing`).

`<synthetic>`, empty/undefined model, and free flash models (`glm-4.7-flash`, `glm-4.5-flash`)
resolve to all-zero pricing.

Prices are from the official z.ai pricing page (`cacheRead` = "Cached Input"; z.ai publishes no
separate cache-write tier, so `cacheCreate` = input rate). Claude tiers retain current values.

### 2. Cost computed per entry
`calculateCost(usage, pricing)` is unchanged. Callers (`readAllUsage`, `projectCost`
aggregation, `heatmap`) resolve pricing per entry from `entry.message?.model` before calling it.
Their signatures change from taking a bare `TokenPricing` to a `PricingContext`
(`{ userOverrides, providerType, fallback }`) so rule 3/4 work without global state. The
`DataManager` builds the context once from `config` + the detected `providerType` and passes it
down.

### 3. Base-URL-first provider detection (`src/data/apiClient.ts`)
`ClaudeProvider` gains `'z-ai'` and `'custom-endpoint'`. A new exported helper
`readClaudeBaseUrl()` returns `ANTHROPIC_BASE_URL` from, in order: `process.env`,
`~/.claude/settings.json`, `~/.claude/settings.local.json` (the `env` object). File reads are
confined to `~/.claude` (reuse the `validateCredentialsPath` confinement pattern) and tolerate
missing/malformed JSON (graceful degradation).

`detectProvider()` checks the base URL **before** credentials: a set, non-`api.anthropic.com`
host returns `z-ai` (host includes `z.ai`) or `custom-endpoint`. This removes the stale-OAuth
false positive. The existing claude-ai → bedrock → api-key probes remain as the fallback chain.

### 3a. z.ai quota fetch (added after initial cost-only design)
z.ai exposes the 5-hour + weekly quota from its subscription dashboard via an internal but
stable endpoint `GET {origin}/api/monitor/usage/quota/limit` (`Authorization: Bearer <token>`,
`Accept: application/json`), used by several existing usage trackers. The response holds
`data.limits[]`; `TOKENS_LIMIT` entries carry `percentage` (0–100) and `nextResetTime` (epoch
ms), with `unit`/`number` describing the window. `parseZaiQuota()` distinguishes the windows by
duration (short < 1 day → 5-hour, long → weekly) rather than the `unit` code, which varies by
plan. The token comes from `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` (env → settings.json →
settings.local.json via `readClaudeEnvVar`). The monitor URL is derived from the configured
base URL's origin so it works for `api.z.ai` and regional/coding-plan hosts. Missing token or
any error degrades to cost-only mode. Result reuses the existing `RateLimitData` shape and disk
cache, so the status bar/dashboard render z.ai exactly like Claude.ai windows. Non-z.ai custom
endpoints have no comparable endpoint and stay cost-only.

### 3b. Project-cost dedup fix
`projectCost` aggregation did not deduplicate the multiple JSONL lines Claude Code writes per
streaming response, so project costs were over-counted (observed ~16× vs the global figure). It
now applies the same `requestId`/`message.id` dedup `readJsonlFile` uses.

### 4. Cost-only mode is automatic
`DataManager.getUsageData()` already routes every non-`claude-ai` provider to cost-only
`local-only` mode and skips the Anthropic rate-limit call, so `z-ai`/`custom-endpoint` need no
new branch there — only the pricing context must be threaded in.

### 5. UI labels
`statusBar.buildTooltip` and `webview/panel.ts` add labels `z-ai → "Z.AI / GLM"` and
`custom-endpoint → "Custom endpoint"`. Cost mode and the hidden rate-limit panel already
trigger for any non-`claude-ai` provider.

## Testing strategy

`resolvePricing` and `readClaudeBaseUrl` are pure/exported so they unit-test without the
electron host. Provider detection is tested against a temp `settings.json` containing a z.ai
base URL **with a stale `claudeAiOauth` credentials file present** — the core regression guard.
Mixed `glm-*`/`claude-*` JSONL is asserted to produce a blended cost differing from the old
single-tier result. Manifest tests assert the new enum values and the `pricing.models` key.

## Open question
GLM model lineup changes often (current flagship GLM-5.1). The table is seeded from the
official pricing page at authoring time and is fully user-overridable via `pricing.models`;
re-verify before release.
