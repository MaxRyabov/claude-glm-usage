# Tasks: add-zai-provider-support

## 1. Pricing module (per-model rates)
- [x] 1.1 Create `src/data/pricing.ts`: move `TokenPricing` + `DEFAULT_PRICING` here; add
  `MODEL_PRICING` table (z.ai GLM + Claude tiers) and `resolvePricing()` with longest-prefix
  matching and the 4-step precedence (override → table → provider default → fallback)
- [x] 1.2 Re-export `TokenPricing`, `DEFAULT_PRICING`, `calculateCost` from `jsonlReader.ts` for
  back-compat
- [x] 1.3 `<synthetic>` / empty / free flash models resolve to all-zero pricing
- [x] 1.4 TEST: `src/test/suite/pricing.test.ts` — longest-prefix (glm-5.1 vs glm-5 vs
  glm-5-turbo; glm-4.5-air vs glm-4.5), claude-opus/sonnet/haiku, override precedence, z-ai
  provider default → GLM-4.7, `<synthetic>`→0, flash→0, unknown→fallback

## 2. Thread per-model pricing through aggregation
- [x] 2.1 Add `model?: string` to `JsonlEntry.message` (jsonlReader.ts)
- [x] 2.2 `readAllUsage()` accepts a `PricingContext` and resolves pricing per entry from
  `entry.message?.model`
- [x] 2.3 `projectCost.ts` aggregation resolves pricing per entry
- [x] 2.4 `heatmap.ts` resolves pricing per entry (if it computes cost)
- [x] 2.5 `dataManager.ts` builds the `PricingContext` from `config` + detected `providerType`
  and passes it to `readAllUsage`/`getAllProjectCosts`/heatmap
- [x] 2.6 TEST: `jsonlReader.test.ts` — mixed `glm-*`/`claude-*` entries blend to correct cost;
  `model` field is read

## 3. Provider detection (base-URL-first)
- [x] 3.1 Extend `ClaudeProvider` union with `'z-ai' | 'custom-endpoint'` (apiClient.ts)
- [x] 3.2 Add exported `readClaudeBaseUrl()` reading `process.env` → `settings.json` →
  `settings.local.json` `env.ANTHROPIC_BASE_URL`, confined to `~/.claude`, tolerant of
  missing/malformed files
- [x] 3.3 `detectProvider()` checks base URL first: non-anthropic host → `z-ai` (host contains
  `z.ai`) else `custom-endpoint`; keep claude-ai/bedrock/api-key fallback chain
- [x] 3.4 TEST: detection — z.ai base URL + stale `claudeAiOauth` present → `z-ai` (regression
  guard); non-z.ai custom URL → `custom-endpoint`; no base URL → unchanged behaviour

## 4. UI, config, manifest, i18n
- [x] 4.1 `statusBar.ts` buildTooltip: labels `z-ai → "Z.AI / GLM"`, `custom-endpoint → "Custom endpoint"`
- [x] 4.2 `webview/panel.ts`: provider label string for the new providers
- [x] 4.3 `config.ts`: add `pricingModels` getter (`pricing.models`, default `{}`)
- [x] 4.4 `package.json`: add `z-ai`/`custom-endpoint` to `claudeProvider` enum + enumDescriptions;
  add `claudeStatus.pricing.models` (object) setting
- [x] 4.5 i18n: add nls strings in `package.nls.json`, `package.nls.ja.json`, `package.nls.zh-cn.json`
- [x] 4.6 TEST: `statusBar.test.ts` — `providerType: 'z-ai'` → Z.AI label + cost mode
- [x] 4.7 TEST: `manifest.test.ts` — enum has `z-ai`/`custom-endpoint`; `pricing.models` key present

## 7. z.ai quota display + dedup fix (added after initial cost-only design)
- [x] 7.1 `apiClient.ts`: `readClaudeEnvVar()` + `readZaiToken()` (AUTH_TOKEN → API_KEY)
- [x] 7.2 `apiClient.ts`: `parseZaiQuota()` (5h vs weekly by window duration) + `fetchZaiQuota()`
  (Bearer token, origin-derived `/api/monitor/usage/quota/limit`)
- [x] 7.3 `dataManager.ts`: fetch z.ai quota for `z-ai` with cache + graceful fallback to cost-only
- [x] 7.4 `statusBar.ts` + `webview/panel.ts`: show rate-limit % for `z-ai` (percent mode, 7d row,
  warning colors, prediction gauge); local-only stays cost-only
- [x] 7.5 `projectCost.ts`: deduplicate streaming lines by `requestId`/`message.id` (cost over-count fix)
- [x] 7.6 TEST: `parseZaiQuota` (5h/weekly map, warning, empty input), `readZaiToken`/`readClaudeEnvVar`
- [x] 7.7 TEST: `projectCost` dedup counts each requestId once and prices by model

## 5. Documentation
- [x] 5.1 README (en/ja/zh): z.ai setup section + provider table rows
- [x] 5.2 `docs/SETTINGS.md`, `docs/DATA.md` (per-model pricing), `docs/ARCHITECTURE.md` (provider table)
- [x] 5.3 `CHANGELOG.md`: entry under `## [Unreleased]`

## 6. Final gate
- [x] 6.1 `npm run lint` clean
- [x] 6.2 `npm test` fully green
- [ ] 6.3 Archive the OpenSpec change and open PR `feat/zai-provider-support` → `main`
