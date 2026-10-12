import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  HttpClient,
  NewsSearchAdapter,
  RssFeedAdapter,
  bingNewsUrl,
  canonicalLink,
  htmlToText,
  newsSearchUrl,
  parseFeed,
  validateFeed,
} from '../src/adapters/feeds/index.js';
import { YouTubeAdapter, YouTubeQuota, channelRef, youtubeSearchUrl } from '../src/adapters/youtube/index.js';
import { classifyTarget } from '../src/adapters/classify.js';
import { AdapterRegistry, SimpleBudget } from '../src/adapters/registry.js';
import { SessionError } from '../src/adapters/errors.js';
import { DETECT_SESSION } from '../src/adapters/facebook/domScripts.js';
import type { RawItem, ScanContext, SourceAdapter } from '../src/adapters/types.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { openDb } from '../src/db/index.js';
import { Capturer, type CaptureMeta } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';
import { syncSearchTargets } from '../src/scheduler/searchTargets.js';
import { runDoctor } from '../src/doctor/index.js';

const NOW = new Date();
const rfc = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toUTCString();
const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

// --- Fixtures --------------------------------------------------------------------------

const GOOGLE_NEWS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>"xyzbank" - Google News</title>
<item><title>XYZ Bank app outage leaves customers stranded - Dawn</title>
<link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link><guid isPermaLink="false">CBMiAAA</guid>
<pubDate>${rfc(30)}</pubDate>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiAAA"&gt;XYZ Bank app outage leaves customers stranded&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Dawn&lt;/font&gt;</description>
<source url="https://www.dawn.com">Dawn</source></item>
<item><title>Old xyzbank story - Tribune</title><link>https://news.google.com/rss/articles/OLD</link>
<pubDate>${rfc(60 * 72)}</pubDate><source url="https://tribune.com.pk">Tribune</source></item>
</channel></rss>`;

const BING_NEWS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=xyzbank&amp;format=rss"><channel><title>xyzbank - Bing News</title>
<item><title>XYZ Bank app outage leaves customers stranded</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=1&amp;url=https%3a%2f%2fwww.dawn.com%2fnews%2f123%3futm_source%3dbing&amp;c=1&amp;mkt=en-us</link>
<description>Customers of XYZ Bank could not log in for hours on Friday.</description>
<pubDate>${rfc(25)}</pubDate><News:Source>Dawn</News:Source></item>
<item><title>xyzbank launches new savings account with 20% profit</title>
<link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fbiz.pk%2fpromo</link>
<description>Promotional offer.</description><pubDate>${rfc(40)}</pubDate><News:Source>Biz PK</News:Source></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>PK Forum</title><link href="https://forum.pk/"/>
<entry><id>tag:forum.pk,1</id><title>xyzbank charged me twice</title><link rel="alternate" href="https://forum.pk/t/1"/>
<updated>${iso(10)}</updated><author><name>ali</name></author><content type="html">&lt;p&gt;Double charge on my &lt;b&gt;card&lt;/b&gt;&lt;/p&gt;</content></entry>
<entry><id>tag:forum.pk,2</id><title>Cricket thread</title><link href="https://forum.pk/t/2"/><updated>${iso(20)}</updated></entry>
</feed>`;

function mockHttp(routes: Record<string, string | (() => Response)>, calls: string[] = []) {
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    return typeof r === 'function' ? r() : new Response(r, { status: 200 });
  }) as typeof fetch;
  return new HttpClient({ fetch: fetchImpl, sleep: async () => undefined, minHostIntervalMs: 0 });
}

const ctx = (over: Partial<ScanContext> = {}): ScanContext => ({
  runId: 1,
  cutoffTime: new Date(NOW.getTime() - 24 * 3_600_000),
  maxPosts: 30,
  maxScrolls: 2,
  stopAfterConsecutiveSeen: 3,
  isSeen: () => false,
  budget: new SimpleBudget(0),
  signal: new AbortController().signal,
  now: NOW,
  timezone: 'Asia/Karachi',
  ...over,
});
const collect = async (g: AsyncGenerator<RawItem>) => {
  const out: RawItem[] = [];
  for await (const x of g) out.push(x);
  return out;
};

