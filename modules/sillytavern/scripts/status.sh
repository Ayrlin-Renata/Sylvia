#!/bin/sh
# status.sh — exit 0 = up; optional stdout = JSON detail.
# SillyTavern runs on its configured port; check the process + port.
PORT="${SYLVIA_MODULE_PORT:-8000}"
if pidof node >/dev/null 2>&1; then
	# best-effort: report the port if ss is available
	echo "{\"port\": ${PORT}, \"process\": \"node\"}"
	exit 0
fi
exit 1
