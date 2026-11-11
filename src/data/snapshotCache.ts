import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJson } from './atomicWrite';
import type { ClaudeUsageData } from './dataManager';
import type { ProjectCostData } from './projectCost';
import type { HeatmapData } from '../webview/heatmap';

// A persisted snapshot of the last computed dashboard aggregates. Stored in its own file
// (separate from the rate-limit cache) so the first panel open after a VSCode restart can
// render instantly from disk while a fresh refresh runs in the background.
export interface DashboardSnapshot {
  usage: ClaudeUsageData
  projectCosts: ProjectCostData[]
  heatmap: HeatmapData | null
  /** Set by readSnapshot: when the file was written — consumers rebase the relative reset times by this. */
  savedAt: Date
}

/** What writeSnapshot takes: the snapshot body — `savedAt` is stamped by the writer itself. */
export type SnapshotInput = Omit<DashboardSnapshot, 'savedAt'>;

interface SnapshotFile {
  version: number
  savedAt: string
  usage: ClaudeUsageData
  projectCosts: ProjectCostData[]
  heatmap: HeatmapData | null
}

const SNAPSHOT_VERSION = 1;

function getSnapshotPath(): string {
  return path.join(os.homedir(), '.claude', 'vscode-claude-status-snapshot.json');
}

export async function writeSnapshot(snapshot: SnapshotInput): Promise<void> {
  // peak and context are volatile: the first goes stale within minutes, the second
  // recomputes from the parse cache instantly — neither belongs in the snapshot. Stripped
  // here, at the format owner, so no caller can persist them by accident.
  const { peak, context, ...usage } = snapshot.usage;
  void peak; void context;
  const file: SnapshotFile = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    usage,
    projectCosts: snapshot.projectCosts,
    heatmap: snapshot.heatmap,
  };
  try {
    await atomicWriteJson(getSnapshotPath(), file, 0o600);
  } catch {
    // ignore write failures (e.g. read-only FS)
  }
}

/**
 * Load the persisted snapshot, reviving Date fields. Missing/invalid → null. The path
 * defaults to the production location; tests pass their own (a temp dir) so they never
 * touch the user's real snapshot.
 */
export async function readSnapshot(filePath: string = getSnapshotPath()): Promise<DashboardSnapshot | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const file = JSON.parse(raw) as SnapshotFile;
    if (!file || file.version !== SNAPSHOT_VERSION || !file.usage || typeof file.usage !== 'object') {
      return null;
    }
    if (typeof file.usage.cost5h !== 'number' || typeof file.usage.utilization5h !== 'number') {
      return null;
    }
    // Fail closed on schema drift: reject an older/renamed snapshot whose required
    // discriminator fields are missing or mistyped, rather than letting `undefined`
    // flow into the UI (mirrors validateCacheFile's strictness for the rate-limit cache).
    const u = file.usage as unknown as Record<string, unknown>;
    if (typeof u.providerType !== 'string' ||
        typeof u.dataSource !== 'string' ||
        typeof u.limitStatus !== 'string') {
      return null;
    }

    const usage: ClaudeUsageData = {
      ...file.usage,
      // Window-credit fields added after the first release default to 0: a snapshot
      // written by an older version must not leak undefined into spend5h (NaN forecast)
      // during the gap between loadFromDisk and the first live refresh.
      localCredits5h: file.usage.localCredits5h ?? 0,
      localCreditsDay: file.usage.localCreditsDay ?? 0,
      localCredits7d: file.usage.localCredits7d ?? 0,
      lastUpdated: reviveDate(file.usage.lastUpdated) ?? new Date(0),
    };
    const projectCosts = Array.isArray(file.projectCosts)
      ? file.projectCosts.map((p) => ({ ...p, lastActive: reviveDate(p.lastActive) ?? new Date(0) }))
      : [];
    const heatmap = file.heatmap
      ? { ...file.heatmap, generatedAt: reviveDate(file.heatmap.generatedAt) ?? new Date(0) }
      : null;
    // A broken savedAt reads as epoch 0 — maximally stale, the conservative choice for
    // consumers that rebase relative reset times by the snapshot's age.
    const savedAt = reviveDate(file.savedAt) ?? new Date(0);

    return { usage, projectCosts, heatmap, savedAt };
  } catch {
    return null;   // missing or corrupt — treat as no snapshot
  }
}

function reviveDate(value: unknown): Date | null {
  if (value instanceof Date) { return value; }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
