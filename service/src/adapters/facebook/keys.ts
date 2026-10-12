import { createHash } from 'node:crypto';
import { normalize } from '../../matcher/normalize.js';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const toUrl = (href: string): URL | null => {
  try {
    return new URL(href, 'https://www.facebook.com');
  } catch {
    return null;
  }
};

/**
 * Extract a post ID from any Facebook permalink form (spec §8.1):
 *   /groups/<g>/posts/<id>/   /groups/<g>/permalink/<id>/   /<page>/posts/<id>
 *   /permalink.php?story_fbid=<id>&id=…   /story.php?story_fbid=<id>
 *   /photo/?fbid=<id>   /watch/?v=<id>   /<page>/videos/<id>
 * IDs may be numeric or `pfbid…`.
 */
export function extractPostId(href: string): string | null {
  const u = toUrl(href);
  if (!u || !/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, '');

  const m = path.match(/\/(?:posts|permalink|videos)\/(pfbid[0-9A-Za-z]+|\d+)/i);
  if (m) return m[1];

  const qp = u.searchParams.get('story_fbid') ?? u.searchParams.get('fbid') ?? u.searchParams.get('v');
  if (qp && /^(pfbid[0-9A-Za-z]+|\d+)$/.test(qp)) return qp;

  return null;
}

/** Group ID or slug from a group URL. */
export function extractGroupId(href: string): string | null {
  const u = toUrl(href);
  const m = u?.pathname.match(/\/groups\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/**
 * Comment ID from `comment_id` / `reply_comment_id`. Newer links carry a base64
 * value that decodes to `comment:<postId>_<commentId>`.
 */
export function extractCommentId(href: string): string | null {
  const u = toUrl(href);
  if (!u) return null;
  const raw = u.searchParams.get('reply_comment_id') ?? u.searchParams.get('comment_id');
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const m = decoded.match(/^comment:\d+_(\d+)$/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return /^[0-9A-Za-z_-]+$/.test(raw) ? raw : null;
}

/** Canonical permalink without query params or fragments. */
export function canonicalUrl(href: string): string {
  const u = toUrl(href);
  if (!u) return href;
  const keep = ['story_fbid', 'fbid', 'v', 'id'];
  const kept = new URLSearchParams();
  for (const k of keep) {
    const v = u.searchParams.get(k);
    if (v && (k !== 'id' || u.pathname.endsWith('.php'))) kept.set(k, v);
  }
  const q = kept.toString();
  return `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
}

export const postKey = (postId: string) => `fb:post:${postId}`;
export const commentKey = (postId: string, commentId: string) => `fb:comment:${postId}:${commentId}`;

/** Fallback key when no ID can be parsed (spec §8.1). */
export function fallbackKey(type: 'post' | 'comment', authorName: string, text: string, postedAt: Date): string {
  const minute = new Date(Math.floor(postedAt.getTime() / 60000) * 60000).toISOString();
  return `fb:${type}:h:${sha256(`${authorName}\u0000${normalize(text)}\u0000${minute}`).slice(0, 32)}`;
}

/**
 * Time-independent content alias. Facebook can show the same post with a numeric
 * ID on one load and a pfbid on the next; checking this alias too keeps such posts unique.
 */
export function contentAlias(_authorName: string, text: string): string | null {
  // Text only: on live Facebook the author is sometimes read as the group name, which made the
  // same post look new. Long enough texts are distinctive on their own.
  const n = normalize(text);
  if (n.length < 40) return null; // too short to be distinctive
  return `fb:alias:t:${sha256(n).slice(0, 32)}`;
}

/** Pick the most stable post ID among candidate hrefs: numeric beats pfbid. */
export function bestPostId(hrefs: string[]): string | null {
  const ids = hrefs.map(extractPostId).filter((x): x is string => !!x);
  return ids.find((id) => /^\d+$/.test(id)) ?? ids[0] ?? null;
}
