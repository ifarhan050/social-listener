import type { Repos } from '../db/index.js';
import type { Keyword } from '../db/keywords.js';
import type { Mission } from '../db/missions.js';
import { Matcher, prepareText, type MatchOptions, type MatchResult, type PreparedText } from '../matcher/index.js';
import { TEMPLATES } from './templates.js';

export * from './templates.js';

export const LEGACY_MISSION_NAME = 'Brand complaints & scams';
const LEGACY_FLAG = 'legacy_mission_created';

/**
 * Upgrade path: installs that predate missions have brand keywords but no missions.
 * Create mission #1 from them (template "complaints", reading the keywords table live)
 * and attach existing captures to it, so nothing changes for the user. Runs once.
 */
export function ensureLegacyMission(repos: Repos): Mission | null {
  if (repos.missions.count() > 0 || repos.settings.get(LEGACY_FLAG)) return null;
  const keywords = repos.keywords.list();
  if (!keywords.length) return null;
  const t = TEMPLATES.complaints;
  let mission!: Mission;
  repos.db.transaction(() => {
    mission = repos.missions.create({
      name: LEGACY_MISSION_NAME,
      template: 'complaints',
      goal: `Find complaints, scam warnings and service problems about ${keywords.map((k) => k.keyword).join(', ')}.`,
      match: { use_keywords: true },
      keep_rules: t.keep_rules,
      exclude_rules: t.exclude_rules,
      report: { days: t.report_days },
    });
    const rows = repos.db
      .prepare(`SELECT item_key, review_status, matched_keyword FROM seen_items WHERE is_match = 1 AND type IN ('post','comment')`)
      .all() as { item_key: string; review_status: string | null; matched_keyword: string | null }[];
    for (const r of rows) {
      const status = (r.review_status ?? 'kept') as 'pending' | 'kept' | 'context' | 'rejected';
      repos.missions.link(r.item_key, mission.id, r.matched_keyword ? [r.matched_keyword] : [], status);
    }
    repos.settings.set(LEGACY_FLAG, true);
  })();
  return mission;
}

/**
 * The keyword tools (add_keyword…) edit the brand mission's terms. If keywords are added on an
 * install that has missions but no keyword-based mission, create one so they take effect.
 */
export function ensureKeywordsMission(repos: Repos): void {
  if (repos.missions.list().some((m) => m.match.use_keywords)) return;
  if (!repos.keywords.list().length) return;
  if (repos.missions.count() === 0 && !repos.settings.get(LEGACY_FLAG)) {
    ensureLegacyMission(repos);
    return;
  }
  const t = TEMPLATES.complaints;
  const name = repos.missions.getByName(LEGACY_MISSION_NAME) ? `${LEGACY_MISSION_NAME} (keywords)` : LEGACY_MISSION_NAME;
  repos.missions.create({
    name,
    template: 'complaints',
    goal: `Find complaints, scam warnings and service problems about ${repos.keywords.list().map((k) => k.keyword).join(', ')}.`,
    match: { use_keywords: true },
    keep_rules: t.keep_rules,
    exclude_rules: t.exclude_rules,
    report: { days: t.report_days },
  });
}

/** Fill unspecified fields from the mission's template. */
export function withTemplateDefaults<T extends { template: string; keep_rules?: string; exclude_rules?: string; sources?: Mission['sources']; report?: Mission['report'] }>(
  input: T,
): T & Pick<Mission, 'keep_rules' | 'exclude_rules' | 'sources' | 'report'> {
  const t = TEMPLATES[input.template as keyof typeof TEMPLATES] ?? TEMPLATES.custom;
  return {
    ...input,
    keep_rules: input.keep_rules || t.keep_rules,
    exclude_rules: input.exclude_rules || t.exclude_rules,
    sources: { ...t.default_sources, ...(input.sources ?? {}) },
    report: { days: t.report_days, schedule: t.report_schedule, ...(input.report ?? {}) },
  };
}

