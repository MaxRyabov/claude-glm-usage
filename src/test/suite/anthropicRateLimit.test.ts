import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  fetchRateLimitData,
  pickFreshestCredentials,
  plausibleExpiry,
  isTokenExpired,
  AnthropicAuthError,
  AnthropicFormatError,
  AnthropicTokenExpiredError,
  CredentialsUnavailableError,
  ZaiAuthError,
  ZaiFormatError,
  OAuthCredentials,
} from '../../data/apiClient';
import {
  PollBackoff,
  backoffReasonOf,
  CredentialRejectedError,
  QuotaFormatError,
} from '../../data/authBackoff';

/**
 * The Anthropic header path had no test coverage at all before this change, while the change
 * itself touches shared ground (the cache schema, the webview). These tests pin the behaviour
 * that must NOT move.
 */
/** Exactly what `setup` below creates — see the note on the sweep in `suiteSetup`. */
const FIXTURE_DIR = /^test-anthropic-(\d+)-\d+$/;

/** Whether the process that created a fixture directory is still running. */
function ownerIsAlive(dirName: string): boolean {
  const pid = Number(FIXTURE_DIR.exec(dirName)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) { return true; } // unreadable owner — do not touch it
  if (pid === process.pid) { return true; }
  try {
    process.kill(pid, 0); // signal 0 only probes; it does not terminate anything
    return true;
  } catch (err) {
    // Only ESRCH means "no such process". EPERM means the opposite — the process exists but we
    // may not signal it (another user, a sandbox that forbids kill) — and treating it as dead
    // would delete a live sibling run's fixture.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

suite('Anthropic rate-limit headers', () => {
  // Read per test, not at module load: fetchRateLimitData takes its own Date.now() reading
  // internally, so a timestamp captured when the file was loaded drifts by however long the
  // suite takes to reach the assertion — about two seconds here, which is enough to fail.
  const nowSec = () => Math.floor(Date.now() / 1000);
  let credDir: string;
  let credPath: string;

  // Sweep residue from runs that were killed between setup and teardown (CI timeout, crash).
  // The path guard in fetchRateLimitData confines credentials to ~/.claude, so the fixtures
  // cannot live in a temp sandbox — but they should not accumulate there either.
  //
  // This deletes inside the user's live config directory, so the match is the exact shape this
  // suite creates (`test-anthropic-<pid>-<epoch ms>`) rather than a prefix: a directory of
  // someone else's that merely started with `test-anthropic-` would otherwise be destroyed.
  // It must also contain nothing but our own fixture file before it is removed.
  suiteSetup(async () => {
    const claudeDir = path.join(os.homedir(), '.claude');
    let entries: string[] = [];
    try { entries = await fs.readdir(claudeDir); } catch { return; }
    for (const name of entries.filter(e => FIXTURE_DIR.test(e))) {
      const dir = path.join(claudeDir, name);
      // Residue means a run that is no longer running. A second copy of this suite on the same
      // machine — two CI jobs on one runner, two working trees — has a live fixture of exactly
      // this shape, and deleting it mid-run would make that run flake.
      if (ownerIsAlive(name)) { continue; }
      try {
        const contents = await fs.readdir(dir);
        if (contents.length > 1 || (contents.length === 1 && contents[0] !== '.credentials.json')) {
          continue; // not ours after all — leave it alone
        }
        await fs.rm(dir, { recursive: true, force: true });
      } catch { /* a directory we cannot inspect or remove is not worth failing the suite over */ }
    }
  });

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
    // The reset header carries garbage on purpose. Without it the resetIn5h assertion would be
    // vacuous — an absent header is 0 anyway — and it would miss the case that mattered:
    // parseInt returns NaN, Math.max(0, NaN) is NaN, and NaN reaches the cache as JSON null,
    // which the reader rejects, so every poll rewrote a file the next read threw away.
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': 'not-a-number',
      'anthropic-ratelimit-unified-7d-utilization': '-3',
      'anthropic-ratelimit-unified-5h-reset': 'garbage',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    assert.strictEqual(r.utilization5h, 0);
    assert.strictEqual(r.utilization7d, 0);
    assert.strictEqual(r.resetIn5h, 0);
    assert.ok(!Number.isNaN(r.resetIn5h), 'a garbage reset header must not yield NaN');
  });

  test('the z.ai-only fields stay absent for Anthropic', async () => {
    const r = await fetchRateLimitData(credPath, reply({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 600),
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    // Assert the fixture actually reached the parser first: without this, a typo in a header
    // name would leave every field undefined and the absence checks below would pass while
    // proving nothing.
    assert.strictEqual(r.utilization5h, 0.5, 'the fixture must have been parsed');
    assert.strictEqual(r.billing, undefined);
    assert.strictEqual(r.planLevel, undefined);
    assert.strictEqual(r.credits5h, undefined);
    assert.strictEqual(r.credits7d, undefined);
  });
});

suite('Poll backoff', () => {
  const TTL = 300;
  const T0 = 1_800_000_000_000;

  test('a recorded rejection suppresses the next poll', () => {
    const b = new PollBackoff<string>();
    assert.strictEqual(b.isActive('z-ai', TTL, T0), false);
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 60_000), true);
  });

  test('suppression expires once the TTL has elapsed', () => {
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + TTL * 1000), false);
    // And stays expired: a recovered key resumes polling rather than staying suppressed.
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + TTL * 2000), false);
  });

  test('suppression is per provider', () => {
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.isActive('claude-ai', TTL, T0 + 1000), false);
  });

  test('a successful poll clears it', () => {
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    b.clear();
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 1000), false);
  });

  test('a format drift suppresses polling without blaming the credential', () => {
    // A payload we cannot parse will not parse in sixty seconds either, so it backs off — but
    // it is not the user's key, and the interface must not say it is.
    const b = new PollBackoff<string>();
    b.record('z-ai', 'format', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 + 60_000), true);
    assert.strictEqual(b.activeReason('z-ai', TTL, T0 + 60_000), 'format');
  });

  test('reading an expired record does not destroy a live one', () => {
    // activeReason is a query, not a command. Clearing from inside the read made the answer
    // depend on who asked first: a caller passing a shorter ttl would wipe a suppression that
    // is still live for everyone else, bringing back the request storm.
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.isActive('z-ai', 0, T0 + 1), false, 'a zero ttl reads as expired');
    assert.strictEqual(b.activeReason('z-ai', TTL, T0 + 1000), 'credentials',
      'the record must survive being read with a shorter ttl');
  });

  test('a backwards clock step does not extend the suppression', () => {
    // NTP correction or a VM snapshot restore can put `now` before the recorded moment.
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.isActive('z-ai', TTL, T0 - 60_000), false);
  });

  test('the reason distinguishes the two classes', () => {
    const b = new PollBackoff<string>();
    b.record('z-ai', 'credentials', T0);
    assert.strictEqual(b.activeReason('z-ai', TTL, T0 + 1000), 'credentials');
    assert.strictEqual(b.activeReason('z-ai', TTL, T0 + TTL * 1000), null);
  });
});

