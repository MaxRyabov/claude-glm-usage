import * as assert from 'assert';
import {
  pollFailureOutcome,
  idleDataSource,
  pollDecision,
  noPollOutcome,
  supersededByCache,
  activeNotice,
  showsRateData,
  actsOnRateData,
  snapshotDataSource,
  dashboardUsage,
  pauseSeconds,
  DataSource,
  RETRY_DELAY_SECONDS,
} from '../../data/pollOutcome';
import {
  AnthropicAuthError,
  AnthropicFormatError,
  AnthropicTokenExpiredError,
  CredentialsUnavailableError,
  ZaiAuthError,
  ZaiFormatError,
  ClaudeProvider,
} from '../../data/apiClient';
import { PollBackoff } from '../../data/authBackoff';

const CACHE_CASES = [
  { name: 'fresh cache', hasCache: true, cacheValid: true },
  { name: 'expired cache', hasCache: true, cacheValid: false },
  { name: 'no cache', hasCache: false, cacheValid: false },
];

suite('pollFailureOutcome', () => {
  const REASONS: { name: string; err: unknown }[] = [
    { name: 'Anthropic 401', err: new AnthropicAuthError(401) },
    { name: 'Anthropic 403', err: new AnthropicAuthError(403) },
    { name: 'z.ai refusal', err: new ZaiAuthError('refused') },
    { name: 'Anthropic format', err: new AnthropicFormatError('no headers') },
    { name: 'z.ai format', err: new ZaiFormatError('moved') },
    { name: 'expired token', err: new AnthropicTokenExpiredError('expired') },
    { name: 'no credentials', err: new CredentialsUnavailableError('none') },
    { name: '5xx', err: new Error('Anthropic API unavailable (HTTP 503)') },
    { name: 'thrown string', err: 'boom' },
  ];

  // The design's table (A6) as literals, one column per cache × cost combination. Nothing here
  // is computed, so a mistake shared by the implementation and a helper cannot hide.
  type Column = 'fresh+cost' | 'fresh' | 'expired+cost' | 'expired' | 'none+cost' | 'none';
  const EXPECTED: Record<'refusal' | 'unavailable' | 'other', Record<Column, DataSource>> = {
    refusal: {
      'fresh+cost': 'auth-rejected', 'fresh': 'auth-rejected',
      'expired+cost': 'auth-rejected', 'expired': 'auth-rejected',
      'none+cost': 'auth-rejected', 'none': 'auth-rejected',
    },
    unavailable: {
      'fresh+cost': 'cache', 'fresh': 'cache',
      'expired+cost': 'stale', 'expired': 'stale',
      'none+cost': 'local-only', 'none': 'no-credentials',
    },
    other: {
      'fresh+cost': 'cache', 'fresh': 'cache',
      'expired+cost': 'stale', 'expired': 'stale',
      'none+cost': 'local-only', 'none': 'no-data',
    },
  };
  const ROW: Record<string, keyof typeof EXPECTED> = {
    'Anthropic 401': 'refusal', 'Anthropic 403': 'refusal', 'z.ai refusal': 'refusal',
    'no credentials': 'unavailable',
    'Anthropic format': 'other', 'z.ai format': 'other', 'expired token': 'other',
    '5xx': 'other', 'thrown string': 'other',
  };
  const COLUMNS: { column: Column; hasCache: boolean; cacheValid: boolean; hasCostData: boolean }[] = [
    { column: 'fresh+cost', hasCache: true, cacheValid: true, hasCostData: true },
    { column: 'fresh', hasCache: true, cacheValid: true, hasCostData: false },
    { column: 'expired+cost', hasCache: true, cacheValid: false, hasCostData: true },
    { column: 'expired', hasCache: true, cacheValid: false, hasCostData: false },
    { column: 'none+cost', hasCache: false, cacheValid: false, hasCostData: true },
    { column: 'none', hasCache: false, cacheValid: false, hasCostData: false },
  ];

  for (const r of REASONS) {
    for (const c of COLUMNS) {
      test(`${r.name}, ${c.column}`, () => {
        const { column, ...ctx } = c;
        assert.strictEqual(pollFailureOutcome(r.err, ctx).dataSource, EXPECTED[ROW[r.name]][column]);
      });
    }
  }

  test('only a missing credential ever says "not logged in"', () => {
    let sawIt = false;
    for (const r of REASONS) {
      const out = pollFailureOutcome(r.err, { hasCache: false, cacheValid: false, hasCostData: false });
      if (out.dataSource === 'no-credentials') {
        sawIt = true;
        assert.strictEqual(r.name, 'no credentials', `${r.name} must not read as "not logged in"`);
      }
    }
    // Guard against a vacuous pass: the table must contain the one case that does say it.
    assert.ok(sawIt, 'the missing-credential case must produce no-credentials');
  });

  test('backoff, retry delay and notice per class', () => {
    const ctx = { hasCache: true, cacheValid: false, hasCostData: true };
    const o401 = pollFailureOutcome(new AnthropicAuthError(401), ctx);
    assert.deepStrictEqual([o401.backoff, o401.retryDelay, o401.notice, o401.rejectionStatus], ['credentials', false, null, 401]);
    const o403 = pollFailureOutcome(new AnthropicAuthError(403), ctx);
    assert.strictEqual(o403.rejectionStatus, 403);
    const zai = pollFailureOutcome(new ZaiAuthError('x'), ctx);
    assert.strictEqual(zai.backoff, 'credentials');
    assert.strictEqual(zai.rejectionStatus, undefined, 'z.ai refusals carry no Anthropic status');
    const fmt = pollFailureOutcome(new AnthropicFormatError('x'), ctx);
    assert.deepStrictEqual([fmt.backoff, fmt.retryDelay, fmt.notice], ['format', false, null]);
    const exp = pollFailureOutcome(new AnthropicTokenExpiredError('x'), ctx);
    assert.deepStrictEqual([exp.backoff, exp.retryDelay, exp.notice], [null, false, 'token-expired']);
    const none = pollFailureOutcome(new CredentialsUnavailableError('x'), ctx);
    assert.deepStrictEqual([none.backoff, none.retryDelay, none.notice], [null, false, null]);
    const net = pollFailureOutcome(new Error('ECONNRESET'), ctx);
    assert.deepStrictEqual([net.backoff, net.retryDelay, net.notice], [null, true, null]);
  });
});

