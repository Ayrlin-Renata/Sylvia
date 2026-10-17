#!/data/data/com.termux/files/usr/bin/bash
# 9router off.sh — stop the router started by on.sh.
# The daemon also SIGTERMs our whole process group as belt-and-braces after
# this script returns; we do the graceful sequence ourselves so shutdown
# details land in service.log.
set -u
MOD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOD_DIR" || exit 1
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

pid=""
[ -f run.pid ] && pid="$(cat run.pid 2>/dev/null || true)"

if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$(stamp)] pid $pid ignored SIGTERM — sending SIGKILL" >> service.log
    kill -KILL "$pid" 2>/dev/null || true
  fi
fi
rm -f run.pid
echo "[$(stamp)] stopped" >> service.log
exit 0
