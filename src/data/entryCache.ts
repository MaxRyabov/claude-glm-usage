import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TokenUsage } from './pricing';
import { atomicWriteJson } from './atomicWrite';

export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Confirm a path stays inside ~/.claude/projects/ (M-3). Defends against path traversal
 * (e.g. a symlink resolving elsewhere) so JSONL discovery never reads files outside the
 * projects directory.
 */
export function isSafePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoot = path.resolve(getClaudeProjectsDir());
  return resolved.startsWith(allowedRoot + path.sep);
}

// A normalized, deduplicated assistant usage record — the single shape every data
// consumer (usage totals, project cost, prediction, heatmap) reads from. Far smaller
// than the raw JSONL line, so the whole history fits in a few MB in memory / on disk.
export interface UsageEntry {
  timestamp: number   // ms since epoch
  model?: string
  usage: TokenUsage
  cwd?: string
}

interface FileCacheEntry {
  mtimeMs: number
  size: number
  offset: number          // byte offset up to which complete lines have been parsed
  entries: UsageEntry[]
  seenIds: Set<string>    // dedupe keys (requestId ?? message.id) already counted
}

// ---- module state -----------------------------------------------------------

const cache = new Map<string, FileCacheEntry>();

// True when the in-memory cache diverges from what was last persisted to disk, so an
// idle refresh cycle (nothing re-parsed) skips re-serializing the multi-MB cache file.
let dirty = false;

// Cached directory walk, reused while the projects tree is unchanged (rescan pre-check).
let walkCache: { dirSig: string; files: string[] } | null = null;

let persistedLoaded = false;

const PARSE_CACHE_VERSION = 1;

function getParseCachePath(): string {
  return path.join(os.homedir(), '.claude', 'vscode-claude-status-parsecache.json');
}

// ---- parsing ----------------------------------------------------------------

interface RawAssistant {
  type?: unknown
  timestamp?: unknown
  cwd?: unknown
  requestId?: unknown
  message?: { id?: unknown; model?: unknown; usage?: Partial<TokenUsage> }
}

function normalizeUsage(u: Partial<TokenUsage> | undefined): TokenUsage {
  return {
    input_tokens: u?.input_tokens || 0,
    output_tokens: u?.output_tokens || 0,
    cache_read_input_tokens: u?.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens || 0,
  };
}

/**
 * Parse a single JSONL line into `out` (deduped via `seenIds`). Returns true if the line
 * was valid JSON (i.e. a finished record), false if it failed to parse — which, for the
 * unterminated trailing segment, means a mid-write partial line to be re-read next pass.
 * Blank lines count as "complete" (true) so they don't pin the offset.
 */
function tryIngestLine(line: string, seenIds: Set<string>, out: UsageEntry[]): boolean {
  const trimmed = line.trim();
  if (!trimmed) { return true; }
  let obj: RawAssistant;
  try {
    obj = JSON.parse(trimmed) as RawAssistant;
  } catch {
    return false;   // not valid JSON yet
  }
  if (obj.type !== 'assistant' || typeof obj.timestamp !== 'string' || !obj.message) { return true; }
  const usage = obj.message.usage;
  if (!usage) { return true; }
  const ts = new Date(obj.timestamp).getTime();
  if (isNaN(ts)) { return true; }

  const dedupeKey =
    (typeof obj.requestId === 'string' && obj.requestId) ||
    (typeof obj.message.id === 'string' && obj.message.id) ||
    null;
  if (dedupeKey) {
    if (seenIds.has(dedupeKey)) { return true; }
    seenIds.add(dedupeKey);
  }

  out.push({
    timestamp: ts,
    model: typeof obj.message.model === 'string' ? obj.message.model : undefined,
    usage: normalizeUsage(usage),
    cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
  });
  return true;
}

/**
 * Parse `chunk` (a UTF-8 slice beginning at byte `absStart`, always a newline boundary)
 * into `out`, deduping via `seenIds`. Lines terminated by '\n' are final and always
 * consumed. The trailing unterminated segment is parsed too: if it is valid JSON it is a
 * finished record and consumed; if not, it is a mid-write partial line, so the offset is
 * left before it and it is re-read (and completed) on the next incremental pass. Returns
 * the new absolute byte offset.
 */
