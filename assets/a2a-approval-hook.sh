#!/data/data/com.termux/files/usr/bin/bash
# Announce an A2A approval request to the Sylvia daemon.
#
# The plugin's approveCommand hook fires when an operator asks for authority.
# This script forwards the request to the daemon, which logs it, raises a
# Termux notification (when Termux:API is installed) and puts it in the
# panel's queue. The DECISION still goes to the plugin's admin endpoint —
# the hook only announces. Failure here is never fatal: the plugin's own
# broker queue is the durable surface.
set -u
DAEMON="${SYLVIA_DAEMON_PORT:-3090}"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
PAYLOAD=$(printf '{"id":"%s","reason":"%s","target":"%s","level":"%s","scope":"%s","ttlMs":%s}' \
  "$(esc "${NUNCIA_APPROVAL_ID:-}")" \
  "$(esc "${NUNCIA_APPROVAL_REASON:-}")" \
  "$(esc "${NUNCIA_APPROVAL_TARGET:-}")" \
  "$(esc "${NUNCIA_APPROVAL_LEVEL:-}")" \
  "$(esc "${NUNCIA_APPROVAL_SCOPE:-}")" \
  "${NUNCIA_APPROVAL_TTL_MS:-120000}")
curl -s -m 4 -X POST -H 'content-type: application/json' \
  -d "$PAYLOAD" "http://127.0.0.1:${DAEMON}/api/a2a/approval" >/dev/null 2>&1 || true
exit 0
