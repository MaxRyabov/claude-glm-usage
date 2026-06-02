import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  TokenUsage,
  TokenPricing,
  DEFAULT_PRICING,
  PricingContext,
  calculateCost,
  resolvePricing,
} from './pricing';

// Re-export the pricing primitives so existing importers keep working unchanged.
export { TokenUsage, TokenPricing, DEFAULT_PRICING, PricingContext, calculateCost, resolvePricing };

// Actual Claude Code JSONL structure (verified against real data):
// - type: 'assistant' entries contain usage data
// - usage is at entry.message.usage (NOT entry.usage)
// - model is at entry.message.model (e.g. "claude-opus-4-7", "glm-4.6")
// - costUSD field does not exist; always calculate from tokens
// - cwd is at the top level of every entry
interface JsonlEntry {
  type: string
  timestamp: string
  cwd?: string
  requestId?: string
  message?: {
    id?: string
    model?: string
    usage?: TokenUsage
  }
}

export interface AggregatedUsage {
  cost5h: number
  costDay: number
  cost7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number
}

export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Confirm a path stays inside ~/.claude/projects/ (M-3). Defends against path
 * traversal (e.g. a symlink resolving elsewhere) so JSONL discovery never reads
 * files outside the projects directory.
 */
export function isSafePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoot = path.resolve(getClaudeProjectsDir());
  return resolved.startsWith(allowedRoot + path.sep);
}

export async function findAllJsonlFiles(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();
  const files: string[] = [];

  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir);
      try {
        const stat = await fs.stat(dirPath);
        if (!stat.isDirectory()) { continue; }
        const entries = await fs.readdir(dirPath);
        for (const entry of entries) {
          if (entry.endsWith('.jsonl')) {
            // Resolve symlinks before the safety check so an entry pointing
            // outside the projects directory is rejected (M-3).
            let realPath = path.join(dirPath, entry);
            try {
              realPath = await fs.realpath(realPath);
            } catch {
              // fall back to the lexical path if realpath fails
            }
            if (isSafePath(realPath)) {
              files.push(realPath);
            }
          }
        }
      } catch {
        // skip unreadable dirs
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist — graceful degradation
  }

  return files;
}

export async function readJsonlFile(filePath: string): Promise<JsonlEntry[]> {
  const entries: JsonlEntry[] = [];
  // Claude Code writes one JSONL entry per content block in a streaming response,
  // all sharing the same requestId and usage counts. Deduplicate to count each
  // API call exactly once.
  const seenRequestIds = new Set<string>();
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        // Only 'assistant' entries have usage data in message.usage
        if (
          obj.type === 'assistant' &&
          typeof obj.timestamp === 'string' &&
          obj.message !== undefined
        ) {
          const dedupeKey =
            (typeof obj.requestId === 'string' && obj.requestId) ||
            (typeof (obj.message as Record<string, unknown>)?.id === 'string' &&
              (obj.message as Record<string, unknown>).id as string) ||
            null;
          if (dedupeKey) {
            if (seenRequestIds.has(dedupeKey)) { continue; }
            seenRequestIds.add(dedupeKey);
          }
          entries.push(obj as unknown as JsonlEntry);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
  return entries;
}

export async function readAllUsage(ctx: PricingContext = {}): Promise<AggregatedUsage> {
  const now = Date.now();
  const window5h = 5 * 3600 * 1000;
  const window7d = 7 * 24 * 3600 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const result: AggregatedUsage = {
    cost5h: 0,
    costDay: 0,
    cost7d: 0,
    tokensIn5h: 0,
    tokensOut5h: 0,
    tokensCacheRead5h: 0,
    tokensCacheCreate5h: 0,
  };

  const files = await findAllJsonlFiles();
  for (const file of files) {
    const entries = await readJsonlFile(file);
    for (const entry of entries) {
      const ts = new Date(entry.timestamp).getTime();
      if (isNaN(ts)) { continue; }

      const usage = entry.message?.usage;
      if (!usage) { continue; }
      const cost = calculateCost(usage, resolvePricing(entry.message?.model, ctx));

      const age = now - ts;
      if (age <= window7d) {
        result.cost7d += cost;
      }
      if (ts >= startOfToday.getTime()) {
        result.costDay += cost;
      }
      if (age <= window5h) {
        result.cost5h += cost;
        result.tokensIn5h += usage.input_tokens || 0;
        result.tokensOut5h += usage.output_tokens || 0;
        result.tokensCacheRead5h += usage.cache_read_input_tokens || 0;
        result.tokensCacheCreate5h += usage.cache_creation_input_tokens || 0;
      }
    }
  }

  return result;
}

export async function wasJsonlUpdatedRecently(seconds: number): Promise<boolean> {
  const files = await findAllJsonlFiles();
  const threshold = Date.now() - seconds * 1000;
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs >= threshold) { return true; }
    } catch {
      // skip
    }
  }
  return false;
}
