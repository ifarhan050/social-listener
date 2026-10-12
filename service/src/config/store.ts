import type { SettingsRepo } from '../db/settings.js';
import { applyConfigPatch } from './merge.js';
import { configSchema, type Config } from './schema.js';

const CONFIG_KEY = 'config';

/**
 * Older versions had per-section switches (`news.enabled`, `rss.enabled`, `youtube.enabled`,
 * `reddit.enabled`). Carry a saved `false` into the single `platforms` switch so it isn't lost.
 */
export function migrateLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const platforms = { ...((raw.platforms as Record<string, unknown>) ?? {}) };
  let changed = false;
  for (const p of ['news', 'rss', 'youtube', 'reddit']) {
    const section = raw[p] as Record<string, unknown> | undefined;
    if (section && 'enabled' in section) {
      if (section.enabled === false && platforms[p] === undefined) platforms[p] = false;
      const { enabled: _drop, ...rest } = section;
      raw = { ...raw, [p]: rest };
      changed = true;
    }
  }
  // `search.max_keywords` became `search.max_queries` (phrases now come from missions).
  const search = raw.search as Record<string, unknown> | undefined;
  if (search && 'max_keywords' in search) {
    const { max_keywords, ...rest } = search;
    raw = { ...raw, search: { max_queries: max_keywords, ...rest } };
  }
  // `scheduler.enabled` (default true) was replaced by `scheduler.trigger` (default cowork).
  const sched = raw.scheduler as Record<string, unknown> | undefined;
  if (sched && 'enabled' in sched) {
    const { enabled: _drop, ...rest } = sched;
    raw = { ...raw, scheduler: rest };
  }
  return changed ? { ...raw, platforms } : raw;
}

/**
 * Single source of truth for configuration (spec §13.3): the `settings` table.
 * Always read fresh so changes from the API/MCP apply to the next run.
 */
export class ConfigStore {
  constructor(private settings: SettingsRepo) {}

  get(): Config {
    // Re-parse so newly added defaults fill in for configs saved by older versions.
    return configSchema.parse(migrateLegacy(this.settings.get<Record<string, unknown>>(CONFIG_KEY) ?? {}));
  }

  update(patch: unknown): Config {
    const next = applyConfigPatch(this.get(), patch);
    this.settings.set(CONFIG_KEY, next);
    return next;
  }

  reset(): Config {
    const next = configSchema.parse({});
    this.settings.set(CONFIG_KEY, next);
    return next;
  }
}

export type SessionStatus = 'unknown' | 'ok' | 'needs_reconnect';

export interface RuntimeState {
  session_status: SessionStatus;
  session_checked_at: string | null;
  /** Facebook jobs paused until this ISO time after a checkpoint (spec §6.1). */
  paused_until: string | null;
  /** Why Facebook is paused: checkpoint/login wall, or a soft block (rate limit). */
  paused_reason?: string | null;
  /** Last time Facebook showed a checkpoint or soft block (doctor warns for 7 days). */
  last_restriction_at?: string | null;
  /** User acknowledged the account-risk notice (spec §14). Scanning is refused until true. */
  risk_acknowledged: boolean;
  /** Consecutive fetch runs that scanned targets but saw no new posts (spec §15). */
  zero_new_streak: number;
  /** Health of API-based platforms (e.g. reddit). Facebook uses the session_* fields above. */
  platform_health: Record<string, PlatformHealth>;
  alerts: Alert[];
}

export interface PlatformHealth {
  status: 'ok' | 'not_configured' | 'error' | 'unknown';
  checked_at: string | null;
  detail?: string;
  /** After a failed check, the platform is skipped until this time (avoids retrying every tick). */
  retry_after?: string | null;
}

export interface Alert {
  code: 'session_needs_reconnect' | 'zero_new_items' | 'budget_exhausted' | 'sync_failures' | 'reddit_auth_failed' | 'facebook_rate_limited';
  message: string;
  at: string;
}

const STATE_KEY = 'runtime_state';
const DEFAULT_STATE: RuntimeState = {
  session_status: 'unknown',
  session_checked_at: null,
  paused_until: null,
  risk_acknowledged: false,
  zero_new_streak: 0,
  platform_health: {},
  alerts: [],
};

export class StateStore {
  constructor(private settings: SettingsRepo) {}

  get(): RuntimeState {
    return { ...DEFAULT_STATE, ...(this.settings.get<Partial<RuntimeState>>(STATE_KEY) ?? {}) };
  }

  patch(p: Partial<RuntimeState>): RuntimeState {
    const next = { ...this.get(), ...p };
    this.settings.set(STATE_KEY, next);
    return next;
  }

  raise(alert: Omit<Alert, 'at'>, now = new Date()): void {
    const s = this.get();
    const others = s.alerts.filter((a) => a.code !== alert.code);
    this.patch({ alerts: [...others, { ...alert, at: now.toISOString() }] });
  }

  clear(code: Alert['code']): void {
    const s = this.get();
    if (s.alerts.some((a) => a.code === code)) this.patch({ alerts: s.alerts.filter((a) => a.code !== code) });
  }
}
