# Tasks: support-zai-quota-formats

> **Prerequisite**: PR #5 (Russian localization) must be merged into `main` and this branch
> rebased onto it before task 5.3 — `l10n/bundle.l10n.ru.json` and the locale parity test do not
> exist on `main` yet.

## 1. Window classification (`src/data/apiClient.ts`)

- [ ] 1.1 Remove `zaiUnitToMs`; it is unexported and its unit map is wrong (5 as minutes,
      6 as days). Replace with constants: 3 = hours, 5 = months, 6 = weeks.
- [ ] 1.2 Extend `ZaiLimitEntry` with `currentValue`, `usage`, `remaining`, `usageDetails`, and
      `ZaiQuotaResponse.data` with `level`. Document the inverted `usage`/`currentValue` naming
      inline — it is the single easiest defect to reintroduce.
- [ ] 1.3 Add `isZaiWindowCap` (`TOKENS_LIMIT` or `CREDIT_LIMIT`) and `zaiKindFromUnit`: hours to
      the 5-hour kind regardless of `number`, weeks to weekly, months on a `TIME_LIMIT` to MCP,
      months on a window cap to other, everything else unresolved.
- [ ] 1.4 Add `zaiKindsFromOrder(limits, now)`: candidates are window caps only, so a leading
      `TIME_LIMIT` takes no slot; six-hour veto horizon; a missing `nextResetTime` keeps a
      candidate eligible; array order is trusted when every candidate is vetoed; the map is keyed
      by index into the full `limits` array so it zips back onto it entry for entry.
- [ ] 1.5 Add `zaiResolveKinds(limits, now)`: build the positional map only when some window cap
      is unresolved, with `zaiKindFromUnit` still winning per entry.
- [ ] 1.6 Add a defensive `zaiLimitsOf(json)` tolerating null, non-objects, a non-array `limits`,
      and null or non-object elements, and capping the number of entries considered.
- [ ] 1.7 Use at most two window caps: the first fills the 5-hour slot, the next the weekly slot,
      and any further cap is ignored.

## 2. Utilization, reset horizons and amounts

- [ ] 2.1 Derive utilization from `currentValue / usage` when both are finite and `usage` is
      positive, but only when it agrees with `percentage` within 1.5 pp; otherwise use
      `percentage`. **When `percentage` is absent or not a number, use the ratio unguarded** —
      comparing against the current `percentage ?? 0` default would report 0 % for a perfectly
      good credit window. Keep `clamp01`.
- [ ] 2.2 Add `zaiWindowSeconds(entry, kind)`: unit times number when resolvable, else five hours
      or seven days by kind.
- [ ] 2.3 Add `zaiResetSeconds(entry, kind, nowSec)`: use `nextResetTime` (epoch milliseconds)
      when it is in the future and within 400 days, else fall back to the window length. Never
      zero for a window that exists.
- [ ] 2.4 Extract `billing`, `planLevel`, `credits5h`, `credits7d`. Pass `remaining` through
      unchanged and never recompute it; expose used and total even when `remaining` is absent.
- [ ] 2.5 Make `now` an injectable parameter of `parseZaiQuota`, defaulting to the current time.
- [ ] 2.6 Map utilization at or above 1 on either window to the denied limit status.
- [ ] 2.7 Confirm `parseZaiQuota` still cannot throw on any input path.

## 3. Request-level failure handling

- [ ] 3.1 Add `readZaiEnvelopeFailure(json)`: only an explicit `success: false` is a failure; map
      `code` with 401, 403 and 429 passing through, 1000 and 1001 to 401, anything else to 502.
- [ ] 3.2 Rewrite the `fetchZaiQuota` retry loop to switch on failure class rather than HTTP
      status, so the raw-token fallback becomes reachable in production. The class of the **last**
      attempt decides the resulting failure.
