#!/bin/sh
# on.sh — start SillyTavern in its OWN process group (setsid) so the netgate
# can SIGSTOP/SIGCONT it on metered/offline. Reads settings from settings.env
# (SYLVIA_MODULE_* vars) written by the daemon before launch.
ST_DIR="${SYLVIA_TAVERN_DIR:-$HOME/SillyTavern}"
PORT="${SYLVIA_MODULE_PORT:-8000}"
BIND="${SYLVIA_MODULE_BIND:-127.0.0.1}"
if [ ! -d "$ST_DIR" ]; then
	echo "sillytavern: directory not found: $ST_DIR (set SYLVIA_TAVERN_DIR or clone SillyTavern there)" >&2
	exit 1
fi
cd "$ST_DIR" || exit 1
# setsid detaches into a new session/process-group; pid is the group leader.
setsid node server.js --listen --port "$PORT" --listenAddress "$BIND" </dev/null >/dev/null 2>&1 &
echo "sillytavern: started (port $PORT, bind $BIND)"
