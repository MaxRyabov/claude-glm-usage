# Design: support-zai-quota-formats

## Context

`GET {origin}/api/monitor/usage/quota/limit` is z.ai's undocumented monitor endpoint. It is the
only source of the 5-hour and weekly quota the extension shows for the `z-ai` provider. Two
payload generations are live at once, and the shape a user sees depends on their tariff, not on
a version parameter we can request.

Captured from two live accounts on 2026-09-18:

```jsonc
// New tariff — credit-based
{"code":200,"msg":"Operation successful","success":true,"data":{"level":"max","limits":[
 {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":16693,
  "remaining":11306,"percentage":59,"nextResetTime":1789728421115},
 {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":140000,"currentValue":47691,
  "remaining":92308,"percentage":34,"nextResetTime":1790062251984}]}}

// Old tariff — token-based
{"code":200,"msg":"Operation successful","success":true,"data":{"level":"max","limits":[
 {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":0},          // idle: no nextResetTime
 {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":100,"nextResetTime":1790075035980},
 {"type":"TIME_LIMIT","unit":5,"number":1,"usage":4000,"currentValue":20,"remaining":3980,
  "percentage":1,"nextResetTime":1790593435997,
  "usageDetails":[{"modelCode":"search-prime","usage":13},{"modelCode":"web-reader","usage":7}]}]}}
```

Two observations reframe the problem:

1. **Both tariffs already send `unit`/`number`/`level`.** The difference that actually breaks us
   is the entry *type* (`CREDIT_LIMIT` vs `TOKENS_LIMIT`) and the presence of absolute amounts.
   The `unit`-less shape documented for pre-2026-09 deployments was not observed on either
   account, so handling it is defensive hardening, not the primary path.
2. **Authentication failures are indistinguishable from success at the HTTP layer.** Probed
   directly: `Bearer deadbeef` returns `200 {"code":401,"success":false}`; a well-formed but
   invalid key returns `200 {"code":1000,"success":false}`.

Field semantics worth stating because they are counter-intuitive:

| Field | Meaning |
|---|---|
| `usage` | **The cap.** The naming is inverted relative to every other API we consume. |
| `currentValue` | The amount **used** (credits, or MCP calls on `TIME_LIMIT`). |
| `remaining` | Cap minus used, **rounded** — 28000 − 16693 = 11307, reported as 11306, because credits are fractional. |
| `percentage` | Integer percent consumed. |
| `nextResetTime` | Epoch **milliseconds**. Omitted entirely for an idle 5-hour window. |
| `unit` | 3 = hours, 5 = months, 6 = weeks. Codes 1, 2 and 4 were never observed. |

Constraints: `parseZaiQuota` must never throw (project rule on graceful degradation); the
`RateLimitData` contract is consumed by the status bar, webview, prediction and notifications;
ESLint runs `eqeqeq: "warn"`; tests are Mocha TDD plus `assert`, with no mocking library.

## Goals / Non-Goals

**Goals:**
- Correct 5-hour and weekly utilization for both tariff generations and both billing models.
- Surface absolute credit amounts and the plan tier where the payload provides them.
- Fail honestly on authentication errors instead of reporting a fabricated 0 %.
- Keep the Anthropic path equivalent in behaviour, and prove it with tests.

**Non-Goals:**
- Displaying the monthly MCP allowance. It is classified only so it cannot be mistaken for a
  quota window.
- Other monitor endpoints (`model-usage`, `tool-usage`, `credit-usage/activity`).
- Reconciling z.ai's rolling windows against its own dashboard's calendar-day aggregates.

## Decisions

### D1. Per-entry duck typing, no global format-version switch

Each entry is classified independently: read the period off the `(type, unit)` pair where it
resolves, and fall back to array position only for entries where it does not.

*Alternative rejected — sniff the payload once ("does any entry carry `unit`?") and branch to a
v1 or v2 parser.* Two parsers double the surface that must stay correct, and a half-migrated
payload — some entries carrying `unit`, some not — would be routed wholly to the wrong one.
Per-entry resolution degrades exactly as far as the ambiguity extends and no further.

### D2. Array position identifies windows when `unit` is absent; reset time only vetoes

