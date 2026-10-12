import type { Database } from 'better-sqlite3';

/** Ordered migrations; index + 1 == PRAGMA user_version after applying. */
const MIGRATIONS: string[] = [
  // 1 — spec §11 schema
  `
  CREATE TABLE targets (
    id              INTEGER PRIMARY KEY,
    platform        TEXT NOT NULL,
    kind            TEXT NOT NULL,
    url             TEXT NOT NULL UNIQUE,
    name            TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    priority        TEXT NOT NULL DEFAULT 'normal',
    cutoff_hours    INTEGER,
    max_posts       INTEGER,
    activity_ema    REAL DEFAULT 0,
    hit_rate_ema    REAL DEFAULT 0.2,
    scans           INTEGER DEFAULT 0,
    watermark       TEXT,
    last_scanned_at TEXT,
    next_due_at     TEXT
  );

  CREATE TABLE keywords (
    id        INTEGER PRIMARY KEY,
    keyword   TEXT NOT NULL UNIQUE,
    variants  TEXT DEFAULT '[]',
    negatives TEXT DEFAULT '[]',
    enabled   INTEGER DEFAULT 1
  );

  CREATE TABLE seen_items (
    item_key      TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    parent_key    TEXT,
    target_id     INTEGER,
    text_hash     TEXT,
    posted_at     TEXT,
    first_seen    TEXT NOT NULL,
    is_match      INTEGER NOT NULL,
    capture_path  TEXT,
    sync_status   TEXT,
    sync_attempts INTEGER DEFAULT 0,
    next_sync_at  TEXT,
    last_error    TEXT
  );
  CREATE INDEX idx_seen_sync ON seen_items(sync_status, next_sync_at);

  CREATE TABLE comment_rescans (
    post_key   TEXT NOT NULL,
    due_at     TEXT NOT NULL,
    done       INTEGER DEFAULT 0,
    PRIMARY KEY (post_key, due_at)
  );

  CREATE TABLE runs (
    id                 INTEGER PRIMARY KEY,
    kind               TEXT NOT NULL,
    started_at         TEXT, finished_at TEXT,
    page_loads         INTEGER, posts_scanned INTEGER,
    new_captures       INTEGER, duplicates_skipped INTEGER,
    errors             INTEGER, notes TEXT
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2 — capture metadata used for querying captures (keyword filter, first_seen range)
  `
  ALTER TABLE seen_items ADD COLUMN matched_keyword TEXT;
  CREATE INDEX idx_seen_match ON seen_items(is_match, first_seen);
  CREATE INDEX idx_runs_started ON runs(started_at);
  `,
  // 3 — review queue: Cowork labels each capture; only negative, non-promotional items are kept.
  // review_status: pending | kept | context (post kept only for its negative comments) | rejected
  `
  ALTER TABLE seen_items ADD COLUMN review_status TEXT;
  ALTER TABLE seen_items ADD COLUMN sentiment TEXT;
  ALTER TABLE seen_items ADD COLUMN promotional INTEGER;
  ALTER TABLE seen_items ADD COLUMN review_reason TEXT;
  ALTER TABLE seen_items ADD COLUMN reviewed_at TEXT;
  UPDATE seen_items SET review_status = 'pending', sync_status = NULL WHERE is_match = 1 AND type IN ('post', 'comment');
  CREATE INDEX idx_seen_review ON seen_items(review_status, capture_path);
  `,
  // 4 — report jobs (e.g. "Facebook groups, last 30 days, most negative posts"), resumable.
  `
  CREATE TABLE report_jobs (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    params      TEXT NOT NULL,
    status      TEXT NOT NULL,            -- running | partial | done | failed | aborted
    progress    TEXT NOT NULL DEFAULT '{}',
    notes       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE report_posts (
    job_id        INTEGER NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
    post_key      TEXT NOT NULL,
    group_name    TEXT,
    group_url     TEXT,
    post_url      TEXT,
    author        TEXT,
    posted_at     TEXT,
    text          TEXT,
    matched_keyword TEXT,
    comment_count INTEGER,
    comments      TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (job_id, post_key)
  );
  `,
  // 5 — missions: each user goal (complaints, leads, competitors, topic…) with its own
  // match rules, search phrases, review rules, sources and report. Verdicts are per mission.
  `
  CREATE TABLE missions (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    template       TEXT NOT NULL,
    goal           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',   -- active | paused
    match          TEXT NOT NULL DEFAULT '{}',
    search_queries TEXT NOT NULL DEFAULT '[]',
    keep_rules     TEXT NOT NULL DEFAULT '',
    exclude_rules  TEXT NOT NULL DEFAULT '',
    sources        TEXT NOT NULL DEFAULT '{}',
    target_ids     TEXT,
    locale         TEXT NOT NULL DEFAULT '{}',
    report         TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE item_missions (
    item_key       TEXT NOT NULL,
    mission_id     INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    matched_terms  TEXT NOT NULL DEFAULT '[]',
    review_status  TEXT NOT NULL DEFAULT 'pending',  -- pending | kept | context | rejected
    verdict_label  TEXT,
    score          INTEGER,
    reason         TEXT,
    reviewed_at    TEXT,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (item_key, mission_id)
  );
  CREATE INDEX idx_item_missions_status ON item_missions(mission_id, review_status);
  `,
  // 6 — per-target comment mode, and manual /find jobs (count + types + sources + date range).
  `
  ALTER TABLE targets ADD COLUMN comments_mode TEXT NOT NULL DEFAULT 'matching';
  CREATE TABLE find_jobs (
    id          INTEGER PRIMARY KEY,
    params      TEXT NOT NULL,
    status      TEXT NOT NULL,              -- collecting | ready | done | exhausted | partial | aborted | failed
    progress    TEXT NOT NULL DEFAULT '{}',
    notes       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE find_items (
    job_id      INTEGER NOT NULL REFERENCES find_jobs(id) ON DELETE CASCADE,
    item_key    TEXT NOT NULL,
    payload     TEXT NOT NULL,
    label       TEXT,
    keep        INTEGER,
    reason      TEXT,
    saved       INTEGER NOT NULL DEFAULT 0,
    batch       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (job_id, item_key)
  );
  `,
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
