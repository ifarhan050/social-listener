---
name: setup-wizard
description: Guided, plug-and-play setup of the social-listener agent for beginners — install or start the local agent if needed, log in to Facebook once, then turn what the user wants to find (complaints about a brand, leads such as people asking for a tutor, similar businesses/competitors, a topic or market) into a mission, and run a first search. Use for /setup, /new-mission, "set up social listening", "I want to find …", "help me get started", or when the user pastes a filled mission prompt.
---

# Setup wizard

Take someone from "just added the plugin" to "it found my first results", with as few questions as possible. Assume the user is **not technical**:
- use plain words and short sentences, one step at a time;
- prefer multiple-choice questions;
- never ask them to open a terminal, edit a file or run `npm`.

Never invent URLs, page names or keywords the user didn't give or approve.

## 0. Make sure the agent is installed and running
0. **If the social-listener tools are missing** (there is no `get_status` tool, or every social-listener tool fails to start), the plugin's helper couldn't start on this computer, usually because Node.js isn't installed yet. Say this kindly and give one step:
   - "Download **Social-Listener-Setup.zip** from https://github.com/ifarhan050/social-listener/releases/latest, unzip it, and double-click **Install on Windows** (or **Install on Mac**: right-click → Open). It sets everything up without admin rights. Then quit Claude completely, reopen it, and type /setup again."
   - Stop there. Don't try to install anything from inside this chat.
1. Call `get_status`. It starts the agent automatically if it's installed.
2. **If it isn't installed** (the error says it isn't installed or running):
   - Explain in one line: "The agent needs a small helper app on this computer. It does the reading and keeps your results here; nothing is sent to anyone else."
   - Ask: "Install it now? It takes about 5 minutes and doesn't need admin rights."
   - After a clear yes, call `install_service` with `confirm: true`. It sets up everything, including Node.js, privately.
   - If it fails, show the "Setup stopped / What to do" lines from its output in plain words. The fallback is the **Social Listener Setup** download: double-click "Install on Windows" or "Install on Mac".
3. If `get_status` shows `versions.update_available`, offer `update_service`. It takes a few minutes and keeps all data and the Facebook login.
4. Call `doctor`. Explain any ✖ item in one plain sentence with its fix, and skip the noise.

## 1. What do you want to find?
- Ask in plain words, or use their filled prompt if they pasted one (the `prompts/*.md` style).
- Map it to a template with `list_templates`:
  - **complaints:** problems, scams or negative talk about a brand or product;
  - **leads:** people **asking for** something the user offers (a tutor, a plumber, a product);
  - **businesses:** others **offering** the same or similar service (competitors or partners);
  - **topic:** follow a subject or market and summarise it;
  - **custom:** anything else.
- Ask only what's missing, with at most 4 questions, in one message:
  - the brand or offer;
  - location or areas;
  - languages (English / Urdu / Roman Urdu);
  - what to ignore.

## 2. Propose the mission (then wait for "yes")
Show a short card, in plain words:
- **Name** and **goal**: 1–2 sentences, specific (who, what, where).
- **Search phrases:** 3–8, written the way people actually post, most important first. Include Roman Urdu or Urdu if relevant. For leads, phrase them as requests ("need home tutor DHA", "tutor chahiye"); for businesses, as offers ("tuition available Lahore").
- **Match rules**, following the template's `match_example`:
  - `any`: brand or topic terms;
  - `all_of`: [[service words], [request words]] for leads, [[service words], [offer words]] for businesses;
  - `none`: noise words.

  Keep them broad enough; Claude filters precisely later. Show them as "words it looks for" and "words it ignores", not as JSON.
- **Where it looks:** the template's sources, minus anything the user doesn't want. Facebook uses their account (slow and careful); news, RSS and YouTube need no account.

After the user says yes, call `create_mission`. If the user's brand mission already exists (the original keyword-based one), offer to edit it with `update_mission` instead of duplicating it.

## 3. Facebook (only if they want it)
- Call `facebook_login_status`. If it's connected, say so and move on.
- If not, explain the risk in plain words, then ask: "Log in to Facebook now? A Chrome window will open; log in, then just close it. You only do this once."
  - **Risk notice:** reading Facebook automatically is against Facebook's terms and can lead to a checkpoint or restriction. The agent only reads, slowly, like a person, and within daily limits, but the risk isn't zero. Using a secondary account is safer.
- After a clear yes, call `connect_facebook` with `accept_risk: true`. While it waits, tell them: "Log in in the Chrome window (including any code Facebook asks for), then close the window."
  - If it returns `waiting: true`, ask them to say "done" once the window is closed, then call `facebook_login_status`.
- **Groups and pages:** ask for Facebook groups or pages (and subreddits, YouTube channels, RSS feeds) to add with `add_target`.
  - Suggest the **kinds** of places to look (area groups, parent groups, community and buy/sell groups, industry forums), but never make up URLs.
  - No groups? Say that's fine: `/find` can do a **general Facebook search**.
- Keep the safety defaults. Don't raise budgets or turn off active hours or human pacing.
- Use `set_platform_enabled` for platforms they don't want at all.
- **YouTube or Reddit API keys** (optional): never ask for them in chat. Call `open_dashboard` and tell them to paste the keys in the "API keys" box there.

## 4. First results
- Offer a first search sized to the mission, e.g. "Find 10 <main type> about <subject> from the last 7 days?". Then follow the `find` skill. Results are saved as a report, a CSV and in captures.
- Runs are **manual**: the agent only works when they ask. Scheduled runs are off. Only if they ask for automatic runs:
  - turn on `scheduler.scheduled_runs` with `update_config`;
  - create **one** Cowork scheduled task, "Social listening – collect & review" (prompt `/scheduled-run`, hourly);
  - say it runs only while the computer is awake and Claude is open.
- For their own brand page (or an ombudsman page), where complaints sit in comments that don't name the brand, offer `comments_mode: "all"` on that target (`update_target`).

## 5. Hand over
- Give a 3–5 line summary of what's set up, with ✅ or ⚠️ per item: agent, mission, Facebook login, sources.
- Then follow the `getting-started` skill: show the "things you can ask" list with 5–6 sample prompts filled in for *their* mission (brand, area, type).
- End with: "Type /start any time to see this list again."

## Rules
- Read-only on every platform: never like, comment, join, message or post, and never contact leads on the user's behalf.
- No secrets in chat. API keys go in the dashboard's API keys box (`open_dashboard`).
- For leads and businesses missions, remind the user once that the posts contain personal details. They should use them respectfully, follow platform rules and local law, and keep only what they need.
