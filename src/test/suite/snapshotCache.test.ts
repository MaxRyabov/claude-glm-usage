import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readSnapshot, writeSnapshot, DashboardSnapshot } from '../../data/snapshotCache';
import type { ClaudeUsageData } from '../../data/dataManager';

const snapshotPath = path.join(os.homedir(), '.claude', 'vscode-claude-status-snapshot.json');

function makeUsage(): ClaudeUsageData {
  return {
    utilization5h: 0.5, utilization7d: 0.3, resetIn5h: 1800, resetIn7d: 86400,
    limitStatus: 'allowed', cost5h: 1.23, costDay: 4.56, cost7d: 7.89,
    tokensIn5h: 100, tokensOut5h: 50, tokensCacheRead5h: 0, tokensCacheCreate5h: 0,
    has7dLimit: true, providerType: 'claude-ai',
    lastUpdated: new Date('2026-01-01T00:00:00.000Z'), cacheAge: 0, dataSource: 'api',
  };
}

suite('snapshotCache', () => {
  // The snapshot file lives at the production path; back it up so tests never clobber it.
  let backup: string | null = null;
  const claudeDirExists = fs.existsSync(path.dirname(snapshotPath));

  suiteSetup(() => {
    if (!claudeDirExists) { return; }
    try { backup = fs.readFileSync(snapshotPath, 'utf-8'); } catch { backup = null; }
  });
  suiteTeardown(() => {
    if (!claudeDirExists) { return; }
    try {
      if (backup !== null) { fs.writeFileSync(snapshotPath, backup, { mode: 0o600 }); }
      else { fs.rmSync(snapshotPath, { force: true }); }
    } catch { /* ignore */ }
  });

  const maybe = claudeDirExists ? test : test.skip;

  maybe('round-trips a snapshot, reviving Date fields', async () => {
    const snap: DashboardSnapshot = {
      usage: makeUsage(),
      projectCosts: [{
        projectName: 'demo', projectPath: '/tmp/demo', costToday: 1, cost7d: 2, cost30d: 3,
        sessionCount: 4, lastActive: new Date('2026-01-02T00:00:00.000Z'),
      }],
      heatmap: { daily: [], hourly: [], generatedAt: new Date('2026-01-03T00:00:00.000Z') },
    };
    await writeSnapshot(snap);

    const back = await readSnapshot();
    assert.ok(back, 'snapshot should read back');
    assert.strictEqual(back!.usage.cost5h, 1.23);
    assert.ok(back!.usage.lastUpdated instanceof Date, 'lastUpdated revived to Date');
    assert.strictEqual(back!.usage.lastUpdated.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.strictEqual(back!.projectCosts.length, 1);
    assert.ok(back!.projectCosts[0].lastActive instanceof Date);
    assert.ok(back!.heatmap && back!.heatmap.generatedAt instanceof Date);
  });

  maybe('returns null for an invalid snapshot file', async () => {
    await fsp.writeFile(snapshotPath, JSON.stringify({ version: 999, garbage: true }), 'utf-8');
    assert.strictEqual(await readSnapshot(), null);
  });

  maybe('fails closed when a required discriminator field is missing (schema drift)', async () => {
    const usage = makeUsage() as unknown as Record<string, unknown>;
    delete usage.providerType;   // simulate an older-schema snapshot
    const file = { version: 1, savedAt: new Date().toISOString(), usage, projectCosts: [], heatmap: null };
    await fsp.writeFile(snapshotPath, JSON.stringify(file), 'utf-8');
    assert.strictEqual(await readSnapshot(), null);
  });
});
