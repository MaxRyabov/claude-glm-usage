import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadEntries, discoverFiles, findActiveSession, getClaudeProjectsDir, __resetEntryCacheForTests } from '../../data/entryCache';

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const line = (rid: string, opts: { model?: string; ts?: string } = {}): string => JSON.stringify({
  type: 'assistant',
  timestamp: opts.ts ?? new Date().toISOString(),
  requestId: rid,
  message: { id: `m_${rid}`, model: opts.model ?? 'claude-sonnet-4-6', usage },
});
const HOUR = 3600 * 1000;

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

  setup(async function () {
    // discoverFiles rescans the real (possibly large) ~/.claude/projects tree.
    this.timeout(20_000);
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

    // Compare full paths, not name endings: the walk covers the real ~/.claude/projects, where
    // any live session whose UUID ends in 'a' also ends with 'a.jsonl'.
    const all = await discoverFiles();
    assert.ok(all.some((p) => path.resolve(p) === path.resolve(a)), 'unfiltered discovery includes a.jsonl');
    assert.ok(all.some((p) => path.resolve(p) === path.resolve(b)), 'unfiltered discovery includes b.jsonl');

    // Second call reuses the cached walk and stat-filters to the last 30 minutes.
    const recent = await discoverFiles(Date.now() - 30 * 60 * 1000);
    assert.ok(recent.some((p) => path.resolve(p) === path.resolve(b)), 'recent window keeps b.jsonl');
    assert.ok(!recent.some((p) => path.resolve(p) === path.resolve(a)), 'recent window drops the 2h-old a.jsonl');
  });
});

