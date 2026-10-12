import type { Database } from 'better-sqlite3';

export interface Keyword {
  id: number;
  keyword: string;
  variants: string[];
  negatives: string[];
  enabled: boolean;
}

interface Row {
  id: number;
  keyword: string;
  variants: string;
  negatives: string;
  enabled: number;
}

const fromRow = (r: Row): Keyword => ({
  id: r.id,
  keyword: r.keyword,
  variants: JSON.parse(r.variants || '[]'),
  negatives: JSON.parse(r.negatives || '[]'),
  enabled: r.enabled === 1,
});

export type KeywordInput = { keyword: string; variants?: string[]; negatives?: string[]; enabled?: boolean };
export type KeywordPatch = Partial<KeywordInput>;

export class KeywordsRepo {
  constructor(private db: Database) {}

  list(): Keyword[] {
    return (this.db.prepare('SELECT * FROM keywords ORDER BY id').all() as Row[]).map(fromRow);
  }

  listEnabled(): Keyword[] {
    return this.list().filter((k) => k.enabled);
  }

  get(id: number): Keyword | undefined {
    const r = this.db.prepare('SELECT * FROM keywords WHERE id = ?').get(id) as Row | undefined;
    return r && fromRow(r);
  }

  add(k: KeywordInput): Keyword {
    const info = this.db
      .prepare('INSERT INTO keywords (keyword, variants, negatives, enabled) VALUES (?, ?, ?, ?)')
      .run(
        k.keyword.trim(),
        JSON.stringify(k.variants ?? []),
        JSON.stringify(k.negatives ?? []),
        k.enabled === false ? 0 : 1,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, patch: KeywordPatch): Keyword | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE keywords SET keyword = ?, variants = ?, negatives = ?, enabled = ? WHERE id = ?')
      .run(next.keyword.trim(), JSON.stringify(next.variants), JSON.stringify(next.negatives), next.enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM keywords WHERE id = ?').run(id).changes > 0;
  }
}
