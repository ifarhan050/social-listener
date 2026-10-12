import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { ConfigStore, StateStore } from '../config/store.js';
import type { Repos } from '../db/index.js';
import type { Runner } from '../scheduler/runner.js';
import type { ReviewService } from '../review/index.js';
import type { FindService } from '../find/index.js';
import type { FacebookGroupReport } from '../reports/facebookGroups.js';
import { localDateString, startOfLocalDay, isWithinActiveHours } from '../util/tz.js';
import { logger } from '../util/logger.js';
import { searchEnabled } from '../scheduler/searchTargets.js';
import { NotASocialUrl, classifyTarget } from '../adapters/classify.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import { validateFeed, type HttpClient } from '../adapters/feeds/index.js';
import type { YouTubeQuota } from '../adapters/youtube/index.js';
import type { HealthStatus } from '../adapters/types.js';
import { runDoctor, summarize, type Check } from '../doctor/index.js';
import { DATA_DIR, SERVICE_VERSION } from '../util/paths.js';
import { secretsStatus, type SecretKey } from '../util/envFile.js';
import { TEMPLATES, TEMPLATE_IDS, effectiveQueries, ensureKeywordsMission, ensureLegacyMission, withTemplateDefaults } from '../missions/index.js';
import type { CaptureMeta } from '../capture/index.js';
import { PLATFORMS, type PlatformName } from '../config/schema.js';
import {
  capturesQuery,
  keywordCreate,
  keywordPatch,
  missionCreate,
  missionItemsQuery,
  missionPatch,
  missionStatus,
  groupReportStart,
  findStart,
  findLabels,
  findExportQuery,
  secretsUpdate,
  snapshotRequest,
  platformName,
  platformToggle,
  reportQuery,
  reviewLogQuery,
  reviewQueueQuery,
  reviewSubmit,
  scanRequest,
  targetCreate,
  targetPatch,
} from './validation.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export interface ApiDeps {
  repos: Repos;
  config: ConfigStore;
  state: StateStore;
  runner: Runner;
  review: ReviewService;
  registry: AdapterRegistry;
  http: HttpClient;
  youtubeQuota?: YouTubeQuota;
  groupReport?: FacebookGroupReport;
  find?: FindService;
  updateSecrets?: (values: Partial<Record<SecretKey, string | null>>) => Record<SecretKey, 'set' | 'not set'>;
  facebookSnapshot?: (opts: { target_id?: number; posts?: number }) => Promise<{ file: string; summary: Record<string, unknown> }>;
  token: string;
  port: number;
  /** Starts the visible Facebook login window. */
  connectFacebook: () => Promise<unknown>;
  startedAt: Date;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid id');
  return id;
};

// Express 4 doesn't forward async errors; wrap handlers.
const h =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

export function buildStatus(deps: ApiDeps) {
  const { repos, config, state, runner } = deps;
  const cfg = config.get();
  const now = new Date();
  const st = state.get();
  const dayStart = startOfLocalDay(now, cfg.timezone).toISOString();
  return {
    service: { version: SERVICE_VERSION, started_at: deps.startedAt.toISOString(), now: now.toISOString() },
    session: { status: st.session_status, checked_at: st.session_checked_at, paused_until: st.paused_until },
    risk_acknowledged: st.risk_acknowledged,
    busy: runner.busy,
    can_run: runner.blockedReason(cfg, now) ?? 'yes',
    /** Who starts scans: "cowork" (scheduled tasks call run_scan) or "service" (built-in timer). */
    scheduler: { trigger: cfg.scheduler.trigger, scheduled_runs: cfg.scheduler.scheduled_runs },
    /** Earliest due time per enabled platform ("now" if something is due). */
    next_due: nextDueByPlatform(deps, now),
    /** Per-platform readiness: 'yes' or the reason that platform's targets are skipped. */
    platforms: runner.platformStatus(cfg, now),
    reddit: {
      configured: runner.configuredPlatforms().includes('reddit'),
      ...(st.platform_health.reddit ?? { status: 'unknown', checked_at: null }),
    },
    active_hours: { ...cfg.active_hours, timezone: cfg.timezone, within: isWithinActiveHours(now, cfg.timezone, cfg.active_hours) },
    budget: { date: localDateString(now, cfg.timezone), daily_used: runner.dailyUsed(cfg, now), daily_limit: cfg.fetch.daily_page_budget, run_limit: cfg.fetch.run_page_budget },
    captures_today: repos.seen.countCapturedSince(dayStart),
    sync: repos.seen.syncCounts(),
    missions: missionsReport(deps).map((m) => ({ id: m.id, name: m.name, template: m.template, status: m.status, pending: m.counts.pending ?? 0, kept: m.counts.kept ?? 0 })),
    review: { enabled: cfg.review.enabled, ...repos.seen.reviewCounts() },
    youtube: deps.youtubeQuota
      ? { quota_used_today: deps.youtubeQuota.used(), quota_cap: cfg.youtube.daily_quota_units }
      : undefined,
    targets: (() => {
      const due = runner.dueTargets(now);
      const all = repos.targets.list();
      return {
        groups: all.filter((t) => t.kind === 'group' && t.status === 'active').length,
        pages: all.filter((t) => t.kind === 'page' && t.status === 'active').length,
        subreddits: all.filter((t) => t.kind === 'subreddit' && t.status === 'active').length,
        keyword_search: {
          facebook: { mode: cfg.search.mode, active: searchEnabled(cfg, repos, 'facebook') },
          reddit: { mode: cfg.reddit.search_mode, active: runner.searchPlatforms().includes('reddit') && searchEnabled(cfg, repos, 'reddit') },
        },
        due_now: due.length,
      };
    })(),
    keywords: repos.keywords.listEnabled().length,
    current_run: runner.currentRun,
    last_run: runner.lastRun ?? repos.runs.recent(1)[0] ?? null,
    alerts: st.alerts,
  };
}

