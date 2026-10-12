import type { ConfigStore } from '../config/store.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import type { ReportComment, ReportJob, ReportPost } from '../db/reports.js';
import type { RawItem, ScanContext, SourceAdapter } from '../adapters/types.js';
import { SessionError } from '../adapters/errors.js';
import { groupSearchUrl } from '../adapters/facebook/urls.js';
import { shuffle } from '../adapters/facebook/human.js';
import { MissionMatcher, effectiveQueries, ensureLegacyMission } from '../missions/index.js';
import { normalize } from '../matcher/normalize.js';
import { TrackedBudget, type Runner } from '../scheduler/runner.js';
import { logger } from '../util/logger.js';

export const KIND = 'facebook_groups_negative';

export interface GroupReportParams {
  /** Mission whose search phrases and rules are used. */
  mission_id?: number;
  group_ids: number[];
  days: number;
  max_posts_per_group: number;
  keywords: string[];
}

export interface GroupReportProgress {
  remaining: number[];
  done: number[];
  page_loads: number;
  posts_found: number;
  /** Groups where group search showed nothing, so the group feed was scanned instead. */
  fallback_groups: number[];
  errors: { group_id: number; error: string }[];
}

export interface StartOptions {
  group_ids?: number[];
  days?: number;
  max_posts_per_group?: number;
  resume_job_id?: number;
  mission_id?: number;
}

export interface ReportDeps {
  repos: Repos;
  config: ConfigStore;
  runner: Runner;
  /** FacebookFeedAdapter kind "group_search" (search inside one group). */
  searchAdapter: SourceAdapter;
  /** FacebookFeedAdapter kind "group" (chronological feed), used as fallback. */
  feedAdapter: SourceAdapter;
  closeBrowser: () => Promise<void>;
  now?: () => Date;
  rng?: () => number;
}

/** True if a post comes from one of the brand's own pages (by name or URL). */
export function isOwnPage(post: Pick<RawItem, 'authorName' | 'url' | 'sourceUrl'>, ownPages: string[]): boolean {
  const author = normalize(post.authorName);
  return ownPages.some((p) => {
    const v = p.trim();
    if (!v) return false;
    if (/^https?:\/\//i.test(v)) {
      const slug = v.replace(/\/+$/, '').toLowerCase();
      return [post.url, post.sourceUrl].some((u) => !!u && u.toLowerCase().startsWith(slug));
    }
    return author !== '' && author === normalize(v);
  });
}

/**
 * "Facebook groups, last N days, brand mentions with all their comments" — data for the
 * Cowork negative-mentions report. Read-only, human-paced, within the page budgets;
 * resumable when the budget runs out. Classification and ranking happen in Cowork.
 */
