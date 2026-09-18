## ADDED Requirements

### Requirement: Quota windows are identified per entry, without a format-version switch
The extension SHALL classify each entry of `data.limits[]` independently, resolving the window
period from the `(type, unit)` pair where it is stated and falling back to array position only
for entries where it is not. It SHALL NOT branch the whole payload on a single detected format
version.

Window caps are entries whose `type` is `TOKENS_LIMIT` or `CREDIT_LIMIT`. Period unit codes are
`3` = hours, `5` = months and `6` = weeks; any other code SHALL be treated as unresolved rather
than guessed. An hour period SHALL denote the 5-hour window regardless of `number`; where more
than one hour-period window cap is present, the first SHALL be used.

A window cap whose period is neither hours nor weeks SHALL be classified as other: it SHALL NOT
occupy the 5-hour or weekly slot and SHALL NOT participate in positional assignment.

#### Scenario: New-tariff token payload classified by unit
- **WHEN** the payload contains `TOKENS_LIMIT` with `unit: 3, number: 5` and `TOKENS_LIMIT` with
  `unit: 6, number: 1`
- **THEN** the first is the 5-hour window and the second is the weekly window

#### Scenario: Mixed payload resolves per entry
- **WHEN** one window cap carries `unit: 3` and another carries no `unit` at all
- **THEN** the first is classified by its unit and the second by its array position

#### Scenario: Undocumented unit code is not guessed
- **WHEN** a window cap carries `unit: 2`
- **THEN** the entry is treated as unresolved and classified by array position, not as days

#### Scenario: A month-period window cap takes no slot
- **WHEN** a window cap carries `unit: 5` alongside an hour-period and a week-period window cap
- **THEN** the reported 5-hour and weekly windows come from the hour- and week-period entries,
  and the month-period entry is ignored

### Requirement: Credit-based tariffs are read as quota windows
The extension SHALL treat `CREDIT_LIMIT` entries as quota windows equivalent to `TOKENS_LIMIT`
entries, so that credit-based tariffs report utilization rather than zero.

#### Scenario: Credit tariff reports utilization
- **WHEN** the payload contains only `CREDIT_LIMIT` entries for the 5-hour and weekly windows
- **THEN** both windows report their utilization and the weekly window is reported as present

#### Scenario: Credit tariff has no MCP entry
- **WHEN** a credit-based payload omits `TIME_LIMIT` entirely
- **THEN** parsing succeeds and no quota window is derived from a missing MCP allowance

### Requirement: The MCP allowance is never mistaken for a quota window
The extension SHALL exclude `TIME_LIMIT` entries from 5-hour and weekly window selection,
regardless of their position in the array or their reported percentage.

#### Scenario: Exhausted MCP allowance does not raise a quota warning
- **WHEN** a `TIME_LIMIT` entry at 99 % precedes two window caps at low utilization
- **THEN** the reported 5-hour and weekly utilizations come from the window caps and the limit
  status is not a warning

### Requirement: Array position identifies windows when the period is unstated, and reset time only vetoes
For each window cap whose period is unresolved, the extension SHALL identify the window by array
position among the window caps, treating the first candidate that is not provably too distant as
the 5-hour window and the next remaining window cap as the weekly window.

A window cap SHALL be excluded from the 5-hour slot only when its `nextResetTime` is more than
six hours in the future. A missing `nextResetTime` SHALL NOT exclude it. Reset time SHALL NOT be
used to positively select a window. When every candidate is excluded, the extension SHALL fall
back to array order rather than leaving the 5-hour window unassigned.

Where more than two window caps are present, only the first two SHALL be used; any further window
cap SHALL be ignored rather than replacing the weekly window.

#### Scenario: Legacy payload classified by order
- **WHEN** two `TOKENS_LIMIT` entries carry no `unit` and no `number`
- **THEN** the first is the 5-hour window and the second is the weekly window

#### Scenario: Weekly window resetting sooner keeps its position
- **WHEN** the first window cap resets in two hours and the second, at 100 %, resets in eighty
  minutes
- **THEN** the first remains the 5-hour window and the second remains the weekly window

#### Scenario: A distant first candidate is vetoed
- **WHEN** the first window cap resets in three days and the second resets in one hour
- **THEN** the second is the 5-hour window and the first is the weekly window

#### Scenario: Idle windows keep array order
- **WHEN** neither window cap carries a `nextResetTime`
- **THEN** array order decides, and the first is the 5-hour window

