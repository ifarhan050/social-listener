---
name: missions
description: Manage and report on social-listener missions (what the agent looks for — complaints, leads, competitors, topics). Use for /missions, /report (a mission report), listing/pausing/editing/duplicating/deleting missions, tuning search phrases or match rules, or when a user asks "what has the agent found for this goal?".
---

# Missions

A **mission** is one goal the agent works on. Each mission has:
- search phrases, typed into Facebook, news, YouTube and Reddit search;
- match rules (a cheap prefilter: `any` / `all_of` / `none`);
- keep and exclude rules, which you apply in review;
- sources and a report.

All missions share the same browser, safety limits and captures. One post can count for several missions, with a separate verdict for each.

## Listing and editing
- `list_missions` shows each mission's status, template, effective search phrases and counts (`pending`, `kept`, `rejected`).
- **Pause or resume:** `set_mission_status`. Pausing keeps everything.
- **Edit:** `update_mission`. Show before → after and confirm when you narrow or replace rules. Arrays replace, so send full lists.
- **Duplicate:** read the mission, then `create_mission` with a new name.
- **Delete:** `delete_mission`, only after explicit confirmation. Suggest pausing instead. Captures are kept.
- **The original brand mission** (`uses_keywords: true`) reads its terms from the keyword list (`add_keyword` / `update_keyword`). Giving it explicit `match` rules switches it to mission rules.

### Tuning tips
- **Too much noise:** add `none` terms, or tighten `exclude_rules`. Review handles the rest.
- **Too little:** add search phrases the way people actually write them, including Roman Urdu or Urdu, and broaden `any` / `all_of` terms.
- **Facebook:** only the first `search.max_queries` phrases across all missions are searched there (account safety). Put the most valuable phrases first. Other sources search them all.

## Finding a set number of items
For "get me N negative / promotional / lead posts from <period>", use the `find` skill (`/find`). It searches a date range, lets you label the candidates, and saves the matches to the mission's captures, so they appear in `/report` too.

## `/report <mission> [days]`
1. Find the mission by name or id with `list_missions`. If the name is ambiguous, ask.
2. Make sure nothing is waiting for review. If `counts.pending` > 0 for this mission, review it first (`review-captures` skill).
3. Call `get_mission_items` (default: stored items in the mission's `report.days` window).
4. For **complaints** missions that need comment-level evidence from Facebook groups, you may also run the deep pass: `start_facebook_group_report` with `mission_id`, then poll `get_facebook_group_report`. That follows the `facebook-negative-report` flow.
5. Write the report in the **template's format** (`list_templates` → `report_format`, or the mission's own `report.format`):
   - **complaints:** top N by severity, with evidence and links;
   - **leads:** open leads, newest first, labelled hot/warm/cold. For each: first name, what they need, area, date and link. Add counts by area and need. Never suggest contacting anyone automatically;
   - **businesses:** providers (name as shown, offer, area, price if stated, link). Group duplicates and add a short market overview;
   - **topic:** themes with counts and short quotes, sentiment split, notable posts, what changed;
   - **custom:** the user's format.
6. **Save the file** as `<mission-name-slug>-report.md` in the working folder (overwrite it). Put a dated header, the scope (sources, days) and a method note at the top. Then summarise in 3–6 lines in chat.
7. **Privacy:**
   - first names only, short quotes;
   - no phone numbers, emails, account numbers or other personal details in the report, even if posts contain them. The link is how the user follows up.
