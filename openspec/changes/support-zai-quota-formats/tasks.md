# Tasks: support-zai-quota-formats

## 1. Window classification (`src/data/apiClient.ts`)

- [ ] 1.1 Remove `zaiUnitToMs`; it is unexported and its unit map is wrong (5 as minutes,
      6 as days). Replace with constants: 3 = hours, 5 = months, 6 = weeks.
- [ ] 1.2 Extend `ZaiLimitEntry` with `currentValue`, `usage`, `remaining`, `usageDetails`, and
      `ZaiQuotaResponse.data` with `level`. Document the inverted `usage`/`currentValue` naming
      inline — it is the single easiest defect to reintroduce.
- [ ] 1.3 Add `isZaiWindowCap` (`TOKENS_LIMIT` or `CREDIT_LIMIT`) and `zaiKindFromUnit`,
      returning the 5-hour, weekly, MCP or other kind, or null when unresolved.
- [ ] 1.4 Add `zaiKindsFromOrder(limits, now)`: six-hour veto horizon, a missing `nextResetTime`
      keeps a candidate eligible, the first eligible window cap takes the 5-hour slot, and
      ordering is trusted when every candidate is vetoed. Index by the full `limits` array.
- [ ] 1.5 Add `zaiResolveKinds(limits, now)`: build the positional map only when some window cap
      is unresolved, with `zaiKindFromUnit` still winning per entry. Include the regex safety net
      for a future dedicated weekly type.
- [ ] 1.6 Add a defensive `zaiLimitsOf(json)` tolerating null, non-objects, a non-array `limits`,
      and null or non-object elements.

## 2. Utilization, reset horizons and amounts

- [ ] 2.1 Derive utilization from `currentValue / usage` when both are finite and `usage` is
      positive, but only when it agrees with `percentage` within 1.5 pp; otherwise use
      `percentage`. Keep `clamp01`.
- [ ] 2.2 Add `zaiWindowSeconds(entry, kind)`: unit times number when resolvable, else five hours
      or seven days by kind.
- [ ] 2.3 Add `zaiResetSeconds(entry, kind, nowSec)`: use `nextResetTime` (epoch milliseconds)
      when it is in the future and within 400 days, else fall back to the window length. Never
      zero for a window that exists.
- [ ] 2.4 Extract `billing`, `planLevel`, `credits5h`, `credits7d`, passing `remaining` through
      unchanged and never recomputing it.
- [ ] 2.5 Make `now` an injectable parameter of `parseZaiQuota`, defaulting to the current time.
- [ ] 2.6 Confirm `parseZaiQuota` still cannot throw on any input path.

## 3. Request-level failure handling

- [ ] 3.1 Add `readZaiEnvelopeFailure(json)`: only an explicit `success: false` is a failure; map
      `code` with 401, 403 and 429 passing through, 1000 and 1001 to 401, anything else to 502.
- [ ] 3.2 Rewrite the `fetchZaiQuota` retry loop to switch on failure class rather than HTTP
      status, so the raw-token fallback becomes reachable in production.
- [ ] 3.3 Wrap `response.json()` in try/catch — gateways and proxies return HTML with status 200.
- [ ] 3.4 Throw when a successful envelope carries no window cap, rather than reporting 0 %.
- [ ] 3.5 Never include the envelope `msg` in the thrown message; use the mapped code.

## 4. Model and persistence

- [ ] 4.1 Extend `RateLimitData` with optional `billing`, `planLevel`, `credits5h` and
      `credits7d`, plus the `QuotaBilling` and `QuotaAmounts` types (`src/data/apiClient.ts`).
- [ ] 4.2 Carry the new fields through `ClaudeUsageData` and the merge in
      `DataManager.getUsageData` (`src/data/dataManager.ts`).
- [ ] 4.3 Cache schema version 3 becomes 4: persist the credit amounts, plan tier and an explicit
      `has7dLimit`; extend `validateCacheFile` without weakening any existing range check
      (`src/data/cache.ts`).
- [ ] 4.4 Read `has7dLimit` from the cache directly in `cacheToRateLimitData` instead of inferring
      it from a positive `reset7dAt` — that inference is always true (`src/data/dataManager.ts`).
- [ ] 4.5 Bump `SNAPSHOT_VERSION` from 1 to 2 (`src/data/snapshotCache.ts`).

## 5. Dashboard

