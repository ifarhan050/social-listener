#!/usr/bin/env bash
# Social Listener - installer / updater / uninstaller (macOS; also works on Linux). No admin needed.
#
# Easiest: double-click "Install on Mac.command" from the Social Listener Setup download.
# Or in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/__SOCIAL_LISTENER_REPO__/main/install/install.sh | bash
#   bash install.sh [--repo owner/repo] [--ref main] [--dry-run] [--no-start] [--no-autostart]
#   bash install.sh --uninstall [--remove-data]
#
# Re-runnable; your data (service/data), settings (service/.env) and Facebook login are kept.
# If Node.js 20+ isn't installed, the official Node.js LTS is downloaded (checksum-verified)
# into the app folder - nothing is installed system-wide.
set -euo pipefail

REPO="__SOCIAL_LISTENER_REPO__"
REF="main"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/social-listener"
DRY_RUN=0
NO_START=0
NO_AUTOSTART=0
UNINSTALL=0
REMOVE_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --no-autostart) NO_AUTOSTART=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --remove-data) REMOVE_DATA=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

TOTAL=6
step() { printf '\n\033[36m[%s/%s] %s\033[0m\n' "$1" "$TOTAL" "$2"; }
info() { printf '      %s\n' "$1"; }
fail() {
  printf '\n\033[31mSetup stopped: %s\033[0m\n' "$1" >&2
  [ -n "${2:-}" ] && printf '\033[33mWhat to do: %s\033[0m\n' "$2" >&2
  exit 1
}

SERVICE_DIR="$INSTALL_DIR/service"
DATA_DIR="$SERVICE_DIR/data"
NODE_DIR="$INSTALL_DIR/runtime/node"
CONN="$HOME/.social-listener/connection.json"
OS="$(uname -s)"
LABEL="com.social-listener.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
XDG_AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/social-listener.desktop"
PROFILE_MARK="# social-listener (added by its installer)"

stop_running() {
  if [ "$OS" = Darwin ] && [ -f "$PLIST" ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
  if [ -f "$CONN" ]; then
    oldpid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONN" | head -n1)
    [ -n "$oldpid" ] && kill "$oldpid" 2>/dev/null || true
    sleep 1
  fi
}

remove_profile_lines() {
  for f in "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$f" ] || continue
    grep -q "$PROFILE_MARK" "$f" || continue
    grep -v -F "$PROFILE_MARK" "$f" > "$f.sl-tmp" && mv "$f.sl-tmp" "$f"
  done
}

# --- Uninstall --------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  echo "Uninstalling Social Listener..."
  if [ "$DRY_RUN" = 1 ]; then
    echo "  Stop the service; remove $PLIST / $XDG_AUTOSTART; remove PATH lines from shell profiles;"
    echo "  delete $INSTALL_DIR (keeping service/data unless --remove-data)."
    exit 0
  fi
  stop_running
  rm -f "$PLIST" "$XDG_AUTOSTART" "$CONN"
  remove_profile_lines
  [ -L /usr/local/bin/node ] && [ "$(readlink /usr/local/bin/node)" = "$NODE_DIR/bin/node" ] && rm -f /usr/local/bin/node
  if [ "$REMOVE_DATA" = 0 ] && [ -d "$DATA_DIR" ] && [ -r /dev/tty ]; then
    printf 'Also delete your saved results and the Facebook login? Type YES to delete, or press Enter to keep them: '
    read -r answer < /dev/tty || answer=""
    [ "$answer" = "YES" ] && REMOVE_DATA=1
  fi
  if [ -d "$INSTALL_DIR" ]; then
    if [ "$REMOVE_DATA" = 1 ]; then rm -rf "$INSTALL_DIR"
    else
      find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name service -exec rm -rf {} +
      [ -d "$SERVICE_DIR" ] && find "$SERVICE_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
      echo "Kept your data in $SERVICE_DIR (delete that folder to remove it)."
    fi
  fi
  echo "Social Listener was removed. You can also remove the plugin in Claude -> Customize -> Plugins."
  exit 0
fi

