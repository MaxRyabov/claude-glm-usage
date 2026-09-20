import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  classifyBaseUrl, readClaudeBaseUrl, readClaudeEnvVar, readZaiToken, detectProvider,
  parseZaiQuota, fetchZaiQuota, readZaiEnvelopeFailure, ZaiAuthError,
} from '../../data/apiClient';

suite('Provider detection — custom endpoints (Z-2)', () => {
  const ENV_KEY = 'ANTHROPIC_BASE_URL';
  let savedEnv: string | undefined;

  setup(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  teardown(() => {
    if (savedEnv === undefined) { delete process.env[ENV_KEY]; }
    else { process.env[ENV_KEY] = savedEnv; }
  });

  suite('classifyBaseUrl', () => {
    test('z.ai host → z-ai', () => {
      assert.strictEqual(classifyBaseUrl('https://api.z.ai/api/anthropic'), 'z-ai');
    });
    test('other non-Anthropic host → custom-endpoint', () => {
      assert.strictEqual(classifyBaseUrl('https://api.moonshot.cn/anthropic'), 'custom-endpoint');
    });
    test('Anthropic host → null (use normal probing)', () => {
      assert.strictEqual(classifyBaseUrl('https://api.anthropic.com'), null);
    });
    test('null / unparseable → null', () => {
      assert.strictEqual(classifyBaseUrl(null), null);
      assert.strictEqual(classifyBaseUrl('not a url'), null);
    });
  });

  suite('readClaudeBaseUrl', () => {
    let tmpDir: string;

    setup(async () => {
      tmpDir = path.join(os.tmpdir(), `claude-settings-test-${Date.now()}-${Math.floor(performance.now())}`);
      await fs.mkdir(tmpDir, { recursive: true });
    });
    teardown(async () => { try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    test('process.env wins over files', async () => {
      process.env[ENV_KEY] = 'https://env.example.com';
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://file.example.com' } }));
      assert.strictEqual(await readClaudeBaseUrl(tmpDir), 'https://env.example.com');
    });

    test('reads ANTHROPIC_BASE_URL from settings.json', async () => {
      await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }));
      assert.strictEqual(await readClaudeBaseUrl(tmpDir), 'https://api.z.ai/api/anthropic');
    });

    test('falls back to settings.local.json', async () => {
      await fs.writeFile(path.join(tmpDir, 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }));
      assert.strictEqual(await readClaudeBaseUrl(tmpDir), 'https://api.z.ai/api/anthropic');
    });

    test('tolerates a malformed settings file', async () => {
      await fs.writeFile(path.join(tmpDir, 'settings.json'), '{ this is not json');
      assert.strictEqual(await readClaudeBaseUrl(tmpDir), null);
    });

    test('returns null when no base URL is configured', async () => {
      assert.strictEqual(await readClaudeBaseUrl(tmpDir), null);
    });
  });

  suite('detectProvider base-URL-first ordering', () => {
    // The regression guard: a z.ai base URL must win even though a stale claudeAiOauth
    // credentials file may exist on the machine. We drive this via the env path, which
    // readClaudeBaseUrl checks before any file or credential read.
    test('z.ai base URL → z-ai regardless of credentials', async () => {
      process.env[ENV_KEY] = 'https://api.z.ai/api/anthropic';
      assert.strictEqual(await detectProvider(), 'z-ai');
    });

    test('non-z.ai custom base URL → custom-endpoint', async () => {
      process.env[ENV_KEY] = 'https://api.moonshot.cn/anthropic';
      assert.strictEqual(await detectProvider(), 'custom-endpoint');
    });
  });
});

