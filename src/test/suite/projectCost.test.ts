import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { workspacePathToHash, getProjectCostForDir } from '../../data/projectCost';

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
