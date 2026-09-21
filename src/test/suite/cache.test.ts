import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCacheValid, getCacheAge, validateCacheFile, writeCache, getCachePath } from '../../data/cache';

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
    assert.strictEqual(validateCacheFile({ ...(base({}) as object), version: 2 }), null);
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
    // Redirect the cache to a temp file for the duration: writing the user's real cache races
    // with their running extension, which rewrites it on a 60-second timer.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-status-cache-'));
    const previous = process.env['CLAUDE_STATUS_CACHE_PATH'];
    process.env['CLAUDE_STATUS_CACHE_PATH'] = path.join(tmpDir, 'cache.json');
    const cachePath = getCachePath();
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
      // Guarded: a failed cleanup must not mask a failed assertion.
      try {
        if (previous === undefined) { delete process.env['CLAUDE_STATUS_CACHE_PATH']; }
        else { process.env['CLAUDE_STATUS_CACHE_PATH'] = previous; }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup failures */ }
    }
  });
});

suite('Cache write-side guards', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-status-guard-'));
  const base = {
    utilization5h: 0.2, utilization7d: 0.4, resetIn5h: 900, resetIn7d: 86400,
    limitStatus: 'allowed' as const, has7dLimit: true,
  };

  async function writeAndRead(over: Record<string, unknown>): Promise<unknown> {
    const dir = tmp();
    const previous = process.env['CLAUDE_STATUS_CACHE_PATH'];
    process.env['CLAUDE_STATUS_CACHE_PATH'] = path.join(dir, 'cache.json');
    try {
      await writeCache({ ...base, ...over } as Parameters<typeof writeCache>[0], 'claude-ai');
      // Check the contract itself — the file is absent — rather than catching any exception as
      // "not written". A catch-all passed on unrelated failures too (the temp directory, the
      // disk), so the test could stay green while proving nothing about the guard.
      if (!fs.existsSync(getCachePath())) { return 'not-written'; }
      return validateCacheFile(JSON.parse(fs.readFileSync(getCachePath(), 'utf-8')));
    } finally {
      try {
        if (previous === undefined) { delete process.env['CLAUDE_STATUS_CACHE_PATH']; }
        else { process.env['CLAUDE_STATUS_CACHE_PATH'] = previous; }
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore cleanup failures */ }
    }
  }

  test('a record the reader would reject is never written', async () => {
    // A malformed upstream reset header used to reach here as NaN, serialise to JSON null and
    // be rejected on read — so every poll rewrote a file the next read discarded, and the
    // extension called the API on every tick instead of using its cache.
    assert.strictEqual(await writeAndRead({ resetIn5h: NaN }), 'not-written');
    assert.strictEqual(await writeAndRead({ utilization5h: 1.5 }), 'not-written');
    assert.strictEqual(await writeAndRead({ utilization7d: NaN }), 'not-written');
    assert.strictEqual(await writeAndRead({ limitStatus: 'nonsense' }), 'not-written');
  });

  test('a well-formed record still round-trips', async () => {
    const back = await writeAndRead({});
    assert.notStrictEqual(back, 'not-written', 'a valid record must still be written');
    assert.ok(back, 'and must validate on read');
  });

  test('an invalid optional field is dropped, not the whole record', async () => {
    // Sanitised before the gate, so one bad optional value costs that field only — the core
    // utilization survives rather than the extension losing its cache entirely.
    const back = await writeAndRead({ billing: 'bitcoin', planLevel: 'x'.repeat(200) }) as
      { usageData: { billing?: string, planLevel?: string, utilization5h: number } } | 'not-written';
    assert.notStrictEqual(back, 'not-written', 'the record must still be written');
    if (back === 'not-written') { return; }
    assert.strictEqual(back.usageData.billing, undefined);
    assert.strictEqual(back.usageData.planLevel, undefined);
    assert.strictEqual(back.usageData.utilization5h, 0.2);
  });

  test('a record with an empty provider is never written', async () => {
    const dir = tmp();
    const previous = process.env['CLAUDE_STATUS_CACHE_PATH'];
    process.env['CLAUDE_STATUS_CACHE_PATH'] = path.join(dir, 'cache.json');
    try {
      await writeCache(base as Parameters<typeof writeCache>[0], '');
      assert.strictEqual(fs.existsSync(getCachePath()), false, 'the reader rejects an empty provider');
    } finally {
      if (previous === undefined) { delete process.env['CLAUDE_STATUS_CACHE_PATH']; }
      else { process.env['CLAUDE_STATUS_CACHE_PATH'] = previous; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('amounts where used exceeds total are rejected', () => {
    const nowSec = Date.now() / 1000;
    const record = (credits5h: unknown) => ({
      version: 4, updatedAt: new Date().toISOString(), providerType: 'z-ai',
      usageData: { ...base, reset5hAt: nowSec + 900, reset7dAt: nowSec + 86400, credits5h },
    });
    assert.strictEqual(validateCacheFile(record({ used: 28000, total: 16693 })), null);
    assert.strictEqual(validateCacheFile(record({ used: 10, total: 100, remaining: 500 })), null);
    assert.ok(validateCacheFile(record({ used: 16693, total: 28000, remaining: 11306 })));
  });

  test('a record dated in the future is rejected', () => {
    // Otherwise isCacheValid sees a negative age and treats the record as fresh forever.
    const nowSec = Date.now() / 1000;
    const at = (offsetMs: number) => ({
      version: 4, updatedAt: new Date(Date.now() + offsetMs).toISOString(), providerType: 'z-ai',
      usageData: { ...base, reset5hAt: nowSec + 900, reset7dAt: nowSec + 86400 },
    });
    assert.strictEqual(validateCacheFile(at(24 * 3_600_000)), null, 'a day ahead is corrupt');
    assert.ok(validateCacheFile(at(60_000)), 'a minute of clock skew is tolerated');
  });

  test('a negative remaining amount is rejected', () => {
    const nowSec = Date.now() / 1000;
    const record = {
      version: 4, updatedAt: new Date().toISOString(), providerType: 'z-ai',
      usageData: {
        ...base, reset5hAt: nowSec + 900, reset7dAt: nowSec + 86400,
        credits5h: { used: 10, total: 100, remaining: -100 },
      },
    };
    assert.strictEqual(validateCacheFile(record), null);
  });
});
