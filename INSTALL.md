# Install Social Listener (instructions for Claude)

You are Claude, and the user asked you to install **Social Listener** by following this file. Social Listener is a read-only listening agent: it finds posts about what the user cares about (complaints, scams, leads, competitors, a topic) on Facebook, news, RSS, YouTube and Reddit, and saves the results on their computer.

Your goal: get the user from nothing to their first results with **no technical steps on their side**. You handle downloads and setup. The user only clicks **accept** on the plugin card (Cowork requires that click to install any plugin). They type their Facebook password only if they want Facebook, and only into Facebook's own window.

Talk to the user in plain, friendly words: one short message per stage, no jargon, no file paths, no JSON. Never ask them to open a terminal or edit a file.

Release files: `https://github.com/ifarhan050/social-listener/releases/latest/download/<file>`, where `<file>` is
- `social-listener.plugin`: the Cowork plugin;
- `SHA256SUMS.txt`: checksums for every file;
- `VERSION.txt`: the latest version number.

---

## Step 1: Is the plugin already installed?
Check whether you have the social-listener tools (for example `get_status`).

- **Yes:** call `get_status`.
  - Download `VERSION.txt`. If it's newer than `versions.plugin`, do Step 2 to offer the update, then continue.
  - Otherwise go to Step 3.
- **No:** go to Step 2.

## Step 2: Hand the user the plugin (one click for them)
**If you are in Claude Cowork** (you have a shell and an outputs folder):

1. In your shell:
   ```bash
   cd /tmp && rm -f social-listener.plugin SHA256SUMS.txt
   curl -fsSLO https://github.com/ifarhan050/social-listener/releases/latest/download/social-listener.plugin
   curl -fsSLO https://github.com/ifarhan050/social-listener/releases/latest/download/SHA256SUMS.txt
   grep ' social-listener.plugin$' SHA256SUMS.txt | sha256sum -c -
   ```
2. **Only if the check prints `OK`,** copy `/tmp/social-listener.plugin` into this session's **outputs** folder, keeping the name `social-listener.plugin`. Copy it; don't write the download straight into outputs. It then appears in the chat as a plugin card.
   - **If the check fails,** don't offer the file; tell the user the download couldn't be verified and to try again later.
3. Tell the user: **"Click accept on the Social Listener card above. That's the only click needed."**
4. **If downloads are blocked** in your shell, tell the user the one fallback: Claude app → **Customize → Plugins → Add marketplace**, paste `https://github.com/ifarhan050/social-listener`, then **Install**.

**If you are Claude Code** (a terminal on the user's computer), run these instead:
```bash
claude plugin marketplace add ifarhan050/social-listener
claude plugin install social-listener@social-listener
```

**After the user accepts:**
- When the plugin starts, it fetches what it needs by itself: if the computer has no Node.js, it downloads a private, checksum-verified copy (about 30 MB, up to a minute the first time). Nothing is installed system-wide and no admin rights are needed.
- **If the social-listener tools are available in this chat now,** go to Step 3.
- **If they aren't,** new plugins may only load in new chats. Tell the user: "Done! Open a **new chat** and type **/setup**; I'll finish everything there." If they started the install with "I want to find …", tell them to add that after /setup. Stop.
- **If the tools are there but fail with a "still downloading" message,** wait about 30 seconds and try `get_status` again (twice at most). If it still fails, ask the user to open a new chat and type **/setup**.

## Step 3: Set everything up
Follow the plugin's **`setup-wizard`** skill. Two points from this file apply:
- **Consent:** if the user's request said they agree to install (for example "I agree to install it on this computer"), that is their consent for `install_service`. Don't ask again; tell them it's being set up and that it takes a few minutes. Without that sentence, ask once.
- **What to find:** if the request said what they want to find ("I want to find: …"), use it for the mission and ask only what's truly missing. Otherwise ask that one question.

`install_service` downloads the app and its packages, checks for Chrome (or gets a private browser), and starts the agent now and at every login. Then the wizard creates the mission and runs a first small search, with results saved as a report and a CSV in the user's folder.

Facebook is **optional** and comes last: offer `/connect-facebook`. The user logs in in Facebook's own window, once. Never ask for passwords or API keys in chat.

## Step 4: Hand over
- A short summary: ✅/⚠️ for the agent, the mission and Facebook.
- The first results with links.
- "Type **/start** any time to see what you can ask."
- **Updates later:** the user can paste the same install message again. You'll update the plugin (Step 2, if newer) and the agent (`update_service`). Their data and Facebook login are kept.

## Rules
- Only read on every platform: never like, comment, join, share, message or post.
- Never ask for passwords, codes or API keys in chat. API keys go in the dashboard (`open_dashboard`).
- Only download from `github.com/ifarhan050/social-listener` and `nodejs.org` as described above, and only use a plugin file whose checksum matched.
