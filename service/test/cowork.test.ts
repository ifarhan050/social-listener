import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore, StateStore, migrateLegacy } from '../src/config/store.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { FacebookFeedAdapter } from '../src/adapters/facebook/groupFeed.js';
import { groupSearchUrl } from '../src/adapters/facebook/urls.js';
import { Human, dwellMs, shuffle, wheelSteps } from '../src/adapters/facebook/human.js';
import type { BrowserManager } from '../src/adapters/facebook/browser.js';
import { HttpClient } from '../src/adapters/feeds/index.js';
import { Capturer } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';
import { SchedulerLoop } from '../src/scheduler/loop.js';
import { ReviewService } from '../src/review/index.js';
import { FacebookGroupReport, isOwnPage } from '../src/reports/facebookGroups.js';
import { createApp } from '../src/api/server.js';
import { currentLaunchSpec } from '../src/app.js';
import { startService, validateLaunch } from '../../plugin-mcp/src/autostart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = path.resolve(here, '..');
const GROUP_SEARCH = fs.readFileSync(path.join(here, 'fixtures', 'group-search.html'), 'utf8');
const SOFT_BLOCK = `<div role="navigation">nav</div><div role="dialog"><h2>You're Temporarily Blocked</h2></div>`;

/** Deterministic RNG for tests. */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

// --- Scheduling is driven by Cowork -----------------------------------------------------

describe('scheduler trigger', () => {
  it('defaults to cowork and drops the legacy scheduler.enabled', () => {
    const repos = openDb(':memory:');
    repos.settings.set('config', { scheduler: { enabled: true, tick_seconds: 30 } });
    const cfg = new ConfigStore(repos.settings).get();
    expect(cfg.scheduler.trigger).toBe('cowork');
    expect(cfg.scheduler.tick_seconds).toBe(30);
    expect(migrateLegacy({ scheduler: { enabled: false } })).toEqual({ scheduler: {} });
  });

  it('the built-in loop starts nothing under cowork, and starts due runs under service', () => {
    const repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    const start = vi.fn(() => ({ started: true }));
    const runner = { busy: null, dueTargets: () => [{ id: 1 }], blockedReason: () => null, start } as unknown as Runner;
    const loop = new SchedulerLoop(runner, config);
    loop.tick();
    expect(start).not.toHaveBeenCalled();
    config.update({ scheduler: { trigger: 'service' } });
    loop.tick();
    expect(start).toHaveBeenCalledOnce();
  });
});

// --- Auto-start ------------------------------------------------------------------------