case "$REPO" in __*__) [ -n "${SOCIAL_LISTENER_REPO:-}" ] && REPO="$SOCIAL_LISTENER_REPO" ;; esac
case "$REPO" in __*__) fail "No GitHub repository configured." "Run with --repo <owner>/<repo>." ;; esac
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid --repo '$REPO' (expected owner/repo)."
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || fail "Invalid --ref '$REF'."
ZIP_URL="https://codeload.github.com/$REPO/tar.gz/$REF"

case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) ARCH="" ;; esac
case "$OS" in Darwin) PLAT=darwin ;; Linux) PLAT=linux ;; *) PLAT="" ;; esac

system_node() {
  local n
  n=$(command -v node 2>/dev/null || true)
  [ -n "$n" ] || return 1
  case "$n" in "$NODE_DIR"*) return 1 ;; esac
  local major
  major=$("$n" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  [ -n "$major" ] && [ "$major" -ge 20 ] && { echo "$n"; return 0; }
  return 1
}

sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

install_private_node() {
  [ -n "$PLAT" ] && [ -n "$ARCH" ] || fail "No Node.js download for this computer ($OS $(uname -m))." "Install Node.js 20+ from https://nodejs.org and run this again."
  info "Finding the latest Node.js LTS release on nodejs.org"
  local index ver name base tmp expected actual
  index=$(curl -fsSL https://nodejs.org/dist/index.json) || fail "Could not reach nodejs.org." "Check your internet connection and run the installer again."
  # index.json is newest first; take the first LTS (lts is a codename, not false) with major >= 22.
  ver=$(printf '%s' "$index" | tr '{' '\n' | grep '"lts":"' | grep -o '"version":"v[0-9.]*"' | sed 's/.*"\(v[0-9.]*\)"/\1/' | awk -F. '{ if (substr($1,2)+0 >= 22) { print; exit } }')
  [ -n "$ver" ] || fail "Could not find a Node.js LTS release." "Run the installer again later."
  name="node-$ver-$PLAT-$ARCH"
  base="https://nodejs.org/dist/$ver"
  tmp=$(mktemp -d)
  info "Downloading Node.js $ver ($PLAT-$ARCH)"
  curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz" || fail "Node.js download failed." "Check your internet connection and run the installer again."
  expected=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')
  actual=$(sha256 "$tmp/$name.tar.gz")
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { rm -rf "$tmp"; fail "The Node.js download failed its checksum check, so it was not used." "Run the installer again."; }
  info "Checksum OK. Unpacking"
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$NODE_DIR"
  mkdir -p "$(dirname "$NODE_DIR")"
  mv "$tmp/$name" "$NODE_DIR"
  rm -rf "$tmp"
}

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run - nothing will be changed. Steps:"
  if [ -x "$NODE_DIR/bin/node" ]; then echo "  1. Node.js: use the app's own copy in $NODE_DIR"
  elif sn=$(system_node); then echo "  1. Node.js: use the installed $sn"
  else
    echo "  1. Node.js: download the latest LTS for $PLAT-$ARCH from https://nodejs.org/dist/index.json,"
    echo "     verify it against SHASUMS256.txt, unpack into $NODE_DIR (no admin, PATH unchanged)"
  fi
  echo "  2. Download $ZIP_URL"
  echo "  3. Copy into $INSTALL_DIR (keeping service/data and service/.env)"
  echo "  4. npm ci; npm run build -w service"
  echo "  5. Use installed Chrome/Edge, or download a private Chromium if neither exists"
  if [ "$OS" = Darwin ]; then echo "  6. Start via $PLIST (also at login), then open the dashboard"
  else echo "  6. Start in the background; start at login via $XDG_AUTOSTART; open the dashboard"; fi
  exit 0
fi

echo "Social Listener setup"
echo "Installing into $INSTALL_DIR (no admin rights needed). This takes about 3-10 minutes."

# 1. Node.js
step 1 "Checking Node.js"
if [ -x "$NODE_DIR/bin/node" ]; then NODE="$NODE_DIR/bin/node"; info "Using the app's own Node.js ($("$NODE" -v))"
elif sn=$(system_node); then NODE="$sn"; info "Using the installed Node.js ($("$NODE" -v))"
else
  info "Node.js 20+ is not installed; getting a private copy for this app (nothing system-wide)."
  install_private_node
  NODE="$NODE_DIR/bin/node"
  info "Node.js $("$NODE" -v) ready"
fi
if [ "$NODE" = "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  # The plugin's launcher finds this private copy itself; undo PATH edits made by versions before 0.3.
  remove_profile_lines
  [ -L /usr/local/bin/node ] && [ "$(readlink /usr/local/bin/node)" = "$NODE_DIR/bin/node" ] && rm -f /usr/local/bin/node
fi

stop_running

# 2. Download
step 2 "Downloading the app ($REPO, $REF)"
tmp=$(mktemp -d)
curl -fsSL "$ZIP_URL" | tar -xz -C "$tmp" || fail "Could not download $ZIP_URL." "Check your internet connection and run the installer again."
src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)
[ -f "$src/service/package.json" ] || fail "The download does not look like the Social Listener app."

# 3. Copy (data and .env are not in the archive, so they are never overwritten)
step 3 "Copying files"
mkdir -p "$INSTALL_DIR"
cp -R "$src"/. "$INSTALL_DIR"/
rm -rf "$tmp"

cd "$INSTALL_DIR"
step 4 "Installing packages and building (the longest step)"
npm ci --no-audit --no-fund --loglevel=error || fail "Installing packages failed." "Run the installer again. If it fails again, send the messages above to whoever gave you this app."
npm run build -w service --silent || fail "Building the app failed." "Run the installer again, or send the messages above to whoever gave you this app."

step 5 "Checking for Google Chrome or Microsoft Edge"
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || [ -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ] \
  || command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null || command -v microsoft-edge >/dev/null; then
  info "Found - the agent will use it (with its own separate profile)."
else
  info "Neither found - downloading a private Chromium for the agent (about 150 MB)."
  npx -w service playwright install chromium
fi

# Dashboard opener (also handy later).
cat > "$INSTALL_DIR/open-dashboard.sh" <<'EOS'
#!/usr/bin/env bash
c="$HOME/.social-listener/connection.json"
url=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$c" | head -n1)
token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$c" | head -n1)
(command -v open >/dev/null && open "$url/#token=$token") || xdg-open "$url/#token=$token"
EOS
chmod +x "$INSTALL_DIR/open-dashboard.sh"

if [ "$NO_START" = 1 ]; then printf '\nInstalled. Start it with: (cd %s && %s dist/index.js)\n' "$SERVICE_DIR" "$NODE"; exit 0; fi

step 6 "Starting the agent"
mkdir -p "$DATA_DIR"
rm -f "$CONN"
if [ "$OS" = Darwin ] && [ "$NO_AUTOSTART" = 0 ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>dist/index.js</string></array>
  <key>WorkingDirectory</key><string>$SERVICE_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA_DIR/service.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/service.err.log</string>
</dict>
</plist>
EOP
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || launchctl load -w "$PLIST"
  info "It will start automatically when you log in."
else
  (cd "$SERVICE_DIR" && nohup "$NODE" dist/index.js >>"data/service.log" 2>>"data/service.err.log" &)
  if [ "$OS" = Linux ] && [ "$NO_AUTOSTART" = 0 ]; then
    mkdir -p "$(dirname "$XDG_AUTOSTART")"
    printf '[Desktop Entry]\nType=Application\nName=Social Listener\nExec=sh -c "cd %s && %s dist/index.js >>data/service.log 2>>data/service.err.log"\nX-GNOME-Autostart-enabled=true\n' "$SERVICE_DIR" "$NODE" > "$XDG_AUTOSTART"
    info "It will start automatically when you log in."
  fi
fi
for _ in $(seq 1 40); do [ -f "$CONN" ] && break; sleep 1; done
[ -f "$CONN" ] || fail "The agent did not start." "See $DATA_DIR/service.err.log, or run the installer again."
"$INSTALL_DIR/open-dashboard.sh" || true

printf '\n\033[32mAll done! The dashboard opened in your browser.\033[0m\n\n'
echo "Next steps:"
echo "  1. If you haven't yet, add the plugin: in a Claude Cowork chat paste"
echo "       Install Social Listener for me by following https://github.com/__SOCIAL_LISTENER_REPO__/blob/main/INSTALL.md"
echo "  2. In a Cowork chat, type /setup - Claude will guide you (including the Facebook login)."
echo ""
echo "Later: open the dashboard with $INSTALL_DIR/open-dashboard.sh"
echo "Uninstall: bash $INSTALL_DIR/install/install.sh --uninstall"
