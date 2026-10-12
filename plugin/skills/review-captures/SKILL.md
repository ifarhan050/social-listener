---
name: review-captures
description: Review social-listener captures and decide, for each mission, which posts and comments to keep (complaints, leads, competitors, topic posts — whatever the mission's goal is). Use when the user runs /review, asks to filter, triage or clean up captured posts, or when get_status shows items pending review.
---

# Reviewing captures

The collector saves every post or comment that matches a mission's search rules; that's a cheap, broad prefilter. **You** decide what's actually useful for each mission. Kept items are stored and reported. Items that every mission rejects have their files deleted. Every decision and its reason are logged (`get_review_log`), and nothing is collected twice.

## Loop
1. Call `get_review_queue` (20 captures per page). Each entry includes `missions`: the goal, `keep_rules`, `exclude_rules` and `labels` of every mission involved.
2. For **every** item (the post when `post.needs_review` is true, plus each comment), give a verdict **for each mission id in its `missions_pending`**:
   - `keep`: true or false. Is this item what this mission is looking for, given its goal, keep rules and exclude rules?
   - `label`: one of that mission's labels, e.g. leads `hot`/`warm`/`cold`, complaints `scam`/`money`/`service`/`other`, businesses `competitor`/`partner`/`mention`, topic `positive`/`negative`/`question`/`news`.
   - `score` (0–3, optional): how strong or urgent it is.
   - `reason`: one short line, e.g. "parent needs A-level physics tutor in DHA", "card blocked, no support reply", "academy advertising admissions".
   - Always send `mission_id` when an item has more than one pending mission.
3. Send everything in one `submit_reviews` call. Repeat until `remaining_in_queue` is 0.
4. **Summarise per mission:** reviewed / kept / rejected, plus the kept items briefly (source, short excerpt, link). For leads, newest first with area and need.

## How to judge
- **Judge each item by its own text, against that mission only.** A comment is judged by the comment; the post is just context. The same post can be kept for one mission and rejected for another.
- English, Urdu and Roman Urdu: judge the meaning, not the language.
- **Keep and exclude rules are the user's intent.** Follow them over your own taste. When an item is borderline, keep it with a lower `score` rather than dropping a possibly real lead or complaint.

### By template
**complaints** keeps negative experiences about the brand:
- failed transactions, outages, blocked accounts or cards, fees, poor service, refund delays, scam or fraud warnings;
- sarcasm, and polite reports of a real problem.

It excludes:
- promotional content: ads, offers, the brand's own marketing, agents, giveaways, job posts, competitor ads;
- the brand's own pages, praise, neutral questions;
- negativity aimed at someone else.

On news: press releases and launches count as promotional; outage, fraud and fine reporting counts as negative.

**leads** keeps someone **asking for** what the mission offers: a request, a requirement, or "can anyone recommend…". Specific requests (subject, level, area, budget, timing) are `hot`; vague ones are `warm` or `cold`.
It excludes people **offering** the service (providers, academies, "available for tuition"), ads, job posts for providers (unless the goal wants them), requests outside the area, and requests that are already fulfilled.

**businesses** keeps providers **offering** the same or a similar service, and discussion or reviews of such providers.
It excludes customers asking (those are leads), unrelated industries, and spam.

**topic** keeps substantive discussion: opinions, experiences, questions, news, prices.
It excludes spam and off-topic uses of the words.

**custom:** follow the mission's rules literally.

## Complaint-style shortcut (still accepted)
For items whose `missions_pending` is empty (captured before missions existed), or for complaint missions, you can send `sentiment` (`negative`/`neutral`/`positive`) and `promotional` (true/false) instead of `keep`. The item is kept when it's negative and not promotional.

## Rules the service applies (you don't need to enforce them)
- An item is stored if **any** mission keeps it, and its files are deleted only when **every** mission rejects it.
- A post that didn't match the rules itself (it came with a matching comment) isn't kept on its own; it's stored as **context** when one of its comments is kept. A promotional post is stored as context unless `review.keep_promo_post_as_context` is off.

## Privacy
- Don't copy phone numbers, emails or other personal details into reasons or summaries.
- Never suggest contacting people automatically. The user follows up themselves through the link.
