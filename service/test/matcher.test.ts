import { describe, expect, it } from 'vitest';
import { Matcher, containsAnyTerm, damerauLevenshtein, normalize } from '../src/matcher/index.js';

const opts = { fuzzyMaxDistance: 1, fuzzyMinLength: 6 };
const m = (kw: Parameters<typeof Matcher>[0]) => new Matcher(kw, opts);

describe('normalize', () => {
  it('lowercases, strips diacritics, #/@ and punctuation', () => {
    expect(normalize('  Héllo, #XYZBank @Team!! ')).toBe('hello xyzbank team');
    expect(normalize('ＸＹＺ　Ｂａｎｋ')).toBe('xyz bank'); // NFKC full-width
    expect(normalize("xyz-bank's app")).toBe('xyz bank s app');
  });
});

describe('damerauLevenshtein', () => {
  it('computes OSA distance', () => {
    expect(damerauLevenshtein('xyzbank', 'xyzbank')).toBe(0);
    expect(damerauLevenshtein('xyzbank', 'xyzbnak')).toBe(1); // transposition
    expect(damerauLevenshtein('xyzbank', 'xyzbanks')).toBe(1);
    expect(damerauLevenshtein('xyzbank', 'abcbank')).toBe(3);
    expect(damerauLevenshtein('kitten', 'sitting', 1)).toBeGreaterThan(1);
  });
});

describe('Matcher', () => {
  const kw = [{ keyword: 'xyzbank' }];

  it.each([
    'I love XYZ Bank',
    'xyzbank is down',
    '#xyzbank help',
    'what about @XyzBank?',
    'X-Y-Z bank customer care',
    'xyz.bank app',
  ])('matches "%s"', (text) => {
    expect(m(kw).match(text)?.keyword).toBe('xyzbank');
  });

  it('records the matched variant span', () => {
    expect(m(kw).match('Is XYZ Bank open?')).toMatchObject({ keyword: 'xyzbank', variant: 'xyz bank', fuzzy: false });
  });

  it('respects word boundaries (no substring matches)', () => {
    expect(m([{ keyword: 'abcbank' }]).match('abcbanking services')).toBeNull();
    expect(m([{ keyword: 'hbl' }]).match('the hblx product')).toBeNull();
  });

  it('fuzzy-matches distance 1 only for long keywords', () => {
    expect(m(kw).match('xyzbnak sucks')?.fuzzy).toBe(true);
    expect(m(kw).match('xyzbnk')?.fuzzy).toBe(true);
    expect(m(kw).match('xyzbxxk')).toBeNull(); // distance 2
    expect(m([{ keyword: 'hbl' }]).match('hbk')).toBeNull(); // short keyword, no fuzzy
  });

  it('prefers exact over fuzzy', () => {
    expect(m(kw).match('xyzbnak and xyzbank')).toMatchObject({ variant: 'xyzbank', fuzzy: false });
  });

  it('matches aliases/variants including other scripts', () => {
    const k = [{ keyword: 'xyzbank', variants: ['ایکس وائی زیڈ بینک', 'XYZB'] }];
    expect(m(k).match('میرا ایکس وائی زیڈ بینک اکاؤنٹ')).toMatchObject({ keyword: 'xyzbank', form: 'ایکس وائی زیڈ بینک' });
    expect(m(k).match('xyzb card blocked')?.form).toBe('XYZB');
  });

  it('negative keywords veto the match', () => {
    const k = [{ keyword: 'xyzbank', negatives: ['xyz bank job', 'hiring'] }];
    expect(m(k).match('XYZ Bank is hiring')).toBeNull();
    expect(m(k).match('xyzbank job openings')).toBeNull();
    expect(m(k).match('xyzbank app crashed')).not.toBeNull();
  });

  it('returns all matching keywords', () => {
    const k = [{ keyword: 'xyzbank' }, { keyword: 'abcbank' }];
    expect(m(k).matchAll('xyzbank vs abc bank').map((r) => r.keyword)).toEqual(['xyzbank', 'abcbank']);
  });

  it('handles empty text', () => {
    expect(m(kw).match('')).toBeNull();
  });
});

describe('containsAnyTerm', () => {
  it('finds secondary terms on word boundaries', () => {
    expect(containsAnyTerm('My debit Card was blocked', ['card', 'atm'])).toBe(true);
    expect(containsAnyTerm('discard this', ['card'])).toBe(false);
    expect(containsAnyTerm('the ATM ate it', ['atm'])).toBe(true);
  });
});
