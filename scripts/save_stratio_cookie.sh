#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/save_stratio_cookie.sh [output_file]
#
# Steps:
# 1) In browser devtools, copy the Stratio cookie VALUE only.
# 2) Run this script to save it into a local file.

OUT="${1:-$HOME/.secrets/stratio.cookie}"
mkdir -p "$(dirname "$OUT")"

if command -v pbpaste >/dev/null 2>&1; then
  COOKIE="$(pbpaste | tr -d '\r' | tr -d '\n')"
else
  echo "pbpaste is not available on this host."
  exit 1
fi

if [[ -z "${COOKIE}" ]]; then
  echo "Clipboard is empty. Copy Stratio cookie value first."
  exit 1
fi

printf "%s" "${COOKIE}" > "${OUT}"
chmod 600 "${OUT}"
echo "Saved cookie to ${OUT}"
