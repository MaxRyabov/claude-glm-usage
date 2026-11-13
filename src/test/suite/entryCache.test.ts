import * as assert from 'assert';
import * as fs from 'fs/promises';
// Direct module objects (not the namespace wrappers TS emits for `import * as`): two
// tests stub fs.open / os.homedir on the real module so entryCache — which calls them
// through its own namespace imports — sees the stubs.
import fsModule = require('fs/promises');
import * as os from 'os';
import osModule = require('os');
import * as path from 'path';
import {
  loadEntries, discoverFiles, findActiveSession, getClaudeProjectsDir, isSafePath,
  loadPersistedCache, persistCache, __resetEntryCacheForTests,
} from '../../data/entryCache';
// Same direct-module pattern as fsModule/osModule: counting atomicWriteJson calls pins
// whether persistCache re-serializes, which the written content alone cannot show
// (a pointless rewrite produces identical bytes).
import atomicModule = require('../../data/atomicWrite');

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

  test('a failed tail read does not advance the cached stat — the tail is retried next tick', async () => {
    await fs.writeFile(file, line('r1') + '\n');
    await loadEntries([file]);
    await fs.appendFile(file, line('r2') + '\n');

    // Simulate one transient read failure: readSlice goes through fs.open. The stub is
    // module-level (no sinon in this project), restored in the finally right below.
    const realOpen = fsModule.open;
    let failNextOpen = true;
    fsModule.open = async (...args: Parameters<typeof fsModule.open>) => {
      if (failNextOpen) { failNextOpen = false; throw new Error('EACCES: simulated transient failure'); }
      return realOpen(...args);
    };
    try {
      await loadEntries([file]);   // incremental read throws — the old size must be kept
    } finally {
      fsModule.open = realOpen;
    }

    const entries = await loadEntries([file]);   // must NOT hit the unchanged-file cache
    assert.strictEqual(entries.length, 2, 'the unread tail is retried after a transient read failure');
  });

  test('a transient tail-read failure leaves the cache clean — no pointless rewrite', async () => {
    // Regression: dirty=true used to be set even when the incremental read threw, so a
    // repeatedly-failing file (e.g. locked by antivirus) re-serialized the multi-MB
    // persisted cache on every refresh tick for nothing.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'entrycache-dirty-'));
    const realHomedir = osModule.homedir;
    osModule.homedir = () => home;
    const realWrite = atomicModule.atomicWriteJson;
    let writes = 0;
    atomicModule.atomicWriteJson = async (...args: Parameters<typeof realWrite>): Promise<void> => {
      writes++;
      return realWrite(...args);
    };
    try {
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      await fs.writeFile(file, line('r1') + '\n');
      await loadEntries([file]);
      await persistCache(24 * HOUR);
      assert.strictEqual(writes, 1, 'first persist writes once');

      await fs.appendFile(file, line('r2') + '\n');
      const realOpen = fsModule.open;
      let failNextOpen = true;
      fsModule.open = async (...args: Parameters<typeof fsModule.open>) => {
        if (failNextOpen) { failNextOpen = false; throw new Error('EACCES: simulated transient failure'); }
        return realOpen(...args);
      };
      try {
        await loadEntries([file]);   // incremental read throws — nothing changed
      } finally {
        fsModule.open = realOpen;
      }
      await persistCache(24 * HOUR);
      assert.strictEqual(writes, 1, 'failed read must not re-serialize the cache');

      const entries = await loadEntries([file]);   // retry succeeds
      assert.strictEqual(entries.length, 2);
      await persistCache(24 * HOUR);
      assert.strictEqual(writes, 2, 'a successful retry persists exactly once more');
    } finally {
      atomicModule.atomicWriteJson = realWrite;
      osModule.homedir = realHomedir;
      await fs.rm(home, { recursive: true, force: true });
    }
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

  test('returns a defensive copy — mutating the result never empties the cached walk', async function () {
    this.timeout(20_000);
    await fs.writeFile(path.join(projDir, 'a.jsonl'), line('r1') + '\n');
    const first = await discoverFiles();
    assert.ok(first.some((p) => path.resolve(p) === path.resolve(path.join(projDir, 'a.jsonl'))));
    first.length = 0;   // a hostile caller destroys its own copy
    const second = await discoverFiles();
    assert.ok(second.length > 0, 'the cached walk survives the caller clearing its result');
    assert.ok(
      second.some((p) => path.resolve(p) === path.resolve(path.join(projDir, 'a.jsonl'))),
      'the file is still discovered after the caller mutated the first result',
    );
  });

  test('a symlinked projects root does not drop every file (root resolved via realpath)', async function () {
    // HOME → temp home whose .claude/projects is a symlink to a real dir. isSafePath
    // compares realpath'd file paths against the root, so the root must be realpath'd
    // too — a lexically resolved root would drop every file under the symlink and
    // silently stop all data loading.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'entrycache-realhome-'));
    const linkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'entrycache-linkhome-'));
    const target = path.join(realHome, 'projects-real', 'p1', 'a.jsonl');
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, line('r1') + '\n');
      await fs.mkdir(path.join(linkHome, '.claude'), { recursive: true });
      try {
        await fs.symlink(path.join(realHome, 'projects-real'), path.join(linkHome, '.claude', 'projects'), 'dir');
      } catch {
        this.skip();   // symlink privileges absent
        return;
      }
      const realHomedir = osModule.homedir;
      osModule.homedir = () => linkHome;
      try {
        // Fail fast if the stub did not take: proceeding would discover against the
        // real home instead of the temp one.
        assert.notStrictEqual(osModule.homedir(), realHomedir(), 'os.homedir stub must be active before discovery');
        const all = await discoverFiles();
        assert.ok(
          all.some((p) => path.resolve(p) === path.resolve(target)),
          'files under a symlinked projects root are discovered',
        );
      } finally {
        osModule.homedir = realHomedir;
      }
    } finally {
      await fs.rm(realHome, { recursive: true, force: true });
      await fs.rm(linkHome, { recursive: true, force: true });
    }
  });

  test('an allowedRoot failure is not cached — a projects dir appearing later behind a link still passes', async function () {
    // Regression: the first isSafePath call while ~/.claude/projects does not exist used
    // to pin the LEXICAL root for the whole session; with a linked $HOME every later
    // realpath'd file then failed the containment check until the extension host
    // restarted. Junctions (unlike symlinks) need no privileges on Windows.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'entrycache-realhome2-'));
    const linkHome = path.join(os.tmpdir(), `entrycache-linkhome2-${Date.now()}-${process.pid}`);
    try {
      await fs.symlink(realHome, linkHome, 'junction');
    } catch {
      await fs.rm(realHome, { recursive: true, force: true });
      this.skip();
      return;
    }
    const realHomedir = osModule.homedir;
    osModule.homedir = () => linkHome;
    try {
      // Phase 1: the projects dir does not exist yet — realpath throws, the lexical
      // fallback answers this call (and must not be remembered as the root).
      assert.strictEqual(isSafePath(path.join(linkHome, '.claude', 'projects', 'f.jsonl')), true);
      // Phase 2: the dir appears behind the link — a freshly realpath'd file must pass.
      const projectsReal = path.join(realHome, '.claude', 'projects');
      await fs.mkdir(projectsReal, { recursive: true });
      await fs.writeFile(path.join(projectsReal, 'f.jsonl'), line('r1') + '\n');
      const realFile = await fs.realpath(path.join(linkHome, '.claude', 'projects', 'f.jsonl'));
      assert.strictEqual(
        isSafePath(realFile),
        true,
        'a realpath’d file passes once the linked projects dir exists',
      );
    } finally {
      osModule.homedir = realHomedir;
      await fs.rm(realHome, { recursive: true, force: true });
      await fs.rm(linkHome, { recursive: true, force: true });   // the junction, never its target
    }
  });
});