suite('EntryCache findActiveSession', () => {
  const projectsDir = getClaudeProjectsDir();
  let projDir: string;
  // Freeze each timestamp once: recomputing Date.now() after the write races the clock.
  const at = (hoursAgo: number): { iso: string; ms: number } => {
    const ms = Date.now() - hoursAgo * HOUR;
    return { iso: new Date(ms).toISOString(), ms };
  };

  setup(async () => {
    __resetEntryCacheForTests();
    await fs.mkdir(projectsDir, { recursive: true });
    projDir = path.join(projectsDir, `_entrycache-test-${Date.now()}-${process.pid}`);
    await fs.mkdir(projDir, { recursive: true });
  });
  teardown(async () => { try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('the latest top-level session of the project wins', async () => {
    const old = at(2);
    const fresh = at(0.5);
    await fs.writeFile(path.join(projDir, 's-old.jsonl'), line('r1', { ts: old.iso }) + '\n');
    await fs.writeFile(path.join(projDir, 's-new.jsonl'), line('r2', { ts: fresh.iso }) + '\n');
    const active = await findActiveSession(projDir);
    assert.ok(active, 'fresh session expected');
    assert.strictEqual(active.timestamp, fresh.ms);
  });

  test('a staler session in another project never wins', async () => {
    const otherDir = path.join(projectsDir, `_entrycache-test-other-${Date.now()}-${process.pid}`);
    await fs.mkdir(otherDir, { recursive: true });
    try {
      // A much newer turn exists — but in a different project dir.
      const foreign = at(0.1);
      const mine = at(1);
      await fs.writeFile(path.join(otherDir, 'x.jsonl'), line('r-other', { ts: foreign.iso }) + '\n');
      await fs.writeFile(path.join(projDir, 's.jsonl'), line('r-mine', { ts: mine.iso }) + '\n');
      const active = await findActiveSession(projDir);
      assert.ok(active);
      assert.strictEqual(active.timestamp, mine.ms, 'the other project turn must not leak in');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('a session older than the freshness window is discarded', async () => {
    const stale = at(7);
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1', { ts: stale.iso }) + '\n');
    assert.strictEqual(await findActiveSession(projDir, 6 * HOUR), null, '7h-old last turn is stale');
  });

  test('a trailing synthetic record does not shadow the real last turn', async () => {
    const real = at(1);
    const synthetic = at(0.5);
    await fs.writeFile(
      path.join(projDir, 's.jsonl'),
      [line('r1', { ts: real.iso }), line('r2', { model: '<synthetic>', ts: synthetic.iso })].join('\n') + '\n',
    );
    const active = await findActiveSession(projDir);
    assert.ok(active);
    assert.strictEqual(active.timestamp, real.ms, 'synthetic tail is skipped');
  });

  test('a synthetic-only file yields null, then picks up a real turn appended later', async () => {
    const synthetic = at(0.5);
    const real = at(0.1);
    const file = path.join(projDir, 's.jsonl');
    await fs.writeFile(file, line('r1', { model: '<synthetic>', ts: synthetic.iso }) + '\n');
    assert.strictEqual(await findActiveSession(projDir), null, 'no non-synthetic turns yet');
    // Second call exercises the "scanned, none" sentinel — must stay null without rescan.
    assert.strictEqual(await findActiveSession(projDir), null);

    await fs.appendFile(file, line('r2', { ts: real.iso }) + '\n');
    const active = await findActiveSession(projDir);
    assert.ok(active, 'appended real turn is found after the synthetic-only state');
    assert.strictEqual(active.timestamp, real.ms);
  });

  test('a symlinked jsonl escaping the projects root is never read', async function () {
    // Requires symlink privileges (Developer Mode / not restricted) — skip where absent.
    const victimDir = path.join(os.tmpdir(), `entrycache-victim-${Date.now()}-${process.pid}`);
    await fs.mkdir(victimDir, { recursive: true });
    const victim = path.join(victimDir, 'victim.jsonl');
    const fresh = at(0.1);
    await fs.writeFile(victim, line('r-evil', { ts: fresh.iso }) + '\n');
    const link = path.join(projDir, 'link.jsonl');
    try {
      await fs.symlink(victim, link, 'file');
    } catch {
      await fs.rm(victimDir, { recursive: true, force: true });   // no leak on skip
      this.skip();
      return;
    }
    try {
      await fs.writeFile(path.join(projDir, 's.jsonl'), line('r-real', { ts: at(1).iso }) + '\n');
      const active = await findActiveSession(projDir);
      assert.ok(active);
      assert.notStrictEqual(active.timestamp, fresh.ms, 'symlinked file outside the root must be ignored');
    } finally {
      await fs.rm(victimDir, { recursive: true, force: true });
      await fs.rm(link, { force: true });
    }
  });

  test('a dir outside ~/.claude/projects is rejected defensively', async () => {
    const outside = path.join(os.tmpdir(), `entrycache-outside-${Date.now()}-${process.pid}`);
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.writeFile(path.join(outside, 's.jsonl'), line('r1') + '\n');
      assert.strictEqual(await findActiveSession(outside), null);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

suite('EntryCache subagents walk', () => {
  const projectsDir = getClaudeProjectsDir();
  let projDir: string;
  let subDir: string;
  const byReal = (list: string[], p: string): boolean =>
    list.some((x) => path.resolve(x) === path.resolve(p));

  setup(async function () {
    // discoverFiles rescans the real ~/.claude/projects tree (hundreds of files) whenever
    // a test mutates it — realpath on Windows alone can exceed the 2s default.
    this.timeout(20_000);
    __resetEntryCacheForTests();
    await fs.mkdir(projectsDir, { recursive: true });
    projDir = path.join(projectsDir, `_entrycache-test-${Date.now()}-${process.pid}`);
    subDir = path.join(projDir, '11111111-2222-3333-4444-555555555555', 'subagents');
    await fs.mkdir(subDir, { recursive: true });
  });
  teardown(async () => { try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('subagent files join the walk/aggregates but not sessions or findActiveSession', async () => {
    const session = path.join(projDir, '11111111-2222-3333-4444-555555555555.jsonl');
    const agent = path.join(subDir, 'agent-aaaaaaaaaaaaaaaa.jsonl');
    // Subagent turn is newer than the top-level one (timestamps frozen once).
    const topTs = Date.now() - HOUR;
    const subTs = Date.now();
    await fs.writeFile(session, line('r-top', { ts: new Date(topTs).toISOString() }) + '\n');
    await fs.writeFile(agent, line('r-sub', { ts: new Date(subTs).toISOString() }) + '\n');

    const all = await discoverFiles();
    assert.ok(byReal(all, session), 'top-level session file discovered');
    assert.ok(byReal(all, agent), 'subagent file discovered');

    const entries = await loadEntries(
      all.filter((p) => path.resolve(p) === path.resolve(session) || path.resolve(p) === path.resolve(agent)),
    );
    assert.strictEqual(entries.length, 2, 'both turns land in the shared aggregates');

    // Active session: only top-level files — the newer subagent turn must not win.
    const active = await findActiveSession(projDir);
    assert.ok(active);
    assert.strictEqual(active.timestamp, topTs);
  });

  test('a subagent file created after the first walk is discovered (dirSig includes subagents mtime)', async () => {
    const first = path.join(subDir, 'agent-first.jsonl');
    await fs.writeFile(first, line('r1') + '\n');
    let all = await discoverFiles();
    assert.ok(byReal(all, first));

    const second = path.join(subDir, 'agent-second.jsonl');
    await fs.writeFile(second, line('r2') + '\n');
    // Creating a file bumps the subagents dir mtime, but pin it explicitly so the test
    // never depends on filesystem timestamp granularity.
    const bump = new Date(Date.now() + 2_000);
    await fs.utimes(subDir, bump, bump);

    all = await discoverFiles();
    assert.ok(byReal(all, second), 'file created after the cached walk enters the aggregates');
  });

  test('deeper workflow logs (subagents/workflows/…) are not walked — no full recursion', async () => {
    const wfDir = path.join(subDir, 'workflows', 'wf_test');
    await fs.mkdir(wfDir, { recursive: true });
    const deep = path.join(wfDir, 'agent-deep.jsonl');
    await fs.writeFile(deep, line('r-deep') + '\n');

    const all = await discoverFiles();
    assert.ok(!byReal(all, deep), 'workflow-level agent files stay out of the walk');
  });

  test('a directory named like *.jsonl is not treated as a file', async () => {
    const weirdDir = path.join(projDir, 'weird.jsonl');   // directory, not a session file
    await fs.mkdir(weirdDir, { recursive: true });
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1') + '\n');

    const all = await discoverFiles();
    assert.ok(!byReal(all, weirdDir), 'a *.jsonl-named directory stays out of the file list');
    assert.ok(byReal(all, path.join(projDir, 's.jsonl')), 'real session file still discovered');
  });

  test('a directory named like *.jsonl inside subagents/ is not treated as a file', async () => {
    const weirdSub = path.join(subDir, 'not-a-file.jsonl');   // directory inside subagents/
    await fs.mkdir(weirdSub, { recursive: true });
    const agent = path.join(subDir, 'agent-ok.jsonl');
    await fs.writeFile(agent, line('r1') + '\n');

    const all = await discoverFiles();
    assert.ok(!byReal(all, weirdSub), 'a *.jsonl-named directory inside subagents/ stays out');
    assert.ok(byReal(all, agent), 'real subagent file still discovered');
  });

  test('a dangling *.jsonl symlink is dropped, not passed on the lexical path', async function () {
    // realpath of a dangling symlink rejects — the fail-closed branch of pushSafeFile.
    const dangling = path.join(projDir, 'dangling.jsonl');
    try {
      await fs.symlink(path.join(projDir, 'no-such-target.jsonl'), dangling, 'file');
    } catch {
      this.skip();   // symlink privileges absent
      return;
    }
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1') + '\n');

    const all = await discoverFiles();
    assert.ok(!byReal(all, dangling), 'dangling symlink must not enter the file list');
    assert.ok(byReal(all, path.join(projDir, 's.jsonl')), 'real session file still discovered');
  });
});
