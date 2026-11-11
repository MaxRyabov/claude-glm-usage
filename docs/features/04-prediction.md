# Feature 04: Usage Prediction & Budget Alerts

## Purpose

**VSCode-exclusive feature** — predict when the rate limit will be exhausted
based on the current burn rate, and alert the user before it happens.
Also supports a user-defined USD budget with its own alert threshold.

---

## Prediction Engine (`src/data/prediction.ts`)

### Burn Rate Calculation

Use a sliding window of the **last 30 minutes** of JSONL entries — one engine, two units.
The same window yields USD/hour and z.ai credits/hour, so the two numbers a dashboard
shows next to each other can never diverge:

```typescript
export function calculateBurnRate(entries: ReadonlyArray<{ timestamp: number; cost: number }>): number
export function calculateCreditsBurnRate(entries: ReadonlyArray<{ timestamp: number; credits: number }>): number
// Both: fewer than 2 turns → 0; otherwise sum ÷ (now − first turn), per hour.
```

Turns are read from the main session files **and** `<session>/subagents/*.jsonl` — without
the subagent turns the credit speed is systematically understated. Credits follow
`creditsForEntry` (GLM-only models, peak factor 0.5 outside UTC weekdays 06:00–10:00 by the
turn's own timestamp).

> **Note:** Costs are always calculated from token counts (`entry.message.usage`).
> There is no `costUSD` field in JSONL.

### Rate Limit Exhaustion Prediction

```typescript
export async function computePrediction(input: PredictionInput): Promise<PredictionData>

export interface PredictionInput {
  utilization5h: number        // 0.0–1.0
  resetIn5h: number            // seconds until reset; caps the exhaustion horizon
  spend5h: number              // window spend in the utilization unit: USD cost5h for
                               //   claude-ai, locally counted credits5h for z-ai
  costToday: number            // USD, for the budget path
  dailyBudget: number | null
  fallbackUnit?: 'usd' | 'credits'  // unit of spend5h and of the fallback burn rate
  quotaCredits?: QuotaAmounts | null  // live z.ai quota with absolute amounts — pass it
                               //   only when actsOnRateData admits the data: a stale
                               //   remainder must not drive a forecast
  pricingCtx?: PricingContext  // per-model pricing for the USD burn rate
}
```

**Algorithm** (`predictFromTurns` in `src/data/prediction.ts`):

1. Read the turns of the last 30 minutes; compute `burnRateUsdPerHour` and
   `burnRateCreditsPerHour` from them.
2. If `utilization5h >= 1.0`: already exhausted → `estimatedExhaustionIn = 0`.
3. **Quota-checked path** — live z.ai quota with absolute amounts (`quotaCredits`):
   - remaining = `quotaCredits.remaining ?? (quotaCredits.total − quotaCredits.used)`
     — `remaining` is used exactly as reported, never recomputed;
   - remaining ≤ 0 → the limit is reached now (`rate-limit-reached`);
   - credits burn rate 0 (no turns in the window) → **no exhaustion forecast at all**;
   - `remaining / burn ≥ resetIn5h` → `exhaustsBeforeReset = false` and the
     `survives-reset` recommendation: "The 5h window will not be exhausted before the
     reset.";
   - otherwise the exhaustion time is capped at `resetIn5h` (exhaustion can't happen
     after the window resets), `creditsRemaining5h` carries the remaining §.
4. **Utilization fallback** — no absolute amounts: estimate capacity from
   `spend5h / utilization5h`, remaining share `× (1.0 − utilization5h)`, divide by the
   burn rate **in spend5h's own unit** (`fallbackUnit`), cap at `resetIn5h`.
5. `safeToStartHeavyTask = effectiveSeconds > 1800` (30 min threshold).

One rate per window means the forecast errs up to 2× either way at the peak-window
boundaries — leaving the peak it is pessimistic, entering it optimistic.

### Recommendation Text

```typescript
export function buildRecommendation(exhaustionIn: number): string {
  if (exhaustionIn < 600)   return 'Less than 10 min remaining. Save your work and pause.'
  if (exhaustionIn < 1800)  return 'Less than 30 min remaining. Wrap up current task.'
  if (exhaustionIn < 3600)  return 'About 1 hour remaining. Plan your next task accordingly.'
  return 'Plenty of capacity. Safe to start heavy tasks.'
}
```

---

## Budget System

### User Configuration

```json
// settings.json
{
  "claudeStatus.budget.dailyUsd": 20.0,
  "claudeStatus.budget.weeklyUsd": 100.0,
  "claudeStatus.budget.alertThresholdPercent": 80
}
```

Default: no budget set (`null` = disabled).

### Budget Exhaustion Prediction

```typescript
// In computePrediction():
if (dailyBudget !== null) {
  const remaining = dailyBudget - costToday
  budgetRemaining = Math.max(0, remaining)
  if (remaining <= 0) {
    budgetExhaustionTime = new Date()
  } else if (burnRateUsdPerHour > 0) {
    const hoursUntil = remaining / burnRateUsdPerHour
    budgetExhaustionTime = new Date(Date.now() + hoursUntil * 3600 * 1000)
  }
}
```

---

## Notification System

### VSCode Notifications

Rate-limit notifications are driven by the **actual quota utilization** of each window
(`utilization5h` / `utilization7d`), not by the time-to-exhaustion prediction. The prediction is
still computed and shown in the dashboard, but it no longer triggers alerts — see
[`notificationDecision.ts`](../../src/data/notificationDecision.ts) for the pure decision logic.

Stepped behavior (thresholds are configurable, see [SETTINGS.md](../SETTINGS.md)):

- **5h window** — silent below 90% used; a **warning** on each 2% step (90, 92, 94, 96, 98); a
  distinct **error** ("5h rate limit reached", with *Open Dashboard*) at 100%.
- **7d window** — silent below 80% used; a **warning** on each 5% step at 80, 85, 90 (capped at 90),
  only when the provider exposes a 7d window (`has7dLimit`).

Each step is shown at most once per window and re-arms when that window resets. Only the current
(highest) step per window is emitted, since utilization is monotonic within a window.

```typescript
async function checkAndNotify(data: ClaudeUsageData, config: ExtensionConfig) {
  if (config.rateLimitWarning) {
    for (const n of decideRateLimitNotifications(data, config.rateLimitThresholds, notifiedKeys)) {
      markNotified(n.key) // mark before await to prevent duplicates
      const reset = formatDuration(n.resetIn)
      if (n.reached) {
        const action = await vscode.window.showErrorMessage(
          `Claude Code: 5h rate limit reached — resets in ${reset}`,
          'Open Dashboard', 'Dismiss'
        )
        if (action === 'Open Dashboard') openDashboard()
      } else {
        vscode.window.showWarningMessage(
          `Claude Code: ${n.window} limit ${n.percentUsed}% used — resets in ${reset}`
        )
      }
    }
  }

  if (prediction.budgetRemaining !== null && config.dailyBudget) {
    const used = config.dailyBudget - prediction.budgetRemaining
    const pct = (used / config.dailyBudget) * 100
    if (pct >= config.budgetAlertThreshold && !wasNotified('budget')) {
      vscode.window.showWarningMessage(
        `Claude Code: Daily budget ${Math.round(pct)}% used ($${used.toFixed(2)} / $${config.dailyBudget})`
      )
      markNotified('budget')
    }
  }
}
```

### Notification Deduplication

Notifications must not repeat within a single window. Use an in-memory `Set<string>` of notified
keys, namespaced per window (`5h-92`, `7d-85`). Keys for a window are cleared when that window
resets, so each step re-arms exactly once per fresh window.

```typescript
const notifiedKeys = new Set<string>()

function markNotified(key: string): void { notifiedKeys.add(key) }
function clearWindowKeys(prefix: string): void {
  for (const key of notifiedKeys) if (key.startsWith(prefix)) notifiedKeys.delete(key)
}
// On a 5h rollover: clearWindowKeys('5h-'); on a 7d rollover: clearWindowKeys('7d-')
```

---

## WebView Display

In the Prediction card of the dashboard:

```html
<div class="card">
  <p class="card-title">Prediction</p>

  <!-- Burn rate — the same two-unit speed the Now panel shows:
       "412 cr/hr · $1.42/hr" for z-ai (primary unit first), "$4.2/hr" otherwise -->
  <div class="cost-row"><span class="cost-label">Burn rate</span>
    <span>412 cr/hr · $1.42/hr</span></div>

  <!-- Credit path — only when the live quota reported absolute amounts
       (creditsRemaining5h is host-gated on actsOnRateData) -->
  <div class="cost-row"><span class="cost-label">5h credits left</span>
    <span>§11.3k</span></div>

  <!-- Rate limit prediction; the quota-checked path that survives says exactly that
       (recommendationKey "survives-reset") instead of a time -->
  <div class="alert warning">
    ⚠️ 5h limit in ~45 min (at 14:23)
  </div>

  <!-- Budget (if configured) -->
  <div class="cost-row">
    <span class="cost-label">Daily budget</span>
    <span>$3.21 / $20.00 (16%)</span>
  </div>
  <div class="progress-track">
    <div class="progress-fill" style="width: 16%"></div>
  </div>

  <div class="prediction-row">💡 Wrap up current task.</div>

  <!-- Budget configure input (always visible in dashboard) -->
  <div class="budget-configure">
    <label>Daily budget ($)</label>
    <input type="number" id="dailyBudget" min="0" step="5">
    <button id="btn-save-budget">Save</button>
    <button id="btn-clear-budget">Clear</button>
  </div>
</div>
```

The burn-speed line itself is built by one page helper, `speedText` in
`src/webview/panel.ts`: dollars always, credits alongside for z-ai, ordered by
`units.primary`. The Now panel shows the same line, plus the quota reconciliation
"local §2.8k · quota §3.1k over 5h" (see
[02-webview.md](02-webview.md), "Now panel").
