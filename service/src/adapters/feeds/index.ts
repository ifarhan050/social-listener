import type { Config } from '../../config/schema.js';
import type { Keyword } from '../../db/keywords.js';
import { normalize } from '../../matcher/normalize.js';
import { sha256 } from '../facebook/keys.js';
import type { CommentExpandOptions, HealthStatus, RawItem, ScanContext, SourceAdapter, Target } from '../types.js';
import { HttpClient, HttpError } from './http.js';
import { canonicalLink, hostOf } from './links.js';
import { parseFeed, type Feed, type FeedItem } from './rss.js';

export * from './http.js';
export * from './links.js';
export * from './rss.js';

const URDU = /[؀-ۿ]/;

/** Target URL that identifies a keyword's news search (the Google News RSS query). */
export function newsSearchUrl(keyword: string): string {
  const u = new URL('https://news.google.com/rss/search');
  u.searchParams.set('q', keyword);
  return u.toString();
}

export function googleNewsUrl(q: string, edition: { hl: string; gl: string; ceid: string }): string {
  const u = new URL('https://news.google.com/rss/search');
  u.searchParams.set('q', q);
  u.searchParams.set('hl', edition.hl);
  u.searchParams.set('gl', edition.gl);
  u.searchParams.set('ceid', edition.ceid);
  return u.toString();
}

export function bingNewsUrl(q: string): string {
  const u = new URL('https://www.bing.com/news/search');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'rss');
  return u.toString();
}

/** Stable key for an article, and a title alias so the same story from two engines is captured once. */
export function articleKeys(item: FeedItem): { itemKey: string; aliasKey: string | null } {
  const link = canonicalLink(item.link || item.id);
  const title = normalize(item.title);
  return {
    itemKey: `news:${sha256(link).slice(0, 24)}`,
    aliasKey: title.length >= 20 ? `news:t:${sha256(title).slice(0, 24)}` : null,
  };
}

/** Google News titles end with " - Publisher"; drop it. */
const cleanTitle = (title: string, source: string | null) =>
  source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title;

export function newsItemToRaw(item: FeedItem, now: Date): RawItem {
  const title = cleanTitle(item.title, item.sourceName);
  // Alias on the cleaned title so Google's "Headline - Publisher" matches Bing's "Headline".
  const { itemKey, aliasKey } = articleKeys({ ...item, title });
  const source = item.sourceName ?? hostOf(item.link);
  const body = item.content || item.summary;
  // Google News descriptions often just repeat the title + source.
  const extra = body && !normalize(body).startsWith(normalize(title)) ? body : '';
  const sourceUrl = item.sourceUrl ?? (hostOf(item.link) ? `https://${hostOf(item.link)}` : null);
  return {
    type: 'post',
    itemKey,
    aliasKey,
    // Bing links are unwrapped to the article; Google News redirect links still open the article.
    url: /(^|\.)bing\.com$/i.test(hostOf(item.link) ?? '') ? canonicalLink(item.link) : item.link,
    sourceName: source,
    sourceUrl,
    sourceType: 'news',
    authorName: item.author ?? source ?? '',
    text: extra ? `${title}\n\n${extra}` : title,
    postedAt: item.published ?? now,
    postedAtApprox: !item.published,
    commentCount: 0,
  };
}

/**
 * Feeds aren't strictly chronological (search feeds are relevance-ranked), so collect,
 * filter by cutoff/watermark, sort newest first and cap — never "stop at first old".
 */
function* recentItems(items: RawItem[], ctx: ScanContext): Generator<RawItem> {
  const seen = new Set<string>();
  const fresh = items
    .filter((i) => i.postedAtApprox || (i.postedAt >= ctx.cutoffTime && (!ctx.watermark || i.postedAt >= ctx.watermark)))
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  let n = 0;
  for (const i of fresh) {
    if (seen.has(i.itemKey) || (i.aliasKey && seen.has(i.aliasKey))) continue;
    seen.add(i.itemKey);
    if (i.aliasKey) seen.add(i.aliasKey);
    yield i;
    if (++n >= ctx.maxPosts) return;
  }
}

/** Google News + Bing News RSS search per keyword. No account, no key. */
export class NewsSearchAdapter implements SourceAdapter {
  readonly id = 'news_search';
  readonly platform = 'news';
  readonly usesPageBudget = false;

  constructor(
    private http: HttpClient,
    private getConfig: () => Config,
    private getKeywords: () => Keyword[],
  ) {}