For `unit`-less payloads the period is named nowhere and both caps share one `type`. The array
arrives in the order z.ai's own dashboard renders it: 5-hour, then weekly, then MCP.

Reset time cannot carry this signal positively. An exhausted weekly cap was observed resetting
**40 minutes before** the 5-hour window, while an idle 5-hour window carries no reset time at
all. So position decides, and the reset time is used only to *rule a candidate out*: anything
more than six hours away is provably not a 5-hour window — five hours, plus one hour of slack
for clock skew, since `nextResetTime` is the server's clock while the horizon is the user's.

*Alternative rejected — "whichever resets soonest is the 5-hour window".* It inverts precisely
on the observed case above and mislabels every idle account.

Only window caps compete for the slots: a `TIME_LIMIT` never occupies a positional slot, so a
payload that leads with an MCP entry classifies exactly as one that does not. The resulting map
is keyed by index into the **full** `limits` array so it can be zipped back onto it entry for
entry, but the candidate ordering is built from window caps alone. Both halves matter: keying by
a filtered index would misalign the map, and letting `TIME_LIMIT` take a slot would hand the
5-hour window to the MCP allowance on the live token tariff, whose payload leads with one.

### D3. Prefer the derived ratio over `percentage`, guarded by agreement

`percentage` is an integer: the live credit account reports 59 for an actual 59.62 %. The
notification ladder steps at 90/92/94/96/98, so a whole-percent input quantises the very
thresholds it drives.

Where `currentValue` and `usage` are both finite and `usage` is positive, utilization is
`currentValue / usage` — **but only when it agrees with `percentage` within 1.5 pp**, otherwise
`percentage / 100` wins. The guard is cheap insurance against the one scenario that would
silently invert the ratio: z.ai correcting its inverted `usage`/`currentValue` naming. Verified
against live data: 16693/28000 = 59.62 % against a reported 59; 47691/140000 = 34.06 % against 34.

When `percentage` is absent altogether the ratio is used unguarded, because there is nothing to
disagree with. This case must be stated rather than left to fall through: the current code reads
`percentage ?? 0`, so a credit window reporting perfectly good amounts and no percentage would
compare against zero, fail the guard and report 0 % — reintroducing QF-1 through the very
mechanism meant to fix it. `percentage` is redundant on a credit plan, so its disappearance is a
realistic next move for the upstream API, not a hypothetical.

### D4. A missing reset time falls back to a full window, never to zero

Zero is not a neutral "unknown" here. `panel.ts` hides the prediction chart when `resetIn5h` is
zero, and `prediction.ts` computes `Math.min(secondsUntilExhaustion, resetIn5h)`, so a zero
yields `estimatedExhaustionIn = 0` and a `critical` recommendation — "under 10 minutes left" —
shown to a user sitting at 3 % utilization.

For the 5-hour window the fallback is also simply correct: the window is anchored to the first
request inside it, so an entry with no `nextResetTime` is an idle window with no anchor yet, and
the true horizon is a full five hours. The length comes from `unit` times `number` when
resolvable, otherwise from the window kind (5 h or 7 d).

A constant fallback is additionally stable across polls, so `checkWindowResets` cannot read it
as a spurious window rollover; a genuine rollover still registers, because a window counting
down through minutes and then going idle jumps by far more than the 3600 s threshold.

The same fallback covers a `nextResetTime` in the past (a stale snapshot) or absurdly far out.
"Absurd" is pinned at 400 days: comfortably beyond the longest window z.ai bills on (a month),
and short enough to catch the realistic upstream slip of sending seconds where milliseconds are
expected, which lands roughly 55 000 years out. The number lives here so the requirement and the
code do not drift apart with no recorded reason.

### D5. Envelope failure detection lives in `fetchZaiQuota`, not in the parser

`parseZaiQuota` stays a total function — that is the project's graceful-degradation rule, and
the parser is the piece under test with hostile input. `fetchZaiQuota` already has a `throws`
contract that `DataManager` catches and converts into cache, then stale, then local-only, which
is exactly the desired user experience for a dead token.

