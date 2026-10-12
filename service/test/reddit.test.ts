import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedditAdapter,
  RedditBudgetExhausted,
  RedditClient,
  flattenComments,
  postToItem,
  redditSearchUrl,
  type RedditComment,
  type RedditPost,
} from '../src/adapters/reddit/index.js';
import { classifyTarget } from '../src/adapters/classify.js';
import { AdapterRegistry, SimpleBudget } from '../src/adapters/registry.js';
import type { RawItem, ScanContext, SourceAdapter } from '../src/adapters/types.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { openDb, type Repos } from '../src/db/index.js';
import { Capturer, type CaptureMeta } from '../src/capture/index.js';
import { Runner, type RunReport } from '../src/scheduler/runner.js';
import { syncSearchTargets } from '../src/scheduler/searchTargets.js';

// --- Mock Reddit API ------------------------------------------------------------------

const NOW = Date.now();
const ago = (min: number) => Math.floor((NOW - min * 60_000) / 1000);

const post = (id: string, title: string, minAgo: number, extra: Partial<RedditPost> = {}): RedditPost => ({
  id,
  name: `t3_${id}`,
  title,
  selftext: '',
  author: `user_${id}`,
  subreddit: 'pakistan',
  permalink: `/r/pakistan/comments/${id}/slug/`,
  created_utc: ago(minAgo),
  score: 5,
  num_comments: 0,
  ...extra,
});
const comment = (id: string, linkId: string, body: string, minAgo: number, extra: Partial<RedditComment> = {}): RedditComment => ({
  id,
  body,
  author: `c_${id}`,
  subreddit: 'pakistan',
  permalink: `/r/pakistan/comments/${linkId}/slug/${id}/`,
  created_utc: ago(minAgo),
  link_id: `t3_${linkId}`,
  link_title: `Post ${linkId}`,
  link_permalink: `https://www.reddit.com/r/pakistan/comments/${linkId}/slug/`,
  ...extra,
});
const listing = <T>(items: T[], kind: string, after: string | null = null) => ({
  kind: 'Listing',
  data: { after, children: items.map((data) => ({ kind, data })) },
});

const POSTS = {
  search: [
    post('s1', 'XYZ Bank app down again?', 30, { num_comments: 2 }),
    post('s2', 'Unrelated question about cricket', 60),
    post('nsfw', 'xyzbank nsfw thing', 70, { over_18: true }),
    post('s3', 'xyzbank old post', 60 * 48), // older than 24h cutoff → stop
    post('s4', 'xyzbank never reached', 10),
  ],
  subNew: [post('n1', 'Best bank for freelancers?', 20, { selftext: 'Thinking of xyz bank or others', num_comments: 0 })],
  subComments: [
    comment('k1', 'old1', 'xyzbank froze my card yesterday', 5),
    comment('k2', 'old1', 'same with me', 6),
    comment('k3', 'old2', 'nothing relevant', 7),
    comment('k4', 'gone', '[removed]', 8),
    comment('k9', 'old1', 'too old xyzbank', 60 * 48),
  ],
  info: [post('old1', 'Card issues thread', 60 * 30, { num_comments: 40 }), post('old2', 'Random thread', 60 * 30)],
  thread_s1: [comment('t1', 's1', 'yes xyzbank app is broken', 20), comment('t2', 's1', 'works for me', 25)],
};

interface MockState {
  calls: string[];
  tokenCalls: number;
  fail429Once: boolean;
  userAgents: Set<string>;
}

function mockFetch(st: MockState): typeof fetch {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    st.userAgents.add(headers.get('user-agent') ?? '');
    st.calls.push(url.pathname + (url.searchParams.get('q') ? `?q=${url.searchParams.get('q')}` : ''));
    if (url.hostname === 'www.reddit.com' && url.pathname === '/api/v1/access_token') {
      st.tokenCalls++;
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (headers.get('authorization') !== 'Bearer tok') return json({ error: 'unauthorized' }, 401);
    if (st.fail429Once) {
      st.fail429Once = false;
      return json({}, 429, { 'x-ratelimit-reset': '0' });
    }
    switch (url.pathname) {
      case '/search':
        return json(listing(POSTS.search, 't3'));
      case '/r/pakistan/new':
        return json(listing(POSTS.subNew, 't3'));
      case '/r/pakistan/comments':
        return json(listing(POSTS.subComments, 't1'));
      case '/api/info':
        return json(listing(POSTS.info.filter((p) => url.searchParams.get('id')!.split(',').includes(p.name)), 't3'));
      case '/comments/s1':
        return json([listing([POSTS.search[0]], 't3'), listing(POSTS.thread_s1, 't1')]);
      case '/comments/n1':
        return json([listing([POSTS.subNew[0]], 't3'), listing([], 't1')]);
      default:
        return json({ error: 'not found' }, 404);
    }
  }) as typeof fetch;
}

