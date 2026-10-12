import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore, StateStore, migrateLegacy } from '../src/config/store.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { HttpClient, NewsSearchAdapter, RssFeedAdapter } from '../src/adapters/feeds/index.js';
import type { SourceAdapter } from '../src/adapters/types.js';
import { Capturer } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';
import { ReviewService } from '../src/review/index.js';
import { createApp } from '../src/api/server.js';
import { runDoctor } from '../src/doctor/index.js';

const NOW = new Date();
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Forum</title>
<item><title>xyzbank charged me twice</title><link>https://forum.pk/t/1</link><guid>1</guid><pubDate>${new Date(NOW.getTime() - 600_000).toUTCString()}</pubDate></item>
</channel></rss>`;

describe('config: platforms switch', () => {
  it('defaults every platform to on', () => {
    expect(new ConfigStore(openDb(':memory:').settings).get().platforms).toEqual({ facebook: true, news: true, rss: true, youtube: true, reddit: true });
  });

  it('migrates old per-section switches into platforms', () => {
    const repos = openDb(':memory:');
    repos.settings.set('config', { news: { enabled: false, interval_hours: 3 }, reddit: { enabled: true } });
    const cfg = new ConfigStore(repos.settings).get();
    expect(cfg.platforms.news).toBe(false);
    expect(cfg.platforms.reddit).toBe(true);
    expect(cfg.news.interval_hours).toBe(3);
    expect((cfg.news as Record<string, unknown>).enabled).toBeUndefined();
    expect(migrateLegacy({ platforms: { news: true }, news: { enabled: false } })).toMatchObject({ platforms: { news: true } });
  });

  it('rejects unknown platform names', () => {
    const store = new ConfigStore(openDb(':memory:').settings);
    expect(() => store.update({ platforms: { tiktok: true } })).toThrow(ZodError);
  });
});

describe('platform switches: runner, API, doctor', () => {
  let repos: Repos;
  let config: ConfigStore;
  let state: StateStore;
  let runner: Runner;
  let server: Server;
  let base: string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-platforms-'));
  const fbCalls: string[] = [];
  const TOKEN = 't'.repeat(40);

  const fetchImpl = (async (input: string | URL) => {
    const u = String(input);
    if (u.startsWith('https://forum.pk/feed')) return new Response(RSS);
    if (u.includes('news.google.com') || u.includes('bing.com')) return new Response(RSS.replace('Forum', 'News'));
    return new Response('nf', { status: 404 });
  }) as typeof fetch;

  beforeAll(async () => {
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true });
    config.update({ active_hours: { start: '00:00', end: '00:00' } });
    repos.keywords.add({ keyword: 'xyzbank' });

    const http = new HttpClient({ fetch: fetchImpl, sleep: async () => undefined, minHostIntervalMs: 0 });
    const registry = new AdapterRegistry();
    registry.register(new NewsSearchAdapter(http, () => config.get(), () => repos.keywords.listEnabled()));
    registry.register(new RssFeedAdapter(http, () => config.get()));
    const fb: SourceAdapter = {
      id: 'facebook_group',
      platform: 'facebook',
      usesPageBudget: true,
      isConfigured: () => true,
      healthCheck: async () => ({ ok: true, status: 'ok' }),
      async *scanTarget(t) {
        fbCalls.push(t.url);
      },
      async *expandComments() {},
    };
    registry.register(fb);

    runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), dir), closeBrowser: async () => undefined });
    repos.targets.add({ platform: 'rss', kind: 'feed', url: 'https://forum.pk/feed', name: 'Forum' });
    repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/g', name: 'G' });

    const app = createApp({
      repos,
      config,
      state,
      runner,
      review: new ReviewService(repos, () => config.get(), dir),
      registry,
      http,
      token: TOKEN,
      port: 0,
      connectFacebook: async () => undefined,
      startedAt: NOW,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterAll(() => {
    server?.close();
    repos?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const api = (p: string, init: RequestInit = {}) =>
    fetch(base + p, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  const resetDue = () => {
    for (const t of repos.targets.list()) repos.targets.update(t.id, { next_due_at: null });
  };

  it('GET /platforms lists all five with state', async () => {
    const r = await api('/platforms');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { platform: string; enabled: boolean; account_risk: boolean; targets: number; ready: string }[];
    expect(body.map((p) => p.platform)).toEqual(['facebook', 'news', 'rss', 'youtube', 'reddit']);
    expect(body.find((p) => p.platform === 'facebook')).toMatchObject({ enabled: true, account_risk: true, targets: 1, ready: 'yes' });
    expect(body.find((p) => p.platform === 'youtube')).toMatchObject({ configured: false, needs: 'YOUTUBE_API_KEY' });
  });

  it('PATCH validates platform name and body', async () => {
    expect((await api('/platforms/tiktok', { method: 'PATCH', body: '{"enabled":false}' })).status).toBe(400);
    expect((await api('/platforms/news', { method: 'PATCH', body: '{"enabled":"no"}' })).status).toBe(400);
  });

  it('disabling news and facebook removes them silently; RSS still runs; search rows are kept', async () => {
    resetDue();
    runner.dueTargets(); // creates the news search row
    const newsRow = repos.targets.list().find((t) => t.platform === 'news')!;
    expect(newsRow).toBeTruthy();

    for (const p of ['news', 'facebook']) {
      const r = await api(`/platforms/${p}`, { method: 'PATCH', body: '{"enabled":false}' });
      expect(((await r.json()) as { enabled: boolean; ready: string })).toMatchObject({ enabled: false, ready: 'disabled' });
    }
    expect(runner.dueTargets().map((t) => t.platform)).toEqual(['rss']);
    expect(repos.targets.get(newsRow.id)).toBeTruthy(); // kept for its watermark

    const report = await runner.start({ trigger: 'manual' }).done;
    expect(report.targets.map((t) => t.platform)).toEqual(['rss']);
    expect(report.reason ?? '').not.toMatch(/skipped/); // no noise for switched-off platforms
    expect(fbCalls).toEqual([]);
    expect(runner.platformStatus()).toMatchObject({ news: 'disabled', facebook: 'disabled', rss: 'yes' });

    const status = (await (await api('/status')).json()) as { platforms: Record<string, string> };
    expect(status.platforms.news).toBe('disabled');
  });

  it('re-enabling resumes scanning', async () => {
    for (const p of ['news', 'facebook']) await api(`/platforms/${p}`, { method: 'PATCH', body: '{"enabled":true}' });
    resetDue();
    const report = await runner.start({ trigger: 'manual' }).done;
    expect(new Set(report.targets.map((t) => t.platform))).toEqual(new Set(['news', 'rss', 'facebook']));
    expect(fbCalls).toEqual(['https://www.facebook.com/groups/g']);
  });

  it('doctor shows disabled platforms as info and warns when all are off', () => {
    config.update({ platforms: { facebook: false } });
    const d1 = runDoctor({ config: config.get(), state: state.get(), repos, registry: new AdapterRegistry(), dataDir: dir, env: {} });
    expect(d1.find((c) => c.area === 'facebook')).toMatchObject({ status: 'info', detail: expect.stringMatching(/disabled/) });
    expect(d1.some((c) => c.area === 'facebook risk')).toBe(false);

    config.update({ platforms: { facebook: false, news: false, rss: false, youtube: false, reddit: false } });
    const d2 = runDoctor({ config: config.get(), state: state.get(), repos, registry: new AdapterRegistry(), dataDir: dir, env: {} });
    expect(d2.find((c) => c.check === 'Platforms')).toMatchObject({ status: 'warn' });
  });
});
