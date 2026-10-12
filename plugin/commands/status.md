---
description: Is everything working? Plain-language health check of the agent
---

Call `get_status` and `facebook_login_status`. Reply for a non-technical user.

1. **First line:** "✅ Everything is ready" or "⚠️ N thing(s) need you", followed by each fix in plain words:
   - the Facebook login is needed → `/connect-facebook`;
   - `versions.update_available` → "say *update the agent*" (`update_service`, after a yes);
   - a safety pause → "Facebook reading is paused until <time> to keep your account safe; nothing to do";
   - `zero_new_items` → "Facebook may have changed its layout; the agent may need an update".
2. **Then 3–5 short lines:**
   - which platforms are on;
   - Facebook use today vs the daily limit;
   - results found today;
   - items waiting for review (suggest `/review` if there are any);
   - the last run (when, and what it found).
3. Show missions as one line each: name, kept count, waiting count. If there are none, suggest `/setup`.

If the agent isn't installed or running, say: "The agent isn't running on this computer. Type /setup and I'll install or start it."
