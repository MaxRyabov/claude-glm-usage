## Why

The WebView dashboard loads very slowly — every section sits in "Loading…" for a long
time — and during active Claude Code sessions the extension destabilizes the shared VSCode
Extension Host, forcing all extensions (including Claude Code) to reload mid-session. Both
symptoms trace to the same data layer: the JSONL history is re-read and re-parsed redundantly
on every update, and the file watcher fires unbounded, overlapping refreshes.

## What Changes

- Introduce a **shared parsed-entry cache** keyed by file path + `mtime` + size. Each JSONL file is
  read and parsed exactly once; all consumers (`readAllUsage`, `getProjectCostForDir`,
  `readRecentCosts`, `getHeatmapData`) draw from it. On refresh, only changed files are re-read.
- **Persist the parse cache to disk** (keyed by path|mtime|size) so parsed entries survive a VSCode
  restart, and **parse appended bytes incrementally** for append-only JSONL files instead of
  re-reading whole files. *(Techniques adapted from the CodeDash project.)*
- Apply **mtime-based file filtering** to discovery so short-window consumers (e.g. 30-minute
  prediction, 7-day usage) skip files outside their window, plus a **cheap rescan pre-check** of
  directory mtimes to skip the directory walk entirely when nothing changed.
- **Memoize per-model pricing** resolution and write all cache files **atomically** (temp + flush +
  rename) to avoid corruption.
- **Debounce the file watcher** and **serialize `refresh()`** (mutex + coalesce) so a burst of
  JSONL writes during a Claude Code stream collapses into a single bounded refresh — eliminating
  the Extension Host overload that reloads other extensions.
- **Persist a dashboard snapshot to disk** (usage, project costs, heatmap) so the first panel
  open after launching VSCode renders instantly from the snapshot, then refreshes in the
  background.

## Capabilities

### New Capabilities
- `usage-data-cache`: A shared store (in-memory + on-disk, keyed by path|mtime|size) that reads and
  parses each Claude Code JSONL file once — incrementally for appended bytes — and serves normalized
  usage entries to all data consumers, with mtime-window file filtering, a cheap rescan pre-check,
  and per-model pricing memoization.
- `refresh-stability`: Debounced file-watcher handling and serialized/coalesced refresh cycles
  that keep the Extension Host responsive under high-frequency JSONL writes.
- `dashboard-snapshot`: On-disk persistence of the last computed dashboard aggregates for
  instant cold-start rendering, followed by a background refresh, using atomic crash-safe writes.

### Modified Capabilities
<!-- No existing committed specs change their requirements; openspec/specs/ is empty. -->

## Impact

- **Code**: new `src/data/entryCache.ts`; refactors to `src/data/jsonlReader.ts`,
  `src/data/projectCost.ts`, `src/data/prediction.ts`, `src/webview/heatmap.ts`,
  `src/data/dataManager.ts` (watcher debounce + refresh mutex + snapshot load/save),
  `src/data/cache.ts` (cache file schema bump for snapshot), and the panel `ready` handler in
  `src/webview/panel.ts`.
- **Behavior**: faster dashboard load, instant cold start, no Extension Host reload storms.
- **Compatibility**: cache file `version` bumps; older cache files degrade gracefully. Public
  function signatures consumed by `src/test/suite/` are preserved.
- **Tests**: existing suites (jsonlReader, projectCost, prediction, heatmap, cache) must keep
  passing; deduplication semantics in `projectCost` are verified unchanged.
