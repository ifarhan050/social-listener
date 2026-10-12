#!/bin/sh
# Get a private Node.js for Social Listener (macOS / Linux), without admin rights.
# Used by launch.sh when the computer has no Node.js 18+.
#   get-node.sh <runtime/node dir> [wait seconds]   start (or join) a background download, wait up to N s
#   get-node.sh <runtime/node dir> --worker         the background download itself
# Official LTS from nodejs.org, verified against SHASUMS256.txt, unpacked next to the target and
# renamed into place, so a half-finished download is never used. Writes only to stderr.
NODE_DIR="$1"
MODE="${2:-25}"
LOCK="$NODE_DIR.downloading"
say() { echo "[social-listener] $1" >&2; }
[ -x "$NODE_DIR/bin/node" ] && exit 0

if [ "$MODE" = "--worker" ]; then
  parent=$(dirname "$NODE_DIR")
  mkdir -p "$parent" || exit 0
  tmp="$NODE_DIR.tmp-$$"
  trap 'rm -rf "$tmp"; rmdir "$LOCK" 2>/dev/null' EXIT
  case "$(uname -s)" in Darwin) plat=darwin ;; Linux) plat=linux ;; *) say "unsupported OS"; exit 0 ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) say "unsupported CPU"; exit 0 ;; esac
  # index.json is newest first; the first LTS (lts is a codename, not false) with major >= 22.
  ver=$(curl -fsSL https://nodejs.org/dist/index.json | tr '{' '\n' | grep '"lts":"' | grep -o '"version":"v[0-9.]*"' \
    | sed 's/.*"\(v[0-9.]*\)"/\1/' | awk -F. '{ if (substr($1,2)+0 >= 22) { print; exit } }')
  [ -n "$ver" ] || { say "could not find a Node.js LTS release"; exit 0; }
  name="node-$ver-$plat-$arch"
  base="https://nodejs.org/dist/$ver"
  mkdir -p "$tmp"
  curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz" || { say "Node.js download failed"; exit 0; }
  expected=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)
  else actual=$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1); fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { say "Node.js download failed its checksum check"; exit 0; }
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp" || exit 0
  [ -x "$NODE_DIR/bin/node" ] || mv "$tmp/$name" "$NODE_DIR"   # same folder: atomic rename
  exit 0
fi

# Start a background download unless one is already running (mkdir is atomic; stale after 10 min).
mkdir -p "$(dirname "$NODE_DIR")"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
if mkdir "$LOCK" 2>/dev/null; then
  say "Node.js is not installed; downloading a private copy for Social Listener (one time, about 30 MB)..."
  nohup sh "$0" "$NODE_DIR" --worker >/dev/null 2>&1 &
fi
i=0
while [ "$i" -lt $((MODE * 2)) ]; do
  [ -x "$NODE_DIR/bin/node" ] && exit 0
  sleep 0.5 2>/dev/null || sleep 1
  i=$((i + 1))
done
[ -x "$NODE_DIR/bin/node" ] && exit 0
exit 1
