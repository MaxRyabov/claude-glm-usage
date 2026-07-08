import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCacheValid, getCacheAge, validateCacheFile, writeCache } from '../../data/cache';

// Minimal CacheFile shape for testing (without importing private type)
interface TestCacheFile {
  version: 3
  updatedAt: string
  providerType: string
  usageData: {
    utilization5h: number
    utilization7d: number
    reset5hAt: number
    reset7dAt: number
    limitStatus: string
  }
}

function makeCache(ageSeconds: number): TestCacheFile {
  const updatedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const nowSec = Date.now() / 1000;
  return {
    version: 3,
    updatedAt,
    providerType: 'claude-ai',
    usageData: {
      utilization5h: 0.5,
      utilization7d: 0.3,
      reset5hAt: nowSec + 1800,
      reset7dAt: nowSec + 86400,
      limitStatus: 'allowed',
    },
  };
}

suite('Cache', () => {
  test('isCacheValid returns true when cache is fresh', () => {
    const cache = makeCache(100) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), true);
  });

  test('isCacheValid returns false when cache is stale', () => {
    const cache = makeCache(400) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), false);
  });

  test('isCacheValid returns false exactly at boundary', () => {
    const cache = makeCache(300) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), false);
  });

  test('getCacheAge returns approximate age in seconds', () => {
    const cache = makeCache(120) as Parameters<typeof getCacheAge>[0];
    const age = getCacheAge(cache);
    assert.ok(age >= 119 && age <= 125, `Expected ~120s, got ${age}`);
  });
});

suite('validateCacheFile (M-2)', () => {
  test('accepts a well-formed v3 cache', () => {
    assert.ok(validateCacheFile(makeCache(10)) !== null);
  });

  test('rejects a wrong version', () => {
    const c = makeCache(10) as unknown as Record<string, unknown>;
    c.version = 1;
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects a v2 cache lacking providerType', () => {
    const c = makeCache(10) as unknown as Record<string, unknown>;
    c.version = 2;
    delete c.providerType;
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects a missing/empty providerType', () => {
    const c = makeCache(10) as unknown as Record<string, unknown>;
    delete c.providerType;
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects utilization out of [0,1]', () => {
    const c = makeCache(10);
    c.usageData.utilization5h = 1.5;
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects an unknown limitStatus', () => {
    const c = makeCache(10);
    c.usageData.limitStatus = 'bogus';
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects a malformed updatedAt', () => {
    const c = makeCache(10);
    c.updatedAt = 'not-a-date';
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects NaN utilization (every NaN comparison is false)', () => {
    const c = makeCache(10);
    c.usageData.utilization5h = NaN;
    assert.strictEqual(validateCacheFile(c), null);
  });

  test('rejects a non-object', () => {
    assert.strictEqual(validateCacheFile(null), null);
    assert.strictEqual(validateCacheFile('string'), null);
  });
});

suite('writeCache permissions (M-1)', () => {
  // POSIX mode bits are meaningless on Windows; skip there (runs in CI/macOS).
  const isPosix = process.platform !== 'win32';
  const maybe = isPosix ? test : test.skip;
  const cachePath = path.join(os.homedir(), '.claude', 'vscode-claude-status-cache.json');
  let backup: string | null = null;

  // Back up and restore the real cache file so running the suite never clobbers
  // the user's actual cache (the test writes to the production path).
  suiteSetup(() => {
    if (!isPosix) { return; }
    try { backup = fs.readFileSync(cachePath, 'utf-8'); } catch { backup = null; }
  });

  suiteTeardown(() => {
    if (!isPosix) { return; }
    try {
      if (backup !== null) {
        fs.writeFileSync(cachePath, backup, { mode: 0o600 });
      } else {
        fs.rmSync(cachePath, { force: true });
      }
    } catch { /* ignore restore failures */ }
  });

  maybe('writes the cache file with mode 0600', async () => {
    await writeCache({
      utilization5h: 0.4,
      utilization7d: 0.2,
      resetIn5h: 1800,
      resetIn7d: 86400,
      limitStatus: 'allowed',
      has7dLimit: true,
    }, 'claude-ai');
    const mode = fs.statSync(cachePath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});
