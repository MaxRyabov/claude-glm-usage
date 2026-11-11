# Feature 01: Status Bar Display

## Purpose

Always-visible Claude Code usage summary in the VSCode status bar (bottom bar).
Lightweight, non-blocking, updates automatically.

---

## Display Format

The ` · ` (middle dot) separates the major segments — [quota windows + peak badge] →
context → project cost. Inside the first group the windows and the ⚡ badge are joined
by plain spaces. Each optional segment hides when it has no data.

### Percent mode (default — claude-ai and z-ai, `displayMode: "percent"`)

```
🤖 5h:78% 7d:84% · my-app:$3.21
```

### Warning mode (≥75% utilization)
```
🤖 5h:78%⚠ 7d:84%⚠ · my-app:$3.21
```

### Denied (limit reached)
```
🤖 5h:100%✗ · my-app:$3.21
```

### z-ai in peak hours (UTC weekdays 06:00–10:00)
```
🤖 5h:12% 7d:3% ⚡ · ctx 38% · my-app:§2.8k
```
- `⚡` — peak tariff is active (double credits); shown only for the z-ai provider,
  even when the quota API is off. Recomputed on every render tick from the clock
  alone — it never triggers a provider request. The window is defined in **UTC**:
  weekdays Mon–Fri, `[06:00, 10:00)` UTC (start inclusive, end exclusive) — the
  weekday and the hours come from the UTC calendar, not the machine zone. The
  tooltip's `Peak …` line renders the window in the local time zone for
  convenience: inside the window it names the local end time (`Peak until 13:00`),
  outside it names the local boundaries (`Peak 09:00–13:00 (UTC+3)`); DST
  transitions shift that local rendering but never the window itself.
- `ctx 38%` — context fill of the workspace's active session (last turn's
  input + cache_read + cache_creation vs the model's context window). Hidden when
  there is no fresh (< 6 h, `ACTIVE_SESSION_FRESHNESS_MS` in
  `src/data/entryCache.ts`) session. `⚠` appears at the auto-compact edge
  (window − `CONTEXT_WARN_MARGIN_TOKENS` = 20k tokens, capped at 10% of the
  window; both are fixed constants in `src/data/contextFill.ts`, not settings),
  e.g. `ctx 93%⚠`; a `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override set below the real
  fill shows its true value (`ctx 104%`) without clamping.
- `§2.8k` — the cost segment follows `claudeStatus.display.primaryUnit`
  (`auto | credits | usd`, default `auto`): credits (§) for z-ai, dollars ($)
  for everyone else; explicit `credits` degrade to dollars on providers without
  a credit tariff. Applies to the project segment, cost-mode windows
  (`5h:§2.8k 7d:§9.1k`) and the cost tooltip. Budgets always stay in USD.

### Stale data (cache expired, or `rateLimitApi.enabled: false` with cached data)
```
🤖 5h:78% 7d:84% [32m ago] · my-app:$3.21   ← minutes (< 1 h)
🤖 5h:78% 7d:84% [2h 15m ago] · my-app:$3.21 ← hours  (1 h – 23 h)
🤖 5h:78% 7d:84% [1d 3h ago] · my-app:$3.21  ← days   (≥ 24 h)
```

### Cost mode (non-claude-ai provider, or `displayMode: "cost"`)
```
🤖 5h:$14.21 7d:$53.17 · my-app:$3.21        ← primary unit usd
🤖 5h:§2.8k 7d:§9.1k · my-app:§2.8k          ← primary unit credits (z-ai)
```

### No data yet (initial state)
```
🤖 Claude: run refresh
```

### No credentials
```
🤖 Not logged in
```

### Rejected credentials (auth-rejected)
```
🤖 Access refused      ← claude-ai, HTTP 403
🤖 Login rejected      ← claude-ai, other auth failures
🤖 API key rejected    ← any other provider
```

Degraded states (`no-credentials`, `no-data`, `auth-rejected`) never show the
peak badge or the context segment. `no-data` means no quota cache **and** no local
JSONL cost data — the whole label is replaced. A z-ai window without a quota cache
but with local cost data (`local-only`) is not degraded: it shows the cost windows,
the ⚡ badge and the context segment as usual.

---

## Provider Behavior

| Provider | Rate % shown | Mode | Peak ⚡ | Primary unit |
|----------|-------------|------|---------|--------------|
| `claude-ai`, API enabled | Yes | percent (default) or cost | never | usd |
| `claude-ai`, API disabled, cache exists | Yes (stale) | percent with `[X ago]` (m / h / d) | never | usd |
| `claude-ai`, API disabled, no cache | No | cost only | never | usd |
| `z-ai`, API enabled | Yes (quota) | percent (default) or cost | only in peak window | credits (auto) |
| `z-ai`, API disabled, cache exists | Yes (stale, quota) | percent with `[X ago]` (m / h / d) | only in peak window | credits (auto) |
| `z-ai`, API disabled / no quota cache (local cost data present) | No | cost only (local-only) | only in peak window | credits (auto) |
| `aws-bedrock` / `api-key` / `unknown` | No | cost only (always) | never | usd |

---

## Status Bar Item Specification

```typescript
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left,
  100  // priority — appears near left side
)
statusBarItem.name = 'Claude Code Usage'  // for screen readers
statusBarItem.command = 'vscode-claude-status.openDashboard'
statusBarItem.tooltip = buildTooltip(data)
```

### Position

Left side of status bar, priority 100.
Configurable via `claudeStatus.statusBar.alignment` setting (`'left'` | `'right'`).

---

## Color Coding

Use VSCode theme color IDs (not hardcoded hex):

| State | Background | Foreground |
|-------|-----------|------------|
| Normal (< 75%) | — | — (default) |
| Warning (≥ 75%) | `statusBarItem.warningBackground` | `statusBarItem.warningForeground` |
| Denied (100%) | `statusBarItem.errorBackground` | `statusBarItem.errorForeground` |
| Stale data | — | `descriptionForeground` (dimmed) |
| No credentials | `statusBarItem.errorBackground` | `statusBarItem.errorForeground` |
| Rejected credentials (auth-rejected) | `statusBarItem.errorBackground` | `statusBarItem.errorForeground` |
| Non-claude-ai | — | — (default) |

```typescript
function applyColor(item: vscode.StatusBarItem, data: ClaudeUsageData): void {
  const { limitStatus, dataSource, providerType } = data

  if (dataSource === 'no-credentials') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    item.color = new vscode.ThemeColor('statusBarItem.errorForeground')
    return
  }
  if (dataSource === 'stale') {
    item.backgroundColor = undefined
    item.color = new vscode.ThemeColor('descriptionForeground')
    return
  }
  // Non-claude-ai providers: no warning/error colors
  if (providerType !== 'claude-ai') {
    item.backgroundColor = undefined
    item.color = undefined
    return
  }
  switch (limitStatus) {
    case 'denied':
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
      item.color = new vscode.ThemeColor('statusBarItem.errorForeground')
      break
    case 'allowed_warning':
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      item.color = new vscode.ThemeColor('statusBarItem.warningForeground')
      break
    default:
      item.backgroundColor = undefined
      item.color = undefined
  }
}
```

---

## Tooltip (hover text)

### Claude.ai provider
```
Claude Code Usage
─────────────────────────────
5h window:   78% [XXXXXX..] resets in 2h 47m
7d window:   84% [XXXXXXX.] resets in 4d 8h

