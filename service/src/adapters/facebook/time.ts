import { fromZoned, zonedParts } from '../../util/tz.js';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  y: 31_536_000_000, yr: 31_536_000_000, yrs: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

function parseClock(s: string | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Convert Facebook timestamp labels to absolute instants (spec §6.5).
 * Handles: "Just now", "3h", "2 d", "15 mins", "Yesterday at 4:10 PM",
 * "Monday at 9:00 AM", "October 1 at 3:22 PM", "3 October", "October 1, 2025", ISO strings.
 * Returns null when the label cannot be parsed.
 */
export function parseFacebookTime(label: string, now: Date, timeZone: string): Date | null {
  const s = label.trim().replace(/\s+/g, ' ').replace(/ /g, ' ');
  if (!s) return null;
  const lower = s.toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (/^(just now|now|a few seconds ago)$/.test(lower)) return new Date(now);

  // Relative: "3h", "2 d", "15 mins", "1 hr ago", "a day ago"
  const rel = lower.match(/^(\d+|an?)\s*([a-z]+)(?:\s+ago)?$/);
  if (rel && UNIT_MS[rel[2]]) {
    const n = /^an?$/.test(rel[1]) ? 1 : Number(rel[1]);
    return new Date(now.getTime() - n * UNIT_MS[rel[2]]);
  }

  const today = zonedParts(now, timeZone);
  // Tooltip format: "Monday, October 6, 2025 at 3:22 PM" / "Monday 6 October 2025 at 15:22" — drop the weekday
  // when a full date follows (a bare "Monday at 9:00 AM" keeps it and is handled below).
  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  const full = lower.replace(new RegExp(`^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\\s+(?=${MONTH}\\.?\\s+\\d{1,2}\\b|\\d{1,2}\\s+${MONTH})`), '');
  const [dayPart, clockPart] = full.split(/\s+at\s+/);
  const clock = parseClock(clockPart) ?? { h: 0, m: 0 };
  const hadClock = clockPart !== undefined && parseClock(clockPart) !== null;

  const atDay = (y: number, mo: number, d: number) => fromZoned(timeZone, y, mo, d, clock.h, clock.m);
  const shiftDays = (days: number) => {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day - days));
    return atDay(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  };

  if (dayPart === 'today') return shiftDays(0);
  if (dayPart === 'yesterday') return shiftDays(1);

  if (WEEKDAYS[dayPart] !== undefined && hadClock) {
    let back = (today.weekday - WEEKDAYS[dayPart] + 7) % 7;
    if (back === 0) back = 7; // "Monday" on a Monday means last week
    return shiftDays(back);
  }

  // "October 1", "Oct 1, 2025", "1 October", "1 October 2025"
  const md = dayPart.match(/^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  const dm = dayPart.match(/^(\d{1,2})\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/);
  const hit = md
    ? { mon: MONTHS[md[1]], day: Number(md[2]), year: md[3] ? Number(md[3]) : undefined }
    : dm
      ? { mon: MONTHS[dm[2]], day: Number(dm[1]), year: dm[3] ? Number(dm[3]) : undefined }
      : null;
  if (hit?.mon && hit.day >= 1 && hit.day <= 31) {
    let year = hit.year ?? today.year;
    let d = atDay(year, hit.mon, hit.day);
    // Labels without a year that land in the future refer to last year.
    if (hit.year === undefined && d.getTime() > now.getTime() + 86_400_000) d = atDay(--year, hit.mon, hit.day);
    return d;
  }

  return null;
}
