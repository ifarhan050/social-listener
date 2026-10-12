import type { Database } from 'better-sqlite3';
import type { PlatformName } from '../config/schema.js';

export type MissionStatus = 'active' | 'paused';

/**
 * Match rules for a mission (cheap prefilter; Claude makes the final call in review).
 *   any     — at least one term must appear (variants/fuzzy like brand keywords)
 *   all_of  — every group must have at least one term (e.g. [[tutor,tuition],[need,looking for]])
 *   none    — any of these terms vetoes the match
 *   use_keywords — legacy: take any/none from the keywords table (the original brand mission)
 */
export interface MissionMatch {
  use_keywords?: boolean;
  any?: string[];
  all_of?: string[][];
  none?: string[];
}

export interface MissionLocale {
  location?: string;
  languages?: string[];
}

export interface MissionReport {
  days?: number;
  format?: string;
  schedule?: string;
}

export interface Mission {
  id: number;
  name: string;
  template: string;
  goal: string;
  status: MissionStatus;
  match: MissionMatch;
  /** Phrases typed into platform searches (Facebook, news, YouTube, Reddit). Legacy mission: its keywords. */
  search_queries: string[];
  keep_rules: string;
  exclude_rules: string;
  /** Per-mission source choice (within the global platforms switches). Missing = on. */
  sources: Partial<Record<PlatformName, boolean>>;
  /** Restrict to these targets (groups/pages/feeds/channels); null = all targets of its sources. */
  target_ids: number[] | null;
  locale: MissionLocale;
  report: MissionReport;
  created_at: string;
  updated_at: string;
}

export type NewMission = Pick<Mission, 'name' | 'template' | 'goal'> &
  Partial<Pick<Mission, 'status' | 'match' | 'search_queries' | 'keep_rules' | 'exclude_rules' | 'sources' | 'target_ids' | 'locale' | 'report'>>;
export type MissionPatch = Partial<Omit<NewMission, never>>;

interface Row {
  id: number;
  name: string;
  template: string;
  goal: string;
  status: MissionStatus;
  match: string;
  search_queries: string;
  keep_rules: string;
  exclude_rules: string;
  sources: string;
  target_ids: string | null;
  locale: string;
  report: string;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): Mission => ({
  ...r,
  match: JSON.parse(r.match),
  search_queries: JSON.parse(r.search_queries),
  sources: JSON.parse(r.sources),
  target_ids: r.target_ids ? JSON.parse(r.target_ids) : null,
  locale: JSON.parse(r.locale),
  report: JSON.parse(r.report),
});

const JSON_FIELDS = ['match', 'search_queries', 'sources', 'target_ids', 'locale', 'report'] as const;
const FIELDS = ['name', 'template', 'goal', 'status', 'keep_rules', 'exclude_rules', ...JSON_FIELDS] as const;

export type ItemReviewStatus = 'pending' | 'kept' | 'context' | 'rejected';

