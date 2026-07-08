# Design: fix-rate-limit-notifications

## Context

The rate-limit notification trigger in `checkAndNotify()` (`src/extension.ts`) consumed
`prediction.estimatedExhaustionIn` — a 30-minute burn-rate extrapolation capped at the 5h reset.
That coupling produced false positives near a window reset and nonsensical estimates for z.ai
(see proposal NL-1…NL-3). The fix replaces the trigger with a utilization-driven, provider-agnostic
decision while leaving the `prediction` engine untouched (the dashboard still renders burn-rate and
time-to-exhaustion).

## Decisions

### 1. Pure decision function

`decideRateLimitNotifications(usage, thresholds, alreadyNotified)` lives in
`src/data/notificationDecision.ts` with no `vscode` import, mirroring the testable-pure-function
pattern of `prediction.ts` / `statusBar.ts`. It returns an array of `RateLimitNotification`
(`{ key, window, severity, percentUsed, resetIn, reached }`). `checkAndNotify` is reduced to:
compute decisions → mark each `key` in the dedup set → show the VSCode notification.

### 2. Step (bucket) math

`bucketFor(percent, start, step, cap?)` returns the highest reached step, or `null` below `start`.
A `1e-9` epsilon absorbs `utilization*100` float error (e.g. `0.98*100 = 97.9999…`) so boundary
values land in the correct bucket. Only the current (highest) bucket per window is emitted —
utilization is monotonic within a window, so intermediate steps skipped by the 5-minute poll are
intentionally not back-filled.

- 5h: `start=90, step=2` → 90, 92, 94, 96, 98, 100.
- 7d: `start=80, step=5, cap=90` → 80, 85, 90 (nothing above 90).

### 3. Severity and the 100% case

5h buckets ≥ 100 are `severity: 'error'` with `reached: true` and shown via `showErrorMessage`
with an *Open Dashboard* action (matching the previous critical behavior). All other 5h steps and
all 7d steps are `warning`.

### 4. Per-window dedup and reset

Dedup keys are namespaced per window (`5h-92`, `7d-85`). `checkWindowResets` clears `5h-*` keys on a
5h rollover and `7d-*` keys on a 7d rollover (detected by `resetIn` jumping up > 1 hour), so each
step re-arms exactly once per fresh window. The daily `budget` key continues to re-arm on a 5h
rollover, preserving prior behavior.

### 5. Configurable thresholds

Five settings under `claudeStatus.notifications.*` (`rateLimit5hStartPercent`, `rateLimit5hStepPercent`,
`rateLimit7dStartPercent`, `rateLimit7dEndPercent`, `rateLimit7dStepPercent`) feed
`config.rateLimitThresholds`. The obsolete `rateLimitWarningThresholdMinutes` is removed.

## Testing strategy

`src/test/suite/notificationDecision.test.ts` unit-tests the pure function and `bucketFor` with
Mocha + `assert` (factory-fixture style): below/at/above thresholds for both windows, the 100% error
case, dedup via `alreadyNotified`, the 7d cap, no-7d-window providers, both windows firing together,
custom thresholds, and `resetIn` pass-through. No Electron host required.
