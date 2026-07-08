# Proposal: fix-rate-limit-notifications

## Why

Rate-limit notifications fire from a **time-to-exhaustion prediction**, not from the actual
remaining quota, and misfire for every provider.

| ID | Problem |
|----|---------|
| NL-1 | The trigger reads `prediction.estimatedExhaustionIn`, which is capped at `resetIn5h`. When the 5h window is about to reset (`resetIn5h < 30 min`) the warning fires even at low utilization — a false positive near every window rollover. |
| NL-2 | The burn-rate capacity estimate `cost5h / utilization5h` mixes a locally computed `$` cost with a server-side quota fraction. For z.ai these are different scales, so the predicted exhaustion time is meaningless. |
| NL-3 | The trigger is unrelated to "how much of the limit is left", so users get alerts that do not correspond to their real remaining quota. |

## What Changes

- **NL-1 / NL-2 / NL-3** → Drive rate-limit notifications from the real quota fraction
  (`utilization5h` / `utilization7d`) via a new pure module `decideRateLimitNotifications`.
- **5h window**: silent below 90% used; one notification per 2% step at/above 90% (90, 92, 94, 96, 98);
  a distinct **error** notification at 100% ("limit reached", with *Open Dashboard*).
- **7d window**: silent below 80% used; one warning per 5% step at 80, 85, 90 (capped at 90),
  only for providers/plans that expose a 7d window.
- Notification text shows the percent used, the window, and time until that window resets.
- New configurable threshold settings replace the obsolete
  `notifications.rateLimitWarningThresholdMinutes`.
- `prediction` (burn-rate, time-to-exhaustion) is left intact — the dashboard still consumes it.

## Impact

- Affected specs: `rate-limit-notifications` (new).
- Affected code: `src/data/notificationDecision.ts` (new), `src/extension.ts`, `src/config.ts`,
  `package.json`, `package.nls*.json`, `l10n/bundle.l10n.*.json`.
- New tests: `src/test/suite/notificationDecision.test.ts`.
- Settings: adds `notifications.rateLimit5hStartPercent`, `…5hStepPercent`, `…7dStartPercent`,
  `…7dEndPercent`, `…7dStepPercent`; removes `…rateLimitWarningThresholdMinutes`.
- Backward compatibility: the master toggle `notifications.rateLimitWarning` is unchanged; the
  removed minutes setting has no runtime effect for existing users beyond losing a now-unused key.