suite('Failure classes', () => {
  test('each class maps to its backoff reason', () => {
    assert.strictEqual(backoffReasonOf(new ZaiAuthError('x')), 'credentials');
    assert.strictEqual(backoffReasonOf(new AnthropicAuthError(401)), 'credentials');
    assert.strictEqual(backoffReasonOf(new AnthropicAuthError(403)), 'credentials');
    assert.strictEqual(backoffReasonOf(new ZaiFormatError('x')), 'format');
    assert.strictEqual(backoffReasonOf(new AnthropicFormatError('x')), 'format');
  });

  test('failures that earn no backoff', () => {
    assert.strictEqual(backoffReasonOf(new AnthropicTokenExpiredError('x')), null);
    assert.strictEqual(backoffReasonOf(new CredentialsUnavailableError('x')), null);
    assert.strictEqual(backoffReasonOf(new Error('HTTP 503')), null);
    assert.strictEqual(backoffReasonOf('boom'), null);
    assert.strictEqual(backoffReasonOf(undefined), null);
  });

  test('provider classes keep their own identity', () => {
    // providerDetection.test.ts relies on `instanceof ZaiAuthError`; the shared base must not
    // blur which provider refused.
    assert.ok(new ZaiAuthError('x') instanceof CredentialRejectedError);
    assert.ok(!(new AnthropicAuthError(401) instanceof ZaiAuthError));
    assert.ok(new AnthropicFormatError('x') instanceof QuotaFormatError);
    assert.ok(!(new AnthropicFormatError('x') instanceof ZaiFormatError));
  });

  test('recordedAt reports the moment for the recorded provider only', () => {
    const b = new PollBackoff<string>();
    assert.strictEqual(b.recordedAt('claude-ai'), null);
    b.record('claude-ai', 'credentials', 1234);
    assert.strictEqual(b.recordedAt('claude-ai'), 1234);
    assert.strictEqual(b.recordedAt('z-ai'), null);
    b.clear();
    assert.strictEqual(b.recordedAt('claude-ai'), null);
  });
});