Only an explicit `success: false` counts as a failure; a valid payload omitting the field must
keep flowing. `code` maps to a status — 401, 403 and 429 pass through, 1000 and 1001 are auth
failures, anything else is 502 — and the auth-variant retry is driven by that class rather than
the HTTP status, which is what makes the Bearer-to-raw-token fallback reachable in production
for the first time.

`msg` is never surfaced: z.ai returned English on one endpoint and Chinese on another within a
single request batch, ignoring `Accept-Language`.

### D6. A 200 carrying no usable window cap is an error, not 0 %

If the envelope claims success but contains no `TOKENS_LIMIT` and no `CREDIT_LIMIT`, throw. This
is precisely the class of event that created this work — a payload shape moving underneath us —
and the difference between "stale quota with an age badge" and "confidently wrong zero" is the
whole point of the change.

### D7. Optional fields on `RateLimitData`, persisted in cache v4

`billing`, `planLevel`, `credits5h` and `credits7d` are optional and populated only by the z.ai
parser, so the Anthropic path is unchanged by construction. They must be cached, because the
dashboard is served from cache for most of a five-minute TTL and the amounts would otherwise
flicker between polls.

The cache bump is also the moment to fix an unrelated latent defect: `cacheToRateLimitData`
infers `has7dLimit` from `reset7dAt > 0`, while `writeCache` stores `now + resetIn7d` — a value
near 1.8e9 regardless of the input. Every cached read therefore claims a weekly window exists,
for every provider including Anthropic Pro. Schema v4 stores the boolean explicitly.

A v4 reader still **accepts a v3 file** and always writes v4. Rejecting v3 outright would be
fail-closed in the usual good sense, but during an extension update two windows run different
versions against one cache file: the new one rejects v3 and rewrites v4, the old one rejects v4
and rewrites v3, and both then poll the API on every tick until every window restarts. Accepting
v3 for reading — deriving `has7dLimit` the old way for those records only, since nothing better
is recoverable from them — breaks the loop from our side at the cost of one stale boolean that
the next successful poll overwrites.

The **snapshot schema stays at version 1.** The new fields are optional and `readSnapshot`
validates only the required discriminators, so an old snapshot remains valid and simply lacks
them. Bumping it would reject every existing snapshot and cost each user the instant cold-start
render that `optimize-dashboard-loading` was built to provide — a visible regression bought for
nothing.

`planLevel` is a free-form string from an external API that lands in the on-disk cache and then
in WebView markup assembled by concatenation. It is therefore constrained on the way in — accepted
only as a short string, with the whole cache file rejected otherwise, which is exactly what
`validateCacheFile` already does for every other field — and escaped on the way out through the
panel's existing `esc()`. The WebView CSP would keep a tampered cache from executing anything, so
this is markup corruption rather than code execution, but both guards are one line each.

### D8. A rejected key is remembered, and said out loud

Fixing QF-4 has a consequence the fix itself creates. Today a dead token produces a successful
HTTP 200, which is cached; after the fix it produces a thrown error, and nothing is cached.
`shouldCallApi` returns true whenever no cache exists, the poll timer fires every 60 seconds, and
`fetchZaiQuota` tries two authentication variants — so a user with an expired key would generate
two requests a minute, indefinitely, in every open window. The project's rule is at most one call
per five minutes when idle. Trading a wrong number for a request storm is not a fix.

So an authentication-class failure is recorded with its timestamp and suppresses further attempts
until the cache TTL elapses, exactly as a successful response does. Network and upstream failures
are deliberately **not** suppressed the same way: those are transient and worth retrying, whereas
a revoked key will still be revoked in five minutes.

The same classification then drives a distinct user-visible state. Without it the two failures
that matter most look identical: "z.ai is down for five minutes" and "my key has been dead for a
week" both render as an aging cache badge. The first resolves itself; the second needs the user
to do something, and nothing in the interface says so. Since D5 already produces the failure
class, surfacing it costs a state, not an investigation.

### D9. A fully consumed window reports `denied`

z.ai's utilization has never been able to produce `denied` — the mapping stops at
`allowed_warning` — so the red status-bar state is unreachable for the provider, and a user whose
weekly window is exhausted sees the same amber as one at 76 %. The live token account is sitting
at exactly 100 % while this is being written.

