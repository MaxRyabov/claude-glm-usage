import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCacheValid, getCacheAge, validateCacheFile, writeCache } from '../../data/cache';

// Minimal CacheFile shape for testing (without importing private type).
// Deliberately still v3: the current reader accepts both 3 and 4, so this fixture doubles as
// the backward-compatibility guard for windows running an older extension build.
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

// ---------------------------------------------------------------------------
// Schema v4: explicit weekly-window flag, credit amounts and plan tier.
// ---------------------------------------------------------------------------
suite('Cache schema v4', () => {
  const base = (over: Record<string, unknown> = {}): unknown => {
    const nowSec = Date.now() / 1000;
    return {
      version: 4,
      updatedAt: new Date().toISOString(),
      providerType: 'z-ai',
      usageData: {
        utilization5h: 0.5,
        utilization7d: 0.3,
        reset5hAt: nowSec + 1800,
        reset7dAt: nowSec + 86400,
        limitStatus: 'allowed',
        has7dLimit: true,
        ...over,
      },
    };
  };

  test('accepts a v4 record carrying amounts and tier', () => {
    const v = validateCacheFile(base({
      billing: 'credits',
      planLevel: 'max',
      credits5h: { used: 16693, total: 28000, remaining: 11306 },
      credits7d: { used: 47691, total: 140000 },
    }));
    assert.ok(v, 'expected the record to validate');
    assert.strictEqual(v?.usageData.planLevel, 'max');
    assert.strictEqual(v?.usageData.credits5h?.remaining, 11306);
    // remaining is optional — z.ai does not always send it.
    assert.strictEqual(v?.usageData.credits7d?.remaining, undefined);
  });

  test('accepts a v3 record so mixed extension versions cannot fight over the file', () => {
    // Without this, an updated window rejects v3 and rewrites v4, the older one rejects v4 and
    // rewrites v3, and both poll the API every tick until every window restarts.
    const nowSec = Date.now() / 1000;
    const v3 = {
      version: 3,
      updatedAt: new Date().toISOString(),
      providerType: 'claude-ai',
      usageData: {
        utilization5h: 0.5, utilization7d: 0.3,
        reset5hAt: nowSec + 1800, reset7dAt: nowSec + 86400, limitStatus: 'allowed',
      },
    };
    assert.ok(validateCacheFile(v3), 'v3 must still be readable');
  });

  test('still rejects the abandoned versions and out-of-range values', () => {
    assert.strictEqual(validateCacheFile(base({}) && { ...(base({}) as object), version: 2 }), null);
    assert.strictEqual(validateCacheFile(base({ utilization5h: 1.5 })), null);
    assert.strictEqual(validateCacheFile(base({ limitStatus: 'unknown' })), null);
    assert.strictEqual(validateCacheFile(base({ utilization7d: NaN })), null);
  });

  test('rejects malformed v4 fields rather than trusting them', () => {
    assert.strictEqual(validateCacheFile(base({ has7dLimit: 'yes' })), null);
    assert.strictEqual(validateCacheFile(base({ billing: 'bitcoin' })), null);
    // planLevel reaches WebView markup, so an overlong or non-string value voids the record.
    assert.strictEqual(validateCacheFile(base({ planLevel: 'x'.repeat(200) })), null);
    assert.strictEqual(validateCacheFile(base({ planLevel: 42 })), null);
    assert.strictEqual(validateCacheFile(base({ credits5h: { used: 1 } })), null);
    assert.strictEqual(validateCacheFile(base({ credits5h: { used: 1, total: 0 } })), null);
  });

  test('writeCache round-trips the weekly flag both ways', async () => {
    // The defect this replaces: has7dLimit was derived from `reset7dAt > 0`, and writeCache
    // stores `now + resetIn7d` — ~1.8e9 even when resetIn7d is 0 — so every cached read
    // claimed a weekly window, for every provider including Anthropic Pro.
    const cachePath = path.join(os.homedir(), '.claude', 'vscode-claude-status-cache.json');
    const saved = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf-8') : null;
    try {
      await writeCache({
        utilization5h: 0.2, utilization7d: 0, resetIn5h: 900, resetIn7d: 0,
        limitStatus: 'allowed', has7dLimit: false,
      }, 'claude-ai');
      const noWeekly = validateCacheFile(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
      assert.strictEqual(noWeekly?.usageData.has7dLimit, false);
      assert.strictEqual(noWeekly?.version, 4, 'writes must always use the current version');

      await writeCache({
        utilization5h: 0.2, utilization7d: 0.4, resetIn5h: 900, resetIn7d: 86400,
        limitStatus: 'allowed', has7dLimit: true,
        billing: 'credits', planLevel: 'max',
        credits5h: { used: 269, total: 28000, remaining: 27730 },
      }, 'z-ai');
      const weekly = validateCacheFile(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
      assert.strictEqual(weekly?.usageData.has7dLimit, true);
      assert.strictEqual(weekly?.usageData.billing, 'credits');
      assert.strictEqual(weekly?.usageData.planLevel, 'max');
      assert.deepStrictEqual(weekly?.usageData.credits5h, { used: 269, total: 28000, remaining: 27730 });
    } finally {
      if (saved !== null) { fs.writeFileSync(cachePath, saved); }
      else { try { fs.unlinkSync(cachePath); } catch { /* ignore */ } }
    }
  });
});
