import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore, StateStore } from '../src/config/store.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { HttpClient, NewsSearchAdapter } from '../src/adapters/feeds/index.js';
import { YouTubeAdapter, YouTubeQuota } from '../src/adapters/youtube/index.js';
import type { RawItem, ScanContext, SourceAdapter, Target } from '../src/adapters/types.js';
import { Capturer } from '../src/capture/index.js';
import { Runner } from '../src/scheduler/runner.js';
import { ReviewService } from '../src/review/index.js';
import { FindService, labelMatches, resolveRange } from '../src/find/index.js';
import { csvCell, findCsv } from '../src/find/export.js';
import { createApp } from '../src/api/server.js';

const NOW = new Date('2026-10-07T07:00:00Z'); // 12:00 in Asia/Karachi
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

/** A fake source: yields the given posts and records the target URLs it was asked to scan. */
class FakeAdapter implements SourceAdapter {
  readonly id: string;
  readonly usesPageBudget: boolean;
  scanned: string[] = [];
  constructor(
    readonly platform: string,
    kind: string,
    private posts: (target: Target) => RawItem[],
    private comments: Record<string, string[]> = {},
  ) {
    this.id = `${platform}_${kind}`;
    this.usesPageBudget = platform === 'facebook';
  }
  isConfigured() {
    return true;
  }
  async healthCheck() {
    return { ok: true, status: 'ok' as const };
  }
  async *scanTarget(target: Target, ctx: ScanContext) {
    this.scanned.push(target.url);
    if (this.usesPageBudget) ctx.budget.tryConsume();
    for (const p of this.posts(target)) yield p;
  }
  async *expandComments(post: RawItem) {
    for (const [i, text] of (this.comments[post.itemKey] ?? []).entries())
      yield { type: 'comment' as const, itemKey: `${post.itemKey}:c${i}`, parentKey: post.itemKey, url: `${post.url}?c=${i}`, authorName: `Commenter ${i}`, text, postedAt: post.postedAt };
  }
}

const post = (key: string, text: string, at: Date, extra: Partial<RawItem> = {}): RawItem => ({
  type: 'post',
  itemKey: key,
  url: `https://example.com/${key}`,
  authorName: 'Someone',
  text,
  postedAt: at,
  commentCount: 0,
  ...extra,
});

