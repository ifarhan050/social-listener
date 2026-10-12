import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import type { Mission } from '../db/missions.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { RawItem, ScanContext, SourceAdapter } from '../adapters/types.js';
import { SessionError } from '../adapters/errors.js';
import { classifyTarget } from '../adapters/classify.js';
import { groupSearchUrl, searchUrl as facebookSearchUrl } from '../adapters/facebook/urls.js';
import { newsSearchUrl } from '../adapters/feeds/index.js';
import { youtubeSearchUrl } from '../adapters/youtube/index.js';
import { redditSearchUrl } from '../adapters/reddit/index.js';
import type { Capturer } from '../capture/index.js';
import { slug } from '../capture/index.js';
import { MissionMatcher, effectiveQueries, ensureLegacyMission, type MissionHit } from '../missions/index.js';
import { TrackedBudget, type Runner } from '../scheduler/runner.js';
import { fromZoned, localDateString, zonedParts } from '../util/tz.js';
import { logger } from '../util/logger.js';
import { findCsv, type ExportInclude } from './export.js';

/**
 * Manual "find" jobs: "N posts of these types, from these groups (or a general search),
 * in this date range". The service collects candidates in batches; Claude labels them;
 * the job continues until N are kept, the sources are exhausted, or the page budget is
 * reached (then it can be resumed). Kept items are saved to captures for the mission.
 */

export const PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_year', 'last_year'] as const;
export type Preset = (typeof PRESETS)[number];
export const FIND_PLATFORMS = ['news', 'rss', 'youtube', 'reddit', 'facebook'] as const;

export type FindStatus = 'collecting' | 'ready' | 'done' | 'exhausted' | 'partial' | 'aborted' | 'failed';

export interface FindParams {
  mission_id: number;
  queries: string[];
  want: { count: number; types: string[] };
  groups: number[];
  platforms: string[];
  from: string;
  to: string;
  range_label: string;
}

export interface Step {
  platform: string;
  kind: 'fb_group_search' | 'fb_group_feed' | 'fb_search' | 'news' | 'youtube' | 'reddit' | 'rss';
  query?: string;
  target_id?: number;
}

export interface FindProgress {
  steps: Step[];
  next_step: number;
  batches: number;
  collected: number;
  kept: number;
  labelled: number;
  page_loads: number;
  group_posts: Record<string, number>;
  notes: string[];
}

export interface FindInput {
  mission_id?: number;
  queries?: string[];
  count: number;
  types: string[];
  groups?: (number | string)[];
  platforms?: string[];
  when: { preset?: Preset; from?: string; to?: string };
}

export interface FindLabel {
  item_key: string;
  label: string;
  keep?: boolean;
  reason: string;
}

export interface Payload {
  type: 'post';
  platform: string;
  source: string | null;
  source_url: string | null;
  url: string;
  author: string;
  text: string;
  posted_at: string | null;
  date_unknown: boolean;
  reactions: number | null;
  comment_count: number | null;
  comments: { author: string; text: string; posted_at: string | null; url: string }[];
  matched_terms: string[];
  target_id: number;
  step: string;
  png: string | null;
  raw: Omit<RawItem, 'postedAt' | 'elementHandle' | 'comments'> & { postedAt: string };
}

// --- Date ranges ----------------------------------------------------------------------------

