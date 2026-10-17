#!/data/data/com.termux/files/usr/bin/bash
# 9router on.sh — install (first run) + start the router.
#
# The daemon tracks THIS script's process as the service pid (it spawned us
# detached → own process group), so we must `exec` the service in the
# foreground: if we forked into the background and exited, the daemon would
# see the pid die and report "not running" (and for behavior=always, restart
# loop). `exec` keeps the same pid, which we record in run.pid for off.sh.
#
# The daemon writes settings.env (SYLVIA_MODULE_<KEY>=...) before every start;
# source it and fall back to the module.json schema defaults.
set -u
MOD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOD_DIR" || exit 1
[ -f settings.env ] && . ./settings.env
: "${SYLVIA_MODULE_PORT:=20128}"
: "${SYLVIA_MODULE_BIND:=127.0.0.1}"
: "${SYLVIA_MODULE_INITIALPASSWORD:=sylvia}"

BIN="$MOD_DIR/node_modules/.bin/9router"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Record the pid for the WHOLE lifecycle — including the first-run install
# below. Our pid survives the exec, so status.sh/off.sh see us from the first
# second (writing it only after install made status.sh falsely report
# "not running" for the entire install window).
echo "$$" > run.pid

# First run: fetch 9router into the module dir (self-contained — deleting the
# module dir uninstalls it). This needs the network and can take a few minutes
# (postinstall compiles better-sqlite3); progress is in install.log, not lost:
# the daemon spawns us with stdio ignored, so everything goes to log files.
if [ ! -x "$BIN" ]; then
  echo "[$(stamp)] installing 9router (first run, may take a few minutes)..." >> install.log
  if ! command -v npm >/dev/null 2>&1; then
    echo "[$(stamp)] npm not found on PATH" >> install.log
    exit 1
  fi
  if ! npm install --prefix "$MOD_DIR" 9router --no-audit --no-fund >> install.log 2>&1; then
    echo "[$(stamp)] npm install failed (see above) — check network / free space; status.sh will retry on next on" >> install.log
    exit 1
  fi
  echo "[$(stamp)] install finished" >> install.log
fi
[ -x "$BIN" ] || { echo "[$(stamp)] 9router binary missing after install" >> install.log; exit 1; }

# 9Router reads PORT (service port, default 20128), HOSTNAME (bind), and
# INITIAL_PASSWORD (dashboard login — without it the CLI may prompt via
# enquirer, and our stdio is ignored, so it would hang).
export PORT="$SYLVIA_MODULE_PORT"
export HOSTNAME="$SYLVIA_MODULE_BIND"
export INITIAL_PASSWORD="$SYLVIA_MODULE_INITIALPASSWORD"
export NEXT_PUBLIC_BASE_URL="http://127.0.0.1:$PORT"

echo "[$(stamp)] exec 9router (port=$PORT bind=$HOSTNAME)" >> service.log
# Flags, not env: the 9router CLI's own --help says -p/--port and -H/--host
# (default 0.0.0.0) — it IGNORES PORT/HOSTNAME env vars (we saw it bind
# 0.0.0.0 despite them). Also: never exec the npm bin directly — it carries
# `#!/usr/bin/env node` and Android has no /usr/bin/env ("bad interpreter").
# --no-browser: no browser to open on Android; --skip-update: no background
# self-upgrades rewriting node_modules under the daemon's feet.
# Env exports above are kept too — INITIAL_PASSWORD / NEXT_PUBLIC_BASE_URL
# are dashboard-level settings the flags don't cover.
exec node "$BIN" --port "$PORT" --host "$HOSTNAME" --no-browser --skip-update >> service.log 2>&1
