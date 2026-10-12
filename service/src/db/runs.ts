import type { Database } from 'better-sqlite3';

export type RunKind = 'fetch' | 'sync' | 'discovery' | 'report';

export interface Run {
  id: number;
  kind: RunKind;
  started_at: string | null;
  finished_at: string | null;
  page_loads: number | null;
  posts_scanned: number | null;
  new_captures: number | null;
  duplicates_skipped: number | null;
  errors: number | null;
  notes: string | null;
}

export interface RunStats {
  page_loads: number;
  posts_scanned: number;
  new_captures: number;
  duplicates_skipped: number;
  errors: number;
  notes?: string | null;
}

export class RunsRepo {
  constructor(private db: Database) {}

  start(kind: RunKind, startedAt: Date): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs (kind, started_at, page_loads, posts_scanned, new_captures, duplicates_skipped, errors)
         VALUES (?, ?, 0, 0, 0, 0, 0)`,
      )
      .run(kind, startedAt.toISOString());
    return Number(info.lastInsertRowid);
  }

  /** Persist running counters (called during a run so the daily budget sees live page loads). */
  update(id: number, stats: RunStats): void {
    this.db
      .prepare(
        `UPDATE runs SET page_loads = @page_loads, posts_scanned = @posts_scanned, new_captures = @new_captures,
           duplicates_skipped = @duplicates_skipped, errors = @errors, notes = @notes WHERE id = @id`,
      )
      .run({ notes: null, ...stats, id });
  }

  finish(id: number, finishedAt: Date, stats: RunStats): void {
    this.update(id, stats);
    this.db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(finishedAt.toISOString(), id);
  }

  get(id: number): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
  }

  recent(limit = 20): Run[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as Run[];
  }

  between(fromIso: string, toIso: string): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY id')
      .all(fromIso, toIso) as Run[];
  }

  /** Sum of page loads for runs started at/after `sinceIso` (spec §11: daily budget). */
  pageLoadsSince(sinceIso: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(SUM(page_loads), 0) AS n FROM runs WHERE started_at >= ?')
        .get(sinceIso) as { n: number }
    ).n;
  }
}