#### Scenario: A single window cap reports no weekly window
- **WHEN** the payload contains exactly one window cap
- **THEN** the weekly window is reported as absent with zero utilization

#### Scenario: Every candidate vetoed falls back to array order
- **WHEN** both window caps report a `nextResetTime` more than six hours in the future
- **THEN** the first is the 5-hour window and the second is the weekly window

#### Scenario: A third window cap is ignored
- **WHEN** three window caps carry no resolvable period
- **THEN** the first two fill the 5-hour and weekly windows and the third is ignored

### Requirement: Utilization prefers absolute amounts when they agree with the reported percentage
Where a window cap reports both `currentValue` and a positive `usage`, the extension SHALL derive
utilization from `currentValue / usage`, but only when that value agrees with the reported
`percentage` within 1.5 percentage points. Otherwise it SHALL use `percentage`.

Where `percentage` is absent or not a number and the amounts are usable, the extension SHALL use
the derived ratio without an agreement check. Where neither a usable `percentage` nor usable
amounts are present, utilization SHALL be zero. Utilization SHALL be clamped to the range 0 to 1.

`usage` is the cap and `currentValue` is the amount consumed; the extension SHALL NOT interpret
these names the other way round.

#### Scenario: Derived ratio refines an integer percentage
- **WHEN** a window cap reports `currentValue: 16693`, `usage: 28000` and `percentage: 59`
- **THEN** the reported utilization is approximately 0.596, not 0.59

#### Scenario: Disagreement falls back to the reported percentage
- **WHEN** the derived ratio differs from `percentage` by more than 1.5 percentage points
- **THEN** the reported utilization comes from `percentage`

#### Scenario: Percentage above 100 is clamped
- **WHEN** a window cap reports `percentage: 250`
- **THEN** the reported utilization is 1

#### Scenario: Amounts without a percentage are used directly
- **WHEN** a window cap reports `currentValue: 16693` and `usage: 28000` but no `percentage`
- **THEN** the reported utilization is approximately 0.596, not zero

### Requirement: A window without a usable reset time reports a full window horizon
The extension SHALL report the seconds remaining until a window resets from `nextResetTime`,
interpreted as epoch milliseconds. When `nextResetTime` is absent, already in the past, or more
than 400 days in the future, the extension SHALL report the window's own length instead — derived
from `unit` and `number` when resolvable, and otherwise five hours for the 5-hour window and
seven days for the weekly window. It SHALL NOT report zero for a window that exists.

#### Scenario: Idle 5-hour window reports five hours
- **WHEN** the 5-hour window cap carries no `nextResetTime`
- **THEN** the reported time until reset is approximately five hours

#### Scenario: A past reset time falls back to the window length
- **WHEN** `nextResetTime` is one minute in the past
- **THEN** the reported time until reset is the window's own length

#### Scenario: An absurdly distant reset time is ignored
- **WHEN** `nextResetTime` is 500 days in the future
- **THEN** the reported time until reset is the window's own length

#### Scenario: Weekly fallback is a week, not a day
- **WHEN** a weekly window cap carries `unit: 6, number: 1` and no `nextResetTime`
- **THEN** the reported time until reset is approximately seven days

### Requirement: Credit amounts and plan tier are surfaced when present
The extension SHALL expose, as optional data, the billing model of the plan, the plan tier from
`level`, and the used, total and remaining amounts for each window that reports them. It SHALL
report the billing model as credit-based when any `CREDIT_LIMIT` entry is present and as
token-based otherwise. It SHALL NOT recompute `remaining`, which the upstream API rounds.

These fields SHALL be absent for providers other than z.ai and for payloads that do not report
absolute amounts. Where a window reports the used and total amounts but not `remaining`, the
extension SHALL still expose the two it has rather than discarding all three.

The plan tier SHALL be accepted only as a short string and SHALL be rejected — invalidating the
whole cache record — when it is of another type or exceeds that length, because it originates
from an external API and is persisted to disk before being rendered.

#### Scenario: Credit tariff exposes amounts and tier
- **WHEN** a `CREDIT_LIMIT` window reports `currentValue: 16693`, `usage: 28000` and
  `remaining: 11306`, and the payload reports `level: "max"`
- **THEN** those three amounts are exposed unchanged alongside the plan tier and a credit-based
  billing model

#### Scenario: Token tariff exposes no amounts
- **WHEN** the payload contains only `TOKENS_LIMIT` entries reporting a percentage
- **THEN** no credit amounts are exposed and the billing model is token-based