const PLATFORM_INFO: Record<PlatformName, { label: string; needs?: string; account_risk: boolean }> = {
  facebook: { label: 'Facebook (groups, pages, search)', account_risk: true },
  news: { label: 'News search (Google/Bing News RSS)', account_risk: false },
  rss: { label: 'RSS/Atom feeds', account_risk: false },
  youtube: { label: 'YouTube (official API)', needs: 'YOUTUBE_API_KEY', account_risk: false },
  reddit: { label: 'Reddit (official API)', needs: 'REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET', account_risk: false },
};

/** Missions with effective search phrases and verdict counts. */
export function missionsReport(deps: ApiDeps) {
  const keywords = deps.repos.keywords.list();
  const counts = deps.repos.missions.counts();
  return deps.repos.missions.list().map((m) => ({
    ...m,
    uses_keywords: !!m.match.use_keywords,
    effective_queries: effectiveQueries(m, keywords),
    effective_match: m.match.use_keywords
      ? { any: keywords.filter((k) => k.enabled).flatMap((k) => [k.keyword, ...k.variants]), none: keywords.flatMap((k) => k.negatives) }
      : m.match,
    counts: counts[m.id] ?? {},
  }));
}

/** One row per platform: switch state, credentials, readiness, target count, last check. */
export function platformsReport(deps: ApiDeps) {
  const cfg = deps.config.get();
  const st = deps.state.get();
  const now = new Date();
  const configured = deps.runner.configuredPlatforms();
  const targets = deps.repos.targets.list();
  return PLATFORMS.map((p) => {
    const info = PLATFORM_INFO[p];
    const health =
      p === 'facebook'
        ? { status: st.session_status, checked_at: st.session_checked_at }
        : (st.platform_health[p] ?? { status: 'unknown', checked_at: null });
    return {
      platform: p,
      label: info.label,
      enabled: cfg.platforms[p],
      configured: p === 'facebook' || p === 'news' || p === 'rss' ? true : configured.includes(p),
      needs: configured.includes(p) ? undefined : info.needs,
      ready: deps.runner.platformBlockedReason(p, cfg, now) ?? 'yes',
      targets: targets.filter((t) => t.platform === p && t.kind !== 'search' && t.status === 'active').length,
      last_check: health,
      account_risk: info.account_risk,
    };
  });
}

function nextDueByPlatform(deps: ApiDeps, now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  const cfg = deps.config.get();
  for (const t of deps.repos.targets.list()) {
    if (t.status !== 'active' || !deps.runner.platformEnabled(t.platform, cfg)) continue;
    const due = !t.next_due_at || new Date(t.next_due_at) <= now ? 'now' : t.next_due_at;
    const cur = out[t.platform];
    if (!cur || due === 'now' || (cur !== 'now' && due < cur)) out[t.platform] = due;
  }
  return out;
}

