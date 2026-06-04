import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { classifyBaseUrl, readClaudeBaseUrl, readClaudeEnvVar, readZaiToken, detectProvider, parseZaiQuota, fetchZaiQuota } from '../../data/apiClient';

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
      { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 22, nextResetTime: Date.now() + 5 * 86400_000 },
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
      { type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 22, nextResetTime: Date.now() + 5 * 86400_000 },
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
