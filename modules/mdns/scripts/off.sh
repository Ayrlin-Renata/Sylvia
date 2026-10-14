#!/bin/sh
# off.sh — stop the mDNS responder. The daemon already SIGCONT+SIGTERMed the
# process group; this cleans up any stragglers.
pkill -x avahi-daemon 2>/dev/null || true
pkill -x mdnsd 2>/dev/null || true
exit 0