  isConfigured(): boolean {
    return true; // no credentials needed; on/off is platforms.news, checked by the runner
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, status: 'ok' };
  }

  /** Live check: fetch one feed. */
  async probe(): Promise<HealthStatus> {
    try {
      parseFeed(await this.http.text(bingNewsUrl('bank')));
      return { ok: true, status: 'ok' };
    } catch (err) {
      return { ok: false, status: 'error', detail: (err as Error).message };
    }
  }

  /** Feed URLs to query for a target keyword (plus Urdu-edition variants when configured). */
  /** Feed URLs for a keyword. With a date range, Google News gets `after:`/`before:` operators (Bing is filtered locally). */
  feedUrls(keyword: string, range: { after?: string | null; before?: string | null } = {}): string[] {
    const cfg = this.getConfig().news;
    const urls: string[] = [];
    const ops = [range.after ? `after:${range.after}` : '', range.before ? `before:${range.before}` : ''].filter(Boolean).join(' ');
    if (cfg.engines.includes('google_news')) urls.push(googleNewsUrl(ops ? `${keyword} ${ops}` : keyword, cfg.region));
    if (cfg.engines.includes('bing_news')) urls.push(bingNewsUrl(keyword));
    if (cfg.urdu_edition && cfg.engines.includes('google_news')) {
      const kw = this.getKeywords().find((k) => k.keyword === keyword);
      for (const v of kw?.variants.filter((x) => URDU.test(x)) ?? [])
        urls.push(googleNewsUrl(v, { hl: 'ur', gl: 'PK', ceid: 'PK:ur' }));
    }
    return urls;
  }

  async *scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem> {
    const params = new URL(target.url).searchParams;
    const keyword = params.get('q');
    if (!keyword) throw new Error(`news target has no query: ${target.url}`);
    const items: RawItem[] = [];
    const errors: string[] = [];
    // Optional date range (used by /find): ?after=YYYY-MM-DD&before=YYYY-MM-DD on the target URL.
    for (const url of this.feedUrls(keyword, { after: params.get('after'), before: params.get('before') })) {
      if (ctx.signal.aborted) return;
      try {
        const feed = parseFeed(await this.http.text(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml' }));
        items.push(...feed.items.map((i) => newsItemToRaw(i, ctx.now)));
      } catch (err) {
        errors.push(`${hostOf(url)}: ${(err as Error).message}`);
      }
    }
    if (!items.length && errors.length) throw new Error(`all news feeds failed (${errors.join('; ')})`);
    yield* recentItems(items, ctx);
  }

  async *expandComments(_post: RawItem, _ctx: ScanContext, _opts: CommentExpandOptions): AsyncGenerator<RawItem> {}
}

// --- Custom RSS/Atom feeds -------------------------------------------------------------

export function feedItemToRaw(item: FeedItem, feedUrl: string, feedTitle: string | null, now: Date): RawItem {
  const id = item.id || item.link || item.title;
  const body = item.content || item.summary;
  return {
    type: 'post',
    itemKey: `rss:${sha256(feedUrl).slice(0, 10)}:${sha256(id).slice(0, 24)}`,
    url: item.link || feedUrl,
    sourceName: feedTitle ?? hostOf(feedUrl),
    sourceUrl: feedUrl,
    sourceType: 'feed',
    authorName: item.author ?? feedTitle ?? hostOf(feedUrl) ?? '',
    text: body ? `${item.title}\n\n${body}` : item.title,
    postedAt: item.published ?? now,
    postedAtApprox: !item.published,
    commentCount: 0,
  };
}

/** Fetch a URL once and check it's an RSS/Atom feed. Used when adding a feed target. */
export async function validateFeed(http: HttpClient, url: string): Promise<Feed> {
  let body: string;
  try {
    body = await http.text(url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
  } catch (err) {
    throw new Error(`could not fetch ${url}: ${(err as Error).message}`);
  }
  if (/^\s*<!doctype html|^\s*<html/i.test(body))
    throw new Error('that URL is a web page, not an RSS/Atom feed — look for a "RSS" link or a URL ending in /feed or .rss');
  return parseFeed(body);
}

export class RssFeedAdapter implements SourceAdapter {
  readonly id = 'rss_feed';
  readonly platform = 'rss';
  readonly usesPageBudget = false;

  constructor(
    private http: HttpClient,
    private getConfig: () => Config,
  ) {}

  isConfigured(): boolean {
    return true; // no credentials needed; on/off is platforms.rss, checked by the runner
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, status: 'ok' };
  }

  async *scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem> {
    let feed: Feed;
    try {
      feed = parseFeed(await this.http.text(target.url, { signal: ctx.signal }));
    } catch (err) {
      if (err instanceof HttpError) throw new Error(`feed fetch failed (${err.status})`);
      throw err;
    }
    yield* recentItems(
      feed.items.map((i) => feedItemToRaw(i, target.url, target.name ?? feed.title, ctx.now)),
      ctx,
    );
  }

  async *expandComments(_post: RawItem, _ctx: ScanContext, _opts: CommentExpandOptions): AsyncGenerator<RawItem> {}
}
