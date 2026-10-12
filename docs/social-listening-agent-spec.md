# Social Listening Agent — Build Specification

> Hand-off spec for Claude Code. Build in the phases listed in §16. Every numeric value in this document is a **configurable default**, not a hardcoded constant.

---

## 1. Overview

A local, background social-listening agent that:

1. Monitors **configured public Facebook groups and pages** (and, later, Reddit and other platforms) for **brand keywords** (e.g. `xyzbank`).
2. Captures every matching **post and comment** as an **element screenshot + extracted text + metadata**.
3. Guarantees **unique results** — nothing is captured or synced twice.
4. **Batch-syncs** captures to an existing portal, where semantic analysis already runs.
5. Is controllable from **Claude Cowork** (via a plugin + local MCP server) and from a **local settings dashboard**.

The collector runs **headless in the background** using its own Playwright browser profile, so it never touches or interrupts the user's own browser.

### Goals
- Maximize unique keyword matches per page load (efficiency over raw volume).
- Zero duplicates on the portal.
- Fully configurable from a dashboard and from Claude.
- Pluggable source adapters so new platforms can be added without touching core logic.

### Non-goals
- Posting, liking, commenting, joining groups, or any write action on Facebook.
- Sentiment / semantic analysis (the portal does this).
- Multi-account operation, proxies, or anti-detection techniques (explicitly out of scope — see §14).

---

## 2. Architecture

```
┌──────────────── Claude Cowork ────────────────┐
│  Plugin: skills + commands + sub-agents       │
│            │  (MCP over stdio)                │
└────────────┼──────────────────────────────────┘
             ▼
┌──────────── Local Service (Node.js / TS) ─────────────┐
│  MCP Server ── Config API ── Settings Dashboard (web) │
│        │                                              │
│  Scheduler (priority queue, adaptive intervals)       │
│        │                                              │
│  Fetch Worker ──► Source Adapters                     │
│        │           ├─ FacebookGroupAdapter (Playwright)│
│        │           ├─ FacebookPageAdapter  (Playwright)│
│        │           └─ RedditAdapter (official API) [P3]│
│        ▼                                              │
│  Matcher ─► Capturer (screenshots + text + meta)      │
│        ▼                                              │
│  SQLite (config, groups, seen_items, outbox, runs)    │
│        ▼                                              │
│  Sync Worker ──► Portal Ingest API (batch, idempotent)│
└───────────────────────────────────────────────────────┘
```

**Runs locally on the user's machine** (not a cloud server): logins from datacenter IPs trigger Facebook security checks; the user's own network looks like normal usage. Local MCP servers also load in Cowork sessions running on the user's computer.

---

## 3. Tech Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (Node.js 20+) |
| Browser automation | Playwright (Chromium), persistent context |
| Database | SQLite via `better-sqlite3` |
| HTTP / dashboard | Express + a lightweight frontend (server-rendered or small SPA) |
| MCP | `@modelcontextprotocol/sdk`, stdio transport |
| Scheduling | In-process scheduler (custom priority queue; no external cron dependency) |
| Image processing | `sharp` (PNG → WebP/JPEG compression) |
| Logging | `pino` (JSON logs) |
| Validation | `zod` for config and API payloads |
| Tests | `vitest` |

---

## 4. Repository Structure

```
social-listener/
├── plugin/                          # Cowork / Claude Code plugin
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   ├── skills/
│   │   ├── social-listening/SKILL.md
│   │   └── manage-config/SKILL.md
│   ├── commands/
│   │   ├── scan.md
│   │   ├── add-keyword.md
│   │   ├── add-group.md
│   │   ├── status.md
│   │   └── settings.md
│   └── agents/
│       └── capture-reviewer.md
├── service/
│   ├── src/
│   │   ├── index.ts                 # boots scheduler, workers, dashboard, MCP
│   │   ├── mcp/server.ts
│   │   ├── config/                  # schema (zod), load/save, defaults
│   │   ├── db/                      # migrations, repositories
│   │   ├── scheduler/               # priority queue, scoring, budgets
│   │   ├── adapters/
│   │   │   ├── types.ts             # SourceAdapter interface
│   │   │   ├── facebook/
│   │   │   │   ├── session.ts       # login, health check
│   │   │   │   ├── groupFeed.ts
│   │   │   │   ├── pageFeed.ts
│   │   │   │   ├── extract.ts       # post/comment extraction
│   │   │   │   └── time.ts          # relative timestamp parsing
│   │   │   └── reddit/              # Phase 3
│   │   ├── matcher/                 # normalization, fuzzy, negatives
│   │   ├── capture/                 # screenshots, files, meta.json
│   │   ├── sync/                    # outbox, batching, retries
│   │   ├── dashboard/               # Express routes + UI
│   │   └── monitoring/              # run stats, alerts
│   ├── data/                        # gitignored: sqlite, browser profile, captures
│   └── test/
└── README.md
```

