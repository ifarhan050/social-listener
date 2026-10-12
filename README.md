# Social Listener

A general-purpose listening agent for **Claude Cowork**. You tell it what to find, and it watches Facebook groups and pages, news, RSS feeds, YouTube and Reddit for matching posts and comments. Claude reviews what it collects against your goal and writes reports. Examples of goals:
- complaints and scams about a brand;
- people asking for what you offer, like "need a home tutor in Lahore";
- similar businesses and competitors;
- a topic you want to follow.

Everything runs locally on your computer and is read-only. The original specification is in [docs/social-listening-agent-spec.md](docs/social-listening-agent-spec.md).

## Quick start (plug and play)

**For users: no terminal, no admin rights, nothing to install by hand.**

1. **Download** `Social-Listener-Setup.zip` from the [latest release](https://github.com/ifarhan050/social-listener/releases/latest) and unzip it.
2. **Install the helper app:**
   - **Windows:** double-click `Install on Windows.cmd`. If you see "Windows protected your PC", click *More info* → *Run anyway*.
   - **Mac:** right-click `Install on Mac.command` → *Open*. If macOS blocks it, go to System Settings → Privacy & Security → *Open Anyway*.

   It sets up everything it needs: it downloads its own private copy of Node.js if you don't have one, and installs nothing system-wide. It also starts automatically when you log in, and opens the dashboard when it's done.
3. **Add the plugin to Claude:** Customize → Plugins → upload `social-listener-plugin.zip` (it's in the same folder). Then **quit Claude completely and reopen it**.
4. **In a Cowork chat, type `/setup`.** Claude:
   - asks what you want to find;
   - creates a **mission**;
   - logs you in to Facebook once, if you want Facebook (a Chrome window opens: log in, then close it; the login is kept);
   - runs a first search.
5. **Type `/start` any time** to see what you can ask, with [sample prompts](prompts/getting-started.md) filled in for your missions.

Everything after that happens in chat:
- "Find 20 negative posts about [brand] from last month"
- "Export my last search as a CSV"
- "Is everything working?"
- "Update the agent"

**API keys** for YouTube or Reddit are optional. Say "open the agent's dashboard" and paste them in its **API keys** box. They're saved on your computer only and take effect immediately.

**Uninstall:** double-click `Uninstall on Windows.cmd` / `Uninstall on Mac.command` in the setup folder (on Windows also Start menu → Social Listener → Uninstall). It asks before deleting your saved results and Facebook login.

Prefer a single line? On Windows PowerShell: `irm https://raw.githubusercontent.com/ifarhan050/social-listener/main/install/install.ps1 | iex`. On a Mac Terminal: `curl -fsSL https://raw.githubusercontent.com/ifarhan050/social-listener/main/install/install.sh | bash`.

**Maintainers:** see [scripts/release.md](scripts/release.md) for building and publishing a release. The repo the installers download from is `socialListener.repo` in the root `package.json`.

## Missions

A **mission** is one goal. Each install can run several at once, sharing the browser, the database and the Facebook safety limits.

| Template | Finds | Claude keeps | Report |
|---|---|---|---|
| `complaints` | negative talk about a brand | complaints, scams, outages, refunds (no promos or own pages) | top N most negative, with evidence |
| `leads` | people **asking for** what you offer | real requests in your area (not providers advertising) | open leads, newest first, hot/warm/cold |
| `businesses` | others **offering** the same service | competitors and partners (not customers asking) | list of providers plus a market overview |
| `topic` | anything about a subject | substantive discussion | themes, sentiment, notable posts |
| `custom` | your own description | your rules | your format |

**How a mission works:**
- **Search phrases** are what gets typed into Facebook, news, YouTube and Reddit search.
- **Match rules** are a cheap, broad prefilter on every post the agent reads:
  - `any`: one of these terms must appear;
  - `all_of`: one term from each group must appear, e.g. `[[tutor, tuition], [need, looking for, chahiye]]`;
  - `none`: any of these terms rules the post out.
- **Claude decides.** During review it judges each item **per mission** against that mission's goal and keep/exclude rules. One post can be a lead for one mission and irrelevant to another.
- **Reports:** `/report <mission>` writes `<mission>-report.md` in the template's format.

| Command | What it does |
|---|---|
| `/setup` | First-time wizard: install if needed, create your first mission |
| `/new-mission` | Add another goal |
| `/missions` | List, pause, edit, duplicate, delete missions |
| `/report <mission> [days]` | Write that mission's report |

An install upgraded from the brand-only version keeps its keywords as mission #1, "Brand complaints & scams". Nothing is lost.

## Layout

```
service/      Long-running local service (TypeScript): scheduler, Playwright collector, SQLite, HTTP API
plugin-mcp/   Source for the thin stdio MCP proxy
plugin/       Installable Cowork / Claude Code plugin (skills, commands, bundled MCP proxy)
docs/         Specification
```

```
Cowork ──stdio──► plugin/server/mcp-proxy.js ──HTTP 127.0.0.1 + token──► service
                                                                          ├─ scheduler loop / runner
                                                                          ├─ FacebookGroupAdapter (Playwright, own profile)
                                                                          ├─ matcher → capturer (WebP + meta.json)
                                                                          └─ SQLite (targets, keywords, seen_items, runs, settings)
```

The service owns the browser, the scheduler, and the database. The MCP server is only a proxy, so opening Cowork never starts a second scheduler. On boot the service writes `~/.social-listener/connection.json` (`{url, token}`), and the proxy reads it to find the service.

## Developer setup (from source)

Requires Node 20+ (tested on Node 24, Windows).

```bash
npm install
```

```bash
npx -w service playwright install chromium
```

```bash
npm run build:plugin
```

## Developer: run from source

1. **Start the service.** Keep it running in the background:
   ```bash
   npm run start
   ```
   It prints a dashboard link like `http://127.0.0.1:4737/#token=…`. The token sits in the URL fragment, so it's never sent to the server or written to logs.
2. **Acknowledge the account risk** on the dashboard. Automated access may conflict with Meta's Terms, and scanning stays disabled until you accept.
3. **Connect Facebook.** Click **Connect Facebook** on the dashboard, or run `npm run connect`. Your installed **Chrome** opens as a normal browser, with no automation attached, on a dedicated profile (`service/data/browser-profile-chrome/`). Log in yourself, including 2FA, then **close that window**. The service then checks the session in the background, and scans reuse that profile. You can choose the browser with `browser.channel`: `chrome` (the default), `msedge`, or `chromium`. `chromium` uses Playwright's bundled browser and an automated login window, which Facebook tends to answer with repeated CAPTCHAs.
   > Set your Facebook display language to **English (US)**. Phase 1 extraction reads English UI labels such as "See more", "3h", and "12 comments".
4. **Add keywords, and optionally groups or pages**, from Claude (`/add-keyword`, `/add-group <group or page url>`) or through the API. On first boot a placeholder keyword `xyzbank` is seeded; replace it.
   - **No groups or pages yet?** The service searches Facebook posts for each enabled keyword, with the "Recent" filter on. Each keyword gets an automatically managed `search` target with its own schedule. Set `search.mode` to `when_no_targets` (default), `always`, or `off`.
   - **Pages:** use `facebook.com/<page-name>`, `profile.php?id=<n>`, or `pages/<name>/<id>`. Page timelines are scanned newest-first, the same way groups are.
   - **Search hits:** these record the group they were posted in (`source_name`, `source_url`) and `found_via: "search"`. Search results aren't strictly chronological, so old results are skipped. A search stops after `search.stop_after_consecutive_old` too-old results in a row.
5. Scans run automatically when targets are due and within active hours. Run `/scan` from Claude for an ad-hoc run.

## Sources

| Source | How it's read | Account or key | Restriction risk |
|---|---|---|---|
| Facebook groups, pages, keyword search | Playwright, using **your** logged-in Chrome profile | your Facebook login | **yes**: capped, paced, active hours, auto-pause |
| News search (per keyword) | Google News RSS + Bing News RSS | none | none |
| RSS/Atom feeds (forums, blogs, news sections) | the feed itself | none | none |
| YouTube (keyword search + channels, with comments) | official YouTube Data API v3 | `YOUTUBE_API_KEY` (free, about 10,000 units a day) | none |
| Reddit (keyword search + subreddits) | official Reddit Data API | `REDDIT_CLIENT_ID` / `SECRET` (needs Reddit's approval) | none |

**Turning platforms on and off:** each platform has one switch.
- **In Cowork:** `/platforms` shows them; `/platforms facebook off` or `/platforms youtube on` changes one.
- **On the dashboard:** use the **Platforms** checkboxes.
- **In settings:** `"platforms": {"facebook": true, "news": true, "rss": true, "youtube": true, "reddit": true}`.

Switching a platform off keeps its targets, captures and review history, and scanning resumes when you switch it back on. YouTube and Reddit also need their API keys before they can run.

Keyword searches are created automatically for every enabled keyword on each configured source. Add groups, pages, subreddits, YouTube channels, or feeds with `/add-group <url>`.

**YouTube setup:**
1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable **YouTube Data API v3**.
3. Create an **API key**, restricted to that API.
4. Set `YOUTUBE_API_KEY=` in `service/.env` and restart the service.

A keyword search costs 100 units, so the default cap (`youtube.daily_quota_units` = 8000) covers about 70 searches a day.

## Account safety

These features were inspired by [Agent Reach](https://github.com/Panniantong/agent-reach), but built the conservative way.

**What we do:**
- Facebook is only one of several sources. News, RSS, and YouTube need no social login, so wide coverage costs no account risk.
- **Facebook-only active hours:** scans run in a waking window (default 08:00–23:00). Other sources run around the clock.
- **Hard page budgets** per run and per day, with randomized human-like delays, one tab, and read-only clicks.
- **Facebook search is capped:** only the first `search.max_keywords` keywords (default 5) get one, at most every `search.min_interval_hours` (default 12 h).
- **Automatic stop:**
  - a checkpoint or login wall pauses Facebook and asks you to reconnect;
  - a **soft block** ("You're temporarily blocked", "going too fast") is detected after every scroll and pauses Facebook for 48 h;
  - other sources keep running either way.
- **`/doctor`** (or `npm run doctor`) flags risky settings, each with a fix.

**What we deliberately don't do:** no exported cookies handed to third-party tools, no secondary or "small" accounts, no proxies, no hiding of automation, and no switching to another scraper when a platform blocks us. Each of these makes a restriction more likely, not less.

## Manual runs with /find

Runs are **manual by default**. Ask for what you want in Cowork:

```
/find 20 negative faysal bank last month
/find 10 scam posts in https://www.facebook.com/groups/123456 this year
/find 15 leads tuition last 7 days
/find 5 complaints from 2026-03-01 to 2026-03-31 facebook only
```

- **How many** and **which types:** negative/complaint, scam, promotional, lead, business, question, positive, neutral, or your own word.
- **Where:**
  - give Facebook group or page URLs (or target ids) and only those are read: in-group search for each phrase, and the group feed when the search finds nothing;
  - give none for a **general search**: news, RSS, YouTube and Reddit first (no account risk), then Facebook post search.
- **When:**
  - presets: `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_90_days`, `this_month`, `last_month`, `this_year`, `last_year`;
  - or a from/to date range.
- **Facebook depth:**
  - groups are read back at most `find.facebook_max_days` (90);
  - older ranges use Facebook's year filter (best-effort);
  - news (`after:`/`before:`) and YouTube (`publishedBefore`) honour any range.

The service collects candidates in batches (`find.batch_size`, with up to `find.max_comments_per_post` comments each). Claude labels each one, and the service keeps going until it has the number you asked for, the sources run out, or the page budget is reached. If the budget runs out, the job ends `partial`; resume it later with `/find continue <job id>`.

Kept items are saved to captures as **kept** for the mission, so `/report` includes them. Claude also writes `find-<mission>-<types>-<range>.md` and gives you a summary in chat.

**CSV export:** Claude also saves `find-<mission>-<types>-<range>.csv` (one row per post plus one row per comment, linked by `parent_item_key`; UTF-8 with a BOM, so Excel shows Urdu correctly). The service keeps a copy in `data/exports/`. Export an earlier job with `/find export <job id>` (add `labelled` to include rejected items), or download it from `GET /api/find/<id>/export?format=csv`.

`/scan` still runs one normal collection pass over whatever is due.

## Scheduled runs are off by default

The service never scans on its own, and **scheduled runs are off** (`scheduler.scheduled_runs: false`). A `/scheduled-run` task that still fires is refused: it replies with one line and doesn't scan.

To turn automatic runs on:
1. Set `scheduler.scheduled_runs` to `true` (via `/settings`, or `update_config`).
2. Create the tasks in Cowork: **Scheduled → New task → Set up manually**. Set the folder to where reports should be saved.

| Task | Prompt | Suggested frequency |
|---|---|---|
| Collect and review | `/scheduled-run` | Hourly |
| Negative-mentions report | `/negative-report 30` | Weekly (or on demand) |

A scheduled run only scans targets that are **due**: per-platform intervals, the Facebook search cap (12 h), active hours, page budgets and pauses all still apply. These tasks use this computer's local service, so they run **only while the computer is awake and the Claude app is open** (see [scheduled tasks in Cowork](https://support.claude.com/en/articles/13854387/schedule-recurring-tasks-in-claude-cowork)). The plugin starts the service in the background whenever a task needs it; opt out with `SOCIAL_LISTENER_AUTOSTART=0`.

### Comments on your own page
On your brand's own page (or an ombudsman page), complaints usually sit in comments that don't name the brand. Set `comments_mode: "all"` on that target with `update_target`. Every comment on its posts then goes to review, even without your search terms.

### Scan window and dates
- **First scan:** a new target is first read back `fetch.first_scan_lookback_hours` (168 = 7 days); after that, `fetch.cutoff_hours` (24).
- **Run time:** a run stops after `fetch.run_timeout_minutes` (45).
- **Facebook dates:** they come from the timestamp tooltip, which the service reads by hovering the timestamp link, as a person would.
- **Doctor checks:**
  - if most dates in the last scan were approximate, `/doctor` warns you. Run `debug_facebook_snapshot` and share the saved file (`data/debug/`) so the selectors can be fixed;
  - `/doctor` also lists low-yield targets (scanned more than 5 times with no match).

## Facebook negative-mentions report

`/negative-report [days]` produces a top-5 report of the most negative recent brand mentions in your monitored Facebook groups and saves it as **`facebook-negative-mentions.md`** in the working folder. It's built on the service's own read-only, human-paced browser, not OpenCLI.

1. **Pre-flight:** `doctor` and `get_status` must show Facebook ready; otherwise the report stops and says why.
2. **Collect:** the service searches inside each group for each keyword, then for each matching post from the last N days it collects **all** comments. Groups are visited in random order, with breaks between them. If a group search shows nothing, that group's feed is read instead.
3. **Resume:** the job stays within the page budgets. If a budget runs out it ends `partial`, and the next run resumes it.
4. **Classify and rank (Claude):** posts and comments are labelled; promotional posts and your own pages' posts are excluded (set `brand.own_pages`). Posts are ranked by negative comments weighted by severity.
5. **Output:** for each of the top 5, the group, date, author's first name, an excerpt, three short negative comments, negative vs total comments, and the link.

## Review: keep only negative, non-promotional mentions

Keyword matching casts a wide net. **Claude in Cowork** decides what's stored; the service never sends text to an AI service itself.

1. Every new capture goes into a **review queue** (`review_status: pending`) and isn't eligible for sync.
2. Run `/review` in Cowork. `/scan` also reviews automatically after a scan. Claude reads the queue with `get_review_queue`, labels each post and comment for **sentiment** and **promotional**, and submits the labels with `submit_reviews`, following the `review-captures` skill.
3. Only **negative and non-promotional** items are kept. A post that isn't kept stays as **context** when it has kept comments. That includes the brand's own promotional post, unless `review.keep_promo_post_as_context` is off.
4. Everything else has its screenshots deleted. Its database row keeps the label and reason, so it's never collected again and can be audited with `get_review_log`. Kept captures get a `review` block in `meta.json`.

To store every match again, set `review.enabled` to false. To review automatically, schedule `/review` as a recurring task in Cowork (for example hourly).

## Connecting Reddit

Reddit is read through its **official Data API** (app-only OAuth). The service reads public posts and comments only and never logs in as a user. Reddit captures are **text and metadata only**, with no screenshots.

**1. Get API credentials.** Since November 2025, Reddit no longer issues API keys on a self-service basis. New apps need Reddit's approval under its Responsible Builder Policy:
- **Already have a Reddit app from before then?** Its client ID and secret still work. Find them at <https://www.reddit.com/prefs/apps>.
- **Otherwise:** request access through Reddit Developer Support (linked from <https://www.reddit.com/prefs/apps> and r/redditdev). Describe the use case: read-only monitoring of public posts that mention your brand, low volume. Commercial use needs a separate agreement with Reddit. Approval can take days.

**2. Add the credentials to `service/.env`:**
```
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=windows:social-listener:0.1.0 (by /u/<your-reddit-username>)
```

**3. Save the keys** in the dashboard's **API keys** box (say "open the agent's dashboard" in Cowork). They take effect immediately. If you edited `service/.env` by hand instead, restart the service. `/status` should then show `reddit: ok` after the first run, and `platforms.reddit: "yes"`.

**4. Choose what to monitor:**
- **Site-wide keyword search** runs automatically for every enabled keyword, newest first. It's controlled by `reddit.search_mode`: `always` (default), `when_no_targets`, or `off`.
- **Subreddits:** add them with `/add-group https://www.reddit.com/r/<name>` (or just `r/<name>`). Each scan reads the subreddit's newest posts and its newest-comments stream, so mentions in comments on older threads are caught too.

**Limits:** each run makes at most `reddit.max_requests_per_run` API requests (60 by default), at least `reddit.min_request_interval_ms` apart, and the service honours Reddit's rate-limit headers. Reddit doesn't count toward the Facebook page budget. A Facebook checkpoint or pause only skips Facebook targets; Reddit keeps running.

## Using it from Claude Cowork / Claude Code

Install the `plugin/` folder as a plugin. For a local test in Claude Code:

```bash
claude --plugin-dir ./plugin
```

| Command | What it does |
|---|---|
| `/status` | Health, budget, last run, alerts |
| `/scan [ids]` | Ad-hoc scan, then a summary |
| `/add-keyword <kw> [variants]` | Add a keyword |
| `/add-group <url> [priority] [cutoff_hours]` | Add a group |
| `/settings` | Show settings and the dashboard link |
| `/platforms [name on|off]` | Show or switch source platforms on/off |
| `/setup` | First-time wizard: install if needed, create your first mission |
| `/new-mission`, `/missions`, `/report <mission>` | Add, manage and report on missions |
| `/scheduled-run` | One collection pass for a Cowork scheduled task |
| `/negative-report [days]` | Top-5 negative Facebook group mentions → facebook-negative-mentions.md |
| `/doctor [live]` | Health check and Facebook risk warnings, with fixes |
| `/review` | Keep only negative, non-promotional mentions |

Skills: `social-listening` (summarizing mentions, flagging spikes) and `manage-config` (safe edits, confirming destructive changes). MCP tools: `get_status`, `run_scan`, `list/add/update/remove_target`, `list/add/update/remove_keyword`, `get_config`, `update_config`, `get_captures`, `get_run_report`.

The service must be installed on the same computer. If it isn't running, the tools start it automatically; if it isn't installed, they say to type `/setup`, which installs it.

## Output

```
service/data/captures/<YYYY-MM-DD>/<keyword>/<post-id>/
  post.webp
  comment_<comment-id>.webp
  meta.json        # spec §9.3, plus posted_at_approx
```

## How uniqueness is guaranteed

1. **Stable keys.** `fb:post:<id>` comes from every permalink form (`/posts/`, `/permalink/`, `story_fbid`, `pfbid…`), with query parameters stripped. Comments use `fb:comment:<post>:<comment>`, including base64 `comment_id`s. A hash is the fallback when no ID can be found.
2. **Check before screenshot.** Each key is looked up in `seen_items` before anything is captured. A time-independent **content alias** (author + normalized text) is also checked, because Facebook can show the same post with a numeric ID on one load and a `pfbid` on another.
3. **Primary key.** `seen_items.item_key` is the primary key with a plain `INSERT`, so a duplicate can never be written.
4. Posts that don't match are also recorded as seen. That's what lets `stop_after_consecutive_seen` end a scan early.

## Safety (enforced in code)

- **Read-only.** Clicks go through an allowlist: "See more", comment counts, "View more comments", the comment sort control, and dismissing cookie or notification overlays. Like, Comment, Share, Join, Follow, Reply, and Send are refused even if a pattern would allow them.
- **One account, one tab.** Plain Chromium, with no stealth plugins, proxies, or fingerprint changes.
- **Hard limits.** Run and daily page budgets are hard stops. Scans only run within active hours, with randomized delays.
- **Checkpoints.** A login wall or checkpoint stops the run, sets `needs_reconnect`, pauses scanning for `checkpoint_pause_hours`, and raises an alert. Login is never retried automatically.
- **Local only.** The API binds to `127.0.0.1`, requires a bearer token, and rejects other `Host` headers (protection against DNS rebinding).

## Development

```bash
npm test
```

```bash
npm run typecheck
```

- **Unit tests:** matcher, item keys, timestamp parsing, timezone and active hours, config, budgets, and the click allowlist.
- **Fixture test** (`service/test/fixture-run.test.ts`): runs the real adapter, runner, capturer, and SQLite against a saved feed in `service/test/fixtures/group-feed.html` in headless Chromium. It covers pinned posts, the cutoff, "See more", comment dialogs, "All comments", and "View more". It then runs a second time to confirm zero new captures and zero duplicate keys.

## Known limitations (Phase 1)

- **Live Facebook markup is unverified.** Extraction uses ARIA roles, `dir="auto"` text blocks, and link patterns, as the spec requires, and passes against the fixture. Live Facebook markup changes often; run the manual checklist below, and expect selector tuning in `service/src/adapters/facebook/domScripts.ts`.
- **English UI only.**
- **Fixed revisit interval.** Targets are revisited every `fetch.default_interval_hours` with jitter. Adaptive EMA/UCB scheduling comes in Phase 2.
- **No portal sync yet.** Captures are marked `sync_status = 'pending'`.
- **Minimal dashboard.** It covers status, the risk acknowledgement, connecting, and scanning. The full dashboard comes in Phase 3.

### Manual live test checklist (spec §17)

1. Log in through `npm run connect`. `/status` then shows `session: ok`.
2. Add one low-volume group and a keyword that's common there.
3. Run `/scan` and check that the screenshots in `service/data/captures/…` are legible and that `meta.json` has the right author, text, and time.
4. Run `/scan` again. It should produce 0 new captures. Confirm no duplicates with `SELECT item_key, COUNT(*) FROM seen_items GROUP BY 1 HAVING COUNT(*) > 1`, which should return no rows.
5. Confirm `page loads today` never exceeds the daily budget.

## Roadmap

- **Phase 2:**
  - Sync worker (batching, retries, idempotency) against a mock portal that implements the spec §10.2 contract
  - Adaptive scheduler (EMA activity, UCB yield scoring)
  - Decaying comment rescans
  - Retention
- **Phase 3:** full dashboard, discovery that turns groups found by search into candidate targets, `capture-reviewer` sub-agent, blur-avatars.
- **Phase 4:** ~~Reddit~~ done (official API: keyword search + subreddits). Next: more platforms through the adapter registry.

## Open questions (spec §18)

Portal ingest API details, the real keyword list and its variants, initial groups and their priorities, timezone and active hours (currently the defaults Asia/Karachi, 08:00–23:00), avatar blurring, and `track_edits`.
