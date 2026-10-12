import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Config } from '../config/schema.js';
import type { Repos } from '../db/index.js';
import type { Target } from '../db/targets.js';
import type { NewSeenItem } from '../db/seenItems.js';
import type { RawItem } from '../adapters/types.js';
import type { MatchResult } from '../matcher/index.js';
import type { MissionHit } from '../missions/index.js';
import { normalize } from '../matcher/normalize.js';
import { sha256 } from '../adapters/facebook/keys.js';
import { localDateString, toZonedIso } from '../util/tz.js';

/** Filesystem-safe slug (Windows forbids `:` etc.). */
export const slug = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80) || 'item';

/** Capture folder per post: `fb:post:123` → `123` (unchanged), `reddit:post:abc` → `reddit_abc`. */
export const folderName = (postKey: string) => slug(postKey.replace(/^fb:post:/, '').replace(/^([a-z]+):post:/, '$1_'));

export const textHash = (text: string) => sha256(normalize(text));

/** Where a post came from. Search hits report the group they were posted in when known. */
function sourceOf(target: Target, post: RawItem): Pick<CaptureMeta, 'source_type' | 'source_name' | 'source_url' | 'found_via'> {
  if (target.kind !== 'search') {
    // Subreddit targets: the post's own subreddit is the target.
    return { source_type: target.kind, source_name: target.name ?? post.sourceName ?? null, source_url: target.url, found_via: 'feed' };
  }
  return post.sourceUrl
    ? { source_type: post.sourceType ?? 'group', source_name: post.sourceName ?? null, source_url: post.sourceUrl, found_via: 'search' }
    : { source_type: 'search', source_name: target.name, source_url: target.url, found_via: 'search' };
}

export interface CommentCapture {
  item: RawItem;
  match: MatchResult;
  /** Missions this comment matched (each gets its own review verdict). */
  missions?: MissionHit[];
  /** Absent for sources without screenshots (Reddit). */
  png?: Buffer;
}

export interface PostCapture {
  target: Target;
  post: RawItem;
  postPng?: Buffer;
  postMatch: MatchResult | null;
  /** Missions the post itself matched. */
  postMissions?: MissionHit[];
  /** Already judged (e.g. labelled in a /find job): store as kept instead of queueing for review. */
  reviewStatus?: 'kept';
  comments: CommentCapture[];
  capturedAt: Date;
}

export interface CaptureMeta {
  item_key: string;
  type: 'post';
  platform: string;
  /** group | page | subreddit | search (search = found by keyword search, source unknown) */
  source_type: string;
  source_name: string | null;
  source_url: string;
  /** How the post was found: by scanning a target's feed, or by keyword search. */
  found_via: 'feed' | 'search';
  url: string;
  author_name: string;
  text: string;
  posted_at: string;
  posted_at_approx: boolean;
  captured_at: string;
  reaction_count: number | null;
  comment_count: number | null;
  matched_keyword: string | null;
  matched_variant: string | null;
  matched_in: 'post' | 'comment';
  /** Missions this capture is relevant to (post or comments matched their rules). */
  missions?: { id: number; name: string; template: string; terms: string[] }[];
  text_hash: string;
  /** null for sources without screenshots (Reddit). */
  screenshot: string | null;
  comments: {
    item_key: string;
    url: string;
    author_name: string;
    text: string;
    posted_at: string;
    matched_keyword: string;
    matched_variant: string;
    screenshot: string | null;
  }[];
}

export class Capturer {
  constructor(
    private repos: Repos,
    private getConfig: () => Config,
    private capturesDir: string,
  ) {}

  private async compress(png: Buffer): Promise<{ buf: Buffer; ext: string }> {
    const { format, quality } = this.getConfig().capture;
    const img = sharp(png);
    return format === 'jpeg'
      ? { buf: await img.jpeg({ quality, mozjpeg: true }).toBuffer(), ext: 'jpg' }
      : { buf: await img.webp({ quality }).toBuffer(), ext: 'webp' };
  }

  /** Record a seen-but-not-matching post so later scans skip it and stop early. */
  markSeen(target: Target, post: RawItem, now: Date): void {
    const rows: NewSeenItem[] = [
      {
        item_key: post.itemKey,
        type: 'post',
        target_id: target.id,
        text_hash: textHash(post.text),
        posted_at: post.postedAt.toISOString(),
        first_seen: now.toISOString(),
        is_match: 0,
      },
    ];
    if (post.aliasKey && post.aliasKey !== post.itemKey && !this.repos.seen.has(post.aliasKey)) {
      rows.push({ item_key: post.aliasKey, type: 'alias', parent_key: post.itemKey, first_seen: now.toISOString(), is_match: 0 });
    }
    this.repos.seen.insertMany(rows);
  }

