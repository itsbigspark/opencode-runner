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

COOKIE=""

# macOS
if command -v pbpaste >/dev/null 2>&1; then
  COOKIE="$(pbpaste | tr -d '\r' | tr -d '\n')"
fi

# Wayland Linux
if [[ -z "${COOKIE}" ]] && command -v wl-paste >/dev/null 2>&1; then
  COOKIE="$(wl-paste --no-newline 2>/dev/null | tr -d '\r' | tr -d '\n')"
fi

# X11 Linux
if [[ -z "${COOKIE}" ]] && command -v xclip >/dev/null 2>&1; then
  COOKIE="$(xclip -o -selection clipboard 2>/dev/null | tr -d '\r' | tr -d '\n')"
fi

if [[ -z "${COOKIE}" ]] && command -v xsel >/dev/null 2>&1; then
  COOKIE="$(xsel --clipboard --output 2>/dev/null | tr -d '\r' | tr -d '\n')"
fi

# Fallback: manual paste
if [[ -z "${COOKIE}" ]]; then
  echo "No supported clipboard tool found or clipboard is empty."
  echo "Paste Stratio cookie value, then press Enter:"
  IFS= read -r COOKIE
  COOKIE="$(printf "%s" "${COOKIE}" | tr -d '\r' | tr -d '\n')"
fi

if [[ -z "${COOKIE}" ]]; then
  echo "Clipboard is empty. Copy Stratio cookie value first."
  exit 1
fi

# Accept either raw cookie value or full 'stratio-cookie=...'
if [[ "${COOKIE}" == stratio-cookie=* ]]; then
  COOKIE="${COOKIE#stratio-cookie=}"
fi

printf "%s" "${COOKIE}" > "${OUT}"
chmod 600 "${OUT}"