#### Scenario: Credit amounts survive a cache round-trip
- **WHEN** quota data carrying credit amounts and a plan tier is written to the cache and read
  back
- **THEN** the restored data still carries the same amounts and tier

#### Scenario: A window without a remaining amount still exposes the rest
- **WHEN** a window cap reports `currentValue` and `usage` but no `remaining`
- **THEN** the used and total amounts are exposed and the remaining amount is absent

#### Scenario: An oversized plan tier invalidates the cache record
- **WHEN** a cache file carries a plan tier that is not a short string
- **THEN** the whole record is rejected and the quota is refetched

### Requirement: Authentication failures returned with HTTP 200 are detected
The extension SHALL treat an explicit `success: false` in the response envelope as a failed
request and SHALL NOT parse it as quota data, because z.ai answers a rejected token with HTTP
200 rather than an error status. A payload that omits `success` SHALL be parsed normally.

The extension SHALL map the envelope `code` to a failure class — 401, 403 and 429 as themselves,
1000 and 1001 as authentication failures, and any other code as an upstream error — and SHALL
NOT display the envelope `msg`, whose language does not follow the requested locale.

#### Scenario: Rejected token does not report zero usage
- **WHEN** the endpoint returns HTTP 200 with `{"code": 1000, "success": false}` for every
  authentication variant
- **THEN** the quota request fails and the extension falls back to cached, stale or cost-only
  display rather than reporting 0 % used

#### Scenario: Successful envelope without the success field is parsed
- **WHEN** the response omits `success` but contains usable window caps
- **THEN** the quota is parsed normally

### Requirement: The authentication retry is driven by the failure class
The extension SHALL attempt the bearer token form first and the raw token form second, retrying
only when the first attempt failed authentication — whether that failure arrived as an HTTP
status or as a response envelope. It SHALL NOT retry on any other failure.

#### Scenario: Envelope auth failure triggers the raw-token retry
- **WHEN** the bearer attempt returns HTTP 200 with `{"code": 1001, "success": false}` and the
  raw-token attempt succeeds
- **THEN** the quota from the second attempt is reported

#### Scenario: A non-authentication failure is not retried
- **WHEN** the first attempt returns an upstream error unrelated to authentication
- **THEN** no second attempt is made and the request fails

#### Scenario: The last failure decides the class
- **WHEN** the bearer attempt fails authentication and the raw-token attempt fails for an
  unrelated reason
- **THEN** the request fails as that unrelated failure, and is not recorded as an authentication
  failure

### Requirement: A successful response without usable limits is an error
The extension SHALL treat a successful envelope that contains no `TOKENS_LIMIT` and no
`CREDIT_LIMIT` entry as a failed request, so that an unrecognised payload shape surfaces as
stale or cached data rather than as zero usage. A response body that is not valid JSON SHALL
likewise fail the request.

#### Scenario: Payload with only an MCP entry fails
- **WHEN** a successful response contains only a `TIME_LIMIT` entry
- **THEN** the quota request fails rather than reporting 0 % used

#### Scenario: A non-JSON body fails the request
- **WHEN** the response body cannot be parsed as JSON
- **THEN** the quota request fails without throwing an unhandled error

### Requirement: Quota parsing never throws
Parsing a quota payload SHALL always return a result and SHALL NOT throw, for any input,
including null, non-objects, a non-array `limits`, and array elements that are null or not
objects. Unparseable input SHALL yield zero utilization and no weekly window.

#### Scenario: Hostile input yields zeros
- **WHEN** the parser receives null, a string, a number, a non-array `limits`, or an array
  containing null and non-object elements
- **THEN** it returns zero utilization with no weekly window and does not throw

### Requirement: Repeated authentication failures do not poll the API
The extension SHALL record an authentication-class failure with the time it occurred and SHALL
NOT issue another quota request before the cache time-to-live has elapsed since that failure.
Failures of other classes, such as network or upstream errors, SHALL NOT be suppressed this way.

Without this, a rejected key writes no cache entry, the poll scheduler treats the absence of a
cache as a reason to call, and the extension issues a request on every timer tick for as long as
the key stays rejected.

#### Scenario: A rejected key is not retried every tick
- **WHEN** a quota request fails authentication and another refresh is requested before the cache
  time-to-live has elapsed
- **THEN** no request is sent to the provider

#### Scenario: The suppression expires
- **WHEN** the cache time-to-live has elapsed since the recorded authentication failure
- **THEN** the next refresh issues a request

