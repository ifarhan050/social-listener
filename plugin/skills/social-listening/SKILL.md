---
name: social-listening
description: Interpret and summarize brand mentions captured by the local social-listener service (Facebook groups/pages, news, RSS feeds, YouTube and Reddit). Use when the user asks what people are saying about their brand, wants a summary or digest of mentions, asks about spikes, top threads, or notable posts, or asks for capture/run statistics.
---

# Social listening: interpreting captures

The `social-listener` MCP tools talk to a local background service that scans configured Facebook groups for brand keywords and saves each match as a screenshot plus `meta.json`. You read its results; you never browse Facebook yourself.

## Missions

Captures belong to **missions** (the user's goals: complaints, leads, competitors, topics). `meta.json` has a `missions` list. For "what did we find for X?", use `get_mission_items` for that mission; for a full report, use `/report <mission>` (`missions` skill).

## Getting data

1. Call `get_status` first. If it reports the service isn't running, a session that needs a reconnect, or alerts, tell the user before anything else.
2. Call `get_captures` with a date range (ISO `from`/`to`). Optionally filter by `keyword` or `target_id`. Each row has the `meta` of its post: author, text, `posted_at`, `matched_keyword`, `matched_variant`, `matched_in` (`post` or `comment`), reaction and comment counts, and the matching `comments[]`.
3. Call `get_run_report` for collection stats (page loads, posts scanned, new captures, duplicates skipped, errors).

## Summarizing

- Group mentions by **target (group)**, **keyword**, and **time** (by hour or day).
- Show volume first, then themes: complaints (app down, card blocked, fees, branch service), praise, questions, and comparisons with competitors.
- Name the **top threads** by `comment_count` + `reaction_count`. Quote short excerpts (≤ 1–2 sentences) and attribute them as "a group member" unless the user asks for names.
- **Flag spikes**: a day or hour with clearly more captures than the recent baseline, or many posts in one thread on the same theme (for example an outage).
- Note when a capture's `posted_at_approx` is true; that timestamp is only the scan time.
- `platform` can also be `news` (a news article; `source_name` is the publisher, `author_name` the publisher or byline), `rss` (an item from a custom feed), or `youtube` (a video, or a comment on it; `source_name` is the channel). These sources have no screenshots.
- `platform` is `facebook` or `reddit` for social posts. Reddit captures have no screenshots (`screenshot: null`), and their `source_name` is the subreddit (`r/<name>`). On Reddit, `reaction_count` is the post score. When you summarize, break mentions down by platform as well.
- `found_via: "search"` means keyword search found the post. `source_type`/`source_name` then name the group it was posted in when known, and are `search` otherwise. `found_via: "feed"` means it came from scanning a monitored group or page.
- Sentiment and semantic analysis are done by the portal. Give a qualitative read, not scores.

## Caveats to state when relevant

- Coverage is limited to configured groups, the cutoff window, and the page budgets. A quiet result doesn't prove nobody mentioned the brand.
- An alert saying "No new posts seen for N consecutive runs" usually means Facebook changed its layout and extraction needs fixing. It doesn't mean zero mentions.
- Captures contain private individuals' names and words. Don't spread them further than the user needs.
