#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   source scripts/set_stratio_env.sh /absolute/path/to/stratio.cookie
#
# Notes:
# - Must be sourced so env vars are available to backend/frontend shell.
# - Cookie file must contain only the raw `stratio` cookie value.

COOKIE_PATH="${1:-${STRATIO_COOKIE_PATH:-}}"
if [[ -z "${COOKIE_PATH}" ]]; then
  echo "Usage: source scripts/set_stratio_env.sh /absolute/path/to/stratio.cookie"
  return 1 2>/dev/null || exit 1
fi

if [[ ! -f "${COOKIE_PATH}" ]]; then
  echo "Cookie file not found: ${COOKIE_PATH}"
  return 1 2>/dev/null || exit 1
fi

export STRATIO_COOKIE_PATH="${COOKIE_PATH}"

# Platform endpoints (override as needed per environment)
export ROCKET_BASE_URL="${ROCKET_BASE_URL:-https://admin.aviva.stratio.com/rocket-pre}"
export STRATIO_API_BASE_URL="${STRATIO_API_BASE_URL:-${ROCKET_BASE_URL}}"
export STRATIO_REQUIRE_API_PING="${STRATIO_REQUIRE_API_PING:-false}"
export STRATIO_JDBC_URL="${STRATIO_JDBC_URL:-jdbc:virtualizer://<host>:<port>/<db>}"
export STRATIO_REQUIRE_JDBC="${STRATIO_REQUIRE_JDBC:-false}"

# Optional: command that performs JDBC "SELECT 1".
# Should exit 0 on success, non-zero on failure.
# Example:
# export STRATIO_JDBC_CHECK_COMMAND='python /opt/stratio/check_jdbc.py'
export STRATIO_JDBC_CHECK_COMMAND="${STRATIO_JDBC_CHECK_COMMAND:-}"

echo "Stratio env loaded."
echo "  STRATIO_COOKIE_PATH=${STRATIO_COOKIE_PATH}"
echo "  ROCKET_BASE_URL=${ROCKET_BASE_URL}"
echo "  STRATIO_API_BASE_URL=${STRATIO_API_BASE_URL}"
echo "  STRATIO_REQUIRE_API_PING=${STRATIO_REQUIRE_API_PING}"
echo "  STRATIO_JDBC_URL=${STRATIO_JDBC_URL}"
echo "  STRATIO_REQUIRE_JDBC=${STRATIO_REQUIRE_JDBC}"
if [[ -n "${STRATIO_JDBC_CHECK_COMMAND}" ]]; then
  echo "  STRATIO_JDBC_CHECK_COMMAND set"
else
  echo "  STRATIO_JDBC_CHECK_COMMAND is empty (JDBC health will fail until set)"
fi