describe('plugin auto-start', () => {
  const good = () => currentLaunchSpec(SERVICE_ROOT, path.join(SERVICE_ROOT, 'src', 'index.ts'));

  it('accepts the launch spec the service writes', () => {
    const v = validateLaunch(good());
    expect(v.ok).toBe(true);
  });

  it.each([
    ['missing', undefined, /no launch info/],
    ['bad node', { ...good(), node: 'C:/Windows/System32/cmd.exe' }, /node path/],
    ['other folder', { ...good(), cwd: os.tmpdir() }, /package.json|not the social-listener/],
    ['script outside project', { ...good(), args: [process.execPath] }, /script paths/],
  ])('rejects %s', (_n, spec, re) => {
    const v = validateLaunch(spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(re as RegExp);
  });

  it('only passes through service env vars', () => {
    const v = validateLaunch({ ...good(), env: { SOCIAL_LISTENER_PORT: '4799', PATH: 'evil', NODE_OPTIONS: '--require x' } });
    expect(v.ok && v.spec.env).toEqual({ SOCIAL_LISTENER_PORT: '4799' });
  });

  it('spawns detached once and waits until the service answers', async () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    let pings = 0;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-auto-'));
    const spec = { ...good(), env: { SOCIAL_LISTENER_DATA_DIR: dataDir } };
    const r = await startService(spec, { spawn: spawn as never, ping: async () => ++pings >= 2, sleep: async () => undefined });
    expect(r.ok).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [node, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean; windowsHide: boolean; cwd: string }];
    expect(node).toBe(process.execPath);
    expect(args[1]).toMatch(/src[\\/]index\.ts$/);
    expect(opts).toMatchObject({ detached: true, windowsHide: true, cwd: SERVICE_ROOT });
    expect(unref).toHaveBeenCalled();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

// --- Human-like pacing ------------------------------------------------------------------

describe('human pacing', () => {
  it('splits scrolling into wheel steps that add up', () => {
    const steps = wheelSteps(700, [80, 160], seq(0, 0.5, 0.999)); // Math.random() is < 1
    expect(steps.reduce((a, b) => a + b, 0)).toBe(700);
    expect(steps.slice(0, -1).every((s) => s >= 80 && s <= 160)).toBe(true);
  });

  it('reading time grows with text length and is capped', () => {
    const short = dwellMs('one two three', [240, 240], 12000, () => 0);
    const long = dwellMs('word '.repeat(200), [240, 240], 12000, () => 0);
    expect(short).toBe(750);
    expect(long).toBe(12000);
    expect(dwellMs('', [200, 300], 12000)).toBe(0);
  });

  it('shuffle is a permutation', () => {
    const s = shuffle([1, 2, 3, 4, 5], seq(0.9, 0.1, 0.5, 0.3));
    expect([...s].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('waits when enabled, never when disabled', async () => {
    const waits: number[] = [];
    const cfg = new ConfigStore(openDb(':memory:').settings);
    const h = new Human(() => cfg.get().fetch.human, () => 0, async (ms) => void waits.push(ms));
    await h.read('a b c d e f g h i j');
    await h.breakBetweenTargets();
    expect(waits).toEqual([3000, 20000]); // 10 words at 200 wpm; minimum break
    cfg.update({ fetch: { human: { enabled: false } } });
    waits.length = 0;
    await h.read('a b c');
    await h.breakBetweenTargets();
    expect(waits).toEqual([]);
  });
});

// --- Facebook group report job ------------------------------------------------------------

describe('Facebook group report job (offline fixtures)', () => {
  let browser: Browser;
  let page: Page;
  let repos: Repos;
  let config: ConfigStore;
  let state: StateStore;
  let runner: Runner;
  let report: FacebookGroupReport;
  let server: Server;
  let base: string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-report-'));
  const loaded: string[] = [];
  let pageHtml = (_url: string) => GROUP_SEARCH;
  const TOKEN = 'k'.repeat(40);

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true });
    config.update({
      active_hours: { start: '00:00', end: '00:00' },
      fetch: { page_delay_ms: [0, 0], scroll_delay_ms: [0, 0], max_scrolls: 1, human: { enabled: false } },
      brand: { own_pages: ['XYZ Bank Official'] },
    });
    repos.keywords.add({ keyword: 'xyzbank' });
    repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/testgroup', name: 'Test Group' });
    repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/second', name: 'Second Group' });

    const getConfig = () => config.get();
    const fakeBrowser = { open: async () => page, close: async () => undefined } as unknown as BrowserManager;
    const nav = async (p: Page, url: string) => {
      loaded.push(url);
      await p.setContent(pageHtml(url));
    };
    const healthy = <T extends object>(a: T) => Object.assign(a, { healthCheck: async () => ({ ok: true, status: 'ok' as const }) });
    const searchAdapter = healthy(new FacebookFeedAdapter('group_search', fakeBrowser, getConfig, nav));
    const feedAdapter = healthy(new FacebookFeedAdapter('group', fakeBrowser, getConfig, nav));
    const registry = new AdapterRegistry();
    registry.register(feedAdapter);
    runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, getConfig, dir), closeBrowser: async () => undefined });
    report = new FacebookGroupReport({ repos, config, runner, searchAdapter, feedAdapter, closeBrowser: async () => undefined, rng: () => 0.99 });

    server = createApp({
      repos, config, state, runner, registry,
      review: new ReviewService(repos, getConfig, dir),
      http: new HttpClient(),
      groupReport: report,
      token: TOKEN, port: 0, connectFacebook: async () => undefined, startedAt: new Date(),
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterAll(async () => {
    server?.close();
    await browser?.close();
    repos?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const api = (p: string, init: RequestInit = {}) =>
    fetch(base + p, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });

  it('builds group search URLs', () => {
    expect(groupSearchUrl('https://www.facebook.com/groups/testgroup', 'xyz bank')).toBe(
      'https://www.facebook.com/groups/testgroup/search/?q=xyz+bank',
    );
  });

  it('recognizes own pages by name or URL', () => {
    expect(isOwnPage({ authorName: 'XYZ Bank Official', url: 'x' }, ['xyz bank official'])).toBe(true);
    expect(isOwnPage({ authorName: 'Ali', url: 'https://www.facebook.com/XYZBank/posts/1' }, ['https://www.facebook.com/XYZBank'])).toBe(true);
    expect(isOwnPage({ authorName: 'Ali', url: 'https://www.facebook.com/groups/g/posts/1' }, ['XYZ Bank'])).toBe(false);
  });

  it('collects matching posts from the last 30 days with ALL their comments (via the API)', async () => {
    const r = await api('/reports/facebook-groups', { method: 'POST', body: JSON.stringify({ group_ids: [1], days: 30 }) });
    expect(r.status).toBe(202);
    const { job_id } = (await r.json()) as { job_id: number };
    expect(runner.busy).toBe('report');
    expect(runner.start({ trigger: 'manual' }).reason).toBe('busy: report in progress'); // never overlaps a scan
    await vi.waitFor(() => expect(report.get(job_id)!.status).not.toBe('running'), { timeout: 30_000, interval: 200 });

    const job = (await (await api(`/reports/${job_id}`)).json()) as {
      status: string;
      posts: { post_key: string; group_name: string; author: string; comments: { author: string; text: string }[] }[];
    };
    expect(job.status).toBe('done');
    expect(job.posts.map((p) => p.post_key).sort()).toEqual(['fb:post:3001', 'fb:post:3004']); // old, own-page and non-matching excluded
    const p1 = job.posts.find((p) => p.post_key === 'fb:post:3001')!;
    expect(p1).toMatchObject({ group_name: 'Test Group', author: 'Ayesha Khan' });
    expect(p1.comments.map((c) => c.author)).toEqual(['Hamza', 'Sana', 'Omar', 'Nida']); // all comments, incl. non-keyword ones
    expect(loaded.some((u) => u.includes('/groups/testgroup/search/?q=xyzbank'))).toBe(true);
    expect(await page.evaluate('window.__forbiddenClicks || 0')).toBe(0);
  });

  it('ends partial when the page budget runs out, and resume finishes without duplicates', async () => {
    config.update({ fetch: { run_page_budget: 2 } }); // health check + one group search
    const s = report.start({ days: 30 });
    expect(s.started).toBe(true);
    await s.done;
    const j1 = report.get(s.job_id!)!;
    expect(j1.status).toBe('partial');
    expect(j1.progress.remaining).toHaveLength(1);

    config.update({ fetch: { run_page_budget: 40 } });
    const r = report.start({ resume_job_id: s.job_id });
    expect(r.started).toBe(true);
    await r.done;
    const j2 = report.get(s.job_id!)!;
    expect(j2.status).toBe('done');
    expect(j2.progress.done.sort()).toEqual([1, 2]);
    const keys = j2.posts.map((p) => `${p.group_url}|${p.post_key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a soft block aborts the job and pauses Facebook', async () => {
    pageHtml = () => SOFT_BLOCK;
    const s = report.start({ group_ids: [1] });
    await s.done;
    const job = report.get(s.job_id!)!;
    expect(job.status).toBe('aborted');
    expect(state.get().paused_reason).toBe('rate_limited');
    pageHtml = () => GROUP_SEARCH;
  });

  it('refuses with a reason when Facebook is not ready', async () => {
    // Still paused from the soft block above.
    expect(report.start({}).reason).toMatch(/facebook: paused after a Facebook soft block/);
    state.patch({ paused_until: null, paused_reason: null });
    config.update({ platforms: { facebook: false } });
    const r = await api('/reports/facebook-groups', { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { reason: string }).reason).toBe('facebook: disabled');
    config.update({ platforms: { facebook: true } });
    expect((await api('/reports/facebook-groups', { method: 'POST', body: '{"days":500}' })).status).toBe(400);
  });
});
