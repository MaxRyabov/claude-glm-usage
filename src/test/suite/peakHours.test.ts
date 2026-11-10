import * as assert from 'assert';
import { isPeakAt, peakStatus } from '../../data/peakHours';

// Fixed dates: 2026-11-09 is a Monday, 2026-11-14/15 — Saturday/Sunday.
const MON = (h: number, m = 0): Date => new Date(Date.UTC(2026, 10, 9, h, m));
const TUE_11 = new Date(Date.UTC(2026, 10, 10, 11));
const FRI_11 = new Date(Date.UTC(2026, 10, 13, 11));
const SAT_07 = new Date(Date.UTC(2026, 10, 14, 7));

suite('isPeakAt (UTC weekdays 06:00–10:00)', () => {
  test('weekday inside the window is peak', () => {
    assert.strictEqual(isPeakAt(MON(7, 30).getTime()), true);
  });

  test('boundaries: 06:00 in, 10:00 out', () => {
    assert.strictEqual(isPeakAt(MON(5, 59).getTime()), false);
    assert.strictEqual(isPeakAt(MON(6, 0).getTime()), true);
    assert.strictEqual(isPeakAt(new Date(Date.UTC(2026, 10, 9, 9, 59, 59, 999)).getTime()), true);
    assert.strictEqual(isPeakAt(MON(10, 0).getTime()), false);
  });

  test('weekend never peaks', () => {
    assert.strictEqual(isPeakAt(SAT_07.getTime()), false);
    assert.strictEqual(isPeakAt(new Date(Date.UTC(2026, 10, 15, 7)).getTime()), false);   // Sunday
  });
});

suite('peakStatus', () => {
  test('non-z-ai providers have no peak at all', () => {
    assert.strictEqual(peakStatus(MON(7), 'claude-ai'), null);
    assert.strictEqual(peakStatus(MON(7), 'unknown'), null);
  });

  test('active window: local labels via Intl (Europe/Moscow = UTC+3 in November)', () => {
    const st = peakStatus(MON(7), 'z-ai', 'Europe/Moscow');
    assert.ok(st);
    assert.strictEqual(st.active, true);
    assert.strictEqual(st.windowStartLocal, '09:00');   // 06:00 UTC
    assert.strictEqual(st.windowEndLocal, '13:00');     // 10:00 UTC
    assert.strictEqual(st.tzLabel, 'UTC+3');
  });

  test('negative offset: America/New_York (UTC−5 in November)', () => {
    const st = peakStatus(MON(7), 'z-ai', 'America/New_York');
    assert.ok(st);
    assert.strictEqual(st.windowStartLocal, '01:00');
    assert.strictEqual(st.windowEndLocal, '05:00');
    assert.strictEqual(st.tzLabel, 'UTC-5');
  });

  test('before today’s window: today is reported', () => {
    const st = peakStatus(MON(4), 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, 10, 9, 6));
    assert.strictEqual(st.windowEndMs, Date.UTC(2026, 10, 9, 10));
    assert.strictEqual(st.windowStartLocal, '06:00');
    assert.strictEqual(st.windowEndLocal, '10:00');
  });

  test('after today’s window: next weekday morning is reported', () => {
    const st = peakStatus(TUE_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, 10, 11, 6));   // Wednesday
  });

  test('Friday afternoon rolls over the weekend to Monday', () => {
    const st = peakStatus(FRI_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, 10, 16, 6));   // next Monday
  });

  test('default (machine) timezone still yields HH:MM labels and a UTC± label', () => {
    const st = peakStatus(MON(7), 'z-ai');
    assert.ok(st);
    assert.match(st.windowStartLocal, /^\d{2}:\d{2}$/);
    // On a UTC machine shortOffset is just "UTC" (no ±N suffix); half-hour zones give
    // "UTC+5:30" — all valid.
    assert.match(st.tzLabel, /^UTC([+-]\d+(:\d{2})?)?$/);
  });

  test('an invalid user-supplied timezone falls back to the machine zone, never throws', () => {
    const st = peakStatus(MON(7), 'z-ai', 'Mars/Olympus_Mons');
    assert.ok(st);
    assert.match(st.windowStartLocal, /^\d{2}:\d{2}$/);
    assert.match(st.tzLabel, /^UTC([+-]\d+(:\d{2})?)?$/);
  });
});
