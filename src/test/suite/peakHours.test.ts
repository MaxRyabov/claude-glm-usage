import * as assert from 'assert';
import { isPeakAt, peakStatus } from '../../data/peakHours';

// Fixed dates: 2026-11-09 is a Monday, 2026-11-14/15 — Saturday/Sunday.
// Date.UTC months are 0-based — name them instead of repeating bare indices.
const OCT = 9;
const NOV = 10;
// Full-precision UTC timestamp (named months, explicit seconds/ms) — the shared shape
// for every fixed date below, so boundary cases don't hand-roll their own Date.UTC.
const utc = (month: number, day: number, h: number, m = 0, s = 0, ms = 0): number =>
  Date.UTC(2026, month, day, h, m, s, ms);
const MON = (h: number, m = 0): Date => new Date(utc(NOV, 9, h, m));
const TUE_11 = new Date(utc(NOV, 10, 11));
const FRI_11 = new Date(utc(NOV, 13, 11));
const SAT_07 = new Date(utc(NOV, 14, 7));

// Independent default-zone (machine) formatters — deliberately no shared code with
// peakStatus: they pin that an omitted/invalid timeZone selects the machine zone, not
// a hardcoded UTC (the two differ on any non-UTC host and coincide on a UTC one).
const machineHhMm = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const machineTzLabel = (ms: number): string =>
  (new Intl.DateTimeFormat('en', { timeZoneName: 'shortOffset' }).formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName')?.value ?? '').replace(/^GMT/, 'UTC');

suite('isPeakAt (UTC weekdays 06:00–10:00)', () => {
  test('weekday inside the window is peak', () => {
    assert.strictEqual(isPeakAt(MON(7, 30).getTime()), true);
  });

  test('boundaries: 06:00 in, 10:00 out', () => {
    assert.strictEqual(isPeakAt(MON(5, 59).getTime()), false);
    assert.strictEqual(isPeakAt(MON(6, 0).getTime()), true);
    assert.strictEqual(isPeakAt(utc(NOV, 9, 9, 59, 59, 999)), true);
    assert.strictEqual(isPeakAt(MON(10, 0).getTime()), false);
  });

  test('weekend never peaks', () => {
    assert.strictEqual(isPeakAt(SAT_07.getTime()), false);
    assert.strictEqual(isPeakAt(utc(NOV, 15, 7)), false);   // Sunday
  });
});

suite('peakStatus', () => {
  test('non-z-ai providers have no peak at all', () => {
    assert.strictEqual(peakStatus(MON(7), 'claude-ai'), null);
    assert.strictEqual(peakStatus(MON(7), 'unknown'), null);
  });

  test('active window: absolute bounds and local labels via Intl (Europe/Moscow = UTC+3 in November)', () => {
    const st = peakStatus(MON(7), 'z-ai', 'Europe/Moscow');
    assert.ok(st);
    assert.strictEqual(st.active, true);
    assert.strictEqual(st.windowStartMs, utc(NOV, 9, 6));
    assert.strictEqual(st.windowEndMs, utc(NOV, 9, 10), 'end = start + 4h');
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

  test('fractional offsets: Asia/Kolkata (+5:30) and Asia/Kathmandu (+5:45)', () => {
    const kolkata = peakStatus(MON(7), 'z-ai', 'Asia/Kolkata');
    assert.ok(kolkata);
    assert.strictEqual(kolkata.windowStartLocal, '11:30');
    assert.strictEqual(kolkata.windowEndLocal, '15:30');
    assert.strictEqual(kolkata.tzLabel, 'UTC+5:30');

    const kathmandu = peakStatus(MON(7), 'z-ai', 'Asia/Kathmandu');
    assert.ok(kathmandu);
    assert.strictEqual(kathmandu.windowStartLocal, '11:45');
    assert.strictEqual(kathmandu.windowEndLocal, '15:45');
    assert.strictEqual(kathmandu.tzLabel, 'UTC+5:45');
  });

  test('western zone crossing midnight: America/Los_Angeles labels span two local days', () => {
    const st = peakStatus(MON(7), 'z-ai', 'America/Los_Angeles');   // PST = UTC−8 in November
    assert.ok(st);
    assert.strictEqual(st.windowStartLocal, '22:00');   // 06:00 UTC = previous day 22:00
    assert.strictEqual(st.windowEndLocal, '02:00');     // 10:00 UTC = same morning 02:00
    assert.strictEqual(st.tzLabel, 'UTC-8');
  });

  test('DST transition: the offset is taken at the window moment, not at "now"', () => {
    // US clocks fall back on Sunday 2026-11-01. On Friday 30 Oct (still EDT, UTC−4)
    // the active window renders with the pre-transition offset…
    const fri = peakStatus(new Date(Date.UTC(2026, OCT, 30, 7)), 'z-ai', 'America/New_York');
    assert.ok(fri);
    assert.strictEqual(fri.windowStartLocal, '02:00');
    assert.strictEqual(fri.tzLabel, 'UTC-4');
    // …while on Saturday 31 Oct (EDT) the *next* window already lies past the
    // transition and must use EST (UTC−5), proving the label follows the window.
    const sat = peakStatus(new Date(Date.UTC(2026, OCT, 31, 12)), 'z-ai', 'America/New_York');
    assert.ok(sat);
    assert.strictEqual(sat.active, false, 'Saturday afternoon is outside every window');
    assert.strictEqual(sat.windowStartMs, Date.UTC(2026, NOV, 2, 6), 'next window is Monday 2 Nov');
    assert.strictEqual(sat.windowStartLocal, '01:00');
    assert.strictEqual(sat.windowEndLocal, '05:00');
    assert.strictEqual(sat.tzLabel, 'UTC-5');
  });

  test('before today’s window: today is reported', () => {
    const st = peakStatus(MON(4), 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, NOV, 9, 6));
    assert.strictEqual(st.windowEndMs, Date.UTC(2026, NOV, 9, 10));
    assert.strictEqual(st.windowStartLocal, '06:00');
    assert.strictEqual(st.windowEndLocal, '10:00');
  });

  test('after today’s window: next weekday morning is reported', () => {
    const st = peakStatus(TUE_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, NOV, 11, 6));   // Wednesday
    assert.strictEqual(st.windowEndMs, Date.UTC(2026, NOV, 11, 10), 'end = start + 4h');
  });

  test('Friday after the window rolls over the weekend to Monday', () => {
    const st = peakStatus(FRI_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.windowStartMs, Date.UTC(2026, NOV, 16, 6));   // next Monday
    assert.strictEqual(st.windowEndMs, Date.UTC(2026, NOV, 16, 10), 'end = start + 4h');
  });

  test('default (machine) timezone: labels equal an independent machine-zone formatting', () => {
    const st = peakStatus(MON(7), 'z-ai');
    assert.ok(st);
    // The expectation comes from a separate default-zone formatter over the same window
    // moments: this pins "omitted timeZone → machine zone", not just the label shape.
    // A regression hardcoding UTC (or losing the offset) fails on any non-UTC host; on
    // a UTC host both coincide and only the format guards below apply.
    assert.strictEqual(st.windowStartLocal, machineHhMm(st.windowStartMs));
    assert.strictEqual(st.windowEndLocal, machineHhMm(st.windowEndMs));
    assert.strictEqual(st.tzLabel, machineTzLabel(st.windowStartMs));
    assert.match(st.windowStartLocal, /^\d{2}:\d{2}$/);
    // On a UTC machine shortOffset is just "UTC" (no ±N suffix); half-hour zones give
    // "UTC+5:30" — all valid.
    assert.match(st.tzLabel, /^UTC([+-]\d+(:\d{2})?)?$/);
  });

  test('an invalid user-supplied timezone falls back to the machine zone, never throws', () => {
    // A direct call already fails the test on a throw. Equality with the no-timezone
    // call pins the fallback target, and the independent machine-zone expectation below
    // rules out the "both calls quietly fell back to hardcoded UTC" pass that an
    // equality-only check allows (the two differ on any non-UTC host).
    const st = peakStatus(MON(7), 'z-ai', 'Mars/Olympus_Mons');
    assert.ok(st);
    assert.deepStrictEqual(st, peakStatus(MON(7), 'z-ai'), 'invalid tz result equals the machine-zone result');
    assert.strictEqual(st.windowStartLocal, machineHhMm(st.windowStartMs));
    assert.strictEqual(st.tzLabel, machineTzLabel(st.windowStartMs));
    assert.match(st.tzLabel, /^UTC([+-]\d+(:\d{2})?)?$/);
  });
});