/** Doctor report; with `live`, one cheap request per API platform (never Facebook). */
export async function doctorReport(deps: ApiDeps, live: boolean) {
  const checks: Check[] = runDoctor({
    config: deps.config.get(),
    state: deps.state.get(),
    repos: deps.repos,
    registry: deps.registry,
    youtubeQuota: deps.youtubeQuota,
    lastRun: deps.runner.lastRun,
    dataDir: DATA_DIR,
    env: process.env,
  });
  if (live) {
    for (const platform of deps.registry.platforms().filter((p) => p !== 'facebook')) {
      const a = deps.registry.forPlatform(platform).find((x) => x.isConfigured());
      if (!a) continue;
      let h: HealthStatus;
      try {
        h = a.probe ? await a.probe() : await a.healthCheck();
      } catch (err) {
        h = { ok: false, status: 'error', detail: (err as Error).message };
      }
      checks.push({ area: platform, check: 'Live check', status: h.ok ? 'ok' : 'fail', detail: h.ok ? 'reachable' : (h.detail ?? h.status) });
    }
  }
  return { summary: summarize(checks), checks };
}

export function createApp(deps: ApiDeps) {
  /** Validate an RSS/Atom feed URL by fetching it once. */
  const asFeed = async (url: string) => {
    const feed = await validateFeed(deps.http, url);
    return { platform: 'rss', kind: 'feed', url: url.trim(), name: feed.title ?? undefined };
  };

  const { repos, config, state, runner } = deps;
  const app = express();
  app.disable('x-powered-by');

  // DNS-rebinding guard: only accept requests addressed to the loopback host.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(403).json({ error: 'forbidden host' });
    next();
  });

  // Dashboard shell (static, no data). The token is supplied in the URL fragment and kept client-side.
  app.use('/', express.static(publicDir, { index: 'index.html' }));

  app.use('/api', express.json({ limit: '1mb' }), (req, res, next) => {
    const auth = req.headers.authorization ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tok || !safeEqual(tok, deps.token)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  const api = express.Router();

  api.get('/status', (_req, res) => res.json(buildStatus(deps)));

  api.post(
    '/scan',
    h(async (req, res) => {
      const body = scanRequest.parse(req.body ?? {});
      if (body.scheduled && !config.get().scheduler.scheduled_runs)
        return res.status(409).json({ started: false, reason: 'scheduled runs are turned off — use /scan or /find (or set scheduler.scheduled_runs to true)' });
      const r = runner.start({ targetIds: body.target_ids, trigger: body.scheduled ? 'scheduled' : 'manual' });
      if (!r.started) return res.status(409).json({ started: false, reason: r.reason });
      if (body.wait) return res.json({ started: true, report: await r.done });
      res.status(202).json({ started: true, run: runner.currentRun });
    }),
  );

  api.post('/scan/abort', (_req, res) => {
    runner.abort('aborted by user');
    res.json({ ok: true });
  });

  // Targets
  api.get('/targets', (_req, res) => {
    runner.syncSearchTargets();
    res.json(repos.targets.list());
  });
  api.post(
    '/targets',
    h(async (req, res) => {
      const body = targetCreate.parse(req.body);
      let classified: { platform: string; kind: string; url: string; name?: string };
      try {
        classified = body.kind === 'feed' ? await asFeed(body.url) : classifyTarget(body.url);
      } catch (e) {
        // Not a Facebook/Reddit/YouTube URL: accept it if it is an RSS/Atom feed.
        if (e instanceof NotASocialUrl && /^https?:\/\//i.test(body.url)) {
          try {
            classified = await asFeed(body.url);
          } catch (fe) {
            throw new HttpError(400, `${e.message}. Tried it as a feed: ${(fe as Error).message}`);
          }
        } else throw new HttpError(400, (e as Error).message);
      }
      if (body.kind && body.kind !== classified.kind)
        throw new HttpError(400, `URL looks like a ${classified.kind}, not a ${body.kind}`);
      const url = classified.url;
      if (repos.targets.getByUrl(url)) throw new HttpError(409, `target already exists: ${url}`);
      const name =
        body.name ?? classified.name ?? (classified.kind === 'subreddit' ? `r/${url.split('/r/')[1]}` : undefined);
      res.status(201).json(repos.targets.add({ ...body, name, kind: classified.kind, url, platform: classified.platform }));
    }),
  );
  api.patch(
    '/targets/:id',
    h((req, res) => {
      const t = repos.targets.update(idParam(req), targetPatch.parse(req.body));
      if (!t) throw new HttpError(404, 'target not found');
      res.json(t);
    }),
  );
  api.delete(
    '/targets/:id',
    h((req, res) => {
      const t = repos.targets.get(idParam(req));
      if (t?.kind === 'search')
        throw new HttpError(409, 'search targets follow your keywords; disable the target, or turn search off (search.mode / reddit.search_mode)');
      if (!repos.targets.remove(idParam(req))) throw new HttpError(404, 'target not found');
      res.json({ ok: true });
    }),
  );

  // Keywords
  api.get('/keywords', (_req, res) => res.json(repos.keywords.list()));
  api.post(
    '/keywords',
    h((req, res) => {
      const body = keywordCreate.parse(req.body);
      if (repos.keywords.list().some((k) => k.keyword.toLowerCase() === body.keyword.toLowerCase()))
        throw new HttpError(409, `keyword already exists: ${body.keyword}`);
      const k = repos.keywords.add(body);
      ensureKeywordsMission(repos); // keywords feed the brand mission
      res.status(201).json(k);
    }),
  );
  api.patch(
    '/keywords/:id',
    h((req, res) => {
      const k = repos.keywords.update(idParam(req), keywordPatch.parse(req.body));
      if (!k) throw new HttpError(404, 'keyword not found');
      res.json(k);
    }),
  );
  api.delete(
    '/keywords/:id',
    h((req, res) => {
      if (!repos.keywords.remove(idParam(req))) throw new HttpError(404, 'keyword not found');
      res.json({ ok: true });
    }),
  );

  // Config
  api.get('/config', (_req, res) => res.json(config.get()));
  api.patch(
    '/config',
    h((req, res) => res.json(config.update(req.body))),
  );
  api.post('/config/reset', (_req, res) => res.json(config.reset()));

  // Captures
  api.get(
    '/captures',
    h((req, res) => {
      const q = capturesQuery.parse(req.query);
      const rows = repos.seen.queryCaptures(q).filter((r) => r.type !== 'alias');
      res.json(
        rows.map((r) => {
          let meta: unknown = null;
          if (r.type === 'post' && r.capture_path) {
            try {
              meta = JSON.parse(fs.readFileSync(path.join(r.capture_path, 'meta.json'), 'utf8'));
            } catch {
              /* files may have been removed by retention */
            }
          }
          return { ...r, meta };
        }),
      );
    }),
  );

  // Review queue (Cowork labels captures; only negative, non-promotional items are kept)
  api.get(
    '/review/queue',
    h((req, res) => {
      const q = reviewQueueQuery.parse(req.query);
      res.json({ pending_items: deps.review.pendingCount(), captures: deps.review.queue(q.limit ?? 20) });
    }),
  );
  api.post(
    '/review',
    h((req, res) => res.json(deps.review.submit(reviewSubmit.parse(req.body).decisions))),
  );
  api.get(
    '/review/log',
    h((req, res) => {
      const q = reviewLogQuery.parse(req.query);
      res.json(deps.review.log(q.status, q.limit ?? 50));
    }),
  );

  // Missions: each user goal (complaints, leads, competitors, topic…) with its own rules.
  api.get('/templates', (_req, res) => res.json(TEMPLATE_IDS.map((id) => TEMPLATES[id])));
  api.get('/missions', (_req, res) => {
    ensureLegacyMission(repos);
    res.json(missionsReport(deps));
  });
  api.post(
    '/missions',
    h((req, res) => {
      const body = missionCreate.parse(req.body);
      if (repos.missions.getByName(body.name)) throw new HttpError(409, `a mission named "${body.name}" already exists`);
      const m = repos.missions.create(withTemplateDefaults(body));
      runner.syncSearchTargets();
      res.status(201).json(missionsReport(deps).find((x) => x.id === m.id));
    }),
  );
  api.patch(
    '/missions/:id',
    h((req, res) => {
      const id = idParam(req);
      const patch = missionPatch.parse(req.body);
      if (patch.name) {
        const other = repos.missions.getByName(patch.name);
        if (other && other.id !== id) throw new HttpError(409, `a mission named "${patch.name}" already exists`);
      }
      const cur = repos.missions.get(id);
      if (!cur) throw new HttpError(404, 'mission not found');
      // Giving the brand mission explicit rules switches it off the keywords table.
      const m = repos.missions.update(id, patch.match ? { ...patch, match: { ...patch.match, use_keywords: false } } : patch)!;
      runner.syncSearchTargets();
      res.json(missionsReport(deps).find((x) => x.id === m.id));
    }),
  );
  api.post(
    '/missions/:id/status',
    h((req, res) => {
      const m = repos.missions.update(idParam(req), missionStatus.parse(req.body));
      if (!m) throw new HttpError(404, 'mission not found');
      runner.syncSearchTargets();
      res.json(missionsReport(deps).find((x) => x.id === m.id));
    }),
  );
  api.delete(
    '/missions/:id',
    h((req, res) => {
      if (!repos.missions.remove(idParam(req))) throw new HttpError(404, 'mission not found');
      repos.settings.set('legacy_mission_created', true); // don't re-create a deleted brand mission
      runner.syncSearchTargets();
      res.json({ ok: true, note: 'captures and their files are kept; only this mission and its verdicts were removed' });
    }),
  );
  api.get(
    '/missions/:id/items',
    h((req, res) => {
      const id = idParam(req);
      const m = repos.missions.get(id);
      if (!m) throw new HttpError(404, 'mission not found');
      const q = missionItemsQuery.parse(req.query);
      const statuses = q.status === 'stored' || !q.status ? (['kept', 'context'] as const) : ([q.status] as const);
      const days = q.days ?? m.report.days ?? 30;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const items = repos.missions.items(id, [...statuses], since, q.limit ?? 200).map((r) => {
        let meta: CaptureMeta | null = null;
        if (r.capture_path) {
          try {
            meta = JSON.parse(fs.readFileSync(path.join(r.capture_path, 'meta.json'), 'utf8')) as CaptureMeta;
          } catch {
            /* files removed by retention */
          }
        }
        const comment = r.type === 'comment' ? meta?.comments.find((c) => c.item_key === r.item_key) : undefined;
        return {
          item_key: r.item_key,
          type: r.type,
          first_seen: r.first_seen,
          verdict: { status: r.review.review_status, label: r.review.verdict_label, score: r.review.score, reason: r.review.reason },
          matched_terms: r.review.matched_terms,
          platform: meta?.platform,
          source: meta?.source_name,
          url: comment?.url ?? meta?.url,
          author_name: comment?.author_name ?? meta?.author_name,
          posted_at: comment?.posted_at ?? meta?.posted_at,
          text: comment?.text ?? meta?.text,
          post: comment ? { url: meta?.url, text: meta?.text?.slice(0, 500), author_name: meta?.author_name } : undefined,
        };
      });
      res.json({ mission: { id: m.id, name: m.name, template: m.template, goal: m.goal, report: m.report }, days, items });
    }),
  );

  // Platforms: one on/off switch each (non-destructive).
  api.get('/platforms', (_req, res) => res.json(platformsReport(deps)));
  api.patch(
    '/platforms/:name',
    h((req, res) => {
      const name = platformName.parse(req.params.name);
      const { enabled } = platformToggle.parse(req.body);
      config.update({ platforms: { [name]: enabled } });
      runner.syncSearchTargets();
      res.json(platformsReport(deps).find((p) => p.platform === name));
    }),
  );

  // Facebook group report job (data for the Cowork negative-mentions report).
  api.post(
    '/reports/facebook-groups',
    h((req, res) => {
      if (!deps.groupReport) throw new HttpError(501, 'reports not available');
      const r = deps.groupReport.start(groupReportStart.parse(req.body ?? {}));
      if (!r.started) return res.status(409).json({ started: false, reason: r.reason });
      res.status(202).json({ started: true, job_id: r.job_id });
    }),
  );
  api.get(
    '/reports/:id',
    h((req, res) => {
      const job = deps.groupReport?.get(idParam(req));
      if (!job) throw new HttpError(404, 'report job not found');
      res.json(job);
    }),
  );

  // Manual find jobs: N items of given types, from given groups (or a general search), in a date range.
  api.post(
    '/find',
    h((req, res) => {
      if (!deps.find) throw new HttpError(501, 'find not available');
      const r = deps.find.start(findStart.parse(req.body ?? {}));
      if (!r.started) return res.status(409).json({ started: false, reason: r.reason });
      res.status(202).json({ started: true, job_id: r.job_id, plan: r.plan });
    }),
  );
  api.get('/find', (req, res) => res.json(deps.find?.list(Math.min(Number(req.query.limit) || 10, 50)) ?? []));
  api.post(
    '/find/:id/continue',
    h((req, res) => {
      if (!deps.find) throw new HttpError(501, 'find not available');
      const r = deps.find.continue(idParam(req));
      if (!r.started) return res.status(409).json({ started: false, reason: r.reason });
      res.status(202).json({ started: true });
    }),
  );
  api.get(
    '/find/:id',
    h((req, res) => {
      const job = deps.find?.get(idParam(req));
      if (!job) throw new HttpError(404, 'find job not found');
      res.json(job);
    }),
  );
  api.get(
    '/find/:id/export',
    h((req, res) => {
      const q = findExportQuery.parse(req.query);
      const r = deps.find?.exportCsv(idParam(req), q.include ?? 'kept');
      if (!r) throw new HttpError(404, 'find job not found');
      if (q.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
        return res.send(r.csv);
      }
      res.json(r);
    }),
  );
  api.post(
    '/find/:id/labels',
    h(async (req, res) => {
      if (!deps.find) throw new HttpError(501, 'find not available');
      const id = idParam(req);
      if (!deps.find.get(id)) throw new HttpError(404, 'find job not found');
      res.json(await deps.find.label(id, findLabels.parse(req.body).labels));
    }),
  );
  api.post(
    '/debug/facebook-snapshot',
    h(async (req, res) => {
      if (!deps.facebookSnapshot) throw new HttpError(501, 'snapshot not available');
      try {
        res.json(await deps.facebookSnapshot(snapshotRequest.parse(req.body ?? {})));
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    }),
  );

  // API keys (YouTube, Reddit): written to the local .env only; values are never returned.
  api.get('/secrets', (_req, res) => res.json(secretsStatus()));
  api.put(
    '/secrets',
    h((req, res) => {
      if (!deps.updateSecrets) throw new HttpError(501, 'not available');
      res.json(deps.updateSecrets(secretsUpdate.parse(req.body ?? {})));
    }),
  );

  // Doctor: environment, platform readiness, and Facebook risk warnings.
  api.get(
    '/doctor',
    h(async (req, res) => res.json(await doctorReport(deps, req.query.live === 'true'))),
  );

  // Runs / reports
  api.get('/runs', (req, res) => res.json(repos.runs.recent(Math.min(Number(req.query.limit) || 20, 200))));
  api.get(
    '/report',
    h((req, res) => {
      const q = reportQuery.parse(req.query);
      if (q.run_id) {
        const run = repos.runs.get(q.run_id);
        if (!run) throw new HttpError(404, 'run not found');
        return res.json({ runs: [run], totals: totals([run]) });
      }
      const cfg = config.get();
      const from = q.from ? new Date(q.from).toISOString() : startOfLocalDay(new Date(), cfg.timezone).toISOString();
      const to = q.to ? new Date(q.to).toISOString() : new Date(Date.now() + 1000).toISOString();
      const runs = repos.runs.between(from, to);
      res.json({ from, to, runs, totals: totals(runs) });
    }),
  );

  // Session
  api.post('/session/acknowledge-risk', (req, res) => {
    if (req.body?.acknowledged !== true) return res.status(400).json({ error: 'send {"acknowledged": true}' });
    res.json(state.patch({ risk_acknowledged: true }));
  });
  api.post('/session/connect', (_req, res) => {
    if (!state.get().risk_acknowledged)
      return res.status(409).json({ error: 'acknowledge the account-risk notice first' });
    if (runner.busy) return res.status(409).json({ error: `busy: ${runner.busy} in progress` });
    deps.connectFacebook().catch((err) => logger.error({ err }, 'connect failed'));
    res.status(202).json({
      started: true,
      message: 'A browser window opened on this computer. Log in to Facebook there, then close that window to finish connecting.',
    });
  });

  app.use('/api', api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation failed', issues: err.issues });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'invalid JSON' });
    logger.error({ err }, 'api error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function totals(runs: { page_loads: number | null; posts_scanned: number | null; new_captures: number | null; duplicates_skipped: number | null; errors: number | null }[]) {
  const sum = (k: keyof (typeof runs)[number]) => runs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    runs: runs.length,
    page_loads: sum('page_loads'),
    posts_scanned: sum('posts_scanned'),
    new_captures: sum('new_captures'),
    duplicates_skipped: sum('duplicates_skipped'),
    errors: sum('errors'),
  };
}
