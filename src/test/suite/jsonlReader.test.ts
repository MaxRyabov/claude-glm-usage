import * as assert from 'assert';
import * as path from 'path';
import { calculateCost, aggregateUsage, isSafePath, getClaudeProjectsDir } from '../../data/jsonlReader';
import { isPeakAt } from '../../data/peakHours';
import type { UsageEntry } from '../../data/entryCache';

suite('JsonlReader', () => {
  test('calculateCost returns 0 for zero tokens', () => {
    const cost = calculateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.strictEqual(cost, 0);
  });

  test('calculateCost uses correct pricing for input tokens', () => {
    const cost = calculateCost({
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.strictEqual(cost, 3.00);
  });

  test('calculateCost uses correct pricing for output tokens', () => {
    const cost = calculateCost({
      input_tokens: 0,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.strictEqual(cost, 15.00);
  });

  test('calculateCost uses correct pricing for cache read tokens', () => {
    const cost = calculateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    assert.strictEqual(cost, 0.30);
  });

  test('calculateCost uses correct pricing for cache creation tokens', () => {
    const cost = calculateCost({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    assert.strictEqual(cost, 3.75);
  });

  test('calculateCost sums all token types', () => {
    const cost = calculateCost({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    assert.strictEqual(cost, 3.00 + 15.00 + 0.30 + 3.75);
  });

  suite('aggregateUsage (credit windows)', () => {
    const HOUR = 3600 * 1000;
    // 100k in + 200k cache_read + 50k out → (690k + 340k + 1200k)/10000 = 223 § at peak,
    // 111.5 § off-peak. cache_creation (999_999) must not change the credit number.
    const glmUsage = {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 999_999,
    };
    // Manual formula check: the peak phase depends on when the test runs, so only the
    // 1×/0.5× factor comes from isPeakAt — the multiplier math is spelled out here.
    const manualCredits = (ts: number): number =>
      (100_000 * 6.9 + 200_000 * 1.7 + 50_000 * 24) / 10_000 * (isPeakAt(ts) ? 1 : 0.5);

    test('GLM turns earn credits in the windows they fall into; claude turns earn none', () => {
      const now = Date.now();
      const glmNow: UsageEntry = { timestamp: now, model: 'glm-4.6', usage: glmUsage };
      const claudeNow: UsageEntry = { timestamp: now, model: 'claude-sonnet-5-5', usage: glmUsage };
      // 30h ago: past any plausible local midnight (always before today 00:00), inside 7d.
      const glm30h: UsageEntry = { timestamp: now - 30 * HOUR, model: 'glm-4.6', usage: glmUsage };

      const agg = aggregateUsage([glmNow, claudeNow, glm30h], now);

      // The claude turn is in the same windows as glmNow yet adds zero credits: the
      // assertions below would fail if it were billed.
      assert.ok(Math.abs(agg.credits5h - manualCredits(glmNow.timestamp)) < 1e-9,
        `credits5h: expected only the current GLM turn, got ${agg.credits5h}`);
      assert.ok(Math.abs(agg.creditsDay - manualCredits(glmNow.timestamp)) < 1e-9,
        `creditsDay: the 30h-old turn is before today's midnight, claude is not billed`);
      assert.ok(Math.abs(agg.credits7d - (manualCredits(glmNow.timestamp) + manualCredits(glm30h.timestamp))) < 1e-9,
        `credits7d: both GLM turns, got ${agg.credits7d}`);

      // Token counters still see every model; the 30h-old turn is out of the 5h window.
      assert.strictEqual(agg.tokensIn5h, 200_000, 'two 100k-input turns, the 30h-old one excluded');
      assert.ok(agg.cost5h > 0, 'USD aggregate unaffected');
    });

    test('entries outside the 7d window contribute nothing', () => {
      const now = Date.now();
      const old: UsageEntry = { timestamp: now - 8 * 24 * HOUR, model: 'glm-4.6', usage: glmUsage };
      const agg = aggregateUsage([old], now);
      assert.strictEqual(agg.credits7d, 0);
      assert.strictEqual(agg.credits5h, 0);
      assert.strictEqual(agg.creditsDay, 0);
    });
  });

  suite('isSafePath (M-3)', () => {
    const projects = getClaudeProjectsDir();

    test('accepts a file inside ~/.claude/projects', () => {
      assert.strictEqual(isSafePath(path.join(projects, 'proj', 'session.jsonl')), true);
    });

    test('rejects a sibling path outside the projects directory', () => {
      assert.strictEqual(isSafePath(path.join(projects, '..', 'secret.jsonl')), false);
    });

    test('rejects a traversal escaping the projects directory', () => {
      assert.strictEqual(isSafePath(path.join(projects, 'proj', '..', '..', 'evil.jsonl')), false);
    });

    test('rejects an unrelated absolute path', () => {
      assert.strictEqual(isSafePath('/etc/passwd'), false);
    });
  });

  // Note: JSONL parsing + requestId/message.id deduplication is now handled by the
  // incremental parser in entryCache (see entryCache.test.ts), and per-model GLM/Claude
  // pricing is covered by pricing.test.ts. The legacy readJsonlFile parser and its tests
  // were removed in the 1.0.0 rebrand cleanup.
});
