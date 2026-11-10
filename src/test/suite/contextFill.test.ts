import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  resolveContextWindow,
  computeContextFill,
  CONTEXT_WARN_MARGIN_TOKENS,
} from '../../data/contextFill';
import type { ContextFill } from '../../data/contextFill';
import { getClaudeProjectsDir, __resetEntryCacheForTests } from '../../data/entryCache';

const HOUR = 3600 * 1000;

suite('resolveContextWindow', () => {
  test('glm models get 200k', () => {
    assert.strictEqual(resolveContextWindow('glm-4.6', null), 200_000);
    assert.strictEqual(resolveContextWindow('glm-5.3', null), 200_000);
  });

  test('unknown models get the 200k default', () => {
    assert.strictEqual(resolveContextWindow('some-unknown-model', null), 200_000);
    assert.strictEqual(resolveContextWindow(undefined, null), 200_000);
  });

  test('the override applies only to non-claude models', () => {
    assert.strictEqual(resolveContextWindow('glm-4.6', 400_000), 400_000);
    assert.strictEqual(resolveContextWindow('some-unknown-model', 400_000), 400_000);
    // claude reads its built-in table; an override must not widen a claude window.
    assert.strictEqual(resolveContextWindow('claude-sonnet-5-5', 400_000), 200_000);
  });

  test('claude table covers full and short model names', () => {
    for (const name of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku']) {
      assert.strictEqual(resolveContextWindow(name, null), 200_000, `${name} → 200k`);
    }
    // A claude name missing from the table falls back to the claude default, not the override.
    assert.strictEqual(resolveContextWindow('claude-future-9', 400_000), 200_000);
  });

  test('[1m] wins for any model, claude included, and is case-insensitive', () => {
    assert.strictEqual(resolveContextWindow('glm-4.6 [1m]', null), 1_000_000);
    assert.strictEqual(resolveContextWindow('claude-sonnet-5-5 [1m]', null), 1_000_000);
    assert.strictEqual(resolveContextWindow('GLM-5.3 [1M]', null), 1_000_000);
    // …and beats an explicit override too.
    assert.strictEqual(resolveContextWindow('glm-4.6 [1m]', 400_000), 1_000_000);
  });
});

