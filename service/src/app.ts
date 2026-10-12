import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigStore, StateStore } from './config/store.js';
import { openDb, type Repos } from './db/index.js';
import { AdapterRegistry } from './adapters/registry.js';
import { BrowserManager } from './adapters/facebook/browser.js';
import { FacebookFeedAdapter } from './adapters/facebook/groupFeed.js';
import { connectInteractive } from './adapters/facebook/session.js';
import { RedditAdapter, RedditClient } from './adapters/reddit/index.js';
import { HttpClient, NewsSearchAdapter, RssFeedAdapter } from './adapters/feeds/index.js';
import { YouTubeAdapter, YouTubeQuota } from './adapters/youtube/index.js';
import { Capturer } from './capture/index.js';
import { Runner } from './scheduler/runner.js';
import { ReviewService } from './review/index.js';
import { FacebookGroupReport } from './reports/facebookGroups.js';
import { FindService } from './find/index.js';
import { facebookSnapshot } from './debug/fbSnapshot.js';
import { ensureLegacyMission } from './missions/index.js';
import { SchedulerLoop } from './scheduler/loop.js';
import { CAPTURES_DIR, CONNECTION_DIR, CONNECTION_FILE, DATA_DIR, DB_PATH, ENV_FILE } from './util/paths.js';
import { SECRET_KEYS, secretsStatus, upsertEnvFile, type SecretKey } from './util/envFile.js';
import { logger } from './util/logger.js';

export interface Service {
  repos: Repos;
  config: ConfigStore;
  state: StateStore;
  browser: BrowserManager;
  runner: Runner;
  review: ReviewService;
  registry: AdapterRegistry;
  http: HttpClient;
  youtubeQuota: YouTubeQuota;
  groupReport: FacebookGroupReport;
  find: FindService;
  /** Sanitized DOM outline of a Facebook feed, for fixing selectors. */
  facebookSnapshot: (opts: { target_id?: number; posts?: number }) => Promise<{ file: string; summary: Record<string, unknown> }>;
  loop: SchedulerLoop;
  /** Save API keys to .env and switch the YouTube/Reddit adapters to them (no restart). */
  updateSecrets: (values: Partial<Record<SecretKey, string | null>>) => Record<SecretKey, 'set' | 'not set'>;
  connectFacebook: () => Promise<unknown>;
  shutdown: () => Promise<void>;
}

export function createService(opts: { dbPath?: string; capturesDir?: string; dataDir?: string; envFile?: string } = {}): Service {
  const repos = openDb(opts.dbPath ?? DB_PATH);
  const config = new ConfigStore(repos.settings);
  const state = new StateStore(repos.settings);
  initStore(repos, config);

  const getConfig = () => config.get();
  const browser = new BrowserManager(getConfig);
  const registry = new AdapterRegistry();
  for (const kind of ['group', 'page', 'search'] as const) registry.register(new FacebookFeedAdapter(kind, browser, getConfig));

  // Zero-account sources (no social login, so no account-restriction risk).
  const http = new HttpClient();
  registry.register(new NewsSearchAdapter(http, getConfig, () => repos.keywords.listEnabled()));
  registry.register(new RssFeedAdapter(http, getConfig));
  const youtubeQuota = new YouTubeQuota(repos.settings, () => config.get().youtube.daily_quota_units);

  // API-key sources: Reddit (official API) and YouTube. Keys come from .env only (never the
  // settings table); re-registered when the dashboard saves new keys.
  const registerKeyedAdapters = () => {
    const reddit = RedditClient.fromEnv(process.env, {
      minIntervalMs: () => config.get().reddit.min_request_interval_ms,
      maxRequestsPerRun: () => config.get().reddit.max_requests_per_run,
    });
    for (const kind of ['search', 'subreddit'] as const) registry.register(new RedditAdapter(kind, reddit, getConfig));
    for (const kind of ['search', 'channel'] as const)
      registry.register(new YouTubeAdapter(kind, process.env.YOUTUBE_API_KEY || null, http, youtubeQuota, getConfig));
  };
  registerKeyedAdapters();

  const capturer = new Capturer(repos, getConfig, opts.capturesDir ?? CAPTURES_DIR);
  const review = new ReviewService(repos, getConfig, opts.capturesDir ?? CAPTURES_DIR);
  const runner = new Runner({
    repos,
    config,
    state,
    registry,
    capturer,
    closeBrowser: () => browser.close(),
  });
  const loop = new SchedulerLoop(runner, config);
  const groupReport = new FacebookGroupReport({
    repos,
    config,
    runner,
    searchAdapter: new FacebookFeedAdapter('group_search', browser, getConfig),
    feedAdapter: registry.forTarget({ platform: 'facebook', kind: 'group' })!,
    closeBrowser: () => browser.close(),
  });
  const dataDir = opts.dataDir ?? (opts.dbPath ? path.dirname(opts.dbPath) : DATA_DIR);
  const find = new FindService({
    repos,
    config,
    runner,
    registry,
    groupSearchAdapter: new FacebookFeedAdapter('group_search', browser, getConfig),
    capturer,
    dataDir,
    closeBrowser: () => browser.close(),
  });
  const snapshot = (o: { target_id?: number; posts?: number }) => facebookSnapshot({ repos, config, runner, browser, dataDir }, o);

  const updateSecrets = (values: Partial<Record<SecretKey, string | null>>) => {
    const clean = Object.fromEntries(
      Object.entries(values)
        .filter(([k, v]) => (SECRET_KEYS as readonly string[]).includes(k) && v !== undefined)
        .map(([k, v]) => [k, v?.trim() || null]),
    );
    upsertEnvFile(opts.envFile ?? ENV_FILE, clean);
    for (const [k, v] of Object.entries(clean)) {
      if (v) process.env[k] = v;
      else delete process.env[k];
    }
    registerKeyedAdapters();
    runner.syncSearchTargets();
    logger.info({ keys: Object.keys(clean) }, 'API keys updated');
    return secretsStatus();
  };

  const connectFacebook = () =>
    runner.exclusive('connect', async () => {
      const res = await connectInteractive(browser);
      state.patch({ session_checked_at: new Date().toISOString() });
      if (res.ok) {
        state.patch({ session_status: 'ok', paused_until: null });
        state.clear('session_needs_reconnect');
        logger.info('Facebook connected');
      } else {
        logger.warn({ res }, 'Facebook connect did not complete');
      }
      return res;
    });

  return {
    repos,
    config,
    state,
    browser,
    runner,
    review,
    registry,
    http,
    youtubeQuota,
    groupReport,
    find,
    facebookSnapshot: snapshot,
    loop,
    updateSecrets,
    connectFacebook,
    shutdown: async () => {
      loop.stop();
      runner.abort('shutdown');
      await browser.close();
      repos.db.close();
    },
  };
}

