// z.ai peak-hours window.
//
// The z.ai coding plan charges double credits during peak hours — UTC weekdays
// 06:00–10:00 (the window is fixed by the add-statusbar-peak-ctx-units spec;
// see openspec/changes/add-statusbar-peak-ctx-units). Outside the window every
// turn costs half. Other providers (Anthropic) have no peak tariff, so
// peakStatus returns null for them and no peak UI is shown.

/** Peak window boundaries, UTC hours (start inclusive, end exclusive). */
const PEAK_START_UTC_HOUR = 6;
const PEAK_END_UTC_HOUR = 10;
const PEAK_START_UTC_MIN = PEAK_START_UTC_HOUR * 60;
const PEAK_END_UTC_MIN = PEAK_END_UTC_HOUR * 60;
const PEAK_WINDOW_MS = (PEAK_END_UTC_MIN - PEAK_START_UTC_MIN) * 60_000;

export interface PeakStatus {
  /** True when `now` is inside the peak window (weekday 06:00–10:00 UTC). */
  active: boolean
  /** Window start in ms since epoch — today's window when active, otherwise the next one. */
  windowStartMs: number
  windowEndMs: number
  /** Window start on the user's local clock, e.g. "09:00" (for tooltips like «пик до 13:00»). */
  windowStartLocal: string
  windowEndLocal: string
  /** Local UTC offset label, e.g. "UTC+3". */
  tzLabel: string
}

/** Whether a moment (any provider-independent timestamp) falls inside the peak window. */
export function isPeakAt(timestampMs: number): boolean {
  const d = new Date(timestampMs);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) { return false; }   // Sat/Sun
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= PEAK_START_UTC_MIN && mins < PEAK_END_UTC_MIN;
}

/** Start (06:00 UTC) of the nearest window: today's while it is active or not yet begun, else the next weekday's. */
function nearestWindowStart(now: Date): number {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), PEAK_START_UTC_HOUR),
  );
  if (start.getTime() > now.getTime()) {
    // Today's window has not begun: use it on a weekday, else roll forward.
    while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
      start.setUTCDate(start.getUTCDate() + 1);
    }
    return start.getTime();
  }
  if (isPeakAt(now.getTime())) { return start.getTime(); }   // inside today's window
  // Today's window is over: the next weekday 06:00 UTC (skips the weekend).
  do {
    start.setUTCDate(start.getUTCDate() + 1);
  } while (start.getUTCDay() === 0 || start.getUTCDay() === 6);
  return start.getTime();
}

function localTimeLabel(date: Date, timeZone?: string): string {
  // en-GB + hourCycle h23 gives a stable "HH:MM" 24-hour label for every locale. h23
  // (not hour12:false) guarantees 00–23: some ICU builds render midnight as "24:00"
  // under hour12:false, and for UTC−6..−10 zones the window start lands on midnight.
  // An invalid timeZone (user config is free text) falls back to the machine zone
  // instead of throwing RangeError out of peakStatus.
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
  }
}

function tzLabelOf(at: Date, timeZone?: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en', { timeZoneName: 'shortOffset' }).formatToParts(at);
  }
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  return name.replace(/^GMT/, 'UTC');   // "GMT+3" → "UTC+3"
}

/**
 * Peak status for a provider at a given moment. Only the z-ai coding plan has peak
 * pricing, so every other providerType yields null (no peak badge, no peak cost).
 */
export function peakStatus(now: Date, providerType: string, timeZone?: string): PeakStatus | null {
  if (providerType !== 'z-ai') { return null; }
  const windowStartMs = nearestWindowStart(now);
  const windowEndMs = windowStartMs + PEAK_WINDOW_MS;
  return {
    active: isPeakAt(now.getTime()),
    windowStartMs,
    windowEndMs,
    windowStartLocal: localTimeLabel(new Date(windowStartMs), timeZone),
    windowEndLocal: localTimeLabel(new Date(windowEndMs), timeZone),
    // Offset label of the window moment, not of "now": a DST shift between now and the
    // (possibly next-weekday) window would otherwise mislabel the local times above.
    tzLabel: tzLabelOf(new Date(windowStartMs), timeZone),
  };
}