export interface ItemMission {
  item_key: string;
  mission_id: number;
  matched_terms: string[];
  review_status: ItemReviewStatus;
  verdict_label: string | null;
  score: number | null;
  reason: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export class MissionsRepo {
  constructor(private db: Database) {}

  list(): Mission[] {
    return (this.db.prepare('SELECT * FROM missions ORDER BY id').all() as Row[]).map(fromRow);
  }

  active(): Mission[] {
    return this.list().filter((m) => m.status === 'active');
  }

  get(id: number): Mission | undefined {
    const r = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Row | undefined;
    return r && fromRow(r);
  }

  getByName(name: string): Mission | undefined {
    const r = this.db.prepare('SELECT * FROM missions WHERE lower(name) = lower(?)').get(name.trim()) as Row | undefined;
    return r && fromRow(r);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n;
  }

  create(m: NewMission, now = new Date()): Mission {
    const at = now.toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO missions (name, template, goal, status, match, search_queries, keep_rules, exclude_rules, sources, target_ids, locale, report, created_at, updated_at)
         VALUES (@name, @template, @goal, @status, @match, @search_queries, @keep_rules, @exclude_rules, @sources, @target_ids, @locale, @report, @at, @at)`,
      )
      .run({
        name: m.name.trim(),
        template: m.template,
        goal: m.goal,
        status: m.status ?? 'active',
        match: JSON.stringify(m.match ?? {}),
        search_queries: JSON.stringify(m.search_queries ?? []),
        keep_rules: m.keep_rules ?? '',
        exclude_rules: m.exclude_rules ?? '',
        sources: JSON.stringify(m.sources ?? {}),
        target_ids: m.target_ids ? JSON.stringify(m.target_ids) : null,
        locale: JSON.stringify(m.locale ?? {}),
        report: JSON.stringify(m.report ?? {}),
        at,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: MissionPatch, now = new Date()): Mission | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, at: now.toISOString() };
    for (const f of FIELDS) {
      if (!(f in patch)) continue;
      const v = (patch as Record<string, unknown>)[f];
      sets.push(`${f} = @${f}`);
      params[f] = (JSON_FIELDS as readonly string[]).includes(f) ? (v === null ? null : JSON.stringify(v)) : v;
    }
    if (sets.length) this.db.prepare(`UPDATE missions SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(params);
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM missions WHERE id = ?').run(id).changes > 0;
  }

  // --- per-item verdicts -------------------------------------------------------------

  link(itemKey: string, missionId: number, terms: string[], status: ItemReviewStatus, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO item_missions (item_key, mission_id, matched_terms, review_status, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(item_key, mission_id) DO NOTHING`,
      )
      .run(itemKey, missionId, JSON.stringify(terms), status, now.toISOString());
  }

  forItem(itemKey: string): ItemMission[] {
    return (this.db.prepare('SELECT * FROM item_missions WHERE item_key = ? ORDER BY mission_id').all(itemKey) as (Omit<ItemMission, 'matched_terms'> & { matched_terms: string })[]).map(
      (r) => ({ ...r, matched_terms: JSON.parse(r.matched_terms) as string[] }),
    );
  }

  setVerdict(itemKey: string, missionId: number, v: { status: ItemReviewStatus; label: string | null; score: number | null; reason: string; at: string }): void {
    this.db
      .prepare(
        `UPDATE item_missions SET review_status = ?, verdict_label = ?, score = ?, reason = ?, reviewed_at = ? WHERE item_key = ? AND mission_id = ?`,
      )
      .run(v.status, v.label, v.score, v.reason, v.at, itemKey, missionId);
  }

  counts(): Record<number, Record<string, number>> {
    const rows = this.db
      .prepare('SELECT mission_id, review_status, COUNT(*) AS n FROM item_missions GROUP BY mission_id, review_status')
      .all() as { mission_id: number; review_status: string; n: number }[];
    const out: Record<number, Record<string, number>> = {};
    for (const r of rows) (out[r.mission_id] ??= {})[r.review_status] = r.n;
    return out;
  }

  /** Item keys for a mission with the given statuses, newest first (for reports). */
  items(missionId: number, statuses: ItemReviewStatus[], sinceIso?: string, limit = 500): { item_key: string; review: ItemMission; capture_path: string | null; type: string; first_seen: string }[] {
    const rows = this.db
      .prepare(
        `SELECT im.*, s.capture_path, s.type, s.first_seen FROM item_missions im JOIN seen_items s ON s.item_key = im.item_key
         WHERE im.mission_id = ? AND im.review_status IN (${statuses.map(() => '?').join(',')})
         ${sinceIso ? 'AND s.first_seen >= ?' : ''}
         ORDER BY s.first_seen DESC LIMIT ?`,
      )
      .all(missionId, ...statuses, ...(sinceIso ? [sinceIso] : []), limit) as (Omit<ItemMission, 'matched_terms'> & {
      matched_terms: string;
      capture_path: string | null;
      type: string;
      first_seen: string;
    })[];
    return rows.map((r) => ({
      item_key: r.item_key,
      capture_path: r.capture_path,
      type: r.type,
      first_seen: r.first_seen,
      review: { ...r, matched_terms: JSON.parse(r.matched_terms) as string[] },
    }));
  }
}
