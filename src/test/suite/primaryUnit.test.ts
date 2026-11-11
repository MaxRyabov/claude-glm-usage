import * as assert from 'assert';
import { resolvePrimaryUnit, formatCredits } from '../../config';

suite('resolvePrimaryUnit', () => {
  test('auto follows the provider: credits for z-ai, usd for everyone else', () => {
    assert.strictEqual(resolvePrimaryUnit('z-ai', 'auto'), 'credits');
    assert.strictEqual(resolvePrimaryUnit('claude-ai', 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('aws-bedrock', 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('api-key', 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('custom-endpoint', 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('unknown', 'auto'), 'usd');
  });

  test('explicit units apply as set for z-ai', () => {
    assert.strictEqual(resolvePrimaryUnit('z-ai', 'credits'), 'credits');
    assert.strictEqual(resolvePrimaryUnit('z-ai', 'usd'), 'usd');
  });

  test('credits degrade to usd for a provider without a credit tariff', () => {
    assert.strictEqual(resolvePrimaryUnit('claude-ai', 'credits'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('aws-bedrock', 'credits'), 'usd');
  });
});

suite('formatCredits', () => {
  test('whole numbers below a thousand keep exact digits', () => {
    assert.strictEqual(formatCredits(0), '§0');
    assert.strictEqual(formatCredits(742), '§742');
    assert.strictEqual(formatCredits(999), '§999');
  });

  test('the k suffix switches exactly at 1000', () => {
    assert.strictEqual(formatCredits(1000), '§1.0k');
    assert.strictEqual(formatCredits(1001), '§1.0k');
  });

  test('thousands compact with the k suffix', () => {
    assert.strictEqual(formatCredits(2800), '§2.8k');
    assert.strictEqual(formatCredits(9999), '§10.0k');
    assert.strictEqual(formatCredits(999_949), '§999.9k');
  });

  test('a mantissa rounded up to 1000.0 carries into the M tier', () => {
    // (999_999 / 1000).toFixed(1) is "1000.0" — the mantissa crossed into the next
    // order and must render as §1.0M, never §1000.0k.
    assert.strictEqual(formatCredits(999_950), '§1.0M');
    assert.strictEqual(formatCredits(999_999), '§1.0M');
    assert.strictEqual(formatCredits(1_000_000), '§1.0M');
  });

  test('millions compact with the M suffix', () => {
    assert.strictEqual(formatCredits(1_200_000), '§1.2M');
  });

  test('rounds half-up to the nearest whole credit before compacting', () => {
    // 999.5/999.6 round up to 1000 and cross the compact threshold; 741.4 rounds down.
    assert.strictEqual(formatCredits(999.5), '§1.0k');
    assert.strictEqual(formatCredits(999.6), '§1.0k');
    assert.strictEqual(formatCredits(741.4), '§741');
    assert.strictEqual(formatCredits(0.5), '§1');
  });

  test('non-finite and negative inputs render as §0 (fail-soft)', () => {
    assert.strictEqual(formatCredits(Number.NaN), '§0');
    assert.strictEqual(formatCredits(Number.POSITIVE_INFINITY), '§0');
    assert.strictEqual(formatCredits(-5), '§0');
  });
});