Utilization at or above 1 on either window therefore maps to `denied`. This is a visible change
beyond "parse the payload correctly", and it was weighed as such: it is one line, it uses data the
change is already fixing, and leaving it out would mean shipping correct quota numbers attached to
a status colour that contradicts them.

## Risks / Trade-offs

- **Clock skew defeats the six-hour veto** → A machine more than an hour slow can push a genuine
  5-hour reset outside the horizon and, on a `unit`-less payload, hand the short slot to the
  weekly cap. The one-hour slack covers ordinary NTP drift; the horizon must never be tightened
  below six hours. Unrecoverable from the payload alone, and accepted.
- **A third window cap, such as a monthly credit budget, would be classified `other`** →
  Deliberate: `unit: 5` on a window cap resolves to `other` rather than to `null`, so an
  unexpected cap is ignored instead of collapsing the whole payload onto the positional path.
- **Older z.ai tariffs start emitting weekly notifications they never sent before** → This is
  the QF-3 fix working as intended, but from the user's side it is an unannounced change in
  behaviour. Mitigation: an explicit changelog entry.
- **Cache and snapshot version bumps invalidate every existing file** → One cold refetch per
  user. Both validators are already fail-closed, so this path is exercised today, not new.
- **Test fixtures pinned to a fixed clock** → The existing suite calls `Date.now()` at module
  scope and again inside the parser; new positional tests sit on the six-hour boundary and would
  flake on that slack. `now` becomes an injectable parameter and every new test passes it.
- **A `percentage`/ratio disagreement is silent** → By design the guard falls back rather than
  reporting a discrepancy. If z.ai's naming ever flips, utilization quietly reverts to
  whole-percent precision instead of inverting. Accepted: correctness over precision.
- **`TIME_LIMIT` data is parsed and then discarded** → `RateLimitData` has no slot for a third
  window. The user consequence is real and accepted: when the MCP allowance runs out, web search
  and web reader stop working while the extension still shows everything green. Any future MCP
  display must be optional per plan, because credit tariffs omit the entry entirely rather than
  reporting it as zero.
- **A window cap with a month period has nowhere to go** → It is classified as `other`, takes no
  slot and does not participate in positional assignment, so a hypothetical monthly credit budget
  is ignored rather than silently occupying the weekly slot. The alternative — treating a month
  as unresolved — would push it onto the positional path, where it would take a slot and corrupt
  both readings.
- **Amounts may arrive partially** → A window reporting `currentValue` and `usage` but no
  `remaining` is common enough to specify rather than discover: the amounts block renders from
  used and total alone, and `remaining` is shown only when the API sends it. It is never
  recomputed, because the API rounds it.
- **A user switching tariff keeps a cache entry from the previous generation** → The provider is
  `z-ai` in both cases, so the provider discriminator does not invalidate it, and the dashboard
  may show token-era data with no amounts for up to one TTL after the switch. Bounded, self-
  correcting, and cheaper to accept than to detect.
- **An unbounded `limits` array reaches the cache** → The parser tolerates malformed input but the
  results are written to disk. A response carrying thousands of entries — a format change, not an
  attack — would inflate the cache file, so the number of entries considered is capped.
- **Two extension versions sharing one cache file** → Addressed in D7 by accepting v3 for reading;
  the residual cost is that the older window still refetches on its own schedule until it is
  restarted.

## Migration Plan

1. Cache `version` 3 becomes 4. A v4 reader accepts both 3 and 4 and always writes 4; for a v3
   record `has7dLimit` is derived the old way, since nothing better is recoverable from it.
2. The snapshot schema is unchanged at version 1 — see D7.
3. No settings change and no user action. Rollback is reverting the extension version: the older
   reader rejects v4 and rewrites v3 on its next poll, which the newer reader still accepts.

## Open Questions

- Do `lite` and `pro` token tariffs ever carry `currentValue`/`usage` on `TOKENS_LIMIT`? Only
  `max` accounts were available for observation. The D3 guard makes this safe either way.
- What other `code` values exist beyond 200, 401, 403, 429, 1000 and 1001? Unknown codes map to
  502 and do not retry, which is the safe default.
