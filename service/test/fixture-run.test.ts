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
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures', 'group-feed.html'), 'utf8');

describe('fixture group feed: end-to-end run + dedup (Phase 1 acceptance, offline)', () => {
  let browser: Browser;
  let page: Page;
  let repos: Repos;
  let runner: Runner;
  let capturesDir: string;
  let run1: RunReport;
  let run2: RunReport;

  beforeAll(async () => {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();

    capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-captures-'));
    repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    config.update({
      active_hours: { start: '00:00', end: '00:00' },
      fetch: { page_delay_ms: [0, 0], scroll_delay_ms: [0, 0], human: { enabled: false }, max_scrolls: 2, first_scan_lookback_hours: 24 },
    });
    const state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true });
    repos.keywords.add({ keyword: 'xyzbank' });
    repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/testgroup', name: 'Test Group' });

    const getConfig = () => config.get();
    const fakeBrowser = { open: async () => page, close: async () => undefined } as unknown as BrowserManager;
    const registry = new AdapterRegistry();
    registry.register(healthy(new FacebookFeedAdapter('group', fakeBrowser, getConfig, async (p) => p.setContent(FIXTURE))));

    runner = new Runner({
      repos,
      config,
      state,
      registry,
      capturer: new Capturer(repos, getConfig, capturesDir),
      closeBrowser: async () => undefined,
    });

    const s1 = runner.start({ trigger: 'manual' });
    expect(s1.started).toBe(true);
    run1 = await s1.done;
    // Second run must ignore next_due_at, so pass the target explicitly.
    const s2 = runner.start({ trigger: 'manual', targetIds: [1] });
    run2 = await s2.done;
  });

  afterAll(async () => {
    await browser?.close();
    repos?.db.close();
    if (capturesDir) fs.rmSync(capturesDir, { recursive: true, force: true });
  });

  it('first run captures matching posts and comments', () => {
    expect(run1.status).toBe('completed');
    expect(run1.stats.errors).toBe(0);
    // pinned 9000 (post) + 1001 (post + comments 5001, 5003) + pfbid post (comment 7001)
    expect(run1.stats.new_captures).toBe(5);
    const keys = repos.db
      .prepare(`SELECT item_key FROM seen_items WHERE is_match = 1 ORDER BY item_key`)
      .all()
      .map((r) => (r as { item_key: string }).item_key);
    expect(keys).toEqual([
      'fb:comment:1001:5001',
      'fb:comment:1001:5003',
      'fb:comment:pfbid02XyZabc123:7001',
      'fb:post:1001',
      'fb:post:9000',
      'fb:post:pfbid02XyZabc123',
    ]);
  });

  it('records non-matching posts as seen and stops at the cutoff', () => {
    expect(repos.seen.get('fb:post:1002')?.is_match).toBe(0);
    expect(repos.seen.has('fb:post:1004')).toBe(false); // older than cutoff → stop
    expect(repos.seen.has('fb:post:1005')).toBe(false);
  });

  it('writes screenshots and meta.json in the spec §9 layout', () => {
    const row = repos.seen.get('fb:post:1001')!;
    expect(row.capture_path).toMatch(/\d{4}-\d{2}-\d{2}[\\/]xyzbank[\\/]1001$/);
    const meta = JSON.parse(fs.readFileSync(path.join(row.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;
    expect(meta).toMatchObject({
      item_key: 'fb:post:1001',
      type: 'post',
      platform: 'facebook',
      source_type: 'group',
      source_name: 'Test Group',
      url: 'https://www.facebook.com/groups/testgroup/posts/1001',
      author_name: 'Ali Khan',
      matched_keyword: 'xyzbank',
      matched_variant: 'xyzbank',
      matched_in: 'post',
      reaction_count: 42,
      comment_count: 14,
      screenshot: 'post.webp',
    });
    expect(meta.text).toContain('EXPANDED TAIL TEXT'); // "See more" was expanded
    expect(meta.text).not.toMatch(/\bLike\b|Share/);
    expect(meta.posted_at).toMatch(/\+05:00$/);
    expect(meta.comments.map((c) => c.item_key)).toEqual(['fb:comment:1001:5001', 'fb:comment:1001:5003']);
    expect(meta.comments[0]).toMatchObject({ author_name: 'Bilal', matched_variant: 'xyz bank', screenshot: 'comment_5001.webp' });

    for (const f of ['post.webp', 'comment_5001.webp', 'comment_5003.webp']) {
      const buf = fs.readFileSync(path.join(row.capture_path!, f));
      expect(buf.subarray(8, 12).toString()).toBe('WEBP');
    }
  });

  it('captures a non-matching post when a comment matches (matched_in=comment)', () => {
    const row = repos.seen.get('fb:post:pfbid02XyZabc123')!;
    const meta = JSON.parse(fs.readFileSync(path.join(row.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;
    expect(meta.matched_in).toBe('comment');
    expect(meta.matched_keyword).toBeNull();
    expect(meta.comments).toHaveLength(1);
  });

  it('second run produces no new captures and no duplicate keys', () => {
    expect(run2.status).toBe('completed');
    expect(run2.stats.new_captures).toBe(0);
    expect(run2.stats.duplicates_skipped).toBeGreaterThan(0);
    const dupes = repos.db.prepare('SELECT item_key, COUNT(*) n FROM seen_items GROUP BY item_key HAVING n > 1').all();
    expect(dupes).toEqual([]);
    const dirs = fs.readdirSync(capturesDir, { recursive: true }).filter((f) => String(f).endsWith('meta.json'));
    expect(dirs).toHaveLength(3);
    expect(fs.existsSync(path.join(capturesDir, '.staging')) ? fs.readdirSync(path.join(capturesDir, '.staging')) : []).toEqual([]);
  });

  it('DB primary key rejects a duplicate insert (dedup layer 2)', () => {
    expect(() =>
      repos.seen.insert({ item_key: 'fb:post:1001', type: 'post', first_seen: new Date().toISOString(), is_match: 1 }),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('never clicks write actions', async () => {
    expect(await page.evaluate('window.__forbiddenClicks || 0')).toBe(0);
  });

  it('logs run stats and updates target watermark', () => {
    const runs = repos.runs.recent(5);
    expect(runs[0].finished_at).not.toBeNull();
    expect(runs.find((r) => r.id === run1.run_id)?.page_loads).toBe(2); // health check + feed load
    const t = repos.targets.get(1)!;
    expect(t.scans).toBe(2);
    expect(t.watermark).not.toBeNull();
    expect(t.next_due_at).not.toBeNull();
  });
});
