---
name: manage-config
description: Safely change the social-listener's keywords, monitored Facebook groups, cutoffs, budgets, active hours, and other settings via its MCP tools. Use when the user wants to add/remove/edit keywords, variants, negative keywords, groups/targets, or tune scanning behaviour.
---

# Managing social-listener configuration

All changes go through the `social-listener` MCP tools. They write to the same SQLite settings that the service and dashboard use, so changes apply from the next run.

## Rules

1. **Read before you write.** Call `list_keywords`, `list_targets`, or `get_config` first so you change the right item and can show before → after.
2. **Confirm destructive changes** before calling the tool: `remove_keyword`, `remove_target`, disabling a keyword or target, `update_config` that lowers budgets or narrows active hours, and replacing a `variants`/`negatives` list (arrays replace, they don't append). Say exactly what changes.
3. **Appending to lists:** to add a variant, read the current list, append to it, and send the full list.
4. After a change, report the updated object the tool returned.

## Keywords

- Matching ignores case, spaces, punctuation, `#`, and `@`, so `XYZ Bank`, `xyzbank`, and `#xyzbank` already match. Don't add those as variants.
- Keywords of 6+ characters also match with one typo (`xyzbnak`).
- Add **variants** for other scripts and transliterations (for example Urdu `ایکس وائی زیڈ بینک`) and for abbreviations.
- Add **negatives** for recurring false positives (for example `hiring`, `xyz bank jobs`). A negative found in the same post or comment discards the match.

## Targets (groups, pages, keyword search)

- `add_target` takes a public **group** URL (`facebook.com/groups/<id-or-slug>`) or a **page** URL (`facebook.com/<page-name>`, `profile.php?id=<n>`, `pages/<name>/<id>`). The kind is detected from the URL.
- **Keyword search:** the service keeps one `search` target per enabled keyword. These run Facebook's post search with the "Recent" filter. `search.mode` decides when they run:
  - `when_no_targets` (default): only while no group or page is active
  - `always`: alongside groups and pages
  - `off`: never

  Search targets follow the keyword list automatically and can't be removed. To pause one, disable it with `update_target` `status: "disabled"`.
- Each search costs one page load per keyword per run, so many keywords with `search.mode: "always"` use up the daily budget faster.

## Missions

What the agent looks for lives in **missions** (see the `missions` skill and `/missions`): each has search phrases, match rules, keep and exclude rules, sources and a report. Keywords (`add_keyword`) only feed the original keyword-based brand mission. For new goals, use `/new-mission`.

## Scheduling (Cowork drives scans)

- `scheduler.trigger` defaults to `cowork`: the service **never scans by itself**. Scans happen when Cowork calls `run_scan`, usually from a Cowork scheduled task running `/scheduled-run`. `service` turns the old built-in timer back on; only use it if the user asks.
- `run_scan` only scans targets that are **due**. Per-platform intervals, the Facebook search cap, active hours and budgets all still apply, so an hourly Cowork task is safe.
- If the service isn't running, the plugin starts it in the background on its own. Users can turn this off with `SOCIAL_LISTENER_AUTOSTART=0`.

## Brand and report settings

- `brand.own_pages`: the brand's own Facebook page names or URLs. Their posts are excluded from mentions and from the negative report. Ask the user for these if the report includes the brand's own posts.
- `report.days` (30), `report.max_posts_per_group` (15) and `report.max_comment_expansions` (5) control `/negative-report`.

## Human-like pacing (Facebook)

`fetch.human` sets reading time per post, pauses before clicks, wheel scrolling, idle pauses, and breaks between groups (20–60 s).
- Never lower these unless the user insists; doctor warns if they're below the defaults.
- This is pacing only. Never suggest disguising the browser, proxies, or extra accounts.

## Platforms on/off

- **Platforms:** `facebook`, `news`, `rss`, `youtube`, `reddit`. Each has one switch (the `platforms.<name>` setting).
- **See them:** `list_platforms`. **Change one:** `set_platform_enabled`, or the `/platforms` command.
- **Turning one off is non-destructive.** Targets, captures and review history stay, and scanning resumes when it's turned back on.
- **Confirm before** turning everything off, and before turning Facebook on. Facebook uses the user's account.
- **Finer controls:**
  - `search.mode` / `<platform>.search_mode` turn off only keyword search;
  - `update_target status: "disabled"` turns off a single target.

## Zero-account sources (no ban risk)

These sources need no social-media login, so prefer them for wide coverage:
- **News search** (`news.*`): Google News and Bing News RSS for every keyword. On by default; no key.
  - `news.region` sets the Google News edition (Pakistan by default).
  - `news.urdu_edition` also searches the Urdu edition for Urdu-script keyword variants.
  - `news.interval_hours` defaults to 1.
- **RSS/Atom feeds:** add any feed with `add_target`. `rss.interval_hours` defaults to 2.
- **YouTube** (`youtube.*`): the official API. It needs `YOUTUBE_API_KEY` in `.env`; you can't set it through the tools.
  - It searches each keyword's newest videos and their comments; channel targets read uploads and comments.
  - `youtube.daily_quota_units` (default 8000) is a hard cap. One keyword search costs 100 units.
  - `youtube.interval_hours` defaults to 6.

## Facebook account safety

- `active_hours` applies to **Facebook only**; other sources run 24/7. Keep it to a waking window (for example 08:00–23:00). Don't disable it.
- `search.max_queries` (default 5, counted across **all** missions) and `search.min_interval_hours` (default 12) limit Facebook keyword search, the most closely watched action. Missions' extra phrases are still searched on news, YouTube and Reddit.
- A soft block ("You're temporarily blocked", "going too fast") pauses Facebook for `fetch.soft_block_pause_hours` (48 h). A checkpoint or login wall pauses for `fetch.checkpoint_pause_hours` and needs a reconnect.
- Run `doctor` after changing Facebook settings. It flags risky values with fixes.
- Never suggest proxies, secondary accounts, cookie exports, or hiding automation.

## Reddit

- **Credentials** live only in the service's `.env` (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`). You can't set them through the tools. New Reddit API credentials need Reddit's approval (Responsible Builder Policy); the README explains how to request it. `get_status` shows `reddit.configured` and `reddit.status`.
- **Subreddits:** `add_target` with `https://www.reddit.com/r/<name>` or `r/<name>`. Each scan reads the subreddit's newest posts plus its newest comments.
- **Reddit keyword search:** one `search` target per keyword on platform `reddit`. `reddit.search_mode` decides when it runs:
  - `always` (default)
  - `when_no_targets`: only while no subreddit is active
  - `off`
- **Settings:**
  - `reddit.max_requests_per_run` (default 60) is a hard cap per run. Reddit allows about 100 requests a minute per app, so keep it modest.
  - `reddit.min_request_interval_ms` sets the spacing between requests.
  - `reddit.include_nsfw` (default false).
  - Turn Reddit off without removing credentials with `set_platform_enabled({platform: "reddit", enabled: false})`.
- Reddit doesn't use the Facebook page budget, and a Facebook pause doesn't stop Reddit.
- `priority: "high"` is for must-watch groups. `cutoff_hours` and `max_posts` override the global defaults for one group.
- To scan a group right away: `update_target` with `next_due_at: null`, then `run_scan` with `target_ids`.

## Settings guardrails

- `fetch.daily_page_budget` and `fetch.run_page_budget` are safety limits that protect the user's Facebook account. Don't raise them unless the user asks, and say that higher values increase the risk of account checkpoints.
- Never suggest proxies, multiple accounts, or anti-detection measures. They're out of scope by design.
- Secrets such as the portal API key are not settings. They live in the service's `.env`.
