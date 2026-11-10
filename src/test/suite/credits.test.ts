import * as assert from 'assert';
import { creditsForEntry } from '../../data/credits';

const usage = (over: Partial<Record<string, number>> = {}) => ({
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
  ...over,
});

suite('credits', () => {
  test('base formula: (input×6.9 + cache_read×1.7 + output×24) / 10000', () => {
    // 1000×6.9 + 2000×1.7 + 500×24 = 6900 + 3400 + 12000 = 22300 → 2.23 §
    const credits = creditsForEntry({ model: 'glm-5.3', usage: usage() }, true);
    assert.ok(Math.abs(credits - 2.23) < 1e-9, `expected 2.23, got ${credits}`);
  });

  test('flash model name switches to the discounted tier', () => {
    // 1000×2.3 + 2000×0.56 + 500×8 = 2300 + 1120 + 4000 = 7420 → 0.742 §
    const credits = creditsForEntry({ model: 'glm-5.3-flash', usage: usage() }, true);
    assert.ok(Math.abs(credits - 0.742) < 1e-9, `expected 0.742, got ${credits}`);
  });

  test('cache_creation does not affect credits', () => {
    const without = creditsForEntry(
      { model: 'glm-5.3', usage: usage({ cache_creation_input_tokens: 0 }) }, true);
    const withBig = creditsForEntry(
      { model: 'glm-5.3', usage: usage({ cache_creation_input_tokens: 999_999 }) }, true);
    assert.strictEqual(without, withBig, 'cache_creation must be ignored by the credit formula');
  });

  test('off-peak turns cost half', () => {
    const peak = creditsForEntry({ model: 'glm-5.3', usage: usage() }, true);
    const offPeak = creditsForEntry({ model: 'glm-5.3', usage: usage() }, false);
    assert.ok(Math.abs(offPeak - peak / 2) < 1e-9, `expected half of ${peak}, got ${offPeak}`);
  });

  test('non-GLM models cost zero credits', () => {
    assert.strictEqual(creditsForEntry({ model: 'claude-sonnet-4-6', usage: usage() }, true), 0);
    assert.strictEqual(creditsForEntry({ model: undefined, usage: usage() }, true), 0);
    assert.strictEqual(creditsForEntry({ model: '<synthetic>', usage: usage() }, true), 0);
  });
});
