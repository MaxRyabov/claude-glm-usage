import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fetchRateLimitData } from '../../data/apiClient';
import { PollBackoff } from '../../data/authBackoff';

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
