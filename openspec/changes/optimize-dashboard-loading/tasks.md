## 1. Atomic writes + separate on-disk files

- [x] 1.1 Add `src/util/atomicWrite.ts` with `atomicWriteJson(filePath, obj)` (write temp → fsync → rename, cleanup temp on failure)
- [x] 1.2 Route the existing `src/data/cache.ts` rate-limit write through `atomicWriteJson` (keep v2 schema unchanged)
- [x] 1.3 Add `src/data/snapshotCache.ts`: `readSnapshot`/`writeSnapshot` for the dashboard snapshot file, with validation + graceful degradation
- [x] 1.4 Persist the parse cache in its own file via `entryCache` (see 2.x); validate + treat missing/invalid as empty

## 2. Shared entry cache (`src/data/entryCache.ts`)

- [x] 2.1 Define `UsageEntry` and the in-memory `Map<filePath, { mtimeMs, size, offset, entries, seenIds }>`; load persisted `parseCache` on first use
- [x] 2.2 Implement `loadEntries(filePaths)`: parallel `stat`, serve from cache on matching `mtime|size`, else parse
- [x] 2.3 Implement full parse (with dedup by `requestId ?? message.id`) and per-model pricing memoization (`Map<model, pricing>`)
- [x] 2.4 Implement incremental append parse: read bytes `[offset, size)`, carry partial-line remainder, merge + dedup against `seenIds`, advance offset; full re-parse when `size < offset`
- [x] 2.5 Implement `discoverFiles(minMtimeMs?)`: directory walk preserving path-safety (`realpath` inside `~/.claude/projects/`), optional mtime-window filter
- [x] 2.6 Add cheap rescan pre-check: cache last walk + monitored dir mtimes; reuse result when unchanged
- [x] 2.7 Evict cache entries for files no longer discovered; bound persisted `parseCache` (drop files outside the largest window); persist updates via `writeParseCache`

## 3. Refactor consumers onto the shared cache

- [x] 3.1 `src/data/jsonlReader.ts`: `readAllUsage` uses `discoverFiles(now-7d)` + `loadEntries`; keep export signature; make `findAllJsonlFiles`/`readJsonlFile` thin wrappers or remove if unused
- [x] 3.2 `src/data/prediction.ts`: `readRecentCosts` uses `discoverFiles(now-30m)` + `loadEntries`
- [x] 3.3 `src/data/projectCost.ts`: `getProjectCostForDir` uses `loadEntries` over the project dir's files; verify totals match (per-file dedup)
- [x] 3.4 `src/webview/heatmap.ts`: `getHeatmapData` uses `discoverFiles(now-90d)` + `loadEntries`; keep `aggregateByDay`/`aggregateByHour`

## 4. dataManager: stability + snapshot

- [x] 4.1 Debounce watcher `onDidChange`/`onDidCreate` (~1.5–2s single timer); clear on `dispose()`
- [x] 4.2 Serialize `refresh()`/`forceRefresh()` with `refreshing`/`refreshQueued` (run exactly one more if requested mid-flight)
- [x] 4.3 Persist snapshot (`writeSnapshot`) after a successful refresh
- [x] 4.4 On startup, load snapshot into `lastData`/`lastProjectCosts`/`lastHeatmapData`; mark `dataSource` stale until first fresh refresh

## 5. Panel cold-start

- [x] 5.1 In the panel `ready` handler, send the snapshot immediately, then let the background refresh push fresh data via `onDidUpdate`
- [x] 5.2 Surface the stale indicator in the WebView until fresh data arrives

## 6. Tests + verification

- [x] 6.1 `entryCache` tests: cache hit on unchanged `mtime|size`; re-parse on change; eviction of removed files
- [x] 6.2 Incremental parse tests: append-only growth parses only new bytes; truncation re-parses; dedup preserved across merge
- [x] 6.3 Discovery tests: mtime-window filter; path-traversal rejection; rescan pre-check skips re-walk when unchanged
- [x] 6.4 Cache tests: snapshot round-trip + Date revival; invalid snapshot ignored; atomic write reads back equal / leaves no temp file
- [x] 6.5 Regression: project-cost dedup totals unchanged (projectCost.test); existing usage/heatmap suites still green
- [ ] 6.6 dataManager debounce/coalesce tests — deferred: logic is coupled to the DataManager singleton + vscode FileSystemWatcher + live refresh I/O, so verified manually (F5) rather than unit-tested
- [x] 6.7 Run `npm run lint` and `npm test`; update `CHANGELOG.md` `## [Unreleased]` (perf + fix)