suite('computeContextFill', () => {
  // findActiveSession only reads project dirs inside the real ~/.claude/projects —
  // use a clearly-named temp project subdir and clean it up afterwards (entryCache pattern).
  const projectsDir = getClaudeProjectsDir();
  let projDir: string;
  // Freeze each timestamp once: recomputing Date.now() after the write races the clock.
  const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * HOUR).toISOString();

  const line = (rid: string, model: string | undefined, hoursAgo: number, usage: Record<string, number>): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: at(hoursAgo),
      requestId: rid,
      message: {
        id: `m_${rid}`,
        ...(model !== undefined ? { model } : {}),
        usage: {
          input_tokens: usage.input ?? 0,
          output_tokens: usage.output ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
          cache_creation_input_tokens: usage.cacheCreate ?? 0,
        },
      },
    });

  setup(async () => {
    __resetEntryCacheForTests();
    await fs.mkdir(projectsDir, { recursive: true });
    projDir = path.join(projectsDir, `_ctxfill-test-${Date.now()}-${process.pid}`);
    await fs.mkdir(projDir, { recursive: true });
  });
  teardown(async () => { try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('fill = input + cache_read + cache_creation of the active session (output excluded)', async () => {
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1', 'glm-4.6', 0.5, {
      input: 20_000, cacheRead: 40_000, cacheCreate: 5_000, output: 500_000,
    }) + '\n');
    const fill = await computeContextFill(projDir, null);
    assert.ok(fill, 'fresh session expected');
    assert.strictEqual(fill.usedTokens, 65_000, 'output tokens do not fill the context window');
    assert.strictEqual(fill.windowTokens, 200_000);
    assert.ok(Math.abs(fill.fillRatio - 0.325) < 1e-9);
    assert.strictEqual(fill.nearLimit, false);
  });

  test(`⚠ threshold is window − ${CONTEXT_WARN_MARGIN_TOKENS} tokens: 185k warns, 170k does not`, async () => {
    await fs.writeFile(path.join(projDir, 's1.jsonl'), line('r1', 'glm-4.6', 1, { input: 170_000 }) + '\n');
    await fs.writeFile(path.join(projDir, 's2.jsonl'), line('r2', 'glm-4.6', 0.5, { input: 185_000 }) + '\n');
    // s2 is the active session (newest), but check both thresholds via two separate dirs.
    const fill = await computeContextFill(projDir, null);
    assert.ok(fill);
    assert.strictEqual(fill.usedTokens, 185_000);
    assert.strictEqual(fill.nearLimit, true, '185k ≥ 200k − 20k → warn');

    const quiet = path.join(projectsDir, `_ctxfill-test-quiet-${Date.now()}-${process.pid}`);
    await fs.mkdir(quiet, { recursive: true });
    try {
      await fs.writeFile(path.join(quiet, 's.jsonl'), line('r1', 'glm-4.6', 0.5, { input: 170_000 }) + '\n');
      const q = await computeContextFill(quiet, null);
      assert.ok(q);
      assert.strictEqual(q.nearLimit, false, '170k < 180k → no warn');
    } finally {
      await fs.rm(quiet, { recursive: true, force: true });
    }
  });

  test('nearLimit boundary is inclusive: exactly window − 20k warns, one token less does not', async () => {
    const edge = path.join(projectsDir, `_ctxfill-test-edge-${Date.now()}-${process.pid}`);
    const below = path.join(projectsDir, `_ctxfill-test-below-${Date.now()}-${process.pid}`);
    await fs.mkdir(edge, { recursive: true });
    await fs.mkdir(below, { recursive: true });
    try {
      await fs.writeFile(path.join(edge, 's.jsonl'), line('r1', 'glm-4.6', 0.5, { input: 180_000 }) + '\n');
      await fs.writeFile(path.join(below, 's.jsonl'), line('r1', 'glm-4.6', 0.5, { input: 179_999 }) + '\n');
      const atEdge = await computeContextFill(edge, null);
      const oneBelow = await computeContextFill(below, null);
      assert.ok(atEdge && oneBelow, 'both fresh sessions expected');
      assert.strictEqual(atEdge.nearLimit, true, '180_000 = 200k − 20k is already near the limit (>=)');
      assert.strictEqual(oneBelow.nearLimit, false, '179_999 is below the margin');
    } finally {
      await fs.rm(edge, { recursive: true, force: true });
      await fs.rm(below, { recursive: true, force: true });
    }
  });

  test('fillRatio is not clamped: an override below the real fill shows 104%', async () => {
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1', 'glm-4.6', 0.5, { input: 104_000 }) + '\n');
    const fill = await computeContextFill(projDir, 100_000);
    assert.ok(fill);
    assert.strictEqual(fill.windowTokens, 100_000);
    assert.ok(Math.abs(fill.fillRatio - 1.04) < 1e-9, 'no clamp to 100%');
    assert.strictEqual(fill.nearLimit, true);
  });

  test('a [1m] session resolves to the 1M window', async () => {
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1', 'glm-4.6 [1m]', 0.5, { input: 150_000 }) + '\n');
    const fill = await computeContextFill(projDir, null);
    assert.ok(fill);
    assert.strictEqual(fill.windowTokens, 1_000_000);
    assert.strictEqual(fill.nearLimit, false, '150k of 1M is nowhere near the margin');
  });

  test('a claude session ignores the override', async () => {
    await fs.writeFile(path.join(projDir, 's.jsonl'), line('r1', 'claude-sonnet-5-5', 0.5, { input: 100_000 }) + '\n');
    const fill = await computeContextFill(projDir, 400_000);
    assert.ok(fill);
    assert.strictEqual(fill.windowTokens, 200_000);
  });

  test('returns null without a project dir, for a stale session, or with no model', async () => {
    assert.strictEqual(await computeContextFill(null, null), null, 'no project dir');

    // Each cause gets its own clean dir with its own requestId, so every assertion
    // fails for exactly the reason its message claims.
    const staleDir = path.join(projectsDir, `_ctxfill-test-stale-${Date.now()}-${process.pid}`);
    const noModelDir = path.join(projectsDir, `_ctxfill-test-nomodel-${Date.now()}-${process.pid}`);
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(noModelDir, { recursive: true });
    try {
      // Fresh enough timestamp, but no model on the turn — the window is unresolvable.
      await fs.writeFile(path.join(noModelDir, 's.jsonl'), line('r-nomodel', undefined, 0.5, { input: 1_000 }) + '\n');
      const noModel: ContextFill | null = await computeContextFill(noModelDir, null);
      assert.strictEqual(noModel, null, 'a fresh session without a model cannot resolve a window');

      await fs.writeFile(path.join(staleDir, 's.jsonl'), line('r-stale', 'glm-4.6', 7, { input: 1_000 }) + '\n');
      assert.strictEqual(await computeContextFill(staleDir, null), null, 'last turn older than 6h');
    } finally {
      await fs.rm(staleDir, { recursive: true, force: true });
      await fs.rm(noModelDir, { recursive: true, force: true });
    }
  });
});
