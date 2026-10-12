import type { Config } from '../config/schema.js';
import type { ConfigStore, StateStore } from '../config/store.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import { SimpleBudget } from '../adapters/registry.js';
import type { HealthStatus, PageLoadBudget, RawItem, ScanContext, SourceAdapter } from '../adapters/types.js';
import { SessionError } from '../adapters/errors.js';
import type { Capturer, CommentCapture } from '../capture/index.js';
import { containsAnyTerm, prepareText } from '../matcher/index.js';
import { MissionMatcher, ensureLegacyMission, type HitScope } from '../missions/index.js';
import { isWithinActiveHours, startOfLocalDay } from '../util/tz.js';
import { randInt } from '../util/random.js';
import { shuffle } from '../adapters/facebook/human.js';
import { SEARCH_PLATFORMS, dueTargets, syncSearchTargets, type SearchPlatform } from './searchTargets.js';
import { logger } from '../util/logger.js';

export interface RunStatsLive {
  /** Facebook browser page loads (count toward the daily page budget). */
  page_loads: number;
  posts_scanned: number;
  new_captures: number;
  duplicates_skipped: number;
  errors: number;
  new_seen: number;
  /** Facebook posts whose date was read exactly vs. only approximately (doctor warns when approx dominates). */
  fb_dated?: number;
  fb_approx?: number;
}

export interface TargetReport {
  target_id: number;
  platform: string;
  name: string | null;
  posts_scanned: number;
  new_captures: number;
  duplicates_skipped: number;
  new_seen: number;
  error?: string;
}

export interface RunReport {
  run_id: number | null;
  status: 'completed' | 'skipped' | 'aborted' | 'failed';
  reason?: string;
  started_at: string;
  finished_at?: string;
  stats: RunStatsLive;
  targets: TargetReport[];
}

export interface RunOptions {
  targetIds?: number[];
  trigger: 'scheduled' | 'manual';
}

export interface RunnerDeps {
  repos: Repos;
  config: ConfigStore;
  state: StateStore;
  registry: AdapterRegistry;
  capturer: Capturer;
  /** Release browser resources after a run. */
  closeBrowser: () => Promise<void>;
  now?: () => Date;
}

/** After a failed API-platform health check, skip that platform for this long. */
const PLATFORM_RETRY_MINUTES = 30;

/** Budget that also counts toward the run's persisted page_loads. */
export class TrackedBudget implements PageLoadBudget {
  private inner: SimpleBudget;
  constructor(
    limit: number,
    private onUse: () => void,
  ) {
    this.inner = new SimpleBudget(limit);
  }
  get remaining() {
    return this.inner.remaining;
  }
  get used() {
    return this.inner.used;
  }
  tryConsume() {
    const ok = this.inner.tryConsume();
    if (ok) this.onUse();
    return ok;
  }
}

export type Busy = 'scan' | 'connect' | 'report' | 'find' | null;

/**
 * Run orchestrator: one run at a time, targets scanned sequentially. Global gates
 * (busy, active hours) block the whole run; platform gates (Facebook session/budget,
 * Reddit credentials) only skip that platform's targets. Adaptive EMA/UCB scheduling
 * replaces `nextDue` in Phase 2.
 */
export class Runner {
  private _busy: Busy = null;
  private abortCtl: AbortController | null = null;
  private current: RunReport | null = null;
  private last: RunReport | null = null;