// --- Feeds ------------------------------------------------------------------------------

describe('feed parsing', () => {
  it('parses Google News RSS with publisher and HTML description', () => {
    const f = parseFeed(GOOGLE_NEWS);
    expect(f.items[0]).toMatchObject({ title: 'XYZ Bank app outage leaves customers stranded - Dawn', sourceName: 'Dawn', sourceUrl: 'https://www.dawn.com' });
    expect(f.items[0].summary).toBe('XYZ Bank app outage leaves customers stranded Dawn');
  });
  it('parses Bing News source and Atom content', () => {
    expect(parseFeed(BING_NEWS).items[0].sourceName).toBe('Dawn');
    const a = parseFeed(ATOM);
    expect(a.title).toBe('PK Forum');
    expect(a.items[0]).toMatchObject({ link: 'https://forum.pk/t/1', author: 'ali', content: 'Double charge on my card' });
  });
  it('rejects non-feeds', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(/not an RSS or Atom feed/);
  });
  it('canonicalizes links (unwrap Bing, strip tracking)', () => {
    expect(canonicalLink('http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fwww.dawn.com%2fnews%2f123%3futm_source%3dbing&c=1')).toBe(
      'https://dawn.com/news/123',
    );
    expect(htmlToText('a&amp;b &#39;c&#39; <b>d</b>')).toBe("a&b 'c' d");
  });
});

describe('news search adapter', () => {
  const repos = openDb(':memory:');
  const config = new ConfigStore(repos.settings);
  repos.keywords.add({ keyword: 'xyzbank', variants: ['ایکس وائی زیڈ بینک'] });
  const calls: string[] = [];
  const http = mockHttp({ 'https://news.google.com/rss/search': GOOGLE_NEWS, 'https://www.bing.com/news/search': BING_NEWS }, calls);
  const adapter = new NewsSearchAdapter(http, () => config.get(), () => repos.keywords.listEnabled());

  it('queries Google News (EN + Urdu edition) and Bing News', () => {
    const urls = adapter.feedUrls('xyzbank');
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('hl=en-PK');
    expect(urls[2]).toContain('ceid=PK%3Aur');
  });

  it('merges engines, dedups the same story by title, drops old items', async () => {
    const items = await collect(adapter.scanTarget({ url: newsSearchUrl('xyzbank') } as never, ctx()));
    const titles = items.map((i) => i.text.split('\n')[0]);
    expect(titles).toEqual(['XYZ Bank app outage leaves customers stranded', 'xyzbank launches new savings account with 20% profit']);
    expect(items[0]).toMatchObject({ sourceName: 'Dawn', sourceType: 'news', url: 'https://dawn.com/news/123', commentCount: 0 });
    expect(calls.some((c) => c.includes('bing.com'))).toBe(true);
  });
});

describe('custom RSS feeds', () => {
  it('validates feeds and rejects web pages', async () => {
    const http = mockHttp({ 'https://forum.pk/feed': ATOM, 'https://forum.pk/': '<!doctype html><html></html>' });
    await expect(validateFeed(http, 'https://forum.pk/feed')).resolves.toMatchObject({ title: 'PK Forum' });
    await expect(validateFeed(http, 'https://forum.pk/')).rejects.toThrow(/web page, not an RSS/);
  });
  it('maps entries to items with stable keys', async () => {
    const http = mockHttp({ 'https://forum.pk/feed': ATOM });
    const a = new RssFeedAdapter(http, () => new ConfigStore(openDb(':memory:').settings).get());
    const items = await collect(a.scanTarget({ url: 'https://forum.pk/feed', name: null } as never, ctx()));
    expect(items).toHaveLength(2);
    expect(items[0].itemKey).toMatch(/^rss:[0-9a-f]{10}:[0-9a-f]{24}$/);
    expect(items[0]).toMatchObject({ sourceName: 'PK Forum', text: 'xyzbank charged me twice\n\nDouble charge on my card' });
  });
});

// --- YouTube ----------------------------------------------------------------------------

