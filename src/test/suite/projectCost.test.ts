import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { workspacePathToHash, getProjectCostForDir } from '../../data/projectCost';
import { isPeakAt } from '../../data/peakHours';

suite('ProjectCost', () => {
  suite('getProjectCostForDir deduplication + per-model pricing', () => {
    let dir: string;
    setup(async () => {
      dir = path.join(os.tmpdir(), `projcost-test-${Date.now()}-${Math.floor(performance.now())}`);
      await fs.mkdir(dir, { recursive: true });
    });
    teardown(async () => { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    test('counts each requestId once and prices by model', async () => {
      const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const line = (rid: string, uuid: string, model: string) => JSON.stringify({
        type: 'assistant', uuid, timestamp: new Date().toISOString(), requestId: rid,
        message: { id: `m_${rid}`, model, usage },
      });
      // Same request streamed as 3 duplicate lines, plus a second distinct request.
      await fs.writeFile(path.join(dir, 'session.jsonl'), [
        line('r1', 'a', 'glm-4.6'), line('r1', 'b', 'glm-4.6'), line('r1', 'c', 'glm-4.6'),
        line('r2', 'd', 'glm-4.6'),
      ].join('\n'));

      const result = await getProjectCostForDir(dir, 'demo');
      // 2 unique requests × 1M input × $0.60/M (glm-4.6) = $1.20 — NOT 4 × $0.60.
      assert.ok(Math.abs(result.cost30d - 1.20) < 1e-9, `expected $1.20, got ${result.cost30d}`);
    });
  });

  suite('getProjectCostForDir credits', () => {
    let dir: string;
    setup(async () => {
      dir = path.join(os.tmpdir(), `projcost-credits-${Date.now()}-${Math.floor(performance.now())}`);
      await fs.mkdir(dir, { recursive: true });
    });
    teardown(async () => { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    test('credits follow the same windows as USD; claude turns are not billed', async () => {
      const HOUR = 3600 * 1000;
      // 100k in + 200k cache_read + 50k out = 223 § at peak, 111.5 § off-peak
      // (cache_creation of 999_999 must not move the number). Only the peak factor comes
      // from isPeakAt — the multiplier math is the manual recalculation the spec asks for.
      const usage = {
        input_tokens: 100_000,
        output_tokens: 50_000,
        cache_read_input_tokens: 200_000,
        cache_creation_input_tokens: 999_999,
      };
      const manual = (ts: number): number =>
        (100_000 * 6.9 + 200_000 * 1.7 + 50_000 * 24) / 10_000 * (isPeakAt(ts) ? 1 : 0.5);

      const now = Date.now();
      const line = (rid: string, model: string, ts: number) => JSON.stringify({
        type: 'assistant', uuid: `${rid}-u`, timestamp: new Date(ts).toISOString(), requestId: rid,
        message: { id: `m_${rid}`, model, usage },
      });
      // now / 30h ago (before any local midnight) / a claude turn now that must not bill.
      await fs.writeFile(path.join(dir, 'session.jsonl'), [
        line('r-now', 'glm-4.6', now),
        line('r-30h', 'glm-4.6', now - 30 * HOUR),
        line('r-claude', 'claude-sonnet-5-5', now),
      ].join('\n'));

      // One frozen clock for the fixtures, the manual recalc and the aggregation —
      // rules out the local-midnight race between manual() and the internal todayStart.
      const result = await getProjectCostForDir(dir, 'demo', {}, now);
      const nowCredits = manual(now);
      const oldCredits = manual(now - 30 * HOUR);

      assert.ok(Math.abs(result.creditsToday - nowCredits) < 1e-9,
        `creditsToday: only the current GLM turn (${nowCredits}), got ${result.creditsToday}`);
      assert.ok(Math.abs(result.credits7d - (nowCredits + oldCredits)) < 1e-9,
        `credits7d: both GLM turns, got ${result.credits7d}`);
      assert.ok(Math.abs(result.credits30d - (nowCredits + oldCredits)) < 1e-9,
        `credits30d: both GLM turns, got ${result.credits30d}`);

      // Same two GLM turns without the claude record: the USD delta is exactly the
      // claude turn's cost by the sonnet table ($3/$15/$0.30/$3.75 per 1M) — proving it
      // is priced in dollars while earning no credits. A bare `>` would pass even with
      // wrong sonnet rates; the exact delta catches a pricing regression.
      const claudeCost = (100_000 * 3 + 200_000 * 0.30 + 50_000 * 15 + 999_999 * 3.75) / 1e6;
      const soloDir = path.join(os.tmpdir(), `projcost-solo-${Date.now()}-${Math.floor(performance.now())}`);
      await fs.mkdir(soloDir, { recursive: true });
      try {
        await fs.writeFile(path.join(soloDir, 'session.jsonl'), [
          line('r-now', 'glm-4.6', now),
          line('r-30h', 'glm-4.6', now - 30 * HOUR),
        ].join('\n'));
        const solo = await getProjectCostForDir(soloDir, 'solo', {}, now);
        assert.ok(Math.abs((result.costToday - solo.costToday) - claudeCost) < 1e-9,
          `USD delta must be the claude turn's cost (${claudeCost}), got ${result.costToday - solo.costToday}`);
      } finally {
        await fs.rm(soloDir, { recursive: true, force: true });
      }
    });

    test('the peak factor follows each record timestamp, not the current moment', async () => {
      // Two fixed moments on deliberately different peak statuses: the last past
      // Tuesday 07:30 UTC (inside the window) and the last past Sunday 12:00 UTC
      // (outside). Both are guaranteed < 7d old, so the 7d aggregate must equal
      // base × 1 + base × 0.5 with the factors written out by hand.
      const lastUtcMoment = (dow: number, hh: number, mm: number): number => {
        const d = new Date();
        d.setUTCHours(hh, mm, 0, 0);
        let back = (d.getUTCDay() - dow + 7) % 7;
        if (back === 0 && d.getTime() > Date.now()) { back = 7; }
        d.setUTCDate(d.getUTCDate() - back);
        return d.getTime();
      };
      const peakTs = lastUtcMoment(2, 7, 30);    // Tuesday, inside 06:00–10:00 UTC
      const offTs = lastUtcMoment(0, 12, 0);     // Sunday, always off-peak
      assert.ok(Date.now() - peakTs < 7 * 24 * 3600 * 1000, 'helper stays inside the 7d window');
      assert.ok(Date.now() - offTs < 7 * 24 * 3600 * 1000, 'helper stays inside the 7d window');
      // Pin the classification itself: if these ever fail, it is the peak window that
      // changed, not the credit arithmetic below.
      assert.strictEqual(isPeakAt(peakTs), true, 'fixture: Tuesday 07:30 UTC is peak');
      assert.strictEqual(isPeakAt(offTs), false, 'fixture: Sunday 12:00 UTC is off-peak');

      const usage = {
        input_tokens: 100_000, output_tokens: 50_000,
        cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0,
      };
      const base = (100_000 * 6.9 + 200_000 * 1.7 + 50_000 * 24) / 10_000;   // 223 §
      const line = (rid: string, ts: number) => JSON.stringify({
        type: 'assistant', uuid: `${rid}-u`, timestamp: new Date(ts).toISOString(), requestId: rid,
        message: { id: `m_${rid}`, model: 'glm-4.6', usage },
      });
      await fs.writeFile(path.join(dir, 'session.jsonl'), [
        line('r-peak', peakTs),
        line('r-off', offTs),
      ].join('\n'));

      const result = await getProjectCostForDir(dir, 'demo', {}, Date.now());
      assert.ok(Math.abs(result.credits7d - (base + base * 0.5)) < 1e-9,
        `peak turn at full price + off-peak at half = ${base * 1.5}, got ${result.credits7d}`);
    });
  });


  suite('workspacePathToHash', () => {
    test('replaces forward slashes with hyphens', () => {
      assert.strictEqual(
        workspacePathToHash('/home/user/my-app'),
        '-home-user-my-app'
      );
    });

    test('replaces underscores with hyphens (verified against real data)', () => {
      // Real example: /home/long/sb_git/vscode-claude-status
      //             → -home-long-sb-git-vscode-claude-status
      assert.strictEqual(
        workspacePathToHash('/home/long/sb_git/vscode-claude-status'),
        '-home-long-sb-git-vscode-claude-status'
      );
    });

    test('replaces all non-alphanumeric chars with hyphens', () => {
      assert.strictEqual(
        workspacePathToHash('/mnt/c/Users/910lo/sb_git/my.app'),
        '-mnt-c-Users-910lo-sb-git-my-app'
      );
    });

    test('preserves alphanumeric characters', () => {
      const result = workspacePathToHash('/home/User123/project');
      assert.ok(!result.includes('/'));
      assert.ok(result.includes('User123'));
      assert.ok(result.includes('project'));
    });

    test('handles empty string', () => {
      assert.strictEqual(workspacePathToHash(''), '');
    });
  });
});