suite('idleDataSource', () => {
  const PROVIDERS: ClaudeProvider[] = ['unknown', 'claude-ai', 'z-ai', 'aws-bedrock', 'api-key', 'custom-endpoint'];
  for (const p of PROVIDERS) {
    test(`${p} without cost`, () => {
      assert.strictEqual(idleDataSource(p, false), p === 'unknown' ? 'no-credentials' : 'no-data');
    });
    test(`${p} with cost`, () => {
      assert.strictEqual(idleDataSource(p, true), 'local-only');
    });
  }
});

suite('pollDecision', () => {
  const NOW = 1_800_000_000_000;
  const base = { force: false, pauseReason: null, retryableFailureAt: null, cache: 'valid' as const, now: NOW };

  test('a manual refresh polls through a pause and a retry delay', () => {
    assert.strictEqual(pollDecision({ ...base, force: true, pauseReason: 'credentials' }), 'poll');
    assert.strictEqual(pollDecision({ ...base, force: true, retryableFailureAt: NOW - 1000 }), 'poll');
  });

  test('an active pause skips even without a cache', () => {
    assert.strictEqual(pollDecision({ ...base, pauseReason: 'credentials', cache: 'none' }), 'skip');
    assert.strictEqual(pollDecision({ ...base, pauseReason: 'format', cache: 'none' }), 'skip');
  });

  test('a retryable failure waits five minutes, with or without a cache', () => {
    for (const cache of ['none', 'expired'] as const) {
      const justFailed = { ...base, cache, retryableFailureAt: NOW - (RETRY_DELAY_SECONDS * 1000 - 1) };
      assert.strictEqual(pollDecision(justFailed), 'skip', `${cache}: inside the delay`);
      const later = { ...base, cache, retryableFailureAt: NOW - RETRY_DELAY_SECONDS * 1000 };
      assert.strictEqual(pollDecision(later), cache === 'none' ? 'poll' : 'poll-if-jsonl-recent',
        `${cache}: after the delay`);
    }
  });

  test('a clock that stepped back does not hold the retry delay', () => {
    assert.strictEqual(pollDecision({ ...base, cache: 'none', retryableFailureAt: NOW + 60_000 }), 'poll');
  });

  test('the old rules otherwise', () => {
    assert.strictEqual(pollDecision({ ...base, cache: 'none' }), 'poll');
    assert.strictEqual(pollDecision({ ...base, cache: 'valid' }), 'skip');
    assert.strictEqual(pollDecision({ ...base, cache: 'expired' }), 'poll-if-jsonl-recent');
  });

  // The pause length comes from PollBackoff evaluated against pauseSeconds(ttl) — exactly how
  // DataManager.activePause wires them.
  test('a 60 s TTL does not shorten the pause below five minutes', () => {
    const b = new PollBackoff<string>();
    b.record('claude-ai', 'credentials', NOW);
    const at = (sec: number) => b.activeReason('claude-ai', pauseSeconds(60), NOW + sec * 1000);
    assert.strictEqual(at(61), 'credentials', 'still paused after one TTL of 60 s');
    assert.strictEqual(at(299), 'credentials');
    assert.strictEqual(at(300), null);
  });

  test('a TTL above five minutes is the pause length', () => {
    const b = new PollBackoff<string>();
    b.record('z-ai', 'format', NOW);
    const at = (sec: number) => b.activeReason('z-ai', pauseSeconds(900), NOW + sec * 1000);
    assert.strictEqual(at(899), 'format');
    assert.strictEqual(at(900), null);
  });
});

