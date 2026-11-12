import * as assert from 'assert';
import * as fsp from 'fs/promises';
import * as os from 'os';
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
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('round-trips a snapshot, reviving Date fields', async () => {
    const snap: SnapshotInput = {
      usage: makeUsage(),
      projectCosts: [{
        projectName: 'demo', projectPath: '/tmp/demo', costToday: 1, cost7d: 2, cost30d: 3,
        creditsToday: 0.5, credits7d: 1.5, credits30d: 2.5,
        sessionCount: 4, lastActive: new Date('2026-01-02T00:00:00.000Z'),
      }],
      heatmap: { daily: [], hourly: [], generatedAt: new Date('2026-01-03T00:00:00.000Z') },
    };
    await writeSnapshot(snap, snapshotPath);

    const back = await readSnapshot(snapshotPath);
    assert.ok(back, 'snapshot should read back');
    assert.strictEqual(back!.usage.cost5h, 1.23);
    assert.ok(back!.usage.lastUpdated instanceof Date, 'lastUpdated revived to Date');
    assert.strictEqual(back!.usage.lastUpdated.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(back!.projectCosts.length, 1);
    assert.ok(back!.projectCosts[0].lastActive instanceof Date);
    assert.ok(back!.heatmap && back!.heatmap.generatedAt instanceof Date);
  });

  test('returns null for an invalid snapshot file', async () => {
    await fsp.writeFile(snapshotPath, JSON.stringify({ version: 999, garbage: true }), 'utf-8');
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
        projectName: 'demo', projectPath: '/tmp/demo', costToday: 1, cost7d: 2, cost30d: 3,
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
});
