## Context

The dashboard reads Claude Code usage from `~/.claude/projects/**/*.jsonl`. Today four modules
(`readAllUsage`, `getProjectCostForDir`, `readRecentCosts`, `getHeatmapData`) independently scan and
`JSON.parse` the same files on every refresh, and the file watcher fires an unbounded, non-coalesced
`refresh()` per write event. During a Claude Code stream this overloads the shared Extension Host
and triggers a host reload (all extensions restart). Only rate-limit data is persisted, so the first
panel open always shows "Loading…". Techniques validated in the sibling project `D:\Projects\CodeDash`
(disk parse cache keyed by path|mtime|size, incremental append parsing, mtime rescan pre-check,
atomic writes, pricing memoization) are folded in.

Constraints: keep public function signatures used by `src/test/suite/` stable; preserve path-safety
checks; never block the main thread; degrade gracefully when `~/.claude/` is missing.

## Goals / Non-Goals

**Goals:**
- Parse each JSONL file at most once per change; reuse across all consumers (memory + disk cache).
- Cut work for short windows via mtime-window discovery and a cheap rescan pre-check.
- Keep the Extension Host stable under high-frequency writes (debounce + serialized refresh).
- Instant cold-start render from an on-disk snapshot, then background refresh.
- Preserve current cost/token totals exactly.

**Non-Goals:**
- No new runtime dependencies (no SQLite, no worker threads).
- No change to the rate-limit/quota API logic or pricing values.
- No UI redesign beyond a "stale" indicator already supported via `dataSource`.
- Not adopting CodeDash's search index / peek-reading (not needed here).

## Decisions

### 1. New module `src/data/entryCache.ts` as the single read/parse path
A singleton store exposes:
- `discoverFiles(minMtimeMs?: number): Promise<string[]>` — directory walk with a cheap rescan
  pre-check (cache last walk result + monitored dir mtimes; re-walk only on change), optional
  mtime-window filter, and the existing path-safety (`realpath` inside `~/.claude/projects/`).
- `loadEntries(filePaths: string[]): Promise<UsageEntry[]>` — for each file, `stat` in parallel;
  serve from cache when `mtime|size` match; else parse (incrementally when only appended) and update
  both the in-memory map and the on-disk cache.
- `UsageEntry { timestamp: number; model?: string; usage: TokenUsage; cwd?: string }`.

Rationale: one implementation of parsing + dedup replaces three copies, so a 60s refresh touching one
changed file costs one small parse. Alternative (each consumer keeps its own reader, just add mtime
filter) was rejected — it leaves redundant parsing and four code paths to keep in sync.

### 2. Cache entry shape and incremental parsing
In-memory: `Map<filePath, { mtimeMs, size, offset, entries, seenIds }>`. On change:
- `size > cachedSize` → read bytes `[offset, size)` via a file handle (`fs.open` + `read`), split the
  appended chunk on newlines (carry a partial-line remainder at `offset`), parse, dedup against the
  retained `seenIds` set, append to `entries`, advance `offset`.
- `size < cachedOffset` (truncation/rotation) → full re-parse from 0.
- Not cached → full parse, record `offset = size`.

Dedup key = `requestId ?? message.id`, matching today's `readJsonlFile`. Keeping `seenIds` per file
makes the incremental merge correct. Alternative (always re-read whole file on any mtime change) is
simpler but loses the biggest win for the active session file (the one that changes constantly).

### 3. Separate on-disk files for parse cache and dashboard snapshot
Keep the existing `~/.claude/vscode-claude-status-cache.json` (v2, rate-limit) untouched, and add two
dedicated files written independently:
- `vscode-claude-status-parsecache.json` — per-file `{ mtimeMs, size, offset, entries }`.
- `vscode-claude-status-snapshot.json` — last `ClaudeUsageData`, `projectCosts`, `heatmap`, `generatedAt`.

Rationale: separate files avoid rewriting a multi-MB parse cache every time the small (5-min)
rate-limit cache is written, and let each concern validate/degrade independently. Each is written via
a new `atomicWriteJson` (temp + `fsync` + rename). A missing/invalid file is treated as empty. Bound
the on-disk `parseCache` (drop files outside the largest/heatmap window, cap total) so it can't grow
without limit. The deduped assistant-only entries are far smaller than the raw JSONL (~150 B/entry),
so even a heavy 90-day history stays in the single-digit-MB range.

### 4. dataManager: debounce watcher + serialized/coalesced refresh
- Watcher `onDidChange/onDidCreate` feed a single debounce timer (~1.5–2s); fire one `refresh()` after
  quiet. Clear timer on `dispose()`.
- `refresh()`/`forceRefresh()` guarded by `refreshing`/`refreshQueued` flags: if a refresh is running,
  mark queued and run exactly one more after it completes (mirrors the existing `heatmapPending`
  pattern). After a successful refresh, persist the snapshot.

Rationale: this is the direct fix for the host-reload storm; combined with the cheap per-refresh cost
from §1–2 it makes watcher bursts harmless.

### 5. Cold-start render path
On activation, load the snapshot into `lastData`/`lastProjectCosts`/`lastHeatmapData` so the first
`onDidUpdate`/panel `ready` sends data immediately (marked stale via `dataSource`), then the normal
background refresh replaces it. Pricing resolution memoized per pass (`Map<modelName, pricing>`).

## Risks / Trade-offs

- **Incremental-parse correctness vs. non-append writes** → guard strictly on size growth + truncation
  detection; any mismatch falls back to full re-parse. Add tests for append, truncation, and rewrite.
- **projectCost dedup scope changes** (per-file in the shared cache vs. today's per-directory Set) →
  streaming duplicates share a file, so totals should match; verify with a regression test before/after.
- **On-disk cache staleness/corruption** → schema validation + atomic writes + graceful "treat as
  empty"; snapshot shown stale until refreshed.
- **Cache file growth** → cap `parseCache` size and evict files outside the largest window.
- **Cross-platform `fsync`/rename** → use Node `fs` primitives already used elsewhere; rename is atomic
  on the same filesystem (cache lives under `~/.claude`).

## Migration Plan

Additive: v3 cache supersedes v2 (v2 still readable for `usageData`). No settings or API changes.
Rollback = revert the change; a v3 cache file is ignored by the old code (it rejects `version !== 2`),
so downgrades degrade to "no cache" rather than breaking.