describe('YouTube adapter (official API, mocked)', () => {
  const repos = openDb(':memory:');
  const config = new ConfigStore(repos.settings);
  const video = (id: string, title: string, minAgo: number, comments = 0) => ({
    id,
    snippet: { title, description: `desc ${id}`, channelId: 'UCabc', channelTitle: 'Some Channel', publishedAt: iso(minAgo) },
    statistics: { commentCount: String(comments), likeCount: '3' },
  });
  const json = (b: unknown) => () => new Response(JSON.stringify(b), { status: 200 });
  const calls: string[] = [];
  const http = mockHttp(
    {
      'https://www.googleapis.com/youtube/v3/search': json({ items: [{ id: { videoId: 'v1' } }, { id: { videoId: 'v2' } }] }),
      'https://www.googleapis.com/youtube/v3/videos': json({ items: [video('v1', 'xyzbank app review', 60, 12), video('v2', 'unrelated', 90)] }),
      'https://www.googleapis.com/youtube/v3/channels': json({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] }),
      'https://www.googleapis.com/youtube/v3/playlistItems': json({ items: [{ contentDetails: { videoId: 'v1', videoPublishedAt: iso(60) } }] }),
      'https://www.googleapis.com/youtube/v3/commentThreads': json({
        items: [
          {
            id: 't1',
            snippet: { videoId: 'v1', topLevelComment: { id: 'c1', snippet: { textOriginal: 'xyzbank froze my account', textDisplay: '', authorDisplayName: 'Ali', publishedAt: iso(30) } } },
            replies: { comments: [{ id: 'c1.r1', snippet: { textOriginal: 'same here', textDisplay: '', authorDisplayName: 'Sara', publishedAt: iso(20) } }] },
          },
        ],
      }),
    },
    calls,
  );
  const quota = new YouTubeQuota(repos.settings, () => config.get().youtube.daily_quota_units);
  const search = new YouTubeAdapter('search', 'SECRET_KEY', http, quota, () => config.get());

  it('searches newest videos, enriches with stats, and charges quota', async () => {
    const items = await collect(search.scanTarget({ url: youtubeSearchUrl('xyzbank') } as never, ctx()));
    expect(items.map((i) => i.itemKey)).toEqual(['youtube:video:v1', 'youtube:video:v2']);
    expect(items[0]).toMatchObject({ url: 'https://www.youtube.com/watch?v=v1', sourceType: 'youtube_channel', commentCount: 12 });
    expect(quota.used()).toBe(101); // search 100 + videos 1
    expect(calls.find((c) => c.includes('/search'))).toContain('order=date');
  });

  it('reads comment threads including replies', async () => {
    const [v1] = await collect(search.scanTarget({ url: youtubeSearchUrl('xyzbank') } as never, ctx()));
    const comments = await collect(search.expandComments(v1, ctx(), { maxExpansions: 3 }));
    expect(comments.map((c) => c.itemKey)).toEqual(['youtube:comment:v1:c1', 'youtube:comment:v1:c1.r1']);
    expect(comments[0].url).toBe('https://www.youtube.com/watch?v=v1&lc=c1');
  });

  it('resolves channel handles and reads uploads', async () => {
    expect(channelRef('https://www.youtube.com/@XYZBank')).toEqual({ forHandle: '@XYZBank' });
    const ch = new YouTubeAdapter('channel', 'SECRET_KEY', http, quota, () => config.get());
    const items = await collect(ch.scanTarget({ url: 'https://www.youtube.com/@XYZBank' } as never, ctx()));
    expect(items.map((i) => i.itemKey)).toEqual(['youtube:video:v1']);
  });

  it('stops at the daily quota cap', async () => {
    config.update({ youtube: { daily_quota_units: quota.used() + 50 } });
    const items = await collect(search.scanTarget({ url: youtubeSearchUrl('xyzbank') } as never, ctx()));
    expect(items).toEqual([]);
    expect((await search.healthCheck()).ok).toBe(false);
  });

  it('never leaks the API key in errors', async () => {
    config.update({ youtube: { daily_quota_units: 8000 } });
    const bad = new YouTubeAdapter('search', 'SECRET_KEY', mockHttp({}), new YouTubeQuota(openDb(':memory:').settings, () => 8000), () => config.get());
    await expect(collect(bad.scanTarget({ url: youtubeSearchUrl('x') } as never, ctx()))).rejects.toThrow(/YouTube API search failed \(404\)/);
    await collect(bad.scanTarget({ url: youtubeSearchUrl('x') } as never, ctx())).catch((e) => expect(String(e)).not.toContain('SECRET_KEY'));
  });

  it('classifies YouTube channel URLs', () => {
    expect(classifyTarget('https://youtube.com/@XYZBank/videos')).toEqual({ platform: 'youtube', kind: 'channel', url: 'https://www.youtube.com/@XYZBank' });
    expect(() => classifyTarget('https://www.youtube.com/watch?v=abc')).toThrow(/YouTube channel URL/);
  });
});

