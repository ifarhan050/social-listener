import { damerauLevenshtein } from './distance.js';
import { compact, normalize, tokenize } from './normalize.js';

export { normalize, tokenize, compact } from './normalize.js';
export { damerauLevenshtein } from './distance.js';

export interface KeywordSpec {
  keyword: string;
  variants?: string[];
  negatives?: string[];
}

export interface MatchOptions {
  fuzzyMaxDistance: number;
  fuzzyMinLength: number;
}

export interface MatchResult {
  /** The configured keyword that matched. */
  keyword: string;
  /** The text span (normalized) that produced the match, e.g. "xyz bank". */
  variant: string;
  /** Which form matched: the keyword itself or one of its aliases. */
  form: string;
  fuzzy: boolean;
}

interface CompiledForm {
  form: string;
  compact: string;
  /** Max number of text tokens a match may span. */
  maxSpan: number;
  fuzzy: boolean;
}

interface CompiledKeyword {
  keyword: string;
  forms: CompiledForm[];
  negatives: CompiledForm[];
}

export interface PreparedText {
  tokens: string[];
}

export const prepareText = (text: string): PreparedText => ({ tokens: tokenize(normalize(text)) });

function compileForm(form: string, opts: MatchOptions, allowFuzzy: boolean): CompiledForm | null {
  const n = normalize(form);
  if (!n) return null;
  const c = n.replace(/ /g, '');
  const words = n.split(' ').length;
  return {
    form,
    compact: c,
    // "xyzbank" may appear as "xyz bank" or "x y z bank": allow a few extra tokens beyond the form's word count.
    maxSpan: Math.max(words + 2, Math.min(c.length, 4)),
    fuzzy: allowFuzzy && opts.fuzzyMaxDistance > 0 && c.length >= opts.fuzzyMinLength,
  };
}

/**
 * Find a contiguous token span whose concatenation equals (or, if fuzzy, is within
 * the distance bound of) the compact form. Matching whole tokens enforces word
 * boundaries, so "xyzbank" does not match inside "xyzbanking".
 */
function findSpan(tokens: string[], f: CompiledForm, maxDist: number): { span: string; fuzzy: boolean } | null {
  let fuzzyHit: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    let joined = '';
    for (let j = i; j < tokens.length && j - i < f.maxSpan; j++) {
      joined += tokens[j];
      if (joined === f.compact) return { span: tokens.slice(i, j + 1).join(' '), fuzzy: false };
      if (f.fuzzy && fuzzyHit === null && Math.abs(joined.length - f.compact.length) <= maxDist) {
        if (damerauLevenshtein(joined, f.compact, maxDist) <= maxDist) {
          fuzzyHit = tokens.slice(i, j + 1).join(' ');
        }
      }
      if (joined.length > f.compact.length + maxDist) break;
    }
  }
  return fuzzyHit === null ? null : { span: fuzzyHit, fuzzy: true };
}

export class Matcher {
  private compiled: CompiledKeyword[];

  constructor(
    keywords: KeywordSpec[],
    private opts: MatchOptions,
  ) {
    this.compiled = keywords
      .map((k) => ({
        keyword: k.keyword,
        forms: [k.keyword, ...(k.variants ?? [])]
          .map((f) => compileForm(f, opts, true))
          .filter((f): f is CompiledForm => f !== null),
        negatives: (k.negatives ?? [])
          .map((f) => compileForm(f, opts, false))
          .filter((f): f is CompiledForm => f !== null),
      }))
      .filter((k) => k.forms.length > 0);
  }

  get size(): number {
    return this.compiled.length;
  }

  /** All keywords matching `text`, in configured order. Negatives veto their keyword. */
  matchAll(text: string | PreparedText): MatchResult[] {
    const { tokens } = typeof text === 'string' ? prepareText(text) : text;
    if (!tokens.length) return [];
    const out: MatchResult[] = [];
    for (const k of this.compiled) {
      let best: MatchResult | null = null;
      for (const f of k.forms) {
        const hit = findSpan(tokens, f, this.opts.fuzzyMaxDistance);
        if (hit && (!best || (best.fuzzy && !hit.fuzzy))) {
          best = { keyword: k.keyword, variant: hit.span, form: f.form, fuzzy: hit.fuzzy };
          if (!hit.fuzzy) break;
        }
      }
      if (!best) continue;
      if (k.negatives.some((n) => findSpan(tokens, n, 0))) continue;
      out.push(best);
    }
    return out;
  }

  match(text: string | PreparedText): MatchResult | null {
    return this.matchAll(text)[0] ?? null;
  }
}

/** Exact (non-fuzzy) phrase containment with word boundaries — used for secondary terms. */
export function containsAnyTerm(text: string | PreparedText, terms: string[]): boolean {
  const { tokens } = typeof text === 'string' ? prepareText(text) : text;
  return terms.some((t) => {
    const c = compact(t);
    if (!c) return false;
    return findSpan(tokens, { form: t, compact: c, maxSpan: normalize(t).split(' ').length + 2, fuzzy: false }, 0) !== null;
  });
}
