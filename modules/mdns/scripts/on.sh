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
	# Android has no avahi-daemon/mdnsd CLI: discovery there is the FRAMEWORK's
	# Network Service Discovery, which no shell process can drive, and Termux's
	# repositories carry neither package. This module therefore cannot run on
	# Termux as written — and being classified `always` made the daemon restart
	# it forever (death streak 7, exponential backoff: an "always on" service
	# that is never on). It is `manual` for exactly that reason.
	cat >&2 <<'MSG'
mdns: no responder available.
  Android ships neither an avahi-daemon nor an mdnsd CLI — mDNS there is the
  framework's Network Service Discovery, not a daemon. Starting this module
  will always fail; it is `manual` so the daemon does not churn on it.
  If you need mDNS, run your own userspace responder.
MSG
	exit 2
fi
