import type { Database } from 'better-sqlite3';

export type ReportStatus = 'running' | 'partial' | 'done' | 'failed' | 'aborted';

export interface ReportJob<P = unknown, G = unknown> {
  id: number;
  kind: string;
  params: P;
  status: ReportStatus;
  progress: G;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportComment {
  author: string;
  text: string;
  posted_at: string | null;
  url: string;
}

export interface ReportPost {
  post_key: string;
  group_name: string | null;
  group_url: string | null;
  post_url: string;
  author: string;
  posted_at: string | null;
  text: string;
  matched_keyword: string | null;
  comment_count: number | null;
  comments: ReportComment[];
}

interface JobRow {
  id: number;
  kind: string;
  params: string;
  status: ReportStatus;
  progress: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export class ReportsRepo {
  constructor(private db: Database) {}

  create<P>(kind: string, params: P, now: Date): number {
    const at = now.toISOString();
    const info = this.db
      .prepare(`INSERT INTO report_jobs (kind, params, status, progress, created_at, updated_at) VALUES (?, ?, 'running', '{}', ?, ?)`)
      .run(kind, JSON.stringify(params), at, at);
    return Number(info.lastInsertRowid);
  }

  get<P, G>(id: number): ReportJob<P, G> | undefined {
    const r = this.db.prepare('SELECT * FROM report_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r && { ...r, params: JSON.parse(r.params) as P, progress: JSON.parse(r.progress) as G };
  }

  update(id: number, fields: { status?: ReportStatus; progress?: unknown; notes?: string | null }, now: Date): void {
    const cur = this.db.prepare('SELECT * FROM report_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!cur) return;
    this.db
      .prepare('UPDATE report_jobs SET status = ?, progress = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(
        fields.status ?? cur.status,
        fields.progress !== undefined ? JSON.stringify(fields.progress) : cur.progress,
        fields.notes !== undefined ? fields.notes : cur.notes,
        now.toISOString(),
        id,
      );
  }

  /** Insert or refresh a post (resume may revisit it with more comments). */
  upsertPost(jobId: number, p: ReportPost): void {
    this.db
      .prepare(
        `INSERT INTO report_posts (job_id, post_key, group_name, group_url, post_url, author, posted_at, text, matched_keyword, comment_count, comments)
         VALUES (@job_id, @post_key, @group_name, @group_url, @post_url, @author, @posted_at, @text, @matched_keyword, @comment_count, @comments)
         ON CONFLICT(job_id, post_key) DO UPDATE SET
           comment_count = excluded.comment_count,
           comments = CASE WHEN json_array_length(excluded.comments) >= json_array_length(report_posts.comments)
                           THEN excluded.comments ELSE report_posts.comments END`,
      )
      .run({ ...p, job_id: jobId, comments: JSON.stringify(p.comments) });
  }

  posts(jobId: number): ReportPost[] {
    return (
      this.db.prepare('SELECT * FROM report_posts WHERE job_id = ? ORDER BY posted_at DESC').all(jobId) as (Omit<ReportPost, 'comments'> & {
        comments: string;
      })[]
    ).map((r) => ({ ...r, comments: JSON.parse(r.comments) as ReportComment[] }));
  }

  hasPost(jobId: number, postKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM report_posts WHERE job_id = ? AND post_key = ?').get(jobId, postKey) !== undefined;
  }
}
