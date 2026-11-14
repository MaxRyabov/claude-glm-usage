# Data Layer Specification

## 1. JSONL Reader (`src/data/jsonlReader.ts`)

### Source Files

Claude Code writes session data to:
```
~/.claude/projects/<project-hash>/*.jsonl
```

Each line is a JSON object. Relevant fields (verified against Claude Code v2.1.x):

```jsonc
// 'assistant' type entries contain usage data
{
  "type": "assistant",
  "timestamp": "2026-02-24T10:23:45.123Z",
  "cwd": "/home/user/my-project",
  "message": {
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_read_input_tokens": 8900,
      "cache_creation_input_tokens": 450
    }
  }
}
```

> **Important verified facts:**
> - `costUSD` field does **not** exist — always calculate cost from token counts
> - Usage data is at `entry.message.usage`, **not** `entry.usage`
> - Only `type === 'assistant'` entries have usage; skip all other types
> - `cwd` is at the top level of every entry
> - Skip lines that fail to parse or lack required fields — never throw on parse errors

### Cost Calculation

Cost is computed **per model**: each JSONL entry's `message.model` is resolved to a
`TokenPricing` by `resolvePricing()` in [`src/data/pricing.ts`](../src/data/pricing.ts).
Resolution precedence:

1. `claudeStatus.pricing.models` override (keyed by model name/prefix) →
2. built-in `MODEL_PRICING` table (z.ai GLM tiers + Claude tiers, longest-prefix match) →
3. provider default (`z-ai` → GLM-4.7 rates) →
4. the flat `claudeStatus.pricing.*` fallback below.

`<synthetic>`, empty models, and free flash tiers resolve to zero. This means GLM usage is
priced at GLM rates, Claude usage at Claude rates, and mixed usage blends correctly.

The flat `claudeStatus.pricing.*` settings are the **fallback for unknown models** (defaults
based on Claude Sonnet 4.x):

| Token type | Setting key | Default (USD / 1M) |
|------------|-------------|-------------------|
| Input | `claudeStatus.pricing.inputPerMillion` | $3.00 |
| Output | `claudeStatus.pricing.outputPerMillion` | $15.00 |
| Cache read | `claudeStatus.pricing.cacheReadPerMillion` | $0.30 |
| Cache create | `claudeStatus.pricing.cacheCreatePerMillion` | $3.75 |