// --- Facebook risk hardening ----------------------------------------------------------

describe('Facebook soft-block detection', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser?.close());

  it.each([
    "You're Temporarily Blocked",
    "You can't use this feature right now",
    'It looks like you were misusing this feature by going too fast.',
  ])('detects "%s" as rate_limited', async (msg) => {
    const page = await browser.newPage();
    await page.setContent(`<div role="navigation">nav</div><div role="dialog"><h2>${msg}</h2></div>`);
    expect(await page.evaluate(DETECT_SESSION)).toBe('rate_limited');
    await page.close();
  });

  it('a normal feed is ok', async () => {
    const page = await browser.newPage();
    await page.setContent('<div role="navigation">nav</div><div role="feed">posts</div>');
    expect(await page.evaluate(DETECT_SESSION)).toBe('ok');
    await page.close();
  });
});

describe('runner: zero-account sources, Facebook-only active hours, soft-block pause, search cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sources-'));
  const repos = openDb(':memory:');
  const config = new ConfigStore(repos.settings);
  const state = new StateStore(repos.settings);
  repos.keywords.add({ keyword: 'xyzbank' });
  repos.keywords.add({ keyword: 'abcbank' });
  state.patch({ risk_acknowledged: true });

  const http = mockHttp({ 'https://news.google.com/rss/search': GOOGLE_NEWS, 'https://www.bing.com/news/search': BING_NEWS, 'https://forum.pk/feed': ATOM });
  const registry = new AdapterRegistry();
  registry.register(new NewsSearchAdapter(http, () => config.get(), () => repos.keywords.listEnabled()));
  registry.register(new RssFeedAdapter(http, () => config.get()));
  let fbBehaviour: 'ok' | 'soft_block' = 'ok';
  const fbScanned: string[] = [];
  const fb = (kind: string): SourceAdapter => ({
    id: `facebook_${kind}`,
    platform: 'facebook',
    usesPageBudget: true,
    isConfigured: () => true,
    healthCheck: async () => ({ ok: true, status: 'ok' }),
    async *scanTarget(t) {
      fbScanned.push(t.url);
      if (fbBehaviour === 'soft_block') throw new SessionError({ ok: false, status: 'rate_limited' });
    },
    async *expandComments() {},
  });
  registry.register(fb('group'));
  registry.register(fb('search'));
  const runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), dir), closeBrowser: async () => undefined });
  repos.targets.add({ platform: 'rss', kind: 'feed', url: 'https://forum.pk/feed', name: 'PK Forum' });
  repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/g', name: 'G' });

  afterAll(() => {
    repos.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps Facebook search to search.max_queries and spaces it by min_interval_hours', () => {
    config.update({ search: { max_queries: 1, mode: 'always' } });
    syncSearchTargets(repos, ['facebook', 'news'], { facebookMaxQueries: 1 });
    const searches = repos.targets.list().filter((t) => t.kind === 'search');
    expect(searches.filter((t) => t.platform === 'facebook').map((t) => t.name)).toEqual(['Search: xyzbank']);
    expect(searches.filter((t) => t.platform === 'news')).toHaveLength(2);
    const cfg = config.get();
    expect(runner.intervalHours(cfg, { platform: 'facebook', kind: 'search' })).toBe(12);
    expect(runner.intervalHours(cfg, { platform: 'news', kind: 'search' })).toBe(1);
    const due = new Date(runner.nextDue(cfg, NOW, { platform: 'facebook', kind: 'search' })).getTime() - NOW.getTime();
    expect(due).toBeGreaterThanOrEqual(12 * 3_600_000 - 25 * 60_000);
  });

  it('outside active hours, Facebook is skipped but news and RSS run', async () => {
    // A 1-minute window that excludes now.
    const h = (NOW.getUTCHours() + 5 + 12) % 24; // Karachi = UTC+5, 12h away from now
    const hh = String(h).padStart(2, '0');
    config.update({ active_hours: { start: `${hh}:00`, end: `${hh}:01` } });
    expect(runner.platformBlockedReason('facebook', config.get(), NOW)).toMatch(/outside active hours/);
    expect(runner.platformBlockedReason('news', config.get(), NOW)).toBeNull();
    const report = await runner.start({ trigger: 'manual' }).done;
    expect(report.status).toBe('completed');
    expect(report.reason).toMatch(/facebook skipped: outside active hours/);
    expect(new Set(report.targets.map((t) => t.platform))).toEqual(new Set(['news', 'rss']));
    expect(fbScanned).toEqual([]);
    expect(report.stats.new_captures).toBeGreaterThan(0);
    const news = repos.seen.queryCaptures({ review_status: 'all' }).find((r) => r.item_key.startsWith('news:'))!;
    const meta = JSON.parse(fs.readFileSync(path.join(news.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;
    expect(meta).toMatchObject({ platform: 'news', source_type: 'news', found_via: 'search', screenshot: null });
    expect(news.review_status).toBe('pending'); // waits for Cowork review
  });

  it('a soft block pauses Facebook for 48 h without forcing a reconnect; other sources keep running', async () => {
    config.update({ active_hours: { start: '00:00', end: '00:00' } });
    for (const t of repos.targets.list()) repos.targets.update(t.id, { next_due_at: null });
    fbBehaviour = 'soft_block';
    const report = await runner.start({ trigger: 'manual' }).done;
    const st = state.get();
    expect(st.paused_reason).toBe('rate_limited');
    expect(st.session_status).not.toBe('needs_reconnect');
    const pausedFor = new Date(st.paused_until!).getTime() - Date.now();
    expect(pausedFor).toBeGreaterThan(47 * 3_600_000);
    expect(st.alerts.map((a) => a.code)).toContain('facebook_rate_limited');
    expect(report.targets.some((t) => t.platform === 'news' && !t.error)).toBe(true);
    expect(runner.platformBlockedReason('facebook', config.get(), new Date())).toMatch(/soft block/);
  });
});

describe('doctor', () => {
  const base = () => {
    const repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    const state = new StateStore(repos.settings);
    repos.keywords.add({ keyword: 'xyzbank' });
    return { repos, config, state };
  };
  const run = (b: ReturnType<typeof base>) =>
    runDoctor({ config: b.config.get(), state: b.state.get(), repos: b.repos, registry: new AdapterRegistry(), dataDir: os.tmpdir(), env: {} });

  it('flags risky Facebook settings with fixes', () => {
    const b = base();
    b.config.update({ active_hours: { start: '00:00', end: '00:00' }, fetch: { daily_page_budget: 500, page_delay_ms: [500, 1000] }, search: { min_interval_hours: 2 } });
    b.state.patch({ last_restriction_at: new Date().toISOString() });
    const risks = run(b).filter((c) => c.area === 'facebook risk');
    expect(risks.map((c) => c.check).sort()).toEqual(['Active hours', 'Daily page budget', 'Delays', 'Facebook search frequency', 'Recent restriction']);
    expect(risks.every((c) => c.status === 'warn' && c.fix)).toBe(true);
  });

  it('default settings raise no risk warnings', () => {
    expect(run(base()).filter((c) => c.area === 'facebook risk')).toEqual([]);
  });
});
