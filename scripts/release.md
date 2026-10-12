# Publishing a release

Users only ever download **`Social-Listener-Setup.zip`** from the GitHub release page. The installers inside it fetch the app's code from `main` of the repo set in `package.json` → `socialListener.repo` (currently `ifarhan050/social-listener`). The repo must be **public**.

## Steps
1. **Bump the version** in the same 3 places so `get_status` can spot outdated installs:
   - `plugin/.claude-plugin/plugin.json`
   - `service/package.json`
   - `PLUGIN_VERSION` in `plugin-mcp/src/index.ts`
2. **Check everything:**
   ```bash
   npm run typecheck
   npm test
   ```
3. **Build both zips:**
   ```bash
   npm run package:release
   ```
   This produces `dist/social-listener-plugin.zip` and `dist/Social-Listener-Setup.zip`. It also refreshes the generated copies in `plugin/install/` and `plugin/skills/*/prompts/`; commit those so the marketplace copy of the plugin matches.
4. **Commit and push to `main`.** Installers download `main`, so push **before** publishing the release.
5. **Publish the release:**
   ```bash
   gh release create v0.2.0 dist/Social-Listener-Setup.zip dist/social-listener-plugin.zip --title "Social Listener 0.2.0" --notes "What's new: ..."
   ```

## Before announcing a release
- On a Windows account **without Node.js**, double-click `Install on Windows.cmd` and check that:
  - Node is downloaded privately;
  - the dashboard opens;
  - after a restart of the computer, the agent is running again.
- In Claude, upload the plugin, restart Claude, and type `/setup`. The tools must answer. If they say Node can't be found, see "If Claude can't start the plugin" below.
- `/connect-facebook`: log in, close the window, then check that `/status` shows Facebook connected.
- Do the same on a Mac (`Install on Mac.command`).

## If Claude can't start the plugin
Claude starts the plugin with the `node` command.
- **When the installer had to download its own Node.js:**
  - **Windows:** the installer adds that Node to the user's PATH (no admin), and Claude must be fully restarted once.
  - **Mac:** the installer adds Node to `~/.zprofile` / `~/.bash_profile`, and links it into `/usr/local/bin` when that folder is writable.
- **If Claude still can't find `node`,** the simplest fix is to install Node.js LTS from https://nodejs.org (one admin prompt), then restart Claude.

## Optional: install from GitHub instead of uploading a zip
`.claude-plugin/marketplace.json` makes this repo a plugin marketplace. Where Claude lets users add a marketplace by repo (`ifarhan050/social-listener`), they get updates without re-uploading zips.
