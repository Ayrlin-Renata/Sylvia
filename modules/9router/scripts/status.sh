#!/data/data/com.termux/files/usr/bin/bash
# 9router status.sh — exit 0 = up; stdout = optional status JSON (§9.1).
# "up" means the dashboard actually answers HTTP, not just that a pid lives:
# a pid that is alive but not serving is reported as starting/installing.
set -u
MOD_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MOD_DIR" || exit 1
[ -f settings.env ] && . ./settings.env
: "${SYLVIA_MODULE_PORT:=20128}"

port="$SYLVIA_MODULE_PORT"
url="http://127.0.0.1:$port"

pid=""
[ -f run.pid ] && pid="$(cat run.pid 2>/dev/null || true)"
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  printf '{"running":false,"port":%s}\n' "$port"
  exit 1
fi

code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url/" 2>/dev/null || true)"
[ -n "$code" ] || code="000"

# Any HTTP answer proves the server is serving — the dashboard answers
# 307 (redirect to the login page) before auth, and 401/404 count too.
# Only 000 = no connection at all.
if [ "$code" != "000" ]; then
  printf '{"running":true,"http":true,"port":%s,"url":"%s"}\n' "$port" "$url"
  exit 0
fi
if [ ! -x "node_modules/.bin/9router" ]; then
  # pid alive + no binary yet = the first-run npm install is in progress
  printf '{"running":true,"http":false,"phase":"installing","port":%s}\n' "$port"
  exit 1
fi
printf '{"running":true,"http":false,"phase":"starting","port":%s,"httpCode":"%s"}\n' "$port" "$code"
exit 1
