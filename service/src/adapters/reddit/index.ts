import type { Config } from '../../config/schema.js';
import { logger } from '../../util/logger.js';
import type { CommentExpandOptions, HealthStatus, RawItem, ScanContext, SourceAdapter, Target } from '../types.js';
import { RedditApiError, RedditBudgetExhausted, type RedditClient } from './client.js';

export * from './client.js';

// --- Reddit API shapes (only the fields we use) ---------------------------------

export interface RedditPost {
  id: string;
  name: string;
  title: string;
  selftext?: string;
  author: string;
  subreddit: string;
  permalink: string;
  created_utc: number;
  score?: number;
  num_comments?: number;
  over_18?: boolean;
  stickied?: boolean;
  removed_by_category?: string | null;
}

export interface RedditComment {
  id: string;
  body: string;
  author: string;
  subreddit: string;
  permalink: string;
  created_utc: number;
  link_id: string;
  link_title?: string;
  link_permalink?: string;
  link_author?: string;
  over_18?: boolean;
  replies?: Listing<RedditComment | MoreStub> | '';
}

interface MoreStub {
  children: string[];
  count?: number;
}

interface Thing<T> {
  kind: string;
  data: T;
}

export interface Listing<T> {
  kind: 'Listing';
  data: { after: string | null; children: Thing<T>[] };
}

// --- Keys & mapping ---------------------------------------------------------------

export const redditPostKey = (id: string) => `reddit:post:${id}`;
export const redditCommentKey = (postId: string, commentId: string) => `reddit:comment:${postId}:${commentId}`;
const stripPrefix = (fullname: string) => fullname.replace(/^t\d_/, '');
const abs = (permalink: string) => `https://www.reddit.com${permalink.replace(/\/+$/, '')}`;
const subUrl = (sub: string) => `https://www.reddit.com/r/${sub}`;

const isRemovedText = (t: string | undefined) => t === '[removed]' || t === '[deleted]';

export function postToItem(p: RedditPost): RawItem {
  const body = isRemovedText(p.selftext) ? '' : (p.selftext ?? '');
  return {
    type: 'post',
    itemKey: redditPostKey(p.id),
    url: abs(p.permalink),
    sourceName: `r/${p.subreddit}`,
    sourceUrl: subUrl(p.subreddit),
    sourceType: 'subreddit',
    authorName: p.author,
    text: body ? `${p.title}\n\n${body}` : p.title,
    postedAt: new Date(p.created_utc * 1000),
    reactionCount: p.score,
    commentCount: p.num_comments,
    isPinned: !!p.stickied,
    elementHandle: { id: p.id },
  };
}

export function commentToItem(c: RedditComment): RawItem {
  const postId = stripPrefix(c.link_id);
  return {
    type: 'comment',
    itemKey: redditCommentKey(postId, c.id),
    parentKey: redditPostKey(postId),
    url: abs(c.permalink),
    sourceName: `r/${c.subreddit}`,
    sourceUrl: subUrl(c.subreddit),
    sourceType: 'subreddit',
    authorName: c.author,
    text: c.body,
    postedAt: new Date(c.created_utc * 1000),
  };
}

/** Post built from the link fields of a comment-stream entry (when /api/info can't return it). */
function postFromCommentLink(c: RedditComment): RawItem {
  const postId = stripPrefix(c.link_id);
  return {
    type: 'post',
    itemKey: redditPostKey(postId),
    url: c.link_permalink ? c.link_permalink.replace(/\/+$/, '') : abs(c.permalink.split('/').slice(0, 6).join('/')),
    sourceName: `r/${c.subreddit}`,
    sourceUrl: subUrl(c.subreddit),
    sourceType: 'subreddit',
    authorName: c.link_author ?? '',
    text: c.link_title ?? '',
    postedAt: new Date(c.created_utc * 1000),
    postedAtApprox: true,
    elementHandle: { id: postId },
  };
}