async function ingest(
  absStart: number,
  chunk: string,
  seenIds: Set<string>,
  out: UsageEntry[],
): Promise<number> {
  const lastNl = chunk.lastIndexOf('\n');
  const terminated = lastNl === -1 ? '' : chunk.slice(0, lastNl + 1);
  const tail = chunk.slice(lastNl + 1);   // '' when the chunk ends with '\n'

  // Yield to the event loop periodically: a cold parse of a large session file would
  // otherwise block the shared Extension Host for the whole file.
  const lines = terminated.split('\n');
  for (let i = 0; i < lines.length; i++) {
    tryIngestLine(lines[i], seenIds, out);
    if (i % 2000 === 1999) { await new Promise<void>((r) => setImmediate(r)); }
  }
  let consumed = Buffer.byteLength(terminated, 'utf-8');

  if (tail.trim() && tryIngestLine(tail, seenIds, out)) {
    consumed += Buffer.byteLength(tail, 'utf-8');   // valid JSON → finished record
  }

  return absStart + consumed;
}

/** Read bytes [offset, offset+length) of a file as UTF-8 (offset must be a \n boundary). */
async function readSlice(filePath: string, offset: number, length: number): Promise<string> {
  if (length <= 0) { return ''; }
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function parseFull(filePath: string, mtimeMs: number, size: number): Promise<FileCacheEntry> {
  const entries: UsageEntry[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    offset = await ingest(0, content, seenIds, entries);
  } catch {
    // unreadable — cache an empty record so we don't retry every cycle until it changes
  }
  const record: FileCacheEntry = { mtimeMs, size, offset, entries, seenIds };
  cache.set(filePath, record);
  dirty = true;
  return record;
}

async function parseIncremental(
  filePath: string,
  mtimeMs: number,
  size: number,
  cached: FileCacheEntry,
): Promise<FileCacheEntry> {
  try {
    const chunk = await readSlice(filePath, cached.offset, size - cached.offset);
    cached.offset = await ingest(cached.offset, chunk, cached.seenIds, cached.entries);
  } catch {
    // read failed — keep prior entries, just refresh stat below
  }
  cached.mtimeMs = mtimeMs;
  cached.size = size;
  dirty = true;
  return cached;
}

// ---- public API -------------------------------------------------------------

// Cold-start cap: parsing every session file at once (300 files / hundreds of MB on
// heavy installs) held all file contents in memory simultaneously and starved the
// shared Extension Host — the crash that took Claude Code's extension down with it.
const PARSE_CONCURRENCY = 4;

/** Load (and cache) normalized entries for the given files, parsing each at most once. */
export async function loadEntries(filePaths: string[]): Promise<UsageEntry[]> {
  const perFile: UsageEntry[][] = new Array(filePaths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < filePaths.length) {
      const idx = next++;
      perFile[idx] = await loadOne(filePaths[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARSE_CONCURRENCY, filePaths.length) }, worker),
  );
  const all: UsageEntry[] = [];
  for (const entries of perFile) { all.push(...entries); }
  return all;
}

// Concurrent consumers (usage totals, project cost, heatmap refresh in the same cycle)
// often request overlapping file sets; share one in-flight parse per file instead of
// re-reading the same bytes for each caller.
const inFlight = new Map<string, Promise<UsageEntry[]>>();

function loadOne(filePath: string): Promise<UsageEntry[]> {
  const pending = inFlight.get(filePath);
  if (pending) { return pending; }
  const p = doLoadOne(filePath).finally(() => { inFlight.delete(filePath); });
  inFlight.set(filePath, p);
  return p;
}

async function doLoadOne(filePath: string): Promise<UsageEntry[]> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    if (cache.delete(filePath)) { dirty = true; }   // file vanished — evict
    return [];
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;    // unchanged — served from cache
  }

  // Append-only growth with a known prefix → parse only the new tail.
  if (cached && stat.size > cached.size && cached.offset <= cached.size) {
    return (await parseIncremental(filePath, stat.mtimeMs, stat.size, cached)).entries;
  }

  // New file, truncation/rotation (size shrank), or in-place rewrite → full re-parse.
  return (await parseFull(filePath, stat.mtimeMs, stat.size)).entries;
}

/**
 * Discover JSONL session files under ~/.claude/projects/. The directory walk is reused
 * while the tree's signature (projects dir + subdirectory mtimes) is unchanged, so an
 * unchanged tree skips the re-walk. When `minMtimeMs` is given, files are stat-filtered
 * to that window (stat is cheap relative to read+parse).
 */
export async function discoverFiles(minMtimeMs?: number): Promise<string[]> {
  const all = await walkAll();
  if (minMtimeMs === undefined) { return all; }

  const stats = await Promise.all(all.map(async (p) => {
    try { return { p, m: (await fs.stat(p)).mtimeMs }; } catch { return null; }
  }));
  return stats
    .filter((s): s is { p: string; m: number } => s !== null && s.m >= minMtimeMs)
    .map((s) => s.p);
}