suite('Anthropic token expiry', () => {
  const NOW = 1_800_000_000_000;

  test('a believable epoch-ms expiry is kept', () => {
    assert.strictEqual(plausibleExpiry(NOW + 3_600_000, NOW), NOW + 3_600_000);
    assert.strictEqual(plausibleExpiry(NOW - 3_600_000, NOW), NOW - 3_600_000);
  });

  test('anything else counts as no expiry', () => {
    assert.strictEqual(plausibleExpiry(undefined, NOW), null);
    assert.strictEqual(plausibleExpiry(String(NOW + 1000), NOW), null, 'a string');
    assert.strictEqual(plausibleExpiry(Math.floor(NOW / 1000), NOW), null, 'seconds, not ms');
    assert.strictEqual(plausibleExpiry(NOW + 400 * 24 * 3600 * 1000, NOW), null, 'over a year ahead');
    assert.strictEqual(plausibleExpiry(Number.NaN, NOW), null);
  });

  test('the 60 s margin', () => {
    assert.strictEqual(isTokenExpired(NOW - 1, NOW), true);
    assert.strictEqual(isTokenExpired(NOW + 30_000, NOW), true, 'expiring within the margin');
    assert.strictEqual(isTokenExpired(NOW + 60_000, NOW), true, 'the boundary itself');
    assert.strictEqual(isTokenExpired(NOW + 120_000, NOW), false);
    // Seconds would read as long expired if believed; they must not stop polling.
    assert.strictEqual(isTokenExpired(Math.floor(NOW / 1000), NOW), false);
  });
});

suite('Keychain vs credentials file', () => {
  const NOW = 1_800_000_000_000;
  const expiredFile = { token: 'file-token', expiresAt: NOW - 1000, source: 'file' as const };
  const freshFile = { token: 'file-token', expiresAt: NOW + 3_600_000, source: 'file' as const };
  const darwinDefault = { platform: 'darwin' as NodeJS.Platform, isDefaultPath: true, now: NOW };

  function keychain(result: OAuthCredentials | Error) {
    let reads = 0;
    const read = async (): Promise<OAuthCredentials> => {
      reads++;
      if (result instanceof Error) { throw result; }
      return result;
    };
    return { read, reads: () => reads };
  }

  test('an expired file loses to a fresher Keychain entry on macOS', async () => {
    const k = keychain({ token: 'keychain-token', expiresAt: NOW + 3_600_000 });
    const picked = await pickFreshestCredentials(expiredFile, k.read, darwinDefault);
    assert.strictEqual(k.reads(), 1);
    assert.strictEqual(picked.token, 'keychain-token');
  });

  test('an unreadable Keychain falls back to the file', async () => {
    const k = keychain(new CredentialsUnavailableError('locked'));
    const picked = await pickFreshestCredentials(expiredFile, k.read, darwinDefault);
    assert.strictEqual(k.reads(), 1, 'the Keychain must actually have been tried');
    assert.strictEqual(picked.token, 'file-token');
  });

  test('an older Keychain entry does not replace the file', async () => {
    const k = keychain({ token: 'keychain-token', expiresAt: NOW - 3_600_000 });
    const picked = await pickFreshestCredentials(expiredFile, k.read, darwinDefault);
    assert.strictEqual(k.reads(), 1);
    assert.strictEqual(picked.token, 'file-token');
  });

  test('the Keychain is not read when it cannot help', async () => {
    const cases: [string, typeof expiredFile | typeof freshFile, { platform: NodeJS.Platform; isDefaultPath: boolean; now: number }][] = [
      ['fresh file', freshFile, darwinDefault],
      ['not macOS', expiredFile, { ...darwinDefault, platform: 'win32' }],
      ['path set by the user', expiredFile, { ...darwinDefault, isDefaultPath: false }],
      ['token already from the Keychain', { ...expiredFile, source: 'keychain' as const } as unknown as typeof expiredFile, darwinDefault],
    ];
    for (const [name, file, opts] of cases) {
      const k = keychain({ token: 'keychain-token', expiresAt: NOW + 3_600_000 });
      const picked = await pickFreshestCredentials(file, k.read, opts);
      assert.strictEqual(k.reads(), 0, name);
      assert.strictEqual(picked.token, 'file-token', name);
    }
  });
});

