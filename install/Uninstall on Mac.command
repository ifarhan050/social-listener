#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash ./install.sh --uninstall
echo
read -r -p "Press Enter to close this window." _
