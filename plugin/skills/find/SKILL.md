---
name: find
description: Manual search for a set number of posts of given types (negative, scam, promotional, lead, question...) in a date range, from specific Facebook groups or a general search, then save the matches to captures and a results file. Use when the user asks to find, pull or get N posts or comments of some kind, for a period like today, last week, last month, this year or between two dates, or runs /find.
---

# Find: N items of given types in a date range

The service collects **candidates** in batches; **you** decide which ones are the wanted types. Only use the social-listener MCP tools. Don't browse Facebook yourself or use any other browser tool. The service's browser is read-only and human-paced.

## 1. Understand the request
Extract these from the user's words or the command arguments:

| Field | How |
|---|---|
| `count` | The number they asked for. Default 10, max 200. |
| `types` | Their words mapped to short labels: complaints → `negative`; fraud → `scam`; ads → `promotional`; people asking to buy or hire → `lead`; companies offering services → `business`; also `question`, `positive`, `neutral`. Several are allowed. |
| mission | Call `list_missions`. Pick the one the request is about (brand or topic). If several fit, ask. If nothing fits, offer one-off `queries` (their phrases) with the closest mission, or `/new-mission`. |
| `groups` | Facebook group or page URLs, or target ids from `list_targets`, if they named any. Otherwise omit it: general search. |
| `platforms` | Only if they limited sources ("only Facebook", "news only"). |
| `when` | Use a `preset` (`today`, `yesterday`, `last_7_days`, `last_30_days`, `last_90_days`, `this_month`, `last_month`, `this_year`, `last_year`) or `from` / `to` as YYYY-MM-DD. "last week" → `last_7_days`; "last month" → `last_month`; "in March" → that month's from/to. Default `last_7_days`. |

Confirm it in **one line**, then start without waiting unless something is ambiguous. For example: "Finding 20 negative posts about Faysal Bank, last month, general search (news, RSS, Facebook)."

## 2. Run the loop
1. Call `start_find`. If it's refused, tell the user the reason and the fix (busy → try again shortly; Facebook paused → other sources still work with `platforms`).
2. Poll `get_find` about every 20 s while `status` is `collecting`.
3. When it is `ready`, label **every** item in `to_label` with `submit_find_labels`:
   - `label` is one of the requested types when it truly fits. Otherwise say what it is (`promotional`, `neutral`, `positive`, `other`…).
   - Use the post text **and its comments**. For complaints, a neutral post whose comments are complaints counts as `negative` when the comments are about the subject.
   - Judge by the mission's goal (`get_mission`): e.g. a complaint about a different bank is `other`.
   - `reason`: one short sentence.
   - Don't set `keep` unless you have a reason to override the default (kept = label in the requested types).
4. After labelling:
   - `status` is `done` → finish.
   - `partial` → call `continue_find`, then poll again.
   - `exhausted` → finish (there were fewer than requested).
   - `aborted` → finish, explaining the Facebook pause from `notes`.
   Stop after 8 batches in one session; say how to resume (`/find continue <job id>`).

## 3. Results
- Kept items are already saved to captures (as kept, for the mission), so later `/report`s include them.
- Write `find-<mission>-<types>-<range>.md` in the working folder (lowercase, hyphens), with:
  - a header line: request, date range, sources searched, how many were checked and kept;
  - one section per kept item (newest first): label, source or group, author, date (or "date unknown"), link, a short quote (≤ 300 chars), the 1–3 most relevant comments, and your reason;
  - a "Notes" section from the job's `notes` (Facebook skipped or paused, ranges beyond 90 days being best-effort, feeds that don't reach back far enough).
- Call `export_find_csv` with the job id and save the returned `csv` text **unchanged** in the working folder as the returned `filename` (`find-<mission>-<types>-<range>.csv`). It has one row per post plus one row per comment, linked by `parent_item_key`. The service also keeps a copy (`file`).
- In chat: kept / requested, the top 5 one-liners with links, both file names, and any notes.

## Exporting an earlier job
`/find export <job id> [labelled|all]`: call `export_find_csv` (`include`: `kept` by default; `labelled` adds rejected items with their labels; `all` adds unlabelled ones) and save the CSV as above. Nothing else.

## Resuming
`/find continue <job id>`: call `get_find`. Label anything still in `to_label`, then `continue_find` and run the loop as above. Jobs ending `partial` because of the page budget or active hours can be resumed later or tomorrow.

## Never
Never like, comment, join, share, message or post. Don't change settings or turn platforms on during a find unless the user asks. Don't retry Facebook after a pause or soft block.
