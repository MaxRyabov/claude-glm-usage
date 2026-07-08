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
}

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

export async function writeSnapshot(snapshot: DashboardSnapshot): Promise<void> {
  const file: SnapshotFile = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    usage: snapshot.usage,
    projectCosts: snapshot.projectCosts,
    heatmap: snapshot.heatmap,
  };
  try {
    await atomicWriteJson(getSnapshotPath(), file, 0o600);
  } catch {
    // ignore write failures (e.g. read-only FS)
  }
}

/** Load the persisted snapshot, reviving Date fields. Missing/invalid → null. */
export async function readSnapshot(): Promise<DashboardSnapshot | null> {
  try {
    const raw = await fs.readFile(getSnapshotPath(), 'utf-8');
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
      lastUpdated: reviveDate(file.usage.lastUpdated) ?? new Date(0),
    };
    const projectCosts = Array.isArray(file.projectCosts)
      ? file.projectCosts.map((p) => ({ ...p, lastActive: reviveDate(p.lastActive) ?? new Date(0) }))
      : [];
    const heatmap = file.heatmap
      ? { ...file.heatmap, generatedAt: reviveDate(file.heatmap.generatedAt) ?? new Date(0) }
      : null;

    return { usage, projectCosts, heatmap };
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