/** Depth-first flatten of a comment tree; collects `more` stubs for later expansion. */
export function flattenComments(
  children: Thing<RedditComment | MoreStub>[],
  out: RedditComment[] = [],
  more: string[] = [],
): { comments: RedditComment[]; more: string[] } {
  for (const ch of children) {
    if (ch.kind === 'more') {
      more.push(...(ch.data as MoreStub).children);
    } else if (ch.kind === 't1') {
      const c = ch.data as RedditComment;
      out.push(c);
      if (c.replies && typeof c.replies === 'object') flattenComments(c.replies.data.children, out, more);
    }
  }
  return { comments: out, more };
}

/** `https://www.reddit.com/r/<sub>` → `<sub>`; search URL → its `q`. */
export const subredditOf = (url: string) => new URL(url).pathname.match(/^\/r\/([^/]+)/i)?.[1] ?? null;
export const searchQueryOf = (url: string) => new URL(url).searchParams.get('q');

export function redditSearchUrl(keyword: string): string {
  const u = new URL('https://www.reddit.com/search/');
  u.searchParams.set('q', keyword);
  u.searchParams.set('sort', 'new');
  return u.toString();
}

// --- Adapter ----------------------------------------------------------------------

/**
 * Reddit via the official Data API. Two kinds:
 *   search    — site-wide post search, newest first
 *   subreddit — /new posts plus the subreddit's newest-comments stream
 * Read-only; no screenshots (text + metadata captures).
 */
export class RedditAdapter implements SourceAdapter {
  readonly id: string;
  readonly platform = 'reddit';
  readonly usesPageBudget = false;

  constructor(
    readonly kind: 'search' | 'subreddit',
    private client: RedditClient,
    private getConfig: () => Config,
  ) {
    this.id = `reddit_${kind}`;
  }

  isConfigured(): boolean {
    return this.client.configured; // on/off is platforms.reddit, checked by the runner
  }