> Do **not** add a top-level `bin/` directory inside `plugin/` — it prevents installation in claude.ai and Cowork.

---

## 5. Source Adapter Interface

All platforms implement one interface so new sources plug in without changing core logic.

```ts
export interface SourceAdapter {
  id: string;                                   // 'facebook_group' | 'facebook_page' | 'reddit'
  healthCheck(): Promise<HealthStatus>;         // session valid? checkpoint?
  scanTarget(target: Target, ctx: ScanContext): AsyncGenerator<RawItem>;
  expandComments(post: RawItem, ctx: ScanContext): AsyncGenerator<RawItem>;
  captureScreenshot(item: RawItem, outPath: string): Promise<void>;
}

export interface ScanContext {
  cutoffTime: Date;          // stop when posts are older
  watermark?: Date;          // newest post time from last run (minus overlap)
  maxPosts: number;
  maxScrolls: number;
  isSeen(key: string): boolean;
  budget: PageLoadBudget;    // decremented per page load
  signal: AbortSignal;
}

export interface RawItem {
  type: 'post' | 'comment';
  itemKey: string;           // normalized stable ID (see §8)
  parentKey?: string;        // for comments
  url: string;
  authorName: string;
  text: string;
  postedAt: Date;
  reactionCount?: number;
  commentCount?: number;
  isPinned?: boolean;
  elementHandle?: unknown;   // adapter-internal locator for screenshots
}
```

---

## 6. Facebook Collection

### 6.1 Session
- **Connect flow:** dashboard button "Connect Facebook" launches a **visible** Playwright window on a dedicated persistent profile (`data/browser-profile/`). The user logs in manually (incl. 2FA). Session is saved.
- **All scans run headless** with that profile.
- **Health check before every run:** detect login wall or checkpoint. On failure → abort run, set `session_status = 'needs_reconnect'`, pause all Facebook jobs for `checkpoint_pause_hours` (default 12–24), raise alert in dashboard and via MCP `get_status`.

### 6.2 Group mode (primary)
1. Open the group feed sorted **chronologically ("New posts")**, not "Most relevant".
2. Scroll newest → oldest, extracting posts.
3. **Skip pinned/featured posts** — never let them trigger the cutoff.
4. For each post: parse timestamp → run matcher → decide on comment expansion (§7.4).
5. **Stop the target** when any condition hits first:
   - post older than `cutoffTime` or older than `watermark - overlap_minutes`
   - `stop_after_consecutive_seen` (default 3) already-seen posts in a row
   - `max_posts` or `max_scrolls` reached
   - page-load budget exhausted

### 6.3 Page mode
Same as group mode, using the page's posts feed.

### 6.4 Discovery mode (weekly)
Run Facebook's general post search (with "Recent" filter) for each keyword to **discover new groups/pages** discussing the brand. Discovered sources are added with `status = 'candidate'` and evaluated by the scheduler's exploration logic (§7.2). Matching posts found during discovery are captured normally.

### 6.5 Extraction rules
- Facebook CSS class names are obfuscated and unstable → **extract via visible text, ARIA roles (`role="article"`), and link patterns**, never class names.
- Expand "See more" before reading post text.
- Switch comments to "All comments" when expanding.
- Convert relative timestamps ("3h", "Yesterday", "2 d") to absolute using run time; when precision matters, read the exact time from the timestamp tooltip or permalink.
- Dismiss login/cookie/notification overlays before any screenshot.

---

## 7. Search & Scheduling Algorithm

### 7.1 Adaptive revisit interval (per target)
```
activity      = EMA(new_posts / hours_since_last_scan, alpha = 0.3)
next_interval = clamp(target_posts_per_visit / activity, min_interval, max_interval)
next_due      = now + next_interval ± jitter
```
Defaults: `target_posts_per_visit = 20`, `min_interval = 1h`, `max_interval = 24h`, `jitter = ±25 min`.

