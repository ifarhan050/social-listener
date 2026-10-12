---
description: Show or switch source platforms on/off (facebook, news, rss, youtube, reddit)
argument-hint: "[platform on|off]"
---

Manage which sources the social-listener collects from, using its MCP tools.

**No arguments:** call `list_platforms` and show a table with these columns:
- platform
- on/off
- ready (or the reason it isn't)
- targets
- account needed?

For platforms that are on but not configured, show the missing `.env` key (`needs`).

**With arguments** (`$ARGUMENTS`, e.g. `facebook off`, `youtube on`):
1. Parse the platform (`facebook`, `news`, `rss`, `youtube`, `reddit`) and `on`/`off` (also accept enable/disable or true/false). If either is unclear, ask.
2. Call `set_platform_enabled` and show the returned row.
3. Explain the effect:
   - **off:** nothing is deleted. Targets, captures and review history stay, and scanning resumes when switched back on.
   - **facebook on:** remind the user that Facebook uses their own account. It's protected by active hours, page budgets, the search cap and automatic pauses. The account-risk notice must be acknowledged on the dashboard.
   - **youtube or reddit on without credentials:** say which key is needed (from `needs`) and offer `open_dashboard`: paste it in the "API keys" box there (it takes effect immediately; never ask for keys in chat).
4. If every platform would end up off, warn that nothing will be collected, and ask before proceeding.

Finer controls (mention when relevant):
- `search.mode` / `<platform>.search_mode` turn off only keyword search on a platform.
- `update_target` with `status: "disabled"` turns off a single group, page, channel or feed.
