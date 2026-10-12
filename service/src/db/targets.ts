import type { Database } from 'better-sqlite3';

export type TargetStatus = 'active' | 'candidate' | 'dormant' | 'disabled';
export type TargetPriority = 'high' | 'normal';

export interface Target {
  id: number;
  platform: string;
  kind: string;
  url: string;
  name: string | null;
  status: TargetStatus;
  priority: TargetPriority;
  cutoff_hours: number | null;
  max_posts: number | null;
  activity_ema: number;
  hit_rate_ema: number;
  scans: number;
  watermark: string | null;
  last_scanned_at: string | null;
  next_due_at: string | null;
  /** 'all': every comment on this target's posts goes to review even without the mission's terms (e.g. the brand's own page). */
  comments_mode: CommentsMode;
}

export type CommentsMode = 'matching' | 'all';

export interface NewTarget {
  platform: string;
  kind: string;
  url: string;
  name?: string | null;
  status?: TargetStatus;
  priority?: TargetPriority;
  cutoff_hours?: number | null;
  max_posts?: number | null;
  comments_mode?: CommentsMode;
}

export type TargetPatch = Partial<
  Pick<Target, 'name' | 'status' | 'priority' | 'cutoff_hours' | 'max_posts' | 'next_due_at' | 'comments_mode'>
>;

export class TargetsRepo {
  constructor(private db: Database) {}

  list(): Target[] {
    return this.db.prepare('SELECT * FROM targets ORDER BY id').all() as Target[];
  }

  get(id: number): Target | undefined {
    return this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as Target | undefined;
  }

  getByUrl(url: string): Target | undefined {
    return this.db.prepare('SELECT * FROM targets WHERE url = ?').get(url) as Target | undefined;
  }

  add(t: NewTarget): Target {
    const info = this.db
      .prepare(
        `INSERT INTO targets (platform, kind, url, name, status, priority, cutoff_hours, max_posts, comments_mode)
         VALUES (@platform, @kind, @url, @name, @status, @priority, @cutoff_hours, @max_posts, @comments_mode)`,
      )
      .run({
        name: null,
        status: 'active',
        priority: 'normal',
        cutoff_hours: null,
        max_posts: null,
        comments_mode: 'matching',
        ...t,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: TargetPatch): Target | undefined {
    const allowed = ['name', 'status', 'priority', 'cutoff_hours', 'max_posts', 'next_due_at', 'comments_mode'] as const;
    const sets = allowed.filter((k) => k in patch);
    if (sets.length) {
      this.db
        .prepare(`UPDATE targets SET ${sets.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
        .run({ ...Object.fromEntries(sets.map((k) => [k, patch[k] ?? null])), id });
    }
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM targets WHERE id = ?').run(id).changes > 0;
  }

  /** Targets eligible for a run: active, due (or never scanned). High priority first. */
  listDue(now: Date): Target[] {
    return this.db
      .prepare(
        `SELECT * FROM targets
         WHERE status = 'active' AND (next_due_at IS NULL OR next_due_at <= ?)
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, hit_rate_ema DESC, id`,
      )
      .all(now.toISOString()) as Target[];
  }

  recordScan(
    id: number,
    fields: { watermark: string | null; last_scanned_at: string; next_due_at: string },
  ): void {
    this.db
      .prepare(
        `UPDATE targets SET scans = scans + 1,
           watermark = COALESCE(@watermark, watermark),
           last_scanned_at = @last_scanned_at, next_due_at = @next_due_at
         WHERE id = @id`,
      )
      .run({ ...fields, id });
  }
}
