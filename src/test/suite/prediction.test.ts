import * as assert from 'assert';
import {
  calculateBurnRate,
  calculateCreditsBurnRate,
  buildRecommendation,
  buildRecommendationKey,
  predictFromTurns,
  quotaCreditsRemaining,
  PredictionInput,
  TimestampedTurn,
} from '../../data/prediction';

// Two GLM turns 10 s apart near the 30-min window edge: 2000 credits and $500 spread
// over the ~0.5 h from the OLDEST turn to now (the span the engine measures) → burn
// ≈ 4000 §/h, ≈ $1000/h. Used by every predictFromTurns test so both engines have data.
const turns = (): TimestampedTurn[] => {
  const now = Date.now();
  return [
    { timestamp: now - 1800_000, cost: 250, credits: 1000 },
    { timestamp: now - 1790_000, cost: 250, credits: 1000 },
  ];
};

const baseInput = (overrides: Partial<PredictionInput> = {}): PredictionInput => ({
  utilization5h: 0.5,
  resetIn5h: 7200,       // 2h until the window resets
  spend5h: 5,
  costToday: 1,
  dailyBudget: null,
  quotaCredits: null,
  ...overrides,
});

suite('Prediction', () => {
  suite('calculateBurnRate', () => {
    test('returns 0 with fewer than 2 entries', () => {
      assert.strictEqual(calculateBurnRate([]), 0);
      assert.strictEqual(calculateBurnRate([{ timestamp: Date.now(), cost: 1 }]), 0);
    });

    test('returns positive rate for 2+ entries', () => {
      const now = Date.now();
      const entries = [
        { timestamp: now - 1800_000, cost: 0.10 }, // 30 min ago
        { timestamp: now - 900_000,  cost: 0.10 }, // 15 min ago
      ];
      const rate = calculateBurnRate(entries);
      // 0.20 USD over 30 min = 0.40 USD/hr
      assert.ok(rate > 0, 'Burn rate should be positive');
      assert.ok(rate < 1.0, 'Burn rate should be reasonable');
    });
  });

  suite('calculateCreditsBurnRate', () => {
    test('returns 0 with fewer than 2 entries', () => {
      assert.strictEqual(calculateCreditsBurnRate([]), 0);
      assert.strictEqual(calculateCreditsBurnRate([{ timestamp: Date.now(), credits: 100 }]), 0);
    });

    test('measures the same turns in credits per hour', () => {
      const rate = calculateCreditsBurnRate(turns());
      // 2000 credits over ~0.5h ≈ 4000 §/h (±clock jitter between construction and call).
      assert.ok(Math.abs(rate - 4000) < 40, `expected ≈4000 §/h, got ${rate}`);
    });
  });

  suite('buildRecommendation', () => {
    test('critical < 600s', () => {
      const msg = buildRecommendation(300);
      assert.ok(msg.includes('10 min'), `Expected 10 min warning, got: ${msg}`);
    });

    test('warning < 1800s', () => {
      const msg = buildRecommendation(1200);
      assert.ok(msg.includes('30 min'), `Expected 30 min warning, got: ${msg}`);
    });

    test('caution < 3600s', () => {
      const msg = buildRecommendation(2700);
      assert.ok(msg.includes('1 hour'), `Expected 1 hour caution, got: ${msg}`);
    });

    test('safe >= 3600s', () => {
      const msg = buildRecommendation(7200);
      assert.ok(msg.includes('Plenty'), `Expected safe message, got: ${msg}`);
    });
  });

  suite('buildRecommendationKey', () => {
    test('maps the same thresholds as the text builder', () => {
      assert.strictEqual(buildRecommendationKey(300), 'critical');
      assert.strictEqual(buildRecommendationKey(1200), 'warning');
      assert.strictEqual(buildRecommendationKey(2700), 'caution');
      assert.strictEqual(buildRecommendationKey(7200), 'safe');
    });
  });

  suite('quotaCreditsRemaining', () => {
    test('prefers the reported remaining amount (conservative)', () => {
      assert.strictEqual(quotaCreditsRemaining({ used: 10, total: 100, remaining: 77 }), 77);
    });

    test('falls back to total − used when remaining is not reported', () => {
      assert.strictEqual(quotaCreditsRemaining({ used: 30, total: 100 }), 70);
    });
  });

  suite('predictFromTurns (z.ai quota path)', () => {
    test('one engine, two units: both burn rates come out of the same turns', () => {
      const p = predictFromTurns(baseInput({
        quotaCredits: { used: 77_000, total: 100_000, remaining: 23_000 },
      }), turns());
      assert.ok(p.currentBurnRate > 0, 'USD burn rate computed');
      assert.ok(Math.abs(p.burnRateCreditsPerHour - 4000) < 40, `credits burn ≈ 4000 §/h, got ${p.burnRateCreditsPerHour}`);
    });

    test('window that outlives the reset → survives-reset, no exhaustion time', () => {
      // 23_000 § left at ≈4000 §/h ≈ 5.75h > 2h until reset — the window survives.
      const p = predictFromTurns(baseInput({
        quotaCredits: { used: 77_000, total: 100_000, remaining: 23_000 },
      }), turns());
      assert.strictEqual(p.exhaustsBeforeReset, false, 'not exhausted before the reset');
      assert.strictEqual(p.estimatedExhaustionIn, null, 'no time is promised');
      assert.strictEqual(p.recommendationKey, 'survives-reset');
      assert.strictEqual(p.creditsRemaining5h, 23_000);
      assert.strictEqual(p.safeToStartHeavyTask, true);
    });

    test('faster burn than the remainder allows → exhaustion in ~15 min', () => {
      // 1000 § left at ≈4000 §/h → ≈900s, well before the 2h reset.
      const p = predictFromTurns(baseInput({
        quotaCredits: { used: 99_000, total: 100_000, remaining: 1000 },
      }), turns());
      assert.strictEqual(p.exhaustsBeforeReset, true);
      assert.ok(p.estimatedExhaustionIn !== null && Math.abs(p.estimatedExhaustionIn - 900) < 1,
        `expected ≈900s, got ${p.estimatedExhaustionIn}`);
      assert.ok(p.estimatedExhaustionTime && Math.abs(p.estimatedExhaustionTime.getTime() - Date.now() - 900_000) < 5_000);
      assert.strictEqual(p.recommendationKey, 'warning');
      assert.strictEqual(p.safeToStartHeavyTask, false, '< 30 min left');
    });

    test('zero credits burn (no GLM turns in the window) → no exhaustion forecast', () => {
      const claudeOnly: TimestampedTurn[] = turns().map((t) => ({ ...t, credits: 0 }));
      const p = predictFromTurns(baseInput({
        quotaCredits: { used: 99_000, total: 100_000, remaining: 1000 },
      }), claudeOnly);
      assert.strictEqual(p.burnRateCreditsPerHour, 0);
      assert.strictEqual(p.estimatedExhaustionIn, null, 'no forecast from a zero rate');
      assert.strictEqual(p.exhaustsBeforeReset, null);
      assert.strictEqual(p.creditsRemaining5h, 1000, 'remainder still reported');
    });

    test('a spent quota (zero remaining) reads as rate-limit-reached, not "10 min left"', () => {
      // remaining absent → total − used = 0: the quota is exhausted right now, and the
      // forecast must say so instead of "Less than 10 min remaining".
      const p = predictFromTurns(baseInput({
        utilization5h: 0.97,
        quotaCredits: { used: 100_000, total: 100_000 },
      }), turns());
      assert.strictEqual(p.recommendationKey, 'rate-limit-reached');
      assert.strictEqual(p.estimatedExhaustionIn, 0);
      assert.strictEqual(p.creditsRemaining5h, 0);
      assert.strictEqual(p.safeToStartHeavyTask, false);
    });

    test('utilization already at 100% wins over the quota path', () => {
      const p = predictFromTurns(baseInput({
        utilization5h: 1.0,
        quotaCredits: { used: 50_000, total: 100_000, remaining: 50_000 },
      }), turns());
      assert.strictEqual(p.recommendationKey, 'rate-limit-reached');
      assert.strictEqual(p.estimatedExhaustionIn, 0);
      assert.strictEqual(p.safeToStartHeavyTask, false);
    });
  });

  suite('predictFromTurns (utilization fallback, claude-ai)', () => {
    test('capacity from spend/utilization, exhaustion capped by the reset', () => {
      // capacity = 5 / 0.5 = 10, remaining 5 at ≈$1000/h → ≈18s (< the 2h reset).
      const p = predictFromTurns(baseInput({}), turns());
      assert.strictEqual(p.creditsRemaining5h, null, 'no quota reported');
      assert.strictEqual(p.exhaustsBeforeReset, null, 'flag is quota-path only');
      assert.ok(p.estimatedExhaustionIn !== null && p.estimatedExhaustionIn < 600,
        `expected < 600s, got ${p.estimatedExhaustionIn}`);
      assert.strictEqual(p.recommendationKey, 'critical');
    });

    test('z-ai token tariff: credits spend divided by the credits burn rate', () => {
      // spend5h is in credits here (localCredits5h): 230 § at util 0.5 → capacity 460 §,
      // remaining 230 § at ≈4000 §/h → ≈207s. Dividing by the USD rate instead would
      // give a ~5,000× wrong time.
      const p = predictFromTurns(baseInput({ fallbackUnit: 'credits', spend5h: 230 }), turns());
      assert.ok(p.estimatedExhaustionIn !== null && Math.abs(p.estimatedExhaustionIn - 207) < 5,
        `expected ≈207s, got ${p.estimatedExhaustionIn}`);
      assert.strictEqual(p.recommendationKey, 'critical');
    });

    test('no turns in the window → no exhaustion time, safe default', () => {
      const p = predictFromTurns(baseInput({}), []);
      assert.strictEqual(p.currentBurnRate, 0);
      assert.strictEqual(p.estimatedExhaustionIn, null);
      assert.strictEqual(p.recommendationKey, 'safe');
    });

    test('daily budget exhaustion still uses the USD burn rate', () => {
      const p = predictFromTurns(baseInput({ dailyBudget: 2, costToday: 1 }), turns());
      assert.ok(p.budgetRemaining !== null && Math.abs(p.budgetRemaining - 1) < 1e-9);
      assert.ok(p.budgetExhaustionTime, 'budget path stays intact');
    });
  });
});