#### Scenario: A network failure is retried normally
- **WHEN** a quota request fails for a network reason rather than authentication
- **THEN** the next refresh issues a request without waiting for the time-to-live

### Requirement: A rejected key is distinguishable from an outage
The extension SHALL present an authentication-class failure as a distinct state naming the
credential as the cause, separate from the display used for stale or unavailable data, so that a
failure requiring user action is not shown identically to one that resolves itself.

#### Scenario: Rejected key is reported as such
- **WHEN** the provider rejects the configured token
- **THEN** the extension indicates that the credential was rejected

#### Scenario: A transient outage is not reported as a credential problem
- **WHEN** a quota request fails for a network reason
- **THEN** the extension shows its usual stale or cached state without naming the credential

### Requirement: A fully consumed window reports a denied status
The extension SHALL report the limit status as denied when either the 5-hour or the weekly
utilization reaches 1, so that an exhausted quota is distinguishable from an approaching one.

#### Scenario: An exhausted weekly window is denied
- **WHEN** the weekly window reports 100 % consumed
- **THEN** the limit status is denied rather than a warning

#### Scenario: A high but unexhausted window stays a warning
- **WHEN** the highest window reports 90 % consumed
- **THEN** the limit status is a warning

### Requirement: The number of limit entries considered is bounded
The extension SHALL consider only a bounded number of entries from `data.limits`, so that an
unexpectedly large response cannot inflate the data written to disk.

#### Scenario: An oversized limits array is truncated
- **WHEN** the response carries far more limit entries than any known plan reports
- **THEN** parsing succeeds, the quota windows are still resolved from the leading entries, and
  the persisted data stays bounded

### Requirement: The weekly window presence survives a cache round-trip
The extension SHALL persist whether a weekly window exists as an explicit value, and SHALL
restore it unchanged when serving quota data from the cache, for every provider.

The extension SHALL also accept a cache record written by the previous schema version, deriving
the weekly window presence as that version did, and SHALL always write the current version. This
keeps two extension versions sharing one cache file from invalidating each other's writes and
polling the API on every tick until every window is restarted.

#### Scenario: A plan without a weekly window stays without one
- **WHEN** quota data reporting no weekly window is written to the cache and read back
- **THEN** the restored data still reports no weekly window

#### Scenario: A plan with a weekly window keeps it
- **WHEN** quota data reporting a weekly window is written to the cache and read back
- **THEN** the restored data still reports a weekly window

#### Scenario: A previous-version cache record is still readable
- **WHEN** the cache file holds a record written by the previous schema version
- **THEN** it is accepted for reading and the next write uses the current version

#### Scenario: A malformed cache record is still rejected
- **WHEN** a cache record carries an out-of-range utilization or an unknown limit status
- **THEN** the record is rejected regardless of its schema version

### Requirement: Credit amounts and plan tier are shown only when available
The extension SHALL display the absolute amounts beside the window they belong to when those
amounts are present, and SHALL omit that display entirely when they are not — which includes
every provider other than z.ai and every token-based z.ai tariff. It SHALL display the plan tier
when present, escaped, and omit it otherwise.

#### Scenario: Credit tariff shows amounts and tier
- **WHEN** the dashboard renders quota data carrying credit amounts and a plan tier
- **THEN** the amounts appear beside their window and the tier is shown

#### Scenario: Anthropic shows neither
- **WHEN** the dashboard renders Anthropic quota data
- **THEN** no amounts block and no tier badge are shown

#### Scenario: Token tariff shows neither
- **WHEN** the dashboard renders z.ai quota data reporting percentages only
- **THEN** no amounts block is shown and the percentage display is unchanged

### Requirement: The Anthropic rate-limit path is unaffected
The extension SHALL continue to derive Anthropic rate-limit data from response headers, with
reset times interpreted as Unix seconds, and SHALL NOT populate the z.ai-specific billing, plan
tier or credit amount fields for Anthropic responses.

#### Scenario: Anthropic headers are parsed unchanged
- **WHEN** an Anthropic response carries unified 5-hour and 7-day utilization and reset headers
- **THEN** the reported utilizations and reset horizons derive from those headers, with reset
  times read as Unix seconds

#### Scenario: A plan without a 7-day header reports no weekly window
- **WHEN** an Anthropic response carries no 7-day reset header
- **THEN** the weekly window is reported as absent

#### Scenario: z.ai-specific fields stay absent
- **WHEN** rate-limit data is produced from an Anthropic response
- **THEN** no billing model, plan tier or credit amounts are exposed