export class FacebookGroupReport {
  constructor(private deps: ReportDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  get(id: number): (ReportJob<GroupReportParams, GroupReportProgress> & { posts: ReportPost[] }) | undefined {
    const job = this.deps.repos.reports.get<GroupReportParams, GroupReportProgress>(id);
    return job && { ...job, posts: this.deps.repos.reports.posts(id) };
  }

  /** Start (or resume) a job in the background. */
  start(opts: StartOptions): { started: boolean; job_id?: number; reason?: string; done: Promise<void> } {
    const { repos, config, runner } = this.deps;
    const cfg = config.get();
    const now = this.now();
    const refuse = (reason: string) => ({ started: false, reason, done: Promise.resolve() });

    if (runner.busy) return refuse(`busy: ${runner.busy} in progress`);
    const blocked = runner.platformBlockedReason('facebook', cfg, now);
    if (blocked) return refuse(`facebook: ${blocked}`);

    let jobId: number;
    if (opts.resume_job_id) {
      const job = repos.reports.get<GroupReportParams, GroupReportProgress>(opts.resume_job_id);
      if (!job || job.kind !== KIND) return refuse('report job not found');
      if (job.status === 'done') return refuse('report job already complete');
      if (job.status === 'running') return refuse('report job is already running');
      jobId = job.id;
      repos.reports.update(jobId, { status: 'running' }, now);
    } else {
      const groups = (opts.group_ids?.length
        ? opts.group_ids.map((id) => repos.targets.get(id))
        : repos.targets.list()
      ).filter((t): t is Target => !!t && t.platform === 'facebook' && t.kind === 'group' && t.status !== 'disabled');
      if (!groups.length) return refuse('no Facebook groups to report on — add groups with /add-group');
      ensureLegacyMission(repos);
      const active = repos.missions.active();
      const mission = opts.mission_id
        ? repos.missions.get(opts.mission_id)
        : (active.find((m) => m.match.use_keywords) ?? (active.length === 1 ? active[0] : undefined));
      if (!mission) return refuse(opts.mission_id ? 'mission not found' : 'which mission? give mission_id (see list_missions)');
      const keywords = effectiveQueries(mission, repos.keywords.list());
      if (!keywords.length) return refuse(mission.match.use_keywords ? 'no enabled keywords' : 'the mission has no search phrases');
      const params: GroupReportParams = {
        mission_id: mission.id,
        group_ids: groups.map((g) => g.id),
        days: opts.days ?? cfg.report.days,
        max_posts_per_group: opts.max_posts_per_group ?? cfg.report.max_posts_per_group,
        keywords,
      };
      jobId = repos.reports.create(KIND, params, now);
      const progress: GroupReportProgress = {
        remaining: shuffle(params.group_ids, this.deps.rng), // random group order
        done: [],
        page_loads: 0,
        posts_found: 0,
        fallback_groups: [],
        errors: [],
      };
      repos.reports.update(jobId, { progress }, now);
    }

    const done = runner.exclusive('report', () => this.execute(jobId)).catch((err) => {
      logger.error({ err }, 'report job failed');
      repos.reports.update(jobId, { status: 'failed', notes: String(err) }, this.now());
    });
    return { started: true, job_id: jobId, done };
  }

  private async execute(jobId: number): Promise<void> {
    const { repos, config, runner } = this.deps;
    const cfg = config.get();
    const job = repos.reports.get<GroupReportParams, GroupReportProgress>(jobId)!;
    const p = job.params;
    const progress = job.progress;
    const startedAt = this.now();
    const runId = repos.runs.start('report', startedAt);
    const stats = { page_loads: 0, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, errors: 0 };
    const save = (status?: 'running' | 'partial' | 'done' | 'aborted' | 'failed', notes?: string) => {
      repos.reports.update(jobId, { status, progress, ...(notes !== undefined ? { notes } : {}) }, this.now());
      repos.runs.update(runId, { ...stats, notes: JSON.stringify({ report_job: jobId }) });
    };
    const budget = new TrackedBudget(Math.min(cfg.fetch.run_page_budget, runner.dailyRemaining(cfg, startedAt)), () => {
      stats.page_loads++;
      progress.page_loads++;
      save();
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('run timeout')), cfg.fetch.run_timeout_minutes * 60_000);

    try {
      // Same pre-flight as a scan: session health check (one page load).
      if (!(await runner.checkPlatform(cfg, this.deps.searchAdapter, budget))) {
        save('aborted', 'Facebook session check failed — see get_status alerts.');
        return;
      }
      // Jobs created before missions have no mission_id: use the brand (keywords) mission.
      const mission = (p.mission_id ? repos.missions.get(p.mission_id) : undefined) ?? repos.missions.list().find((m) => m.match.use_keywords);
      if (!mission) {
        save('failed', 'mission not found');
        return;
      }
      const matcher = new MissionMatcher([mission], repos.keywords.list(), {
        fuzzyMaxDistance: cfg.matching.fuzzy_max_distance,
        fuzzyMinLength: cfg.matching.fuzzy_min_length,
      });
      const cutoff = new Date(startedAt.getTime() - p.days * 86_400_000);
      let first = true;

      while (progress.remaining.length) {
        if (abort.signal.aborted) break;
        if (budget.remaining <= 0) break;
        const groupId = progress.remaining[0];
        const group = repos.targets.get(groupId);
        if (group) {
          if (!first) await this.deps.searchAdapter.pauseBetweenTargets?.(abort.signal).catch(() => undefined);
          first = false;
          const outcome = await this.scanGroup(jobId, group, p, cutoff, matcher, budget, abort.signal, stats, progress);
          if (outcome === 'session') {
            save('aborted', 'Facebook showed a checkpoint, login wall or soft block — Facebook is paused. Resume the job later.');
            return;
          }
          if (outcome === 'budget') break; // group not finished: stays first in `remaining`
        }
        progress.remaining.shift();
        progress.done.push(groupId);
        save();
      }

      if (progress.remaining.length) {
        const why = abort.signal.aborted ? 'run timeout' : 'page budget reached';
        save('partial', `${why}: ${progress.done.length} of ${p.group_ids.length} groups done. Resume to continue.`);
      } else save('done', progress.fallback_groups.length ? `group search showed nothing in ${progress.fallback_groups.length} group(s); their feeds were scanned instead` : undefined);
    } finally {
      clearTimeout(timer);
      repos.runs.finish(runId, this.now(), { ...stats, notes: JSON.stringify({ report_job: jobId }) });
      await this.deps.closeBrowser().catch(() => undefined);
    }
  }

  /** Returns 'ok', 'budget' (stopped mid-group), or 'session' (checkpoint / soft block). */
  private async scanGroup(
    jobId: number,
    group: Target,
    p: GroupReportParams,
    cutoff: Date,
    matcher: MissionMatcher,
    budget: TrackedBudget,
    signal: AbortSignal,
    stats: { posts_scanned: number; errors: number },
    progress: GroupReportProgress,
  ): Promise<'ok' | 'budget' | 'session'> {
    const { repos, config, runner } = this.deps;
    const cfg = config.get();
    const ctx = (): ScanContext => ({
      runId: 0,
      cutoffTime: cutoff,
      maxPosts: p.max_posts_per_group * 3,
      maxScrolls: cfg.fetch.max_scrolls,
      stopAfterConsecutiveSeen: Number.MAX_SAFE_INTEGER, // collect regardless of earlier scans
      isSeen: () => false,
      budget,
      signal,
      now: this.now(),
      timezone: cfg.timezone,
    });

    let kept = 0;
    let anyPost = false;
    const collect = async (adapter: SourceAdapter, target: Target): Promise<void> => {
      for await (const post of adapter.scanTarget(target, ctx())) {
        anyPost = true;
        stats.posts_scanned++;
        if (post.postedAtApprox ? false : post.postedAt < cutoff) continue;
        const match = matcher.match(post.text)[0]?.primary;
        if (!match || isOwnPage(post, cfg.brand.own_pages) || repos.reports.hasPost(jobId, post.itemKey)) continue;

        const comments: ReportComment[] = [];
        for await (const c of adapter.expandComments(post, ctx(), { maxExpansions: cfg.report.max_comment_expansions })) {
          comments.push({ author: c.authorName, text: c.text, posted_at: c.postedAtApprox ? null : c.postedAt.toISOString(), url: c.url });
        }
        repos.reports.upsertPost(jobId, {
          post_key: post.itemKey,
          group_name: group.name ?? post.sourceName ?? null,
          group_url: group.url,
          post_url: post.url,
          author: post.authorName,
          posted_at: post.postedAtApprox ? null : post.postedAt.toISOString(),
          text: post.text,
          matched_keyword: match.keyword,
          comment_count: post.commentCount ?? comments.length,
          comments,
        });
        progress.posts_found++;
        if (++kept >= p.max_posts_per_group) return;
      }
    };

    try {
      for (const q of p.keywords) {
        if (kept >= p.max_posts_per_group) break;
        if (budget.remaining <= 0) return 'budget';
        await collect(this.deps.searchAdapter, { ...group, url: groupSearchUrl(group.url, q) });
      }
      // Group search showed no posts at all (no results or a different layout): read the feed back to the cutoff.
      if (!anyPost && kept < p.max_posts_per_group) {
        if (budget.remaining <= 0) return 'budget';
        progress.fallback_groups.push(group.id);
        await collect(this.deps.feedAdapter, group);
      }
      return 'ok';
    } catch (err) {
      if (err instanceof SessionError) {
        runner.onSessionFailure(cfg, err.health);
        return 'session';
      }
      if (signal.aborted) return 'budget';
      stats.errors++;
      progress.errors.push({ group_id: group.id, error: String(err) });
      logger.warn({ err: String(err), group: group.url }, 'report: group failed');
      return 'ok';
    }
  }
}
