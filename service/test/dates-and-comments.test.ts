import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { openDb } from '../src/db/index.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { AdapterRegistry, SimpleBudget } from '../src/adapters/registry.js';
import { FacebookFeedAdapter } from '../src/adapters/facebook/groupFeed.js';
import { parseFacebookTime } from '../src/adapters/facebook/time.js';
import type { BrowserManager } from '../src/adapters/facebook/browser.js';
import type { RawItem, ScanContext, SourceAdapter, Target } from '../src/adapters/types.js';
import { Capturer } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOLTIP = fs.readFileSync(path.join(here, 'fixtures', 'fb-timestamp-tooltip.html'), 'utf8');
const NOW = new Date('2026-10-07T07:00:00Z');

describe('Facebook dates', () => {
  it('parses full tooltip dates (with weekday and year)', () => {
    const p = (s: string) => parseFacebookTime(s, NOW, 'Asia/Karachi')?.toISOString();
    expect(p('Saturday, October 3, 2026 at 3:22 PM')).toBe('2026-10-03T10:22:00.000Z');
    expect(p('Monday, October 6, 2025 at 3:22 PM')).toBe('2025-10-06T10:22:00.000Z');
    expect(p('Monday at 9:00 AM')).toBeDefined();
  });

  describe('tooltip on hover', () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await chromium.launch();
      page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    });
    afterAll(async () => browser?.close());

    it('hovers the timestamp link, reads the exact date and the permalink', async () => {
      const repos = openDb(':memory:');
      const config = new ConfigStore(repos.settings);
      config.update({ timezone: 'Asia/Karachi', fetch: { page_delay_ms: [0, 0], scroll_delay_ms: [0, 0], human: { enabled: false }, max_scrolls: 1 } });
      const fakeBrowser = { open: async () => page, close: async () => undefined } as unknown as BrowserManager;
      const adapter = new FacebookFeedAdapter('group', fakeBrowser, () => config.get(), async (p) => p.setContent(TOOLTIP));
      const target = { id: 1, platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/testgroup', name: 'Test Group' } as Target;
      const ctx: ScanContext = {
        runId: 1,
        cutoffTime: new Date(NOW.getTime() - 30 * 86_400_000),
        maxPosts: 5,
        maxScrolls: 1,
        stopAfterConsecutiveSeen: 99,
        isSeen: () => false,
        budget: new SimpleBudget(10),
        signal: new AbortController().signal,
        now: NOW,
        timezone: 'Asia/Karachi',
      };
      const posts: RawItem[] = [];
      for await (const p of adapter.scanTarget(target, ctx)) posts.push(p);
      expect(posts).toHaveLength(1);
      expect(posts[0].postedAtApprox).toBeFalsy();
      expect(posts[0].postedAt.toISOString()).toBe('2026-10-03T10:22:00.000Z');
      expect(posts[0].url).toContain('/posts/5555');
      repos.db.close();
    });
  });
});

/** A Facebook page source with one post that doesn't name the brand, and complaint comments that don't either. */
class PageAdapter implements SourceAdapter {
  id = 'facebook_page';
  platform = 'facebook';
  usesPageBudget = true;
  cutoffs: Date[] = [];
  isConfigured() {
    return true;
  }
  async healthCheck() {
    return { ok: true, status: 'ok' as const };
  }
  async *scanTarget(target: Target, ctx: ScanContext) {
    this.cutoffs.push(ctx.cutoffTime);
    ctx.budget.tryConsume();
    yield {
      type: 'post' as const,
      itemKey: `fb:post:${target.id}01`,
      url: `${target.url}/posts/${target.id}01`,
      authorName: 'Official Page',
      text: 'We are upgrading our systems this weekend. Thank you for your patience.',
      postedAt: new Date(NOW.getTime() - 3_600_000),
      commentCount: 2,
    };
  }
  async *expandComments(post: RawItem) {
    yield { type: 'comment' as const, itemKey: `${post.itemKey}:c1`, parentKey: post.itemKey, url: `${post.url}?c=1`, authorName: 'Customer', text: 'My salary is stuck for 3 days, nobody answers the helpline', postedAt: NOW };
    yield { type: 'comment' as const, itemKey: `${post.itemKey}:c2`, parentKey: post.itemKey, url: `${post.url}?c=2`, authorName: 'Fan', text: 'Thanks for the update', postedAt: NOW };
  }
}

describe('runner: comments_mode "all" and first-scan look-back', () => {
  it('sends every comment on an "all" target to review, not on a "matching" target; uses the 7-day look-back on first scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cm-'));
    const repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    const state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true, session_status: 'ok' });
    config.update({ active_hours: { start: '00:00', end: '00:00' }, fetch: { human: { enabled: false } }, search: { mode: 'off' } });
    repos.keywords.add({ keyword: 'Acme Bank' });
    const own = repos.targets.add({ platform: 'facebook', kind: 'page', url: 'https://www.facebook.com/AcmeBank', name: 'Acme Bank (official)', comments_mode: 'all' });
    const other = repos.targets.add({ platform: 'facebook', kind: 'page', url: 'https://www.facebook.com/SomeOtherPage', name: 'Other page' });
    const adapter = new PageAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), dir), closeBrowser: async () => undefined, now: () => NOW });
    const report = await runner.start({ trigger: 'manual', targetIds: [own.id, other.id] }).done;
    expect(report.status).not.toBe('skipped');

    // First scan (no watermark): 7-day look-back.
    for (const c of adapter.cutoffs) expect(NOW.getTime() - c.getTime()).toBe(168 * 3_600_000);

    const ownComments = repos.db.prepare("SELECT item_key, review_status FROM seen_items WHERE type='comment' AND is_match=1").all() as { item_key: string; review_status: string }[];
    expect(ownComments.map((c) => c.item_key).sort()).toEqual([`fb:post:${own.id}01:c1`, `fb:post:${own.id}01:c2`]);
    expect(ownComments.every((c) => c.review_status === 'pending')).toBe(true);
    expect(repos.seen.get(`fb:post:${other.id}01:c1`)?.is_match ?? 0).toBe(0);

    // Later scans use the normal cutoff (24 h).
    repos.targets.update(own.id, { next_due_at: null });
    adapter.cutoffs = [];
    await runner.start({ trigger: 'manual', targetIds: [own.id] }).done;
    expect(NOW.getTime() - adapter.cutoffs[0].getTime()).toBeLessThanOrEqual(24 * 3_600_000);
    repos.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
