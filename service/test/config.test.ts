import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { defaultConfig } from '../src/config/schema.js';
import { applyConfigPatch } from '../src/config/merge.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { openDb } from '../src/db/index.js';
import { SimpleBudget } from '../src/adapters/registry.js';
import { isClickAllowed, CLICK_PATTERNS, feedUrl } from '../src/adapters/facebook/groupFeed.js';
import { classifyTargetUrl, searchUrl } from '../src/adapters/facebook/urls.js';
import { dueTargets, syncSearchTargets } from '../src/scheduler/searchTargets.js';

describe('config', () => {
  it('has spec §12 defaults', () => {
    const c = defaultConfig();
    expect(c.timezone).toBe('Asia/Karachi');
    expect(c.fetch.daily_page_budget).toBe(180);
    expect(c.fetch.page_delay_ms).toEqual([3000, 8000]);
    expect(c.comments.secondary_terms).toContain('atm');
    expect(c.sync.backoff_minutes).toEqual([1, 5, 15, 60]);
    expect(c.track_edits).toBe(false);
    expect(c.browser.channel).toBe('chrome');
  });

  it('keeps a separate profile per browser channel', async () => {
    const { profileDirFor } = await import('../src/adapters/facebook/browser.js');
    expect(profileDirFor('chromium', '/d/profile')).toBe('/d/profile');
    expect(profileDirFor('chrome', '/d/profile')).toBe('/d/profile-chrome');
    expect(profileDirFor('msedge', '/d/profile')).toBe('/d/profile-msedge');
  });

  it('deep-merges patches and replaces arrays', () => {
    const c = applyConfigPatch(defaultConfig(), { fetch: { max_posts: 50 }, comments: { secondary_terms: ['loan'] } });
    expect(c.fetch.max_posts).toBe(50);
    expect(c.fetch.max_scrolls).toBe(8);
    expect(c.comments.secondary_terms).toEqual(['loan']);
  });

  it('rejects invalid values', () => {
    expect(() => applyConfigPatch(defaultConfig(), { fetch: { max_posts: -1 } })).toThrow(ZodError);
    expect(() => applyConfigPatch(defaultConfig(), { timezone: 'Mars/Base' })).toThrow(ZodError);
    expect(() => applyConfigPatch(defaultConfig(), { active_hours: { start: '25:00' } })).toThrow(ZodError);
    expect(() => applyConfigPatch(defaultConfig(), { fetch: { page_delay_ms: [5000, 1000] } })).toThrow(ZodError);
  });

  it('persists through the settings table', () => {
    const repos = openDb(':memory:');
    const store = new ConfigStore(repos.settings);
    store.update({ fetch: { run_page_budget: 10 } });
    expect(new ConfigStore(repos.settings).get().fetch.run_page_budget).toBe(10);
    expect(store.reset().fetch.run_page_budget).toBe(40);
  });

  it('state store raises and clears alerts', () => {
    const repos = openDb(':memory:');
    const s = new StateStore(repos.settings);
    s.raise({ code: 'budget_exhausted', message: 'x' });
    s.raise({ code: 'budget_exhausted', message: 'y' });
    expect(s.get().alerts).toHaveLength(1);
    s.clear('budget_exhausted');
    expect(s.get().alerts).toHaveLength(0);
  });
});

describe('budgets', () => {
  it('hard-stops at the limit', () => {
    const b = new SimpleBudget(2);
    expect([b.tryConsume(), b.tryConsume(), b.tryConsume()]).toEqual([true, true, false]);
    expect(b.used).toBe(2);
    expect(b.remaining).toBe(0);
  });

  it('daily page loads sum across runs', () => {
    const repos = openDb(':memory:');
    const a = repos.runs.start('fetch', new Date('2026-10-03T05:00:00Z'));
    repos.runs.update(a, { page_loads: 7, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, errors: 0 });
    const b = repos.runs.start('fetch', new Date('2026-10-03T06:00:00Z'));
    repos.runs.update(b, { page_loads: 5, posts_scanned: 0, new_captures: 0, duplicates_skipped: 0, errors: 0 });
    expect(repos.runs.pageLoadsSince('2026-10-03T00:00:00Z')).toBe(12);
    expect(repos.runs.pageLoadsSince('2026-10-03T05:30:00Z')).toBe(5);
  });
});

