import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { classifyBaseUrl, readClaudeBaseUrl, detectProvider } from '../../data/apiClient';

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