/** First boot only: example keyword so the system is usable end-to-end. No fake targets. */
/**
 * First boot: save default settings. No placeholder keywords or missions: the Cowork
 * /setup wizard creates the user's first mission. Existing installs get their keywords
 * turned into mission #1 (ensureLegacyMission).
 */
function initStore(repos: Repos, config: ConfigStore) {
  if (!repos.settings.get('seeded')) {
    config.update({});
    repos.settings.set('seeded', true);
  }
  ensureLegacyMission(repos);
}

export interface Connection {
  url: string;
  token: string;
  pid: number;
  /** How to start this service again; used by the Cowork plugin to auto-start it. */
  launch?: LaunchSpec;
}

export interface LaunchSpec {
  /** Absolute path of the node executable that ran the service. */
  node: string;
  /** Script args for node: [tsx cli, src/index.ts] in dev, or [dist/index.js] when built. */
  args: string[];
  /** The service folder (must contain package.json named @social-listener/service). */
  cwd: string;
  /** Service settings that came from the environment, so a restart uses the same ones. */
  env: Record<string, string>;
}

/** Describe how the current process was started, for auto-start. */
export function currentLaunchSpec(serviceRoot: string, entryFile: string): LaunchSpec {
  const env: Record<string, string> = {};
  for (const k of ['SOCIAL_LISTENER_DATA_DIR', 'SOCIAL_LISTENER_PORT', 'LOG_LEVEL']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const args = entryFile.endsWith('.ts')
    ? [path.join(serviceRoot, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), entryFile]
    : [entryFile];
  // Prefer a workspace-local tsx if present (npm may hoist it either way).
  if (entryFile.endsWith('.ts')) {
    const local = path.join(serviceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(local)) args[0] = local;
  }
  return { node: process.execPath, args, cwd: serviceRoot, env };
}

/** Reuse the existing local API token if present, else generate one. */
export function loadOrCreateToken(): string {
  if (process.env.SOCIAL_LISTENER_TOKEN) return process.env.SOCIAL_LISTENER_TOKEN;
  try {
    const existing = JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8')) as Partial<Connection>;
    if (existing.token && existing.token.length >= 32) return existing.token;
  } catch {
    /* none yet */
  }
  return randomBytes(32).toString('hex');
}

export function writeConnectionFile(conn: Connection): void {
  fs.mkdirSync(CONNECTION_DIR, { recursive: true });
  fs.writeFileSync(CONNECTION_FILE, JSON.stringify(conn, null, 2), { mode: 0o600 });
}

export function readConnectionFile(): Connection | null {
  try {
    return JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8')) as Connection;
  } catch {
    return null;
  }
}
