# Changelog

All notable changes to **vscode-claude-status** are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.2.0] — 2026-09-21

### Fixed

- **z.ai credit tariffs showed 0 % on every quota window.** Newer z.ai plans report their quota
  as `CREDIT_LIMIT` entries, which the parser filtered out by type, so the status bar, the
  dashboard gauges and the rate-limit notifications were all silently wrong for those accounts.
  Both payload generations are now read, classified per entry rather than by a single detected
  format version.
- **Weekly quota was invisible on older z.ai payloads.** Responses that state no period yielded a
  window length of 0, so the weekly cap was never identified. Those users will now see a weekly
  row and start receiving weekly notifications that never appeared before.
- **A rejected z.ai API key was reported as "0 % used".** z.ai answers a refused token with
  HTTP 200 and a failure envelope, not 401, so an expired key was parsed as a healthy idle
  account and cached as fresh. The envelope is now inspected, the status bar says the key was
  rejected, and polling backs off instead of retrying every minute. A z.ai response the
  extension cannot parse backs off the same way rather than being polled on every tick. As a
  side effect the bearer-to-raw-token fallback works for the first time — it was gated on an
  HTTP status the live API never returns.
- **Anthropic Pro plans showed a phantom weekly row.** Whether a weekly window exists was derived
  from a cached reset timestamp that is always non-zero, so any cache read claimed one existed —
  for every provider. It is now stored explicitly.
- **An exhausted z.ai window showed amber, not red.** The limit status could never reach
  "denied" for z.ai, so a spent quota looked the same as one at 76 %.
- **A denied quota was attributed to the wrong window.** The status bar printed a flat
  "5h:100%✗" and hid the weekly row whenever the limit was denied. That held for Anthropic,
  whose denial comes from the 5-hour status header, but a z.ai account exhausted on its weekly
  window would be told its 5-hour window was spent while it was in fact empty. The mark and the
  red bar now go on the window that actually reached the limit, in both the status bar and the
  dashboard.
- **A malformed Anthropic reset header made the extension poll the API on every tick.** An
  unparseable header turned into `NaN`, which the cache could not store, so every read found no
  usable cache and triggered a fresh request. An unreadable header now counts as no reset time,
  and a record the cache would reject is never written in the first place.
- **A cache entry dated in the future was treated as fresh forever**, so its data was never
  refreshed. Such entries are now rejected.
- The period unit map read weeks as days, making the weekly fallback reset horizon seven times
  too short.

### Added

- **Absolute credit amounts in the dashboard.** Credit-based z.ai tariffs now show used, total
  and remaining credits beside each quota bar, plus a plan tier badge. Token-based tariffs and
  every other provider are unchanged — the display is driven by whether the data exists. Amounts
  that look inconsistent with the reported percentage are withheld rather than shown wrong.
- Quota percentages are derived from the absolute amounts where they are available, so the
  notification thresholds are no longer quantised by an integer percentage from upstream.

### Changed

- Cache schema is now version 4 (explicit weekly-window flag, credit fields). Version 3 is still
  read, so an updated window and one still running the previous build cannot invalidate each
  other's cache writes. The dashboard snapshot schema is deliberately unchanged, so the instant
  cold-start render is preserved.

---

## [1.1.0] — 2026-07-09

### Added

- **Russian (ru) localization.** The status bar, notifications, dashboard and all manifest strings
  (command titles, setting descriptions) now render in Russian when the VS Code display language is
  `ru`. Adds `package.nls.ru.json`, `l10n/bundle.l10n.ru.json` and a translated `README.ru.md`.
  Introduces a locale key-parity test (`src/test/suite/locale.test.ts`) that keeps every language
  bundle in sync with the base.

---

## [1.0.1] — 2026-07-08

### Fixed

- **Marketplace listing images & badges now render.** The VS Code Marketplace does not render SVG
  images or relative image paths in the README, so the icon and status/badge images were broken on
  the published page. All README images now use absolute `raw.githubusercontent.com` **PNG** URLs,
  and the badges use shields.io's **`.png`** raster endpoint (SVG badges render on GitHub but not on
  the Marketplace); the Open VSX badge was dropped until published there.
- Added a **status-bar screenshot** alongside the dashboard screenshot.
- Repository renamed to `MaxRyabov/claude-glm-usage`; all repo/issue/clone URLs and the
  `code --install-extension` id updated to `max-riabov.claude-glm-usage`. Repository Issues enabled.

### Fixed (code review)

- **Rate-limit cache is now provider-specific.** The on-disk cache records which provider produced
  it (schema v3); after switching Claude.ai ↔ z.ai the UI no longer shows the other provider's
  utilization until the TTL expires.
- **Partial `pricing.models` overrides no longer NaN-out costs** — a user override is merged onto the
  full fallback so missing rate fields can't propagate `NaN` into every total.
