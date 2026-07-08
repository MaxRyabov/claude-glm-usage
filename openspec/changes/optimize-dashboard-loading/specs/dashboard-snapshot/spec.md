## ADDED Requirements

### Requirement: Persist dashboard snapshot to disk

After a successful refresh, the system SHALL persist a snapshot of the last computed dashboard
aggregates (usage data, project costs, heatmap) to a dedicated on-disk file, separate from the
rate-limit cache file. An unrecognized or invalid snapshot file SHALL degrade gracefully (treated as
absent) without breaking the existing rate-limit cache.

#### Scenario: Snapshot written after refresh

- **WHEN** a refresh completes successfully
- **THEN** the latest usage, project cost, and heatmap aggregates are written to the cache file

#### Scenario: Invalid snapshot ignored

- **WHEN** the cache file is missing the snapshot section or it fails validation
- **THEN** the snapshot is treated as absent and the extension continues without error

### Requirement: Instant cold-start render from snapshot

On startup the system SHALL load any persisted snapshot into its last-known state so the first
panel open renders immediately from the snapshot, then triggers a background refresh that pushes
fresh data via the existing update event. Snapshot-sourced data SHALL be visibly indicated as stale
until fresh data arrives.

#### Scenario: First open shows snapshot immediately

- **WHEN** the panel is opened for the first time after launching VSCode and a valid snapshot exists
- **THEN** the dashboard sections render from the snapshot without waiting for a full JSONL re-parse

#### Scenario: Background refresh replaces snapshot

- **WHEN** the snapshot has been displayed and a background refresh completes
- **THEN** the dashboard updates with fresh data and the stale indicator is cleared

#### Scenario: No snapshot falls back to live load

- **WHEN** no valid snapshot exists on first open
- **THEN** the dashboard performs a normal live data load

### Requirement: Atomic, crash-safe cache writes

Writes to the on-disk cache file (rate-limit data, dashboard snapshot, and parse cache) SHALL be
atomic: the data is written to a temporary file, flushed, and then renamed over the target, so a
crash mid-write cannot leave a corrupt or partially written cache file.

#### Scenario: Crash mid-write leaves prior cache intact

- **WHEN** the process is interrupted while writing the cache
- **THEN** the previous cache file remains intact (no partially written/corrupt file replaces it)

#### Scenario: Successful write replaces atomically

- **WHEN** a cache write completes
- **THEN** the target file is replaced in a single atomic rename
