import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Repos } from '../db/index.js';
import type { ReviewStatus, SeenItem, Sentiment } from '../db/seenItems.js';
import type { CaptureMeta } from '../capture/index.js';
import { logger } from '../util/logger.js';
import { TEMPLATES, type TemplateId } from '../missions/templates.js';

/**
 * Review queue (filtering done by Claude in Cowork, not by the service):
 * every keyword match waits here until Cowork labels it. Only negative,
 * non-promotional items are stored; everything else has its files deleted but
 * keeps its seen_items row (label + reason) for dedup and auditing.
 */

const MAX_TEXT = 2000;
const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t);

export interface QueueItem {
  item_key: string;
  author_name: string;
  text: string;
  posted_at: string;
  url?: string;
  matched_keyword: string | null;
  /** Missions that still need a verdict for this item (decide each one). Empty = legacy item, use default rules. */
  missions_pending: number[];
}

/** What Claude needs to judge an item against a mission. */
export interface QueueMission {
  id: number;
  name: string;
  template: string;
  goal: string;
  keep_rules: string;
  exclude_rules: string;
  labels: string[];
}

export interface QueueEntry {
  capture_id: string;
  platform: string;
  source: string | null;
  found_via: string;
  /** The post. `needs_review: false` means it is shown only as context for its comments. */
  post: QueueItem & { needs_review: boolean; url: string; reactions: number | null; comment_count: number | null };
  /** Matching comments awaiting review. */
  comments: QueueItem[];
  /** The missions referenced by missions_pending above, with their goal and rules. */
  missions: QueueMission[];
}

/**
 * One verdict. Generic form: `keep` (+ optional label/score). Legacy complaint form:
 * `sentiment` + `promotional` (keep = negative and not promotional). `mission_id` is
 * required when an item matched several missions.
 */
export interface Decision {
  item_key: string;
  mission_id?: number;
  keep?: boolean;
  sentiment?: Sentiment;
  promotional?: boolean;
  label?: string;
  score?: number;
  reason: string;
}

/** Item-level outcome after all its missions are decided. */
interface Resolved {
  keep: boolean;
  promotional: boolean;
  sentiment: string;
  reason: string;
}

export interface SubmitResult {
  applied: number;
  kept: number;
  context: number;
  rejected: number;
  problems: { item_key: string; problem: string }[];
  remaining_in_queue: number;
}

const readMeta = (dir: string): CaptureMeta | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as CaptureMeta;
  } catch {
    return null;
  }
};

/** Legacy rule: an item is stored only if it is negative and not promotional. */
export const isKeep = (d: Pick<Decision, 'sentiment' | 'promotional'>) => d.sentiment === 'negative' && !d.promotional;

/** Verdict of a decision: explicit `keep`, else the legacy sentiment rule. */
export const decideKeep = (d: Decision) => (d.keep !== undefined ? d.keep : !!d.sentiment && isKeep(d));

export class ReviewService {
  constructor(
    private repos: Repos,
    private getConfig: () => Config,
    private capturesDir: string,
    private now: () => Date = () => new Date(),
  ) {}

  pendingCount(): number {
    return this.repos.seen.reviewCounts().pending ?? 0;
  }

  /** Oldest pending captures first, each with its post and the comments needing a decision. */
  queue(limit = 20): QueueEntry[] {
    const out: QueueEntry[] = [];
    for (const dir of this.repos.seen.pendingReviewFolders(limit)) {
      const meta = readMeta(dir);
      const rows = new Map(this.repos.seen.inFolder(dir).map((r) => [r.item_key, r]));
      if (!meta) {
        logger.warn({ dir }, 'capture folder missing meta.json — rejecting its pending items');
        this.rejectOrphans([...rows.values()]);
        continue;
      }
      const postRow = rows.get(meta.item_key);
      const pendingMissions = (key: string) =>
        rows.get(key)?.review_status === 'pending'
          ? this.repos.missions.forItem(key).filter((m) => m.review_status === 'pending').map((m) => m.mission_id)
          : [];
      const involved = new Set<number>([meta.item_key, ...meta.comments.map((c) => c.item_key)].flatMap(pendingMissions));
      out.push({
        missions: [...involved].map((id) => this.describeMission(id)).filter((m): m is QueueMission => !!m),
        capture_id: path.relative(this.capturesDir, dir).split(path.sep).join('/'),
        platform: meta.platform,
        source: meta.source_name,
        found_via: meta.found_via,
        post: {
          item_key: meta.item_key,
          needs_review: postRow?.review_status === 'pending',
          author_name: meta.author_name,
          text: clip(meta.text),
          posted_at: meta.posted_at,
          url: meta.url,
          reactions: meta.reaction_count,
          comment_count: meta.comment_count,
          matched_keyword: meta.matched_keyword,
          missions_pending: pendingMissions(meta.item_key),
        },
        comments: meta.comments
          .filter((c) => rows.get(c.item_key)?.review_status === 'pending')
          .map((c) => ({
            item_key: c.item_key,
            author_name: c.author_name,
            text: clip(c.text),
            posted_at: c.posted_at,
            url: c.url,
            matched_keyword: c.matched_keyword,
            missions_pending: pendingMissions(c.item_key),
          })),
      });
    }
    return out;
  }