> [!WARNING]
> **Pricing disclaimer — costs are estimates only.**
> Default rates reflect Anthropic's publicly announced pricing at the time of
> implementation. Anthropic may change rates at any time without notice.
> If pricing has changed, update the `claudeStatus.pricing.*` settings to match
> the latest figures on the [Anthropic pricing page](https://www.anthropic.com/pricing).

```typescript
export interface TokenPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreatePerMillion: number
}

function calculateCost(usage: TokenUsage, pricing: TokenPricing): number {
  return (
    ((usage.input_tokens || 0) / 1_000_000) * pricing.inputPerMillion +
    ((usage.output_tokens || 0) / 1_000_000) * pricing.outputPerMillion +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheReadPerMillion +
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cacheCreatePerMillion
  )
}
```

### z.ai Credits (§) — `src/data/credits.ts`

The z.ai coding plan bills usage in credits, not USD. Next to every USD aggregate the
reader accumulates credits in the **same pass**, one turn at a time:

```typescript
export const GLM_CREDIT_MULTIPLIERS: CreditMultipliers = { input: 6.9, cacheRead: 1.7, output: 24 };
export const GLM_FLASH_CREDIT_MULTIPLIERS: CreditMultipliers = { input: 2.3, cacheRead: 0.56, output: 8 };

export const CREDITS_DIVISOR = 10_000;
export const OFF_PEAK_FACTOR = 0.5;

function creditMultipliersFor(model: string | undefined): CreditMultipliers | null {
  if (!isCreditModel(model)) { return null; }
  return (model ?? '').toLowerCase().includes('flash')
    ? GLM_FLASH_CREDIT_MULTIPLIERS
    : GLM_CREDIT_MULTIPLIERS;
}

export function creditsForEntry(entry: CreditEntry, peakActive: boolean): number {
  const m = creditMultipliersFor(entry.model);
  if (!m) { return 0; }
  const weighted =
    (entry.usage.input_tokens || 0) * m.input +
    (entry.usage.cache_read_input_tokens || 0) * m.cacheRead +
    (entry.usage.output_tokens || 0) * m.output;
  const credits = weighted / CREDITS_DIVISOR;
  return peakActive ? credits : credits * OFF_PEAK_FACTOR;
}
```

> **Important verified facts:**
> - `cache_creation_input_tokens` is **not** billed: z.ai folds cache writes into the
>   input term.
> - The GLM filter is by **model name only** — `isCreditModel` is
>   `name.includes('glm') || name.includes('flash')`. A JSONL record carries no provider,
>   and the history can be mixed (a live 7-day sample: 43 736 `glm-5.3` turns next to
>   3 023 `claude-opus-5-5` turns), so `claude-*` and unknown models earn **0 credits** —
>   they must never be charged at z.ai multipliers.
> - The off-peak factor 0.5 is applied by `peakActive = isPeakAt(turn.timestamp)` — the
>   turn's **own** timestamp, not the current moment: a session crossing 10:00 UTC is
>   billed at both rates.
> - **MCP calls are not represented in the formula.** `server_tool_use` entries carry no
>   billing terms here, so the local credit count converges with the quota only *up to
>   MCP usage* — the dashboard reconciliation line ("local §X · by quota §Y over 5h")
>   shows exactly this residual.
> - **Multiplier source:** the two tables above are z.ai plan constants (credits per
>   10k tokens per token class) from the z.ai quota handbook, re-verified 2026-11-10
>   against a live session — they are not user-configurable.

### Peak Hours (z.ai) — `src/data/peakHours.ts`

The peak window is a **tariff constant in UTC** (not configurable; z.ai fixes it):

```typescript
const PEAK_START_UTC_HOUR = 6;       // 06:00 UTC, inclusive
const PEAK_END_UTC_HOUR = 10;        // 10:00 UTC, exclusive (14:00–18:00 SGT)
const PEAK_START_UTC_MIN = PEAK_START_UTC_HOUR * 60;
const PEAK_END_UTC_MIN = PEAK_END_UTC_HOUR * 60;

export function isPeakAt(timestampMs: number): boolean {
  const d = new Date(timestampMs);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) { return false; }   // Sat/Sun
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= PEAK_START_UTC_MIN && mins < PEAK_END_UTC_MIN;
}
```

`peakStatus(now, providerType)` returns `{ active, windowStartMs, windowEndMs,
windowStartLocal, windowEndLocal, tzLabel }` for the status-bar ⚡ segment and the
dashboard, or **null for every provider except `z-ai`** — `if (providerType !== 'z-ai')
{ return null; }`. Local labels come from `Intl.DateTimeFormat` at the window moment.

> **Prediction accuracy at the peak boundary.** The forecast extrapolates with a single
> burn rate measured over the last 30 minutes, so near a window edge it can be off by up
> to **2× in either direction**: leaving the peak makes it pessimistic (the rate still
> carries peak-priced turns), a fully off-peak window right before the peak makes it
> optimistic (the next hour bills double). Piecewise peak/off-peak extrapolation was
> considered and rejected as over-engineering for a 4-hour window.

### Time Windows

- **5h window**: entries where `timestamp >= now - 5 * 3600 * 1000`
- **Day window**: entries where `timestamp >= start of today (local time)`
- **7d window**: entries where `timestamp >= now - 7 * 24 * 3600 * 1000`

### Subagent Logs

The walk (`discoverFiles`) lists **top-level session files plus subagent logs** at one
fixed level, no full recursion:

```typescript
const subDir = path.join(dir.p, entry.name, 'subagents');
```

- Cost, credits and the burn rate include subagent files — by a live-log sample they
  carry the majority of credit spend, so skipping them understated every aggregate.
- **Session counting and the active session use top-level files only** — a subagent log
  is not a session.
- Subagent files pass the same `realpath` + `isSafePath` gate as top-level files
  (fail closed, M-3).
- The walk cache signature includes the mtime of every session directory *and* its
  `subagents/` directory: a new file inside an existing `subagents/` changes only that
  directory's mtime, and without it in the signature the cached walk would keep serving
  a stale file list.

### Active Session — `findActiveSession`

The `ctx NN%` segment is driven by the newest non-synthetic record among the **top-level
JSONL files of the current workspace's project dir** (the `projectCost.ts` mapping):

```typescript
export const ACTIVE_SESSION_FRESHNESS_MS = 6 * 3600 * 1000;
```

- Freshness is 6 hours (just above the 5-hour quota window): the segment describes
  current work, not yesterday's.
- Each file's parse cache incrementally maintains the **last non-synthetic entry**
  (`timestamp`, `model`, `usage` — the `maxTimestamp` role), so the lookup is a scan over
  cached per-file records, O(files), with no disk read and no full entry scan per tick;
  `<synthetic>` entries are skipped. A cache from before the field existed is backfilled
  by one full scan on first load.
- Context fill = `input + cache_read + cache_creation` of that last turn against the
  model's window (`contextFill.ts`); ⚠ from 20k tokens below the window.

### Project Path Mapping

```
Workspace path:  /home/user/projects/my-app
JSONL directory: ~/.claude/projects/-home-user-projects-my-app/
```

Claude Code converts the workspace path by replacing **every non-alphanumeric character**
with `-` (not just `/`). Implemented in `projectCost.ts`:

```typescript
export function workspacePathToHash(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-')
}

function workspacePathToProjectDir(workspacePath: string): string {
  const hash = workspacePathToHash(workspacePath)
  return path.join(os.homedir(), '.claude', 'projects', hash)
}
```

### FileSystemWatcher

```typescript
const watcher = vscode.workspace.createFileSystemWatcher(
  new vscode.RelativePattern(
    vscode.Uri.file(path.join(os.homedir(), '.claude', 'projects')),
    '**/*.jsonl'
  )
)
watcher.onDidChange(() => dataManager.refresh())
watcher.onDidCreate(() => dataManager.refresh())
```

---

## 2. API Client (`src/data/apiClient.ts`)

### When the API is called

The rate-limit API call is controlled by two settings:

| Setting | Default | Behaviour |
|---------|---------|-----------|
| `claudeStatus.rateLimitApi.enabled` | `true` | Master switch — set to `false` to stop API calls |
| `claudeStatus.realtime.enabled` | `false` | When `true`, polls every `cache.ttlSeconds` regardless of activity |

**Default flow (`rateLimitApi.enabled: true`, `realtime.enabled: false`):**

```
Claude active  →  JSONL updated  →  1 API call  →  cache  →  display %
Claude idle    →  read cache only (no API call)  →  show stale age
```

**When `rateLimitApi.enabled: false`:**

```
Cache exists (claude-ai)  →  show cached % with [Xm ago] stale indicator
No cache or non-claude-ai →  cost-only mode (no percentages)
```

> [!NOTE]
> **Why is the default enabled, and why is API consumption negligible?**
>
> The API is called only when Claude Code has been **recently active** — i.e., a
> JSONL file was updated within the last `cache.ttlSeconds` (default: 5 min).
> When you stop using Claude Code, the extension stops calling the API entirely.
>
> Each call sends a minimal 1-token payload to `claude-haiku-4-5-20251001` solely to
> retrieve response headers — no real work is done by the model.
> Typical cost: **≈ $0.00013 per call (≈ 9 tokens)**.
>
> | Usage pattern | Calls/day | Estimated cost/month |
> |---------------|-----------|----------------------|
> | 4 h active/day (default mode) | ~48 | ~$0.002 |
> | Always-on realtime mode | ~288 | ~$0.012 |
>
> Disable with `claudeStatus.rateLimitApi.enabled: false` if your environment
> blocks outbound HTTPS to `api.anthropic.com`. Cached percentages will still
> be shown (with a stale-age indicator) as long as a prior cache file exists.

### Endpoint

```typescript
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,        // OAuth token (NOT x-api-key)
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',      // REQUIRED for OAuth tokens
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-haiku-4-5-20251001',        // cheapest model, pinned version
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }],
  }),
})
```

### Rate Limit Headers to Extract

```
anthropic-ratelimit-unified-5h-utilization  → util5h  (float, e.g. "0.78")
anthropic-ratelimit-unified-5h-reset        → Unix timestamp SECONDS (not ISO string)
anthropic-ratelimit-unified-5h-status       → "allowed" or "denied"
anthropic-ratelimit-unified-7d-utilization  → util7d  (absent on non-Max plans)
anthropic-ratelimit-unified-7d-reset        → Unix timestamp SECONDS (absent on non-Max plans)
```

> **Important:** Reset headers are **Unix timestamps in seconds**, not ISO date strings.
> The 7d headers are only present on Claude.ai Max plans; their absence means `has7dLimit = false`.

```typescript
const nowSec = Date.now() / 1000
const reset5hStr = response.headers.get('anthropic-ratelimit-unified-5h-reset')
const reset7dStr = response.headers.get('anthropic-ratelimit-unified-7d-reset')
const has7dLimit = reset7dStr !== null

const resetIn5h = reset5hStr ? Math.max(0, parseInt(reset5hStr, 10) - nowSec) : 0
const resetIn7d = reset7dStr ? Math.max(0, parseInt(reset7dStr, 10) - nowSec) : 0
```

### Classifying the Response

`fetchRateLimitData` checks, in this order, before any header is parsed:

| Condition | Result | Poll backoff |
|---|---|---|
| No credentials file, no token, no Keychain entry, or a configured path outside `~/.claude` | `CredentialsUnavailableError` → `no-credentials` without cache | none |
| Credentials file is not valid JSON (e.g. caught mid-write) | plain `Error` → retryable | retry after 5 min |
| `expiresAt` (epoch ms) ≤ now + 60 s | `AnthropicTokenExpiredError`, **no request sent** → cache/stale/cost with "login token expired" | none |
| HTTP 401 / 403 | `AnthropicAuthError(status)` → `auth-rejected` | `max(TTL, 5 min)` |
| HTTP 5xx (incl. 529) | plain `Error` → retryable | retry after 5 min |
| None of the five headers above present (200, 400, 404, 429 …) | `AnthropicFormatError` → cache/stale/cost | `max(TTL, 5 min)` |
| Otherwise | headers parsed as below, whatever the status — a 429 with `5h-status: denied` still yields `denied` | — |

Without these checks a response with no rate-limit headers (an expired token answers
`401 authentication_error` with none) was parsed from defaults into "0% used, allowed" and
cached as live data for a whole TTL (issue #8).

`expiresAt` counts only if it is a finite number ≥ `1e12` and at most a year ahead; anything
else is treated as "no expiry" and the request is sent. On macOS with the default path, an
expired file token is compared with the Keychain entry and the later expiry wins — Claude Code
v2.x keeps its live token in the Keychain, and a stale file must not pin the extension to
"expired". The Keychain is read only on the poll path, never during provider detection.

Error messages carry the HTTP status only — never the token or the response body. The body is
always cancelled unread, on success and on failure.

`limitStatus` derivation:

```typescript
let limitStatus: 'allowed' | 'allowed_warning' | 'denied'
const status5h = response.headers.get('anthropic-ratelimit-unified-5h-status')
if (status5h === 'denied') {
  limitStatus = 'denied'
} else if (util5h >= 0.75 || (has7dLimit && util7d >= 0.75)) {
  limitStatus = 'allowed_warning'
} else {
  limitStatus = 'allowed'
}
```

### Credentials File

Actual structure of `~/.claude/.credentials.json` (verified):

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "expiresAt": 1772234688300
  }
}
```

```typescript
interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string
    expiresAt: number
  }
}