### 7.2 Yield scoring with exploration (UCB)
```
hit_rate = EMA(keyword_matches / page_loads, alpha = 0.3)
score    = hit_rate + c * sqrt( ln(total_scans) / target_scans )
```
Default `c = 0.5`. New/candidate targets start with an optimistic `hit_rate` so they get trialled.

- **Promote** a candidate to `active` after ≥ 5 scans with `hit_rate` ≥ `promote_threshold`.
- **Retire** a target to `dormant` after ≥ 10 scans with zero matches; re-check dormant targets once per `dormant_recheck_days` (default 14).
- `priority: "high"` targets bypass scoring and are scanned on every eligible run.

### 7.3 Run selection
1. Respect **active hours** (default 08:00–23:00 in account timezone). No runs outside.
2. Pop all targets with `next_due <= now` from the priority queue.
3. Sort by `score` (high-priority first); scan until **run page budget** or **daily page budget** is exhausted.
4. Unscanned due targets roll to the next run.
5. After each scan update `activity`, `hit_rate`, `watermark`, `last_scanned_at`, `next_due`.

### 7.4 Selective comment expansion
Expand comments only if **any** of:
- post text matches a keyword
- `commentCount >= comment_expand_min_count` (default 10)
- post contains a **secondary term** (configurable, e.g. `account`, `card`, `branch`, `ATM`, `app`)

Limit to `max_comment_expansions` "View more" clicks per post (default 3).

**Comment rescan schedule (decaying):** re-check comments on already-captured or high-comment posts at **2h, 6h, 24h, 48h** after the post time, then stop. Only new matching comments are captured.

### 7.5 Keyword matching (local, zero extra page loads)
- **Normalize:** lowercase, Unicode NFKC, strip diacritics, collapse whitespace, remove punctuation/`#`/`@` → `"XYZ Bank"`, `"xyzbank"`, `"#xyzbank"` all match.
- **Space-insensitive match:** compare keyword with spaces removed against text with spaces removed (with word-boundary checks to avoid substrings of unrelated words).
- **Fuzzy:** Damerau-Levenshtein distance ≤ 1 for keywords of length ≥ 6.
- **Variants:** per-keyword alias list (other scripts, transliterations, abbreviations).
- **Negative keywords:** if present in the same item, discard the match.
- Record `matched_keyword` and `matched_variant` on every capture.

---

## 8. Uniqueness / Deduplication

### 8.1 Stable item keys
- **Post:** extract post ID from the permalink (handle `/posts/<id>`, `/permalink/<id>`, `story_fbid`, `pfbid…` forms); strip all query params. Key = `fb:post:<id>`.
- **Comment:** `fb:comment:<post_id>:<comment_id>` from the comment link's `comment_id`.
- **Fallback:** `sha256(author_name + normalized_text + posted_at_minute)`.

### 8.2 Enforcement (three layers)
1. **Pre-capture check:** look up `item_key` in `seen_items` **before** screenshotting. Skip if present.
2. **DB constraint:** `item_key` is the primary key — duplicates within a run are impossible.
3. **Portal:** unique constraint on `item_key`; ingest endpoint treats known keys as no-ops (§10).

### 8.3 Edits
Store `text_hash`. If a seen item's text changes and `track_edits = true`, enqueue an **update** for the existing key (not a new record). Default `track_edits = false`.

---

## 9. Capture Output

### 9.1 Screenshots
- `locator.screenshot()` on the **post container** and separately on **each matching comment**.
- Fixed viewport width `1280`, `deviceScaleFactor: 2`, wait for images to load.
- Compress with `sharp` to WebP (or JPEG) quality 80, target 150–400 KB.

### 9.2 Folder layout
```
data/captures/<YYYY-MM-DD>/<keyword>/<post-key>/
  post.webp
  comment_<comment-id>.webp
  meta.json
```

### 9.3 `meta.json`
```json
{
  "item_key": "fb:post:1234567890",
  "type": "post",
  "platform": "facebook",
  "source_type": "group",
  "source_name": "Example Group",
  "source_url": "https://facebook.com/groups/abc",
  "url": "https://facebook.com/groups/abc/posts/1234567890",
  "author_name": "Display Name",
  "text": "Full post text...",
  "posted_at": "2026-10-03T09:12:00+05:00",
  "captured_at": "2026-10-03T11:40:22+05:00",
  "reaction_count": 42,
  "comment_count": 17,
  "matched_keyword": "xyzbank",
  "matched_variant": "xyz bank",
  "matched_in": "post",
  "text_hash": "sha256...",
  "screenshot": "post.webp",
  "comments": [
    {
      "item_key": "fb:comment:1234567890:987654321",
      "author_name": "Commenter",
      "text": "Comment text...",
      "posted_at": "2026-10-03T10:01:00+05:00",
      "matched_keyword": "xyzbank",
      "screenshot": "comment_987654321.webp"
    }
  ]
}
```