- [ ] 3.3 Wrap `response.json()` in try/catch — gateways and proxies return HTML with status 200.
- [ ] 3.4 Throw when a successful envelope carries no window cap, rather than reporting 0 %.
- [ ] 3.5 Never include the envelope `msg` in the thrown message; describe it as an envelope code
      rather than an HTTP status, since the response really was HTTP 200.

## 4. Authentication backoff and visible state

- [ ] 4.1 Record an authentication-class failure with its timestamp and suppress further quota
      requests until the cache TTL elapses. Without this the QF-4 fix turns a rejected key into
      two HTTP requests per minute forever, because no cache is written and `shouldCallApi`
      returns true whenever the cache is missing.
- [ ] 4.2 Do not suppress network or upstream failures the same way — those are transient.
- [ ] 4.3 Add a distinct data source for a rejected credential, separate from stale and
      local-only, and surface it in the status bar and dashboard.
- [ ] 4.4 Add the strings for that state to the l10n bundles (see the prerequisite above).

## 5. Model and persistence

- [ ] 5.1 Extend `RateLimitData` with optional `billing`, `planLevel`, `credits5h` and
      `credits7d`, plus the `QuotaBilling` and `QuotaAmounts` types (`src/data/apiClient.ts`).
- [ ] 5.2 Carry the new fields through `ClaudeUsageData` and the merge in
      `DataManager.getUsageData` (`src/data/dataManager.ts`).
- [ ] 5.3 Cache schema version 3 becomes 4: persist the credit amounts, plan tier and an explicit
      `has7dLimit`. Extend `validateCacheFile` without weakening any existing range check, and
      accept `planLevel` only as a short string, rejecting the record otherwise.
- [ ] 5.4 Accept a version 3 record for reading (deriving `has7dLimit` the old way) while always
      writing version 4, so two extension versions sharing the cache file cannot invalidate each
      other's writes on every tick.
- [ ] 5.5 Read `has7dLimit` from the cache directly in `cacheToRateLimitData` instead of inferring
      it from a positive `reset7dAt` — that inference is always true (`src/data/dataManager.ts`).
- [ ] 5.6 Leave `SNAPSHOT_VERSION` at 1. The new fields are optional and the existing validator
      accepts them; bumping it would reject every snapshot and cost each user the instant
      cold-start render.

## 6. Dashboard

- [ ] 6.1 Render the absolute amounts beside the 5-hour and weekly bars when present, showing used
      and total, and the remaining amount only when the API sent it. Hide the block entirely
      otherwise (`src/webview/panel.ts`).
- [ ] 6.2 Render the plan tier badge when `planLevel` is present, escaped through the panel's
      existing `esc()`.
- [ ] 6.3 Add the new strings to every l10n bundle — the locale parity test enforces this once the
      prerequisite merge has landed.

## 7. Tests, z.ai

- [ ] 7.1 TEST: introduce a fixed `NOW` constant in `providerDetection.test.ts` and pass it to
      every new parser call; the existing fixtures rely on wall-clock slack.
- [ ] 7.2 TEST: live credit-tariff fixture — utilization about 0.596 and 0.3406, weekly window
      present, credit billing, tier max, amounts 16693, 28000 and 11306. This is the primary
      regression: the tariff currently reports zeros throughout.
- [ ] 7.3 TEST: live token-tariff fixture — 5-hour utilization 0 with a fallback horizon of about
      18000 s, weekly utilization 1, denied status, token billing, no credit amounts.
- [ ] 7.4 TEST: a leading `TIME_LIMIT` at 99 % claims no quota window and raises no warning.
- [ ] 7.5 TEST: amounts present with no `percentage` yield the derived ratio, not zero; amounts
      without `remaining` still expose used and total.
- [ ] 7.6 TEST: payloads without a unit — order-based classification, weekly window present, a
      weekly cap resetting sooner keeps its slot, a distant first candidate is vetoed, all
      candidates vetoed falls back to array order, two idle caps keep array order, a single cap
      reports no weekly window, a third cap is ignored.
- [ ] 7.7 TEST: a mixed payload (one entry with a unit, one without), an undocumented unit 2, and
      a month-period window cap that takes no slot.
