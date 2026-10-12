/** Timezone helpers built on Intl (no external tz dependency). */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Build the instant for a wall-clock time in `timeZone`. */
export function fromZoned(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes handle DST boundaries well enough for timestamp parsing.
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** YYYY-MM-DD for the local day in `timeZone`. */
export function localDateString(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Start of the local day in `timeZone`, as a UTC instant. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return fromZoned(timeZone, p.year, p.month, p.day, 0, 0);
}

/** ISO-8601 string with the zone's offset, e.g. 2026-10-03T09:12:00+05:00. */
export function toZonedIso(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const off = Math.round(tzOffsetMs(date, timeZone) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** True if `date` falls inside [start, end) local wall-clock window. Supports windows crossing midnight. */
export function isWithinActiveHours(
  date: Date,
  timeZone: string,
  window: { start: string; end: string },
): boolean {
  const p = zonedParts(date, timeZone);
  const mins = p.hour * 60 + p.minute;
  const toMins = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const s = toMins(window.start);
  const e = toMins(window.end);
  if (s === e) return true; // 24h
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}