  beginRun(runId: number): void {
    this.client.beginRun(runId);
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.client.configured) return { ok: false, status: 'not_configured', detail: 'set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in service/.env' };
    try {
      await this.client.check();
      return { ok: true, status: 'ok' };
    } catch (err) {
      return { ok: false, status: 'error', detail: (err as Error).message };
    }
  }

  private skip(nsfw: boolean | undefined, removed: boolean): boolean {
    return removed || (!!nsfw && !this.getConfig().reddit.include_nsfw);
  }

  async *scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem> {
    this.client.beginRun(ctx.runId);
    try {
      if (this.kind === 'search') {
        const q = searchQueryOf(target.url);
        if (!q) throw new Error(`search target has no query: ${target.url}`);
        yield* this.scanPosts('/search', { q, sort: 'new', type: 'link', limit: 100 }, ctx);
      } else {
        const sub = subredditOf(target.url);
        if (!sub) throw new Error(`not a subreddit URL: ${target.url}`);
        yield* this.scanPosts(`/r/${sub}/new`, { limit: 100 }, ctx);
        yield* this.scanCommentStream(sub, ctx);
      }
    } catch (err) {
      if (err instanceof RedditBudgetExhausted) {
        logger.info({ target: target.url }, 'reddit request cap reached — stopping target');
        return;
      }
      throw err;
    }
  }

  private tooOld(t: Date, ctx: ScanContext): boolean {
    return t < ctx.cutoffTime || (!!ctx.watermark && t < ctx.watermark);
  }

  /** Newest-first post listing: stops at the cutoff/watermark, consecutive seen, or max posts. */
  private async *scanPosts(path: string, params: Record<string, string | number>, ctx: ScanContext): AsyncGenerator<RawItem> {
    let after: string | undefined;
    let posts = 0;
    let consecutiveSeen = 0;
    for (let page = 0; page <= ctx.maxScrolls && !ctx.signal.aborted; page++) {
      const listing = await this.client.get<Listing<RedditPost>>(path, { ...params, after }, ctx.signal);
      for (const { data: p } of listing.data.children) {
        if (this.skip(p.over_18, !!p.removed_by_category)) continue;
        const item = postToItem(p);
        if (item.isPinned) {
          yield item;
          continue;
        }
        if (this.tooOld(item.postedAt, ctx)) return;
        consecutiveSeen = ctx.isSeen(item.itemKey) ? consecutiveSeen + 1 : 0;
        yield item;
        if (consecutiveSeen >= ctx.stopAfterConsecutiveSeen) return;
        if (++posts >= ctx.maxPosts) return;
      }
      after = listing.data.after ?? undefined;
      if (!after) return;
    }
  }

  /**
   * The subreddit's newest comments, grouped by post. Each group is yielded as its post
   * (fetched in one /api/info batch) with `comments` attached, so matching comments on
   * older posts are found without crawling every thread.
   */
  private async *scanCommentStream(sub: string, ctx: ScanContext): AsyncGenerator<RawItem> {
    const groups = new Map<string, RedditComment[]>();
    let after: string | undefined;
    let done = false;
    for (let page = 0; page <= ctx.maxScrolls && !done && !ctx.signal.aborted; page++) {
      const listing = await this.client.get<Listing<RedditComment>>(`/r/${sub}/comments`, { limit: 100, after }, ctx.signal);
      for (const { data: c } of listing.data.children) {
        if (this.tooOld(new Date(c.created_utc * 1000), ctx)) {
          done = true;
          break;
        }
        if (this.skip(c.over_18, isRemovedText(c.body))) continue;
        const list = groups.get(c.link_id) ?? [];
        list.push(c);
        groups.set(c.link_id, list);
      }
      after = listing.data.after ?? undefined;
      if (!after) break;
    }
    // Only posts that have at least one unseen comment need yielding.
    const pending = [...groups].filter(([, cs]) => cs.some((c) => !ctx.isSeen(commentToItem(c).itemKey)));
    if (!pending.length) return;

    const posts = new Map<string, RedditPost>();
    for (let i = 0; i < pending.length; i += 100) {
      const ids = pending.slice(i, i + 100).map(([linkId]) => linkId).join(',');
      try {
        const info = await this.client.get<Listing<RedditPost>>('/api/info', { id: ids }, ctx.signal);
        for (const { data } of info.data.children) posts.set(data.name, data);
      } catch (err) {
        if (err instanceof RedditBudgetExhausted) break;
        logger.warn({ err: String(err) }, 'reddit /api/info failed — using link fields from comments');
      }
    }
    for (const [linkId, cs] of pending) {
      const p = posts.get(linkId);
      if (p && this.skip(p.over_18, false)) continue;
      const post = p ? postToItem(p) : postFromCommentLink(cs[0]);
      // isPinned keeps these (older posts with new comments) out of the target's watermark.
      yield { ...post, isPinned: true, comments: cs.map(commentToItem) };
    }
  }

  async *expandComments(post: RawItem, ctx: ScanContext, opts: CommentExpandOptions): AsyncGenerator<RawItem> {
    if (post.comments) {
      yield* post.comments;
      return;
    }
    const id = (post.elementHandle as { id: string } | undefined)?.id;
    if (!id) return;
    try {
      const [, tree] = await this.client.get<[Listing<RedditPost>, Listing<RedditComment | MoreStub>]>(
        `/comments/${id}`,
        { sort: 'new', limit: 200, depth: 10 },
        ctx.signal,
      );
      const { comments, more } = flattenComments(tree.data.children);
      for (const c of comments) if (!isRemovedText(c.body)) yield commentToItem(c);

      // Load "more comments" stubs, at most `maxExpansions` requests of 100 ids.
      for (let i = 0; i < opts.maxExpansions && i * 100 < more.length && !ctx.signal.aborted; i++) {
        const res = await this.client.get<{ json: { data: { things: Thing<RedditComment>[] } } }>(
          '/api/morechildren',
          { api_type: 'json', link_id: `t3_${id}`, children: more.slice(i * 100, i * 100 + 100).join(','), sort: 'new' },
          ctx.signal,
        );
        for (const t of res.json.data.things) if (t.kind === 't1' && !isRemovedText(t.data.body)) yield commentToItem(t.data);
      }
    } catch (err) {
      if (err instanceof RedditBudgetExhausted) return;
      if (err instanceof RedditApiError && err.status === 404) return; // post deleted
      throw err;
    }
  }
}
