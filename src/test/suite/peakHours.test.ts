import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { isPeakAt, peakStatus } from '../../data/peakHours';
import type { PeakStatus } from '../../data/peakHours';

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

// Independent machine-zone expectations — built via getTimezoneOffset (non-Intl V8
// path), deliberately independent from the Intl-based implementation: no Intl call
// participates, so changing the formatter config in peakStatus cannot move these
// expectations in lock-step (which would turn the pin into a tautology). They pin
// that an omitted/invalid timeZone selects the machine zone, not a hardcoded UTC
// (the two differ on any non-UTC host and coincide on a UTC one).
const machineOffsetMin = (ms: number): number => -new Date(ms).getTimezoneOffset();
const machineHhMm = (ms: number): string => {
  // Shift the moment to machine wall time and read it as UTC — no zone rendering.
  const wall = new Date(ms + machineOffsetMin(ms) * 60_000);
  return `${String(wall.getUTCHours()).padStart(2, '0')}:${String(wall.getUTCMinutes()).padStart(2, '0')}`;
};
// Same label contract as tzLabel: "UTC" at zero, otherwise "UTC±H[:MM]".
const machineTzLabel = (ms: number): string => {
  const off = machineOffsetMin(ms);
  if (off === 0) { return 'UTC'; }
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const h = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${h}${mm === 0 ? '' : `:${String(mm).padStart(2, '0')}`}`;
};

// The machine-zone fallback cannot be TZ-pinned in-process (mutating process.env.TZ
// before the first Date use only works on Linux; the runner's zone is whatever the
// host machine has — on a UTC CI host the fallback is indistinguishable from a
// hardcoded UTC). A fresh child node reads TZ from its environment at startup, so
// the probe below runs the compiled module under TZ=Europe/Moscow and reports both
// the omitted-timeZone and the invalid-timeZone results. The module path is resolved
// from this test file's __dirname (out/test/suite → out/data), never hardcoded.
// ELECTRON_RUN_AS_NODE makes the extension-host binary (VS Code) behave as plain
// node inside the child; harmless when execPath already is node.
const childProbeScript = `
  const { peakStatus } = require(${JSON.stringify(path.join(__dirname, '..', '..', 'data', 'peakHours'))});
  const now = new Date(${utc(NOV, 9, 7)});
  const machine = peakStatus(now, 'z-ai');
  const invalid = peakStatus(now, 'z-ai', 'Mars/Olympus_Mons');
  process.stdout.write(JSON.stringify({ machine, invalid }));
`;

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
    const fri = peakStatus(new Date(utc(OCT, 30, 7)), 'z-ai', 'America/New_York');
    assert.ok(fri);
    assert.strictEqual(fri.active, true, 'Friday 07:00 UTC is inside the window');
    assert.strictEqual(fri.windowStartMs, utc(OCT, 30, 6), 'the active window is Friday 30 Oct 06:00 UTC');
    assert.strictEqual(fri.windowStartLocal, '02:00');
    assert.strictEqual(fri.tzLabel, 'UTC-4');
    // …while on Saturday 31 Oct (EDT) the *next* window already lies past the
    // transition and must use EST (UTC−5), proving the label follows the window.
    const sat = peakStatus(new Date(utc(OCT, 31, 12)), 'z-ai', 'America/New_York');
    assert.ok(sat);
    assert.strictEqual(sat.active, false, 'Saturday afternoon is outside every window');
    assert.strictEqual(sat.windowStartMs, utc(NOV, 2, 6), 'next window is Monday 2 Nov');
    assert.strictEqual(sat.windowStartLocal, '01:00');
    assert.strictEqual(sat.windowEndLocal, '05:00');
    assert.strictEqual(sat.tzLabel, 'UTC-5');
  });

  test('before today’s window: today is reported', () => {
    const st = peakStatus(MON(4), 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, utc(NOV, 9, 6));
    assert.strictEqual(st.windowEndMs, utc(NOV, 9, 10));
    assert.strictEqual(st.windowStartLocal, '06:00');
    assert.strictEqual(st.windowEndLocal, '10:00');
  });

  test('after today’s window: next weekday morning is reported', () => {
    const st = peakStatus(TUE_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.windowStartMs, utc(NOV, 11, 6));   // Wednesday
    assert.strictEqual(st.windowEndMs, utc(NOV, 11, 10), 'end = start + 4h');
  });

  test('Friday after the window rolls over the weekend to Monday', () => {
    const st = peakStatus(FRI_11, 'z-ai', 'UTC');
    assert.ok(st);
    assert.strictEqual(st.windowStartMs, utc(NOV, 16, 6));   // next Monday
    assert.strictEqual(st.windowEndMs, utc(NOV, 16, 10), 'end = start + 4h');
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
    assert.match(st.tzLabel, /^UTC(?:[+-]\d{1,2}(?::\d{2})?)?$/);
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
    assert.match(st.tzLabel, /^UTC(?:[+-]\d{1,2}(?::\d{2})?)?$/);
  });

  test('machine-zone fallback pinned in a TZ-isolated child: Moscow clock, not hardcoded UTC', () => {
    // The child runs under TZ=Europe/Moscow (MSK = UTC+3 in November), which the
    // in-process tests above cannot force. On a UTC CI host this is exactly the
    // case that used to be a blind spot: machine zone and hardcoded UTC coincide
    // there, while the child's Moscow zone tells them apart.
    const out = execFileSync(process.execPath, ['-e', childProbeScript], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TZ: 'Europe/Moscow', ELECTRON_RUN_AS_NODE: '1' },
    });
    const { machine, invalid } = JSON.parse(out) as { machine: PeakStatus | null; invalid: PeakStatus | null };
    assert.ok(machine, 'omitted timeZone must still produce a status');
    assert.ok(invalid, 'invalid timeZone must not throw out of peakStatus');
    // The invalid zone falls back to the machine zone: identical payloads.
    assert.deepStrictEqual(invalid, machine, 'invalid tz result equals the machine-zone result');
    // Machine zone is Moscow in November: the window renders on the MSK clock.
    // A hardcoded-UTC regression would render 'UTC'/'06:00' — the exact expects
    // below pin that away, observable even when the parent process runs on UTC.
    assert.strictEqual(machine.tzLabel, 'UTC+3');
    assert.strictEqual(machine.windowStartLocal, '09:00');   // 06:00 UTC + 3h
  });
});
