## ADDED Requirements

### Requirement: Quota windows are identified per entry, without a format-version switch
The extension SHALL classify each entry of `data.limits[]` independently, resolving the window
period from the `(type, unit)` pair where it is stated and falling back to array position only
for entries where it is not. It SHALL NOT branch the whole payload on a single detected format
version.

Window caps are entries whose `type` is `TOKENS_LIMIT` or `CREDIT_LIMIT`. Period unit codes are
`3` = hours, `5` = months and `6` = weeks; any other code SHALL be treated as unresolved rather
than guessed.

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
For payloads whose window caps state no resolvable period, the extension SHALL identify the
5-hour window by array position, treating the first window cap that is not provably too distant
as the 5-hour window and the remaining window caps as weekly.

A window cap SHALL be excluded from the 5-hour slot only when its `nextResetTime` is more than
six hours in the future. A missing `nextResetTime` SHALL NOT exclude it. Reset time SHALL NOT be
used to positively select a window.

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

### Requirement: Utilization prefers absolute amounts when they agree with the reported percentage
Where a window cap reports both `currentValue` and a positive `usage`, the extension SHALL derive
utilization from `currentValue / usage`, but only when that value agrees with the reported
`percentage` within 1.5 percentage points. Otherwise it SHALL use `percentage`. Utilization SHALL
be clamped to the range 0 to 1.

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
absolute amounts.

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

### Requirement: The weekly window presence survives a cache round-trip
The extension SHALL persist whether a weekly window exists as an explicit value, and SHALL
restore it unchanged when serving quota data from the cache, for every provider.

#### Scenario: A plan without a weekly window stays without one
- **WHEN** quota data reporting no weekly window is written to the cache and read back
- **THEN** the restored data still reports no weekly window

#### Scenario: A plan with a weekly window keeps it
- **WHEN** quota data reporting a weekly window is written to the cache and read back
- **THEN** the restored data still reports a weekly window

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
