/**
 * Normalize text for matching (spec §7.5):
 * NFKC, strip Latin combining diacritics, lowercase, drop `#`/`@`,
 * turn other punctuation/symbols into spaces, collapse whitespace.
 *
 * Only U+0300–U+036F marks are stripped so scripts whose vowel signs are
 * combining marks (Devanagari, Arabic harakat aside) keep their meaning.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[#@’']/g, (c) => (c === '#' || c === '@' ? '' : ' '))
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export const tokenize = (normalized: string): string[] => (normalized ? normalized.split(' ') : []);

export const compact = (s: string): string => normalize(s).replace(/ /g, '');