---

## 10. Portal Sync

### 10.1 Behaviour
- **Separate worker** from fetching; a portal outage must never block collection.
- **Interval:** every `sync_interval_minutes` (default 20) **plus** an immediate trigger after each fetch run.
- **Batch:** `sync_batch_size` items (default 40), oldest first, request size ≤ ~15 MB.
- **Concurrency:** `sync_concurrency` (default 2).
- **Retries:** exponential backoff 1m → 5m → 15m → 60m; after `sync_max_attempts` (default 5) mark `failed` for manual review in dashboard.
- **Ack:** mark items `synced` only after per-item success from portal.
- **Idempotency:** send `item_key` as the idempotency key for every item.

### 10.2 Ingest contract (placeholder — replace with real portal API)
```
POST {PORTAL_BASE_URL}/api/ingest/social-captures
Authorization: Bearer {PORTAL_API_KEY}
Content-Type: multipart/form-data

parts:
  manifest: JSON array of meta.json objects (posts with nested comments, or flat items)
  files:    screenshot files, named "<item_key>.webp"

response 200:
{
  "results": [
    { "item_key": "fb:post:123", "status": "created" },
    { "item_key": "fb:comment:123:456", "status": "duplicate" },
    { "item_key": "fb:post:789", "status": "error", "error": "..." }
  ]
}
```
`created` and `duplicate` → mark `synced`. `error` → retry per policy.

> **TODO (owner):** confirm endpoint, auth, payload shape (multipart vs JSON + pre-signed uploads), and whether comments are nested or flat.

### 10.3 Retention
- Delete local screenshot files `local_retention_days` (default 10) after successful sync.
- Keep `seen_items` rows for ≥ `seen_retention_days` (default 120). They are tiny and are what guarantees uniqueness.

---

## 11. Data Model (SQLite)

```sql
CREATE TABLE targets (
  id              INTEGER PRIMARY KEY,
  platform        TEXT NOT NULL,            -- facebook | reddit
  kind            TEXT NOT NULL,            -- group | page | subreddit
  url             TEXT NOT NULL UNIQUE,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active | candidate | dormant | disabled
  priority        TEXT NOT NULL DEFAULT 'normal', -- high | normal
  cutoff_hours    INTEGER,                  -- override; NULL = default
  max_posts       INTEGER,
  activity_ema    REAL DEFAULT 0,
  hit_rate_ema    REAL DEFAULT 0.2,         -- optimistic start
  scans           INTEGER DEFAULT 0,
  watermark       TEXT,                     -- newest post time seen
  last_scanned_at TEXT,
  next_due_at     TEXT
);

CREATE TABLE keywords (
  id        INTEGER PRIMARY KEY,
  keyword   TEXT NOT NULL UNIQUE,
  variants  TEXT DEFAULT '[]',              -- JSON array
  negatives TEXT DEFAULT '[]',              -- JSON array
  enabled   INTEGER DEFAULT 1
);

CREATE TABLE seen_items (
  item_key     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,               -- post | comment
  parent_key   TEXT,
  target_id    INTEGER,
  text_hash    TEXT,
  posted_at    TEXT,
  first_seen   TEXT NOT NULL,
  is_match     INTEGER NOT NULL,            -- 1 if captured, 0 if seen but not matching
  capture_path TEXT,
  sync_status  TEXT,                        -- pending | synced | failed | NULL (non-match)
  sync_attempts INTEGER DEFAULT 0,
  next_sync_at TEXT,
  last_error   TEXT
);
CREATE INDEX idx_seen_sync ON seen_items(sync_status, next_sync_at);

CREATE TABLE comment_rescans (
  post_key   TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  done       INTEGER DEFAULT 0,
  PRIMARY KEY (post_key, due_at)
);

CREATE TABLE runs (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,            -- fetch | sync | discovery
  started_at      TEXT, finished_at TEXT,
  page_loads      INTEGER, posts_scanned INTEGER,
  new_captures    INTEGER, duplicates_skipped INTEGER,
  errors          INTEGER, notes TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
);
```

