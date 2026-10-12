import type { RawItem } from '../types.js';
import {
  bestPostId,
  canonicalUrl,
  commentKey,
  contentAlias,
  extractCommentId,
  extractGroupId,
  extractPostId,
  fallbackKey,
  postKey,
} from './keys.js';
import { parseFacebookTime } from './time.js';

/** Shape returned by EXTRACT_POST. */
export interface RawPostData {
  hrefs: string[];
  permalinkHrefs: string[];
  author: string;
  body: string;
  timeLabels: string[];
  commentCount: string | null;
  reactionCount: string | null;
  isPinned: boolean;
  sourceName?: string | null;
  sourceUrl?: string | null;
}

/** Shape returned per comment by EXTRACT_COMMENTS. */
export interface RawCommentData {
  cid: string;
  hrefs: string[];
  author: string;
  body: string;
  timeLabels: string[];
}

/** "1,234" → 1234, "1.2K" → 1200, "3M" → 3000000. */
export function parseCount(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/\s+/g, '').match(/^([\d.,]+)([KkMm]?)$/);
  if (!m) return undefined;
  const mult = /k/i.test(m[2]) ? 1_000 : /m/i.test(m[2]) ? 1_000_000 : 1;
  const num = mult === 1 ? Number(m[1].replace(/[.,]/g, '')) : Number(m[1].replace(',', '.'));
  return Number.isFinite(num) ? Math.round(num * mult) : undefined;
}

function firstTime(labels: string[], now: Date, tz: string): Date | null {
  for (const l of labels) {
    const d = l ? parseFacebookTime(l, now, tz) : null;
    if (d) return d;
  }
  return null;
}

export function toPostItem(
  data: RawPostData,
  handle: string,
  now: Date,
  tz: string,
  /** Target URL used when the post has no permalink; null for search results. */
  fallbackUrl: string | null,
): RawItem {
  const groupUrl = data.sourceUrl ? extractGroupUrl(data.sourceUrl) : null;
  // Facebook prepends a screen-reader-only 'Facebook' line to some posts.
  data = { ...data, body: data.body.replace(/^Facebook\s*\n+/i, '') };
  const parsed = firstTime(data.timeLabels, now, tz);
  const postedAt = parsed ?? new Date(now);
  const id = bestPostId(data.permalinkHrefs.length ? data.permalinkHrefs : data.hrefs);
  const permalink = id
    ? data.permalinkHrefs.find((h) => extractPostId(h) === id) ?? data.hrefs.find((h) => extractPostId(h) === id)
    : undefined;
  return {
    type: 'post',
    itemKey: id ? postKey(id) : fallbackKey('post', data.author, data.body, postedAt),
    aliasKey: contentAlias(data.author, data.body),
    url: permalink ? canonicalUrl(permalink) : (fallbackUrl ?? groupUrl ?? ''),
    sourceName: groupUrl ? (data.sourceName ?? null) : null,
    sourceUrl: groupUrl,
    authorName: data.author,
    text: data.body,
    postedAt,
    postedAtApprox: !parsed,
    reactionCount: parseCount(data.reactionCount),
    commentCount: parseCount(data.commentCount),
    isPinned: data.isPinned,
    elementHandle: handle,
  };
}

const extractGroupUrl = (href: string): string | null => {
  const g = extractGroupId(href);
  return g ? `https://www.facebook.com/groups/${g}` : null;
};

/** `fb:post:<id>` → `<id>`; fallback keys keep their hash segment. */
export const postIdFromKey = (key: string) => key.replace(/^fb:post:/, '');

export function toCommentItem(data: RawCommentData, post: RawItem, handle: string, now: Date, tz: string): RawItem {
  const parsed = firstTime(data.timeLabels, now, tz);
  const postedAt = parsed ?? new Date(now);
  const cid = data.hrefs.map(extractCommentId).find((x): x is string => !!x) ?? null;
  const postId = postIdFromKey(post.itemKey);
  const link = data.hrefs.find((h) => extractCommentId(h) === cid);
  return {
    type: 'comment',
    itemKey: cid ? commentKey(postId, cid) : fallbackKey('comment', data.author, data.body, postedAt),
    parentKey: post.itemKey,
    url: link ? `${canonicalUrl(link)}${canonicalUrl(link).includes('?') ? '&' : '?'}comment_id=${cid}` : post.url,
    authorName: data.author,
    text: data.body,
    postedAt,
    postedAtApprox: !parsed,
    elementHandle: handle,
  };
}