const credPath = customPath ?? path.join(os.homedir(), '.claude', '.credentials.json')
const creds: ClaudeCredentials = JSON.parse(await fs.readFile(credPath, 'utf-8'))
const token = creds.claudeAiOauth?.accessToken
```

If the file doesn't exist or the token is missing, `readCredentials` throws
`CredentialsUnavailableError`; without a cache that becomes `dataSource: 'no-credentials'`,
and the status bar tells the user to run `claude auth login` (Claude Code has no
`claude login` subcommand). Only this error means "not logged in" — an outage or an
unrecognised response without a cache shows cost-only or no data instead.

### Provider Detection

```typescript
export type ClaudeProvider = 'claude-ai' | 'aws-bedrock' | 'api-key' | 'unknown'

async function detectProvider(customCredPath?: string | null): Promise<ClaudeProvider> {
  // 1. OAuth credentials → claude-ai
  // 2. AWS env vars → aws-bedrock
  // 3. ANTHROPIC_API_KEY → api-key
  // 4. fallback → unknown
}
```

Non-`claude-ai` providers always use cost mode (no rate limit percentages).

---

### z.ai Quota (`parseZaiQuota` / `fetchZaiQuota`)

For the `z-ai` provider the 5-hour and weekly quota comes from an undocumented but stable
monitor endpoint:

```
GET {origin}/api/monitor/usage/quota/limit
Authorization: Bearer <token>       then, if auth is refused, the bare <token>

token = ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY when the first is unset — resolved from
process.env, then ~/.claude/settings.json, then ~/.claude/settings.local.json. The second
attempt sends the same token without the "Bearer " prefix: coding-plan endpoints expect it
bare. Only an authentication-class failure triggers the second attempt.
```

**Two payload generations are live at once**, and which one a user sees depends on their
tariff, not on anything we can request:

```jsonc
// Credit tariff (newer plans) — absolute credit amounts, no MCP entry
{"code":200,"success":true,"data":{"level":"max","limits":[
 {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":16693,
  "remaining":11306,"percentage":59,"nextResetTime":1789728421115},
 {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":140000,"currentValue":47691,
  "remaining":92308,"percentage":34,"nextResetTime":1790062251984}]}}

// Token tariff (older plans) — percentages only, plus a monthly MCP allowance
{"code":200,"success":true,"data":{"level":"max","limits":[
 {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":0},   // idle: no nextResetTime
 {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":100,"nextResetTime":1790075035980},
 {"type":"TIME_LIMIT","unit":5,"number":1,"usage":4000,"currentValue":20,"remaining":3980,
  "percentage":1,"nextResetTime":1790593435997,"usageDetails":[…]}]}}
```

> **Verified facts (captured from two live accounts, 2026-09-18):**
> - `usage` is **the cap**; `currentValue` is the **amount used**. The naming is inverted
>   relative to every other API here, and getting it backwards is the easiest bug to write.
> - `remaining` is **rounded** and is not `usage - currentValue`: 28000 − 16693 = 11307
>   arrives as 11306, because credits are fractional. Never recompute it.
> - `nextResetTime` is epoch **milliseconds**, and is **omitted entirely** for an idle
>   5-hour window — that window is anchored to the first request inside it.
> - `unit` codes: `3` = hours, `5` = months, `6` = weeks. `1`, `2` and `4` have never been
>   observed and are treated as unresolved rather than guessed.
> - A **rejected token returns HTTP 200**, not 401, with `{"success": false}` and a business
>   `code` (401, 1000 and 1001 all mean "auth refused"). Checking `response.ok` alone reads a
>   dead key as a healthy idle account.
> - `msg` is returned in English or Chinese at random, ignoring `Accept-Language` — never
>   show it to the user; map the code instead.
>
> **Unit boundary:** z.ai reports `nextResetTime` in epoch **milliseconds**, while
> `RateLimitData.resetIn5h`/`resetIn7d` are **relative seconds** and the cache stores
> `reset5hAt`/`reset7dAt` as **absolute Unix seconds**. The conversion happens once, in
> `zaiResetSeconds` (`reset / 1000 - nowSec`); everything downstream is already in seconds.
> Getting this wrong is silent — a reset time out by a factor of 1000 is still a truthy
> number and passes every range check.

#### How the two windows are told apart

Classification is **per entry, with no global format-version switch**, so a half-migrated
payload degrades entry by entry rather than being routed wholly to the wrong parser:

1. `(type, unit)` decides where it resolves. Only `TOKENS_LIMIT` and `CREDIT_LIMIT` compete
   for the two window slots; `TIME_LIMIT` (the monthly MCP allowance) never does.
2. Where it does not resolve — payloads predating `unit` name the period nowhere, and both
   token caps share one `type` — **array position decides**: the array arrives in the order
   z.ai's own dashboard renders it (5-hour, weekly, MCP).
3. **Reset time only vetoes.** Anything more than six hours out is provably not a 5-hour
   window (five hours, plus an hour of slack for clock skew). It can never select one
   positively: an exhausted weekly cap was observed resetting **40 minutes before** the
   5-hour window on the same account, and an idle 5-hour window carries no reset time at all.

Utilization prefers `currentValue / usage` over `percentage`, which is an integer — the live
credit account reported 59 for an actual 59.62 %, and the notification ladder steps at
90/92/94/96/98. The ratio is used only when it agrees with `percentage` within 1.5 pp, which
guards against z.ai one day fixing its inverted naming; when `percentage` is absent there is
nothing to disagree with and the ratio is used directly.

A window with no usable reset time reports a **full window** (5 h or 7 d), never zero: the
dashboard hides its prediction chart at zero, and the prediction engine turns zero into a
"under 10 minutes left" warning for a user at 3 % utilization.

---

## 3. Cache (`src/data/cache.ts`)

### Cache File Location

```
~/.claude/vscode-claude-status-cache.json
```

### Cache Schema (Version 4)

```typescript
interface CacheFile {
  version: 3 | 4              // v3 is still accepted for reading; writes are always v4
  updatedAt: string           // ISO datetime
  providerType: string        // which provider produced this snapshot
  usageData: {
    utilization5h: number
    utilization7d: number
    reset5hAt: number         // absolute Unix timestamp (seconds) — NOT relative seconds
    reset7dAt: number         // 0 if no 7d limit (non-Max plan)
    limitStatus: string
    has7dLimit?: boolean      // v4: stored explicitly, see the history note below
    billing?: 'credits' | 'tokens'   // v4: z.ai only
    planLevel?: string               // v4: z.ai only, length-bounded
    // `remaining` is stored exactly as the API sent it and is NEVER recomputed from
    // total − used: upstream rounds it, because credits are fractional (see the z.ai section
    // above). It is optional because the API does not always send it.
    credits5h?: { used: number, total: number, remaining?: number }  // v4: z.ai only
    credits7d?: { used: number, total: number, remaining?: number }  // v4: z.ai only
  }
}
```

> **Schema version history:**
> - v1: stored `resetIn5h`/`resetIn7d` as relative seconds from cache write time
> - v2: stores `reset5hAt`/`reset7dAt` as absolute Unix timestamps (correct across cache reads)
> - v3: adds `providerType`, so a claude-ai cache is never served as z.ai data
> - v4: adds `has7dLimit` and the z.ai credit fields
>
> **Why `has7dLimit` had to become explicit:** it used to be derived as `reset7dAt > 0`, but
> `writeCache` stores `now + resetIn7d` — roughly 1.8 × 10⁹ even when `resetIn7d` is 0. Every
> cached read therefore claimed a weekly window existed, for **every** provider, so Anthropic
> Pro users saw a phantom weekly row as soon as the first cache read happened.
>
> **Why v3 is still read:** during an extension update two windows share one cache file. If the
> new reader rejected v3, it would rewrite v4, the old reader would reject that and rewrite v3,
> and both would poll the API on every tick until every window restarted. Accepting v3 for
> reading (and always writing v4) breaks that loop.
>
> The dashboard **snapshot** schema is deliberately left at version 1: the new fields are
> optional and its validator accepts them, whereas bumping it would reject every existing
> snapshot and cost each user the instant cold-start render.

Cost and token data are NOT cached (always read from JSONL directly — it's local
and fast). Only the API response values are cached.

### Cache Validity Logic

```typescript
function isCacheValid(cache: CacheFile, ttlSeconds: number): boolean {
  const age = (Date.now() - new Date(cache.updatedAt).getTime()) / 1000
  return age < ttlSeconds
}

function getCacheAge(cache: CacheFile): number {
  return (Date.now() - new Date(cache.updatedAt).getTime()) / 1000
}
```

### When to Call the API

The decision is the pure `pollDecision` in `src/data/pollOutcome.ts`:

```typescript
if (force) return 'poll'                                   // manual refresh bypasses everything below
if (pauseReason !== null) return 'skip'                    // refused key / format drift: max(TTL, 5 min)
if (retryableFailureAt within 5 min) return 'skip'         // network / 5xx: retried, but not sooner
if (!cache) return 'poll'
if (cache expired) return 'poll-if-jsonl-recent'           // caller runs wasJsonlUpdatedRecently(300) lazily
return 'skip'                                              // cache is fresh
```

The pause never drops below five minutes, because `cache.ttlSeconds` can be set as low as 60.
It is lifted by a successful poll of this window, or by a cache entry of the same provider
written after the failure (another window polled successfully). A manual refresh while another
window holds the poll lock shows the current cache; the winner's result arrives with the next
refresh.

What a failed poll shows is `pollFailureOutcome`; every branch that did not poll by itself
(skipped, lock held elsewhere, fresh cache under the lock) goes through `noPollOutcome`, so an
active credential pause keeps showing `auth-rejected`. `showsRateData` decides whether
utilization is live for the dashboard bars and prediction chart, the prediction and the startup
snapshot. Threshold notifications and window-rollover tracking use the stricter
`actsOnRateData` ('api' and 'cache' only): a startup snapshot is 'stale' and carries reset times
as old as the snapshot itself.

`wasJsonlUpdatedRecently(seconds)`: check if any `.jsonl` file under
`~/.claude/projects/` has an `mtime` within the last `seconds` seconds.