suite('z.ai quota', () => {
  const AUTH = 'ANTHROPIC_AUTH_TOKEN';
  const KEY = 'ANTHROPIC_API_KEY';
  let savedAuth: string | undefined;
  let savedKey: string | undefined;
  let tmpDir: string;

  setup(async () => {
    savedAuth = process.env[AUTH]; savedKey = process.env[KEY];
    delete process.env[AUTH]; delete process.env[KEY];
    tmpDir = path.join(os.tmpdir(), `claude-token-test-${Date.now()}-${Math.floor(performance.now())}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });
  teardown(async () => {
    savedAuth === undefined ? delete process.env[AUTH] : (process.env[AUTH] = savedAuth);
    savedKey === undefined ? delete process.env[KEY] : (process.env[KEY] = savedKey);
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Sample shaped like the real /api/monitor/usage/quota/limit response.
  const sample = {
    code: 200, success: true,
    data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 6,  nextResetTime: Date.now() + 2 * 3600_000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 22, nextResetTime: Date.now() + 5 * 86400_000 },
      { type: 'TIME_LIMIT',   unit: 5, number: 1, percentage: 45 },
    ] },
  };

  test('parseZaiQuota maps 5h and weekly token windows', () => {
    const r = parseZaiQuota(sample);
    assert.ok(Math.abs(r.utilization5h - 0.06) < 1e-9, `5h util: ${r.utilization5h}`);
    assert.ok(Math.abs(r.utilization7d - 0.22) < 1e-9, `7d util: ${r.utilization7d}`);
    assert.strictEqual(r.has7dLimit, true);
    assert.ok(r.resetIn5h > 0 && r.resetIn7d > r.resetIn5h);
    assert.strictEqual(r.limitStatus, 'allowed');
  });

  test('parseZaiQuota flags a warning at high utilization', () => {
    const hot = { code: 200, success: true, data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 90, nextResetTime: Date.now() + 3600_000 },
    ] } };
    assert.strictEqual(parseZaiQuota(hot).limitStatus, 'allowed_warning');
  });

  test('parseZaiQuota is safe on empty/garbage input', () => {
    const r = parseZaiQuota({});
    assert.strictEqual(r.utilization5h, 0);
    assert.strictEqual(r.has7dLimit, false);
  });

  test('parseZaiQuota falls back to window length when the 5h reset time is absent', () => {
    // z.ai often omits nextResetTime for the rolling 5-hour window. resetIn5h must
    // still be non-zero (≈ 5h) so the dashboard prediction chart can render.
    const noReset = { code: 200, success: true, data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 6 },               // no nextResetTime
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 22, nextResetTime: Date.now() + 5 * 86400_000 },
    ] } };
    const r = parseZaiQuota(noReset);
    assert.ok(Math.abs(r.utilization5h - 0.06) < 1e-9);
    assert.ok(Math.abs(r.resetIn5h - 5 * 3600) < 5, `expected ~18000s, got ${r.resetIn5h}`);
    assert.ok(r.resetIn7d > 0);
  });

  test('readZaiToken prefers AUTH_TOKEN then API_KEY from settings.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'k-key' } }));
    assert.strictEqual(await readZaiToken(tmpDir), 'k-key');
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'k-auth', ANTHROPIC_API_KEY: 'k-key' } }));
    assert.strictEqual(await readZaiToken(tmpDir), 'k-auth');
  });

  test('readClaudeEnvVar reads an arbitrary env key from settings.local.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'local-tok' } }));
    assert.strictEqual(await readClaudeEnvVar('ANTHROPIC_AUTH_TOKEN', tmpDir), 'local-tok');
  });

  test('fetchZaiQuota falls back to a raw token when Bearer is rejected', async () => {
    const okBody = JSON.stringify({ code: 200, success: true, data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: Date.now() + 3600_000 },
    ] } });
    const seen: string[] = [];
    const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      const auth = init.headers['Authorization'];
      seen.push(auth);
      if (auth.startsWith('Bearer ')) {
        return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => JSON.parse(okBody) } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await fetchZaiQuota('https://api.z.ai/api/anthropic', 'tok123', fakeFetch);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.deepStrictEqual(seen, ['Bearer tok123', 'tok123']);
  });

  test('fetchZaiQuota throws on a non-auth HTTP error without retrying', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    await assert.rejects(() => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fakeFetch));
    assert.strictEqual(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// Dual-format quota parsing. Fixtures below are the real payloads captured from two live
// accounts (a credit tariff and a token tariff) on 2026-09-18, trimmed of nothing.
// ---------------------------------------------------------------------------
suite('z.ai quota — tariff generations', () => {
  // A fixed clock. The pre-existing fixtures call Date.now() at module scope and the parser
  // called it again internally, so they relied on wall-clock slack; the positional tests below
  // sit exactly on the six-hour veto boundary and would flake on that.
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const D = 86_400_000;
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

  // --- new tariff, credit-based -------------------------------------------------
  const creditPayload = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
      level: 'max',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 16693, remaining: 11306, percentage: 59, nextResetTime: NOW + 3 * H },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 47691, remaining: 92308, percentage: 34, nextResetTime: NOW + 6 * D },
      ],
    },
  };

  test('credit tariff reports utilization instead of zero', () => {
    const r = parseZaiQuota(creditPayload, NOW);
    // The whole point: before this change CREDIT_LIMIT was filtered out by type and every
    // window on this tariff read 0%.
    assert.ok(Math.abs(r.utilization5h - 16693 / 28000) < 1e-9, `5h: ${r.utilization5h}`);
    assert.ok(Math.abs(r.utilization7d - 47691 / 140000) < 1e-9, `7d: ${r.utilization7d}`);
    assert.strictEqual(r.has7dLimit, true);
    assert.ok(near(r.resetIn5h, 3 * 3600), `resetIn5h: ${r.resetIn5h}`);
    assert.ok(near(r.resetIn7d, 6 * 86400), `resetIn7d: ${r.resetIn7d}`);
    assert.strictEqual(r.limitStatus, 'allowed');
  });

  test('credit tariff exposes amounts, billing and plan tier', () => {
    const r = parseZaiQuota(creditPayload, NOW);
    assert.strictEqual(r.billing, 'credits');
    assert.strictEqual(r.planLevel, 'max');
    assert.deepStrictEqual(r.credits5h, { used: 16693, total: 28000, remaining: 11306 });
    assert.deepStrictEqual(r.credits7d, { used: 47691, total: 140000, remaining: 92308 });
    // remaining is passed through, never recomputed: 28000 - 16693 is 11307, not 11306.
    assert.notStrictEqual(r.credits5h?.remaining, 28000 - 16693);
  });

  test('derived ratio refines the integer percentage', () => {
    const r = parseZaiQuota(creditPayload, NOW);
    // 16693/28000 is 59.62%, reported by the API as a flat 59. The notification ladder steps
    // at 90/92/94/96/98, so the integer would quantise the thresholds it drives.
    assert.ok(r.utilization5h > 0.596 && r.utilization5h < 0.597, `${r.utilization5h}`);
  });

  // --- old tariff, token-based --------------------------------------------------
  const tokenPayload = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
      level: 'max',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 }, // idle: no nextResetTime
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 100, nextResetTime: NOW + 3 * D },
        {
          type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 20, remaining: 3980,
          percentage: 1, nextResetTime: NOW + 20 * D,
          usageDetails: [{ modelCode: 'search-prime', usage: 13 }, { modelCode: 'web-reader', usage: 7 }],
        },
      ],
    },
  };

  test('token tariff parses, with a five-hour fallback for the idle window', () => {
    const r = parseZaiQuota(tokenPayload, NOW);
    assert.strictEqual(r.utilization5h, 0);
    assert.strictEqual(r.utilization7d, 1);
    assert.ok(near(r.resetIn5h, 5 * 3600), `resetIn5h: ${r.resetIn5h}`);
    assert.ok(near(r.resetIn7d, 3 * 86400), `resetIn7d: ${r.resetIn7d}`);
    assert.strictEqual(r.has7dLimit, true);
  });

  test('an exhausted window is denied, not merely a warning', () => {
    // Until now z.ai could never reach 'denied', so a spent quota looked like one at 76%.
    assert.strictEqual(parseZaiQuota(tokenPayload, NOW).limitStatus, 'denied');
    const high = { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 90 }] } };
    assert.strictEqual(parseZaiQuota(high, NOW).limitStatus, 'allowed_warning');
  });

  test('token tariff exposes billing but no amounts', () => {
    const r = parseZaiQuota(tokenPayload, NOW);
    assert.strictEqual(r.billing, 'tokens');
    assert.strictEqual(r.credits5h, undefined);
    assert.strictEqual(r.credits7d, undefined);
  });

  test('the MCP allowance never claims a quota window', () => {
    // The live token tariff leads with TIME_LIMIT, and the old unit map called unit 5
    // "minutes" when it means months.
    const payload = { data: { limits: [
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 99, nextResetTime: NOW + 10 * D },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7, nextResetTime: NOW + 4 * D },
    ] } };
    const r = parseZaiQuota(payload, NOW);
    assert.ok(Math.abs(r.utilization5h - 0.05) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.07) < 1e-9);
    assert.strictEqual(r.limitStatus, 'allowed');
  });
});

suite('z.ai quota — window identification', () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const D = 86_400_000;
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
  const legacy = (limits: unknown[]) => ({ data: { limits } });

  test('a payload with no unit is classified by array order', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 64, nextResetTime: NOW + 2 * H },
      { type: 'TOKENS_LIMIT', percentage: 100, nextResetTime: NOW + 2 * D },
      { type: 'TIME_LIMIT', percentage: 1, usage: 4000, currentValue: 15, remaining: 3985 },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.64) < 1e-9);
    assert.strictEqual(r.utilization7d, 1);
    // Before this change an absent `number` made the window length compute to 0, so the
    // weekly cap was never found and this read false. The assertion pins the fixed behaviour.
    assert.strictEqual(r.has7dLimit, true);
  });

  test('a weekly window resetting sooner keeps its position', () => {
    // Observed on a live account: an exhausted weekly cap reset 40 minutes BEFORE the 5-hour
    // window. Guards against any "soonest reset wins" refactor.
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: NOW + 2 * H },
      { type: 'TOKENS_LIMIT', percentage: 100, nextResetTime: NOW + 80 * 60_000 },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.30) < 1e-9, `5h: ${r.utilization5h}`);
    assert.strictEqual(r.utilization7d, 1);
  });

  test('a first candidate beyond the horizon is vetoed', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 90, nextResetTime: NOW + 3 * D },
      { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: NOW + H },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.90) < 1e-9);
  });

  test('when every candidate is vetoed, array order decides', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 12, nextResetTime: NOW + 3 * D },
      { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: NOW + 4 * D },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.12) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.44) < 1e-9);
  });

  test('two idle windows keep array order and get full horizons', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 12 },
      { type: 'TOKENS_LIMIT', percentage: 44 },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.12) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.44) < 1e-9);
    assert.ok(near(r.resetIn5h, 5 * 3600), `resetIn5h: ${r.resetIn5h}`);
    assert.ok(near(r.resetIn7d, 7 * 86400), `resetIn7d: ${r.resetIn7d}`);
  });

  test('a single window cap reports no weekly window', () => {
    const r = parseZaiQuota(legacy([{ type: 'TOKENS_LIMIT', percentage: 50, nextResetTime: NOW + H }]), NOW);
    assert.strictEqual(r.has7dLimit, false);
    assert.strictEqual(r.utilization7d, 0);
    assert.strictEqual(r.resetIn7d, 0);
  });

  test('a third window cap is ignored rather than replacing the weekly one', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: NOW + 2 * D },
      { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: NOW + 3 * D },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.20) < 1e-9);
  });

  test('a unit-named window is never handed out twice by the positional pass', () => {
    // Half-migrated payload: the 5-hour entry is named by unit but its reset sits beyond the
    // six-hour horizon (clock skew, or a longer `number`), so the positional pass would have
    // picked the unlabelled entry for the same slot — leaving both marked 5-hour and dropping
    // the weekly window without a trace.
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40, nextResetTime: NOW + 8 * H },
      { type: 'TOKENS_LIMIT', percentage: 88, nextResetTime: NOW + 2 * H },
    ]), NOW);
    assert.strictEqual(r.has7dLimit, true, 'the weekly window must survive');
    assert.ok(Math.abs(r.utilization5h - 0.40) < 1e-9, `5h: ${r.utilization5h}`);
    assert.ok(Math.abs(r.utilization7d - 0.88) < 1e-9, `7d: ${r.utilization7d}`);
  });

  test('the mirror case collapses neither slot', () => {
    // Weekly named by unit and listed first, with an unlabelled entry resetting sooner.
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 70, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: NOW + 2 * H },
    ]), NOW);
    assert.ok(Math.abs(r.utilization7d - 0.70) < 1e-9, `7d: ${r.utilization7d}`);
    assert.ok(Math.abs(r.utilization5h - 0.20) < 1e-9, `5h: ${r.utilization5h}`);
  });

  test('two entries claiming the same unit do not both take the slot', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 20, nextResetTime: NOW + H },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.strictEqual(r.has7dLimit, false, 'a duplicate 5h entry is not a weekly window');
  });

  test('unit wins per entry while order fills the gap', () => {
    // Proves there is no global format-version switch.
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: NOW + 4 * D },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.12) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.44) < 1e-9);
    assert.strictEqual(r.has7dLimit, true);
  });

  test('an undocumented unit code falls back to order, not to days', () => {
    const r = parseZaiQuota(legacy([
      { type: 'TOKENS_LIMIT', unit: 2, number: 1, percentage: 12, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', unit: 2, number: 7, percentage: 44, nextResetTime: NOW + 4 * D },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.12) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.44) < 1e-9);
    assert.ok(near(r.resetIn5h, 3600), `resetIn5h: ${r.resetIn5h}`);
  });

  test('a month-period window cap takes no slot', () => {
    const r = parseZaiQuota(legacy([
      { type: 'CREDIT_LIMIT', unit: 5, number: 1, percentage: 80, nextResetTime: NOW + 20 * D },
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 4, nextResetTime: NOW + H },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 9, nextResetTime: NOW + 4 * D },
    ]), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.04) < 1e-9, `5h: ${r.utilization5h}`);
    assert.ok(Math.abs(r.utilization7d - 0.09) < 1e-9, `7d: ${r.utilization7d}`);
  });
});

suite('z.ai quota — amounts, horizons and hostile input', () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const D = 86_400_000;
  const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
  const one = (entry: unknown) => ({ data: { limits: [entry] } });

  test('amounts without a percentage are used directly, not read as zero', () => {
    // The old default was `percentage ?? 0`, so a credit window with perfect amounts and no
    // percentage would compare against 0, fail the agreement check and report 0% used.
    const r = parseZaiQuota(one(
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 16693, nextResetTime: NOW + H },
    ), NOW);
    assert.ok(r.utilization5h > 0.596 && r.utilization5h < 0.597, `${r.utilization5h}`);
  });

  test('a disagreeing ratio falls back to the reported percentage', () => {
    const r = parseZaiQuota(one(
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 90, percentage: 20, nextResetTime: NOW + H },
    ), NOW);
    assert.ok(Math.abs(r.utilization5h - 0.20) < 1e-9, `${r.utilization5h}`);
  });

  test('amounts without a remaining value still expose used and total', () => {
    const r = parseZaiQuota(one(
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 3219, percentage: 11, nextResetTime: NOW + H },
    ), NOW);
    assert.deepStrictEqual(r.credits5h, { used: 3219, total: 28000 });
  });

  test('a percentage above 100 is clamped', () => {
    assert.strictEqual(parseZaiQuota(one({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 250 }), NOW).utilization5h, 1);
  });

  test('a reset time in the past falls back to the window length', () => {
    const r = parseZaiQuota(one({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5, nextResetTime: NOW - 60_000 }), NOW);
    assert.ok(near(r.resetIn5h, 5 * 3600), `${r.resetIn5h}`);
  });

  test('an absurdly distant reset time is ignored', () => {
    const r = parseZaiQuota(one({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5, nextResetTime: NOW + 500 * D }), NOW);
    assert.ok(near(r.resetIn5h, 5 * 3600), `${r.resetIn5h}`);
  });

  test('a weekly fallback is a week, not a day', () => {
    // The old unit map called unit 6 "days", so this horizon came out seven times too short.
    const r = parseZaiQuota({ data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: NOW + H },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 22 },
    ] } }, NOW);
    assert.ok(near(r.resetIn7d, 7 * 86400), `${r.resetIn7d}`);
  });

  test('hostile input yields zeros without throwing', () => {
    assert.doesNotThrow(() => {
      for (const bad of [null, undefined, 'nope', 42, [], { data: null }, { data: { limits: 'x' } },
        { data: { limits: [null, 42, {}, { type: 123 }] } }]) {
        const r = parseZaiQuota(bad, NOW);
        assert.strictEqual(r.utilization5h, 0);
        assert.strictEqual(r.has7dLimit, false);
      }
    });
  });

  test('an oversized limits array is bounded', () => {
    const many = Array.from({ length: 500 }, () => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 3 }));
    const r = parseZaiQuota({ data: { limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7, nextResetTime: NOW + H },
      ...many,
    ] } }, NOW);
    assert.ok(Math.abs(r.utilization5h - 0.07) < 1e-9);
    assert.strictEqual(r.has7dLimit, true);
  });

  test('an overlong plan level is dropped rather than stored', () => {
    const r = parseZaiQuota({ data: {
      level: 'x'.repeat(200),
      limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7 }],
    } }, NOW);
    assert.strictEqual(r.planLevel, undefined);
  });
});

suite('z.ai quota — envelope failures', () => {
  const okBody = { code: 200, success: true, data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: Date.now() + 3_600_000 },
  ] } };

  const reply = (body: unknown, ok = true, status = 200) => ({
    ok, status, json: async () => body,
  }) as unknown as Response;

  test('readZaiEnvelopeFailure maps the business codes', () => {
    assert.deepStrictEqual(readZaiEnvelopeFailure({ code: 1000, success: false, msg: 'Authentication Failed' }), { code: 1000, status: 401 });
    assert.deepStrictEqual(readZaiEnvelopeFailure({ code: 1001, success: false }), { code: 1001, status: 401 });
    assert.deepStrictEqual(readZaiEnvelopeFailure({ code: 401, success: false }), { code: 401, status: 401 });
    assert.deepStrictEqual(readZaiEnvelopeFailure({ code: 429, success: false }), { code: 429, status: 429 });
    assert.deepStrictEqual(readZaiEnvelopeFailure({ code: 500, success: false }), { code: 500, status: 502 });
  });

  test('only an explicit success:false is a failure', () => {
    assert.strictEqual(readZaiEnvelopeFailure({ code: 200, success: true, data: {} }), null);
    assert.strictEqual(readZaiEnvelopeFailure({ data: { limits: [] } }), null);
    assert.strictEqual(readZaiEnvelopeFailure(null), null);
    assert.strictEqual(readZaiEnvelopeFailure('x'), null);
  });

  test('an envelope refusal retries with the raw token', async () => {
    // This is the case the old code reported as a cheerful 0% used: the gateway answers a
    // rejected Bearer form with HTTP 200, so a status-gated retry never fired.
    const seen: string[] = [];
    const fake = (async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers['Authorization']);
      return init.headers['Authorization'].startsWith('Bearer ')
        ? reply({ code: 1001, success: false, msg: '…' })
        : reply(okBody);
    }) as unknown as typeof fetch;

    const r = await fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.deepStrictEqual(seen, ['Bearer t', 't']);
  });

  test('both forms refused throws a ZaiAuthError after two attempts', async () => {
    let calls = 0;
    // The fixture carries the real upstream `msg`, otherwise the negative check below would be
    // tautological: nothing could leak into the message because nothing was there to leak.
    const fake = (async () => {
      calls++;
      return reply({ code: 1000, success: false, msg: 'Authentication Failed' });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake),
      (e: Error) => e instanceof ZaiAuthError && !/Authentication Failed/.test(e.message),
    );
    assert.strictEqual(calls, 2);
  });

  test('a non-auth envelope failure throws without retrying', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return reply({ code: 500, success: false }); }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake),
      (e: Error) => !(e instanceof ZaiAuthError),
    );
    assert.strictEqual(calls, 1);
  });

  test('an auth failure followed by another class reports the latter', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return calls === 1 ? reply({ code: 1001, success: false }) : reply({ code: 500, success: false });
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake),
      // Not an auth error: backing off for a TTL would be wrong for a transient upstream fault.
      (e: Error) => !(e instanceof ZaiAuthError),
    );
    assert.strictEqual(calls, 2);
  });

  test('a 200 carrying no usable limits throws instead of reporting zero', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return reply({ code: 200, success: true, data: { limits: [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 3 }] } });
    }) as unknown as typeof fetch;
    await assert.rejects(() => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake));
    assert.strictEqual(calls, 1);
  });

  test('a body that is not JSON fails the request', async () => {
    const fake = (async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); },
    }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(() => fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake));
  });

  test('an HTTP 401 still triggers the raw-token retry', async () => {
    const seen: string[] = [];
    const fake = (async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers['Authorization']);
      return init.headers['Authorization'].startsWith('Bearer ')
        ? reply({}, false, 401)
        : reply(okBody);
    }) as unknown as typeof fetch;
    const r = await fetchZaiQuota('https://api.z.ai/api/anthropic', 't', fake);
    assert.ok(Math.abs(r.utilization5h - 0.10) < 1e-9);
    assert.deepStrictEqual(seen, ['Bearer t', 't']);
  });
});
