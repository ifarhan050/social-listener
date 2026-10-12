---
description: Add a Facebook group/page, subreddit, YouTube channel, or RSS feed to monitor
argument-hint: "URL [high|normal] [cutoff_hours]"
---

Add a monitored target using the social-listener tools, following the `manage-config` skill.

Arguments: `$ARGUMENTS`. They are the URL, then an optional priority (`high` or `normal`), then an optional `cutoff_hours`.

1. Accepted URLs:

   | Source | Example | Account risk |
   |---|---|---|
   | Facebook group | `https://www.facebook.com/groups/<id-or-slug>` | uses your Facebook login |
   | Facebook page | `https://www.facebook.com/<page-name>`, `profile.php?id=<n>` | uses your Facebook login |
   | Subreddit | `https://www.reddit.com/r/<name>` or `r/<name>` | none (official API) |
   | YouTube channel | `https://www.youtube.com/@handle` or `/channel/UC…` | none (official API) |
   | RSS/Atom feed | any forum, blog or news feed URL | none |

   For a website that isn't a feed, suggest looking for its RSS link (often `/feed`, `/rss`, or `.xml`).
2. Call `add_target` with `url`, plus `priority` and `cutoff_hours` if given. The platform and kind are detected automatically, and feeds are fetched once to verify them.
3. Show the created target with its `platform` and `kind`. Mention that it will be scanned on the next scheduled run, or that the user can run `/scan <id>` now.
4. **Subreddit or YouTube channel:** call `get_status`. If that platform isn't configured (`platforms.<name>` says "not configured"), say which key is needed and offer `open_dashboard` (its "API keys" box; never ask for keys in chat). Until then the target is stored but skipped.
5. **The user's 10th or later Facebook group or page:** suggest covering more ground with zero-account sources (news, RSS, YouTube) instead of adding more Facebook targets, which raises account risk.