/** Resolve a preset or explicit from/to (dates in the account timezone) to an ISO range. */
export function resolveRange(when: FindInput['when'], tz: string, now = new Date()): { from: Date; to: Date; label: string } {
  const p = zonedParts(now, tz);
  const day = (y: number, m: number, d: number) => fromZoned(tz, y, m, d, 0, 0);
  const startToday = day(p.year, p.month, p.day);
  const DAY = 86_400_000;
  if (when.from || when.to) {
    const parse = (s: string, endOfDay: boolean) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return endOfDay ? new Date(day(y, m, d).getTime() + DAY - 1) : day(y, m, d);
      }
      const dt = new Date(s);
      if (Number.isNaN(dt.getTime())) throw new Error(`invalid date "${s}" (use YYYY-MM-DD)`);
      return dt;
    };
    const from = when.from ? parse(when.from, false) : new Date(0);
    const to = when.to ? parse(when.to, true) : now;
    if (from > to) throw new Error('"from" is after "to"');
    return { from, to: to > now ? now : to, label: `${when.from ?? 'start'} to ${when.to ?? 'now'}` };
  }
  switch (when.preset ?? 'last_7_days') {
    case 'today':
      return { from: startToday, to: now, label: 'today' };
    case 'yesterday':
      return { from: new Date(startToday.getTime() - DAY), to: new Date(startToday.getTime() - 1), label: 'yesterday' };
    case 'last_7_days':
      return { from: new Date(now.getTime() - 7 * DAY), to: now, label: 'last 7 days' };
    case 'last_30_days':
      return { from: new Date(now.getTime() - 30 * DAY), to: now, label: 'last 30 days' };
    case 'last_90_days':
      return { from: new Date(now.getTime() - 90 * DAY), to: now, label: 'last 90 days' };
    case 'this_month':
      return { from: day(p.year, p.month, 1), to: now, label: 'this month' };
    case 'last_month': {
      const [y, m] = p.month === 1 ? [p.year - 1, 12] : [p.year, p.month - 1];
      return { from: day(y, m, 1), to: new Date(day(p.year, p.month, 1).getTime() - 1), label: 'last month' };
    }
    case 'this_year':
      return { from: day(p.year, 1, 1), to: now, label: 'this year' };
    case 'last_year':
      return { from: day(p.year - 1, 1, 1), to: new Date(day(p.year, 1, 1).getTime() - 1), label: 'last year' };
  }
}

/** "negative" also accepts complaint-ish labels, etc., so Claude's wording needn't be exact. */
const SYNONYMS: Record<string, string[]> = {
  negative: ['negative', 'complaint', 'complaints', 'issue', 'problem'],
  scam: ['scam', 'fraud', 'scams'],
  promotional: ['promotional', 'promo', 'ad', 'advert', 'advertisement'],
  positive: ['positive', 'praise'],
  neutral: ['neutral', 'news', 'info'],
  question: ['question', 'query'],
  lead: ['lead', 'leads', 'request', 'hot', 'warm', 'cold'],
  business: ['business', 'competitor', 'provider', 'partner'],
};
export function labelMatches(label: string, types: string[]): boolean {
  const l = label.trim().toLowerCase();
  return types.some((t) => {
    const tt = t.trim().toLowerCase();
    return l === tt || (SYNONYMS[tt] ?? []).includes(l) || Object.values(SYNONYMS).some((g) => g.includes(tt) && g.includes(l));
  });
}

// --- Storage --------------------------------------------------------------------------------

