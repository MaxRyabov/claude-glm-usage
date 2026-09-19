import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fetchRateLimitData } from '../../data/apiClient';
import { AuthBackoff } from '../../data/authBackoff';

/**
 * The Anthropic header path had no test coverage at all before this change, while the change
 * itself touches shared ground (the cache schema, the webview). These tests pin the behaviour
 * that must NOT move.
 */
suite('Anthropic rate-limit headers', () => {
  // Read per test, not at module load: fetchRateLimitData takes its own Date.now() reading
  // internally, so a timestamp captured when the file was loaded drifts by however long the
  // suite takes to reach the assertion — about two seconds here, which is enough to fail.
  const nowSec = () => Math.floor(Date.now() / 1000);
  let credDir: string;
  let credPath: string;

  setup(async () => {
    // fetchRateLimitData reads credentials first, and the path guard confines it to ~/.claude.
    credDir = path.join(os.homedir(), '.claude', `test-anthropic-${process.pid}-${Date.now()}`);
    await fs.mkdir(credDir, { recursive: true });
    credPath = path.join(credDir, '.credentials.json');
    await fs.writeFile(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 },
    }));
  });

  teardown(async () => {
    try { await fs.rm(credDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const reply = (headers: Record<string, string>) => (async () => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as unknown as Response) as unknown as typeof fetch;

  test('parses the unified headers, reading resets as Unix seconds', async () => {
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-7d-utilization': '0.17',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 1800),
      'anthropic-ratelimit-unified-7d-reset': String(nowSec() + 172800),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    assert.ok(Math.abs(r.utilization5h - 0.42) < 1e-9);
    assert.ok(Math.abs(r.utilization7d - 0.17) < 1e-9);
    assert.ok(Math.abs(r.resetIn5h - 1800) <= 2, `resetIn5h: ${r.resetIn5h}`);
    assert.ok(Math.abs(r.resetIn7d - 172800) <= 2, `resetIn7d: ${r.resetIn7d}`);
    assert.strictEqual(r.has7dLimit, true);
    assert.strictEqual(r.limitStatus, 'allowed');
  });

  test('a denied status header wins over utilization', async () => {
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 60),
      'anthropic-ratelimit-unified-5h-status': 'denied',
    }));
    assert.strictEqual(r.limitStatus, 'denied');
  });

  test('a plan with no 7d header reports no weekly window', async () => {
    // Pro plans send no 7d headers at all; Max plans do.
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': '0.80',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 900),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    assert.strictEqual(r.has7dLimit, false);
    assert.strictEqual(r.utilization7d, 0);
    assert.strictEqual(r.resetIn7d, 0);
    // The warning still comes from the 5h window alone.
    assert.strictEqual(r.limitStatus, 'allowed_warning');
  });

  test('malformed header values clamp to zero instead of throwing', async () => {
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': 'not-a-number',
      'anthropic-ratelimit-unified-7d-utilization': '-3',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    assert.strictEqual(r.utilization5h, 0);
    assert.strictEqual(r.utilization7d, 0);
    assert.strictEqual(r.resetIn5h, 0);
  });

  test('the z.ai-only fields stay absent for Anthropic', async () => {
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 600),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    assert.strictEqual(r.billing, undefined);
    assert.strictEqual(r.planLevel, undefined);
    assert.strictEqual(r.credits5h, undefined);
    assert.strictEqual(r.credits7d, undefined);
  });
});

suite('Authentication backoff', () => {
  const TTL = 300;
  const T0 = 1_800_000_000_000;

  test('a recorded rejection suppresses the next poll', () => {
    const b = new AuthBackoff<string>();
    assert.strictEqual(b.isActive('z-ai', TTL, T0), false);
    b.record('z-ai', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 60_000), true);
  });

  test('suppression expires once the TTL has elapsed', () => {
    const b = new AuthBackoff<string>();
    b.record('z-ai', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + TTL * 1000), false);
    // Self-clearing, so a recovered key resumes polling rather than staying suppressed.
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 1), false);
  });

  test('suppression is per provider', () => {
    const b = new AuthBackoff<string>();
    b.record('z-ai', T0);
    assert.strictEqual(b.isActive('claude-ai', TTL, T0 + 1000), false);
  });

  test('a successful poll clears it', () => {
    const b = new AuthBackoff<string>();
    b.record('z-ai', T0);
    b.clear();
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 1000), false);
  });
});