  /**
   * Write screenshots + meta.json, then record every item in one transaction.
   * Files go to a staging dir first and are moved into place only when complete;
   * if the DB insert fails (e.g. duplicate key) the files are removed again.
   */
  async savePost(c: PostCapture): Promise<{ dir: string; meta: CaptureMeta }> {
    const cfg = this.getConfig();
    const tz = cfg.timezone;
    const keyword = c.postMatch?.keyword ?? c.comments[0]?.match.keyword;
    if (!keyword) throw new Error('savePost called without any match');
    // Folder per mission (the original brand mission keeps folders per keyword, as before).
    const firstHit = c.postMissions?.[0] ?? c.comments.find((cc) => cc.missions?.length)?.missions?.[0];
    const folder = firstHit?.folder ?? keyword;
    // Every mission involved: the post's own, plus those of its matching comments (post = context for them).
    const missionInfo = new Map<number, { id: number; name: string; template: string; terms: Set<string> }>();
    for (const h of [...(c.postMissions ?? []), ...c.comments.flatMap((cc) => cc.missions ?? [])]) {
      const e = missionInfo.get(h.mission_id) ?? { id: h.mission_id, name: h.mission_name, template: h.template, terms: new Set<string>() };
      h.terms.forEach((t) => e.terms.add(t));
      missionInfo.set(h.mission_id, e);
    }

    const stagingRoot = path.join(this.capturesDir, '.staging');
    const staging = path.join(stagingRoot, randomUUID());
    fs.mkdirSync(staging, { recursive: true });

    try {
      let postFile: string | null = null;
      if (c.postPng) {
        const post = await this.compress(c.postPng);
        postFile = `post.${post.ext}`;
        fs.writeFileSync(path.join(staging, postFile), post.buf);
      }

      const comments: CaptureMeta['comments'] = [];
      for (const cc of c.comments) {
        let file: string | null = null;
        if (cc.png) {
          const img = await this.compress(cc.png);
          const cid = cc.item.itemKey.split(':').pop()!;
          file = `comment_${slug(cid)}.${img.ext}`;
          fs.writeFileSync(path.join(staging, file), img.buf);
        }
        comments.push({
          item_key: cc.item.itemKey,
          url: cc.item.url,
          author_name: cc.item.authorName,
          text: cc.item.text,
          posted_at: toZonedIso(cc.item.postedAt, tz),
          matched_keyword: cc.match.keyword,
          matched_variant: cc.match.variant,
          screenshot: file,
        });
      }

      const meta: CaptureMeta = {
        item_key: c.post.itemKey,
        type: 'post',
        platform: c.target.platform,
        ...sourceOf(c.target, c.post),
        url: c.post.url,
        author_name: c.post.authorName,
        text: c.post.text,
        posted_at: toZonedIso(c.post.postedAt, tz),
        posted_at_approx: !!c.post.postedAtApprox,
        captured_at: toZonedIso(c.capturedAt, tz),
        reaction_count: c.post.reactionCount ?? null,
        comment_count: c.post.commentCount ?? null,
        matched_keyword: c.postMatch?.keyword ?? null,
        matched_variant: c.postMatch?.variant ?? null,
        matched_in: c.postMatch ? 'post' : 'comment',
        ...(missionInfo.size
          ? { missions: [...missionInfo.values()].map((m) => ({ id: m.id, name: m.name, template: m.template, terms: [...m.terms] })) }
          : {}),
        text_hash: textHash(c.post.text),
        screenshot: postFile,
        comments,
      };
      fs.writeFileSync(path.join(staging, 'meta.json'), JSON.stringify(meta, null, 2));

      let dir = path.join(
        this.capturesDir,
        localDateString(c.capturedAt, tz),
        slug(folder),
        folderName(c.post.itemKey),
      );
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      if (fs.existsSync(dir)) dir = `${dir}_${Date.now()}`;
      fs.renameSync(staging, dir);

      const now = c.capturedAt.toISOString();
      // With review on, captures wait for Cowork's decision and aren't synced until kept.
      const status = cfg.review.enabled && c.reviewStatus !== 'kept'
        ? ({ review_status: 'pending', sync_status: null } as const)
        : ({ review_status: 'kept', sync_status: 'pending' } as const);
      const rows: NewSeenItem[] = [];
      const postSeen = this.repos.seen.has(c.post.itemKey);
      if (!postSeen) {
        rows.push({
          item_key: c.post.itemKey,
          type: 'post',
          target_id: c.target.id,
          text_hash: meta.text_hash,
          posted_at: c.post.postedAt.toISOString(),
          first_seen: now,
          is_match: 1,
          capture_path: dir,
          ...status,
          matched_keyword: keyword,
        });
        if (c.post.aliasKey && c.post.aliasKey !== c.post.itemKey && !this.repos.seen.has(c.post.aliasKey)) {
          rows.push({ item_key: c.post.aliasKey, type: 'alias', parent_key: c.post.itemKey, first_seen: now, is_match: 0 });
        }
      }
      for (const cc of c.comments) {
        rows.push({
          item_key: cc.item.itemKey,
          type: 'comment',
          parent_key: c.post.itemKey,
          target_id: c.target.id,
          text_hash: textHash(cc.item.text),
          posted_at: cc.item.postedAt.toISOString(),
          first_seen: now,
          is_match: 1,
          capture_path: dir,
          ...status,
          matched_keyword: cc.match.keyword,
        });
      }
      try {
        this.repos.db.transaction(() => {
          this.repos.seen.insertMany(rows);
          // Per-mission verdict rows: the post for every involved mission, each comment for its own.
          const itemStatus = status.review_status;
          if (!postSeen) {
            for (const m of missionInfo.values()) {
              const own = c.postMissions?.find((h) => h.mission_id === m.id);
              this.repos.missions.link(c.post.itemKey, m.id, own?.terms ?? [], itemStatus, c.capturedAt);
            }
          }
          for (const cc of c.comments)
            for (const h of cc.missions ?? []) this.repos.missions.link(cc.item.itemKey, h.mission_id, h.terms, itemStatus, c.capturedAt);
        })();
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      return { dir, meta };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}
