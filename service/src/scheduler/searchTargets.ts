import type { Config } from '../config/schema.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import { searchUrl as facebookSearchUrl } from '../adapters/facebook/urls.js';
import { redditSearchUrl } from '../adapters/reddit/index.js';
import { newsSearchUrl } from '../adapters/feeds/index.js';
import { youtubeSearchUrl } from '../adapters/youtube/index.js';
import { effectiveQueries, ensureLegacyMission } from '../missions/index.js';

export type SearchPlatform = 'facebook' | 'reddit' | 'news' | 'youtube';
export const SEARCH_PLATFORMS: SearchPlatform[] = ['facebook', 'reddit', 'news', 'youtube'];

const SEARCH: Record<SearchPlatform, { url: (kw: string) => string; name: (kw: string) => string }> = {
  facebook: { url: facebookSearchUrl, name: (kw) => `Search: ${kw}` },
  reddit: { url: redditSearchUrl, name: (kw) => `Reddit search: ${kw}` },
  news: { url: newsSearchUrl, name: (kw) => `News: ${kw}` },
  youtube: { url: youtubeSearchUrl, name: (kw) => `YouTube search: ${kw}` },
};

export interface SyncOptions {
  /** Only the first N search phrases (across all missions) get a Facebook search — it is heavily scrutinized. */
  facebookMaxQueries?: number;
  /** Platforms that are switched off: keep their existing search rows (and watermarks) instead of deleting them. */
  keepPlatforms?: string[];
}

/** Search phrases per platform: union over active missions that use that platform. */
export function queriesByPlatform(repos: Repos, platforms: SearchPlatform[], opts: SyncOptions = {}): Map<SearchPlatform, string[]> {
  ensureLegacyMission(repos);
  const keywords = repos.keywords.list();
  const missions = repos.missions.active();
  const out = new Map<SearchPlatform, string[]>();
  for (const p of platforms) {
    const qs: string[] = [];
    for (const m of missions) {
      if (m.sources[p] === false) continue;
      for (const q of effectiveQueries(m, keywords)) if (!qs.some((x) => x.toLowerCase() === q.toLowerCase())) qs.push(q);
    }
    out.set(p, p === 'facebook' && opts.facebookMaxQueries ? qs.slice(0, opts.facebookMaxQueries) : qs);
  }
  return out;
}

/**
 * Keep one managed `search` target per search phrase per platform in `platforms`
 * (phrases come from the active missions; the original brand mission uses its keywords).
 * Rows give each search its own watermark and schedule; rows for removed/disabled
 * keywords (or platforms no longer configured) are deleted. User edits to existing
 * rows (status, priority, cutoff) are preserved.
 */
export function syncSearchTargets(repos: Repos, platforms: SearchPlatform[] = ['facebook'], opts: SyncOptions = {}): void {
  const wanted = new Map<string, { platform: SearchPlatform; name: string }>();
  for (const [p, qs] of queriesByPlatform(repos, platforms, opts)) {
    for (const q of qs) wanted.set(SEARCH[p].url(q), { platform: p, name: SEARCH[p].name(q) });
  }
  // Paused missions keep their search rows (and watermarks) until they're resumed or deleted.
  const keywords = repos.keywords.list();
  const pausedUrls = new Set(
    repos.missions
      .list()
      .filter((m) => m.status === 'paused')
      .flatMap((m) => effectiveQueries(m, keywords))
      .flatMap((q) => SEARCH_PLATFORMS.map((p) => SEARCH[p].url(q))),
  );

  repos.db.transaction(() => {
    for (const t of repos.targets.list()) {
      if (t.kind === 'search' && !wanted.has(t.url) && !pausedUrls.has(t.url) && !opts.keepPlatforms?.includes(t.platform)) repos.targets.remove(t.id);
    }
    for (const [url, w] of wanted) {
      if (!repos.targets.getByUrl(url)) repos.targets.add({ platform: w.platform, kind: 'search', url, name: w.name });
    }
  })();
}

/** Active non-search targets on a platform (groups/pages, subreddits, channels). */
export const hasActiveFeedTargets = (repos: Repos, platform: string): boolean =>
  repos.targets.list().some((t) => t.platform === platform && t.kind !== 'search' && t.status === 'active');

const modeFor = (cfg: Config, platform: SearchPlatform) =>
  ({ facebook: cfg.search.mode, reddit: cfg.reddit.search_mode, news: cfg.news.search_mode, youtube: cfg.youtube.search_mode })[platform];

/** Whether keyword search runs on `platform`, per its mode setting. */
export function searchEnabled(cfg: Config, repos: Repos, platform: SearchPlatform = 'facebook'): boolean {
  const mode = modeFor(cfg, platform);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return !hasActiveFeedTargets(repos, platform);
}

/** Due targets for a run, with each platform's search targets included or excluded per its mode. */
export function dueTargets(
  cfg: Config,
  repos: Repos,
  now: Date,
  platforms: SearchPlatform[] = ['facebook'],
  opts: SyncOptions = {},
): Target[] {
  syncSearchTargets(repos, platforms, opts);
  const include = new Map(platforms.map((p) => [p, searchEnabled(cfg, repos, p)]));
  // Only searches an active mission still wants (paused missions' rows are kept but not scanned).
  const wanted = new Set<string>();
  for (const [p, qs] of queriesByPlatform(repos, platforms, opts)) for (const q of qs) wanted.add(SEARCH[p].url(q));
  return repos.targets
    .listDue(now)
    .filter((t) => t.kind !== 'search' || (include.get(t.platform as SearchPlatform) && wanted.has(t.url)));
}