  private describeMission(id: number): QueueMission | null {
    const m = this.repos.missions.get(id);
    if (!m) return null;
    const t = TEMPLATES[m.template as TemplateId] ?? TEMPLATES.custom;
    return { id: m.id, name: m.name, template: m.template, goal: m.goal, keep_rules: m.keep_rules, exclude_rules: m.exclude_rules, labels: t.labels };
  }

  private rejectOrphans(rows: SeenItem[]): void {
    const at = this.now().toISOString();
    for (const r of rows) {
      if (r.review_status !== 'pending') continue;
      this.repos.seen.applyReview({ item_key: r.item_key, review_status: 'rejected', sentiment: 'neutral', promotional: false, review_reason: 'capture files missing', reviewed_at: at });
    }
    this.repos.seen.clearCapturePath(rows.map((r) => r.item_key));
  }

  /**
   * Apply Cowork's verdicts.
   *
   * Per mission: each (item, mission) gets keep/reject (+ label/score). Once an item has no
   * pending missions left, its overall outcome is "kept if any mission kept it".
   * Per folder (as before): comments are decided on their own; the post is kept if it
   * matched itself and was kept, kept as context if any of its comments were kept,
   * otherwise rejected. A folder is finalized once nothing in it is pending.
   * Items captured before missions existed (no mission rows) are decided directly.
   */
  submit(decisions: Decision[]): SubmitResult {
    const cfg = this.getConfig();
    const at = this.now().toISOString();
    const res: SubmitResult = { applied: 0, kept: 0, context: 0, rejected: 0, problems: [], remaining_in_queue: 0 };
    const touched = new Set<string>();
    const resolved = new Map<string, Resolved>();

    // Comments first: a post's mission verdict can become "context" because of them.
    const rowsByKey = new Map(decisions.map((d) => [d.item_key, this.repos.seen.get(d.item_key)]));
    const ordered = [...decisions].sort(
      (a, b) => Number(rowsByKey.get(a.item_key)?.type !== 'comment') - Number(rowsByKey.get(b.item_key)?.type !== 'comment'),
    );

    this.repos.db.transaction(() => {
      for (const d of ordered) {
        const row = rowsByKey.get(d.item_key);
        if (!row || (row.type !== 'post' && row.type !== 'comment')) {
          res.problems.push({ item_key: d.item_key, problem: 'unknown item' });
          continue;
        }
        if (row.review_status !== 'pending') {
          res.problems.push({ item_key: d.item_key, problem: `already reviewed (${row.review_status})` });
          continue;
        }
        if (!row.capture_path) {
          res.problems.push({ item_key: d.item_key, problem: 'no capture folder' });
          continue;
        }
        if (d.keep === undefined && !d.sentiment) {
          res.problems.push({ item_key: d.item_key, problem: 'give keep (true/false) or sentiment' });
          continue;
        }
        const keep = decideKeep(d);
        const missions = this.repos.missions.forItem(d.item_key);

        if (!missions.length) {
          // Legacy item (captured before missions): decide directly.
          resolved.set(d.item_key, {
            keep,
            promotional: !!d.promotional,
            sentiment: d.sentiment ?? d.label ?? (keep ? 'relevant' : 'irrelevant'),
            reason: d.reason,
          });
          touched.add(row.capture_path);
          res.applied++;
          continue;
        }

        const pending = missions.filter((m) => m.review_status === 'pending');
        const missionId = d.mission_id ?? (pending.length === 1 ? pending[0].mission_id : undefined);
        if (missionId === undefined) {
          res.problems.push({
            item_key: d.item_key,
            problem: `matches several missions — give mission_id (pending: ${pending.map((m) => m.mission_id).join(', ')})`,
          });
          continue;
        }
        if (!pending.some((m) => m.mission_id === missionId)) {
          res.problems.push({ item_key: d.item_key, problem: `mission ${missionId} is not pending for this item` });
          continue;
        }
        let status: 'kept' | 'context' | 'rejected' = keep ? 'kept' : 'rejected';
        if (row.type === 'post' && keep && !missions.find((m) => m.mission_id === missionId)?.matched_terms.length) {
          // The post only came along as context for this mission's comments; it isn't "kept" on its own.
          status = 'rejected';
        }
        if (row.type === 'post' && status === 'rejected') {
          const commentKept = this.repos.seen
            .inFolder(row.capture_path)
            .filter((r) => r.type === 'comment')
            .some((r) => this.repos.missions.forItem(r.item_key).some((m) => m.mission_id === missionId && m.review_status === 'kept'));
          if (commentKept && (!d.promotional || cfg.review.keep_promo_post_as_context)) status = 'context';
        }
        this.repos.missions.setVerdict(d.item_key, missionId, {
          status,
          label: d.label ?? d.sentiment ?? null,
          score: d.score ?? null,
          reason: d.reason,
          at,
        });
        res.applied++;

        const after = this.repos.missions.forItem(d.item_key);
        if (after.some((m) => m.review_status === 'pending')) continue; // other missions still to decide
        const anyKept = after.some((m) => m.review_status === 'kept');
        resolved.set(d.item_key, {
          keep: anyKept,
          promotional: !!d.promotional,
          sentiment: d.sentiment ?? d.label ?? (anyKept ? 'relevant' : 'irrelevant'),
          reason: after.map((m) => m.reason).filter(Boolean).join(' | ') || d.reason,
        });
        touched.add(row.capture_path);
      }

      // Item level, per folder: same rules as before.
      for (const dir of touched) {
        const meta = readMeta(dir);
        const rows = this.repos.seen.inFolder(dir);
        for (const c of rows.filter((r) => r.type === 'comment')) {
          const d = resolved.get(c.item_key);
          if (!d) continue;
          const status: ReviewStatus = d.keep ? 'kept' : 'rejected';
          this.repos.seen.applyReview({
            item_key: c.item_key,
            review_status: status,
            sentiment: d.sentiment as Sentiment,
            promotional: d.promotional,
            review_reason: d.reason,
            reviewed_at: at,
          });
          res[status === 'kept' ? 'kept' : 'rejected']++;
        }
        const post = rows.find((r) => r.type === 'post');
        const d = post && resolved.get(post.item_key);
        if (post && d) {
          const anyCommentKept = this.repos.seen.inFolder(dir).some((r) => r.type === 'comment' && r.review_status === 'kept');
          const missionRows = this.repos.missions.forItem(post.item_key);
          // A post "matched itself" if it matched the keyword (legacy) or any mission's rules.
          const matchedItself = missionRows.length ? missionRows.some((m) => m.matched_terms.length > 0) : !!meta?.matched_keyword;
          let status: ReviewStatus;
          if (matchedItself && d.keep) status = 'kept';
          else if (anyCommentKept && (!d.promotional || cfg.review.keep_promo_post_as_context)) status = 'context';
          else status = 'rejected';
          this.repos.seen.applyReview({
            item_key: post.item_key,
            review_status: status,
            sentiment: d.sentiment as Sentiment,
            promotional: d.promotional,
            review_reason: d.reason,
            reviewed_at: at,
          });
          res[status]++;
        }
      }
    })();

    for (const dir of touched) this.finalizeIfDone(dir);
    res.remaining_in_queue = this.pendingCount();
    return res;
  }

