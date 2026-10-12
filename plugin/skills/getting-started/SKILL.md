---
name: getting-started
description: Explain in plain words what the social-listener agent can do and show ready-to-use sample prompts tailored to the user's missions. Use for /start, /help, "what can you do?", "how do I use this?", "I'm new", "show me examples", after /setup finishes, or whenever a user seems unsure what to ask next.
---

# Getting started

Help a beginner feel confident in under a minute. Use short sentences and no jargon. Say "the agent", not "the service" or "MCP".

## Steps
1. Call `get_status` (it starts the agent if needed) and `list_missions`.
   - **If the agent isn't installed**, or there are **no missions**: say one line and offer `/setup`. Stop there.
2. Show a **status line**:
   - "✅ Ready", or "⚠️ 1 thing needs you: <plain fix>" (e.g. Facebook needs a new login → `/connect-facebook`; an update is available → "say *update the agent*").
3. Show **what it does**, in 2 lines: it looks through Facebook groups and pages, news, RSS, YouTube and Reddit for what you asked for, reads like a person (only reading, never posting), and saves the matches as a report and a spreadsheet (CSV) in your folder.
4. Show **"Things you can ask"**: 6–8 prompts from `prompts/getting-started.md`, **filled in with the user's own mission** (brand, area, type). Use real values from `list_missions` instead of placeholders, e.g. "Find 20 negative posts about Faysal Bank from last month".
5. Show **handy commands**, one line each:

| Command | What it does |
|---|---|
| `/find` | Find a number of posts of a kind in a date range |
| `/find export` | Save a search as a CSV spreadsheet |
| `/report` | Write a report for a mission |
| `/connect-facebook` | Log in to Facebook (once) |
| `/status` | Is everything working? |
| `/new-mission` | Look for something else too |

6. End with one tip:
   - Searches only run when you ask, so nothing happens in the background.
   - Results stay on this computer.

## Tone
- No more than ~20 lines in total.
- Never show JSON, ids or file paths unless the user asks.
- If the user asks something the agent can't do (e.g. reply to posts or message people), say so kindly: it only reads, to keep their account safe.
