import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
// Direct module object (not the namespace wrapper TS emits for `import * as`): the
// default-path test stubs os.homedir on the real module so snapshotCache — which reads
// os.homedir() at call time — sees the stub, without touching process.env.
import osModule = require('os');
import * as path from 'path';
import { readSnapshot, writeSnapshot, SnapshotInput } from '../../data/snapshotCache';
import type { ClaudeUsageData } from '../../data/dataManager';

// Every test reads and writes an isolated temp file — never the production path under
// ~/.claude, which the user's running extension owns (both snapshotCache functions take
// an explicit filePath for exactly this reason).
let tmpDir: string;
let snapshotPath: string;

function makeUsage(): ClaudeUsageData {
  return {
    utilization5h: 0.5, utilization7d: 0.3, resetIn5h: 1800, resetIn7d: 86400,
    limitStatus: 'allowed', cost5h: 1.23, costDay: 4.56, cost7d: 7.89,
    localCredits5h: 2.5, localCreditsDay: 9.0, localCredits7d: 15.5,
    tokensIn5h: 100, tokensOut5h: 50, tokensCacheRead5h: 0, tokensCacheCreate5h: 0,
    has7dLimit: true, providerType: 'claude-ai',
    lastUpdated: new Date('2026-01-01T00:00:00.000Z'), cacheAge: 0, dataSource: 'api',
  };
}

