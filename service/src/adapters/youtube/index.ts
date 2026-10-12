import type { Config } from '../../config/schema.js';
import type { SettingsRepo } from '../../db/settings.js';
import { localDateString } from '../../util/tz.js';
import { logger } from '../../util/logger.js';
import type { CommentExpandOptions, HealthStatus, RawItem, ScanContext, SourceAdapter, Target } from '../types.js';
import { HttpClient, HttpError } from '../feeds/http.js';

const API = 'https://www.googleapis.com/youtube/v3/';

/** Quota cost per endpoint (YouTube Data API v3). */
export const QUOTA_COST: Record<string, number> = {
  search: 100,
  videos: 1,
  channels: 1,
  playlistItems: 1,
  commentThreads: 1,
  i18nLanguages: 1,
};

export class QuotaExhausted extends Error {
  constructor() {
    super('YouTube daily quota cap reached');
  }
}

/** Daily quota usage, tracked in settings. YouTube quota resets at midnight Pacific time. */
export class YouTubeQuota {
  private static KEY = 'youtube_quota';
  constructor(
    private settings: SettingsRepo,
    private cap: () => number,
    private now: () => Date = () => new Date(),
  ) {}

  private today() {
    return localDateString(this.now(), 'America/Los_Angeles');
  }

  used(): number {
    const q = this.settings.get<{ date: string; used: number }>(YouTubeQuota.KEY);
    return q?.date === this.today() ? q.used : 0;
  }

  remaining(): number {
    return Math.max(0, this.cap() - this.used());
  }

  /** Reserve units before a call; throws when the cap would be exceeded. */
  take(units: number): void {
    if (this.used() + units > this.cap()) throw new QuotaExhausted();
    this.settings.set(YouTubeQuota.KEY, { date: this.today(), used: this.used() + units });
  }
}

interface Snippet {
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
}
interface Video {
  id: string;
  snippet: Snippet;
  statistics?: { commentCount?: string; likeCount?: string };
}
interface CommentSnippet {
  textOriginal?: string;
  textDisplay: string;
  authorDisplayName: string;
  publishedAt: string;
  likeCount?: number;
}
interface CommentThread {
  id: string;
  snippet: { videoId: string; topLevelComment: { id: string; snippet: CommentSnippet } };
  replies?: { comments: { id: string; snippet: CommentSnippet }[] };
}

export const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const youtubeSearchUrl = (keyword: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`;

export function videoToItem(v: Video): RawItem {
  const s = v.snippet;
  return {
    type: 'post',
    itemKey: `youtube:video:${v.id}`,
    url: videoUrl(v.id),
    sourceName: s.channelTitle,
    sourceUrl: `https://www.youtube.com/channel/${s.channelId}`,
    sourceType: 'youtube_channel',
    authorName: s.channelTitle,
    text: s.description ? `${s.title}\n\n${s.description}` : s.title,
    postedAt: new Date(s.publishedAt),
    commentCount: v.statistics?.commentCount !== undefined ? Number(v.statistics.commentCount) : undefined,
    reactionCount: v.statistics?.likeCount !== undefined ? Number(v.statistics.likeCount) : undefined,
    elementHandle: { videoId: v.id },
  };
}

function commentToItem(videoId: string, id: string, c: CommentSnippet, post: RawItem): RawItem {
  return {
    type: 'comment',
    itemKey: `youtube:comment:${videoId}:${id}`,
    parentKey: post.itemKey,
    url: `${videoUrl(videoId)}&lc=${id}`,
    authorName: c.authorDisplayName,
    text: c.textOriginal ?? c.textDisplay,
    postedAt: new Date(c.publishedAt),
    reactionCount: c.likeCount,
  };
}

/** `https://www.youtube.com/@handle`, `/channel/UC…`, `/user/name` → lookup parameters. */
export function channelRef(url: string): { forHandle: string } | { id: string } | { forUsername: string } | null {
  const p = new URL(url).pathname;
  let m = p.match(/^\/@([\w.\-]+)/);
  if (m) return { forHandle: `@${m[1]}` };
  m = p.match(/^\/channel\/(UC[\w-]{20,})/);
  if (m) return { id: m[1] };
  m = p.match(/^\/user\/([\w.\-]+)/);
  if (m) return { forUsername: m[1] };
  return null;
}

/**
 * YouTube via the official Data API v3 (API key, no account login).
 *   search  — newest videos matching each keyword (+ their comments when relevant)
 *   channel — a channel's latest uploads and their comments
 * Every call reserves quota first; the run stops cleanly at the daily cap.
 */
export class YouTubeAdapter implements SourceAdapter {
  readonly id: string;
  readonly platform = 'youtube';
  readonly usesPageBudget = false;
  private uploadsCache = new Map<string, string>();

  constructor(
    readonly kind: 'search' | 'channel',
    private apiKey: string | null,
    private http: HttpClient,
    private quota: YouTubeQuota,
    private getConfig: () => Config,
  ) {
    this.id = `youtube_${kind}`;
  }