const newState = (): MockState => ({ calls: [], tokenCalls: 0, fail429Once: false, userAgents: new Set() });
const makeClient = (st: MockState, cap = 60) =>
  new RedditClient(
    { clientId: 'id', clientSecret: 'secret', userAgent: 'test:social-listener:0.1 (by /u/tester)' },
    { minIntervalMs: () => 0, maxRequestsPerRun: () => cap, fetch: mockFetch(st), sleep: async () => undefined },
  );

// --- Unit ------------------------------------------------------------------------------

describe('RedditClient', () => {
  it('fetches the token once, sends User-Agent and bearer auth', async () => {
    const st = newState();
    const c = makeClient(st);
    c.beginRun(1);
    await c.get('/r/pakistan/new');
    await c.get('/r/pakistan/new');
    expect(st.tokenCalls).toBe(1);
    expect([...st.userAgents]).toEqual(['test:social-listener:0.1 (by /u/tester)']);
  });

  it('retries 429', async () => {
    const st = newState();
    st.fail429Once = true;
    const c = makeClient(st);
    c.beginRun(1);
    const r = await c.get<{ data: { children: unknown[] } }>('/r/pakistan/new');
    expect(r.data.children).toHaveLength(1);
  });

  it('enforces the per-run request cap and resets per run', async () => {
    const st = newState();
    const c = makeClient(st, 2); // token + 1 GET
    c.beginRun(1);
    await c.get('/r/pakistan/new');
    await expect(c.get('/r/pakistan/new')).rejects.toBeInstanceOf(RedditBudgetExhausted);
    c.beginRun(2);
    await expect(c.get('/r/pakistan/new')).resolves.toBeTruthy();
  });

  it('reports not configured without credentials', async () => {
    const c = RedditClient.fromEnv({}, { minIntervalMs: () => 0, maxRequestsPerRun: () => 1 });
    expect(c.configured).toBe(false);
  });
});

describe('reddit mapping & parsing', () => {
  it('maps posts to items', () => {
    const it = postToItem(post('abc', 'Title', 10, { selftext: 'Body', score: 7, num_comments: 3 }));
    expect(it).toMatchObject({
      itemKey: 'reddit:post:abc',
      url: 'https://www.reddit.com/r/pakistan/comments/abc/slug',
      text: 'Title\n\nBody',
      sourceName: 'r/pakistan',
      sourceType: 'subreddit',
      reactionCount: 7,
      commentCount: 3,
    });
    expect(it.postedAt.getTime()).toBe(ago(10) * 1000);
    expect(postToItem(post('x', 'T', 1, { selftext: '[removed]' })).text).toBe('T');
  });

  it('flattens comment trees and collects more stubs', () => {
    const tree = [
      { kind: 't1', data: { ...comment('a', 'p', 'top', 1), replies: listing([comment('b', 'p', 'reply', 1)], 't1') } },
      { kind: 'more', data: { children: ['c', 'd'] } },
    ];
    const r = flattenComments(tree as never);
    expect(r.comments.map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.more).toEqual(['c', 'd']);
  });

  it.each([
    ['https://www.reddit.com/r/pakistan/', 'https://www.reddit.com/r/pakistan'],
    ['https://old.reddit.com/r/Karachi/comments/abc/x/', 'https://www.reddit.com/r/Karachi'],
    ['r/pakistan', 'https://www.reddit.com/r/pakistan'],
    ['/r/pakistan/', 'https://www.reddit.com/r/pakistan'],
  ])('classifies %s as a subreddit', (input, url) => {
    expect(classifyTarget(input)).toEqual({ platform: 'reddit', kind: 'subreddit', url });
  });

  it('still classifies Facebook URLs and rejects others', () => {
    expect(classifyTarget('https://www.facebook.com/groups/abc')).toMatchObject({ platform: 'facebook', kind: 'group' });
    expect(() => classifyTarget('https://www.reddit.com/user/someone')).toThrow(/subreddit/);
    expect(() => classifyTarget('https://example.com/x')).toThrow(/Facebook group\/page, a subreddit .*RSS\/Atom feed/);
  });

  it('creates Reddit search targets per keyword only when configured', () => {
    const repos = openDb(':memory:');
    repos.keywords.add({ keyword: 'xyzbank' });
    syncSearchTargets(repos, ['facebook']);
    expect(repos.targets.list().map((t) => t.platform)).toEqual(['facebook']);
    syncSearchTargets(repos, ['facebook', 'reddit']);
    expect(repos.targets.list().map((t) => [t.platform, t.name])).toEqual([
      ['facebook', 'Search: xyzbank'],
      ['reddit', 'Reddit search: xyzbank'],
    ]);
    expect(repos.targets.list()[1].url).toBe(redditSearchUrl('xyzbank'));
    syncSearchTargets(repos, ['facebook']);
    expect(repos.targets.list().map((t) => t.platform)).toEqual(['facebook']);
  });
});

