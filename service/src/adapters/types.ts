import type { Target } from '../db/targets.js';

export type { Target };

export interface HealthStatus {
  ok: boolean;
  /** rate_limited = Facebook soft block ("You're temporarily blocked", "going too fast"). */
  status: 'ok' | 'login_required' | 'checkpoint' | 'rate_limited' | 'not_configured' | 'error';
  detail?: string;
}

/** Page-load budget shared across a run; enforced as a hard stop (spec §14). */
export interface PageLoadBudget {
  readonly remaining: number;
  readonly used: number;
  /** Consume one page load. Returns false (and consumes nothing) if exhausted. */
  tryConsume(): boolean;
}

export interface ScanContext {
  /** Identifies the run, so adapters can reset per-run counters (e.g. API request caps). */
  runId: number;
  cutoffTime: Date;
  /** Newest post time from the last run, already minus the overlap. */
  watermark?: Date;
  maxPosts: number;
  maxScrolls: number;
  stopAfterConsecutiveSeen: number;
  isSeen(key: string): boolean;
  /** Browser page-load budget. Only adapters with `usesPageBudget` consume it. */
  budget: PageLoadBudget;
  signal: AbortSignal;
  now: Date;
  timezone: string;
}

export interface CommentExpandOptions {
  maxExpansions: number;
}

export interface RawItem {
  type: 'post' | 'comment';
  itemKey: string;
  /** Secondary, time-independent key also checked for dedup (see keys.contentAlias). */
  aliasKey?: string | null;
  parentKey?: string;
  url: string;
  /** Where the post lives, when it differs from the target (search hits: group or subreddit). */
  sourceName?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  authorName: string;
  text: string;
  postedAt: Date;
  /** True when the timestamp label could not be parsed and `postedAt` is the scan time. */
  postedAtApprox?: boolean;
  reactionCount?: number;
  commentCount?: number;
  isPinned?: boolean;
  /**
   * Comments the adapter already fetched for this post (e.g. a subreddit's comment stream).
   * The runner checks these even when the post itself was seen before.
   */
  comments?: RawItem[];
  /** Adapter-internal handle used for screenshots / comment expansion. */
  elementHandle?: unknown;
}

export interface SourceAdapter {
  /** `${platform}_${kind}`, e.g. facebook_group, reddit_search. */
  id: string;
  platform: string;
  /** True for browser adapters that consume the Facebook page-load budget. */
  usesPageBudget: boolean;
  /** False when required credentials are missing; such targets are skipped. */
  isConfigured(): boolean;
  /** Optional human-like break before scanning the next target on this platform. */
  pauseBetweenTargets?(signal?: AbortSignal): Promise<void>;
  /** Called once per run before the health check (reset per-run counters). */
  beginRun?(runId: number): void;
  healthCheck(): Promise<HealthStatus>;
  /** Optional live connectivity check for `doctor --live` (one cheap request; never Facebook). */
  probe?(): Promise<HealthStatus>;
  scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem>;
  expandComments(post: RawItem, ctx: ScanContext, opts: CommentExpandOptions): AsyncGenerator<RawItem>;
  /**
   * Screenshot the item's element. Returns raw PNG bytes; the capturer compresses
   * and writes them (spec §9.1). Optional: API-based sources (Reddit) have none.
   */
  captureScreenshot?(item: RawItem): Promise<Buffer>;
}
