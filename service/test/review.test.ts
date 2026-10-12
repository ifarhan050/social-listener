import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Repos } from '../src/db/index.js';
import { ConfigStore } from '../src/config/store.js';
import { Capturer } from '../src/capture/index.js';
import { ReviewService } from '../src/review/index.js';
import type { RawItem } from '../src/adapters/types.js';
import type { Target } from '../src/db/targets.js';

const png = () => sharp({ create: { width: 20, height: 10, channels: 3, background: '#c33' } }).png().toBuffer();
const match = (variant = 'xyzbank') => ({ keyword: 'xyzbank', variant, form: 'xyzbank', fuzzy: false });
const item = (type: 'post' | 'comment', key: string, text: string): RawItem => ({
  type,
  itemKey: key,
  url: `https://www.facebook.com/x/${key}`,
  authorName: `author ${key}`,
  text,
  postedAt: new Date('2026-10-04T05:00:00Z'),
});

describe('review queue (Cowork filtering)', () => {
  let dir: string;
  let repos: Repos;
  let config: ConfigStore;
  let capturer: Capturer;
  let review: ReviewService;
  let target: Target;

  const capture = async (postKey: string, postText: string, postMatches: boolean, comments: [string, string][]) => {
    const { dir: d } = await capturer.savePost({
      target,
      post: item('post', postKey, postText),
      postPng: await png(),
      postMatch: postMatches ? match() : null,
      comments: await Promise.all(comments.map(async ([k, t]) => ({ item: item('comment', k, t), match: match(), png: await png() }))),
      capturedAt: new Date('2026-10-04T06:00:00Z'),
    });
    return d;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-review-'));
    repos = openDb(':memory:');
    config = new ConfigStore(repos.settings);
    capturer = new Capturer(repos, () => config.get(), dir);
    review = new ReviewService(repos, () => config.get(), dir);
    target = repos.targets.add({ platform: 'facebook', kind: 'group', url: 'https://www.facebook.com/groups/g', name: 'G' });
  });
  afterEach(() => {
    repos.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('new captures wait in the queue and are not synced', async () => {
    await capture('fb:post:1', 'xyzbank app crashed again', true, [['fb:comment:1:a', 'xyzbank is useless']]);
    expect(repos.seen.get('fb:post:1')).toMatchObject({ review_status: 'pending', sync_status: null });
    const q = review.queue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ platform: 'facebook', source: 'G', post: { item_key: 'fb:post:1', needs_review: true } });
    expect(q[0].comments.map((c) => c.item_key)).toEqual(['fb:comment:1:a']);
    expect(review.pendingCount()).toBe(2);
  });

  it('keeps a negative post, drops a positive comment and its screenshot', async () => {
    const d = await capture('fb:post:1', 'xyzbank froze my card', true, [
      ['fb:comment:1:a', 'same, xyzbank support never answers'],
      ['fb:comment:1:b', 'xyzbank worked fine for me'],
    ]);
    const r = review.submit([
      { item_key: 'fb:post:1', sentiment: 'negative', promotional: false, reason: 'card frozen complaint' },
      { item_key: 'fb:comment:1:a', sentiment: 'negative', promotional: false, reason: 'support complaint' },
      { item_key: 'fb:comment:1:b', sentiment: 'positive', promotional: false, reason: 'satisfied' },
    ]);
    expect(r).toMatchObject({ applied: 3, kept: 2, rejected: 1, context: 0, remaining_in_queue: 0, problems: [] });
    expect(fs.readdirSync(d).sort()).toEqual(['comment_a.webp', 'meta.json', 'post.webp']);
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    expect(meta.review).toMatchObject({ status: 'kept', sentiment: 'negative', promotional: false, reason: 'card frozen complaint' });
    expect(meta.comments.map((c: { item_key: string }) => c.item_key)).toEqual(['fb:comment:1:a']);
    expect(repos.seen.get('fb:post:1')!.sync_status).toBe('pending'); // now eligible for sync
    expect(repos.seen.get('fb:comment:1:b')).toMatchObject({ review_status: 'rejected', capture_path: null, sync_status: null });
  });

  it('deletes rejected captures entirely but keeps the row for dedup and audit', async () => {
    const d = await capture('fb:post:2', 'Open an xyzbank account today and get 5% cashback! DM us', true, []);
    review.submit([{ item_key: 'fb:post:2', sentiment: 'positive', promotional: true, reason: 'advert' }]);
    expect(fs.existsSync(d)).toBe(false);
    expect(repos.seen.has('fb:post:2')).toBe(true);
    expect(repos.seen.get('fb:post:2')).toMatchObject({ review_status: 'rejected', promotional: 1, capture_path: null });
    expect(review.log('rejected')).toEqual([expect.objectContaining({ item_key: 'fb:post:2', promotional: true, reason: 'advert' })]);
    expect(repos.seen.queryCaptures({})).toEqual([]); // rejected hidden by default
    expect(repos.seen.queryCaptures({ review_status: 'all' })).toHaveLength(1);
  });

  it('negative, non-promotional is required: a promotional complaint-sounding post is dropped', async () => {
    await capture('fb:post:3', 'Tired of xyzbank fees? Switch to OtherBank today!', true, []);
    const r = review.submit([{ item_key: 'fb:post:3', sentiment: 'negative', promotional: true, reason: 'competitor ad' }]);
    expect(r.rejected).toBe(1);
  });

  it('keeps a promotional post as context for its negative comments (default)', async () => {
    const d = await capture('fb:post:4', 'Our new savings plan is here!', false, [['fb:comment:4:a', 'xyzbank still hasnt refunded me']]);
    const r = review.submit([
      { item_key: 'fb:post:4', sentiment: 'positive', promotional: true, reason: 'brand promo' },
      { item_key: 'fb:comment:4:a', sentiment: 'negative', promotional: false, reason: 'refund complaint' },
    ]);
    expect(r).toMatchObject({ kept: 1, context: 1, rejected: 0 });
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    expect(meta.review.status).toBe('context');
    expect(meta.screenshot).toBe('post.webp');
  });

  it('with keep_promo_post_as_context=false, drops the promo post image but keeps the comment', async () => {
    config.update({ review: { keep_promo_post_as_context: false } });
    const d = await capture('fb:post:5', 'Our new savings plan is here!', false, [['fb:comment:5:a', 'xyzbank blocked my account']]);
    review.submit([
      { item_key: 'fb:post:5', sentiment: 'positive', promotional: true, reason: 'brand promo' },
      { item_key: 'fb:comment:5:a', sentiment: 'negative', promotional: false, reason: 'account blocked' },
    ]);
    expect(fs.readdirSync(d).sort()).toEqual(['comment_a.webp', 'meta.json']);
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ screenshot: null, review: { status: 'rejected' } });
  });

  it('a post that only matched via comments is never kept on its own', async () => {
    const d = await capture('fb:post:6', 'Which bank is best?', false, [['fb:comment:6:a', 'xyzbank is great']]);
    review.submit([
      { item_key: 'fb:post:6', sentiment: 'negative', promotional: false, reason: 'question' },
      { item_key: 'fb:comment:6:a', sentiment: 'positive', promotional: false, reason: 'praise' },
    ]);
    expect(fs.existsSync(d)).toBe(false);
    expect(repos.seen.get('fb:post:6')!.review_status).toBe('rejected');
  });

  it('partial decisions leave the folder in the queue until everything is decided', async () => {
    const d = await capture('fb:post:7', 'xyzbank down?', true, [['fb:comment:7:a', 'xyzbank yes down']]);
    review.submit([{ item_key: 'fb:comment:7:a', sentiment: 'negative', promotional: false, reason: 'outage' }]);
    const q = review.queue();
    expect(q[0].post.needs_review).toBe(true);
    expect(q[0].comments).toEqual([]);
    expect(fs.readdirSync(d)).toContain('comment_a.webp');
    review.submit([{ item_key: 'fb:post:7', sentiment: 'negative', promotional: false, reason: 'outage question' }]);
    expect(review.queue()).toEqual([]);
  });

  it('reports unknown and already-reviewed items', async () => {
    await capture('fb:post:8', 'xyzbank terrible', true, []);
    review.submit([{ item_key: 'fb:post:8', sentiment: 'negative', promotional: false, reason: 'x' }]);
    const r = review.submit([
      { item_key: 'fb:post:8', sentiment: 'negative', promotional: false, reason: 'x' },
      { item_key: 'fb:post:nope', sentiment: 'negative', promotional: false, reason: 'x' },
    ]);
    expect(r.applied).toBe(0);
    expect(r.problems.map((p) => p.problem)).toEqual(['already reviewed (kept)', 'unknown item']);
  });

  it('with review disabled, captures are kept immediately', async () => {
    config.update({ review: { enabled: false } });
    await capture('fb:post:9', 'xyzbank ok', true, []);
    expect(repos.seen.get('fb:post:9')).toMatchObject({ review_status: 'kept', sync_status: 'pending' });
    expect(review.queue()).toEqual([]);
  });
});
