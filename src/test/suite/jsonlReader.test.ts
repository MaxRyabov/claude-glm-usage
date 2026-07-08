import * as assert from 'assert';
import * as path from 'path';
import { calculateCost, isSafePath, getClaudeProjectsDir } from '../../data/jsonlReader';

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
