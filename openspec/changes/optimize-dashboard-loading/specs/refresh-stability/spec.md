## ADDED Requirements

### Requirement: Debounced file-watcher handling

The file watcher on `~/.claude/projects/**/*.jsonl` SHALL debounce change and create events, so a
burst of writes within a short window triggers at most one refresh after the burst settles. The
debounce timer SHALL be cleared on disposal.

#### Scenario: Burst collapses to one refresh

- **WHEN** many JSONL change events arrive within the debounce window (e.g. during a Claude Code streaming response)
- **THEN** a single refresh runs after the window elapses, not one refresh per event

#### Scenario: Timer cleared on dispose

- **WHEN** the data manager is disposed while a debounce timer is pending
- **THEN** the pending timer is cancelled and no refresh fires afterward

### Requirement: Serialized, coalesced refresh

`refresh()` and `forceRefresh()` SHALL NOT execute concurrently. When a refresh is requested while
one is already in progress, the system SHALL coalesce the request and run exactly one additional
refresh after the current one completes, rather than starting overlapping refreshes.

#### Scenario: Overlapping requests coalesce

- **WHEN** a refresh is requested while another refresh is already running
- **THEN** the new request is deferred and executed once after the in-flight refresh finishes

#### Scenario: Extension Host stays responsive under load

- **WHEN** JSONL files are written at high frequency during an active session
- **THEN** the number of in-flight refresh cycles stays bounded (at most one running plus one queued) and the Extension Host is not overloaded into a reload
