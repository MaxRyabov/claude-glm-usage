import * as assert from 'assert';
import {
  bucketFor,
  decideRateLimitNotifications,
  RateLimitThresholds,
  RateLimitUsage,
} from '../../data/notificationDecision';

const THRESHOLDS: RateLimitThresholds = {
  fiveHourStartPercent: 90,
  fiveHourStepPercent: 2,
  sevenDayStartPercent: 80,
  sevenDayEndPercent: 90,
  sevenDayStepPercent: 5,
};

function makeUsage(overrides: Partial<RateLimitUsage> = {}): RateLimitUsage {
  return {
    utilization5h: 0,
    utilization7d: 0,
    resetIn5h: 3600,
    resetIn7d: 86400,
    has7dLimit: true,
    ...overrides,
  };
}

function decide(usage: Partial<RateLimitUsage>, notified: string[] = []) {
  return decideRateLimitNotifications(makeUsage(usage), THRESHOLDS, new Set(notified));
}

suite('NotificationDecision', () => {
  suite('bucketFor', () => {
    test('returns null below the start threshold', () => {
      assert.strictEqual(bucketFor(89, 90, 2), null);
    });
    test('floors to the step within range (5h)', () => {
      assert.strictEqual(bucketFor(90, 90, 2), 90);
      assert.strictEqual(bucketFor(91, 90, 2), 90);
      assert.strictEqual(bucketFor(93, 90, 2), 92);
      assert.strictEqual(bucketFor(99, 90, 2), 98);
      assert.strictEqual(bucketFor(100, 90, 2), 100);
    });
    test('caps at the end threshold (7d)', () => {
      assert.strictEqual(bucketFor(84, 80, 5, 90), 80);
      assert.strictEqual(bucketFor(85, 80, 5, 90), 85);
      assert.strictEqual(bucketFor(92, 80, 5, 90), 90);
      assert.strictEqual(bucketFor(100, 80, 5, 90), 90);
    });
    test('returns null for non-positive step', () => {
      assert.strictEqual(bucketFor(95, 90, 0), null);
    });
    test('returns null for non-finite utilization (NaN / Infinity)', () => {
      assert.strictEqual(bucketFor(NaN, 90, 2), null);
      assert.strictEqual(bucketFor(Infinity, 90, 2), null);
    });
    test('forces a clean 100 bucket for a full uncapped window even when step ∤ 100', () => {
      // step=3 does not divide 100: without the 100-force the bucket would floor to 99
      // and the "5h rate limit reached" alert (bucket >= 100) would never fire.
      assert.strictEqual(bucketFor(100, 90, 3), 100);
    });
    test('anchors buckets to start for non-default start/step (never below start)', () => {
      // start=82 is not a multiple of step=5; the first bucket must be 82, not 80.
      assert.strictEqual(bucketFor(82, 82, 5), 82);
      assert.strictEqual(bucketFor(86, 82, 5), 82);
      assert.strictEqual(bucketFor(87, 82, 5), 87);
    });
  });

  suite('5h window', () => {
    test('nothing below 90%', () => {
      assert.deepStrictEqual(decide({ utilization5h: 0.89, has7dLimit: false }), []);
    });
    test('exactly 90% → single warning 5h-90', () => {
      const out = decide({ utilization5h: 0.90, has7dLimit: false });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].key, '5h-90');
      assert.strictEqual(out[0].window, '5h');
      assert.strictEqual(out[0].severity, 'warning');
      assert.strictEqual(out[0].percentUsed, 90);
      assert.strictEqual(out[0].reached, false);
    });
    test('93% → 5h-92', () => {
      assert.strictEqual(decide({ utilization5h: 0.93, has7dLimit: false })[0].key, '5h-92');
    });
    test('97% → 5h-96', () => {
      assert.strictEqual(decide({ utilization5h: 0.97, has7dLimit: false })[0].key, '5h-96');
    });
    test('100% → error, reached=true', () => {
      const out = decide({ utilization5h: 1.0, has7dLimit: false });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].key, '5h-100');
      assert.strictEqual(out[0].severity, 'error');
      assert.strictEqual(out[0].reached, true);
    });
    test('already-notified bucket is skipped', () => {
      assert.deepStrictEqual(decide({ utilization5h: 0.92, has7dLimit: false }, ['5h-92']), []);
    });
    test('resetIn is passed through', () => {
      const out = decide({ utilization5h: 0.95, resetIn5h: 1234, has7dLimit: false });
      assert.strictEqual(out[0].resetIn, 1234);
    });
  });

  suite('7d window', () => {
    test('nothing below 80%', () => {
      assert.deepStrictEqual(decide({ utilization7d: 0.79 }), []);
    });
    test('80% and 84% → 7d-80', () => {
      assert.strictEqual(decide({ utilization7d: 0.80 })[0].key, '7d-80');
      assert.strictEqual(decide({ utilization7d: 0.84 })[0].key, '7d-80');
    });
    test('85% → 7d-85', () => {
      assert.strictEqual(decide({ utilization7d: 0.85 })[0].key, '7d-85');
    });
    test('90% and 95% → 7d-90 (capped, nothing above)', () => {
      assert.strictEqual(decide({ utilization7d: 0.90 })[0].key, '7d-90');
      assert.strictEqual(decide({ utilization7d: 0.95 })[0].key, '7d-90');
    });
    test('7d notification is always a warning', () => {
      assert.strictEqual(decide({ utilization7d: 0.90 })[0].severity, 'warning');
    });
    test('no 7d notification when has7dLimit is false', () => {
      assert.deepStrictEqual(decide({ utilization7d: 0.95, has7dLimit: false }), []);
    });
    test('no 7d notification when utilization is 0', () => {
      assert.deepStrictEqual(decide({ utilization7d: 0 }), []);
    });
  });

  suite('both windows', () => {
    test('emits one notification per window when both cross', () => {
      const out = decide({ utilization5h: 0.94, utilization7d: 0.85 });
      const keys = out.map(n => n.key).sort();
      assert.deepStrictEqual(keys, ['5h-94', '7d-85']);
    });
  });

  suite('custom thresholds', () => {
    test('honours a 1% step starting at 85%', () => {
      const custom: RateLimitThresholds = { ...THRESHOLDS, fiveHourStartPercent: 85, fiveHourStepPercent: 1 };
      const out = decideRateLimitNotifications(
        makeUsage({ utilization5h: 0.87, has7dLimit: false }),
        custom,
        new Set(),
      );
      assert.strictEqual(out[0].key, '5h-87');
    });
  });
});
