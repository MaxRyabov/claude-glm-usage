## ADDED Requirements

### Requirement: Notifications are driven by quota utilization

The extension SHALL decide rate-limit notifications from the actual quota fraction of each window
(`utilization5h`, `utilization7d`), independent of any burn-rate or time-to-exhaustion prediction, so
the behavior is identical for every provider that exposes utilization (claude.ai and z.ai).

#### Scenario: No notification below the 5h start threshold
- **WHEN** the 5h window is below the configured start percent (default 90%) used
- **THEN** no rate-limit notification is shown for the 5h window

#### Scenario: Prediction is not used as a trigger
- **WHEN** a time-to-exhaustion prediction would have fired under the old logic but utilization is below threshold
- **THEN** no notification is shown

### Requirement: 5h window stepped warnings

The extension SHALL notify once per configured step (default 2%) once the 5h window reaches the start
threshold (default 90%), emitting only the highest reached step per evaluation.

#### Scenario: First step at the start threshold
- **WHEN** the 5h window reaches exactly 90% used
- **THEN** a warning notification for the `5h-90` step is shown, including the percent used and the time until the 5h window resets

#### Scenario: Subsequent steps
- **WHEN** the 5h window is at 93% used
- **THEN** a warning for the `5h-92` step is shown

#### Scenario: Only the current step is emitted
- **WHEN** utilization jumps past several steps between polls (e.g. 90% to 96%)
- **THEN** only the highest reached step (`5h-96`) is emitted, not every skipped step

### Requirement: 5h limit reached is an error

The extension SHALL show a distinct error-level notification with an Open Dashboard action when the
5h window is fully consumed.

#### Scenario: 100% used
- **WHEN** the 5h window is at 100% used
- **THEN** an error notification "5h rate limit reached" is shown with an Open Dashboard action

### Requirement: 7d window stepped warnings with a cap

The extension SHALL notify once per configured step (default 5%) between the 7d start (default 80%)
and end (default 90%) thresholds, and SHALL NOT add new 7d notifications above the end threshold. The
7d notifications apply only when the provider/plan exposes a 7d window.

#### Scenario: 7d steps
- **WHEN** the 7d window is at 80%, 85%, and 90% used on successive evaluations
- **THEN** warnings for `7d-80`, `7d-85`, and `7d-90` are shown respectively

#### Scenario: 7d cap
- **WHEN** the 7d window is at 95% used
- **THEN** only the `7d-90` step is shown (capped; nothing above the end threshold)

#### Scenario: No 7d window
- **WHEN** the active provider does not expose a 7d window (`has7dLimit` is false)
- **THEN** no 7d notification is shown regardless of any reported 7d utilization

### Requirement: Per-window deduplication and reset

The extension SHALL show each step at most once per window lifetime and SHALL re-arm a window's steps
when that window resets.

#### Scenario: No duplicate within a window
- **WHEN** a step has already been notified and utilization is re-evaluated at the same step
- **THEN** no duplicate notification is shown

#### Scenario: Re-arm after reset
- **WHEN** a window resets (its time-to-reset increases by more than one hour)
- **THEN** that window's notified steps are cleared so they can fire again in the new window

### Requirement: Configurable thresholds

The extension SHALL expose the start/step/end thresholds as settings, replacing the obsolete
minutes-before-exhaustion setting.

#### Scenario: Custom step
- **WHEN** the 5h start is set to 85% and the 5h step to 1%
- **THEN** at 87% used the `5h-87` step warning is shown

#### Scenario: Master toggle
- **WHEN** `notifications.rateLimitWarning` is disabled
- **THEN** no rate-limit notification is shown for any window
