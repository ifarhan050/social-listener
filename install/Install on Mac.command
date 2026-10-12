#!/bin/bash
# Double-click to install Social Listener. (First time: right-click -> Open, or allow it in
# System Settings -> Privacy & Security -> "Open Anyway".)
cd "$(dirname "$0")" || exit 1
echo "Setting up Social Listener. Keep this window open until it says All done."
bash ./install.sh
echo
read -r -p "Press Enter to close this window." _
