export type FacebookTargetKind = 'group' | 'page' | 'search' | 'group_search';

/** First path segments that are Facebook features, not page usernames. */
const RESERVED = new Set([
  'search', 'watch', 'marketplace', 'events', 'gaming', 'login', 'login.php', 'help', 'settings',
  'messages', 'notifications', 'friends', 'bookmarks', 'saved', 'reel', 'reels', 'stories', 'story.php',
  'photo', 'photo.php', 'permalink.php', 'hashtag', 'share', 'sharer', 'policies', 'privacy', 'ads',
  'business', 'fundraisers', 'memories', 'live', 'news', 'feeds', 'home.php', 'dialog', 'checkpoint',
]);

const isFacebookHost = (h: string) => /(^|\.)facebook\.com$/i.test(h) || /^fb\.com$/i.test(h);

/**
 * Classify and normalize a user-supplied target URL.
 *   /groups/<id-or-slug>            → group
 *   /profile.php?id=<n>             → page (also used by many business profiles)
 *   /pages/<name>/<id>              → page
 *   /<username>                     → page
 * Throws with a helpful message for anything else.
 */
export function classifyTargetUrl(input: string): { kind: 'group' | 'page'; url: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error('not a valid URL');
  }
  if (!isFacebookHost(u.hostname)) throw new Error('URL must be on facebook.com');
  const segs = u.pathname.split('/').filter(Boolean);

  if (segs[0]?.toLowerCase() === 'groups') {
    if (!segs[1]) throw new Error('expected https://www.facebook.com/groups/<id-or-slug>');
    return { kind: 'group', url: `https://www.facebook.com/groups/${segs[1]}` };
  }
  if (segs[0]?.toLowerCase() === 'profile.php') {
    const id = u.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) throw new Error('profile.php URL needs a numeric ?id=');
    return { kind: 'page', url: `https://www.facebook.com/profile.php?id=${id}` };
  }
  if (segs[0]?.toLowerCase() === 'pages' && segs.length >= 2) {
    return { kind: 'page', url: `https://www.facebook.com/${segs.slice(0, 3).join('/')}` };
  }
  if (segs.length >= 1 && !RESERVED.has(segs[0].toLowerCase()) && /^[A-Za-z0-9.\-_]+$/.test(segs[0])) {
    return { kind: 'page', url: `https://www.facebook.com/${segs[0]}` };
  }
  throw new Error(
    'expected a group (facebook.com/groups/<id>) or page (facebook.com/<page-name> or profile.php?id=<n>) URL',
  );
}

/** The URL actually loaded for a scan. */
export function feedUrl(targetUrl: string, kind: FacebookTargetKind): string {
  if (kind === 'group_search' || kind === 'search') return targetUrl; // already a complete search URL
  const u = new URL(targetUrl);
  u.hash = '';
  if (kind === 'group') {
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '') + '/';
    // Chronological ("New posts"), never "Most relevant" (spec §6.2).
    u.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
  } else if (kind === 'page') {
    // Page timelines are already newest-first. Keep only profile.php's id.
    const id = u.pathname.endsWith('profile.php') ? u.searchParams.get('id') : null;
    u.search = '';
    if (id) u.searchParams.set('id', id);
  }
  return u.toString();
}

/** Search inside one group: https://www.facebook.com/groups/<id>/search/?q=<kw>. */
export function groupSearchUrl(groupUrl: string, q: string): string {
  const u = new URL(groupUrl);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/search/';
  u.search = '';
  u.hash = '';
  u.searchParams.set('q', q);
  return u.toString();
}

/** Facebook's "Recent posts" search filter, as the site encodes it. */
const RECENT_FILTER = Buffer.from(JSON.stringify({ 'recent_posts:0': JSON.stringify({ name: 'recent_posts', args: '' }) })).toString('base64');

/** Generic post search for a keyword, Recent filter on (spec §6.4). */
export function searchUrl(keyword: string, opts: { year?: number } = {}): string {
  const u = new URL('https://www.facebook.com/search/posts/');
  u.searchParams.set('q', keyword);
  u.searchParams.set('filters', opts.year ? yearFilter(opts.year) : RECENT_FILTER);
  return u.toString();
}

/**
 * Facebook's "Date posted" year filter for post search, as the site encodes it.
 * Best-effort: used by /find for ranges older than find.facebook_max_days.
 */
export function yearFilter(year: number): string {
  const args = JSON.stringify({
    start_year: String(year),
    start_month: `${year}-1`,
    end_year: String(year),
    end_month: `${year}-12`,
    start_day: `${year}-1-1`,
    end_day: `${year}-12-31`,
  });
  return Buffer.from(JSON.stringify({ 'rp_creation_time:0': JSON.stringify({ name: 'creation_time', args }) })).toString('base64');
}
