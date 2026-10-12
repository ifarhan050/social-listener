import { describe, expect, it } from 'vitest';
import { parseFacebookTime } from '../src/adapters/facebook/time.js';
import { isWithinActiveHours, localDateString, startOfLocalDay, toZonedIso } from '../src/util/tz.js';

const TZ = 'Asia/Karachi'; // UTC+5, no DST
// Saturday 2026-10-03 14:30 local
const NOW = new Date('2026-10-03T09:30:00Z');
const p = (s: string) => parseFacebookTime(s, NOW, TZ)?.toISOString() ?? null;

describe('parseFacebookTime', () => {
  it('parses relative labels', () => {
    expect(p('Just now')).toBe(NOW.toISOString());
    expect(p('3h')).toBe('2026-10-03T06:30:00.000Z');
    expect(p('2 d')).toBe('2026-10-01T09:30:00.000Z');
    expect(p('15 mins')).toBe('2026-10-03T09:15:00.000Z');
    expect(p('1 hr ago')).toBe('2026-10-03T08:30:00.000Z');
    expect(p('a day ago')).toBe('2026-10-02T09:30:00.000Z');
    expect(p('1w')).toBe('2026-09-26T09:30:00.000Z');
  });

  it('parses Yesterday/Today with clock time in the account timezone', () => {
    expect(p('Yesterday at 4:10 PM')).toBe('2026-10-02T11:10:00.000Z');
    expect(p('Today at 9:05 AM')).toBe('2026-10-03T04:05:00.000Z');
  });

  it('parses weekday labels as the previous occurrence', () => {
    expect(p('Thursday at 9:00 AM')).toBe('2026-10-01T04:00:00.000Z');
    expect(p('Saturday at 9:00 AM')).toBe('2026-09-26T04:00:00.000Z');
  });

  it('parses month-day labels', () => {
    expect(p('October 1 at 3:22 PM')).toBe('2026-10-01T10:22:00.000Z');
    expect(p('1 October')).toBe('2026-09-30T19:00:00.000Z');
    expect(p('Oct 1, 2025')).toBe('2025-09-30T19:00:00.000Z');
    expect(p('December 25')).toBe('2025-12-24T19:00:00.000Z'); // future without year → last year
  });

  it('passes through ISO strings', () => {
    expect(p('2026-10-03T09:12:00+05:00')).toBe('2026-10-03T04:12:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(p('')).toBeNull();
    expect(p('Shared with Public group')).toBeNull();
  });
});

describe('tz helpers', () => {
  it('formats zoned ISO', () => {
    expect(toZonedIso(new Date('2026-10-03T04:12:00Z'), TZ)).toBe('2026-10-03T09:12:00+05:00');
  });
  it('computes local day', () => {
    expect(localDateString(new Date('2026-10-03T20:00:00Z'), TZ)).toBe('2026-10-04');
    expect(startOfLocalDay(NOW, TZ).toISOString()).toBe('2026-10-02T19:00:00.000Z');
  });
  it('checks active hours, including windows across midnight', () => {
    const w = { start: '08:00', end: '23:00' };
    expect(isWithinActiveHours(new Date('2026-10-03T03:00:00Z'), TZ, w)).toBe(true); // 08:00
    expect(isWithinActiveHours(new Date('2026-10-03T02:59:00Z'), TZ, w)).toBe(false); // 07:59
    expect(isWithinActiveHours(new Date('2026-10-03T18:00:00Z'), TZ, w)).toBe(false); // 23:00
    const night = { start: '22:00', end: '02:00' };
    expect(isWithinActiveHours(new Date('2026-10-03T18:30:00Z'), TZ, night)).toBe(true); // 23:30
    expect(isWithinActiveHours(new Date('2026-10-03T20:30:00Z'), TZ, night)).toBe(true); // 01:30
    expect(isWithinActiveHours(new Date('2026-10-03T09:30:00Z'), TZ, night)).toBe(false);
    expect(isWithinActiveHours(NOW, TZ, { start: '00:00', end: '00:00' })).toBe(true);
  });
});
