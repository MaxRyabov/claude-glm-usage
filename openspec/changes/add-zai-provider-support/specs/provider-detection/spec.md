## ADDED Requirements

### Requirement: Detect custom Anthropic-compatible endpoints
The extension SHALL recognise a configured `ANTHROPIC_BASE_URL` whose host is not
`api.anthropic.com` and classify the provider as `z-ai` (host contains `z.ai`) or
`custom-endpoint` otherwise.

#### Scenario: z.ai base URL
- **WHEN** `ANTHROPIC_BASE_URL` is `https://api.z.ai/api/anthropic`
- **THEN** the provider is detected as `z-ai`

#### Scenario: Other custom base URL
- **WHEN** `ANTHROPIC_BASE_URL` points to a non-Anthropic, non-z.ai host
- **THEN** the provider is detected as `custom-endpoint`

### Requirement: Base URL is read from Claude settings
The extension SHALL read `ANTHROPIC_BASE_URL` from `process.env`, then
`~/.claude/settings.json`, then `~/.claude/settings.local.json` (`env` object), confined to
`~/.claude` and tolerant of missing or malformed files.

#### Scenario: Base URL only in settings.json
- **WHEN** `ANTHROPIC_BASE_URL` is absent from `process.env` but present in `~/.claude/settings.json`
- **THEN** the value from `settings.json` is used

#### Scenario: Malformed settings file
- **WHEN** `~/.claude/settings.json` is missing or not valid JSON
- **THEN** detection does not throw and falls back to the credential/env probes

### Requirement: Custom endpoint suppresses Anthropic rate-limit call
When a non-Anthropic base URL is detected, the extension SHALL NOT call the Anthropic
rate-limit endpoint, even if a stale `claudeAiOauth` credentials file exists.

#### Scenario: Stale OAuth with z.ai base URL
- **WHEN** a `claudeAiOauth` credentials file exists AND `ANTHROPIC_BASE_URL` is a z.ai host
- **THEN** the provider is `z-ai` and no request is made to `api.anthropic.com`

#### Scenario: Non-z.ai custom endpoint is cost-only
- **WHEN** the provider is `custom-endpoint`
- **THEN** the status bar shows cost-only mode (no rate-limit %)

### Requirement: z.ai quota display
For the `z-ai` provider the extension SHALL fetch the 5-hour and weekly quota from z.ai's
monitor endpoint and display the utilization percentages, mirroring the z.ai subscription
dashboard. It SHALL degrade to cost-only mode when no auth token is available or the request
fails.

#### Scenario: Quota fetched and shown
- **WHEN** the provider is `z-ai` and an `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` is available
- **THEN** the extension requests `{origin}/api/monitor/usage/quota/limit` with a Bearer token
  and shows the returned 5-hour and weekly utilization percentages

#### Scenario: No token degrades gracefully
- **WHEN** the provider is `z-ai` but no auth token is configured
- **THEN** the extension shows cost-only mode without throwing
