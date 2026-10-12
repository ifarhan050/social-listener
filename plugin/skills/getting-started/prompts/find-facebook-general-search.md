# Find: general Facebook search (Cowork prompt)

Paste the prompt below into Claude Cowork, after replacing the words in [brackets]. It runs a **general Facebook search** with no groups, on Facebook only, using the `find` skill.

It needs the social-listener plugin with the `find` tools, and the agent must be running.

```
Use the social-listener find skill (MCP tools only, no other browser).

Find 20 posts about [Your Brand] that are negative or scams, from the last 30 days.

- Search: general Facebook search only. Don't limit it to any groups or pages.
- Platforms: facebook only (skip news, RSS, YouTube, Reddit).
- Mission: "[Your Brand] complaints & scams" (use its search phrases, e.g. [Your Brand], [Your Brand] scam, [Your Brand] complaint, [your app name], [brand name in Urdu]).
- Types to keep: negative (complaints, service problems, blocked cards or accounts, failed payments, charges) and scam (fraud, fake agents, phishing using the brand's name).
- Not wanted: promotional posts, ads, job posts, brand news, praise, and complaints about other companies.
- Use the comments too: a neutral post whose comments are complaints about [Your Brand] counts as negative.

Steps: start_find → poll get_find until it's ready → label every item with submit_find_labels → continue_find until 20 are kept, or it says exhausted, partial or aborted. Stop after 8 batches.

At the end:
- write find-[your-brand]-negative-scam-last-30-days.md in this folder: for each kept post, the label, group or page, author, date, link, a short quote, the top 1–3 comments, and why it was kept; then a Notes section;
- export the results with export_find_csv and save the CSV in this folder exactly as returned (one row per post, plus one row per comment);
- in chat, give me kept vs requested, the top 5 with links, and any notes (e.g. Facebook paused or the page budget reached; if partial, give the job id so I can resume).

Read-only: never like, comment, join, share or message.
```

## Changing it
- **Count, type or period:** edit "20", "negative or scams" and "last 30 days".
  - Periods you can use: "last 7 days", "this month", "last month", "this year", or "from 2026-09-01 to 2026-09-30".
- **Older posts:** past 90 days, Facebook's search uses its year filter, which is best-effort. For a bigger date range, also allow news by removing "facebook only".
- **CSV of an earlier job:** "Export my last find as CSV", or "Export social-listener find job 12 as CSV" (add "including rejected" for every labelled item).
- **Resume a partial job:** "Continue my last find and finish the report."

## What to expect
- **Search phrases:** Facebook's general search uses at most 5 of them per job (`search.max_queries`).
- **Limits:** the usual page budgets and active hours (08:00–23:00) apply. A job started outside those hours ends `partial` until you resume it.
