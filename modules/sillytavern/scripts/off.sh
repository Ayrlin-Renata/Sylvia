#!/bin/sh
# off.sh — stop SillyTavern. The daemon already sent SIGCONT+SIGTERM to the
# process group; this is a best-effort cleanup for any stragglers.
pkill -f "node server.js" 2>/dev/null || true
exit 0