suite('snapshotCache', () => {
  suiteSetup(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbcs-snapshot-'));
    snapshotPath = path.join(tmpDir, 'vscode-claude-status-snapshot.json');
  });
  suiteTeardown(async () => {
    // Guarded: if suiteSetup died before mkdtemp assigned tmpDir, an unguarded rm would
    // throw a TypeError here and mask the original setup failure.
    if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); }
  });

  test('round-trips a snapshot, reviving Date fields', async () => {
    const heatmap = {
      daily: [{ date: '2026-01-02', cost: 3.5, sessionCount: 6, tokensTotal: 12_000 }],
      hourly: [{ hour: 9, avgCost: 0.42, count: 8 }],
      generatedAt: new Date('2026-01-03T00:00:00.000Z'),
    };
    const snap: SnapshotInput = {
      usage: makeUsage(),
      projectCosts: [{
        projectName: 'demo', projectPath: path.join(tmpDir, 'demo'), costToday: 1, cost7d: 2, cost30d: 3,
        creditsToday: 0.5, credits7d: 1.5, credits30d: 2.5,
        sessionCount: 4, lastActive: new Date('2026-01-02T00:00:00.000Z'),
      }],
      heatmap,
    };
    await writeSnapshot(snap, snapshotPath);

    const back = await readSnapshot(snapshotPath);
    assert.ok(back, 'snapshot should read back');
    assert.strictEqual(back.usage.cost5h, 1.23);
    assert.ok(back.usage.lastUpdated instanceof Date, 'lastUpdated revived to Date');
    assert.strictEqual(back.usage.lastUpdated.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(back.projectCosts.length, 1);
    assert.ok(back.projectCosts[0].lastActive instanceof Date);
    assert.ok(back.heatmap, 'heatmap round-trips');
    assert.strictEqual(back.heatmap.generatedAt.toISOString(), '2026-01-03T00:00:00.000Z');
    // The heatmap body must survive serialization too, not just generatedAt.
    assert.deepStrictEqual(back.heatmap.daily, heatmap.daily);
    assert.deepStrictEqual(back.heatmap.hourly, heatmap.hourly);
  });

  test('returns null for an invalid snapshot file', async () => {
    await fsp.writeFile(snapshotPath, JSON.stringify({ version: 999, garbage: true }), 'utf-8');
    assert.strictEqual(await readSnapshot(snapshotPath), null);
  });

  test('returns null for a corrupt (unparseable) snapshot file', async () => {
    // Truncated/garbled content: JSON.parse itself throws, the read must still yield
    // null instead of propagating the exception.
    await fsp.writeFile(snapshotPath, '{ not json', 'utf-8');
    assert.strictEqual(await readSnapshot(snapshotPath), null);
  });

  test('fails closed when a required discriminator field is missing (schema drift)', async () => {
    const usage = makeUsage() as unknown as Record<string, unknown>;
    delete usage.providerType;   // simulate an older-schema snapshot
    const file = { version: 1, savedAt: new Date().toISOString(), usage, projectCosts: [], heatmap: null };
    await fsp.writeFile(snapshotPath, JSON.stringify(file), 'utf-8');
    assert.strictEqual(await readSnapshot(snapshotPath), null);
  });

  test('defaults missing localCredits* fields from an older snapshot', async () => {
    // A v1 snapshot written before PR #18 has no localCredits* — the fields must read
    // as 0, not undefined, or the z-ai forecast gets NaN spend5h before the first refresh.
    const usage = makeUsage() as unknown as Record<string, unknown>;
    delete usage.localCredits5h;
    delete usage.localCreditsDay;
    delete usage.localCredits7d;
    const file = { version: 1, savedAt: new Date().toISOString(), usage, projectCosts: [], heatmap: null };
    await fsp.writeFile(snapshotPath, JSON.stringify(file), 'utf-8');

    const back = await readSnapshot(snapshotPath);
    assert.ok(back, 'older snapshot still reads (defaults fill the gap)');
    assert.strictEqual(back.usage.localCredits5h, 0);
    assert.strictEqual(back.usage.localCreditsDay, 0);
    assert.strictEqual(back.usage.localCredits7d, 0);
  });

  test('defaults missing projectCost credit columns from an older snapshot', async () => {
    // Same gap-between-versions protection as localCredits*: a snapshot written before
    // the credit columns existed must not leak undefined into formatCredits.
    const file = {
      version: 1,
      savedAt: new Date().toISOString(),
      usage: makeUsage(),
      projectCosts: [{
        projectName: 'demo', projectPath: path.join(tmpDir, 'demo'), costToday: 1, cost7d: 2, cost30d: 3,
        sessionCount: 1, lastActive: '2026-01-02T00:00:00.000Z',
      }],
      heatmap: null,
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(file), 'utf-8');

    const back = await readSnapshot(snapshotPath);
    assert.ok(back);
    assert.strictEqual(back.projectCosts[0].creditsToday, 0);
    assert.strictEqual(back.projectCosts[0].credits7d, 0);
    assert.strictEqual(back.projectCosts[0].credits30d, 0);
  });

  test('strips the volatile peak and context fields before persisting', async () => {
    const usage = makeUsage();
    usage.peak = {
      active: true, windowStartMs: 1_762_000_000_000, windowEndMs: 1_762_014_400_000,
      windowStartLocal: '09:00', windowEndLocal: '13:00', tzLabel: 'UTC+3',
    };
    usage.context = {
      model: 'glm-4.6', windowTokens: 200_000, usedTokens: 76_000, fillRatio: 0.38, nearLimit: false,
    };
    await writeSnapshot({ usage, projectCosts: [], heatmap: null }, snapshotPath);

    const raw = JSON.parse(await fsp.readFile(snapshotPath, 'utf-8')) as Record<string, unknown>;
    const stored = raw.usage as Record<string, unknown>;
    assert.ok(!('peak' in stored), 'peak is per-refresh state and must not reach the disk');
    assert.ok(!('context' in stored), 'context is per-refresh state and must not reach the disk');
    assert.strictEqual(stored.localCredits5h, 2.5, 'the persisted credit windows survive the strip');

    const back = await readSnapshot(snapshotPath);
    assert.ok(back);
    assert.strictEqual(back.usage.peak, undefined);
    assert.strictEqual(back.usage.context, undefined);
  });

  test('an old-format file still carrying peak/context reads back without them', async () => {
    // writeSnapshot strips the volatile fields now, but a file written before the strip
    // landed must not resurrect a stale peak/context on read either.
    const usage = makeUsage() as unknown as Record<string, unknown>;
    usage.peak = { active: true, windowStartLocal: '09:00', windowEndLocal: '13:00' };
    usage.context = { model: 'glm-4.6', windowTokens: 200_000, usedTokens: 76_000 };
    const file = { version: 1, savedAt: new Date().toISOString(), usage, projectCosts: [], heatmap: null };
    await fsp.writeFile(snapshotPath, JSON.stringify(file), 'utf-8');

    const back = await readSnapshot(snapshotPath);
    assert.ok(back, 'the file is otherwise valid');
    assert.strictEqual(back.usage.peak, undefined, 'a stale peak never reaches consumers');
    assert.strictEqual(back.usage.context, undefined, 'a stale context never reaches consumers');
  });

  test('the default path resolves through os.homedir() — a redirected home round-trips', async () => {
    // The no-argument filePath must build on os.homedir()/.claude. os.homedir itself is
    // stubbed (not process.env): the module resolves the path at call time through
    // os.homedir(), so stubbing the function pins the actual contract without mutating
    // the process environment for every other suite in this process.
    const realHomedir = osModule.homedir;
    const home = path.join(tmpDir, 'redirected-home');
    const defaultPath = path.join(home, '.claude', 'vscode-claude-status-snapshot.json');
    osModule.homedir = () => home;
    try {
      // Fail fast BEFORE any write: if the stub did not take, the default-path calls
      // below would touch the real ~/.claude the user's running extension owns.
      assert.notStrictEqual(osModule.homedir(), realHomedir(), 'os.homedir stub must be active before default-path IO');
      assert.strictEqual(await readSnapshot(), null, 'no snapshot in an empty redirected home');
      await fsp.mkdir(path.dirname(defaultPath), { recursive: true });
      await writeSnapshot({ usage: makeUsage(), projectCosts: [], heatmap: null });
      await fsp.access(defaultPath);   // the default write landed in <home>/.claude
      const back = await readSnapshot();
      assert.ok(back, 'the default-path snapshot reads back');
      assert.strictEqual(back.usage.cost5h, 1.23);
    } finally {
      osModule.homedir = realHomedir;
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});