suite('noPollOutcome', () => {
  test('an active credential pause keeps the rejection, with or without a cache', () => {
    for (const c of CACHE_CASES) {
      assert.strictEqual(
        noPollOutcome({ ...c, hasCostData: true, pauseReason: 'credentials' }), 'auth-rejected', c.name);
    }
  });

  test('a format pause or no pause shows the cache or cost', () => {
    for (const pauseReason of ['format', null] as const) {
      assert.strictEqual(noPollOutcome({ hasCache: true, cacheValid: true, hasCostData: false, pauseReason }), 'cache');
      assert.strictEqual(noPollOutcome({ hasCache: true, cacheValid: false, hasCostData: false, pauseReason }), 'stale');
      assert.strictEqual(noPollOutcome({ hasCache: false, cacheValid: false, hasCostData: true, pauseReason }), 'local-only');
      assert.strictEqual(noPollOutcome({ hasCache: false, cacheValid: false, hasCostData: false, pauseReason }), 'no-data');
    }
  });
});

suite('failure superseded by another window', () => {
  const FAILED_AT = Date.parse('2026-09-22T10:00:00.000Z');

  test('a cache written after the failure supersedes it', () => {
    assert.strictEqual(supersededByCache('2026-09-22T10:00:01.000Z', FAILED_AT), true);
  });

  test('a cache written before the failure does not', () => {
    assert.strictEqual(supersededByCache('2026-09-22T09:59:59.000Z', FAILED_AT), false);
    assert.strictEqual(supersededByCache('2026-09-22T10:00:00.000Z', FAILED_AT), false);
  });

  test('no failure, no timestamp or a garbage timestamp supersedes nothing', () => {
    assert.strictEqual(supersededByCache('2026-09-22T11:00:00.000Z', null), false);
    assert.strictEqual(supersededByCache(undefined, FAILED_AT), false);
    assert.strictEqual(supersededByCache('not a date', FAILED_AT), false);
  });

  test('a notice belongs to the provider it was recorded for', () => {
    const stored = { provider: 'claude-ai' as ClaudeProvider, notice: 'token-expired' as const };
    assert.strictEqual(activeNotice(stored, 'claude-ai'), 'token-expired');
    assert.strictEqual(activeNotice(stored, 'z-ai'), null);
    assert.strictEqual(activeNotice(null, 'claude-ai'), null);
  });
});

suite('showsRateData and its consumers', () => {
  const SOURCES: DataSource[] = ['api', 'cache', 'stale', 'no-credentials', 'no-data', 'local-only', 'auth-rejected'];
  const LIVE = new Set<DataSource>(['api', 'cache', 'stale']);

  for (const provider of ['claude-ai', 'z-ai', 'aws-bedrock', 'unknown'] as ClaudeProvider[]) {
    for (const ds of SOURCES) {
      test(`${provider} / ${ds}`, () => {
        const want = (provider === 'claude-ai' || provider === 'z-ai') && LIVE.has(ds);
        assert.strictEqual(showsRateData(provider, ds), want);
      });
    }
  }

  test('acting needs current data: shown-but-stale is not enough', () => {
    for (const provider of ['claude-ai', 'z-ai'] as ClaudeProvider[]) {
      assert.strictEqual(actsOnRateData(provider, 'api'), true, `${provider} api`);
      assert.strictEqual(actsOnRateData(provider, 'cache'), true, `${provider} cache`);
      // Shown, but its reset times may be as old as a startup snapshot.
      assert.strictEqual(showsRateData(provider, 'stale'), true);
      assert.strictEqual(actsOnRateData(provider, 'stale'), false, `${provider} stale`);
      for (const ds of ['auth-rejected', 'local-only', 'no-data', 'no-credentials'] as DataSource[]) {
        assert.strictEqual(actsOnRateData(provider, ds), false, `${provider} ${ds}`);
      }
    }
    assert.strictEqual(actsOnRateData('aws-bedrock', 'api'), false);
  });

  test('a snapshot becomes stale only if it carried live data', () => {
    assert.strictEqual(snapshotDataSource({ providerType: 'claude-ai', dataSource: 'api' }), 'stale');
    assert.strictEqual(snapshotDataSource({ providerType: 'z-ai', dataSource: 'cache' }), 'stale');
    for (const ds of ['local-only', 'no-data', 'no-credentials', 'auth-rejected'] as DataSource[]) {
      assert.strictEqual(snapshotDataSource({ providerType: 'claude-ai', dataSource: ds }), ds);
    }
    // A cost-only provider's snapshot never had rate data, whatever it was labelled.
    assert.strictEqual(snapshotDataSource({ providerType: 'aws-bedrock', dataSource: 'local-only' }), 'local-only');
  });

  test('the dashboard payload carries the same decision', () => {
    for (const ds of SOURCES) {
      const u = dashboardUsage({ providerType: 'claude-ai' as ClaudeProvider, dataSource: ds, utilization5h: 0.9 });
      assert.strictEqual(u.showRateData, showsRateData('claude-ai', ds), ds);
      assert.strictEqual(u.utilization5h, 0.9, 'the rest of the payload passes through');
    }
  });
});
