import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RateLimitData, QuotaAmounts, QuotaBilling } from './apiClient';
import { atomicWriteJson } from './atomicWrite';

/** Current on-disk schema. v3 is still accepted for reading — see `validateCacheFile`. */
const CACHE_VERSION = 4;
/** `planLevel` is a free-form string from an external API; bound it before it reaches disk. */
const MAX_LEVEL_LENGTH = 32;

interface CacheFile {
  version: 3 | 4
  updatedAt: string
  // Which provider produced this rate-limit/quota snapshot. The cache is shared across
  // providers, so a consumer must only reuse it when it matches the active provider —
  // otherwise switching claude-ai ↔ z-ai would surface the other provider's utilization
  // until the TTL expired.
  providerType: string
  usageData: {
    utilization5h: number
    utilization7d: number
    // Unix timestamps in seconds (absolute, not relative) so that remaining
    // time can be recalculated correctly after reading a stale cache entry.
    reset5hAt: number
    reset7dAt: number
    limitStatus: string
    // v4. Stored explicitly because the old derivation (`reset7dAt > 0`) was always true:
    // writeCache stores `now + resetIn7d`, i.e. ~1.8e9 even when resetIn7d is 0, so every
    // cached read claimed a weekly window existed — for every provider.
    has7dLimit?: boolean
    billing?: QuotaBilling
    planLevel?: string
    // Reuses QuotaAmounts rather than restating it: a second copy of the shape would
    // drift the moment a field is added on the apiClient side.
    credits5h?: QuotaAmounts
    credits7d?: QuotaAmounts
  }
}

/**
 * Exported so tests back up and restore the same file the module writes. Two copies of this
 * path would drift apart silently: the tests would save and restore a path that no longer
 * exists while `writeCache` scribbled fixture quotas into the user's real cache.
 */
export function getCachePath(): string {
  // The override exists so tests can point at a temp directory. Without it a round-trip test
  // writes the user's real cache while their running extension rewrites the same file on its
  // own timer — a race that has failed runs here in practice, not just in theory. Unset in
  // production, so normal behaviour is unchanged.
  return process.env['CLAUDE_STATUS_CACHE_PATH']
    ?? path.join(os.homedir(), '.claude', 'vscode-claude-status-cache.json');
}

/** Optional absolute amounts: present and well-formed, or absent. Anything else is corrupt. */
function validateAmounts(v: unknown): QuotaAmounts | null | 'invalid' {
  if (v === undefined) { return null; }
  if (!v || typeof v !== 'object') { return 'invalid'; }
  const a = v as Record<string, unknown>;
  if (typeof a.used !== 'number' || !isFinite(a.used) || a.used < 0) { return 'invalid'; }
  if (typeof a.total !== 'number' || !isFinite(a.total) || a.total <= 0) { return 'invalid'; }
  if (a.remaining !== undefined &&
      (typeof a.remaining !== 'number' || !isFinite(a.remaining))) { return 'invalid'; }
  return a as unknown as QuotaAmounts;
}

/**
 * Schema-validate a parsed cache object (M-2). Returns the typed CacheFile when every
 * field is present and in range, otherwise null — so a tampered or corrupt cache file
 * degrades gracefully to "no data" instead of being trusted.
 *
 * Both v3 and v4 are accepted for reading, and writes are always v4. Rejecting v3 would be
 * fail-closed in the usual good sense, but during an extension update two windows share one
 * cache file: the new one would reject v3 and rewrite v4, the old one would reject v4 and
 * rewrite v3, and both would poll the API on every tick until every window restarted.
 */
export function validateCacheFile(data: unknown): CacheFile | null {
  if (!data || typeof data !== 'object') { return null; }
  const d = data as Record<string, unknown>;

  if (d.version !== 3 && d.version !== CACHE_VERSION) { return null; } // v1/v2 are rejected
  if (typeof d.updatedAt !== 'string' || isNaN(new Date(d.updatedAt).getTime())) { return null; }
  if (typeof d.providerType !== 'string' || d.providerType.length === 0) { return null; }

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

  // v4-only fields. All optional, so a v3 record passes; a malformed one still fails closed.
  if (ud.has7dLimit !== undefined && typeof ud.has7dLimit !== 'boolean') { return null; }
  if (ud.billing !== undefined &&
      (typeof ud.billing !== 'string' || !['credits', 'tokens'].includes(ud.billing))) { return null; }
  if (ud.planLevel !== undefined &&
      (typeof ud.planLevel !== 'string' || ud.planLevel.length === 0 ||
       ud.planLevel.length > MAX_LEVEL_LENGTH)) { return null; }
  if (validateAmounts(ud.credits5h) === 'invalid') { return null; }
  if (validateAmounts(ud.credits7d) === 'invalid') { return null; }

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

export async function writeCache(data: RateLimitData, providerType: string): Promise<void> {
  const nowSec = Date.now() / 1000;
  const usageData: CacheFile['usageData'] = {
    utilization5h: data.utilization5h,
    utilization7d: data.utilization7d,
    // Store absolute reset timestamps so remaining time stays correct
    reset5hAt: nowSec + data.resetIn5h,
    reset7dAt: nowSec + data.resetIn7d,
    limitStatus: data.limitStatus,
    has7dLimit: data.has7dLimit,
  };
  // The dashboard is served from cache for most of the TTL, so the amounts have to survive
  // the round-trip or they would flicker between polls.
  if (data.billing !== undefined) { usageData.billing = data.billing; }
  // Apply the same bound the validator enforces. Writing a value our own reader would reject
  // would mean rewriting a file that readCache then discards on every tick — the extension
  // would fall back to calling the API each time, which is the degradation this schema is
  // meant to avoid.
  if (typeof data.planLevel === 'string' &&
      data.planLevel.length > 0 && data.planLevel.length <= MAX_LEVEL_LENGTH) {
    usageData.planLevel = data.planLevel;
  }
  // Same reasoning as planLevel above: run the amounts through the reader's own check, so we
  // never persist a record readCache would throw away on every tick. `parseZaiQuota` already
  // rejects unusable amounts, but writeCache takes a RateLimitData from any producer.
  if (validateAmounts(data.credits5h) !== 'invalid') { usageData.credits5h = data.credits5h; }
  if (validateAmounts(data.credits7d) !== 'invalid') { usageData.credits7d = data.credits7d; }

  const cache: CacheFile = {
    version: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    providerType,
    usageData,
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

export type { CacheFile };
export { CACHE_VERSION };