describe('RedditAdapter scanning', () => {
  const st = newState();
  const repos = openDb(':memory:');
  const config = new ConfigStore(repos.settings);
  const adapterFor = (kind: 'search' | 'subreddit') => new RedditAdapter(kind, makeClient(st), () => config.get());
  const ctx = (over: Partial<ScanContext> = {}): ScanContext => ({
    runId: 1,
    cutoffTime: new Date(NOW - 24 * 3_600_000),
    maxPosts: 30,
    maxScrolls: 2,
    stopAfterConsecutiveSeen: 3,
    isSeen: () => false,
    budget: new SimpleBudget(0),
    signal: new AbortController().signal,
    now: new Date(NOW),
    timezone: 'Asia/Karachi',
    ...over,
  });
  const collect = async (gen: AsyncGenerator<RawItem>) => {
    const out: RawItem[] = [];
    for await (const i of gen) out.push(i);
    return out;
  };

  it('search: newest-first, skips NSFW, stops at the cutoff', async () => {
    const items = await collect(adapterFor('search').scanTarget({ url: redditSearchUrl('xyzbank') } as never, ctx()));
    expect(items.map((i) => i.itemKey)).toEqual(['reddit:post:s1', 'reddit:post:s2']);
  });

  it('subreddit: new posts, then comment stream grouped by post', async () => {
    const items = await collect(adapterFor('subreddit').scanTarget({ url: 'https://www.reddit.com/r/pakistan' } as never, ctx()));
    expect(items.map((i) => i.itemKey)).toEqual(['reddit:post:n1', 'reddit:post:old1', 'reddit:post:old2']);
    const old1 = items[1];
    expect(old1.text).toBe('Card issues thread'); // from /api/info
    expect(old1.comments!.map((c) => c.itemKey)).toEqual(['reddit:comment:old1:k1', 'reddit:comment:old1:k2']);
    expect(old1.comments![0].url).toBe('https://www.reddit.com/r/pakistan/comments/old1/slug/k1');
  });

  it('expandComments fetches a thread', async () => {
    const items = await collect(adapterFor('search').expandComments(postToItem(POSTS.search[0]), ctx(), { maxExpansions: 3 }));
    expect(items.map((i) => i.itemKey)).toEqual(['reddit:comment:s1:t1', 'reddit:comment:s1:t2']);
  });
});

// --- End-to-end with the runner -----------------------------------------------------

