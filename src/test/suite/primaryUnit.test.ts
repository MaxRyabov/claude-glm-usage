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

  test('thousands compact with the k suffix', () => {
    assert.strictEqual(formatCredits(2800), '§2.8k');
    assert.strictEqual(formatCredits(9999), '§10.0k');
  });

  test('millions compact with the M suffix', () => {
    assert.strictEqual(formatCredits(1_200_000), '§1.2M');
  });

  test('rounds to the nearest whole credit before compacting', () => {
    // 999.6 rounds to 1000, which crosses the compact threshold.
    assert.strictEqual(formatCredits(999.6), '§1.0k');
    assert.strictEqual(formatCredits(741.4), '§741');
  });
});