- **Rate-limit notification bucketing hardened** — guards non-finite utilization, anchors buckets to
  the configured `start` (so custom start/step values aren't mis-bucketed), and always fires the
  "5h limit reached" alert at 100% even when the step doesn't divide 100.
- **Dashboard snapshot fails closed on schema drift** (validates `providerType`/`dataSource`/
  `limitStatus` before use).
- **Cold start now refreshes the dashboard and notifications**, not just the status bar (uses
  `refresh()` so `onDidUpdate` fires).

---

## [1.0.0] — 2026-07-08

### Changed

- **Rebrand & Marketplace relaunch as “Claude Code + GLM — Usage & Cost”.** The extension is now
  positioned around its dual-provider strength: it tracks usage, cost, and rate-limit quota for
  **both Claude Code and GLM (z.ai)** in one meter. No functional change to the data layer — GLM
  (z.ai) detection, real quota fetching, and per-model GLM pricing were already present and remain
  intact.
  - New extension identity: `name` → `claude-glm-usage`, new publisher, new icon (a dual-arc usage
    gauge blending Claude coral and GLM blue with a `>_` code caret).
  - README rewritten to lead with Claude Code + GLM; the z.ai/GLM setup is promoted to a top-level
    “Two providers, one meter” section. Localized display strings (en/ja/zh) updated.
  - Settings (`claudeStatus.*`) and command IDs (`vscode-claude-status.*`) are unchanged.

### Housekeeping

- Removed the unused legacy JSONL parse path (superseded by the incremental `entryCache`), the
  Yeoman scaffold test, and corrected the stale “Chart.js via CDN” note in the docs (Chart.js is
  bundled locally to `dist/chart-bundle.js`).

### Credits

- Based on [long-910/vscode-claude-status](https://github.com/long-910/vscode-claude-status) (MIT).

---

## [0.9.1] — 2026-07-08

### Fixed

- **Dashboard sections no longer hang on "Loading…".** A `ReferenceError` (`isClaudeAi` left behind
  by the 0.7.0 provider rename) in the WebView's `updateUsage` aborted every dashboard render after
  the "Current Usage" labels — project cost, prediction, pricing, and usage history never rendered,
  and costs / "Last updated" stayed at "—".
- **Further Extension Host load reduction** (crash hardening on large `~/.claude/projects` trees):
  - Cold-start parsing is capped at 4 files at a time (previously all session files — hundreds of MB
    on heavy installs — were read and parsed concurrently) and yields to the event loop every 2 000
    lines, so the shared Extension Host stays responsive.
  - Concurrent consumers requesting the same file now share one in-flight parse instead of
    re-reading the same bytes.
  - The multi-MB persisted parse cache is only rewritten when its contents actually changed (it was
    re-serialized with `fsync` twice per refresh, every 60 s, even when idle) and is now stored as
    compact JSON (~half the size).
- Usage-history heading rendered as "(90 7 days)" instead of "(90 days)".
- **Multi-window hardening.** Each VSCode window runs its own extension instance watching the whole
  `~/.claude/projects` tree, so one long Claude Code session fanned out into continuous work in
  every open window:
  - Watcher-triggered refreshes are rate-limited to one per 15 s per window (the 60 s timer already
    guarantees freshness); the parse cache is persisted at most once per 5 min per window (flushed
    on deactivate).
  - The shared dashboard snapshot is filtered to the current window's workspace folders on load —
    previously a window could briefly render another workspace's project costs after a cold start.
  - A cross-window file lock (`vscode-claude-status-api.lock`, O_EXCL + stale takeover) ensures only
    one window polls the rate-limit API when the shared cache TTL expires; the other windows reuse
    the winner's result from the shared cache instead of each spending a request.

---

## [0.9.0] — 2026-06-05

### Changed

- **Dashboard data loading is dramatically faster, and the file watcher no longer destabilizes the
  Extension Host.** The usage, project-cost, prediction, and heatmap modules previously each scanned
  and re-parsed the entire `~/.claude/projects/**/*.jsonl` history on every refresh, and the watcher
  fired an unbounded, non-coalesced refresh per write event — during a Claude Code streaming response
  that overloaded the shared Extension Host and forced all extensions (including Claude Code) to
  reload. Now:
  - A shared parsed-entry cache (`src/data/entryCache.ts`), keyed by file path + `mtime` + size,
    parses each JSONL file once and serves all four consumers. Append-only files are parsed
    **incrementally** (only the newly appended bytes), and a cheap directory-mtime pre-check skips the
    re-walk when nothing changed. Short-window consumers (30-minute prediction, 7-day usage) filter
    files by mtime instead of reading the whole history.
  - The file watcher is **debounced** (a write burst collapses into one refresh), and `refresh()` is
    **serialized/coalesced** so overlapping refreshes can no longer pile up.
  - Per-model pricing resolution is memoized per aggregation pass.

### Added

- **Instant cold start.** The last computed dashboard aggregates (usage, project costs, heatmap) are
  persisted to disk (`vscode-claude-status-snapshot.json`) and rendered immediately on the first panel
  open, then refreshed in the background. The parse cache is persisted too
  (`vscode-claude-status-parsecache.json`). All cache writes are now atomic (temp → fsync → rename)
  to avoid corruption.

---

## [0.8.0] — 2026-06-05

### Changed

- **Rate-limit notifications are now driven by actual quota utilization, not a time prediction.**
  The old trigger extrapolated a burn rate and capped it at the 5h reset, which fired false alerts
  near every window reset and produced meaningless estimates for z.ai. Notifications now step off the
  real `utilization5h` / `utilization7d` fraction and behave identically for every provider:
  - 5h window: silent below 90% used; a warning on each 2% step (90, 92, 94, 96, 98); a distinct
    **error** ("5h rate limit reached") at 100%.
  - 7d window: silent below 80% used; a warning on each 5% step at 80, 85, 90 (capped at 90), only
    for providers that expose a weekly window.
  - Each notification shows the percent used and the time until that window resets, and re-arms when
    the window resets.

### Added

- New configurable thresholds: `notifications.rateLimit5hStartPercent` (90),
  `…rateLimit5hStepPercent` (2), `…rateLimit7dStartPercent` (80), `…rateLimit7dEndPercent` (90),
  `…rateLimit7dStepPercent` (5).

### Removed

- `notifications.rateLimitWarningThresholdMinutes` — superseded by the utilization-based thresholds.

---

## [0.7.3] — 2026-06-04

### Fixed

- **z.ai prediction chart not rendering** — z.ai omits a reset timestamp for the rolling
  5-hour window (its dashboard only shows the weekly reset), so `resetIn5h` was `0`, which hid
  the dashboard prediction chart and made the exhaustion estimate mis-cap at zero. The reset
  horizon now falls back to the window's own length (5h / 7d, from the entry's `unit`/`number`)
  when z.ai doesn't return an explicit reset time.

---

## [0.7.2] — 2026-06-03

### Fixed

- **Auto-refresh of usage/quota** — the periodic 60-second timer now runs a full `refresh()`
  (firing `onDidUpdate`) instead of a status-bar-only update, so an open dashboard and the
  z.ai 5h/weekly quota update on their own. Previously auto-update depended on the file watcher
  for `~/.claude/projects`, which VS Code watches unreliably outside the workspace — so the
  counter only moved when you pressed **Refresh**. API calls stay gated by the cache TTL, so
  idle sessions still don't poll. Lower `claudeStatus.cache.ttlSeconds` (min 60) for more
  frequent quota updates while actively working.

---

## [0.7.1] — 2026-06-03

### Changed

- **z.ai quota auth fallback** — the quota request now tries `Authorization: Bearer <token>`
  first and falls back to the raw token on a 401/403, so z.ai **coding-plan** keys (which expect
  the token without the `Bearer` prefix) also return live 5-hour / weekly quota instead of
  silently dropping to cost-only mode.

---

## [0.7.0] — 2026-06-03

### Added

- **z.ai (GLM) provider support** — when Claude Code is pointed at z.ai (or any custom
  Anthropic-compatible endpoint) via `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`,
  the extension now auto-detects the provider (no misleading Anthropic rate-limit calls).
  New `claudeProvider` values `z-ai` and `custom-endpoint`.
- **z.ai quota display** — for `z-ai`, the extension fetches the real 5-hour and weekly quota
  from z.ai's monitor endpoint and shows the same utilization % as the z.ai subscription
  dashboard (degrades to cost-only when no token is configured or the request fails).
- **Per-model pricing** — cost is now computed from each entry's `message.model` using a
  built-in price table (z.ai GLM tiers + Claude tiers), so GLM usage is priced correctly
  instead of at Claude's ~5–7× higher flat rate, and mixed Claude+GLM usage blends right.
- **`claudeStatus.pricing.models`** setting — override or add per-model rates, keyed by
  model name/prefix (e.g. `"glm-4.6"`, `"claude-opus"`).

### Changed

- The flat `claudeStatus.pricing.*` values are now the **fallback** for unknown models;
  known Claude and GLM models are priced automatically.

### Fixed

- **Project cost over-counting** — per-project cost now deduplicates the multiple JSONL lines
  Claude Code writes per streaming response (by `requestId`/`message.id`), matching the global
  total instead of inflating it.

---

## [0.6.1] — 2026-05-28

### Added

- **Open VSX Registry** — the extension is now published to [Open VSX](https://open-vsx.org/extension/long-kudo/vscode-claude-status)
  in addition to the VS Code Marketplace, making it available for VSCodium, Gitpod, and
  other Eclipse Theia-based editors.
- **Open VSX badge** — README (EN / JA / ZH) now shows an Open VSX version badge.

### Changed

- **CI release workflow** — `release.yml` now publishes to both VS Marketplace and
  Open VSX Registry in a single `git tag` push via `HaaLeo/publish-vscode-extension@v2`.

---

## [0.6.0] — 2026-05-10

### Fixed

- **macOS Keychain credential lookup** — Claude Code v2.x on macOS stores OAuth credentials
  in the system Keychain under `"Claude Code-credentials"` instead of
  `~/.claude/.credentials.json`. The extension now falls back to the Keychain when the
  credentials file is absent, restoring 5h/7d utilization display on Mac.

---

## [0.5.1] — 2026-05-01

### Fixed

- **Cost deduplication** — Claude Code writes one JSONL entry per content block in a
  streaming response (thinking, text, each tool-use call), all sharing the same
  `requestId` and identical usage counts. The reader was summing every entry, inflating
  costs by 2–4× in agentic sessions. Entries are now deduplicated by `requestId`
  (falling back to `message.id`) so each API call is counted exactly once.
  Resolves [#31](https://github.com/long-910/vscode-claude-status/issues/31).

---

## [0.5.0] — 2026-04-30

### Performance

- **Lazy-load dashboard panel** — `src/webview/panel.ts` (50 KiB) is now split into
  a separate webpack chunk (`dist/panel.js`) and loaded on demand when the user first
  opens the dashboard. The startup bundle (`dist/extension.js`) shrinks from **118 KiB
  to 73 KiB** (−38%), reducing V8 parse time and improving the extension activation time.
  The status bar always appears immediately; only the dashboard itself loads on first use.

### Fixed

- **Minimum VS Code version** — lowered the engine requirement from `^1.109.0` to
  `^1.73.0`. The extension uses no API newer than `vscode.l10n` (added in 1.73), so
  the previous floor was unnecessarily high and blocked installation on VS Code
  1.73–1.108. Resolves [#28](https://github.com/long-910/vscode-claude-status/issues/28).

---

## [0.4.3] — 2026-04-26

### Fixed

- **Duration rollover** — the WebView "resets in" formatter no longer renders impossible
  values like `"1h 60m"` or `"1d 24h"`. After rounding, sub-units that reach their
  maximum (minutes → 60, hours → 24) are now normalised upward: `60m` promotes to `1h`,
  a `60`-minute overshoot in the hours branch promotes the hour count (and a resulting
  `24h` promotes to `1d`), and a `24h` overshoot in the days branch promotes the day
  count. Extracted into a testable `src/webview/formatDuration.ts` module with boundary
  tests covering all rollover edges.

---

## [0.4.2] — 2026-03-15

### Changed

- **Status bar time format** — duration values (stale-cache age, reset countdowns) now display
  days (`d`) and hours (`h`) in addition to minutes (`m`), so long durations like
  "1440m ago" are shown as "1d ago" and "120m ago" as "2h ago".
- **Social preview image** — updated OGP/social-preview image URL across all README files
  (EN / JA / ZH-CN).

### Fixed

- **i18n completeness (JA / ZH-CN)** — all previously untranslated UI strings are now
  registered in the runtime l10n bundle files and fully translated:
  - `formatDuration` uses `vscode.l10n.t` for time units, so durations appear in the
    active locale (e.g. "2時間30分前" in Japanese, "2小时30分钟前" in Chinese).
  - Dashboard (`panel.ts`): 60 + strings covering card titles, buttons, alerts, and
    status labels added to `bundle.l10n.{ja,zh-cn}.json`.
  - WebView `fmt()` helper updated to use i18n unit strings and now also supports days.
  - Removed dead keys `{0}m ago` / `__N__m ago` from both bundle files.

---

## [0.4.1] — 2026-03-09

### Added

- **Internationalization (i18n)** — the extension UI now supports English, Japanese (日本語),
  and Simplified Chinese (简体中文):
  - `package.nls.json` / `package.nls.ja.json` / `package.nls.zh-cn.json` — command titles
    and all VS Code Settings descriptions are translated via the standard `%key%` NLS mechanism.
  - `l10n/bundle.l10n.ja.json` / `l10n/bundle.l10n.zh-cn.json` — runtime strings
    (status bar labels, notifications, tooltips, input prompts) translated using
    `vscode.l10n.t()`.
  - Dashboard WebView — translated via an `i18n` object built on the extension host
    (using `vscode.l10n.t()`) and injected as `window.i18n` into the WebView at creation
    time; all card titles, labels, alerts, and chart tooltips are localized.
  - `package.json` gains `"l10n": "./l10n"` field to register the bundle directory.

- **Chinese README** (`README.zh.md`) — full Simplified Chinese translation of the README,
  added to the language switcher in `README.md` and `README.ja.md`.

### Fixed

- **Dashboard screenshot not shown on VS Code Marketplace** — the screenshot was hosted
  on `github.com/user-attachments/`, which is not in the Marketplace's image allowlist.
  Moved the image reference to `docs/screenshots/dashboard.png` (served via
  `raw.githubusercontent.com`) and excluded `docs/**` from the `.vsix` via `.vscodeignore`
  so the package size is unaffected.

---

## [0.4.0] — 2026-03-08

### Added

- **Rate Limit Timeline chart** — Chart.js line chart in the Prediction card showing
  projected 5h utilization from now to the next window reset. Includes:
  - Solid fill line from current utilization to predicted exhaustion point (100 %)
  - Linear projection continues flat at 100 % through to reset if exhaustion is predicted
  - Orange dashed reference line at 75 % (warning threshold)
  - Red dashed reference line at 100 % (hard limit)
  - Line colour adapts to severity: blue → orange (≥ 75 %) → red (≥ 90 %)
  - Tooltip shows utilization % at each time point
  - Chart hidden automatically for non-claude-ai providers and when no utilization
    data is available

- **Token breakdown** — collapsible section inside the Token Cost card (▶ toggle):
  - Per-type token counts and individual costs for the 5 h window:
    Input tokens (`$X.XX/M`), Output tokens, Cache read, Cache create
  - **Cache hit ratio** — percentage of input tokens served from cache (`cache_read /
(input + cache_read)`); shows "Good! Cache is saving cost." when ≥ 50 %
  - All costs use the currently configured `claudeStatus.pricing.*` rates

- **Monthly cost projection** — "Month (est.)" row in the Token Cost card:
  - Derived from today's JSONL cost × 30 (falls back to 7-day average if today = $0)
  - Hidden when no cost data is available yet

- **Weekly budget progress bar** — shown in the Prediction card when
  `claudeStatus.budget.weeklyUsd` is set:
  - Progress bar, spent / total / percentage display
  - Warning alert at ≥ 80 % of weekly budget

- **Pricing & Settings card** — always-visible card above the Usage History section:
  - Token pricing grid: Input / Output / Cache read / Cache create (per 1M tokens)
  - Status badges: provider type, API enabled/disabled state, cache TTL
  - "⚙ Edit pricing & settings" button opens VSCode settings filtered to `claudeStatus`
  - Collapsible via "▲ Hide" / "▼ Show" toggle (default: expanded)

### Fixed

- **CSP: inline `onclick` attributes blocked** — all `onclick="fn()"` HTML attributes
  have been replaced with `addEventListener` calls (for static buttons) and a single
  document-level event delegation handler (for dynamically generated buttons).
  This fixes Token breakdown, Pricing & Settings toggle, budget configure / save /
  disable buttons, and the "Edit pricing & settings" link — all of which were silently
  blocked by the `script-src 'nonce-...'` Content Security Policy.

### Changed

- `DashboardMessage` now includes `pricing: TokenPricing` and
  `settings: { provider, apiEnabled, cacheTtlSeconds, weeklyBudget }` so the WebView
  can render the Pricing & Settings card and token breakdown without extra round-trips.
- Pricing & Settings card re-renders on every data update to stay in sync when settings
  change while the dashboard is open.

---

## [0.3.3] — 2026-03-05

### Added

- **Multi-provider support** — the extension now handles AWS Bedrock and direct
  API key users in addition to Claude.ai subscriptions:
  - **Auto-detection** (`claudeStatus.claudeProvider: "auto"`, default) — checks
    for an OAuth credentials file first; if absent, inspects environment variables
    (`ANTHROPIC_BEDROCK_BASE_URL`, `AWS_BEDROCK_RUNTIME_URL`, `CLAUDE_AWS_REGION`
    for Bedrock; `ANTHROPIC_API_KEY` for API key); falls back to cost-only display
    when local JSONL data is available, or `Not logged in` when no data exists.
  - **Explicit provider setting** (`claudeStatus.claudeProvider`) — can be set to
    `"claude-ai"`, `"aws-bedrock"`, or `"api-key"` to skip auto-detection.
  - AWS Bedrock / API key users: rate-limit percentages are hidden; status bar
    always shows token cost (`5h:$0.15 7d:$0.42`) computed from local JSONL.
- **`has7dLimit` detection** — the 7 d utilization window is now detected at
  runtime from the presence of `anthropic-ratelimit-unified-7d-reset` response
  header. Plans that only expose a 5 h window (e.g. certain Claude.ai tiers)
  will show only `5h:X%` without a 7 d column.
- **`claudeStatus.claudeProvider`** setting added to `package.json` contributes
  (enum: `"auto"` | `"claude-ai"` | `"aws-bedrock"` | `"api-key"`, default `"auto"`).

### Changed

- **`src/data/apiClient.ts`** — `RateLimitData` gains `has7dLimit: boolean`;
  `fetchRateLimitData` sets it from header presence; `allowed_warning` no longer
  triggers on 7 d utilization when `has7dLimit` is false; new exported
  `detectProvider()` performs credential + env-var probing.
- **`src/data/dataManager.ts`** — `ClaudeUsageData` gains `has7dLimit` and
  `providerType`; `dataSource` union extended with `'local-only'`; `getUsageData`
  skips API rate-limit call for non-claude-ai providers.
- **`src/statusBar.ts`** — `buildLabel` forces cost mode for non-claude-ai
  providers and omits 7 d column when `has7dLimit` is false; `buildTooltip`
  shows rate-limit bars only for claude-ai and adapts header for other providers;
  `applyColor` skips warning/error colours for non-claude-ai providers.
- **`src/config.ts`** — added `claudeProvider` getter.
- **`src/test/suite/statusBar.test.ts`** — `makeData` helper updated with
  `has7dLimit: true` and `providerType: 'claude-ai'` defaults.

---

## [0.3.2] — 2026-03-01

### Added

- **`CONTRIBUTING.md`** (new) — consolidated developer guide replacing
  `DEVELOPMENT.md`; covers local setup, project structure, architecture,
  data flow, JSONL format, token cost formula, CI/CD workflows, release
  procedure, and feature spec index.
- **`.github/dependabot.yml`** (new) — Dependabot configuration for automatic
  dependency updates: npm (weekly, Monday 03:00 JST) and GitHub Actions (weekly,
  Monday 03:00 JST); minor/patch updates grouped; `@types/vscode` major bumps
  ignored; PRs assigned to `long-910` with `dependencies` labels.
- **`package.json`** — Added `sponsor.url` (`https://github.com/sponsors/long-910`)
  and `bugs.url` fields for VS Code Marketplace display.

### Changed

- **`README.md`** / **`README.ja.md`** — Added GitHub Sponsors badge; Contributing
  section now links to `CONTRIBUTING.md`.
- **`package.json`** — Formatted `enum` arrays to multi-line JSON style
  (cosmetic; no functional change).
- **`.gitignore`** — Added `*Zone.Identifier` to suppress Windows/WSL
  alternate data stream files from being tracked.

### Removed

- **`DEVELOPMENT.md`** — content fully migrated to `CONTRIBUTING.md`.
- **`vsc-extension-quickstart.md`** — VS Code scaffold template, superseded
  by project-specific documentation.

---

## [0.3.1] — 2026-02-28

### Changed

- **`README.md`** — split into user-facing content only; removed How It Works,
  CI/CD, and Development sections; fixed Marketplace install section
  (removed "coming soon" label)
- **`README.ja.md`** — full sync with English README in the same structure
- **`DEVELOPMENT.md`** (new) — dedicated developer guide containing:
  data flow, JSONL format, project path mapping, token cost formula,
  CI/CD workflows, release procedure, local setup, project structure,
  and architecture diagram
- **`CLAUDE.md`** — added rule: never push directly to `main`; always open a PR

---

## [0.3.0] — 2026-02-28

### Added

#### Session History Heatmap — Feature 05

- **`src/webview/heatmap.ts`** (new) — Data aggregation engine:
  - `getHeatmapData(days)` — reads all projects' JSONL in parallel
    (`Promise.all`); skips directories/files with `mtime < cutoff` for
    performance; returns `HeatmapData { daily, hourly, generatedAt }`.
  - `aggregateByDay(entries, days)` — groups entries by local date key
    (`YYYY-MM-DD`), fills every day in the window with zeroes for gaps,
    returns array in ascending date order.
  - `aggregateByHour(entries, days)` — buckets entries into 24 local-hour
    slots for the last 30 days, computes `avgCost` and `count` per hour.
  - Helper functions exported for unit testing.
- **`src/data/dataManager.ts`** — Added `getHeatmapData()` with a 5-minute
  in-memory TTL cache and `getLastHeatmapData()` (synchronous).
  `refresh()` / `forceRefresh()` fire `onDidUpdate` twice: once immediately
  (fast; usage + prediction), then again when the heatmap finishes in the
  background (`refreshHeatmapBackground()`). A `heatmapPending` guard
  prevents concurrent recomputes.
- **`src/webview/panel.ts`** — Full heatmap section in the dashboard:
  - **Daily heatmap** — CSS grid (`grid-template-rows: repeat(7, 12px);
grid-auto-flow: column`) with day-of-week padding for correct alignment,
    month labels, five green intensity levels (l0–l4) based on cost relative
    to the window maximum, hover tooltip showing date + cost + message count.
  - **Hourly bar chart** — `<canvas id="hourlyChart">` rendered by
    Chart.js 4.4.0 loaded from `cdn.jsdelivr.net`; respects VS Code CSS
    variables for foreground and progress-bar colours; previous chart
    instance is destroyed before re-render to prevent leaks.
  - Chart.js CDN script tag added (nonce-gated, allowed by existing CSP).
  - `HeatmapData` placeholder type replaced with real import from
    `dataManager`; `sendUpdate()` passes `getLastHeatmapData()`.
  - On WebView `ready`, a background heatmap load is triggered if no cached
    data is available, followed by a second `sendUpdate` when complete.
- **`src/test/suite/heatmap.test.ts`** (new) — Unit tests for pure functions:
  `aggregateByDay` (length, zero-fill, cost accumulation, date format, sort
  order) and `aggregateByHour` (length, hour indices, avg computation, window
  cutoff).

---

## [0.2.0] — 2026-02-28

### Added

#### Usage Prediction & Budget Alerts — Feature 04

- **`src/data/prediction.ts`** (new) — Prediction engine with three exported
  pure functions (`calculateBurnRate`, `buildRecommendation`) and a main async
  entry point (`computePrediction`):
  - Reads the last 30-minute JSONL window to compute a burn rate in USD/hour.
  - Estimates time until the 5 h rate-limit window is exhausted:
    derives total capacity from `cost5h / utilization5h`, then divides
    remaining capacity by current burn rate; result is capped at `resetIn5h`
    so the prediction is never beyond the next window reset.
  - Returns `safeToStartHeavyTask: true` when > 30 minutes remain.
  - Optional daily budget: computes `budgetRemaining` and `budgetExhaustionTime`
    from `costToday` and burn rate.
- **`src/data/dataManager.ts`** — Added `getPrediction()` (computes fresh,
  caches result) and `getLastPrediction()` (returns cached value synchronously).
  `refresh()` / `forceRefresh()` now call `getPrediction()` before firing
  `onDidUpdate`, so notification listeners always see an up-to-date prediction.
- **`src/config.ts`** — Added `setDailyBudget(value: number | null)` method.
- **`src/webview/panel.ts`** — Replaced placeholder `PredictionData` type with
  the real import from `dataManager`. `sendUpdate()` is now `async` and calls
  `getPrediction()` on each update. The Prediction card in the dashboard now
  shows:
  - Burn rate row (`$X.XX/hr`)
  - Rate-limit exhaustion alert (info / warning / error styling by severity)
  - Daily budget progress bar + exhaustion time (when budget is set)
  - Collapsible budget input form ("⚙ Set daily budget" / "⚙ Configure budget")
  - Recommendation text
    The `setBudget` message handler now calls `config.setDailyBudget()` and
    triggers `forceRefresh()` instead of a no-op placeholder.
- **`src/extension.ts`** — Notification system:
  - `notifiedKeys` `Set<string>` deduplicates alerts within a session window.
  - `checkWindowReset()` clears keys when `resetIn5h` jumps by > 1 h (window
    reset detected).
  - `checkAndNotify()` fires `showWarningMessage` at ≤ threshold minutes,
    `showErrorMessage` with "Open Dashboard" action at ≤ 10 min; marks key
    **before** `await` to prevent duplicate dialogs.
  - Budget warning fires once when `budgetRemaining / dailyBudget` falls below
    `(100 − alertThresholdPercent) %`.
  - `vscode-claude-status.setBudget` command now opens an `InputBox` with
    validation; empty input disables the budget, a number saves it.
- **`src/test/suite/prediction.test.ts`** (new) — Unit tests for pure functions:
  `calculateBurnRate` (zero-entry edge case, positive rate) and
  `buildRecommendation` (all four severity levels).

---

## [0.1.0] — 2026-02-28

Initial release implementing the full data layer, status bar, WebView dashboard,
and project-level cost tracking.

### Added

#### Data Layer (`src/data/`)

- **`jsonlReader.ts`** — Parses `~/.claude/projects/**/*.jsonl` locally (no network);
  aggregates `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` for the last 5 h, today, and 7 d windows.
  Calculates USD cost using Claude Sonnet 4.x pricing
  ($3.00 / $15.00 / $0.30 / $3.75 per 1 M tokens).
- **`apiClient.ts`** — Fetches Anthropic rate-limit utilization headers
  (`anthropic-ratelimit-unified-5h-utilization`, `7d-utilization`, reset times)
  with a minimum 5-minute call interval when Claude Code is idle.
  Reads OAuth token from `~/.claude/.credentials.json`.
- **`cache.ts`** — Disk-backed JSON cache at `~/.claude/vscode-claude-status-cache.json`
  (version 1). Stores API response only; JSONL costs are always read fresh.
  Exposes `readCache()`, `writeCache()`, `isCacheValid()`, `getCacheAge()`.
- **`dataManager.ts`** — Singleton data orchestrator. Owns a
  `vscode.EventEmitter<ClaudeUsageData>` that fires on every refresh.
  Starts a `FileSystemWatcher` on `~/.claude/projects/**/*.jsonl` so the
  extension reacts within seconds of any Claude Code activity.
  Exposes `getUsageData()`, `forceRefresh()`, `refreshProjectCosts()`.
- **`projectCost.ts`** — Maps open VS Code workspace folders to their Claude Code
  session directories using two strategies:
  1. Hash: replace every non-alphanumeric character with `-`
     (`/home/user/my-app` → `-home-user-my-app`).
  2. Fallback: scan JSONL `cwd` fields for exact path match.
     Aggregates `costToday`, `cost7d`, `cost30d`, `sessionCount`, `lastActive`
     per project. Multi-root workspaces are each tracked independently.

#### Status Bar (`src/statusBar.ts`)

- Persistent status bar item (left-aligned, priority 10).
- **Percent mode** (default): `🤖 5h:45% 7d:62%`
- **Cost mode**: `🤖 5h:$14.21 7d:$53.17`
- Warning indicator `⚠` when utilisation ≥ 75 %.
- Denied indicator `✗` when rate limit is hit.
- Stale cache suffix `[10m ago]` when cached data is more than 5 minutes old.
- Project cost suffix `| my-app:$3.21` (single workspace) or
  `| PJ:$5.43` (multi-root aggregate).
- Rich hover tooltip with full token breakdown, reset countdown, and project
  cost table.

#### WebView Dashboard (`src/webview/panel.ts`)

- `DashboardPanel` singleton — opens a side panel with live usage data.
- HTML/CSS/JS embedded as a TypeScript template literal (no separate HTML
  file required; compatible with webpack bundling and `.vscodeignore`).
- Content Security Policy with per-session nonce; Chart.js loaded from CDN.
- Sections: Current Usage (colour-coded progress bars), Token Cost (5 h /
  today / 7 d), Project Cost (today / 7 d / 30 d per workspace folder).
- Responds to `vscode.postMessage` protocol: `ready`, `refresh`,
  `toggleMode`, `setBudget` from panel → extension; `update`,
  `setDisplayMode` from extension → panel.
- Supports VS Code light, dark, and high-contrast themes via CSS variables.

#### Extension Entry Point (`src/extension.ts`)

- Activation event: `onStartupFinished`.
- Commands registered:
  - `vscode-claude-status.openDashboard` — open / reveal dashboard panel.
  - `vscode-claude-status.refresh` — force immediate API + JSONL refresh.
  - `vscode-claude-status.toggleDisplayMode` — toggle `%` ↔ `$` mode.
  - `vscode-claude-status.setBudget` — set or disable daily budget via InputBox.
- Keyboard shortcut: `Ctrl+Shift+Alt+C` (`⌘⇧⌥C` on macOS) for toggle.
- 60-second render timer for stale-age display even when JSONL is unchanged.
- Workspace folder change listener re-fetches project costs automatically.

#### Configuration (`package.json` contributes)

- `claudeStatus.displayMode` (`"percent"` | `"cost"`, default `"percent"`)
- `claudeStatus.statusBar.alignment` (`"left"` | `"right"`, default `"left"`)
- `claudeStatus.statusBar.showProjectCost` (boolean, default `true`)
- `claudeStatus.cache.ttlSeconds` (60–3600, default `300`)
- `claudeStatus.realtime.enabled` (boolean, default `false`)
- `claudeStatus.budget.dailyUsd` (number | null, default `null`)
- `claudeStatus.budget.weeklyUsd` (number | null, default `null`)
- `claudeStatus.budget.alertThresholdPercent` (1–100, default `80`)
- `claudeStatus.notifications.rateLimitWarning` (boolean, default `true`)
- `claudeStatus.notifications.rateLimitWarningThresholdMinutes` (5–120, default `30`)
- `claudeStatus.notifications.budgetWarning` (boolean, default `true`)
- `claudeStatus.heatmap.days` (30 | 60 | 90, default `90`)
- `claudeStatus.credentials.path` (string | null, default `null`)

#### Tests (`src/test/suite/`)

- `jsonlReader.test.ts` — unit tests for `calculateCost()` pricing formula.
- `cache.test.ts` — unit tests for `isCacheValid()` and `getCacheAge()`.
- `statusBar.test.ts` — label / tooltip builder tests covering all display
  states (not-logged-in, no-data, denied, warning, stale, project costs,
  multi-root aggregate).
- `projectCost.test.ts` — unit tests for `workspacePathToHash()` including
  the real-world `sb_git` path verified against live Claude Code data.

### Technical Notes

- JSONL entries are read from `entry.message.usage` (not `entry.usage` as
  some older docs suggest); the `costUSD` field is not present in current
  Claude Code output and is therefore always computed client-side.
- Project directory hash uses `replace(/[^a-zA-Z0-9]/g, '-')` — verified
  against real `~/.claude/projects/` directory names.

---

[0.6.1]: https://github.com/long-910/vscode-claude-status/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/long-910/vscode-claude-status/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/long-910/vscode-claude-status/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/long-910/vscode-claude-status/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/long-910/vscode-claude-status/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/long-910/vscode-claude-status/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/long-910/vscode-claude-status/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/long-910/vscode-claude-status/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/long-910/vscode-claude-status/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/long-910/vscode-claude-status/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/long-910/vscode-claude-status/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/long-910/vscode-claude-status/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/long-910/vscode-claude-status/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/long-910/vscode-claude-status/releases/tag/v0.1.0
