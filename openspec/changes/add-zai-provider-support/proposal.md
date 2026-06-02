# Proposal: add-zai-provider-support

## Why

Claude Code can be pointed at third-party Anthropic-compatible backends via
`~/.claude/settings.json` (`env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN`). The most
popular is **z.ai** (GLM models). Claude Code keeps writing the same JSONL to
`~/.claude/projects/**/*.jsonl`, including `message.model` (e.g. `glm-4.6`, `glm-4.5-air`, or a
mapped `claude-*`). The extension is **incorrect** under z.ai today:

| ID | Problem |
|----|---------|
| Z-1 | `calculateCost` always applies the hardcoded Claude Sonnet tier (`$3 / $15 / $0.30 / $3.75` per 1M). GLM-4.7/4.6 is `$0.6 / $2.2`, GLM-4.5-Air `$0.2 / $1.1` — displayed cost is ~3–7× too high. |
| Z-2 | `detectProvider()` calls `readCredentials()` first; a stale `claudeAiOauth` in `.credentials.json` makes it return `claude-ai`, firing a pointless OAuth call to `api.anthropic.com` and showing rate-limit % unrelated to z.ai. z.ai's `env` lives in `settings.json`, which the extension host's `process.env` never sees. |
| Z-3 | The `message.model` field already present in JSONL is unused, so per-model pricing is impossible. |

## What Changes

- **Z-3 / Z-1** → A new `src/data/pricing.ts` resolves a `TokenPricing` per JSONL entry from its
  `message.model` via a built-in, user-overridable price table (z.ai GLM + Claude tiers). Cost is
  computed per entry, so mixed Claude+GLM usage is priced correctly. `<synthetic>` and free
  flash models price at 0.
- **Z-2** → `detectProvider()` reads `ANTHROPIC_BASE_URL` (from `process.env`, then
  `~/.claude/settings.json`, then `settings.local.json`) **first**. A non-Anthropic host returns
  `z-ai` (host contains `z.ai`) or `custom-endpoint`, suppressing the misleading Anthropic
  rate-limit call. These providers use cost-only mode (no rate-limit %), like Bedrock/api-key.
- New setting `claudeStatus.pricing.models` (per-model override map) and two new
  `claudeStatus.claudeProvider` enum values (`z-ai`, `custom-endpoint`).
- Status-bar/WebView provider labels for the new providers.

## Impact

- Affected specs: `cost-pricing`, `provider-detection` (both new).
- Affected code: `src/data/pricing.ts` (new), `src/data/jsonlReader.ts`,
  `src/data/projectCost.ts`, `src/webview/heatmap.ts`, `src/data/apiClient.ts`,
  `src/data/dataManager.ts`, `src/statusBar.ts`, `src/webview/panel.ts`, `src/config.ts`,
  `package.json`, `package.nls.json`, `package.nls.ja.json`, `package.nls.zh-cn.json`.
- New tests under `src/test/suite/`.
- No new runtime dependencies. Fully backward compatible: when no `ANTHROPIC_BASE_URL` and no
  per-model match, behaviour is unchanged (flat `config.tokenPricing`).
