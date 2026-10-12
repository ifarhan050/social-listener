import { toZonedIso } from '../util/tz.js';
import type { Payload } from './index.js';

/** Which find items go into an export. */
export type ExportInclude = 'kept' | 'labelled' | 'all';

export interface ExportItem {
  item_key: string;
  label: string | null;
  keep: number | null;
  reason: string | null;
  saved: number;
  payload: Payload;
}

export const CSV_COLUMNS = [
  'row_type',
  'job_id',
  'mission',
  'item_key',
  'parent_item_key',
  'label',
  'kept',
  'saved_to_captures',
  'reason',
  'platform',
  'source',
  'source_url',
  'author',
  'posted_at',
  'date_unknown',
  'url',
  'text',
  'reactions',
  'comment_count',
  'matched_terms',
  'found_via',
] as const;

type Row = Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null>;

/**
 * One CSV cell (RFC 4180). Cells starting with = + - @ (or tab/CR) are prefixed with `'`
 * so spreadsheet apps don't evaluate post text as a formula.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Find-job results as CSV: one row per post, followed by its collected comments
 * (row_type=comment, parent_item_key = the post; label/kept inherited from the post).
 * UTF-8 with BOM and CRLF line endings, so Excel opens Urdu text correctly.
 */
export function findCsv(
  items: ExportItem[],
  opts: { jobId: number; mission: string; include: ExportInclude; timezone: string },
): { csv: string; rows: number } {
  const chosen = items
    .filter((i) => (opts.include === 'kept' ? i.keep === 1 : opts.include === 'labelled' ? i.label !== null : true))
    .sort((a, b) => (b.payload.posted_at ?? '').localeCompare(a.payload.posted_at ?? ''));
  const when = (iso: string | null) => (iso ? toZonedIso(new Date(iso), opts.timezone) : null);
  const out: Row[] = [];
  for (const i of chosen) {
    const p = i.payload;
    const shared = {
      job_id: opts.jobId,
      mission: opts.mission,
      label: i.label,
      kept: i.keep === null ? null : i.keep === 1,
      saved_to_captures: i.saved === 1,
      platform: p.platform,
      source: p.source,
      source_url: p.source_url,
      matched_terms: p.matched_terms.join('; '),
      found_via: p.step,
    };
    out.push({
      ...shared,
      row_type: 'post',
      item_key: i.item_key,
      parent_item_key: null,
      reason: i.reason,
      author: p.author,
      posted_at: when(p.posted_at),
      date_unknown: p.date_unknown,
      url: p.url,
      text: p.text,
      reactions: p.reactions,
      comment_count: p.comment_count,
    });
    p.comments.forEach((c, n) =>
      out.push({
        ...shared,
        row_type: 'comment',
        item_key: `${i.item_key}#c${n + 1}`,
        parent_item_key: i.item_key,
        reason: null,
        author: c.author,
        posted_at: when(c.posted_at),
        date_unknown: !c.posted_at,
        url: c.url,
        text: c.text,
        reactions: null,
        comment_count: null,
      }),
    );
  }
  const lines = [CSV_COLUMNS.join(','), ...out.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))];
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: out.length };
}
