#!/bin/sh
# Starts the Social Listener plugin helper (MCP server) on macOS / Linux.
# Uses the app's private Node.js, or Node 18+ found on PATH or in the usual places (GUI apps on
# macOS don't read shell profiles), or downloads a private copy (no admin).
# stdout is the MCP channel: everything else goes to stderr.
DIR=$(cd "$(dirname "$0")" && pwd)
NODE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/social-listener/runtime/node"
PNODE="$NODE_DIR/bin/node"
PROXY="$DIR/mcp-proxy.js"

if [ -x "$PNODE" ]; then exec "$PNODE" "$PROXY"; fi
for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ] && "$n" -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" >/dev/null 2>&1; then
    exec "$n" "$PROXY"
  fi
done

sh "$DIR/get-node.sh" "$NODE_DIR" 25 >&2
if [ -x "$PNODE" ]; then exec "$PNODE" "$PROXY"; fi
echo "[social-listener] Still downloading Node.js in the background. Start a new chat in a minute and it will be ready." >&2
exit 1
