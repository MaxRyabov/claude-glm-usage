import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { acquireApiPollLock, releaseApiPollLock } from '../../data/apiLock';

suite('apiLock', () => {
  let tmpDir: string;
  const lockFile = (): string => path.join(tmpDir, 'vscode-claude-status-api.lock');

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilock-test-'));
  });
  teardown(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('acquires when no lock exists and writes its pid', async () => {
    assert.strictEqual(await acquireApiPollLock(tmpDir), true);
    const owner = await fs.readFile(lockFile(), 'utf-8');
    assert.strictEqual(owner.trim(), String(process.pid));
  });

  test('refuses while a fresh lock from another process exists', async () => {
    await fs.writeFile(lockFile(), '99999', 'utf-8');
    assert.strictEqual(await acquireApiPollLock(tmpDir), false);
  });

  test('takes over a stale lock', async () => {
    await fs.writeFile(lockFile(), '99999', 'utf-8');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile(), past, past);
    assert.strictEqual(await acquireApiPollLock(tmpDir), true);
    const owner = await fs.readFile(lockFile(), 'utf-8');
    assert.strictEqual(owner.trim(), String(process.pid));
  });

  test('release removes only its own lock', async () => {
    assert.strictEqual(await acquireApiPollLock(tmpDir), true);
    await releaseApiPollLock(tmpDir);
    await assert.rejects(fs.stat(lockFile()), 'own lock should be removed');

    // A foreign lock must survive a release attempt.
    await fs.writeFile(lockFile(), '99999', 'utf-8');
    await releaseApiPollLock(tmpDir);
    const owner = await fs.readFile(lockFile(), 'utf-8');
    assert.strictEqual(owner.trim(), '99999');
  });

  test('acquire → release → acquire works repeatedly', async () => {
    assert.strictEqual(await acquireApiPollLock(tmpDir), true);
    await releaseApiPollLock(tmpDir);
    assert.strictEqual(await acquireApiPollLock(tmpDir), true);
    await releaseApiPollLock(tmpDir);
  });

  test('returns true when the lock directory does not exist (degrades to polling)', async () => {
    const missing = path.join(tmpDir, 'no-such-dir');
    assert.strictEqual(await acquireApiPollLock(missing), true);
  });
});