class FindRepo {
  constructor(private db: Database) {}
  create(params: FindParams, progress: FindProgress, now: Date): number {
    const at = now.toISOString();
    return Number(
      this.db
        .prepare(`INSERT INTO find_jobs (params, status, progress, created_at, updated_at) VALUES (?, 'collecting', ?, ?, ?)`)
        .run(JSON.stringify(params), JSON.stringify(progress), at, at).lastInsertRowid,
    );
  }
  get(id: number) {
    const r = this.db.prepare('SELECT * FROM find_jobs WHERE id = ?').get(id) as
      | { id: number; params: string; status: FindStatus; progress: string; notes: string | null; created_at: string; updated_at: string }
      | undefined;
    return r && { ...r, params: JSON.parse(r.params) as FindParams, progress: JSON.parse(r.progress) as FindProgress };
  }
  update(id: number, status: FindStatus | null, progress: FindProgress | null, now: Date): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE find_jobs SET status = ?, progress = ?, updated_at = ? WHERE id = ?')
      .run(status ?? cur.status, JSON.stringify(progress ?? cur.progress), now.toISOString(), id);
  }
  recent(limit: number) {
    return (this.db.prepare('SELECT id FROM find_jobs ORDER BY id DESC LIMIT ?').all(limit) as { id: number }[]).map((r) => this.get(r.id)!);
  }
  has(jobId: number, key: string): boolean {
    return this.db.prepare('SELECT 1 FROM find_items WHERE job_id = ? AND item_key = ?').get(jobId, key) !== undefined;
  }
  add(jobId: number, key: string, payload: Payload, batch: number, now: Date): void {
    this.db
      .prepare('INSERT OR IGNORE INTO find_items (job_id, item_key, payload, batch, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, key, JSON.stringify(payload), batch, now.toISOString());
  }
  items(jobId: number, where: 'unlabelled' | 'kept' | 'all') {
    const cond = where === 'unlabelled' ? 'AND label IS NULL' : where === 'kept' ? 'AND keep = 1' : '';
    return (
      this.db.prepare(`SELECT * FROM find_items WHERE job_id = ? ${cond} ORDER BY created_at, rowid`).all(jobId) as {
        item_key: string;
        payload: string;
        label: string | null;
        keep: number | null;
        reason: string | null;
        saved: number;
        batch: number;
      }[]
    ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Payload }));
  }
  setLabel(jobId: number, key: string, label: string, keep: boolean, reason: string): void {
    this.db.prepare('UPDATE find_items SET label = ?, keep = ?, reason = ? WHERE job_id = ? AND item_key = ?').run(label, keep ? 1 : 0, reason, jobId, key);
  }
  markSaved(jobId: number, key: string): void {
    this.db.prepare('UPDATE find_items SET saved = 1 WHERE job_id = ? AND item_key = ?').run(jobId, key);
  }
  counts(jobId: number) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS collected, SUM(label IS NOT NULL) AS labelled, SUM(keep = 1) AS kept FROM find_items WHERE job_id = ?`,
      )
      .get(jobId) as { collected: number; labelled: number | null; kept: number | null };
  }
}

// --- Service --------------------------------------------------------------------------------

export interface FindDeps {
  repos: Repos;
  config: ConfigStore;
  runner: Runner;
  registry: AdapterRegistry;
  /** FacebookFeedAdapter kind "group_search". */
  groupSearchAdapter: SourceAdapter;
  capturer: Capturer;
  dataDir: string;
  closeBrowser: () => Promise<void>;
  now?: () => Date;
}

export class FindService {
  private repo: FindRepo;

  constructor(private deps: FindDeps) {
    this.repo = new FindRepo(deps.repos.db);
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private pngDir(jobId: number) {
    return path.join(this.deps.dataDir, 'find', String(jobId));
  }

  /** Validate the request, build the source plan, and collect the first batch in the background. */
  start(input: FindInput): { started: boolean; job_id?: number; reason?: string; plan?: string[]; done: Promise<void> } {
    const { repos, config, runner } = this.deps;
    const cfg = config.get();
    const refuse = (reason: string) => ({ started: false, reason, done: Promise.resolve() });
    if (runner.busy) return refuse(`busy: ${runner.busy} in progress`);

    ensureLegacyMission(repos);
    const active = repos.missions.active();
    const mission = input.mission_id ? repos.missions.get(input.mission_id) : active.length === 1 ? active[0] : undefined;
    if (!mission) return refuse(input.mission_id ? 'mission not found' : 'which mission? give mission_id (see list_missions)');

    let range: ReturnType<typeof resolveRange>;
    try {
      range = resolveRange(input.when, cfg.timezone, this.now());
    } catch (err) {
      return refuse((err as Error).message);
    }

    // Groups: ids or URLs. Unknown group URLs are added as targets with status "candidate"
    // (used by /find only; not scanned by regular runs until activated).
    const groups: number[] = [];
    for (const g of input.groups ?? []) {
      if (typeof g === 'number') {
        const t = repos.targets.get(g);
        if (!t || t.platform !== 'facebook') return refuse(`target ${g} is not a Facebook group/page`);
        groups.push(t.id);
        continue;
      }
      let c: ReturnType<typeof classifyTarget>;
      try {
        c = classifyTarget(g);
      } catch (err) {
        return refuse(`"${g}": ${(err as Error).message}`);
      }
      if (c.platform !== 'facebook') return refuse(`"${g}" is not a Facebook group or page`);
      const t = repos.targets.getByUrl(c.url) ?? repos.targets.add({ platform: 'facebook', kind: c.kind, url: c.url, status: 'candidate' });
      groups.push(t.id);
    }

    const queries = (input.queries?.length ? input.queries : effectiveQueries(mission, repos.keywords.list())).slice(0, 10);
    if (!queries.length) return refuse('the mission has no search phrases; give queries');
    const platforms = (input.platforms?.length ? input.platforms : FIND_PLATFORMS.filter((p) => mission.sources[p] !== false)).filter(
      (p) => runner.platformEnabled(p, cfg),
    );
    if (groups.length && !platforms.includes('facebook')) platforms.push('facebook');

    const params: FindParams = {
      mission_id: mission.id,
      queries,
      want: { count: input.count, types: input.types },
      groups,
      platforms,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      range_label: range.label,
    };
    const progress: FindProgress = {
      steps: this.plan(params, mission, cfg),
      next_step: 0,
      batches: 0,
      collected: 0,
      kept: 0,
      labelled: 0,
      page_loads: 0,
      group_posts: {},
      notes: [],
    };
    if (!progress.steps.length) return refuse('nothing to search: no enabled/configured sources for this mission');
    const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
    if (platforms.includes('facebook') && days > cfg.find.facebook_max_days)
      progress.notes.push(
        `Facebook: range is ${Math.round(days)} days (> ${cfg.find.facebook_max_days}); general search uses Facebook's year filter (best-effort), groups are read back ${cfg.find.facebook_max_days} days.`,
      );
    const jobId = this.repo.create(params, progress, this.now());
    const done = this.collect(jobId);
    return {
      started: true,
      job_id: jobId,
      plan: progress.steps.map((s) => `${s.platform}:${s.kind}${s.query ? ` "${s.query}"` : ''}${s.target_id ? ` #${s.target_id}` : ''}`),
      done,
    };
  }

  /** Order: zero-account sources first (fast, no risk), then Facebook. */
  private plan(p: FindParams, mission: Mission, cfg: Config): Step[] {
    const { registry, repos, runner } = this.deps;
    const steps: Step[] = [];
    const ready = (platform: string, kind: string) => !!registry.forTarget({ platform, kind })?.isConfigured();
    for (const q of p.queries) {
      if (p.platforms.includes('news') && ready('news', 'search')) steps.push({ platform: 'news', kind: 'news', query: q });
      if (p.platforms.includes('youtube') && ready('youtube', 'search')) steps.push({ platform: 'youtube', kind: 'youtube', query: q });
      if (p.platforms.includes('reddit') && ready('reddit', 'search')) steps.push({ platform: 'reddit', kind: 'reddit', query: q });
    }
    if (p.platforms.includes('rss'))
      for (const t of repos.targets.list())
        if (t.platform === 'rss' && t.status === 'active' && (!mission.target_ids || mission.target_ids.includes(t.id)))
          steps.push({ platform: 'rss', kind: 'rss', target_id: t.id });
    if (p.platforms.includes('facebook') && runner.platformEnabled('facebook', cfg)) {
      if (p.groups.length) {
        for (const g of p.groups) {
          const t = repos.targets.get(g);
          if (t?.kind === 'group') {
            for (const q of p.queries) steps.push({ platform: 'facebook', kind: 'fb_group_search', query: q, target_id: g });
            steps.push({ platform: 'facebook', kind: 'fb_group_feed', target_id: g });
          } else if (t) steps.push({ platform: 'facebook', kind: 'fb_group_feed', target_id: g }); // a page: read its timeline
        }
      } else {
        for (const q of p.queries.slice(0, cfg.search.max_queries)) steps.push({ platform: 'facebook', kind: 'fb_search', query: q });
      }
    }
    return steps;
  }

  /** Collect the next batch (call again via continue()). */
  continue(jobId: number): { started: boolean; reason?: string; done: Promise<void> } {
    const job = this.repo.get(jobId);
    const refuse = (reason: string) => ({ started: false, reason, done: Promise.resolve() });
    if (!job) return refuse('find job not found');
    if (job.status === 'collecting') return refuse('already collecting');
    if (job.status === 'done') return refuse('done: the requested number of items was found');
    if (job.status === 'exhausted') return refuse('exhausted: no more sources to search for this range');
    if (this.repo.items(jobId, 'unlabelled').length) return refuse('label the current batch first (submit_find_labels)');
    if (this.deps.runner.busy) return refuse(`busy: ${this.deps.runner.busy} in progress`);
    this.repo.update(jobId, 'collecting', null, this.now());
    return { started: true, done: this.collect(jobId) };
  }

  private collect(jobId: number): Promise<void> {
    return this.deps.runner
      .exclusive('find', () => this.collectBatch(jobId))
      .catch((err) => {
        logger.error({ err }, 'find job failed');
        this.repo.update(jobId, 'failed', null, this.now());
      });
  }

  private async collectBatch(jobId: number): Promise<void> {
    const { repos, config, runner, registry } = this.deps;
    const cfg = config.get();
    const job = this.repo.get(jobId)!;
    const p = job.params;
    const progress = job.progress;
    progress.batches++;
    const mission = repos.missions.get(p.mission_id);
    if (!mission) {
      progress.notes.push('mission was deleted');
      this.repo.update(jobId, 'failed', progress, this.now());
      return;
    }
    const matcher = new MissionMatcher([mission], repos.keywords.list(), {
      fuzzyMaxDistance: cfg.matching.fuzzy_max_distance,
      fuzzyMinLength: cfg.matching.fuzzy_min_length,
    });
    const from = new Date(p.from);
    const to = new Date(p.to);
    const runId = repos.runs.start('report', this.now());
    const stats = { page_loads: 0, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, errors: 0 };
    const budget = new TrackedBudget(Math.min(cfg.fetch.run_page_budget, runner.dailyRemaining(cfg, this.now())), () => {
      stats.page_loads++;
      progress.page_loads++;
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('run timeout')), cfg.fetch.run_timeout_minutes * 60_000);
    let fbChecked: boolean | null = null;
    let collectedThisBatch = 0;
    let stopReason: 'budget' | 'session' | 'timeout' | null = null;

    try {
      while (progress.next_step < progress.steps.length && collectedThisBatch < cfg.find.batch_size) {
        const step = progress.steps[progress.next_step];
        if (step.platform === 'facebook') {
          const blocked = runner.platformBlockedReason('facebook', cfg, this.now());
          if (blocked) {
            progress.notes.push(`Facebook skipped: ${blocked}`);
            // Remaining Facebook steps stay queued; resume later when Facebook is available.
            stopReason = 'budget';
            break;
          }
          if (budget.remaining <= 0) {
            stopReason = 'budget';
            break;
          }
          if (fbChecked === null) {
            const adapter = registry.forPlatform('facebook')[0] ?? this.deps.groupSearchAdapter;
            fbChecked = await runner.checkPlatform(cfg, adapter, budget);
            if (!fbChecked) {
              progress.notes.push('Facebook session check failed — see get_status alerts');
              stopReason = 'session';
              break;
            }
          }
          if (step.kind === 'fb_group_feed' && step.target_id && (progress.group_posts[step.target_id] ?? 0) > 0) {
            progress.next_step++; // group search already found posts in this group
            continue;
          }
        }
        if (abort.signal.aborted) {
          stopReason = 'timeout';
          break;
        }
        try {
          collectedThisBatch += await this.runStep(jobId, job.params, step, progress, matcher, mission, from, to, budget, abort.signal, stats, cfg);
          progress.next_step++;
        } catch (err) {
          if (err instanceof SessionError) {
            runner.onSessionFailure(cfg, err.health);
            progress.notes.push(`Facebook stopped: ${err.health.status} — Facebook is paused`);
            stopReason = 'session';
            break;
          }
          if (abort.signal.aborted) {
            stopReason = 'timeout';
            break;
          }
          stats.errors++;
          progress.notes.push(`${step.platform} ${step.kind}${step.query ? ` "${step.query}"` : ''}: ${(err as Error).message.slice(0, 160)}`);
          progress.next_step++;
        }
        this.repo.update(jobId, null, progress, this.now());
      }
    } finally {
      clearTimeout(timer);
      repos.runs.finish(runId, this.now(), { ...stats, notes: JSON.stringify({ find_job: jobId }) });
      await this.deps.closeBrowser().catch(() => undefined);
    }

    const c = this.repo.counts(jobId);
    progress.collected = c.collected;
    const unlabelled = c.collected - (c.labelled ?? 0);
    let status: FindStatus;
    if (unlabelled > 0) status = 'ready';
    else if (progress.next_step >= progress.steps.length) status = 'exhausted';
    else status = stopReason === 'session' ? 'aborted' : 'partial';
    if (stopReason === 'budget' && progress.next_step < progress.steps.length)
      progress.notes.push(`batch ${progress.batches}: stopped at the page budget or Facebook availability; resume with continue_find later`);
    this.repo.update(jobId, status, progress, this.now());
  }

  /** Run one source step; returns how many new candidates it added. */
  private async runStep(
    jobId: number,
    p: FindParams,
    step: Step,
    progress: FindProgress,
    matcher: MissionMatcher,
    mission: Mission,
    from: Date,
    to: Date,
    budget: TrackedBudget,
    signal: AbortSignal,
    stats: { posts_scanned: number },
    cfg: Config,
  ): Promise<number> {
    const { repos, registry } = this.deps;
    const day = (d: Date) => localDateString(d, cfg.timezone);
    const fbFloor = new Date(this.now().getTime() - cfg.find.facebook_max_days * 86_400_000);
    let adapter: SourceAdapter | undefined;
    let target: Target;
    const synthetic = (platform: string, kind: string, url: string, name: string): Target =>
      ({ id: 0, platform, kind, url, name, status: 'active', priority: 'normal', cutoff_hours: null, max_posts: null, activity_ema: 0, hit_rate_ema: 0, scans: 0, watermark: null, last_scanned_at: null, next_due_at: null, comments_mode: 'matching' }) as Target;
    let cutoff = from;

    switch (step.kind) {
      case 'news': {
        adapter = registry.forTarget({ platform: 'news', kind: 'search' });
        const u = new URL(newsSearchUrl(step.query!));
        u.searchParams.set('after', day(new Date(from.getTime() - 86_400_000)));
        u.searchParams.set('before', day(new Date(to.getTime() + 86_400_000)));
        target = synthetic('news', 'search', u.toString(), `Find: ${step.query}`);
        break;
      }
      case 'youtube': {
        adapter = registry.forTarget({ platform: 'youtube', kind: 'search' });
        target = synthetic('youtube', 'search', `${youtubeSearchUrl(step.query!)}&before=${encodeURIComponent(to.toISOString())}`, `Find: ${step.query}`);
        break;
      }
      case 'reddit':
        adapter = registry.forTarget({ platform: 'reddit', kind: 'search' });
        target = synthetic('reddit', 'search', redditSearchUrl(step.query!), `Find: ${step.query}`);
        break;
      case 'rss':
        adapter = registry.forTarget({ platform: 'rss', kind: 'feed' });
        target = repos.targets.get(step.target_id!)!;
        break;
      case 'fb_search': {
        adapter = registry.forTarget({ platform: 'facebook', kind: 'search' });
        const old = from < fbFloor;
        target = synthetic('facebook', 'search', facebookSearchUrl(step.query!, old ? { year: zonedParts(from, cfg.timezone).year } : {}), `Find: ${step.query}`);
        break;
      }
      case 'fb_group_search': {
        adapter = this.deps.groupSearchAdapter;
        const g = repos.targets.get(step.target_id!)!;
        target = { ...g, url: groupSearchUrl(g.url, step.query!) };
        cutoff = from < fbFloor ? fbFloor : from;
        break;
      }
      case 'fb_group_feed': {
        const g = repos.targets.get(step.target_id!)!;
        adapter = registry.forTarget({ platform: 'facebook', kind: g.kind });
        target = g;
        cutoff = from < fbFloor ? fbFloor : from;
        break;
      }
    }
    if (!adapter || !target!) throw new Error('source not available');

    const ctx: ScanContext = {
      runId: 0,
      cutoffTime: cutoff,
      maxPosts: cfg.find.batch_size * 2,
      maxScrolls: step.kind === 'fb_group_feed' ? cfg.fetch.max_scrolls * 2 : cfg.fetch.max_scrolls,
      stopAfterConsecutiveSeen: Number.MAX_SAFE_INTEGER,
      isSeen: () => false,
      budget,
      signal,
      now: this.now(),
      timezone: cfg.timezone,
    };
    adapter.beginRun?.(Date.now());
    let added = 0;
    const scope = { platform: target.platform, targetId: target.id, targetKind: target.kind };
    for await (const post of adapter.scanTarget(target, ctx)) {
      stats.posts_scanned++;
      if (step.target_id) progress.group_posts[step.target_id] = (progress.group_posts[step.target_id] ?? 0) + 1;
      if (!post.postedAtApprox && (post.postedAt < from || post.postedAt > to)) continue;
      const hits = matcher.match(post.text, scope).filter((h) => h.mission_id === mission.id);
      if (!hits.length || this.repo.has(jobId, post.itemKey)) continue;

      let png: string | null = null;
      if (adapter.captureScreenshot) {
        try {
          const buf = await adapter.captureScreenshot(post);
          fs.mkdirSync(this.pngDir(jobId), { recursive: true });
          png = path.join(this.pngDir(jobId), `${slug(post.itemKey)}.png`);
          fs.writeFileSync(png, buf);
        } catch {
          /* screenshot optional */
        }
      }
      const comments: Payload['comments'] = [];
      if (post.commentCount !== 0 && cfg.find.max_comments_per_post > 0) {
        try {
          for await (const c of adapter.expandComments(post, ctx, { maxExpansions: cfg.report.max_comment_expansions })) {
            comments.push({ author: c.authorName, text: c.text.slice(0, 600), posted_at: c.postedAtApprox ? null : c.postedAt.toISOString(), url: c.url });
            if (comments.length >= cfg.find.max_comments_per_post) break;
          }
        } catch (err) {
          if (err instanceof SessionError) throw err;
        }
      }
      const { elementHandle: _e, comments: _c, postedAt, ...raw } = post;
      this.repo.add(
        jobId,
        post.itemKey,
        {
          type: 'post',
          platform: target.platform,
          source: post.sourceName ?? (target.id ? target.name : null),
          source_url: post.sourceUrl ?? (target.id ? target.url : null),
          url: post.url,
          author: post.authorName,
          text: post.text.slice(0, 3000),
          posted_at: post.postedAtApprox ? null : postedAt.toISOString(),
          date_unknown: !!post.postedAtApprox,
          reactions: post.reactionCount ?? null,
          comment_count: post.commentCount ?? null,
          comments,
          matched_terms: hits[0].terms,
          target_id: target.id,
          step: `${step.platform}:${step.kind}`,
          png,
          raw: { ...raw, postedAt: postedAt.toISOString() },
        },
        progress.batches,
        this.now(),
      );
      added++;
    }
    return added;
  }

  /**
   * Claude's labels for the current batch. Items whose label is one of the wanted types are
   * kept and saved to captures (as kept, for the mission) until the requested count is reached.
   */
  async label(jobId: number, labels: FindLabel[]): Promise<{ applied: number; kept_total: number; wanted: number; status: FindStatus; problems: { item_key: string; problem: string }[] }> {
    const job = this.repo.get(jobId);
    if (!job) throw new Error('find job not found');
    const problems: { item_key: string; problem: string }[] = [];
    const byKey = new Map(this.repo.items(jobId, 'all').map((i) => [i.item_key, i]));
    let applied = 0;
    for (const l of labels) {
      const item = byKey.get(l.item_key);
      if (!item) {
        problems.push({ item_key: l.item_key, problem: 'not in this job' });
        continue;
      }
      const keep = l.keep ?? labelMatches(l.label, job.params.want.types);
      this.repo.setLabel(jobId, l.item_key, l.label, keep, l.reason);
      applied++;
      if (keep && !item.saved && (this.repo.counts(jobId).kept ?? 0) <= job.params.want.count) {
        try {
          await this.save(job.params, item.item_key, item.payload, l.label, l.reason);
          this.repo.markSaved(jobId, l.item_key);
        } catch (err) {
          problems.push({ item_key: l.item_key, problem: `kept, but saving to captures failed: ${(err as Error).message}` });
        }
      }
    }
    const c = this.repo.counts(jobId);
    const kept = c.kept ?? 0;
    const progress = job.progress;
    progress.kept = kept;
    progress.labelled = c.labelled ?? 0;
    const unlabelled = c.collected - (c.labelled ?? 0);
    let status: FindStatus = job.status;
    if (kept >= job.params.want.count) status = 'done';
    else if (unlabelled === 0) status = progress.next_step >= progress.steps.length ? 'exhausted' : 'partial';
    this.repo.update(jobId, status, progress, this.now());
    if (status === 'done' || status === 'exhausted') fs.rmSync(this.pngDir(jobId), { recursive: true, force: true });
    return { applied, kept_total: kept, wanted: job.params.want.count, status, problems };
  }

  /** Save a kept find item to the mission's captures (as kept, with the label). */
  private async save(p: FindParams, key: string, payload: Payload, label: string, reason: string): Promise<void> {
    const { repos, capturer } = this.deps;
    const mission = repos.missions.get(p.mission_id)!;
    const target: Target =
      (payload.target_id && repos.targets.get(payload.target_id)) ||
      ({ id: 0, platform: payload.platform, kind: 'search', url: payload.source_url ?? payload.url, name: payload.source ?? `Find (${p.range_label})`, comments_mode: 'matching' } as Target);
    const post: RawItem = { ...payload.raw, postedAt: new Date(payload.raw.postedAt) };
    const hit: MissionHit = {
      mission_id: mission.id,
      mission_name: mission.name,
      template: mission.template,
      folder: mission.name,
      terms: payload.matched_terms,
      primary: { keyword: payload.matched_terms[0] ?? mission.name, variant: payload.matched_terms[0] ?? '', form: '', fuzzy: false },
    };
    const existing = repos.seen.get(key);
    if (existing?.is_match === 1) {
      repos.missions.link(key, mission.id, payload.matched_terms, 'kept');
    } else {
      const png = payload.png && fs.existsSync(payload.png) ? fs.readFileSync(payload.png) : undefined;
      const { dir } = await capturer.savePost({ target, post, postPng: png, postMatch: hit.primary, postMissions: [hit], comments: [], capturedAt: this.now(), reviewStatus: 'kept' });
      if (existing) repos.seen.promoteToKept(key, dir, hit.primary.keyword);
      repos.missions.link(key, mission.id, payload.matched_terms, 'kept');
    }
    repos.missions.setVerdict(key, mission.id, { status: 'kept', label, score: null, reason, at: this.now().toISOString() });
  }

  /** Export a job's results as CSV; also keeps a copy under data/exports/. */
  exportCsv(jobId: number, include: ExportInclude = 'kept'): { file: string | null; filename: string; rows: number; csv: string } | undefined {
    const job = this.repo.get(jobId);
    if (!job) return undefined;
    const p = job.params;
    const mission = this.deps.repos.missions.get(p.mission_id)?.name ?? `mission-${p.mission_id}`;
    const { csv, rows } = findCsv(this.repo.items(jobId, 'all'), { jobId, mission, include, timezone: this.deps.config.get().timezone });
    const name = ['find', mission, ...p.want.types, p.range_label].join(' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    const filename = `${name}.csv`;
    if (!rows) return { file: null, filename, rows, csv };
    const dir = path.join(this.deps.dataDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `find-${jobId}-${filename.replace(/^find-/, '')}`);
    fs.writeFileSync(file, csv, 'utf8');
    return { file, filename, rows, csv };
  }

  /** Recent find jobs, newest first (so "export my last find" works in a new chat). */
  list(limit = 10) {
    return this.repo.recent(limit).map((j) => {
      const c = this.repo.counts(j.id);
      return {
        id: j.id,
        status: j.status,
        created_at: j.created_at,
        mission: this.deps.repos.missions.get(j.params.mission_id)?.name ?? null,
        types: j.params.want.types,
        count: j.params.want.count,
        range: j.params.range_label,
        groups: j.params.groups.length,
        collected: c.collected,
        kept: c.kept ?? 0,
      };
    });
  }

  get(jobId: number) {
    const job = this.repo.get(jobId);
    if (!job) return undefined;
    const strip = (i: ReturnType<FindRepo['items']>[number]) => {
      const { raw: _r, png: _p, ...rest } = i.payload;
      return { item_key: i.item_key, label: i.label, keep: i.keep === null ? null : i.keep === 1, reason: i.reason, saved: i.saved === 1, ...rest };
    };
    const c = this.repo.counts(jobId);
    return {
      id: job.id,
      status: job.status,
      params: job.params,
      progress: {
        batches: job.progress.batches,
        steps_done: job.progress.next_step,
        steps_total: job.progress.steps.length,
        collected: c.collected,
        labelled: c.labelled ?? 0,
        kept: c.kept ?? 0,
        page_loads: job.progress.page_loads,
        notes: job.progress.notes,
      },
      to_label: this.repo.items(jobId, 'unlabelled').map(strip),
      kept: this.repo.items(jobId, 'kept').map(strip),
    };
  }
}