describe('read-only click allowlist', () => {
  it('allows only expansion/dismiss controls', () => {
    expect(isClickAllowed('See more', CLICK_PATTERNS.seeMore)).toBe(true);
    expect(isClickAllowed('12 comments', CLICK_PATTERNS.commentCount)).toBe(true);
    expect(isClickAllowed('1.2K comments', CLICK_PATTERNS.commentCount)).toBe(true);
    expect(isClickAllowed('View more comments', CLICK_PATTERNS.viewMore)).toBe(true);
    expect(isClickAllowed('View 5 more comments', CLICK_PATTERNS.viewMore)).toBe(true);
    expect(isClickAllowed('Decline optional cookies', CLICK_PATTERNS.overlayClose)).toBe(true);
  });
  it('refuses write actions even if a pattern were too broad', () => {
    for (const l of ['Like', 'Comment', 'Share', 'Join group', 'Follow', 'Reply', 'Send', 'Write a comment…'])
      expect(isClickAllowed(l, '.*')).toBe(false);
  });
});

describe('urls', () => {
  it('builds feed URLs per kind', () => {
    expect(feedUrl('https://www.facebook.com/groups/abc?ref=x', 'group')).toBe(
      'https://www.facebook.com/groups/abc/?sorting_setting=CHRONOLOGICAL',
    );
    expect(feedUrl('https://www.facebook.com/xyzbank?ref=x', 'page')).toBe('https://www.facebook.com/xyzbank');
    expect(feedUrl('https://www.facebook.com/profile.php?id=123&sk=about', 'page')).toBe(
      'https://www.facebook.com/profile.php?id=123',
    );
  });

  it.each([
    ['https://m.facebook.com/groups/abc/posts/1?x=1', 'group', 'https://www.facebook.com/groups/abc'],
    ['https://www.facebook.com/groups/123456/', 'group', 'https://www.facebook.com/groups/123456'],
    ['https://www.facebook.com/XYZBankOfficial/', 'page', 'https://www.facebook.com/XYZBankOfficial'],
    ['https://www.facebook.com/XYZBankOfficial/posts/pfbid0abc', 'page', 'https://www.facebook.com/XYZBankOfficial'],
    ['https://web.facebook.com/profile.php?id=10001&sk=photos', 'page', 'https://www.facebook.com/profile.php?id=10001'],
    ['https://www.facebook.com/pages/XYZ-Bank/123456', 'page', 'https://www.facebook.com/pages/XYZ-Bank/123456'],
  ])('classifies %s as %s', (url, kind, norm) => {
    expect(classifyTargetUrl(url)).toEqual({ kind, url: norm });
  });

  it.each([
    'https://evil.com/groups/abc',
    'https://www.facebook.com/',
    'https://www.facebook.com/search/posts/?q=x',
    'https://www.facebook.com/watch/?v=1',
    'https://www.facebook.com/profile.php',
  ])('rejects %s', (url) => {
    expect(() => classifyTargetUrl(url)).toThrow();
  });

  it('builds Recent-filtered search URLs', () => {
    const u = new URL(searchUrl('xyz bank'));
    expect(u.pathname).toBe('/search/posts/');
    expect(u.searchParams.get('q')).toBe('xyz bank');
    const filter = JSON.parse(Buffer.from(u.searchParams.get('filters')!, 'base64').toString());
    expect(JSON.parse(filter['recent_posts:0'])).toEqual({ name: 'recent_posts', args: '' });
  });
});

describe('keyword search targets', () => {
  const setup = () => {
    const repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    repos.keywords.add({ keyword: 'xyzbank' });
    return { repos, config };
  };
  const now = new Date();

  it('searches keywords when no groups/pages exist', () => {
    const { repos, config } = setup();
    const due = dueTargets(config.get(), repos, now);
    expect(due.map((t) => [t.kind, t.name])).toEqual([['search', 'Search: xyzbank']]);
  });

  it('stops searching once a group or page is added (when_no_targets)', () => {
    const { repos, config } = setup();
    repos.targets.add({ platform: 'facebook', kind: 'page', url: 'https://www.facebook.com/xyzbank' });
    expect(dueTargets(config.get(), repos, now).map((t) => t.kind)).toEqual(['page']);
    config.update({ search: { mode: 'always' } });
    expect(dueTargets(config.get(), repos, now).map((t) => t.kind).sort()).toEqual(['page', 'search']);
    config.update({ search: { mode: 'off' } });
    repos.targets.update(1, { status: 'disabled' });
    expect(dueTargets(config.get(), repos, now)).toEqual([]);
  });

  it('follows keyword changes', () => {
    const { repos, config } = setup();
    dueTargets(config.get(), repos, now);
    repos.keywords.add({ keyword: 'abcbank' });
    repos.keywords.update(1, { enabled: false });
    syncSearchTargets(repos);
    expect(repos.targets.list().filter((t) => t.kind === 'search').map((t) => t.name)).toEqual(['Search: abcbank']);
  });
});