async function walkAll(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();

  let rootMtime = 0;
  try { rootMtime = (await fs.stat(projectsDir)).mtimeMs; } catch { return []; }

  let subdirs: string[];
  try { subdirs = await fs.readdir(projectsDir); } catch { return []; }

  const dirStats = await Promise.all(subdirs.map(async (d) => {
    const p = path.join(projectsDir, d);
    try {
      const s = await fs.stat(p);
      return s.isDirectory() ? { p, m: s.mtimeMs } : null;
    } catch { return null; }
  }));
  const dirs = dirStats.filter((d): d is { p: string; m: number } => d !== null);

  // Signature changes when a session file is added/removed/renamed (dir mtime) or the
  // set of project dirs changes — the cheap rescan pre-check.
  const dirSig = JSON.stringify([rootMtime, dirs.map((d) => [d.p, d.m])]);
  if (walkCache && walkCache.dirSig === dirSig) {
    return walkCache.files;
  }

  const files: string[] = [];
  await Promise.all(dirs.map(async (dir) => {
    let entries: string[];
    try { entries = await fs.readdir(dir.p); } catch { return; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) { continue; }
      let realPath = path.join(dir.p, entry);
      try { realPath = await fs.realpath(realPath); } catch { /* fall back to lexical */ }
      if (isSafePath(realPath)) { files.push(realPath); }
    }
  }));

  walkCache = { dirSig, files };
  return files;
}

// ---- disk persistence -------------------------------------------------------

interface PersistedFile {
  mtimeMs: number
  size: number
  offset: number
  entries: UsageEntry[]
  ids: string[]
}
interface PersistedCache {
  version: number
  files: Record<string, PersistedFile>
}

function isValidUsage(u: unknown): u is TokenUsage {
  if (!u || typeof u !== 'object') { return false; }
  const o = u as Record<string, unknown>;
  return typeof o.input_tokens === 'number' && typeof o.output_tokens === 'number'
    && typeof o.cache_read_input_tokens === 'number' && typeof o.cache_creation_input_tokens === 'number';
}

/** Load the persisted parse cache into memory (once). Missing/invalid → treated as empty. */
export async function loadPersistedCache(): Promise<void> {
  if (persistedLoaded) { return; }
  persistedLoaded = true;
  try {
    const raw = await fs.readFile(getParseCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedCache;
    if (!parsed || parsed.version !== PARSE_CACHE_VERSION || !parsed.files) { return; }
    for (const [filePath, rec] of Object.entries(parsed.files)) {
      if (!rec || typeof rec.mtimeMs !== 'number' || typeof rec.size !== 'number'
        || typeof rec.offset !== 'number' || !Array.isArray(rec.entries)) { continue; }
      const entries = rec.entries.filter(
        (e) => e && typeof e.timestamp === 'number' && isValidUsage((e as UsageEntry).usage),
      ) as UsageEntry[];
      cache.set(filePath, {
        mtimeMs: rec.mtimeMs,
        size: rec.size,
        offset: rec.offset,
        entries,
        seenIds: new Set(Array.isArray(rec.ids) ? rec.ids : []),
      });
    }
  } catch {
    // missing or corrupt — start empty
  }
}

/**
 * Persist the in-memory parse cache, dropping files older than `maxAgeMs` to bound size.
 * No-op while the cache is unchanged since the last successful persist — serializing the
 * multi-MB cache on every idle 60s refresh was measurable Extension Host load.
 */
export async function persistCache(maxAgeMs: number): Promise<void> {
  if (!dirty) { return; }
  const cutoff = Date.now() - maxAgeMs;
  const files: Record<string, PersistedFile> = {};
  for (const [filePath, rec] of cache.entries()) {
    if (rec.mtimeMs < cutoff) { continue; }
    files[filePath] = {
      mtimeMs: rec.mtimeMs,
      size: rec.size,
      offset: rec.offset,
      entries: rec.entries,
      ids: Array.from(rec.seenIds),
    };
  }
  // Cleared before the await so a mutation racing the write re-arms the flag.
  dirty = false;
  try {
    await atomicWriteJson(getParseCachePath(), { version: PARSE_CACHE_VERSION, files }, 0o600);
  } catch {
    dirty = true;   // write failed — retry on the next cycle
  }
}

/** Test helper: reset all in-memory state. */
export function __resetEntryCacheForTests(): void {
  cache.clear();
  walkCache = null;
  persistedLoaded = false;
  dirty = false;
}
