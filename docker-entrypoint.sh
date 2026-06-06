#!/bin/sh
# Secure-by-default entrypoint for the BHGBrain container.
#
# The image binds the HTTP API to 0.0.0.0 so the published port is reachable from
# the host. To avoid shipping an unauthenticated, externally-reachable memory API
# (or crash-looping on the fail-closed auth gate), this script ensures a bearer
# token exists before starting the server:
#
#   * If BHGBRAIN_TOKEN is already set, it is used as-is.
#   * Otherwise a token is generated, persisted to the data volume, and reused on
#     subsequent restarts so clients get a stable credential.
#   * Set BHGBRAIN_ALLOW_UNAUTHENTICATED=true to intentionally run open (the
#     server still warns); no token is generated in that case.
set -e

DATA_DIR="${BHGBRAIN_DATA_DIR:-/data}"
TOKEN_FILE="${DATA_DIR}/bhgbrain-token"

if [ -z "${BHGBRAIN_TOKEN}" ] && [ "${BHGBRAIN_ALLOW_UNAUTHENTICATED}" != "true" ]; then
  if [ -f "${TOKEN_FILE}" ]; then
    BHGBRAIN_TOKEN="$(cat "${TOKEN_FILE}")"
    export BHGBRAIN_TOKEN
  else
    BHGBRAIN_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
    export BHGBRAIN_TOKEN
    # Persist with owner-only permissions; data dir is a mounted volume.
    if (umask 077; printf '%s' "${BHGBRAIN_TOKEN}" > "${TOKEN_FILE}") 2>/dev/null; then
      SAVED="${TOKEN_FILE}"
    else
      SAVED="(could not write ${TOKEN_FILE}; token is in-memory only)"
    fi
    echo "============================================================" >&2
    echo "BHGBrain: no BHGBRAIN_TOKEN provided — generated a bearer token" >&2
    echo "so the externally-reachable HTTP API is authenticated by default." >&2
    echo "  token: ${BHGBRAIN_TOKEN}" >&2
    echo "  saved: ${SAVED}" >&2
    echo "Provide BHGBRAIN_TOKEN yourself for a stable credential, or set" >&2
    echo "BHGBRAIN_ALLOW_UNAUTHENTICATED=true to intentionally run open." >&2
    echo "============================================================" >&2
  fi
fi

exec "$@"