- [ ] 7.8 TEST: reset times in the past and 500 days out both fall back to the window length, and
      a weekly fallback is seven days rather than one.
- [ ] 7.9 TEST: envelope handling — code 1000 retries then throws, code 500 throws without
      retrying, an auth failure followed by a non-auth failure reports the latter, an omitted
      `success` parses, a 200 carrying only `TIME_LIMIT` throws, and a non-JSON body throws.
- [ ] 7.10 TEST: hostile input (null, a string, a number, a non-array `limits`, null and
      non-object elements, an oversized array) yields zeros without throwing.
- [ ] 7.11 TEST: an authentication failure suppresses the next request until the TTL elapses,
      while a network failure does not.
- [ ] 7.12 TEST: the six existing z.ai tests stay green. Their `{ unit: 6, number: 7 }` fixtures
      may be corrected to `number: 1` — under the fixed unit map they currently describe a
      seven-week window, which no tariff offers. This is a data correction, not a weakening.

## 8. Tests, Anthropic regression

- [ ] 8.1 Add an injectable `fetchImpl` to `fetchRateLimitData`, mirroring `fetchZaiQuota`. The
      Anthropic header path has no test coverage today and cannot be asserted without it.
- [ ] 8.2 TEST: new `src/test/suite/anthropicRateLimit.test.ts` covering header parsing, reset
      times read as Unix seconds, the denied status, a missing 7-day header reporting no weekly
      window, and malformed header values clamping to zero without throwing.
- [ ] 8.3 TEST: the z.ai-only fields stay absent on Anthropic results.
- [ ] 8.4 TEST: a cache v4 round-trip preserves `has7dLimit` as false for a plan without a weekly
      window and true for one with it — the fix for the always-true inference — and preserves the
      credit amounts, plan tier and billing model.
- [ ] 8.5 TEST: a version 3 record is accepted for reading and rewritten as version 4; a record
      with an out-of-range utilization or unknown status is still rejected at either version.
- [ ] 8.6 TEST: the dashboard hides the amounts block and tier badge when the fields are absent,
      for both Anthropic and the token tariff (`panel.test.ts`).
- [ ] 8.7 Update the version fixtures that this change necessarily invalidates: `cache.test.ts`
      lines 9 and 25 (`version: 3`). `snapshotCache.test.ts` needs no change, because the snapshot
      schema is deliberately unchanged.
- [ ] 8.8 Confirm the statusBar, notificationDecision, prediction and locale suites pass
      unmodified. Any of these needing edits means the contract moved wider than intended — stop
      and reassess rather than adjusting the test. (`cache.test.ts` is excluded from this rule by
      8.7; its edit is a schema-version fixture, not a behavioural expectation.)

## 9. Docs and changelog

- [ ] 9.1 Add a z.ai quota section to `docs/DATA.md`: both payload generations, the inverted
      `usage`/`currentValue` naming, and why order beats reset time for window identification.
- [ ] 9.2 Add an Unreleased entry to `CHANGELOG.md`, calling out that older z.ai tariffs start
      showing a weekly row and weekly notifications, that an exhausted window now shows red, that
      a rejected key is reported as such, and that Anthropic Pro users stop seeing a phantom
      weekly row.
- [ ] 9.3 Confirm `.env` is git-ignored so the manual-check tokens cannot be committed.

## 10. Verification

- [ ] 10.1 `npm run lint` and `npm test` pass.
- [ ] 10.2 Owner-only, not a blocker for the rest: run both live tokens through the new parser and
      reconcile against the z.ai subscription dashboard. The payloads captured for 7.2 and 7.3 are
      the durable form of this check.
- [ ] 10.3 Extension Dev Host on the credit tariff: real percentages, credit amounts, tier badge,
      and a rendered prediction chart. Then an invalid token: the rejected-credential state, with
      no request storm on the 60-second timer.
- [ ] 10.4 `openspec validate support-zai-quota-formats --strict` passes.
