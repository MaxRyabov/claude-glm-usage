import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteJson } from '../../data/atomicWrite';

suite('atomicWriteJson', () => {
  let file: string;
  let counter = 0;

  setup(() => { file = path.join(os.tmpdir(), `atomic-${Date.now()}-${counter++}.json`); });
  teardown(async () => { try { await fs.unlink(file); } catch { /* ignore */ } });

  test('writes JSON that reads back equal', async () => {
    const obj = { a: 1, b: 'two', c: [3, 4], nested: { d: true } };
    await atomicWriteJson(file, obj);
    const back = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.deepStrictEqual(back, obj);
  });

  test('overwrites an existing file atomically', async () => {
    await atomicWriteJson(file, { v: 1 });
    await atomicWriteJson(file, { v: 2 });
    const back = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.strictEqual(back.v, 2);
  });

  test('leaves no temp file behind', async () => {
    await atomicWriteJson(file, { ok: true });
    const dir = path.dirname(file);
    const base = path.basename(file);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith(`.${base}.tmp-`));
    assert.strictEqual(leftovers.length, 0, 'temp file should be renamed away');
  });

  test('applies the requested mode on POSIX', async function () {
    if (process.platform === 'win32') { this.skip(); return; }
    await atomicWriteJson(file, { secret: 1 }, 0o600);
    const { mode } = await fs.stat(file);
    assert.strictEqual(mode & 0o777, 0o600, `expected 0600, got ${(mode & 0o777).toString(8)}`);
  });
});
