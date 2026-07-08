# Tasks: fix-rate-limit-notifications

## 1. Pure decision module
- [x] 1.1 Add `src/data/notificationDecision.ts` with `RateLimitNotification`, `RateLimitThresholds`,
      `RateLimitUsage`, `bucketFor`, and `decideRateLimitNotifications`.
- [x] 1.2 Epsilon-harden `bucketFor` against `utilization*100` float boundary error.

## 2. Extension wiring
- [x] 2.1 Replace the `estimatedExhaustionIn`-based block in `checkAndNotify` (`src/extension.ts`)
      with `decideRateLimitNotifications` driven by `config.rateLimitThresholds`.
- [x] 2.2 Per-window dedup: `checkWindowResets` clears `5h-*` / `7d-*` keys on each window rollover;
      `budget` key still re-arms on a 5h rollover.
- [x] 2.3 `showRateLimitNotification` — error + *Open Dashboard* at 100% reached, warnings otherwise,
      using `formatDuration` for the reset suffix.

## 3. Settings
- [x] 3.1 Add `config.rateLimitThresholds` getter; remove `rateLimitWarningThresholdMinutes`
      (`src/config.ts`).
- [x] 3.2 Add five `claudeStatus.notifications.rateLimit{5h,7d}*Percent` keys and remove the minutes
      key in `package.json`.
- [x] 3.3 Update `package.nls.json`, `package.nls.ja.json`, `package.nls.zh-cn.json` descriptions.

## 4. Runtime i18n
- [x] 4.1 Add the three new notification strings to `l10n/bundle.l10n.ja.json` and
      `l10n/bundle.l10n.zh-cn.json`; remove the obsolete `Rate limit in ~{0} min` entries.

## 5. Tests
- [x] 5.1 TEST: `src/test/suite/notificationDecision.test.ts` covering thresholds, both windows,
      100% error, dedup, 7d cap, no-7d providers, custom thresholds, `resetIn` pass-through.

## 6. Docs & changelog
- [ ] 6.1 Update `docs/SETTINGS.md` (new keys, remove minutes key).
- [ ] 6.2 Update `docs/features/04-prediction.md` notification section to the stepped model.
- [ ] 6.3 Add a `## [Unreleased]` entry to `CHANGELOG.md`.

## 7. Verification
- [ ] 7.1 `npm run lint` && `npm test` pass.
- [ ] 7.2 `openspec validate fix-rate-limit-notifications --strict` passes.
- [ ] 7.3 Manual smoke in the Extension Dev Host (no alert <90%/<80%, steps fire, 100% error,
      no dupes, re-arm after reset, z.ai parity).
