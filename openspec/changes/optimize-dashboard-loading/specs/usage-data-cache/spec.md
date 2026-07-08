## ADDED Requirements

### Requirement: Single parse per file via shared entry cache

The system SHALL maintain a shared in-memory cache of parsed Claude Code JSONL entries keyed by
file path, last-modified time (`mtime`), and size. All usage-data consumers SHALL obtain entries
from this cache rather than reading and parsing JSONL files independently.

#### Scenario: Unchanged file is served from cache

- **WHEN** a file's `mtime` and size are unchanged since it was last parsed
- **THEN** the cache returns the previously parsed entries without re-reading or re-parsing the file

#### Scenario: Changed file is re-parsed

- **WHEN** a file's `mtime` or size differs from the cached value (or the file is not yet cached)
- **THEN** the cache reads and parses the file (incrementally where possible — see incremental append parsing), stores the entries under the new `mtime`/size, and returns them

#### Scenario: Multiple consumers reuse one parse

- **WHEN** usage aggregation, project cost, prediction, and heatmap all request entries for the same file within one refresh cycle
- **THEN** the file is read and parsed at most once for that cycle

#### Scenario: Removed files are evicted

- **WHEN** a previously cached file no longer exists during discovery
- **THEN** its entry is removed from the cache so memory does not grow unbounded

### Requirement: Normalized entries with consistent deduplication

The shared cache SHALL produce normalized usage entries (timestamp, model, token usage, cwd) and
SHALL deduplicate streaming-response lines that share the same `requestId` or `message.id`, so each
API call is counted exactly once — matching the prior `readJsonlFile` behavior.

#### Scenario: Streaming duplicates counted once

- **WHEN** a file contains multiple `assistant` lines sharing one `requestId`/`message.id`
- **THEN** only the first occurrence contributes to usage totals

#### Scenario: Malformed lines skipped

- **WHEN** a JSONL line is not valid JSON or lacks usage data
- **THEN** the line is skipped without aborting parsing of the rest of the file

### Requirement: mtime-window file discovery

File discovery SHALL accept an optional minimum-`mtime` threshold and return only files whose
`mtime` falls within the requested window, so short-window consumers do not read the entire history.
Discovery SHALL preserve the existing path-safety checks (resolve symlinks and confirm the file
stays inside `~/.claude/projects/`).

#### Scenario: Short window skips old files

- **WHEN** prediction requests entries for the last 30 minutes
- **THEN** only files modified within that window are read

#### Scenario: Path traversal rejected

- **WHEN** a discovered entry resolves (via symlink) outside `~/.claude/projects/`
- **THEN** it is excluded from the file list

#### Scenario: Aggregated totals unchanged

- **WHEN** usage, project cost, and heatmap are computed over the same data via the shared cache
- **THEN** the resulting cost and token totals match the pre-refactor values for that data

### Requirement: Persistent on-disk parse cache

The parse cache SHALL be persisted to disk so that parsed entries survive a VSCode restart, keyed
by file path + `mtime` + size. On startup the cache SHALL be loaded from disk; files whose
`mtime`/size still match their cached key SHALL NOT be re-parsed. The on-disk cache SHALL degrade
gracefully (treated as empty) if missing or invalid.

#### Scenario: Cold start reuses disk cache

- **WHEN** the extension starts and a file's `mtime`/size matches its persisted cache key
- **THEN** the file's entries are loaded from the disk cache without re-parsing the JSONL

#### Scenario: Stale disk entry is refreshed

- **WHEN** a file's `mtime`/size no longer matches its persisted key
- **THEN** the file is re-parsed and the disk cache entry is updated

#### Scenario: Corrupt disk cache ignored

- **WHEN** the on-disk parse cache is missing or fails to parse
- **THEN** it is treated as empty and parsing proceeds normally

### Requirement: Incremental append parsing

The system SHALL parse Claude Code JSONL files incrementally: because they are append-only, when a
cached file has grown (size increased, earlier bytes unchanged) it MUST read and parse only the
bytes appended since the last known offset and merge them with the cached entries, rather than
re-reading the whole file. If a file's size has shrunk (truncation or rotation), the system SHALL
re-parse it from the beginning.

#### Scenario: Only appended bytes are parsed

- **WHEN** a cached file's size has grown and its content up to the previous offset is unchanged
- **THEN** only the newly appended lines are read and parsed, and merged with the cached entries

#### Scenario: Truncated file re-parsed fully

- **WHEN** a cached file's size is smaller than the last recorded offset
- **THEN** the file is re-parsed from the start

#### Scenario: Dedup preserved across incremental merge

- **WHEN** appended lines repeat a `requestId`/`message.id` already seen in cached entries
- **THEN** the duplicate is not double-counted after the merge

### Requirement: Cheap rescan pre-check before discovery

Before walking the projects directory, the system SHALL perform a cheap pre-check of the
`~/.claude/projects/` directory (and its immediate subdirectory) mtimes. If no monitored directory
mtime has changed since the last scan, the system SHALL reuse the previous discovery result instead
of re-walking the tree.

#### Scenario: Unchanged tree skips re-walk

- **WHEN** no monitored directory mtime has changed since the last discovery
- **THEN** the cached file list is reused without walking the directory tree

#### Scenario: Changed tree triggers re-walk

- **WHEN** a project directory mtime has changed (a new session file appeared or changed)
- **THEN** the directory tree is re-walked and the file list refreshed

### Requirement: Per-model pricing memoization

Resolving per-model pricing SHALL be memoized so repeated lookups for the same model name within a
parse/aggregation pass do not recompute the pricing resolution.

#### Scenario: Repeated model lookups reuse result

- **WHEN** many entries reference the same model name during aggregation
- **THEN** the pricing for that model is resolved once and reused for subsequent entries