Track daily page loads by summing `runs.page_loads` for the current local day.

---

## 12. Configuration (defaults)

```json
{
  "mode": "groups_and_pages",
  "timezone": "Asia/Karachi",
  "active_hours": { "start": "08:00", "end": "23:00" },

  "fetch": {
    "cutoff_hours": 24,
    "max_posts": 30,
    "max_scrolls": 8,
    "use_watermark": true,
    "overlap_minutes": 30,
    "stop_after_consecutive_seen": 3,
    "run_page_budget": 40,
    "daily_page_budget": 180,
    "page_delay_ms": [3000, 8000],
    "scroll_delay_ms": [1000, 3000],
    "page_timeout_ms": 30000,
    "run_timeout_minutes": 25,
    "checkpoint_pause_hours": 18
  },

  "scheduler": {
    "target_posts_per_visit": 20,
    "min_interval_hours": 1,
    "max_interval_hours": 24,
    "jitter_minutes": 25,
    "ucb_c": 0.5,
    "ema_alpha": 0.3,
    "promote_threshold": 0.05,
    "retire_after_zero_scans": 10,
    "dormant_recheck_days": 14
  },

  "comments": {
    "expand_min_count": 10,
    "max_expansions": 3,
    "secondary_terms": ["account", "card", "branch", "atm", "app"],
    "rescan_offsets_hours": [2, 6, 24, 48]
  },

  "matching": {
    "fuzzy_max_distance": 1,
    "fuzzy_min_length": 6
  },

  "discovery": { "enabled": true, "interval_days": 7 },

  "capture": {
    "viewport_width": 1280,
    "device_scale_factor": 2,
    "format": "webp",
    "quality": 80
  },

  "sync": {
    "portal_base_url": "",
    "interval_minutes": 20,
    "batch_size": 40,
    "concurrency": 2,
    "max_attempts": 5,
    "backoff_minutes": [1, 5, 15, 60]
  },

  "retention": {
    "local_retention_days": 10,
    "seen_retention_days": 120
  },

  "track_edits": false
}
```

Secrets (`PORTAL_API_KEY`) live in `.env` / OS keychain, **never** in the settings table or logs.

---

## 13. Interfaces

### 13.1 MCP tools (local server, stdio)
| Tool | Purpose |
|---|---|
| `get_status` | Session health, last runs, queue size, pending sync count, alerts |
| `run_scan` | Trigger an ad-hoc fetch run (optional `target_ids`, respects budgets) |
| `run_sync` | Trigger an immediate sync |
| `list_targets` / `add_target` / `update_target` / `remove_target` | Manage groups/pages (URL, priority, cutoff overrides) |
| `list_keywords` / `add_keyword` / `update_keyword` / `remove_keyword` | Manage keywords, variants, negatives |
| `get_config` / `update_config` | Read / patch settings (zod-validated) |
| `get_captures` | Query captures by date range, keyword, target, sync status |
| `get_run_report` | Stats for a run or a date range |

All mutating tools validate input and return the updated object.

### 13.2 Plugin

**`.claude-plugin/plugin.json`**
```json
{
  "name": "social-listener",
  "version": "0.1.0",
  "description": "Monitor Facebook groups/pages (and more) for brand keywords, capture matches, and sync to the portal."
}
```

**`.mcp.json`** (local server)
```json
{
  "mcpServers": {
    "social-listener": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../service/dist/mcp-entry.js"]
    }
  }
}
```
> Adjust path/launch strategy so the MCP entry connects to the already-running local service (e.g. via local HTTP) rather than starting a second scheduler.

**Skills**
- `social-listening` — how to interpret captures, summarize mentions by target/keyword/time, flag spikes.
- `manage-config` — how to safely change keywords, targets, cutoffs; always confirm destructive changes.

**Commands**
- `/scan` — run an ad-hoc scan and report results.
- `/add-keyword <keyword> [variants]`
- `/add-group <url> [priority] [cutoff_hours]`
- `/status` — health, last run stats, alerts.
- `/settings` — show current config and link to dashboard.

**Sub-agent**
- `capture-reviewer` — reviews a day's captures and produces a digest (counts, top threads, notable posts).

