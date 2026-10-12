import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { FacebookFeedAdapter } from '../src/adapters/facebook/groupFeed.js';
import type { BrowserManager } from '../src/adapters/facebook/browser.js';
import { Capturer, type CaptureMeta } from '../src/capture/index.js';
import { Runner, type RunReport } from '../src/scheduler/runner.js';

/** Fixture adapters must not hit facebook.com for their health check. */
const healthy = <T extends { healthCheck: unknown }>(a: T): T => Object.assign(a, { healthCheck: async () => ({ ok: true, status: 'ok' as const }) });

const here = path.dirname(fileURLToPath(import.meta.url));
const SEARCH = fs.readFileSync(path.join(here, 'fixtures', 'search-results.html'), 'utf8');
const FEED = fs.readFileSync(path.join(here, 'fixtures', 'group-feed.html'), 'utf8');

const readMeta = (repos: Repos, key: string) =>
  JSON.parse(fs.readFileSync(path.join(repos.seen.get(key)!.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;

describe('keyword search (no groups/pages) and page targets — offline', () => {
  let browser: Browser;
  let page: Page;
  let repos: Repos;
  let runner: Runner;
  let config: ConfigStore;
  let capturesDir: string;
  const loaded: string[] = [];
  let searchRun: RunReport;
  let pageRun: RunReport;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-search-'));
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    config.update({
      active_hours: { start: '00:00', end: '00:00' },
      fetch: { page_delay_ms: [0, 0], scroll_delay_ms: [0, 0], human: { enabled: false }, max_scrolls: 1, first_scan_lookback_hours: 24 },
    });
    const state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true });
    repos.keywords.add({ keyword: 'xyzbank' });

    const getConfig = () => config.get();
    const fakeBrowser = { open: async () => page, close: async () => undefined } as unknown as BrowserManager;
    const registry = new AdapterRegistry();
    const nav = (html: string) => async (p: Page, url: string) => {
      loaded.push(url);
      await p.setContent(html);
    };
    registry.register(healthy(new FacebookFeedAdapter('search', fakeBrowser, getConfig, nav(SEARCH))));
    registry.register(healthy(new FacebookFeedAdapter('page', fakeBrowser, getConfig, nav(FEED))));

    runner = new Runner({
      repos,
      config,
      state,
      registry,
      capturer: new Capturer(repos, getConfig, capturesDir),
      closeBrowser: async () => undefined,
    });

    // 1) No targets at all → keyword search runs.
    searchRun = await runner.start({ trigger: 'manual' }).done;

    // 2) Add a page → search stops (when_no_targets); the page timeline is scanned.
    repos.targets.add({ platform: 'facebook', kind: 'page', url: 'https://www.facebook.com/XYZBankOfficial', name: 'XYZ Bank' });
    loaded.length = 0;
    pageRun = await runner.start({ trigger: 'manual' }).done;
  });

  afterAll(async () => {
    await browser?.close();
    repos?.db.close();
    if (capturesDir) fs.rmSync(capturesDir, { recursive: true, force: true });
  });

  it('runs a Recent-posts search for each keyword when no groups/pages exist', () => {
    expect(searchRun.status).toBe('completed');
    expect(searchRun.targets.map((t) => t.name)).toEqual(['Search: xyzbank']);
  });

  it('skips old search results instead of stopping, then stops after consecutive old ones', () => {
    expect(searchRun.stats.new_captures).toBe(2);
    expect(repos.seen.has('fb:post:2001')).toBe(true);
    expect(repos.seen.has('fb:post:pfbid0page1')).toBe(true);
    expect(repos.seen.has('fb:post:2000')).toBe(false); // too old → skipped
    expect(repos.seen.has('fb:post:2009')).toBe(false); // after 4 consecutive old → stopped
  });

  it('records the group a search hit came from', () => {
    expect(readMeta(repos, 'fb:post:2001')).toMatchObject({
      found_via: 'search',
      source_type: 'group',
      source_name: 'Karachi Bankers',
      source_url: 'https://www.facebook.com/groups/karachibankers',
      author_name: 'Ayesha',
      url: 'https://www.facebook.com/groups/karachibankers/posts/2001',
      matched_variant: 'xyz bank',
    });
    expect(readMeta(repos, 'fb:post:pfbid0page1')).toMatchObject({
      found_via: 'search',
      source_type: 'search',
      source_name: 'Search: xyzbank',
      url: 'https://www.facebook.com/XYZBankOfficial/posts/pfbid0page1',
    });
  });

  it('scans page timelines once a page is added, and stops searching', () => {
    expect(pageRun.status).toBe('completed');
    expect(pageRun.targets.map((t) => t.name)).toEqual(['XYZ Bank']);
    expect(loaded).toEqual(['https://www.facebook.com/XYZBankOfficial']);
    expect(pageRun.stats.new_captures).toBeGreaterThan(0);
    expect(readMeta(repos, 'fb:post:1001')).toMatchObject({ found_via: 'feed', source_type: 'page', source_name: 'XYZ Bank' });
  });
});