  constructor(private deps: RunnerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get busy(): Busy {
    return this._busy;
  }
  get currentRun(): RunReport | null {
    return this.current;
  }
  get lastRun(): RunReport | null {
    return this.last;
  }

  /** Acquire the browser for a non-scan job (e.g. interactive connect). */
  async exclusive<T>(kind: Exclude<Busy, null>, fn: () => Promise<T>): Promise<T> {
    if (this._busy) throw new Error(`busy: ${this._busy} in progress`);
    this._busy = kind;
    try {
      return await fn();
    } finally {
      this._busy = null;
    }
  }

  abort(reason = 'aborted'): void {
    this.abortCtl?.abort(new Error(reason));
  }

  /** Global reasons a run can't start (all platforms). Doesn't consume budget. */
  blockedReason(_cfg: Config, _now: Date): string | null {
    if (this._busy) return `busy: ${this._busy} in progress`;
    return null;
  }

  /** The on/off switch (`platforms.<name>`). Unknown platforms default to on. */
  platformEnabled(platform: string, cfg = this.deps.config.get()): boolean {
    return (cfg.platforms as Record<string, boolean>)[platform] !== false;
  }

  private disabledPlatforms(cfg = this.deps.config.get()): string[] {
    return this.deps.registry.platforms().filter((p) => !this.platformEnabled(p, cfg));
  }

  /** Why targets on `platform` can't be scanned now, or null. Synchronous; no network. */
  platformBlockedReason(platform: string, cfg: Config, now: Date): string | null {
    if (!this.platformEnabled(platform, cfg)) return 'disabled';
    const st = this.deps.state.get();
    if (platform === 'facebook') {
      if (!st.risk_acknowledged) return 'account-risk notice not acknowledged (see dashboard)';
      // Human-like window applies to Facebook only; zero-account sources run any time.
      if (!isWithinActiveHours(now, cfg.timezone, cfg.active_hours))
        return `outside active hours (${cfg.active_hours.start}-${cfg.active_hours.end} ${cfg.timezone})`;
      if (st.paused_until && new Date(st.paused_until) > now)
        return st.paused_reason === 'rate_limited'
          ? `paused after a Facebook soft block until ${st.paused_until}`
          : `paused after checkpoint until ${st.paused_until}; reconnect Facebook to resume`;
      if (st.session_status === 'needs_reconnect') return 'Facebook session needs reconnect';
      if (this.dailyRemaining(cfg, now) <= 0) return 'daily page budget exhausted';
      return null;
    }
    const adapters = this.deps.registry.forPlatform(platform);
    if (!adapters.length) return `no adapter for ${platform}`;
    if (!adapters.some((a) => a.isConfigured())) return `${platform} not configured`;
    const h = st.platform_health[platform];
    if (h?.retry_after && new Date(h.retry_after) > now)
      return `${platform} unavailable (${h.detail ?? h.status}); retrying after ${h.retry_after}`;
    return null;
  }

  /** Per-platform readiness, for status displays. */
  platformStatus(cfg = this.deps.config.get(), now = this.now()): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.deps.registry.platforms()) out[p] = this.platformBlockedReason(p, cfg, now) ?? 'yes';
    return out;
  }

  dailyUsed(cfg: Config, now: Date): number {
    return this.deps.repos.runs.pageLoadsSince(startOfLocalDay(now, cfg.timezone).toISOString());
  }

  dailyRemaining(cfg: Config, now: Date): number {
    return Math.max(0, cfg.fetch.daily_page_budget - this.dailyUsed(cfg, now));
  }

  /** Revisit interval per platform; Facebook search is capped (search.min_interval_hours). */
  intervalHours(cfg: Config, target?: Pick<Target, 'platform' | 'kind'>): number {
    switch (target?.platform) {
      case 'news':
        return cfg.news.interval_hours;
      case 'rss':
        return cfg.rss.interval_hours;
      case 'youtube':
        return cfg.youtube.interval_hours;
      case 'facebook':
        return target.kind === 'search'
          ? Math.max(cfg.fetch.default_interval_hours, cfg.search.min_interval_hours)
          : cfg.fetch.default_interval_hours;
      default:
        return cfg.fetch.default_interval_hours;
    }
  }

  nextDue(cfg: Config, now: Date, target?: Pick<Target, 'platform' | 'kind'>): string {
    const hours = this.intervalHours(cfg, target);
    // Jitter never exceeds a quarter of the interval (short news intervals stay short).
    const j = Math.min(cfg.scheduler.jitter_minutes, Math.floor(hours * 15));
    return new Date(now.getTime() + hours * 3_600_000 + randInt(-j, j) * 60_000).toISOString();
  }

  /** Platforms whose keyword-search adapter is usable (has credentials). */
  searchPlatforms(): SearchPlatform[] {
    const cfg = this.deps.config.get();
    return SEARCH_PLATFORMS.filter(
      (p) => this.platformEnabled(p, cfg) && this.deps.registry.forTarget({ platform: p, kind: 'search' })?.isConfigured(),
    );
  }

  /** Platforms with credentials (regardless of the on/off switch). */
  configuredPlatforms(): string[] {
    return this.deps.registry.platforms().filter((p) => this.deps.registry.forPlatform(p).some((a) => a.isConfigured()));
  }

  /** Bring managed keyword-search targets in line with keywords and configured platforms. */
  syncSearchTargets(): void {
    syncSearchTargets(this.deps.repos, this.searchPlatforms(), this.syncOpts());
  }

  private syncOpts() {
    const cfg = this.deps.config.get();
    return { facebookMaxQueries: cfg.search.max_queries, keepPlatforms: this.disabledPlatforms(cfg) };
  }

  /** Targets due now; keyword-search targets included per each platform's search mode. */
  dueTargets(now = this.now()): Target[] {
    const cfg = this.deps.config.get();
    // Switched-off platforms are left out silently (not reported as "skipped" every run).
    return dueTargets(cfg, this.deps.repos, now, this.searchPlatforms(), this.syncOpts()).filter((t) =>
      this.platformEnabled(t.platform, cfg),
    );
  }

  /** Due targets whose platform isn't blocked — what a run would actually scan. */
  runnableTargets(now = this.now(), targets = this.dueTargets(now)): { runnable: Target[]; blocked: Map<string, string> } {
    const cfg = this.deps.config.get();
    const blocked = new Map<string, string>();
    const runnable = targets.filter((t) => {
      const reason = this.platformBlockedReason(t.platform, cfg, now);
      if (reason) blocked.set(t.platform, reason);
      return !reason;
    });
    return { runnable, blocked };
  }

  /** Start a run in the background; resolves with the final report. */
  start(opts: RunOptions): { started: boolean; reason?: string; done: Promise<RunReport> } {
    const cfg = this.deps.config.get();
    const now = this.now();
    const skip = (reason: string) => {
      const report: RunReport = { run_id: null, status: 'skipped', reason, started_at: now.toISOString(), stats: emptyStats(), targets: [] };
      return { started: false, reason, done: Promise.resolve(report) };
    };
    const blocked = this.blockedReason(cfg, now);
    if (blocked) return skip(blocked);

    const candidates = this.targetsFor(opts, now);
    if (!candidates.length) return skip('no targets due (add a group/page/subreddit, or enable keyword search)');
    const { runnable, blocked: platformBlocks } = this.runnableTargets(now, candidates);
    if (platformBlocks.get('facebook') === 'daily page budget exhausted')
      this.deps.state.raise({ code: 'budget_exhausted', message: 'Daily page budget exhausted.' }, now);
    if (!runnable.length) return skip([...platformBlocks].map(([p, r]) => `${p}: ${r}`).join('; '));

    this._busy = 'scan';
    const done = this.execute(cfg, now, opts, runnable, platformBlocks).finally(() => {
      this._busy = null;
    });
    return { started: true, done };
  }

  private targetsFor(opts: RunOptions, now: Date): Target[] {
    if (opts.targetIds?.length) {
      this.syncSearchTargets();
      return opts.targetIds
        .map((id) => this.deps.repos.targets.get(id))
        .filter((t): t is Target => !!t && t.status !== 'disabled');
    }
    return this.dueTargets(now);
  }

  private async execute(
    cfg: Config,
    startedAt: Date,
    opts: RunOptions,
    targets: Target[],
    platformBlocks: Map<string, string>,
  ): Promise<RunReport> {
    const { repos, state } = this.deps;
    const runId = repos.runs.start('fetch', startedAt);
    const stats = emptyStats();
    const report: RunReport = { run_id: runId, status: 'completed', started_at: startedAt.toISOString(), stats, targets: [] };
    if (platformBlocks.size) report.reason = [...platformBlocks].map(([p, r]) => `${p} skipped: ${r}`).join('; ');
    this.current = report;

    const persist = () =>
      repos.runs.update(runId, { ...stats, notes: JSON.stringify({ trigger: opts.trigger, new_seen: stats.new_seen }) });

    const limit = Math.min(cfg.fetch.run_page_budget, this.dailyRemaining(cfg, startedAt));
    const budget = new TrackedBudget(limit, () => {
      stats.page_loads++;
      persist();
    });

    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    const timer = setTimeout(() => this.abort('run timeout'), cfg.fetch.run_timeout_minutes * 60_000);
    const health = new Map<string, boolean>();

    try {
      // Every active mission's rules are checked against each post (a post can serve several missions).
      ensureLegacyMission(repos);
      const missions = repos.missions.active();
      const keywords = repos.keywords.list();
      const onlyLegacy = missions.length > 0 && missions.every((m) => m.match.use_keywords);
      if (!missions.length || (onlyLegacy && !keywords.some((k) => k.enabled))) {
        report.status = 'skipped';
        report.reason = missions.length ? 'no enabled keywords' : 'no active missions — create one with /setup';
        return report;
      }
      const matcher = new MissionMatcher(missions, keywords, {
        fuzzyMaxDistance: cfg.matching.fuzzy_max_distance,
        fuzzyMinLength: cfg.matching.fuzzy_min_length,
      });

      // Random order (high priority still first), so visits don't follow a fixed pattern.
      const ordered = [...shuffle(targets.filter((t) => t.priority === 'high')), ...shuffle(targets.filter((t) => t.priority !== 'high'))];
      const scannedPlatforms = new Set<string>();
      for (const target of ordered) {
        if (signal.aborted) break;
        const base: TargetReport = { target_id: target.id, platform: target.platform, name: target.name, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, new_seen: 0 };
        const adapter = this.deps.registry.forTarget(target);
        if (!adapter) {
          report.targets.push({ ...base, error: `no adapter for ${target.platform}_${target.kind}` });
          continue;
        }
        // Switched off mid-run: skip the rest of that platform's targets.
        if (!this.platformEnabled(adapter.platform)) continue;
        adapter.beginRun?.(runId);

        // Health check once per platform per run, before its first target (spec §6.1).
        if (!health.has(adapter.platform)) health.set(adapter.platform, await this.checkPlatform(cfg, adapter, budget));
        if (!health.get(adapter.platform)) {
          report.targets.push({ ...base, error: `${adapter.platform}: unavailable (see status)` });
          continue;
        }
        if (adapter.usesPageBudget && budget.remaining <= 0) {
          report.targets.push({ ...base, error: 'page budget exhausted' });
          if (this.dailyRemaining(cfg, this.now()) <= 0)
            state.raise({ code: 'budget_exhausted', message: 'Daily page budget exhausted early.' });
          continue;
        }

        // Human-like break between consecutive targets on the same platform (Facebook).
        if (scannedPlatforms.has(adapter.platform)) await adapter.pauseBetweenTargets?.(signal).catch(() => undefined);
        scannedPlatforms.add(adapter.platform);
        const tr = await this.scanOne(cfg, adapter, target, matcher, budget, signal, stats, runId, base);
        report.targets.push(tr);
        persist();
        if (tr.error?.startsWith('session:')) health.set(adapter.platform, false); // skip its remaining targets
      }
      if (signal.aborted && report.status === 'completed') {
        report.status = 'aborted';
        report.reason = String((signal.reason as Error)?.message ?? 'aborted');
      }

      // Facebook layout-change heuristic (spec §15).
      const fb = report.targets.filter((t) => t.platform === 'facebook' && !t.error);
      if (fb.length && fb.every((t) => t.new_seen === 0)) {
        const streak = state.get().zero_new_streak + 1;
        state.patch({ zero_new_streak: streak });
        if (streak >= 3)
          state.raise({ code: 'zero_new_items', message: `No new Facebook posts seen for ${streak} consecutive runs — Facebook layout may have changed.` });
      } else if (fb.some((t) => t.new_seen > 0)) {
        state.patch({ zero_new_streak: 0 });
        state.clear('zero_new_items');
      }
      return report;
    } catch (err) {
      stats.errors++;
      report.status = 'failed';
      report.reason = String(err);
      logger.error({ err }, 'run failed');
      return report;
    } finally {
      clearTimeout(timer);
      this.abortCtl = null;
      const finishedAt = this.now();
      report.finished_at = finishedAt.toISOString();
      repos.runs.finish(runId, finishedAt, {
        ...stats,
        notes: JSON.stringify({ trigger: opts.trigger, status: report.status, reason: report.reason, new_seen: stats.new_seen, fb_dated: stats.fb_dated, fb_approx: stats.fb_approx }),
      });
      await this.deps.closeBrowser().catch(() => undefined);
      this.last = report;
      this.current = null;
      logger.info({ run_id: runId, status: report.status, reason: report.reason, ...stats }, 'run finished');
    }
  }

  /** Run the platform's health check and record the outcome. Returns whether to scan it. */
  async checkPlatform(cfg: Config, adapter: SourceAdapter, budget: PageLoadBudget): Promise<boolean> {
    const { state } = this.deps;
    const at = this.now().toISOString();
    if (adapter.usesPageBudget && !budget.tryConsume()) return false;
    const h = await adapter.healthCheck();

    if (adapter.platform === 'facebook') {
      state.patch({ session_checked_at: at });
      if (!h.ok) {
        this.onSessionFailure(cfg, h);
        return false;
      }
      state.patch({ session_status: 'ok' });
      state.clear('session_needs_reconnect');
      return true;
    }

    const platform_health = { ...state.get().platform_health };
    if (h.ok) {
      platform_health[adapter.platform] = { status: 'ok', checked_at: at, retry_after: null };
      state.patch({ platform_health });
      if (adapter.platform === 'reddit') state.clear('reddit_auth_failed');
      return true;
    }
    const retry_after = new Date(this.now().getTime() + PLATFORM_RETRY_MINUTES * 60_000).toISOString();
    platform_health[adapter.platform] = {
      status: h.status === 'not_configured' ? 'not_configured' : 'error',
      checked_at: at,
      detail: h.detail,
      retry_after,
    };
    state.patch({ platform_health });
    if (adapter.platform === 'reddit' && h.status === 'error')
      state.raise({ code: 'reddit_auth_failed', message: `Reddit API check failed: ${h.detail ?? 'unknown error'}. Retrying after ${retry_after}.` });
    logger.warn({ platform: adapter.platform, health: h }, 'platform health check failed — skipping its targets');
    return false;
  }

  onSessionFailure(cfg: Config, health: HealthStatus): void {
    const now = this.now();
    if (health.status === 'rate_limited') {
      // Soft block: the login is fine, Facebook wants us to slow down. Pause longer, no reconnect.
      const until = new Date(now.getTime() + cfg.fetch.soft_block_pause_hours * 3_600_000).toISOString();
      this.deps.state.patch({ paused_until: until, paused_reason: 'rate_limited', last_restriction_at: now.toISOString() });
      this.deps.state.raise({
        code: 'facebook_rate_limited',
        message: `Facebook showed a temporary block / "going too fast" warning. Facebook scans paused until ${until}. Consider fewer targets or a lower daily budget (run /doctor).`,
      });
      logger.warn({ paused_until: until }, 'facebook soft block — pausing Facebook jobs');
      return;
    }
    const until = new Date(now.getTime() + cfg.fetch.checkpoint_pause_hours * 3_600_000).toISOString();
    this.deps.state.patch({ session_status: 'needs_reconnect', paused_until: until, paused_reason: health.status, last_restriction_at: now.toISOString() });
    this.deps.state.raise({
      code: 'session_needs_reconnect',
      message: `Facebook session problem (${health.status}). Facebook scans paused until ${until}. Reconnect from the dashboard.`,
    });
    logger.warn({ health, paused_until: until }, 'session failure — pausing Facebook jobs');
  }

  private async scanOne(
    cfg: Config,
    adapter: SourceAdapter,
    target: Target,
    matcher: MissionMatcher,
    budget: PageLoadBudget,
    signal: AbortSignal,
    stats: RunStatsLive,
    runId: number,
    base: TargetReport,
  ): Promise<TargetReport> {
    const { repos } = this.deps;
    const now = this.now();
    const tr: TargetReport = { ...base };
    // First scan of a target looks further back (first_scan_lookback_hours); later scans use cutoff_hours.
    const cutoffHours =
      target.cutoff_hours ?? (target.watermark ? cfg.fetch.cutoff_hours : Math.max(cfg.fetch.cutoff_hours, cfg.fetch.first_scan_lookback_hours));
    const watermark =
      cfg.fetch.use_watermark && target.watermark
        ? new Date(new Date(target.watermark).getTime() - cfg.fetch.overlap_minutes * 60_000)
        : undefined;
    const isSeen = (k: string) => repos.seen.has(k);
    const ctx: ScanContext = {
      runId,
      cutoffTime: new Date(now.getTime() - cutoffHours * 3_600_000),
      watermark,
      maxPosts: target.max_posts ?? cfg.fetch.max_posts,
      maxScrolls: cfg.fetch.max_scrolls,
      stopAfterConsecutiveSeen: cfg.fetch.stop_after_consecutive_seen,
      isSeen,
      budget,
      signal,
      now,
      timezone: cfg.timezone,
    };

    const count = (captured: number) => {
      tr.new_captures += captured;
      stats.new_captures += captured;
    };

    let newest: Date | null = null;
    try {
      for await (const post of adapter.scanTarget(target, ctx)) {
        stats.posts_scanned++;
        tr.posts_scanned++;
        if (!post.isPinned && !post.postedAtApprox && (!newest || post.postedAt > newest)) newest = post.postedAt;
        if (target.platform === 'facebook' && !post.isPinned) {
          if (post.postedAtApprox) stats.fb_approx = (stats.fb_approx ?? 0) + 1;
          else stats.fb_dated = (stats.fb_dated ?? 0) + 1;
        }

        try {
          // Dedup layer 1: check before any screenshot (spec §8.2).
          if (isSeen(post.itemKey) || (post.aliasKey && isSeen(post.aliasKey))) {
            stats.duplicates_skipped++;
            tr.duplicates_skipped++;
            // A known post can still carry new pre-fetched comments (Reddit comment stream).
            if (post.comments?.length) count(await this.processComments(cfg, adapter, target, post, null, undefined, matcher, ctx, stats, post.comments));
            continue;
          }
          stats.new_seen++;
          tr.new_seen++;
          count(await this.processPost(cfg, adapter, target, post, matcher, ctx, stats));
        } catch (err) {
          if (err instanceof SessionError) throw err;
          stats.errors++;
          logger.warn({ err: String(err), item: post.itemKey }, 'failed to process post');
        }
      }
    } catch (err) {
      if (err instanceof SessionError) {
        this.onSessionFailure(cfg, err.health);
        tr.error = `session: ${err.health.status}`;
      } else if (!signal.aborted) {
        stats.errors++;
        tr.error = String(err);
        logger.warn({ err: String(err), target: target.url }, 'target scan failed');
      }
    }

    repos.targets.recordScan(target.id, {
      watermark: newest && (!target.watermark || newest > new Date(target.watermark)) ? newest.toISOString() : null,
      last_scanned_at: now.toISOString(),
      next_due_at: this.nextDue(cfg, this.now(), target),
    });
    return tr;
  }

  /** New (unseen) post. Returns the number of new matching items captured (post and/or comments). */
  private async processPost(
    cfg: Config,
    adapter: SourceAdapter,
    target: Target,
    post: RawItem,
    matcher: MissionMatcher,
    ctx: ScanContext,
    stats: RunStatsLive,
  ): Promise<number> {
    const prepared = prepareText(post.text);
    const scope: HitScope = { platform: target.platform, targetId: target.id, targetKind: target.kind };
    const postHits = matcher.match(prepared, scope);
    const postMatch = postHits.length ? postHits : null;
    // Selective comment expansion (spec §7.4); pre-fetched comments are always checked.
    const expand =
      !!post.comments?.length ||
      (target.comments_mode === 'all' && post.commentCount !== 0) ||
      (post.commentCount !== 0 &&
        (!!postMatch ||
          (post.commentCount ?? 0) >= cfg.comments.expand_min_count ||
          containsAnyTerm(prepared, cfg.comments.secondary_terms)));

    if (!postMatch && !expand) {
      this.deps.capturer.markSeen(target, post, this.now());
      return 0;
    }

    // Screenshot the post before expanding comments so the image stays compact.
    const postPng = adapter.captureScreenshot ? await adapter.captureScreenshot(post) : undefined;
    const comments = expand ? adapter.expandComments(post, ctx, { maxExpansions: cfg.comments.max_expansions }) : [];
    const captured = await this.processComments(cfg, adapter, target, post, postMatch, postPng, matcher, ctx, stats, comments);
    if (!captured) this.deps.capturer.markSeen(target, post, this.now());
    return captured;
  }

  /**
   * Match comments, screenshot the matching ones (if the adapter can), and save the post
   * with them. Works for new posts and for already-seen posts with new comments.
   */
  private async processComments(
    _cfg: Config,
    adapter: SourceAdapter,
    target: Target,
    post: RawItem,
    postMatch: ReturnType<MissionMatcher['match']> | null,
    postPng: Buffer | undefined,
    matcher: MissionMatcher,
    ctx: ScanContext,
    stats: RunStatsLive,
    source: AsyncIterable<RawItem> | Iterable<RawItem>,
  ): Promise<number> {
    const comments: CommentCapture[] = [];
    const keys = new Set<string>();
    for await (const c of source) {
      if (keys.has(c.itemKey) || ctx.isSeen(c.itemKey)) {
        stats.duplicates_skipped++;
        continue;
      }
      keys.add(c.itemKey);
      const scope = { platform: target.platform, targetId: target.id, targetKind: target.kind };
      let hits = matcher.match(c.text, scope);
      // comments_mode "all": every comment here goes to review (comments on a brand's own page rarely name it).
      if (!hits.length && target.comments_mode === 'all') hits = matcher.scopeHits(scope);
      if (!hits.length) continue;
      try {
        comments.push({ item: c, match: hits[0].primary, missions: hits, png: adapter.captureScreenshot ? await adapter.captureScreenshot(c) : undefined });
      } catch (err) {
        stats.errors++;
        logger.warn({ err: String(err), item: c.itemKey }, 'comment screenshot failed');
      }
    }
    if (!postMatch && !comments.length) return 0;
    await this.deps.capturer.savePost({
      target,
      post,
      postPng,
      postMatch: postMatch?.[0].primary ?? null,
      postMissions: postMatch ?? [],
      comments,
      capturedAt: this.now(),
    });
    return (postMatch ? 1 : 0) + comments.length;
  }
}

const emptyStats = (): RunStatsLive => ({
  page_loads: 0,
  posts_scanned: 0,
  new_captures: 0,
  duplicates_skipped: 0,
  errors: 0,
  new_seen: 0,
  fb_dated: 0,
  fb_approx: 0,
});