  isConfigured(): boolean {
    return !!this.apiKey; // on/off is platforms.youtube, checked by the runner
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.apiKey) return { ok: false, status: 'not_configured', detail: 'set YOUTUBE_API_KEY in service/.env' };
    if (this.quota.remaining() < QUOTA_COST.search)
      return { ok: false, status: 'error', detail: `daily quota cap reached (${this.quota.used()} units used)` };
    return { ok: true, status: 'ok' };
  }

  async probe(): Promise<HealthStatus> {
    if (!this.apiKey) return this.healthCheck();
    try {
      await this.call('i18nLanguages', { part: 'snippet', hl: 'en' });
      return { ok: true, status: 'ok' };
    } catch (err) {
      return { ok: false, status: 'error', detail: (err as Error).message };
    }
  }

  private async call<T>(endpoint: keyof typeof QUOTA_COST, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    this.quota.take(QUOTA_COST[endpoint]);
    const u = new URL(endpoint, API);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    u.searchParams.set('key', this.apiKey!);
    try {
      return await this.http.json<T>(u.toString(), { signal });
    } catch (err) {
      // Never surface the key in errors/logs.
      if (err instanceof HttpError) throw new HttpError(err.status, `YouTube API ${endpoint} failed (${err.status})`);
      throw err;
    }
  }

  /** Fetch full snippets + statistics for up to 50 ids (search results have truncated descriptions). */
  private async videos(ids: string[], signal: AbortSignal): Promise<Video[]> {
    if (!ids.length) return [];
    const res = await this.call<{ items: Video[] }>('videos', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 }, signal);
    const byId = new Map(res.items.map((v) => [v.id, v]));
    return ids.map((id) => byId.get(id)).filter((v): v is Video => !!v);
  }

  private async uploadsPlaylist(target: Target, signal: AbortSignal): Promise<string> {
    const cached = this.uploadsCache.get(target.url);
    if (cached) return cached;
    const ref = channelRef(target.url);
    if (!ref) throw new Error(`not a YouTube channel URL: ${target.url}`);
    const res = await this.call<{ items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
      'channels',
      { part: 'contentDetails', ...ref },
      signal,
    );
    const uploads = res.items?.[0]?.contentDetails.relatedPlaylists.uploads;
    if (!uploads) throw new Error(`YouTube channel not found: ${target.url}`);
    this.uploadsCache.set(target.url, uploads);
    return uploads;
  }

  async *scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem> {
    const since = ctx.watermark && ctx.watermark > ctx.cutoffTime ? ctx.watermark : ctx.cutoffTime;
    try {
      let ids: string[];
      if (this.kind === 'search') {
        const q = new URL(target.url).searchParams.get('search_query');
        if (!q) throw new Error(`YouTube search target has no query: ${target.url}`);
        const res = await this.call<{ items: { id: { videoId?: string } }[] }>(
          'search',
          {
            part: 'snippet',
            type: 'video',
            order: 'date',
            q,
            publishedAfter: since.toISOString(),
            // Optional end of a date range (used by /find): ?before=ISO on the target URL.
            publishedBefore: new URL(target.url).searchParams.get('before') ?? undefined,
            regionCode: this.getConfig().youtube.region_code,
            maxResults: Math.min(50, ctx.maxPosts),
          },
          ctx.signal,
        );
        ids = res.items.map((i) => i.id.videoId).filter((x): x is string => !!x);
      } else {
        const playlistId = await this.uploadsPlaylist(target, ctx.signal);
        const res = await this.call<{ items: { contentDetails: { videoId: string; videoPublishedAt?: string } }[] }>(
          'playlistItems',
          { part: 'contentDetails', playlistId, maxResults: Math.min(50, ctx.maxPosts) },
          ctx.signal,
        );
        ids = res.items
          .filter((i) => !i.contentDetails.videoPublishedAt || new Date(i.contentDetails.videoPublishedAt) >= since)
          .map((i) => i.contentDetails.videoId);
      }
      let consecutiveSeen = 0;
      for (const v of await this.videos(ids, ctx.signal)) {
        const item = videoToItem(v);
        if (item.postedAt < since) continue;
        consecutiveSeen = ctx.isSeen(item.itemKey) ? consecutiveSeen + 1 : 0;
        yield item;
        if (consecutiveSeen >= ctx.stopAfterConsecutiveSeen) return;
      }
    } catch (err) {
      if (err instanceof QuotaExhausted) {
        logger.info({ target: target.url }, 'YouTube quota cap reached — stopping target');
        return;
      }
      throw err;
    }
  }

  async *expandComments(post: RawItem, ctx: ScanContext, _opts: CommentExpandOptions): AsyncGenerator<RawItem> {
    const videoId = (post.elementHandle as { videoId?: string } | undefined)?.videoId;
    if (!videoId) return;
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < this.getConfig().youtube.max_comment_pages && !ctx.signal.aborted; page++) {
        const res = await this.call<{ items: CommentThread[]; nextPageToken?: string }>(
          'commentThreads',
          { part: 'snippet,replies', videoId, order: 'time', maxResults: 100, textFormat: 'plainText', pageToken },
          ctx.signal,
        );
        let older = false;
        for (const t of res.items) {
          const top = t.snippet.topLevelComment;
          const topItem = commentToItem(videoId, top.id, top.snippet, post);
          if (topItem.postedAt < ctx.cutoffTime) older = true;
          else yield topItem;
          for (const r of t.replies?.comments ?? []) {
            const ri = commentToItem(videoId, r.id, r.snippet, post);
            if (ri.postedAt >= ctx.cutoffTime) yield ri;
          }
        }
        pageToken = res.nextPageToken;
        if (!pageToken || older) return; // newest first: older page means we're done
      }
    } catch (err) {
      if (err instanceof QuotaExhausted) return;
      if (err instanceof HttpError && err.status === 403) return; // comments disabled
      throw err;
    }
  }
}