  /** Once no item in a folder is pending: delete rejected files, or the whole folder; rewrite meta.json. */
  private finalizeIfDone(dir: string): void {
    const rows = this.repos.seen.inFolder(dir);
    if (rows.some((r) => r.review_status === 'pending')) return;
    const meta = readMeta(dir);
    const kept = rows.filter((r) => r.review_status === 'kept' || r.review_status === 'context');
    const rejected = rows.filter((r) => r.review_status === 'rejected');

    // A folder can hold new comments for a post captured earlier (its post row lives elsewhere).
    const postRow = rows.find((r) => r.type === 'post');
    const commentKept = kept.some((r) => r.type === 'comment');
    if (!meta || (!commentKept && (!postRow || postRow.review_status === 'rejected'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.repos.seen.clearCapturePath(rows.map((r) => r.item_key));
      return;
    }

    const byKey = new Map(rows.map((r) => [r.item_key, r]));
    let screenshot = meta.screenshot;
    if (postRow?.review_status === 'rejected' && screenshot) {
      // Rejected (e.g. promotional) post kept only because its comments were: drop its image.
      fs.rmSync(path.join(dir, screenshot), { force: true });
      screenshot = null;
    }
    for (const c of meta.comments) {
      if (byKey.get(c.item_key)?.review_status === 'rejected' && c.screenshot)
        fs.rmSync(path.join(dir, c.screenshot), { force: true });
    }
    const review = (r: SeenItem | undefined) =>
      r && { status: r.review_status, sentiment: r.sentiment, promotional: r.promotional === 1, reason: r.review_reason, reviewed_at: r.reviewed_at };
    const next = {
      ...meta,
      screenshot,
      review: review(byKey.get(meta.item_key)) ?? { status: 'context', note: 'post reviewed in an earlier capture' },
      comments: meta.comments
        .filter((c) => {
          const s = byKey.get(c.item_key)?.review_status;
          return s === 'kept' || s === 'context';
        })
        .map((c) => ({ ...c, review: review(byKey.get(c.item_key)) })),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
    this.repos.seen.clearCapturePath(rejected.map((r) => r.item_key));
  }

  log(status: ReviewStatus | undefined, limit = 50) {
    return this.repos.seen.reviewLog(status, limit).map((r) => ({
      item_key: r.item_key,
      type: r.type,
      review_status: r.review_status,
      sentiment: r.sentiment,
      promotional: r.promotional === 1,
      reason: r.review_reason,
      reviewed_at: r.reviewed_at,
      matched_keyword: r.matched_keyword,
    }));
  }
}
