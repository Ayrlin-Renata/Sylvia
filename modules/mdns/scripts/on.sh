#!/bin/sh
# on.sh — start the mDNS responder in its OWN process group (setsid) so the
# netgate can SIGSTOP/SIGCONT it. This broadcasts on the local network — one of
# the primary "managed traffic" services. On Termux avahi may not be present;
# this uses a lightweight responder or the system daemon if available.
IFACE="${SYLVIA_MODULE_INTERFACE:-}"
if command -v avahi-daemon >/dev/null 2>&1; then
	setsid avahi-daemon --daemonize --no-drop-root </dev/null >/dev/null 2>&1 &
	echo "mdns: started avahi-daemon"
elif command -v mdnsd >/dev/null 2>&1; then
	setsid mdnsd </dev/null >/dev/null 2>&1 &
	echo "mdns: started mdnsd"
else
	echo "mdns: no responder found (avahi-daemon or mdnsd)" >&2
	exit 1
fi
