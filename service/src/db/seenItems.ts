import type { Database } from 'better-sqlite3';

export interface SeenItem {
  item_key: string;
  /** 'alias' rows are secondary dedup keys pointing at a post (see keys.contentAlias). */
  type: 'post' | 'comment' | 'alias';
  parent_key: string | null;
  target_id: number | null;
  text_hash: string | null;
  posted_at: string | null;
  first_seen: string;
  is_match: number;
  capture_path: string | null;
  sync_status: 'pending' | 'synced' | 'failed' | null;
  sync_attempts: number;
  next_sync_at: string | null;
  last_error: string | null;
  matched_keyword: string | null;
  review_status: ReviewStatus | null;
  sentiment: Sentiment | null;
  promotional: number | null;
  review_reason: string | null;
  reviewed_at: string | null;
}

/** pending → awaiting Cowork review; kept/context → stored; rejected → files deleted, row kept for dedup/audit. */
export type ReviewStatus = 'pending' | 'kept' | 'context' | 'rejected';
export type Sentiment = 'negative' | 'neutral' | 'positive' | 'mixed';

export interface ReviewUpdate {
  item_key: string;
  review_status: ReviewStatus;
  sentiment: Sentiment;
  promotional: boolean;
  review_reason: string;
  reviewed_at: string;
}

export type NewSeenItem = Pick<SeenItem, 'item_key' | 'type' | 'first_seen' | 'is_match'> &
  Partial<
    Pick<SeenItem, 'parent_key' | 'target_id' | 'text_hash' | 'posted_at' | 'capture_path' | 'sync_status' | 'matched_keyword' | 'review_status'>
  >;

export interface CaptureQuery {
  from?: string;
  to?: string;
  keyword?: string;
  target_id?: number;
  sync_status?: string;
  /** Default: everything except rejected. */
  review_status?: ReviewStatus | 'all';
  limit?: number;
}

export class SeenItemsRepo {
  constructor(private db: Database) {}

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen_items WHERE item_key = ?').get(key) !== undefined;
  }

  get(key: string): SeenItem | undefined {
    return this.db.prepare('SELECT * FROM seen_items WHERE item_key = ?').get(key) as SeenItem | undefined;
  }

  /**
   * Plain INSERT — the PRIMARY KEY rejects duplicates (dedup layer 2, spec §8.2).
   * Throws SqliteError(SQLITE_CONSTRAINT_PRIMARYKEY) if the key already exists.
   */
  insert(item: NewSeenItem): void {
    this.db
      .prepare(
        `INSERT INTO seen_items
          (item_key, type, parent_key, target_id, text_hash, posted_at, first_seen, is_match,
           capture_path, sync_status, matched_keyword, review_status)
         VALUES
          (@item_key, @type, @parent_key, @target_id, @text_hash, @posted_at, @first_seen, @is_match,
           @capture_path, @sync_status, @matched_keyword, @review_status)`,
      )
      .run({
        parent_key: null,
        target_id: null,
        text_hash: null,
        posted_at: null,
        capture_path: null,
        sync_status: null,
        matched_keyword: null,
        review_status: null,
        ...item,
      });
  }

  /** Insert many in one transaction (all-or-nothing). */
  insertMany(items: NewSeenItem[]): void {
    this.db.transaction((rows: NewSeenItem[]) => rows.forEach((r) => this.insert(r)))(items);
  }

  queryCaptures(q: CaptureQuery): SeenItem[] {
    const where = ['is_match = 1'];
    const params: Record<string, unknown> = {};
    if (q.from) (where.push('first_seen >= @from'), (params.from = q.from));
    if (q.to) (where.push('first_seen <= @to'), (params.to = q.to));
    if (q.keyword) (where.push('matched_keyword = @keyword'), (params.keyword = q.keyword));
    if (q.target_id !== undefined) (where.push('target_id = @target_id'), (params.target_id = q.target_id));
    if (q.sync_status) (where.push('sync_status = @sync_status'), (params.sync_status = q.sync_status));
    if (!q.review_status) where.push("(review_status IS NULL OR review_status != 'rejected')");
    else if (q.review_status !== 'all') (where.push('review_status = @review_status'), (params.review_status = q.review_status));
    params.limit = Math.min(q.limit ?? 100, 1000);
    return this.db
      .prepare(`SELECT * FROM seen_items WHERE ${where.join(' AND ')} ORDER BY first_seen DESC LIMIT @limit`)
      .all(params) as SeenItem[];
  }

  /** Capture folders that still have items awaiting review, oldest first. */
  pendingReviewFolders(limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT capture_path, MIN(first_seen) AS f FROM seen_items
           WHERE review_status = 'pending' AND capture_path IS NOT NULL
           GROUP BY capture_path ORDER BY f LIMIT ?`,
        )
        .all(limit) as { capture_path: string }[]
    ).map((r) => r.capture_path);
  }

  inFolder(capturePath: string): SeenItem[] {
    return this.db
      .prepare(`SELECT * FROM seen_items WHERE capture_path = ? AND type IN ('post', 'comment')`)
      .all(capturePath) as SeenItem[];
  }

  applyReview(u: ReviewUpdate): void {
    this.db
      .prepare(
        `UPDATE seen_items SET review_status = @review_status, sentiment = @sentiment, promotional = @promotional,
           review_reason = @review_reason, reviewed_at = @reviewed_at,
           sync_status = CASE WHEN @review_status IN ('kept', 'context') THEN COALESCE(sync_status, 'pending') ELSE NULL END
         WHERE item_key = @item_key`,
      )
      .run({ ...u, promotional: u.promotional ? 1 : 0 });
  }

  /** A previously seen non-match that a /find job kept: mark it captured and kept. */
  promoteToKept(key: string, capturePath: string, matchedKeyword: string | null): void {
    this.db
      .prepare(
        `UPDATE seen_items SET is_match = 1, capture_path = ?, review_status = 'kept', sync_status = 'pending',
           matched_keyword = COALESCE(matched_keyword, ?) WHERE item_key = ?`,
      )
      .run(capturePath, matchedKeyword, key);
  }

    clearCapturePath(keys: string[]): void {
    const stmt = this.db.prepare('UPDATE seen_items SET capture_path = NULL WHERE item_key = ?');
    for (const k of keys) stmt.run(k);
  }

  reviewCounts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT review_status AS s, COUNT(*) AS n FROM seen_items WHERE is_match = 1 AND type IN ('post','comment') GROUP BY review_status`)
      .all() as { s: string | null; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.s ?? 'none', r.n]));
  }

  /** Audit log of review decisions, newest first. */
  reviewLog(status: ReviewStatus | undefined, limit: number): SeenItem[] {
    return this.db
      .prepare(
        `SELECT * FROM seen_items WHERE reviewed_at IS NOT NULL ${status ? 'AND review_status = @status' : ''}
         ORDER BY reviewed_at DESC LIMIT @limit`,
      )
      .all(status ? { status, limit } : { limit }) as SeenItem[];
  }

  syncCounts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT sync_status AS s, COUNT(*) AS n FROM seen_items WHERE is_match = 1 GROUP BY sync_status`)
      .all() as { s: string | null; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.s ?? 'none', r.n]));
  }

  countCapturedSince(iso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM seen_items WHERE is_match = 1 AND first_seen >= ? AND (review_status IS NULL OR review_status != 'rejected')")
        .get(iso) as { n: number }
    ).n;
  }
}