/** Minimal RFC 4180 parser for tests. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell), rows.push(row), (row = []), (cell = ''), i++;
    } else cell += ch;
  }
  return rows;
}

describe('find: CSV', () => {
  it('quotes, escapes and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, "b"\nc')).toBe('"a, ""b""\nc"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5 stars')).toBe("'-5 stars");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('yes');
  });

  it('round-trips Urdu, newlines and commas', () => {
    const text = 'فیصل بینک نے میرا کارڈ بلاک کر دیا, "urgent"\nsecond line';
    const { csv, rows } = findCsv(
      [{ item_key: 'k1', label: 'negative', keep: 1, reason: 'r', saved: 1, payload: { type: 'post', platform: 'facebook', source: 'G', source_url: null, url: 'u', author: 'A', text, posted_at: '2026-10-01T10:00:00.000Z', date_unknown: false, reactions: 3, comment_count: 0, comments: [], matched_terms: ['فیصل بینک'], target_id: 0, step: 'facebook:fb_search', png: null, raw: {} as never } }],
      { jobId: 1, mission: 'M', include: 'kept', timezone: 'Asia/Karachi' },
    );
    expect(rows).toBe(1);
    const parsed = parseCsv(csv.slice(1));
    expect(parsed[1][16]).toBe(text);
    expect(parsed[1][13]).toBe('2026-10-01T15:00:00+05:00');
  });
});

describe('find: date ranges and labels', () => {
  it('resolves presets in the account timezone', () => {
    const tz = 'Asia/Karachi';
    const lm = resolveRange({ preset: 'last_month' }, tz, NOW);
    expect(lm.from.toISOString()).toBe('2026-08-31T19:00:00.000Z'); // Sep 1 00:00 PKT
    expect(lm.to.toISOString()).toBe('2026-09-30T18:59:59.999Z');
    const ly = resolveRange({ preset: 'last_year' }, tz, NOW);
    expect(ly.from.toISOString()).toBe('2024-12-31T19:00:00.000Z');
    expect(resolveRange({ preset: 'last_7_days' }, tz, NOW).from).toEqual(ago(7));
    const custom = resolveRange({ from: '2026-03-01', to: '2026-03-31' }, tz, NOW);
    expect(custom.from.toISOString()).toBe('2026-02-28T19:00:00.000Z');
    expect(custom.to.toISOString()).toBe('2026-03-31T18:59:59.999Z');
    expect(() => resolveRange({ from: '2026-05-01', to: '2026-04-01' }, tz, NOW)).toThrow(/after/);
  });

  it('matches labels to wanted types with synonyms', () => {
    expect(labelMatches('complaint', ['negative'])).toBe(true);
    expect(labelMatches('Negative', ['complaint'])).toBe(true);
    expect(labelMatches('fraud', ['scam'])).toBe(true);
    expect(labelMatches('promotional', ['negative', 'scam'])).toBe(false);
    expect(labelMatches('hot', ['lead'])).toBe(true);
  });
});

describe('find job', () => {
  let repos: Repos;
  let config: ConfigStore;
  let state: StateStore;
  let runner: Runner;
  let find: FindService;
  let fbSearch: FakeAdapter;
  let fbGroupSearch: FakeAdapter;
  let fbGroup: FakeAdapter;
  let newsUrls: string[];
  let ytUrls: string[];
  let missionId: number;
  let dir: string;

  const NEWS_RSS = (items: { title: string; date: Date; link: string }[]) =>
    `<?xml version="1.0"?><rss><channel><title>n</title>${items
      .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date.toUTCString()}</pubDate></item>`)
      .join('')}</channel></rss>`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-find-'));
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    state = new StateStore(repos.settings);
    state.patch({ risk_acknowledged: true, session_status: 'ok' });
    config.update({
      timezone: 'Asia/Karachi',
      active_hours: { start: '00:00', end: '00:00' },
      platforms: { facebook: true, news: true, rss: false, youtube: true, reddit: false },
      news: { engines: ['google_news'] },
      find: { batch_size: 2 },
      fetch: { human: { enabled: false } },
    });
    missionId = repos.missions.create({
      name: 'Acme Bank complaints',
      template: 'complaints',
      goal: 'complaints and scams about Acme Bank',
      search_queries: ['Acme Bank'],
      match: { any: ['Acme Bank', 'Acme'] },
    }).id;

    newsUrls = [];
    ytUrls = [];
    const http = new HttpClient({
      fetch: (async (url: string) => {
        if (url.includes('news.google.com')) {
          newsUrls.push(url);
          return new Response(
            NEWS_RSS([
              { title: 'Acme Bank customers report failed transfers', date: ago(3), link: 'https://news.pk/a' },
              { title: 'Acme Bank wins award', date: ago(4), link: 'https://news.pk/b' },
              { title: 'Acme Bank old story', date: ago(60), link: 'https://news.pk/old' },
            ]),
          );
        }
        if (url.includes('googleapis.com/youtube/v3/search')) {
          ytUrls.push(url);
          return Response.json({ items: [] });
        }
        if (url.includes('googleapis.com/youtube/v3/videos')) return Response.json({ items: [] });
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
      sleep: async () => undefined,
      minHostIntervalMs: 0,
    });

    const getConfig = () => config.get();
    const registry = new AdapterRegistry();
    registry.register(new NewsSearchAdapter(http, getConfig, () => repos.keywords.list()));
    registry.register(new YouTubeAdapter('search', 'key', http, new YouTubeQuota(repos.settings, () => 10_000, () => NOW), getConfig));
    fbSearch = new FakeAdapter('facebook', 'search', () => [
      post('fb:1', 'Acme Bank froze my account for 2 weeks, nobody answers', ago(2)),
      post('fb:2', 'Acme Bank car loan offer 9% apply now', ago(2)),
      post('fb:3', 'Acme Bank charged me twice, terrible service', ago(5)),
      post('fb:4', 'Acme Bank scam alert: fake agents calling', ago(6)),
      post('fb:5', 'Acme Bank branch was helpful', ago(1)),
      post('fb:old', 'Acme Bank was bad in 2019', ago(400)),
      post('fb:other', 'Totally unrelated cooking post', ago(1)),
    ]);
    fbGroupSearch = new FakeAdapter(
      'facebook',
      'group_search',
      (t) => (t.url.includes('/groups/111/') ? [post('fb:g1', 'Anyone else stuck with Acme Bank card issues?', ago(10), { commentCount: 2 })] : []),
      { 'fb:g1': ['yes same here, 3 weeks', 'Acme helpline never answers'] },
    );
    fbGroup = new FakeAdapter('facebook', 'group', (t) =>
      t.url.includes('222') ? [post('fb:g2', 'Acme Bank app down again, cannot pay bills', ago(4))] : [],
    );
    registry.register(fbSearch);
    registry.register(fbGroup);

    runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, getConfig, dir), closeBrowser: async () => undefined, now: () => NOW });
    find = new FindService({
      repos,
      config,
      runner,
      registry,
      groupSearchAdapter: fbGroupSearch,
      capturer: new Capturer(repos, getConfig, dir),
      dataDir: dir,
      closeBrowser: async () => undefined,
      now: () => NOW,
    });
  });

  const label = (jobId: number, f: (text: string) => string) =>
    find.label(
      jobId,
      find.get(jobId)!.to_label.map((i) => ({ item_key: i.item_key, label: f(i.text), reason: 'test' })),
    );
  const classify = (t: string) => (/scam/i.test(t) ? 'scam' : /offer|apply/i.test(t) ? 'promotional' : /froze|charged|failed|terrible|stuck|down/i.test(t) ? 'negative' : 'neutral');

  it('general search: news (with after/before), YouTube (publishedBefore), then Facebook; count reached across batches', async () => {
    const r = find.start({ mission_id: missionId, count: 3, types: ['negative', 'scam'], when: { preset: 'last_7_days' } });
    expect(r.reason).toBeUndefined();
    expect(r.plan).toEqual(['news:news "Acme Bank"', 'youtube:youtube "Acme Bank"', 'facebook:fb_search "Acme Bank"']);
    await r.done;
    const jobId = r.job_id!;

    // Google News query carries the date operators; YouTube gets publishedBefore.
    expect(decodeURIComponent(newsUrls[0]).replace(/\+/g, ' ')).toMatch(/q=Acme Bank after:2026-09-29 before:2026-10-08/);

    let job = find.get(jobId)!;
    expect(job.status).toBe('ready');
    // Out-of-range news (60 days old) is excluded; both in-range news items are candidates.
    expect(job.to_label.map((i) => i.url)).toEqual(['https://news.pk/a', 'https://news.pk/b']);
    let res = await label(jobId, (t) => (/failed/.test(t) ? 'complaint' : 'neutral'));
    expect(res).toMatchObject({ applied: 2, kept_total: 1, wanted: 3, status: 'partial' });

    expect(find.continue(jobId).started).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    while (find.get(jobId)!.status === 'collecting') await new Promise((r) => setTimeout(r, 5));
    job = find.get(jobId)!;
    expect(new URL(ytUrls[0]).searchParams.get('publishedBefore')).toBe(NOW.toISOString());
    expect(new URL(ytUrls[0]).searchParams.get('publishedAfter')).toBe(ago(7).toISOString());
    // Facebook: the 400-day-old post and the unrelated one are filtered out.
    expect(job.to_label.map((i) => i.item_key).sort()).toEqual(['fb:1', 'fb:2', 'fb:3', 'fb:4', 'fb:5']);
    res = await label(jobId, classify);
    expect(res.status).toBe('done');
    expect(res.kept_total).toBeGreaterThanOrEqual(3);

    // Kept items saved to captures as kept, linked to the mission with the label.
    const kept = repos.seen.queryCaptures({ review_status: 'kept' });
    expect(kept.map((k) => k.item_key)).toEqual(expect.arrayContaining(['fb:1', 'fb:3']));
    expect(repos.missions.forItem('fb:1')[0]).toMatchObject({ mission_id: missionId });
    // Only `count` items are saved; a further match is labelled but not stored.
    expect(kept).toHaveLength(3);
    expect(repos.seen.get('fb:4')).toBeUndefined();
    expect(repos.seen.get('fb:2')).toBeUndefined(); // promotional: not saved
    // A done job refuses to continue.
    expect(find.continue(jobId)).toMatchObject({ started: false });

    // CSV export: kept by default; labelled includes rejected items; copy under data/exports.
    const kept1 = find.exportCsv(jobId)!;
    expect(kept1.csv.startsWith('\uFEFF')).toBe(true);
    const rows = parseCsv(kept1.csv.slice(1));
    expect(rows[0].slice(0, 5)).toEqual(['row_type', 'job_id', 'mission', 'item_key', 'parent_item_key']);
    const keys = rows.slice(1).map((r) => r[3]);
    expect(keys).toContain('fb:1');
    expect(keys).not.toContain('fb:2');
    expect(kept1.filename).toBe('find-acme-bank-complaints-negative-scam-last-7-days.csv');
    expect(kept1.file).toBe(path.join(dir, 'exports', `find-${jobId}-acme-bank-complaints-negative-scam-last-7-days.csv`));
    expect(fs.readFileSync(kept1.file!, 'utf8')).toBe(kept1.csv);
    const all = parseCsv(find.exportCsv(jobId, 'labelled')!.csv.slice(1));
    const promo = all.find((r) => r[3] === 'fb:2')!;
    expect(promo[5]).toBe('promotional');
    expect(promo[6]).toBe('no');
    expect(find.exportCsv(9999)).toBeUndefined();
  });

  it('groups given: in-group search per phrase, group feed only when search found nothing; comments collected', async () => {
    const g1 = repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/111' });
    const r = find.start({
      mission_id: missionId,
      count: 5,
      types: ['negative'],
      groups: [g1.id, 'https://www.facebook.com/groups/222'],
      platforms: ['facebook'],
      when: { preset: 'last_30_days' },
    });
    expect(r.reason).toBeUndefined();
    await r.done;
    const g2 = repos.targets.getByUrl('https://www.facebook.com/groups/222')!;
    expect(g2.status).toBe('candidate'); // added for /find, not scanned by regular runs
    expect(fbGroupSearch.scanned).toEqual(['https://www.facebook.com/groups/111/search/?q=Acme+Bank', 'https://www.facebook.com/groups/222/search/?q=Acme+Bank']);
    // Group 111 search found a post → its feed is skipped; group 222 search was empty → feed read.
    expect(fbGroup.scanned).toEqual(['https://www.facebook.com/groups/222']);
    expect(fbSearch.scanned).toEqual([]); // no general search when groups are given
    const job = find.get(r.job_id!)!;
    expect(job.to_label.map((i) => i.item_key).sort()).toEqual(['fb:g1', 'fb:g2']);
    expect(job.to_label.find((i) => i.item_key === 'fb:g1')!.comments.map((c) => c.text)).toEqual(['yes same here, 3 weeks', 'Acme helpline never answers']);
    const res = await label(r.job_id!, classify);
    expect(res).toMatchObject({ kept_total: 2, status: 'exhausted' });
    // Comments become their own rows, linked to the post.
    const rows = parseCsv(find.exportCsv(r.job_id!)!.csv.slice(1));
    const comments = rows.filter((x) => x[0] === 'comment');
    expect(comments.map((c) => [c[3], c[4], c[5]])).toEqual([
      ['fb:g1#c1', 'fb:g1', 'negative'],
      ['fb:g1#c2', 'fb:g1', 'negative'],
    ]);
    expect(comments[1][16]).toBe('Acme helpline never answers');
  });

  it('ends partial when Facebook is unavailable, and resumes later', async () => {
    state.patch({ paused_until: new Date(NOW.getTime() + 3_600_000).toISOString(), paused_reason: 'rate_limited' });
    const r = find.start({ mission_id: missionId, count: 2, types: ['negative'], platforms: ['facebook'], when: { preset: 'last_7_days' } });
    expect(r.reason).toBeUndefined();
    await r.done;
    let job = find.get(r.job_id!)!;
    expect(job.status).toBe('partial');
    expect(job.progress.notes.join(' ')).toMatch(/Facebook skipped: paused after a Facebook soft block/);
    expect(fbSearch.scanned).toEqual([]);

    state.patch({ paused_until: null, paused_reason: null });
    const c = find.continue(r.job_id!);
    expect(c.started).toBe(true);
    await c.done;
    job = find.get(r.job_id!)!;
    expect(job.status).toBe('ready');
    expect(job.to_label.length).toBe(5);
  });

  it('serves the CSV over the API', async () => {
    const r = find.start({ mission_id: missionId, count: 1, types: ['negative'], platforms: ['facebook'], when: { preset: 'last_7_days' } });
    await r.done;
    await label(r.job_id!, classify);
    const TOKEN = 'e'.repeat(40);
    const server = createApp({
      repos, config, state, runner, find,
      registry: new AdapterRegistry(),
      review: new ReviewService(repos, () => config.get(), dir),
      http: new HttpClient(),
      token: TOKEN, port: 0, connectFacebook: async () => undefined, startedAt: NOW,
    }).listen(0, '127.0.0.1');
    await new Promise((res) => server.once('listening', res));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const get = (p: string) => fetch(base + p, { headers: { authorization: `Bearer ${TOKEN}` } });
    try {
      const res = await get(`/find/${r.job_id}/export?format=csv&include=labelled`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/csv/);
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="find-acme-bank-complaints-negative-last-7-days\.csv"/);
      const body = await res.text();
      expect(parseCsv(body.replace(/^\uFEFF/, '')).length).toBe(6); // header + 5 labelled posts
      // Default "kept": both negative matches (only `count` of them were saved to captures).
      const json = (await (await get(`/find/${r.job_id}/export`)).json()) as { rows: number; csv: string };
      expect(json.rows).toBe(2);
      expect(parseCsv(json.csv.slice(1)).slice(1).map((x) => x[7]).sort()).toEqual(['no', 'yes']);
      expect((await get('/find/9999/export')).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('refuses unclear requests', () => {
    repos.missions.create({ name: 'Second', template: 'topic', goal: 'x', search_queries: ['y'], match: { any: ['y'] } });
    expect(find.start({ count: 2, types: ['negative'], when: {} })).toMatchObject({ started: false, reason: expect.stringMatching(/which mission/) });
    expect(find.start({ mission_id: missionId, count: 2, types: ['negative'], when: { from: 'nope' } })).toMatchObject({ started: false });
    expect(find.start({ mission_id: missionId, count: 2, types: ['negative'], groups: ['https://www.reddit.com/r/bankingpk'], when: {} })).toMatchObject({
      started: false,
      reason: expect.stringMatching(/not a Facebook/),
    });
  });
});

describe('scheduled runs off by default', () => {
  let server: Server;
  let base: string;
  let repos: Repos;
  let config: ConfigStore;
  const TOKEN = 's'.repeat(40);

  beforeAll(async () => {
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    const state = new StateStore(repos.settings);
    const registry = new AdapterRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-sched-'));
    const runner = new Runner({ repos, config, state, registry, capturer: new Capturer(repos, () => config.get(), dir), closeBrowser: async () => undefined });
    server = createApp({
      repos, config, state, runner, registry,
      review: new ReviewService(repos, () => config.get(), dir),
      http: new HttpClient(),
      token: TOKEN, port: 0, connectFacebook: async () => undefined, startedAt: NOW,
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => {
    server?.close();
    repos?.db.close();
  });
  const scan = async (body: object) => {
    const r = await fetch(`${base}/scan`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { reason?: string; error?: string } };
  };

  it('refuses scheduled scans while off, allows manual ones, and allows scheduled when on', async () => {
    expect(config.get().scheduler.scheduled_runs).toBe(false);
    const refused = await scan({ scheduled: true });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/scheduled runs are turned off/);
    expect(JSON.stringify((await scan({})).body)).not.toMatch(/scheduled runs/); // manual: nothing due, but not refused for scheduling
    config.update({ scheduler: { scheduled_runs: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.stringify((await scan({ scheduled: true })).body)).not.toMatch(/scheduled runs/);
  });
});
