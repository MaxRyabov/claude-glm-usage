# Proposal: support-zai-quota-formats

## Why

z.ai has two live generations of its quota payload. New (credit-based) tariffs answer
`GET {origin}/api/monitor/usage/quota/limit` with `CREDIT_LIMIT` entries carrying absolute
credit amounts; older token-based tariffs keep answering with percentage-only
`TOKENS_LIMIT` entries. Our parser filters on `type === 'TOKENS_LIMIT'`, so on a new tariff
**every quota window is discarded and the extension reports 0 % used** — the status bar,
the dashboard gauges and the rate-limit notifications are all silently wrong.

Verifying this against two live accounts surfaced a second, independent defect: z.ai answers
a rejected API key with **HTTP 200** and `{"success": false}`, not 401. `fetchZaiQuota` only
checks `response.ok`, so an expired token is parsed as a healthy idle account, cached with
`dataSource: 'api'`, and shown as a confident "0 % used" indefinitely.

| ID | Problem |
|----|---------|
| QF-1 | `CREDIT_LIMIT` entries are filtered out, so new-tariff accounts show 0 % on every window. |
| QF-2 | `zaiUnitToMs` maps `unit: 5` to minutes and `unit: 6` to days; the real codes are 3 = hours, 5 = months, 6 = weeks. A monthly MCP allowance can therefore be mistaken for a quota window. |
| QF-3 | Payloads without `unit`/`number` (the pre-2026-09 shape) yield a window length of 0, so the weekly window is never identified and `has7dLimit` is false. |
| QF-4 | An authentication failure arrives as HTTP 200 + `success: false` and is parsed as 0 % used, bypassing the whole cache → stale → local-only degradation ladder. |
| QF-5 | The `Bearer` → raw-token retry is gated on HTTP 401/403, which the live API never returns, so the fallback is unreachable in production. |
| QF-6 | New tariffs report absolute credits (used / cap / remaining) and a plan tier that the extension currently discards entirely. |
| QF-7 | `cacheToRateLimitData` derives `has7dLimit` from `reset7dAt > 0`, but `writeCache` always stores `now + resetIn7d` (~1.8 × 10⁹). Every cached read therefore claims a weekly window exists — for **all** providers, including Anthropic Pro. |

## What Changes

- **QF-1 / QF-2 / QF-3** → Replace window detection with per-entry duck typing ported from the
  reference implementation: classify by `(type, unit)` when stated, fall back to array position
  with a six-hour veto horizon when it is not. There is deliberately **no global format-version
  switch**, so half-migrated payloads degrade per entry rather than wholesale.
- **QF-4 / QF-5** → Inspect the `{code, msg, success, data}` envelope before parsing. Treat only
  an explicit `success: false` as a failure, map `code` to a status, and drive the auth-variant
  retry off the failure class rather than the HTTP status. Never surface `msg` (z.ai returns it
  in Chinese or English at random, ignoring `Accept-Language`).
- **QF-6** → Carry the credit amounts and plan tier through to the dashboard as optional fields.
- **QF-7** → Persist `has7dLimit` explicitly in the cache instead of inferring it.
- `parseZaiQuota` remains a total function that never throws; `fetchZaiQuota` keeps the
  `throws` contract that `DataManager` already converts into a cached/stale/cost-only view.
- **BREAKING (internal only)**: the on-disk cache schema goes to `version: 4` and the dashboard
  snapshot to `version: 2`. Both validators are fail-closed, so existing files are rejected and
  refetched once. No user-visible migration.

## Capabilities

### New Capabilities
- `zai-quota-parsing`: How the z.ai quota payload is classified, normalised and failed —
  covering both tariff generations, the credit and token billing models, window identification,
  reset horizons, and envelope-level authentication failures.

### Modified Capabilities
<!-- None. `openspec/specs/` holds no synced specs, so the z.ai quota requirement in
     add-zai-provider-support is superseded by the new capability above rather than
     amended in place. -->

## Impact

- **Affected specs**: `zai-quota-parsing` (new). Supersedes the "z.ai quota display" requirement
  in `openspec/changes/add-zai-provider-support/specs/provider-detection/spec.md`.
- **Affected code**: `src/data/apiClient.ts` (core), `src/data/dataManager.ts`,
  `src/data/cache.ts`, `src/data/snapshotCache.ts`, `src/webview/panel.ts`,
  `l10n/bundle.l10n.{ru,ja,zh-cn}.json`.
- **New tests**: `src/test/suite/anthropicRateLimit.test.ts`; extensions to
  `providerDetection.test.ts` and `panel.test.ts`.
- **Anthropic regression surface**: the cache schema, the snapshot schema and the webview are
  shared across providers, and `fetchRateLimitData` has no test coverage today. It gains an
  injectable `fetchImpl` so the Anthropic header path can be asserted unchanged.
- **User-visible**: users on older z.ai tariffs will start seeing a weekly quota row and
  weekly notifications that never appeared before — that is the fix for QF-3, and it belongs
  in the changelog. Anthropic Pro users stop seeing a phantom weekly row (QF-7).
- **Out of scope**: the monthly MCP allowance (`TIME_LIMIT`) is classified so it cannot be
  mistaken for a quota window, but is not displayed; other monitor endpoints are untouched.