suite('EntryCache persisted cache', () => {
  let home: string;
  let realHomedir: () => string;

  setup(async () => {
    __resetEntryCacheForTests();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'entrycache-persist-'));
    realHomedir = osModule.homedir;
    osModule.homedir = () => home;
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  });
  teardown(async () => {
    osModule.homedir = realHomedir;
    try { await fs.rm(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('an appended older turn does not shadow a newer persisted entry (last backfill)', async () => {
    // Regression: a persisted record predating the `last` field has last === undefined;
    // the first incremental parse used to scan only the appended range and lock in its
    // (possibly older — resumed sessions are not chronological) entry, so the newer
    // pre-existing entry could never win again in findActiveSession.
    const proj = path.join(home, '.claude', 'projects', 'p1');
    const file = path.join(proj, 's.jsonl');
    await fs.mkdir(proj, { recursive: true });
    const freshMs = Date.now() - HOUR;
    const staleMs = Date.now() - 3 * HOUR;
    const freshLine = line('r-fresh', { ts: new Date(freshMs).toISOString() });
    await fs.writeFile(file, freshLine + '\n');
    const prefixBytes = Buffer.byteLength(freshLine + '\n');
    await fs.appendFile(file, line('r-stale', { ts: new Date(staleMs).toISOString() }) + '\n');

    // Pre-`last`-era cache: knows the fresh prefix (offset/size/ids), no `last` field.
    // Keyed by the canonical (realpath'd) form — the same form the walk caches files
    // under, so the record is actually HIT (a lexical short-name key would miss and
    // silently re-parse the file from scratch, hiding the code path under test).
    const canonicalFile = await fs.realpath(file);
    await fs.writeFile(
      path.join(home, '.claude', 'vscode-claude-status-parsecache.json'),
      JSON.stringify({
        version: 1,
        files: {
          [canonicalFile]: {
            mtimeMs: 1,
            size: prefixBytes,
            offset: prefixBytes,
            entries: [{ timestamp: freshMs, model: 'claude-sonnet-4-6', usage }],
            ids: ['r-fresh'],
          },
        },
      }),
    );
    await loadPersistedCache();

    const active = await findActiveSession(proj, 6 * HOUR);
    assert.ok(active, 'fresh pre-existing turn is found');
    assert.strictEqual(
      active.timestamp,
      freshMs,
      'the appended older turn must not shadow the newer persisted entry',
    );
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

  test('a symlinked jsonl in the project dir joins the active-session scan (parity with the walk)', async function () {
    // The walk counts a symlinked session file in the aggregates (it resolves through
    // pushSafeFile); the active-session scan must not silently drop it — isFile() is
    // false for a symlink, so the filter has to mirror the walk's !isDirectory() shape.
    const otherDir = path.join(projectsDir, `_entrycache-linktarget-${Date.now()}-${process.pid}`);
    await fs.mkdir(otherDir, { recursive: true });
    try {
      const fresh = at(0.1);
      const mine = at(1);
      await fs.writeFile(path.join(otherDir, 'fresh.jsonl'), line('r-target', { ts: fresh.iso }) + '\n');
      await fs.writeFile(path.join(projDir, 's.jsonl'), line('r-mine', { ts: mine.iso }) + '\n');
      try {
        await fs.symlink(path.join(otherDir, 'fresh.jsonl'), path.join(projDir, 'link.jsonl'), 'file');
      } catch {
        this.skip();   // symlink privileges absent
        return;
      }
      const active = await findActiveSession(projDir);
      assert.ok(active, 'a symlinked file resolving inside the root counts');
      assert.strictEqual(active.timestamp, fresh.ms, 'the fresher symlinked turn wins, as in the walk');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('a symlinked project dir resolving outside the root is rejected before readdir', async function () {
    // The lexical probe would pass (the link name lives under projects/), letting
    // readdir list a foreign directory; worse, a *.jsonl symlink inside that directory
    // pointing back into another project would import that project's fresh turn. The
    // realpath gate stops both before any listing happens.
    const victimDir = path.join(os.tmpdir(), `entrycache-victimdir-${Date.now()}-${process.pid}`);
    const otherDir = path.join(projectsDir, `_entrycache-otherproj-${Date.now()}-${process.pid}`);
    const linkedProj = path.join(projectsDir, `_entrycache-linkedproj-${Date.now()}-${process.pid}`);
    await fs.mkdir(victimDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    try {
      const fresh = at(0.1);
      await fs.writeFile(path.join(otherDir, 'x.jsonl'), line('r-foreign', { ts: fresh.iso }) + '\n');
      try {
        await fs.symlink(path.join(otherDir, 'x.jsonl'), path.join(victimDir, 'fresh.jsonl'), 'file');
        await fs.symlink(victimDir, linkedProj, 'dir');
      } catch {
        this.skip();   // symlink privileges absent
        return;
      }
      assert.strictEqual(
        await findActiveSession(linkedProj),
        null,
        'a project dir resolving outside ~/.claude/projects yields nothing',
      );
    } finally {
      await fs.rm(victimDir, { recursive: true, force: true });
      await fs.rm(otherDir, { recursive: true, force: true });
      await fs.rm(linkedProj, { force: true });   // the link itself, never its target
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

  test('the walk result is sorted, not readdir/parallel-completion order', async () => {
    // 'Z' (0x5A) sorts before 'a' (0x61) by code point, while NTFS lists them
    // case-insensitively (a before Z): pinning the code-point order proves the explicit
    // sort — not the platform's directory order or task completion order — shapes it.
    await fs.writeFile(path.join(projDir, 'a.jsonl'), line('r1') + '\n');
    await fs.writeFile(path.join(projDir, 'Z.jsonl'), line('r2') + '\n');
    const realProj = await fs.realpath(projDir);
    const mine = (await discoverFiles()).filter((p) => p.startsWith(realProj + path.sep));
    assert.deepStrictEqual(mine, [path.join(realProj, 'Z.jsonl'), path.join(realProj, 'a.jsonl')]);
  });

  test('a symlinked subagent log resolving inside the root joins the walk (parity with top-level)', async function () {
    // The target sits one level deeper than the walk ever goes, so the symlink is the
    // only route to it: the test fails while subagents/ filters links via isFile()
    // (lstat-based, false for symlinks) although top-level symlinks count.
    const deepDir = path.join(path.dirname(subDir), 'deep');
    await fs.mkdir(deepDir, { recursive: true });
    const deep = path.join(deepDir, 'deep.jsonl');
    await fs.writeFile(deep, line('r-deep') + '\n');
    try {
      await fs.symlink(deep, path.join(subDir, 'link.jsonl'), 'file');
    } catch {
      this.skip();   // symlink privileges absent
      return;
    }
    const all = await discoverFiles();
    assert.ok(byReal(all, deep), 'a symlinked subagent log resolving inside the root is counted');
  });

  test('two lexical paths to one log (top-level file + symlink alias) are counted once', async function () {
    // Regression: without realpath dedup a top-level session file and a subagents/
    // symlink to it both entered the list, double-counting every entry in the sums.
    const session = path.join(projDir, '22222222-3333-4444-5555-666666666666.jsonl');
    await fs.writeFile(session, line('r-top') + '\n');
    try {
      await fs.symlink(session, path.join(subDir, 'alias.jsonl'), 'file');
    } catch {
      this.skip();   // symlink privileges absent
      return;
    }
    const all = await discoverFiles();
    const realSession = await fs.realpath(session);
    assert.strictEqual(
      all.filter((p) => p === realSession).length,
      1,
      'the realpath appears exactly once — symlink aliases are not double-counted',
    );
  });
});
