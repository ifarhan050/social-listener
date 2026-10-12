import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { migrate } from './migrations.js';
import { TargetsRepo } from './targets.js';
import { KeywordsRepo } from './keywords.js';
import { SeenItemsRepo } from './seenItems.js';
import { RunsRepo } from './runs.js';
import { SettingsRepo } from './settings.js';
import { ReportsRepo } from './reports.js';
import { MissionsRepo } from './missions.js';

export interface Repos {
  db: Database;
  targets: TargetsRepo;
  keywords: KeywordsRepo;
  seen: SeenItemsRepo;
  runs: RunsRepo;
  settings: SettingsRepo;
  reports: ReportsRepo;
  missions: MissionsRepo;
}

/** Open (or create) the database. Pass ':memory:' for tests. */
export function openDb(file: string): Repos {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return {
    db,
    targets: new TargetsRepo(db),
    keywords: new KeywordsRepo(db),
    seen: new SeenItemsRepo(db),
    runs: new RunsRepo(db),
    settings: new SettingsRepo(db),
    reports: new ReportsRepo(db),
    missions: new MissionsRepo(db),
  };
}

export * from './targets.js';
export * from './keywords.js';
export * from './seenItems.js';
export * from './runs.js';
export * from './settings.js';
export * from './reports.js';
export * from './missions.js';