Token Cost (local)
─────────────────────────────
5h:   in:38.5K out:127.8K  $14.21
day:  $14.21
7d:   $53.17

Project: my-app
  Today: $3.21  |  7d: $18.45

Last updated: just now
Click to open dashboard →
```

### z.ai provider (peak line + credits)
```
Z.AI Usage
Peak until 13:00            ← inside the peak window (local time)
─────────────────────────────
5h window:   12% [X........] resets in 3h 05m
7d window:   3%  [.........] resets in 6d 2h

Context: 38%                ← mirrors the ctx segment (hidden without a fresh session)

Token Cost (local)
─────────────────────────────
5h:   in:38.5K out:127.8K  §2.8k
day:  §11.0k
7d:   §44.0k

Project: my-app
  Today: §2.8k  |  7d: §41.0k

Last updated: just now
Click to open dashboard →
```
Outside the peak the second line names the window boundaries in the local zone:
`Peak 09:00–13:00 (UTC+3)`. The tooltip follows the primary unit; budgets stay in USD.

### Non-claude-ai provider (e.g. AWS Bedrock)
```
Claude Code (AWS Bedrock)
─────────────────────────────

Token Cost (local)
─────────────────────────────
5h:   in:38.5K out:127.8K  $14.21
day:  $14.21
7d:   $53.17

Last updated: just now
Click to open dashboard →
```

Build with `\n`-separated string. VSCode renders tooltip as plain text.

---

## Update Timing

| Event | Action |
|-------|--------|
| Extension activation | Read cache → update immediately |
| JSONL file change (FileWatcher) | `DataManager.refresh()` → update |
| Timer (every 60 seconds) | Re-render from cache (no API call) |
| User clicks "↻ Refresh" in WebView | `DataManager.forceRefresh()` → update |

The ⚡ peak badge and the local clock part of the tooltip are recomputed from the
current time on every re-render (`buildLabel`/`buildTooltip` take a `now` parameter,
defaulting to the wall clock) — entering/leaving the peak window is reflected with at
most one cycle of delay, without a separate timer and without any provider request.
Changing `claudeStatus.display.primaryUnit` re-renders immediately via the existing
`onDidChangeConfiguration` handler — no restart needed.

Timer implementation:
```typescript
const timer = setInterval(() => {
  dataManager.refresh().catch(() => {})
}, 60_000)
context.subscriptions.push({ dispose: () => clearInterval(timer) })
```

---

## Display Toggle (Cost Mode)

Command: `vscode-claude-status.toggleDisplayMode`
Keyboard: `Ctrl+Shift+Alt+C` (default, configurable)

In cost mode, replace utilization percentage with dollar amount:
```
🤖 5h:$14.21 7d:$53.17 | my-app:$3.21
```

Toggle state is persisted in `vscode.workspace.getConfiguration()`:
```typescript
config.setDisplayMode('cost')  // → claudeStatus.displayMode
```

---

## Accessibility

- `statusBarItem.name = 'Claude Code Usage'` — for screen readers
- Tooltip must convey all information shown in the label
- Do not rely solely on color to convey state (use text indicators ⚠ ✗)
