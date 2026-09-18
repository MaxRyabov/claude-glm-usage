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
| QF-2 | `zaiUnitToMs` maps `unit: 6` (weeks) to one day, so a weekly window with no `nextResetTime` reports a one-day reset horizon instead of seven. The same map calls `unit: 5` minutes when it means months; that is currently masked only because `TIME_LIMIT` is filtered out by type, and stops being masked the moment the type filter widens — which QF-1 requires it to. |
| QF-3 | Payloads without `unit`/`number` (the pre-2026-09 shape) yield a window length of 0, so the weekly window is never identified and `has7dLimit` is false. |
| QF-4 | An authentication failure arrives as HTTP 200 + `success: false` and is parsed as 0 % used, bypassing the whole cache → stale → local-only degradation ladder. |
| QF-5 | The `Bearer` → raw-token retry is gated on HTTP 401/403, which the live API never returns, so the fallback is unreachable in production. |
| QF-6 | New tariffs report absolute credits (used / cap / remaining) and a plan tier that the extension currently discards entirely. |
| QF-7 | `cacheToRateLimitData` derives `has7dLimit` from `reset7dAt > 0`, but `writeCache` always stores `now + resetIn7d` (~1.8 × 10⁹). Every cached read therefore claims a weekly window exists — for **all** providers, including Anthropic Pro. |
| QF-8 | A fully consumed z.ai window reports `allowed_warning`, never `denied`, so the red status-bar state is unreachable for z.ai even at 100 %. |

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
- **QF-8** → Report `denied` once a window is fully consumed.
- **New, required by the QF-4 fix**: rejecting a bad token turns a cached success into a thrown
  error, and the poll scheduler calls the API on every 60-second tick while no cache exists. The
  change therefore also records authentication failures so they are not retried before the cache
  TTL elapses, and surfaces a distinct "key rejected" state — without it the fix would trade a
  wrong number for a request every thirty seconds, against the project's rule of at most one call
  per five minutes when idle.
- `parseZaiQuota` remains a total function that never throws; `fetchZaiQuota` keeps the
  `throws` contract that `DataManager` already converts into a cached/stale/cost-only view.
- **BREAKING (internal only)**: the on-disk cache schema goes to `version: 4`. A v4 reader still
  accepts a v3 file for reading and always writes v4, so a window running the previous extension
  version cannot get into a mutual-invalidation loop with an updated one. The dashboard snapshot
  schema is deliberately left at `version: 1` — the new fields are optional and the existing
  validator accepts them, and invalidating snapshots would cost every user the instant cold-start
  render that `optimize-dashboard-loading` exists to provide.

## Capabilities

### New Capabilities
- `zai-quota-parsing`: How the z.ai quota payload is classified, normalised and failed —
  covering both tariff generations, the credit and token billing models, window identification,
  reset horizons, authentication failures and their retry policy, and how the results reach the
  cache and the dashboard.

### Modified Capabilities
<!-- None. `openspec/specs/` holds no synced specs, so there is no spec file to amend. The
     "z.ai quota display" requirement in add-zai-provider-support stays as the general statement
     that the provider shows a quota; this capability complements it with the parsing detail.
     The overlap is resolved when both changes are synced, not by this proposal. -->

## Impact

- **Affected specs**: `zai-quota-parsing` (new). Complements — does not remove — the "z.ai quota
  display" requirement in `openspec/changes/add-zai-provider-support/specs/provider-detection/spec.md`.
- **Affected code**: `src/data/apiClient.ts` (core), `src/data/dataManager.ts`,
  `src/data/cache.ts`, `src/statusBar.ts`, `src/webview/panel.ts`, the l10n bundles.
- **New tests**: `src/test/suite/anthropicRateLimit.test.ts`; extensions to
  `providerDetection.test.ts`, `cache.test.ts` and `panel.test.ts`.
- **Anthropic regression surface**: the cache schema and the webview are shared across providers,
  and `fetchRateLimitData` has no test coverage today. It gains an injectable `fetchImpl` so the
  Anthropic header path can be asserted unchanged.
- **Branch dependency**: this change adds user-facing strings, so it must be built on a `main`
  that already contains PR #5 (Russian localization). That PR introduces `l10n/bundle.l10n.ru.json`
  and the locale parity test; neither exists on `main` yet, and adding strings before it lands
  would leave the Russian bundle incomplete the moment it merges.
- **User-visible**: users on older z.ai tariffs will start seeing a weekly quota row and weekly
  notifications that never appeared before — that is the fix for QF-3, and it belongs in the
  changelog. Anthropic Pro users stop seeing a phantom weekly row (QF-7). A fully consumed z.ai
  window now turns the status bar red (QF-8). A rejected key is now reported as such instead of
  showing zeros.
- **Out of scope**: the monthly MCP allowance (`TIME_LIMIT`) is classified so it cannot be
  mistaken for a quota window, but is not displayed; other monitor endpoints are untouched.
