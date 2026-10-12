---
description: Show the agent's main settings and open its dashboard
---

1. Call `get_config` and summarise, in plain words, the settings people change most: working hours (active hours and timezone), how far back it reads, how much Facebook it reads per run and per day, and which platforms are on.
2. Call `get_status` to show today's Facebook use next to the daily limit.
3. Call `open_dashboard`. It opens the dashboard in the browser on this computer. Mention what's there: the Facebook login, API keys for YouTube or Reddit, platforms, groups and pages, and health checks. Don't paste the link elsewhere; it contains this computer's private access key.
4. Offer to change any setting for them with `update_config`, following the `manage-config` skill.