suite('Anthropic failure classification', () => {
  const TOKEN = 'test-token';
  const HEADERS = {
    'anthropic-ratelimit-unified-5h-utilization': '0.42',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 1800),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
  };
  let credDir: string;

  setup(async () => {
    // Same shape as the suite above, so its residue sweep covers these fixtures too.
    credDir = path.join(os.homedir(), '.claude', `test-anthropic-${process.pid}-${Date.now()}`);
    await fs.mkdir(credDir, { recursive: true });
  });

  teardown(async () => {
    try { await fs.rm(credDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function credentials(expiresAt: unknown = Date.now() + 3_600_000): Promise<string> {
    const p = path.join(credDir, '.credentials.json');
    await fs.writeFile(p, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt } }));
    return p;
  }

  /** A fetch stub that records every call and every body cancel. */
  function stub(status: number, headers: Record<string, string> = {}, cancel?: () => Promise<void>) {
    const auth: (string | null)[] = [];
    let cancels = 0;
    const impl = (async (_url: string, init?: RequestInit) => {
      auth.push((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? null);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        body: { cancel: () => { cancels++; return cancel ? cancel() : Promise.resolve(); } },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls: () => auth.length, auth, cancels: () => cancels };
  }

  /** Expect a rejection of a given class; returns the error for further checks. */
  async function rejection(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (err) {
      return err as Error;
    }
    assert.fail('expected the call to fail');
  }

  test('an expired token sends no request', async () => {
    const s = stub(200, HEADERS);
    const err = await rejection(fetchRateLimitData(await credentials(Date.now() - 1000), s.impl));
    assert.ok(err instanceof AnthropicTokenExpiredError, String(err));
    assert.strictEqual(s.calls(), 0);
  });

  test('a token expiring within the margin sends no request', async () => {
    const s = stub(200, HEADERS);
    const err = await rejection(fetchRateLimitData(await credentials(Date.now() + 30_000), s.impl));
    assert.ok(err instanceof AnthropicTokenExpiredError, String(err));
    assert.strictEqual(s.calls(), 0);
  });

  test('a token with time to spare is sent', async () => {
    const s = stub(200, HEADERS);
    const r = await fetchRateLimitData(await credentials(Date.now() + 120_000), s.impl);
    assert.strictEqual(s.calls(), 1);
    assert.ok(Math.abs(r.utilization5h - 0.42) < 1e-9);
  });

  test('an expiry we cannot believe does not stop the request', async () => {
    for (const expiresAt of [String(Date.now() + 3_600_000), Math.floor(Date.now() / 1000) - 10, undefined]) {
      const s = stub(200, HEADERS);
      await fetchRateLimitData(await credentials(expiresAt), s.impl);
      assert.strictEqual(s.calls(), 1, `expiresAt=${String(expiresAt)}`);
    }
  });

  for (const status of [401, 403] as const) {
    test(`${status} is a credential refusal`, async () => {
      const s = stub(status);
      const err = await rejection(fetchRateLimitData(await credentials(), s.impl));
      assert.strictEqual(s.calls(), 1);
      assert.ok(err instanceof AnthropicAuthError, String(err));
      assert.strictEqual((err as AnthropicAuthError).status, status);
      assert.ok(err.message.includes(`HTTP ${status}`), err.message);
    });

    test(`${status} wins over rate-limit headers`, async () => {
      const s = stub(status, HEADERS);
      const err = await rejection(fetchRateLimitData(await credentials(), s.impl));
      assert.strictEqual(s.calls(), 1);
      assert.ok(err instanceof AnthropicAuthError, String(err));
    });
  }

  for (const status of [500, 529]) {
    test(`${status} stays retryable`, async () => {
      const s = stub(status);
      const err = await rejection(fetchRateLimitData(await credentials(), s.impl));
      // The call count and the status in the message prove the failure came from the response,
      // not from reading credentials — which would also be a plain, retryable-looking Error.
      assert.strictEqual(s.calls(), 1);
      assert.ok(err.message.includes(`HTTP ${status}`), err.message);
      assert.strictEqual(backoffReasonOf(err), null);
      assert.ok(!(err instanceof CredentialsUnavailableError));
    });
  }

  const noHeaders: [number, Record<string, string>, string][] = [
    [200, {}, '200 without headers'],
    [200, { 'anthropic-ratelimit-unified-status': 'allowed' }, '200 with only a header the parser does not read'],
    [400, {}, '400 without headers'],
    [404, {}, '404 without headers'],
    [429, {}, '429 without headers'],
  ];
  for (const [status, headers, name] of noHeaders) {
    test(`${name} is a format drift, not "0% used"`, async () => {
      const s = stub(status, headers);
      const err = await rejection(fetchRateLimitData(await credentials(), s.impl));
      assert.strictEqual(s.calls(), 1);
      assert.ok(err instanceof AnthropicFormatError, String(err));
      assert.ok(err.message.includes(`HTTP ${status}`), err.message);
    });
  }

  test('429 with a denied status is still parsed as denied', async () => {
    const s = stub(429, { ...HEADERS, 'anthropic-ratelimit-unified-5h-status': 'denied' });
    const r = await fetchRateLimitData(await credentials(), s.impl);
    assert.strictEqual(s.calls(), 1);
    assert.strictEqual(r.limitStatus, 'denied');
  });

  test('no credentials file means credentials are unavailable', async () => {
    const s = stub(200, HEADERS);
    const err = await rejection(fetchRateLimitData(path.join(credDir, 'missing.json'), s.impl));
    assert.ok(err instanceof CredentialsUnavailableError, String(err));
    assert.strictEqual(s.calls(), 0);
  });

  test('a path outside ~/.claude means credentials are unavailable', async () => {
    const s = stub(200, HEADERS);
    const outside = path.join(os.tmpdir(), '.credentials.json');
    const err = await rejection(fetchRateLimitData(outside, s.impl));
    assert.ok(err instanceof CredentialsUnavailableError, String(err));
    assert.ok(/must be inside/.test(err.message), 'the cause stays findable in the message');
    assert.strictEqual(s.calls(), 0);
  });

  test('a credentials file caught mid-write is retryable, not "not logged in"', async () => {
    const p = path.join(credDir, '.credentials.json');
    await fs.writeFile(p, '{"claudeAiOauth": {"accessTo');
    const s = stub(200, HEADERS);
    const err = await rejection(fetchRateLimitData(p, s.impl));
    assert.strictEqual(s.calls(), 0);
    assert.ok(/not valid JSON/.test(err.message), err.message);
    assert.ok(!(err instanceof CredentialsUnavailableError));
    assert.strictEqual(backoffReasonOf(err), null);
  });

  test('a refusal message names the status, never the token', async () => {
    const s = stub(401);
    const err = await rejection(fetchRateLimitData(await credentials(), s.impl));
    // First prove the token was really sent: otherwise its absence below proves nothing.
    assert.deepStrictEqual(s.auth, [`Bearer ${TOKEN}`]);
    assert.ok(err.message.includes('401'), err.message);
    assert.ok(!err.message.includes(TOKEN), 'the token must not leak into the message');
  });

  test('the body is released on success and on failure', async () => {
    const ok = stub(200, HEADERS);
    await fetchRateLimitData(await credentials(), ok.impl);
    assert.strictEqual(ok.cancels(), 1, 'success');
    for (const status of [401, 503, 200]) {
      const s = stub(status, {});
      await rejection(fetchRateLimitData(await credentials(), s.impl));
      assert.strictEqual(s.cancels(), 1, `HTTP ${status}`);
    }
  });

  test('a body that refuses to cancel does not break the result', async () => {
    const rejecting = stub(200, HEADERS, () => Promise.reject(new Error('cancel failed')));
    const r1 = await fetchRateLimitData(await credentials(), rejecting.impl);
    assert.strictEqual(rejecting.cancels(), 1);
    assert.strictEqual(r1.limitStatus, 'allowed');
    const throwing = stub(200, HEADERS, () => { throw new Error('cancel threw'); });
    const r2 = await fetchRateLimitData(await credentials(), throwing.impl);
    assert.strictEqual(throwing.cancels(), 1);
    assert.strictEqual(r2.limitStatus, 'allowed');
  });
});
