import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RateLimitData } from './apiClient';
import { atomicWriteJson } from './atomicWrite';

interface CacheFile {
  version: 2
  updatedAt: string
  usageData: {
    utilization5h: number
    utilization7d: number
    // Unix timestamps in seconds (absolute, not relative) so that remaining
    // time can be recalculated correctly after reading a stale cache entry.
    reset5hAt: number
    reset7dAt: number
    limitStatus: string
  }
}

function getCachePath(): string {
  return path.join(os.homedir(), '.claude', 'vscode-claude-status-cache.json');
}

/**
 * Schema-validate a parsed cache object (M-2). Returns the typed CacheFile when every
 * field is present and in range, otherwise null — so a tampered or corrupt cache file
 * degrades gracefully to "no data" instead of being trusted.
 */
export function validateCacheFile(data: unknown): CacheFile | null {
  if (!data || typeof data !== 'object') { return null; }
  const d = data as Record<string, unknown>;

  if (d.version !== 2) { return null; }  // v1 caches used relative times; reject them
  if (typeof d.updatedAt !== 'string' || isNaN(new Date(d.updatedAt).getTime())) { return null; }

  const u = d.usageData;
  if (!u || typeof u !== 'object') { return null; }
  const ud = u as Record<string, unknown>;

  // Positive range checks (x >= a && x <= b) also reject NaN, which would slip
  // through `x < a || x > b` because every comparison with NaN is false.
  if (typeof ud.utilization5h !== 'number' || !(ud.utilization5h >= 0 && ud.utilization5h <= 1)) { return null; }
  if (typeof ud.utilization7d !== 'number' || !(ud.utilization7d >= 0 && ud.utilization7d <= 1)) { return null; }
  if (typeof ud.reset5hAt !== 'number' || !(ud.reset5hAt >= 0)) { return null; }
  if (typeof ud.reset7dAt !== 'number' || !(ud.reset7dAt >= 0)) { return null; }
  if (typeof ud.limitStatus !== 'string' ||
      !['allowed', 'allowed_warning', 'denied'].includes(ud.limitStatus)) { return null; }

  return d as unknown as CacheFile;
}

export async function readCache(): Promise<CacheFile | null> {
  try {
    const content = await fs.readFile(getCachePath(), 'utf-8');
    return validateCacheFile(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function writeCache(data: RateLimitData): Promise<void> {
  const nowSec = Date.now() / 1000;
  const cache: CacheFile = {
    version: 2,
    updatedAt: new Date().toISOString(),
    usageData: {
      utilization5h: data.utilization5h,
      utilization7d: data.utilization7d,
      // Store absolute reset timestamps so remaining time stays correct
      reset5hAt: nowSec + data.resetIn5h,
      reset7dAt: nowSec + data.resetIn7d,
      limitStatus: data.limitStatus,
    },
  };
  try {
    // mode 0600: readable/writable by the owner only — the cache can hold rate-limit
    // state derived from credentials, so other local users must not read it (M-1).
    // Atomic write (temp → fsync → rename) so a crash can't leave a corrupt cache.
    await atomicWriteJson(getCachePath(), cache, 0o600);
  } catch {
    // ignore write failures (e.g. read-only FS)
  }
}

export function isCacheValid(cache: CacheFile, ttlSeconds: number): boolean {
  const age = (Date.now() - new Date(cache.updatedAt).getTime()) / 1000;
  return age < ttlSeconds;
}

export function getCacheAge(cache: CacheFile): number {
  return (Date.now() - new Date(cache.updatedAt).getTime()) / 1000;
}