### 13.3 Settings dashboard (`http://localhost:<port>`)
Bind to `127.0.0.1` only. Protect with a local password or token.

Pages:
1. **Overview** — session status, today's page loads vs budget, captures today, pending/failed sync, alerts.
2. **Keywords** — CRUD with variants and negative keywords.
3. **Targets** — CRUD; status (active/candidate/dormant), priority, per-target cutoff/max posts, live stats (activity, hit rate, next due).
4. **Settings** — all §12 values with validation and "reset to default".
5. **Captures** — browse/filter captures with screenshot preview; retry failed syncs.
6. **Runs & Logs** — run history with stats and errors.
7. **Connect Facebook** — launch login window; show session health.

Dashboard and MCP tools read/write the **same** SQLite settings — single source of truth.

---

## 14. Safety, Compliance & Privacy

- **Read-only.** No posting, reacting, commenting, joining, or messaging.
- **Single account:** the user's own. **No** fake/multiple accounts, proxies, fingerprint spoofing, or anti-detection plugins.
- **Human pacing:** randomized delays, one tab, no parallel targets, active-hours only, daily page budget enforced in code (hard stop).
- **Stop on challenge:** any checkpoint/login wall → stop immediately, pause, alert. Never auto-retry login.
- **Terms awareness:** automated access may conflict with Meta's terms; the user must acknowledge account risk in the dashboard before connecting.
- **Personal data:** captures include private individuals' names and photos. Support configurable retention, restrict dashboard to localhost, and add an optional **blur-avatars** setting for screenshots. Portal-side access control and retention are the owner's responsibility.

---

## 15. Monitoring & Alerts

Log per run: page loads, posts scanned, new posts/comments captured, duplicates skipped, errors, duration.

Alerts (dashboard banner + `get_status`):
- **Session needs reconnect** (checkpoint / logged out).
- **Zero new items for ≥ 3 consecutive runs on active targets** → likely Facebook layout change; extraction needs fixing.
- **Sync failures** above threshold or items in `failed`.
- **Daily budget exhausted early** (consider fewer targets or lower frequency).

---

## 16. Build Phases & Acceptance Criteria

### Phase 1 — Core collector (Facebook groups)
- Persistent-profile login flow + health check.
- Group feed scan (chronological), pinned-post skipping, timestamp parsing, cutoff/watermark/consecutive-seen stopping.
- Matcher (normalize, variants, fuzzy, negatives).
- Element screenshots + meta.json + folder layout.
- SQLite schema + dedup (§8).
- **Accept:** scanning 3 test groups twice in a row produces captures only on the first run unless new matching posts appear; no duplicate `item_key` ever written.

### Phase 2 — Sync + scheduling
- Outbox sync worker with batching, retries, idempotency, retention.
- Adaptive scheduler (§7.1–7.3), budgets, active hours, jitter.
- Selective comment expansion + decaying comment rescans.
- **Accept:** killing the portal mid-sync and restarting yields zero duplicates and zero lost items; daily page budget is never exceeded.

### Phase 3 — Interfaces
- Settings dashboard (all pages in §13.3).
- MCP server + Cowork plugin (skills, commands, sub-agent).
- Pages adapter + discovery mode with candidate promotion/retirement.
- **Accept:** every setting changeable from both dashboard and Claude, reflected immediately in the next run.

### Phase 4 — More sources
- `RedditAdapter` using the official Reddit API (OAuth; keyword search by subreddit and site-wide; respect API terms — commercial use needs Reddit's agreement).
- Adapter registry so additional platforms are drop-in.

---

## 17. Testing

- **Unit:** matcher (normalization, fuzzy, negatives), timestamp parser, item-key normalization (all FB URL variants), scheduler math (EMA, UCB, interval clamping), sync retry state machine.
- **Fixture tests:** saved HTML snapshots of group feeds/posts/comments to test extraction offline (no live Facebook in CI).
- **Integration:** mock portal server verifying batching, partial failures, idempotency.
- **Manual live test checklist:** login, 1 low-volume group, verify screenshots legible, verify stop conditions and budgets.

---

## 18. Open Questions for the Owner

1. Portal ingest API: endpoint, auth, payload format, nested vs flat comments?
2. Initial keyword list with variants (other scripts, transliterations) and negatives?
3. Initial groups/pages with priorities?
4. Account timezone and active hours?
5. Should screenshots blur avatars/names by default?
6. Track edits to already-captured posts (`track_edits`)?
