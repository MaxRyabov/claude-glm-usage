import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadEntries, discoverFiles, getClaudeProjectsDir, __resetEntryCacheForTests } from '../../data/entryCache';

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const line = (rid: string, opts: { model?: string; ts?: string } = {}): string => JSON.stringify({
  type: 'assistant',
  timestamp: opts.ts ?? new Date().toISOString(),
  requestId: rid,
  message: { id: `m_${rid}`, model: opts.model ?? 'claude-sonnet-4-6', usage },
});

suite('EntryCache', () => {
  let file: string;
  let counter = 0;

  setup(() => {
    __resetEntryCacheForTests();
    file = path.join(os.tmpdir(), `entrycache-${Date.now()}-${counter++}.jsonl`);
  });
  teardown(async () => { try { await fs.unlink(file); } catch { /* ignore */ } });

  test('deduplicates lines sharing a requestId', async () => {
    await fs.writeFile(file, [line('r1'), line('r1'), line('r1'), line('r2')].join('\n') + '\n');
    const entries = await loadEntries([file]);
    assert.strictEqual(entries.length, 2, 'two unique requestIds');
  });

  test('parses the final line even without a trailing newline', async () => {
    await fs.writeFile(file, [line('r1'), line('r2')].join('\n'));  // no trailing \n
    const entries = await loadEntries([file]);
    assert.strictEqual(entries.length, 2, 'last unterminated (but valid JSON) line is counted');
  });

  test('incrementally picks up appended lines', async () => {
    await fs.writeFile(file, line('r1') + '\n');
    const first = await loadEntries([file]);
    assert.strictEqual(first.length, 1);

    await fs.appendFile(file, line('r2') + '\n');
    const second = await loadEntries([file]);
    assert.strictEqual(second.length, 2, 'append parsed incrementally');
    assert.strictEqual(first[0].timestamp, second[0].timestamp, 'original entry preserved');
  });

  test('does not double-count when an appended line repeats a requestId', async () => {
    await fs.writeFile(file, line('r1') + '\n');
    await loadEntries([file]);
    await fs.appendFile(file, line('r1') + '\n');   // same requestId again
    const entries = await loadEntries([file]);
    assert.strictEqual(entries.length, 1, 'dedup preserved across incremental merge');
  });

  test('serves unchanged files from cache (same entry objects)', async () => {
    await fs.writeFile(file, line('r1') + '\n');
    const a = await loadEntries([file]);
    const b = await loadEntries([file]);
    assert.strictEqual(a[0], b[0], 'cache hit returns the same parsed object (no re-parse)');
  });

  test('re-parses a truncated file from the start', async () => {
    await fs.writeFile(file, [line('r1'), line('r2')].join('\n') + '\n');
    const first = await loadEntries([file]);
    assert.strictEqual(first.length, 2);

    await fs.writeFile(file, line('r3') + '\n');   // smaller file → truncation/rotation
    const second = await loadEntries([file]);
    assert.strictEqual(second.length, 1, 'truncated file fully re-parsed');
  });

  test('evicts and returns nothing for a removed file', async () => {
    await fs.writeFile(file, line('r1') + '\n');
    assert.strictEqual((await loadEntries([file])).length, 1);
    await fs.unlink(file);
    assert.strictEqual((await loadEntries([file])).length, 0, 'missing file yields no entries');
  });
});

suite('EntryCache discovery', () => {
  // discoverFiles walks the real ~/.claude/projects tree; use a clearly-named temp project
  // subdir so we never touch real session files, and clean it up afterwards.
  const projectsDir = getClaudeProjectsDir();
  let projDir: string;

  setup(async () => {
    __resetEntryCacheForTests();
    await fs.mkdir(projectsDir, { recursive: true });
    projDir = path.join(projectsDir, `_entrycache-test-${Date.now()}-${process.pid}`);
    await fs.mkdir(projDir, { recursive: true });
  });
  teardown(async () => { try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('finds files and filters by the mtime window (rescan reuse)', async () => {
    const a = path.join(projDir, 'a.jsonl');
    const b = path.join(projDir, 'b.jsonl');
    await fs.writeFile(a, line('r1') + '\n');
    await fs.writeFile(b, line('r2') + '\n');
    // Age out `a` to two hours ago.
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(a, old, old);

    const all = await discoverFiles();
    assert.ok(all.some((p) => p.endsWith('a.jsonl')), 'unfiltered discovery includes a.jsonl');
    assert.ok(all.some((p) => p.endsWith('b.jsonl')), 'unfiltered discovery includes b.jsonl');

    // Second call reuses the cached walk and stat-filters to the last 30 minutes.
    const recent = await discoverFiles(Date.now() - 30 * 60 * 1000);
    assert.ok(recent.some((p) => p.endsWith('b.jsonl')), 'recent window keeps b.jsonl');
    assert.ok(!recent.some((p) => p.endsWith('a.jsonl')), 'recent window drops the 2h-old a.jsonl');
  });
});
