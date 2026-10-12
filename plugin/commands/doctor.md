---
description: Check social-listener health and Facebook account-safety settings
argument-hint: "[live]"
---

Call the social-listener `doctor` tool. Pass `live: true` if `$ARGUMENTS` contains "live"; that makes one cheap request per API source and never touches Facebook.

Report it grouped like this:
1. **Failures (✖)** first, each with its fix.
2. **Facebook risk warnings (!)**: explain in one line why each one raises the chance of a restriction, and give the fix. Offer to apply config fixes with `update_config`, but only after the user confirms (follow the `manage-config` skill).
3. **Sources:** which are ready (news, RSS, YouTube, Reddit, Facebook) and what's missing. For a missing YouTube or Reddit key, offer `open_dashboard` and point to its "API keys" box; never ask for keys in chat. For Facebook not connected, suggest `/connect-facebook`.
4. Start the reply with a one-line verdict: "✅ Ready" or "⚠️ N thing(s) need you". Keep the details short and plain.

Never suggest proxies, extra or secondary accounts, cookie exports, or anything that hides automation. Those raise the risk of a ban. Safer coverage comes from the zero-account sources (news, RSS, YouTube).