- [ ] 5.1 Render the absolute amounts under the 5-hour and weekly bars when present
      (`src/webview/panel.ts`), hidden otherwise.
- [ ] 5.2 Render the plan tier badge when `planLevel` is present.
- [ ] 5.3 Add the new strings to the ru, ja and zh-cn l10n bundles — `locale.test.ts` enforces
      parity across locales.

## 6. Tests, z.ai

- [ ] 6.1 TEST: introduce a fixed `NOW` constant in `providerDetection.test.ts` and pass it to
      every new parser call; the existing fixtures rely on wall-clock slack.
- [ ] 6.2 TEST: live credit-tariff fixture — utilization about 0.596 and 0.3406, weekly window
      present, credit billing, tier max, amounts 16693, 28000 and 11306. This is the primary
      regression: the tariff currently reports zeros throughout.
- [ ] 6.3 TEST: live token-tariff fixture — 5-hour utilization 0 with a fallback horizon of about
      18000 s, weekly utilization 1, token billing, no credit amounts.
- [ ] 6.4 TEST: a leading `TIME_LIMIT` at 99 % claims no quota window and raises no warning.
- [ ] 6.5 TEST: payloads without a unit — order-based classification, weekly window present, a
      weekly cap resetting sooner keeps its slot, a distant first candidate is vetoed, two idle
      caps keep array order, and a single cap reports no weekly window.
- [ ] 6.6 TEST: a mixed payload (one entry with a unit, one without) and an undocumented unit 2.
- [ ] 6.7 TEST: reset times in the past and 500 days out both fall back to the window length, and
      a weekly fallback is seven days rather than one.
- [ ] 6.8 TEST: envelope handling — code 1000 retries then throws, code 500 throws without
      retrying, an omitted `success` parses, a 200 carrying only `TIME_LIMIT` throws, and a
      non-JSON body throws.
- [ ] 6.9 TEST: hostile input (null, a string, a number, a non-array `limits`, null and
      non-object elements) yields zeros without throwing.
- [ ] 6.10 TEST: all six existing z.ai tests stay green unmodified, including the 18000 s
      expectation.

## 7. Tests, Anthropic regression

- [ ] 7.1 Add an injectable `fetchImpl` to `fetchRateLimitData`, mirroring `fetchZaiQuota`. The
      Anthropic header path has no test coverage today and cannot be asserted without it.
- [ ] 7.2 TEST: new `src/test/suite/anthropicRateLimit.test.ts` covering header parsing, reset
      times read as Unix seconds, the denied status, a missing 7-day header reporting no weekly
      window, and malformed header values clamping to zero without throwing.
- [ ] 7.3 TEST: the z.ai-only fields stay absent on Anthropic results.
- [ ] 7.4 TEST: a cache v4 round-trip preserves `has7dLimit` as false for a plan without a weekly
      window and true for one with it — the fix for the always-true inference.
- [ ] 7.5 TEST: a version 3 cache file and a version 1 snapshot are rejected and trigger a cold
      refetch rather than a failure.
- [ ] 7.6 TEST: the dashboard hides the credit block and tier badge when the fields are absent
      (`panel.test.ts`).
- [ ] 7.7 Confirm the statusBar, cache, snapshotCache, notificationDecision, prediction and
      locale suites pass unmodified. Any suite needing edits means the contract moved wider than
      intended — stop and reassess rather than adjusting the test.

## 8. Docs and changelog

- [ ] 8.1 Add a z.ai quota section to `docs/DATA.md`: both payload generations, the inverted
      `usage`/`currentValue` naming, and why order beats reset time for window identification.
- [ ] 8.2 Add an Unreleased entry to `CHANGELOG.md`, calling out that older z.ai tariffs start
      showing a weekly row and weekly notifications, and that Anthropic Pro users stop seeing a
      phantom weekly row.
- [ ] 8.3 Confirm `.env` is git-ignored so the manual-check tokens cannot be committed.

## 9. Verification

- [ ] 9.1 `npm run lint` and `npm test` pass.
- [ ] 9.2 Run both tokens through the new parser and reconcile against the z.ai subscription
      dashboard. Temporary script; nothing written to the repo.
- [ ] 9.3 Extension Dev Host on the credit tariff: real percentages, credit amounts, tier badge,
      and a rendered prediction chart. Then an invalid token: cost-only with a cache age, not 0 %.
- [ ] 9.4 `openspec validate support-zai-quota-formats --strict` passes.
