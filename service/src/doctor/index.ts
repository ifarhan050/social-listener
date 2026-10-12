import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { RuntimeState } from '../config/store.js';
import { PLATFORMS, configSchema } from '../config/schema.js';
import { effectiveQueries } from '../missions/index.js';
import type { Repos } from '../db/index.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import { findBrowserExecutable, profileDirFor, resolveChannel } from '../adapters/facebook/browser.js';
import type { YouTubeQuota } from '../adapters/youtube/index.js';
import type { RunReport } from '../scheduler/runner.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  area: string;
  check: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorInput {
  config: Config;
  state: RuntimeState;
  repos: Repos;
  registry: AdapterRegistry;
  youtubeQuota?: YouTubeQuota;
  lastRun?: RunReport | null;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  now?: Date;
}

const DEFAULTS = configSchema.parse({});
const hoursBetween = (start: string, end: string) => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const d = (m(end) - m(start) + 1440) % 1440;
  return d === 0 ? 24 : d / 60;
};

/**
 * Health and risk report, in the spirit of `agent-reach doctor`: environment,
 * each platform's readiness, and settings that raise the chance of a Facebook
 * restriction, each with a plain-English fix. Offline; `probe()` handles live checks.
 */
export function runDoctor(i: DoctorInput): Check[] {
  const { config: cfg, state: st, repos, env } = i;
  const now = i.now ?? new Date();
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // --- Environment -------------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  add({ area: 'environment', check: 'Node.js', status: major >= 20 ? 'ok' : 'fail', detail: `v${process.versions.node}`, fix: major >= 20 ? undefined : 'Install Node.js 20 or newer.' });
  try {
    fs.mkdirSync(i.dataDir, { recursive: true });
    fs.accessSync(i.dataDir, fs.constants.W_OK);
    add({ area: 'environment', check: 'Data folder writable', status: 'ok', detail: i.dataDir });
  } catch {
    add({ area: 'environment', check: 'Data folder writable', status: 'fail', detail: i.dataDir, fix: 'Check folder permissions or set SOCIAL_LISTENER_DATA_DIR.' });
  }

  // --- Facebook ----------------------------------------------------------------------
  // Skipped entirely while Facebook is switched off (platforms.facebook).
  if (!cfg.platforms.facebook) {
    add({ area: 'facebook', check: 'Facebook', status: 'info', detail: 'disabled (platforms.facebook = false)' });
  } else {
    const channel = resolveChannel(cfg.browser.channel);
    const exe = findBrowserExecutable(cfg.browser.channel);
    if (cfg.browser.channel !== 'chromium' && !exe)
      add({ area: 'facebook', check: 'Browser', status: 'warn', detail: `${cfg.browser.channel} not installed; falling back to bundled Chromium`, fix: 'Install Google Chrome, or set browser.channel to msedge.' });
    else if (channel === 'chromium')
      add({ area: 'facebook', check: 'Browser', status: 'warn', detail: 'bundled Chromium: login happens in an automation-flagged window (CAPTCHA loops)', fix: 'Set browser.channel to "chrome" and reconnect.' });
    else add({ area: 'facebook', check: 'Browser', status: 'ok', detail: `${channel} (${exe})` });

    const profile = path.join(i.dataDir, path.basename(profileDirFor(channel)));
    if (!fs.existsSync(profile))
      add({ area: 'facebook', check: 'Login profile', status: 'warn', detail: 'not created yet', fix: 'Connect Facebook from the dashboard or run `npm run connect`.' });

    if (!st.risk_acknowledged)
      add({ area: 'facebook', check: 'Risk notice', status: 'warn', detail: 'not acknowledged, so Facebook scanning is off', fix: 'Acknowledge it on the dashboard if you want Facebook scanning.' });

    const paused = st.paused_until && new Date(st.paused_until) > now;
    if (st.session_status === 'needs_reconnect')
      add({ area: 'facebook', check: 'Session', status: 'fail', detail: 'needs reconnect (login wall or checkpoint)', fix: 'Reconnect Facebook, then wait for the pause to end before scanning.' });
    else if (paused)
      add({ area: 'facebook', check: 'Session', status: 'warn', detail: `paused until ${st.paused_until} (${st.paused_reason ?? 'checkpoint'})`, fix: 'Let the pause run out; do not log in again repeatedly.' });
    else
      add({ area: 'facebook', check: 'Session', status: st.session_status === 'ok' ? 'ok' : 'info', detail: `${st.session_status}${st.session_checked_at ? `, checked ${st.session_checked_at}` : ''}` });

    // --- Facebook risk warnings ------------------------------------------------------------
    const risk = (check: string, detail: string, fix: string) => add({ area: 'facebook risk', check, status: 'warn', detail, fix });
    const win = hoursBetween(cfg.active_hours.start, cfg.active_hours.end);
    if (win >= 24) risk('Active hours', 'disabled: Facebook can be scanned 24/7, which looks automated', 'Set active_hours to a waking window, e.g. 08:00–23:00.');
    else if (win > 16) risk('Active hours', `${win} h window is wider than a typical day`, 'Narrow active_hours to about 15 hours or fewer.');
    if (cfg.fetch.daily_page_budget > DEFAULTS.fetch.daily_page_budget)
      risk('Daily page budget', `${cfg.fetch.daily_page_budget} page loads/day (default ${DEFAULTS.fetch.daily_page_budget})`, 'Lower fetch.daily_page_budget; use news/YouTube/RSS for wider coverage.');
    if (cfg.fetch.run_page_budget > DEFAULTS.fetch.run_page_budget)
      risk('Run page budget', `${cfg.fetch.run_page_budget} page loads/run (default ${DEFAULTS.fetch.run_page_budget})`, 'Lower fetch.run_page_budget.');
    if (cfg.fetch.page_delay_ms[0] < DEFAULTS.fetch.page_delay_ms[0] || cfg.fetch.scroll_delay_ms[0] < DEFAULTS.fetch.scroll_delay_ms[0])
      risk('Delays', `page ${cfg.fetch.page_delay_ms.join('–')} ms, scroll ${cfg.fetch.scroll_delay_ms.join('–')} ms are faster than defaults`, 'Restore fetch.page_delay_ms and fetch.scroll_delay_ms defaults.');
    const hum = cfg.fetch.human;
    if (!hum.enabled) risk('Human pacing', 'turned off: Facebook pages are scrolled and clicked at machine speed', 'Set fetch.human.enabled to true.');
    else if (hum.max_dwell_ms < DEFAULTS.fetch.human.max_dwell_ms || hum.target_break_ms[0] < DEFAULTS.fetch.human.target_break_ms[0] || hum.click_pause_ms[0] < DEFAULTS.fetch.human.click_pause_ms[0])
      risk('Human pacing', 'reading time, click pauses or breaks are shorter than the defaults', 'Restore the fetch.human defaults.');
    if (cfg.search.mode !== 'off' && cfg.search.min_interval_hours < DEFAULTS.search.min_interval_hours)
      risk('Facebook search frequency', `every ${cfg.search.min_interval_hours} h per keyword`, `Keep search.min_interval_hours at ${DEFAULTS.search.min_interval_hours}+; Facebook search is closely watched.`);
    if (cfg.fetch.default_interval_hours < 2)
      risk('Revisit interval', `targets revisited every ${cfg.fetch.default_interval_hours} h`, 'Use 2–3 h or more for Facebook targets.');
    const fbTargets = repos.targets.list().filter((t) => t.platform === 'facebook' && t.kind !== 'search' && t.status === 'active').length;
    if (fbTargets > 15) risk('Facebook targets', `${fbTargets} active groups/pages`, 'Keep the busiest 10–15; cover the rest with keyword search on zero-account sources.');
    if (st.last_restriction_at && now.getTime() - new Date(st.last_restriction_at).getTime() < 7 * 86_400_000)
      risk('Recent restriction', `Facebook checkpoint/soft block at ${st.last_restriction_at}`, 'Halve the daily budget and target count for a week.');
  }

  // --- API / zero-account platforms ---------------------------------------------------------
  const platformLine = (platform: string, label: string, needs?: string) => {
    const adapters = i.registry.forPlatform(platform);
    if (!adapters.length) return;
    if ((cfg.platforms as Record<string, boolean>)[platform] === false) {
      add({ area: platform, check: label, status: 'info', detail: `disabled (platforms.${platform} = false)` });
      return;
    }
    const configured = adapters.some((a) => a.isConfigured());
    const h = st.platform_health[platform];
    if (!configured)
      add({ area: platform, check: label, status: 'info', detail: needs ? `not set up (${needs})` : 'disabled', fix: needs ? `Add ${needs} to service/.env and restart.` : undefined });
    else if (h?.status === 'error')
      add({ area: platform, check: label, status: 'fail', detail: h.detail ?? 'last check failed', fix: 'Check credentials/network; it retries automatically.' });
    else add({ area: platform, check: label, status: 'ok', detail: h?.checked_at ? `last check ${h.checked_at}` : 'ready' });
  };
  platformLine('news', 'News search (Google/Bing News RSS)');
  platformLine('rss', 'Custom RSS feeds');
  platformLine('youtube', 'YouTube Data API', 'YOUTUBE_API_KEY');
  platformLine('reddit', 'Reddit API', 'REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET');
  if (i.youtubeQuota && env.YOUTUBE_API_KEY) {
    const used = i.youtubeQuota.used();
    add({ area: 'youtube', check: 'Daily quota', status: used >= cfg.youtube.daily_quota_units ? 'warn' : 'ok', detail: `${used}/${cfg.youtube.daily_quota_units} units used today (Pacific time)` });
  }

  // Per-target errors from the last run.
  for (const t of i.lastRun?.targets ?? []) {
    if (t.error) add({ area: t.platform, check: `Last run: ${t.name ?? t.target_id}`, status: 'warn', detail: t.error });
  }

  // Facebook dates: if most posts in the last scan had only approximate dates, time windows don't work.
  const lastFb = repos.runs
    .recent(10)
    .map((r) => {
      try {
        return JSON.parse(r.notes ?? '{}') as { fb_dated?: number; fb_approx?: number };
      } catch {
        return {};
      }
    })
    .find((n) => (n.fb_dated ?? 0) + (n.fb_approx ?? 0) > 0);
  if (lastFb) {
    const total = (lastFb.fb_dated ?? 0) + (lastFb.fb_approx ?? 0);
    if ((lastFb.fb_approx ?? 0) / total > 0.5)
      add({ area: 'facebook', check: 'Post dates', status: 'warn', detail: `${lastFb.fb_approx} of ${total} Facebook posts in the last scan had no exact date, so date windows are approximate`, fix: 'Run debug_facebook_snapshot and share the saved file so the date selectors can be fixed.' });
    else add({ area: 'facebook', check: 'Post dates', status: 'ok', detail: `${lastFb.fb_dated} of ${total} Facebook posts had exact dates in the last scan` });
  }

  // Low-yield targets: read many times, never matched.
  for (const t of repos.targets.list())
    if (t.status === 'active' && t.scans > 5 && t.hit_rate_ema === 0)
      add({ area: t.platform, check: `Low yield: ${t.name ?? t.url}`, status: 'info', detail: `scanned ${t.scans} times with 0 matches`, fix: 'Pause it (update_target status paused) or move it to another mission.' });

  // --- Coverage -----------------------------------------------------------------------------
  if (Object.values(cfg.platforms).every((on) => !on))
    add({ area: 'setup', check: 'Platforms', status: 'warn', detail: 'every platform is switched off, so nothing will be collected', fix: 'Turn at least one on with /platforms (news and RSS need no account).' });
  // --- Missions ---------------------------------------------------------------------------
  const keywords = repos.keywords.list();
  const missions = repos.missions.list();
  const active = missions.filter((m) => m.status === 'active');
  if (!active.length) {
    add({ area: 'missions', check: 'Missions', status: 'fail', detail: missions.length ? 'all missions are paused' : 'no missions yet', fix: 'Run /setup (or /new-mission) in Cowork to say what you want to find.' });
  } else {
    add({ area: 'missions', check: 'Missions', status: 'ok', detail: active.map((m) => `${m.name} (${m.template})`).join('; ') });
  }
  for (const m of active) {
    const queries = effectiveQueries(m, keywords);
    if (!queries.length)
      add({ area: 'missions', check: `${m.name}: search phrases`, status: 'warn', detail: 'none — only monitored groups/pages/feeds are scanned for it', fix: 'Add search phrases with /missions edit.' });
    const sources = PLATFORMS.filter((p) => m.sources[p] !== false && cfg.platforms[p]);
    if (!sources.length)
      add({ area: 'missions', check: `${m.name}: sources`, status: 'warn', detail: 'no enabled source for this mission', fix: 'Turn a platform on (/platforms) or edit the mission sources.' });
    if ((m.template === 'leads' || m.template === 'businesses') && cfg.retention.local_retention_days > 30)
      add({ area: 'missions', check: `${m.name}: personal data`, status: 'info', detail: `captures are kept ${cfg.retention.local_retention_days} days`, fix: 'Keep lead/contact data only as long as you need it (retention.local_retention_days).' });
  }
  if (cfg.platforms.facebook) {
    const fbQueries = new Set(active.filter((m) => m.sources.facebook !== false).flatMap((m) => effectiveQueries(m, keywords).map((q) => q.toLowerCase())));
    if (fbQueries.size > cfg.search.max_queries)
      add({ area: 'facebook', check: 'Facebook search phrases', status: 'info', detail: `${fbQueries.size} phrases across missions; only the first ${cfg.search.max_queries} are searched on Facebook (account safety)`, fix: 'The rest are still searched on news, YouTube and Reddit. Put the most important phrases first.' });
  }
  return out;
}

export function summarize(checks: Check[]): { ok: number; warn: number; fail: number; info: number } {
  const s = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) s[c.status]++;
  return s;
}
