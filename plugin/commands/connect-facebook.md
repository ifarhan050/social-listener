---
description: Log in to Facebook for the agent (one time) — a Chrome window opens, you log in and close it
---

1. Call `facebook_login_status`. If it's already connected, say so in one line (with any safety pause) and stop.
2. Explain the risk in plain words, then ask "Open the Facebook login window now?":
   - reading Facebook automatically is against Facebook's terms and can lead to a checkpoint or restriction;
   - the agent only reads, slowly, like a person, within daily limits, but the risk isn't zero;
   - a secondary account is safer.
3. After a clear yes, call `connect_facebook` with `accept_risk: true`. Tell the user: "A Chrome window opened. Log in there (including any code Facebook asks for), then **close the window**."
4. If it returns `waiting: true`, ask them to say "done" after closing the window, then call `facebook_login_status`.
5. **Connected:** "✅ Facebook is connected. You won't need to log in again unless Facebook asks." **Not connected:** give the reason in plain words and offer to try again.

Never ask for the Facebook password in chat. The user only types it in the Chrome window.