describe('Reddit end-to-end run (mock API)', () => {
  let repos: Repos;
  let state: StateStore;
  let runner: Runner;
  let capturesDir: string;
  let run1: RunReport;
  let run2: RunReport;
  let gated: RunReport;
  const fbScanned: string[] = [];

  beforeAll(async () => {
    capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-reddit-'));
    repos = openDb(':memory:');
    const config = new ConfigStore(repos.settings);
    config.update({ active_hours: { start: '00:00', end: '00:00' }, fetch: { first_scan_lookback_hours: 24 } });
    state = new StateStore(repos.settings);
    repos.keywords.add({ keyword: 'xyzbank' });
    repos.targets.add({ platform: 'reddit', kind: 'subreddit', url: 'https://www.reddit.com/r/pakistan', name: 'r/pakistan' });

    const client = makeClient(newState());
    const registry = new AdapterRegistry();
    for (const kind of ['search', 'subreddit'] as const) registry.register(new RedditAdapter(kind, client, () => config.get()));

    // A stub Facebook adapter to prove a Facebook pause doesn't block Reddit.
    const fbStub: SourceAdapter = {
      id: 'facebook_group',
      platform: 'facebook',
      usesPageBudget: true,
      isConfigured: () => true,
      healthCheck: async () => ({ ok: true, status: 'ok' }),
      async *scanTarget(t) {
        fbScanned.push(t.url);
      },
      async *expandComments() {},
    };
    registry.register(fbStub);

    runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), capturesDir), closeBrowser: async () => undefined });

    run1 = await runner.start({ trigger: 'manual' }).done;
    const ids = repos.targets.list().filter((t) => t.platform === 'reddit').map((t) => t.id);
    run2 = await runner.start({ trigger: 'manual', targetIds: ids }).done;

    // Facebook paused + a Facebook group target: only Reddit should run.
    repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/g', name: 'G' });
    state.patch({ risk_acknowledged: true, paused_until: new Date(NOW + 3_600_000).toISOString() });
    for (const t of repos.targets.list()) repos.targets.update(t.id, { next_due_at: null });
    gated = await runner.start({ trigger: 'manual' }).done;
  });

  afterAll(() => {
    repos?.db.close();
    if (capturesDir) fs.rmSync(capturesDir, { recursive: true, force: true });
  });

  it('scans the subreddit and the keyword search without using the Facebook page budget', () => {
    expect(run1.status).toBe('completed');
    expect(run1.targets.map((t) => t.name).sort()).toEqual(['Reddit search: xyzbank', 'r/pakistan']);
    expect(run1.targets.every((t) => !t.error)).toBe(true);
    expect(run1.stats.page_loads).toBe(0);
  });

  it('captures matching posts and comments with text-only meta', () => {
    const keys = repos.db
      .prepare(`SELECT item_key FROM seen_items WHERE is_match = 1 ORDER BY item_key`)
      .all()
      .map((r) => (r as { item_key: string }).item_key);
    expect(keys).toEqual([
      'reddit:comment:old1:k1', // subreddit comment stream
      'reddit:comment:s1:t1', // search hit's thread
      'reddit:post:n1', // match in self-text
      'reddit:post:old1', // context post for k1
      'reddit:post:s1', // search hit
    ]);
    const row = repos.seen.get('reddit:post:s1')!;
    expect(row.capture_path).toMatch(/xyzbank[\\/]reddit_s1$/);
    expect(fs.readdirSync(row.capture_path!)).toEqual(['meta.json']); // no screenshots
    const meta = JSON.parse(fs.readFileSync(path.join(row.capture_path!, 'meta.json'), 'utf8')) as CaptureMeta;
    expect(meta).toMatchObject({
      platform: 'reddit',
      found_via: 'search',
      source_type: 'subreddit',
      source_name: 'r/pakistan',
      url: 'https://www.reddit.com/r/pakistan/comments/s1/slug',
      matched_variant: 'xyz bank',
      screenshot: null,
    });
    expect(meta.comments[0]).toMatchObject({ item_key: 'reddit:comment:s1:t1', screenshot: null });

    const ctxMeta = JSON.parse(
      fs.readFileSync(path.join(repos.seen.get('reddit:comment:old1:k1')!.capture_path!, 'meta.json'), 'utf8'),
    ) as CaptureMeta;
    expect(ctxMeta).toMatchObject({ matched_in: 'comment', source_type: 'subreddit', found_via: 'feed', text: 'Card issues thread' });
  });

  it('second run captures nothing new and writes no duplicate keys', () => {
    expect(run2.stats.new_captures).toBe(0);
    expect(run2.stats.duplicates_skipped).toBeGreaterThan(0);
    expect(repos.db.prepare('SELECT item_key, COUNT(*) n FROM seen_items GROUP BY item_key HAVING n > 1').all()).toEqual([]);
  });

  it('a Facebook pause skips only Facebook targets', () => {
    expect(gated.status).toBe('completed');
    expect(gated.reason).toMatch(/facebook skipped: paused/);
    expect(gated.targets.every((t) => t.platform === 'reddit')).toBe(true);
    expect(fbScanned).toEqual([]);
    expect(runner.platformStatus().reddit).toBe('yes');
    expect(runner.platformStatus().facebook).toMatch(/paused/);
  });
});
