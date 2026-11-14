import * as assert from 'assert';
import { resolvePrimaryUnit, formatCredits } from '../../config';
import type { PrimaryUnitSetting } from '../../config';
import type { ClaudeProvider } from '../../data/apiClient';

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

  test('a non-usd garbage setting resolves through the provider path', () => {
    // The setting value is validated in the primaryUnitSetting getter (normalized to
    // auto); the resolver itself must also be robust to a value that slipped through —
    // anything but an explicit usd takes the provider check, case-sensitively.
    assert.strictEqual(resolvePrimaryUnit('z-ai', 'AUTO' as PrimaryUnitSetting), 'credits');
    assert.strictEqual(resolvePrimaryUnit('z-ai', 'bogus' as PrimaryUnitSetting), 'credits');
    assert.strictEqual(resolvePrimaryUnit('claude-ai', 'bogus' as PrimaryUnitSetting), 'usd');
  });

  test('the provider check is an exact case-sensitive match', () => {
    // providerType comes from our own credential detection, but the guard is cheap:
    // lookalikes take the usd path instead of silently earning a credit tariff.
    assert.strictEqual(resolvePrimaryUnit('' as ClaudeProvider, 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit('Z-AI' as ClaudeProvider, 'auto'), 'usd');
    assert.strictEqual(resolvePrimaryUnit(undefined as unknown as ClaudeProvider, 'auto'), 'usd');
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
    assert.strictEqual(formatCredits(1001), '§1.0k'); // mantissa rounding: 1.001 → 1.0
    assert.strictEqual(formatCredits(1500), '§1.5k'); // a mantissa visibly above the threshold
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

  test('the same carry applies inside the M tier', () => {
    // (999_999_999 / 1e6).toFixed(1) is "1000.0" — the M tier must hand it over to B.
    assert.strictEqual(formatCredits(999_949_999), '§999.9M');
    assert.strictEqual(formatCredits(999_950_000), '§1.0B');
    assert.strictEqual(formatCredits(1_000_000_000), '§1.0B');
  });

  test('the same carry applies inside the B tier', () => {
    // (999_950_000_000 / 1e9).toFixed(1) is "1000.0" — the B tier hands it over to T,
    // completing the k→M / M→B / B→T carry symmetry.
    assert.strictEqual(formatCredits(999_949_999_999), '§999.9B');
    assert.strictEqual(formatCredits(999_950_000_000), '§1.0T');
  });

  test('millions compact with the M suffix', () => {
    assert.strictEqual(formatCredits(1_200_000), '§1.2M');
  });

  test('the T tier and its exponential overflow keep the mantissa bounded', () => {
    assert.strictEqual(formatCredits(1e12), '§1.0T');
    assert.strictEqual(formatCredits(1e15), '§1.0e+3T'); // no higher tier — go exponential
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
    assert.strictEqual(formatCredits(Number.NEGATIVE_INFINITY), '§0');
    assert.strictEqual(formatCredits(undefined as unknown as number), '§0');
    assert.strictEqual(formatCredits(-5), '§0');
    assert.strictEqual(formatCredits(-0), '§0'); // -0 is finite and not < 0 — must not print §-0
  });
});