/** Phrases a mission searches for on each platform. */
export function effectiveQueries(m: Mission, keywords: Keyword[]): string[] {
  const qs = m.match.use_keywords ? keywords.filter((k) => k.enabled).map((k) => k.keyword) : m.search_queries;
  return [...new Set(qs.map((q) => q.trim()).filter(Boolean))];
}

export interface MissionHit {
  mission_id: number;
  mission_name: string;
  template: string;
  /** Capture folder name (legacy brand mission: the keyword, as before; others: the mission name). */
  folder: string;
  /** Terms that matched (for review and reports). */
  terms: string[];
  /** Representative match (keyword + matched text span). */
  primary: MatchResult;
}

export interface HitScope {
  platform: string;
  targetId?: number;
  targetKind?: string;
}

interface Compiled {
  mission: Mission;
  any: Matcher | null;
  allOf: Matcher[];
  none: Matcher | null;
}

const termsMatcher = (terms: string[] | undefined, opts: MatchOptions) =>
  terms && terms.filter((t) => t.trim()).length ? new Matcher(terms.filter((t) => t.trim()).map((t) => ({ keyword: t })), opts) : null;

/**
 * Evaluates every active mission's rules against a text. A post can match several
 * missions; each gets its own review verdict later.
 */
export class MissionMatcher {
  private compiled: Compiled[];

  constructor(missions: Mission[], keywords: Keyword[], opts: MatchOptions) {
    this.compiled = missions.map((m) => {
      if (m.match.use_keywords) {
        const kws = keywords.filter((k) => k.enabled);
        return { mission: m, any: kws.length ? new Matcher(kws, opts) : null, allOf: [], none: termsMatcher(m.match.none, opts) };
      }
      return {
        mission: m,
        any: termsMatcher(m.match.any, opts),
        allOf: (m.match.all_of ?? []).map((g) => termsMatcher(g, opts)).filter((x): x is Matcher => x !== null),
        none: termsMatcher(m.match.none, opts),
      };
    });
  }

  get size(): number {
    return this.compiled.length;
  }

  private inScope(m: Mission, scope?: HitScope): boolean {
    if (!scope) return true;
    if (m.sources[scope.platform as keyof Mission['sources']] === false) return false;
    if (m.target_ids && scope.targetId !== undefined && scope.targetKind !== 'search' && !m.target_ids.includes(scope.targetId)) return false;
    return true;
  }

  /**
   * Every active mission that covers this source, as a hit without terms. Used for targets with
   * comments_mode "all" (e.g. a brand's own page), where comments rarely name the brand.
   */
  scopeHits(scope: HitScope): MissionHit[] {
    return this.compiled
      .filter((c) => this.inScope(c.mission, scope))
      .map((c) => ({
        mission_id: c.mission.id,
        mission_name: c.mission.name,
        template: c.mission.template,
        folder: c.mission.name,
        terms: [],
        primary: { keyword: c.mission.name, variant: '', form: '', fuzzy: false },
      }));
  }

  match(text: string | PreparedText, scope?: HitScope): MissionHit[] {
    const prepared = typeof text === 'string' ? prepareText(text) : text;
    const hits: MissionHit[] = [];
    for (const c of this.compiled) {
      if (!this.inScope(c.mission, scope)) continue;
      if (!c.any && !c.allOf.length) continue; // a mission with no rules matches nothing
      if (c.none?.match(prepared)) continue;
      const found: MatchResult[] = [];
      if (c.any) {
        const r = c.any.matchAll(prepared);
        if (!r.length) continue;
        found.push(...r);
      }
      let ok = true;
      for (const g of c.allOf) {
        const r = g.match(prepared);
        if (!r) {
          ok = false;
          break;
        }
        found.push(r);
      }
      if (!ok || !found.length) continue;
      const m = c.mission;
      hits.push({
        mission_id: m.id,
        mission_name: m.name,
        template: m.template,
        folder: m.match.use_keywords ? found[0].keyword : m.name,
        terms: [...new Set(found.map((f) => f.keyword))],
        primary: found[0],
      });
    }
    return hits;
  }
}
