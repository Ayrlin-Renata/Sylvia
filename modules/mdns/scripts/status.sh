#!/bin/sh
# status.sh — exit 0 = up. The mDNS responder is avahi/mdnsd or a custom
# broadcaster; check a known process is alive.
if pidof avahi-daemon >/dev/null 2>&1 || pidof mdnsd >/dev/null 2>&1; then
	exit 0
fi
exit 1
