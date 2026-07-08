import * as assert from 'assert';
import { resolvePricing, calculateCost, DEFAULT_PRICING, TokenPricing } from '../../data/pricing';

const oneMillionEach = {
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

suite('resolvePricing', () => {
  test('matches a known GLM model', () => {
    assert.strictEqual(resolvePricing('glm-4.6').inputPerMillion, 0.60);
    assert.strictEqual(resolvePricing('glm-4.6').outputPerMillion, 2.20);
  });

  test('longest prefix wins: glm-4.5-air over glm-4.5', () => {
    assert.strictEqual(resolvePricing('glm-4.5-air').inputPerMillion, 0.20);
    assert.strictEqual(resolvePricing('glm-4.5').inputPerMillion, 0.60);
  });

  test('longest prefix wins: glm-5-turbo / glm-5.1 over glm-5', () => {
    assert.strictEqual(resolvePricing('glm-5-turbo').inputPerMillion, 1.20);
    assert.strictEqual(resolvePricing('glm-5.1').inputPerMillion, 1.40);
    assert.strictEqual(resolvePricing('glm-5').inputPerMillion, 1.00);
  });

  test('matches Claude models by prefix with version suffix', () => {
    assert.strictEqual(resolvePricing('claude-opus-4-7').inputPerMillion, 15.00);
    assert.strictEqual(resolvePricing('claude-sonnet-4-6').inputPerMillion, 3.00);
    assert.strictEqual(resolvePricing('claude-haiku-4-5-20251001').inputPerMillion, 0.80);
  });

  test('matching is case-insensitive', () => {
    assert.strictEqual(resolvePricing('GLM-4.6').inputPerMillion, 0.60);
  });

  test('free flash models resolve to zero', () => {
    assert.strictEqual(calculateCost(oneMillionEach, resolvePricing('glm-4.7-flash')), 0);
    assert.strictEqual(calculateCost(oneMillionEach, resolvePricing('glm-4.5-flash')), 0);
  });

  test('<synthetic>, empty and undefined models resolve to zero', () => {
    assert.strictEqual(calculateCost(oneMillionEach, resolvePricing('<synthetic>')), 0);
    assert.strictEqual(calculateCost(oneMillionEach, resolvePricing('')), 0);
    assert.strictEqual(calculateCost(oneMillionEach, resolvePricing(undefined)), 0);
  });

  test('user override beats the built-in table', () => {
    const override: TokenPricing = {
      inputPerMillion: 99, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreatePerMillion: 0,
    };
    const p = resolvePricing('glm-4.6', { userOverrides: { 'glm-4.6': override } });
    assert.strictEqual(p.inputPerMillion, 99);
  });

  test('partial user override merges onto fallback (no undefined → NaN rates)', () => {
    // pricing.models marks no field required, so a user may save only inputPerMillion.
    const partial = { inputPerMillion: 42 } as unknown as TokenPricing;
    const p = resolvePricing('glm-4.6', { userOverrides: { 'glm-4.6': partial } });
    assert.strictEqual(p.inputPerMillion, 42);                                   // override wins
    assert.strictEqual(p.outputPerMillion, DEFAULT_PRICING.outputPerMillion);    // filled from fallback
    assert.strictEqual(p.cacheReadPerMillion, DEFAULT_PRICING.cacheReadPerMillion);
    assert.strictEqual(p.cacheCreatePerMillion, DEFAULT_PRICING.cacheCreatePerMillion);
    // calculateCost must never see undefined → NaN
    const cost = calculateCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      p,
    );
    assert.ok(Number.isFinite(cost) && cost > 0, `expected finite cost, got ${cost}`);
  });

  test('z-ai provider default applies to unknown models', () => {
    const p = resolvePricing('mystery-model', { providerType: 'z-ai' });
    assert.strictEqual(p.inputPerMillion, 0.60);   // GLM-4.7 default tier
    assert.strictEqual(p.outputPerMillion, 2.20);
  });

  test('unknown model without provider falls back to flat default', () => {
    const p = resolvePricing('mystery-model');
    assert.strictEqual(p.inputPerMillion, DEFAULT_PRICING.inputPerMillion);
  });

  test('unknown model uses the supplied fallback over the flat default', () => {
    const fallback: TokenPricing = {
      inputPerMillion: 7, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreatePerMillion: 0,
    };
    const p = resolvePricing('mystery-model', { fallback });
    assert.strictEqual(p.inputPerMillion, 7);
  });

  test('known model ignores provider default and fallback', () => {
    const p = resolvePricing('glm-4.6', {
      providerType: 'z-ai',
      fallback: { inputPerMillion: 7, outputPerMillion: 0, cacheReadPerMillion: 0, cacheCreatePerMillion: 0 },
    });
    assert.strictEqual(p.inputPerMillion, 0.60);
  });
});
