#!/usr/bin/env bash
# =============================================================================
#  Sylvia — consolidated agentic-AI harness installer for Android (Termux)
# =============================================================================
#  Installs, end to end:
#    1. Termux base packages     nodejs-lts, git, bash, tmux, android-tools (adb), rclone, uv, nmap
#    2. DSH Mobile CLI           npm -g @deepseek-ai/dsh
#    3. Mobile/Android patches   Ayrlin-Renata fork -> 12 local rc.7 tarballs
#    4. sylvia-mcp server        ADB loopback / Tasker XML / rclone JSON / network+resource+discovery
#    5. sylvia-daemon            control API :3090, network detection, netgate, registry, discovery
#    6. sylvia-bridge plugin     DSH harness gating (pause on metered / offline-gap context)
#    7. MCP registration         appends entries to ~/.dsh/profiles/web/cordis.patch.yml
#    8. Launchers + env          start-sylvia.sh, sylvia-adb-connect.sh, sylvia.env
#    9. mitmproxy + its MCP      CLI via `uv tool install`, mitmproxy-mcp source
#    10. Local modules           SillyTavern + mDNS reference modules -> module manager (§9)
#  Optional:
#    11. tasker-mcp              (--with-tasker) Go binary + Tasker HTTP API bridge
#
#  Design goals:
#    • Idempotent       — every module checks a precondition and skips when done.
#    • Fail-fast        — stops on the FIRST failing module with a clear message.
#    • Non-destructive  — APPENDS to cordis.patch.yml; never rewrites existing config.
#    • Device-agnostic  — physical phone and Android Studio emulator share this path.
#
#  Usage:
#      bash install.sh                 # core install
#      bash install.sh --with-tasker   # + tasker-mcp
#      bash install.sh --force         # regenerate launchers + sylvia.env even if present
#
#  Env overrides (all optional):
#      SYLVIA_REPO_URL       git URL of THIS repo
#      SYLVIA_DSH_REPO       git URL of the DSH Mobile fork
#      SYLVIA_HOME           install root                     (default $HOME/.sylvia)
#      SYLVIA_WEB_PORT       DSH web port                     (default 3080)
#      SYLVIA_DAEMON_PORT    Sylvia control-panel port        (default 3090)
#      SYLVIA_ADB_PORT       loopback ADB port                (default 5555 = emulator)
#      SYLVIA_ADB_MODE       auto | emulator                  (default auto)
#      SYLVIA_TASKER_API_KEY required only with --with-tasker
# =============================================================================
# -E (errtrace) so the ERR trap fires inside functions too — otherwise a
# failure mid-module exits silently instead of printing the module banner.
set -Eeuo pipefail

# ---- tunable defaults -------------------------------------------------------
SYLVIA_REPO_URL="${SYLVIA_REPO_URL:-https://github.com/Ayrlin-Renata/Sylvia.git}"
SYLVIA_DSH_REPO="${SYLVIA_DSH_REPO:-https://github.com/Ayrlin-Renata/Deepseek-harness-mobile.git}"
SYLVIA_HOME="${SYLVIA_HOME:-$HOME/.sylvia}"
SYLVIA_WEB_PORT="${SYLVIA_WEB_PORT:-3080}"
SYLVIA_DAEMON_PORT="${SYLVIA_DAEMON_PORT:-3090}"
SYLVIA_ADB_PORT="${SYLVIA_ADB_PORT:-5555}"
SYLVIA_ADB_MODE="${SYLVIA_ADB_MODE:-auto}"

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
FORCE=0
WITH_TASKER=0
CURRENT_MODULE="bootstrap"

# ---- tiny output helpers ----------------------------------------------------
c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_cyn=$'\033[36m'
log()  { printf '%s\n' "$*"; }
head_() { printf '\n%s=== %s ===%s\n' "$c_cyn" "$*" "$c_reset"; }
ok()   { printf '%s  ✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
skip() { printf '%s  ○%s %s\n' "$c_dim" "$c_reset" "$* (skipped)"; }
note() { printf '%s  ·%s %s\n' "$c_dim" "$c_reset" "$*"; }
warn() { printf '%s  !%s %s\n' "$c_ylw" "$c_reset" "$*"; }
die()  { printf '\n%s✗ FAILED in module: %s%s\n' "$c_red" "$CURRENT_MODULE" "$c_reset";
         printf '%s\n' "$1" >&2; exit "${2:-1}"; }

on_err() {
  local code=$1 line=$2
  printf '\n%s✗ FAILED in module: %s (line %s, exit %s)%s\n' "$c_red" "$CURRENT_MODULE" "$line" "$code" "$c_reset"
  printf '  Fix the error above, then re-run  %sbash install.sh%s — it is idempotent,\n' "$c_cyn" "$c_reset"
  printf '  so every module that already completed will be skipped.\n'
  exit "$code"
}
trap 'on_err $? $LINENO' ERR

have() { command -v "$1" >/dev/null 2>&1; }
ensure_dir() { mkdir -p "$1"; }

# =============================================================================
#  MODULE 1 — prerequisites
# =============================================================================
module_preconditions() {
  CURRENT_MODULE="preconditions"

  if [ -z "${TERMUX_VERSION:-}" ] && [ -z "${SYLVIA_FORCE:-}" ]; then
    die "This installer targets Termux on Android (F-Droid build).
       It does not look like a Termux session (TERMUX_VERSION unset).
       To run anyway for development/testing, re-run with:  SYLVIA_FORCE=1 bash install.sh"
  fi
  ok "prerequisites (Termux session)"
}

# =============================================================================
#  MODULE 2 — Termux base packages
# =============================================================================
module_base_packages() {
  CURRENT_MODULE="base packages"

  local missing=()
  have git   || missing+=(git)
  have bash  || missing+=(bash)
  have adb   || missing+=(android-tools)   # provides adb
  have rclone || missing+=(rclone)
  have tmux  || missing+=(tmux)            # launcher persistence (start-sylvia.sh)
  have node  || missing+=(nodejs-lts)      # Node ^22.19 || >=24 for node:sqlite
  have uv    || missing+=(uv)              # mitmproxy install + mitmproxy-mcp launcher
  have nmap  || missing+=(nmap)            # LAN discovery (daemon discovery_scan tool)

  if [ ${#missing[@]} -eq 0 ]; then
    skip "all base packages present (git, bash, adb, rclone, tmux, node, uv, nmap)"
  else
    note "installing: ${missing[*]}"
    pkg update -y >/dev/null 2>&1 || warn "pkg update returned non-zero; continuing"
    pkg install -y "${missing[@]}" || die "pkg install failed for: ${missing[*]}"
    ok "installed base packages: ${missing[*]}"
  fi

  # node is now guaranteed present (either pre-existing or just installed).
  # node:sqlite is the hard requirement the DSH session store depends on.
  have node || die "node not found after package install. In Termux run:  pkg install -y nodejs-lts"
  if ! node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))"; then
    die "node:sqlite is unavailable. Upgrade Node:  pkg upgrade nodejs-lts
       (needs Node ^22.19 || >=24). Then re-run this installer."
  fi
  ok "node $(node -v), node:sqlite"
}

# =============================================================================
#  MODULE 3 — DSH Mobile CLI (npm -g @deepseek-ai/dsh)
# =============================================================================
DSH_GLOBAL_LIB="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai/dsh"

module_dsh_cli() {
  CURRENT_MODULE="DSH CLI"

  if have dsh && [ -f "$DSH_GLOBAL_LIB/lib/bin.js" ]; then
    skip "DSH CLI already installed ($DSH_GLOBAL_LIB)"
    return 0
  fi
  note "installing @deepseek-ai/dsh globally (native-addon build warnings are harmless)"
  npm install --global @deepseek-ai/dsh || die "npm install -g @deepseek-ai/dsh failed"
  [ -f "$DSH_GLOBAL_LIB/lib/bin.js" ] || die "DSH bin.js not found at $DSH_GLOBAL_LIB/lib/bin.js after install"
  ok "DSH CLI installed"
}

# =============================================================================
#  MODULE 4 — Mobile/Android patches (fork installer, 12 local rc.7 tarballs)
# =============================================================================
# The fork's install.sh does `cd $(dirname $0)` and expects the 12 tarballs
# beside it, so we clone the fork and run install/install.sh in place.
module_dsh_patch() {
  CURRENT_MODULE="DSH mobile patch"

  # Idempotency canary: dsh-client-ui-layout only exists (at rc.7) once the
  # patcher has run. It is one of the 12 local tarballs the patcher overlays.
  local canary="$DSH_GLOBAL_LIB/dsh-client-ui-layout/package.json"
  if [ -f "$canary" ] && node -e "process.exit(require(process.argv[1]).version==='0.1.0-rc.7'?0:1)" "$canary"; then
    skip "mobile patch already applied (rc.7 packages present)"
    return 0
  fi

  local fork_dir="$SYLVIA_HOME/dsh-mobile"
  if [ ! -f "$fork_dir/install/install.sh" ]; then
    ensure_dir "$SYLVIA_HOME"
    note "cloning DSH fork: $SYLVIA_DSH_REPO"
    rm -rf "$fork_dir"
    git clone --depth 1 "$SYLVIA_DSH_REPO" "$fork_dir" || die "git clone of DSH fork failed ($SYLVIA_DSH_REPO)"
  else
    skip "fork already cloned ($fork_dir)"
  fi

  note "running fork patcher (install/install.sh)"
  bash "$fork_dir/install/install.sh" || die "fork patcher (install/install.sh) failed"

  [ -f "$canary" ] || die "patcher finished but $canary is still missing"
  ok "mobile/Android patches applied (12 rc.7 packages)"
}

# =============================================================================
#  MODULE 5 — sylvia-mcp server source + deps
# =============================================================================
SYLVIA_MCP_DIR=""

module_sylvia_mcp() {
  CURRENT_MODULE="sylvia-mcp"

  # Prefer the copy shipped next to this script (repo checkout). Otherwise clone.
  if [ -f "$SCRIPT_DIR/sylvia-mcp/index.js" ]; then
    SYLVIA_MCP_DIR="$SCRIPT_DIR/sylvia-mcp"
    note "using local sylvia-mcp ($SYLVIA_MCP_DIR)"
  else
    SYLVIA_MCP_DIR="$SYLVIA_HOME/sylvia-mcp"
    if [ ! -f "$SYLVIA_MCP_DIR/index.js" ]; then
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for sylvia-mcp: $SYLVIA_REPO_URL"
      local repo_dir="$SYLVIA_HOME/repo"
      rm -rf "$repo_dir"
      git clone --depth 1 "$SYLVIA_REPO_URL" "$repo_dir" || die "git clone of Sylvia repo failed ($SYLVIA_REPO_URL)"
      rm -rf "$SYLVIA_MCP_DIR"
      cp -r "$repo_dir/sylvia-mcp" "$SYLVIA_MCP_DIR" || die "could not copy sylvia-mcp out of cloned repo"
    else
      skip "sylvia-mcp already cloned ($SYLVIA_MCP_DIR)"
    fi
  fi

  if [ -d "$SYLVIA_MCP_DIR/node_modules/@modelcontextprotocol" ]; then
    skip "sylvia-mcp node_modules present"
  else
    note "npm install in sylvia-mcp"
    ( cd "$SYLVIA_MCP_DIR" && npm install --omit=dev ) || die "npm install in sylvia-mcp failed"
    ok "sylvia-mcp dependencies installed"
  fi

  # Smoke-test that the server still boots and lists its 9 tools.
  node -e "
    import('node:child_process').then(async ({ execFileSync }) => {
      const out = execFileSync(process.execPath, ['index.js'], {
        cwd: process.argv[1], input:
          JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'probe',version:'0'}}}) + '\n' +
          JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}}) + '\n' +
          JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}) + '\n',
        timeout: 15000
      }).toString();
      const expected = ['resilient_adb_exec','tasker_write_and_reload','rclone_exec',
                        'network_state','traffic_gate','resource_list','resource_resolve',
                        'resource_call','discovery_scan'];
      const missing = expected.filter(t => !out.includes('\"name\":\"'+t+'\"'));
      if (missing.length) { console.error('sylvia-mcp probe: missing tools: ' + missing.join(', ')); process.exit(1); }
    }).catch(e => { console.error('sylvia-mcp probe failed: ' + e.message); process.exit(1); });
  " "$SYLVIA_MCP_DIR" || die "sylvia-mcp failed its stdio handshake probe"
  ok "sylvia-mcp verified (9 tools register over stdio)"
}

# =============================================================================
#  MODULE 5b — sylvia-daemon (control API, network detect, netgate, registry)
# =============================================================================
# Zero runtime deps (node:http + node built-ins), so there is nothing to npm
# install — just place the source and confirm it boots.
SYLVIA_DAEMON_DIR=""

module_sylvia_daemon() {
  CURRENT_MODULE="sylvia-daemon"

  if [ -f "$SCRIPT_DIR/sylvia-daemon/index.js" ]; then
    SYLVIA_DAEMON_DIR="$SYLVIA_HOME/sylvia-daemon"
    if [ ! -f "$SYLVIA_DAEMON_DIR/index.js" ]; then
      ensure_dir "$SYLVIA_HOME"
      cp -r "$SCRIPT_DIR/sylvia-daemon" "$SYLVIA_DAEMON_DIR" || die "could not copy sylvia-daemon"
      ok "sylvia-daemon installed ($SYLVIA_DAEMON_DIR)"
    else
      skip "sylvia-daemon already present ($SYLVIA_DAEMON_DIR)"
    fi
  else
    SYLVIA_DAEMON_DIR="$SYLVIA_HOME/sylvia-daemon"
    if [ ! -f "$SYLVIA_DAEMON_DIR/index.js" ]; then
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for sylvia-daemon: $SYLVIA_REPO_URL"
      local repo_dir="$SYLVIA_HOME/repo"
      if [ ! -d "$repo_dir" ]; then
        git clone --depth 1 "$SYLVIA_REPO_URL" "$repo_dir" || die "git clone of Sylvia repo failed ($SYLVIA_REPO_URL)"
      fi
      rm -rf "$SYLVIA_DAEMON_DIR"
      cp -r "$repo_dir/sylvia-daemon" "$SYLVIA_DAEMON_DIR" || die "could not copy sylvia-daemon out of cloned repo"
      ok "sylvia-daemon installed ($SYLVIA_DAEMON_DIR)"
    else
      skip "sylvia-daemon already present ($SYLVIA_DAEMON_DIR)"
    fi
  fi

  # Ensure the state root exists (registry/netstate/module files live here).
  ensure_dir "$SYLVIA_HOME"

  # Boot probe: import the entry and confirm the config + key modules load.
  node -e "
    import(process.argv[1]).then(m => {
      if (typeof m.main !== 'function' && typeof m.startApi !== 'function') {
        console.error('sylvia-daemon probe: entry does not export main/startApi'); process.exit(1);
      }
    }).catch(e => { console.error('sylvia-daemon probe failed: ' + e.message); process.exit(1); });
  " "$SYLVIA_DAEMON_DIR/index.js" || die "sylvia-daemon failed its load probe"
  ok "sylvia-daemon verified (loads without error)"
}

# =============================================================================
#  MODULE 5c — sylvia-bridge DSH plugin (harness gating on metered/offline)
# =============================================================================
SYLVIA_BRIDGE_DIR=""

module_sylvia_bridge() {
  CURRENT_MODULE="sylvia-bridge"

  if [ -f "$SCRIPT_DIR/sylvia-bridge/package.json" ]; then
    SYLVIA_BRIDGE_DIR="$SYLVIA_HOME/sylvia-bridge"
    if [ ! -f "$SYLVIA_BRIDGE_DIR/package.json" ]; then
      ensure_dir "$SYLVIA_HOME"
      cp -r "$SCRIPT_DIR/sylvia-bridge" "$SYLVIA_BRIDGE_DIR" || die "could not copy sylvia-bridge"
      ok "sylvia-bridge source installed ($SYLVIA_BRIDGE_DIR)"
    else
      skip "sylvia-bridge already present ($SYLVIA_BRIDGE_DIR)"
    fi
  else
    SYLVIA_BRIDGE_DIR="$SYLVIA_HOME/sylvia-bridge"
    if [ ! -f "$SYLVIA_BRIDGE_DIR/package.json" ]; then
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for sylvia-bridge: $SYLVIA_REPO_URL"
      local repo_dir="$SYLVIA_HOME/repo"
      if [ ! -d "$repo_dir" ]; then
        git clone --depth 1 "$SYLVIA_REPO_URL" "$repo_dir" || die "git clone of Sylvia repo failed ($SYLVIA_REPO_URL)"
      fi
      rm -rf "$SYLVIA_BRIDGE_DIR"
      cp -r "$repo_dir/sylvia-bridge" "$SYLVIA_BRIDGE_DIR" || die "could not copy sylvia-bridge out of cloned repo"
      ok "sylvia-bridge source installed ($SYLVIA_BRIDGE_DIR)"
    else
      skip "sylvia-bridge already present ($SYLVIA_BRIDGE_DIR)"
    fi
  fi
}

# =============================================================================
#  MODULE 6 — register MCP servers in cordis.patch.yml
# =============================================================================
CORDIS_FILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"

# Symlink the bridge plugin into the DSH profile's node_modules so cordis can
# resolve it, then append its insert row (id-guarded, never duplicated).
_register_sylvia_bridge() {
  [ -n "$SYLVIA_BRIDGE_DIR" ] || { warn "sylvia-bridge source not installed; skipping bridge registration"; return 0; }
  local profile_nm="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules"
  ensure_dir "$profile_nm"
  if [ ! -e "$profile_nm/sylvia-bridge" ]; then
    ln -s "$SYLVIA_BRIDGE_DIR" "$profile_nm/sylvia-bridge" || die "could not link sylvia-bridge into profile"
    ok "linked sylvia-bridge -> profile node_modules"
  fi
  _cordis_append_plugin "sylvia-bridge" "sylvia-bridge"
}

# Append one MCP server entry to the cordis patch layer, guarded by its id so a
# re-run never duplicates. We APPEND as text (never parse+reserialize) because
# the file may contain !!js expressions and comments a YAML round-trip would drop.
_cordis_append() {
  local id="$1" payload="$2"
  ensure_dir "$(dirname "$CORDIS_FILE")"
  if [ ! -f "$CORDIS_FILE" ]; then
    printf '# Sylvia-managed MCP registrations (appended by install.sh).\n' > "$CORDIS_FILE"
  fi
  if grep -qE "^- id: ${id}\$" "$CORDIS_FILE"; then
    skip "cordis entry already present (id: $id)"
    return 0
  fi
  # Ensure a separating newline, then append the top-level array item.
  [ -s "$CORDIS_FILE" ] && [ "$(tail -c1 "$CORDIS_FILE" | wc -l)" -eq 0 ] && printf '\n' >> "$CORDIS_FILE"
  printf '%s\n' "$payload" >> "$CORDIS_FILE"
  ok "registered MCP server (id: $id, tools: mcp__<serverName>__*)"
}

# Cordis plugins are registered with a different shape than MCP servers: an
# `insert` list carrying {id, name}. Same id-guarding + no-reserialize rules.
_cordis_append_plugin() {
  local id="$1" pkg="$2"
  ensure_dir "$(dirname "$CORDIS_FILE")"
  if [ ! -f "$CORDIS_FILE" ]; then
    printf '# Sylvia-managed registrations (appended by install.sh).\n' > "$CORDIS_FILE"
  fi
  if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${id}\$" "$CORDIS_FILE"; then
    skip "cordis plugin already registered (id: $id)"
    return 0
  fi
  [ -s "$CORDIS_FILE" ] && [ "$(tail -c1 "$CORDIS_FILE" | wc -l)" -eq 0 ] && printf '\n' >> "$CORDIS_FILE"
  cat >> "$CORDIS_FILE" <<EOF
- insert:
    - id: ${id}
      name: "${pkg}"
EOF
  ok "registered DSH plugin (id: $id)"
}

module_register_mcp() {
  CURRENT_MODULE="MCP registration"

  local adb_path; adb_path="$(command -v adb || echo "/data/data/com.termux/files/usr/bin/adb")"
  # Deferred here (not at top level): node is only guaranteed present once
  # module_base_packages has run, so resolving it earlier aborts fresh installs.
  local node_bin; node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] || die "node not found on PATH — cannot register the MCP servers"

  # --- sylvia-mcp (always) ---------------------------------------------------
  _cordis_append "sylvia-mcp" "$(cat <<EOF
- id: sylvia-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: "stdio"
    serverName: sylvia
    command: "$node_bin"
    args:
      - "$SYLVIA_MCP_DIR/index.js"
    env:
      SYLVIA_ADB_PATH: "$adb_path"
      SYLVIA_ADB_HOST: "127.0.0.1"
      SYLVIA_ADB_PORT: "$SYLVIA_ADB_PORT"
      SYLVIA_ADB_MODE: "$SYLVIA_ADB_MODE"
      SYLVIA_TASKER_DIR: "/sdcard/Tasker"
      SYLVIA_DAEMON_URL: "http://127.0.0.1:$SYLVIA_DAEMON_PORT"
      SYLVIA_NETSTATE_FILE: "$SYLVIA_HOME/netstate.json"
    cwd: "$SYLVIA_MCP_DIR"
    toolCallTimeoutMs: 60000
EOF
)"

  # --- sylvia-bridge (DSH plugin — harness gating) --------------------------
  # Registered as a cordis plugin insert (not an MCP server). The plugin is
  # resolved from the profile's node_modules, so we symlink it there first.
  _register_sylvia_bridge

  # --- tasker-mcp (optional) -------------------------------------------------
  if [ "$WITH_TASKER" -eq 1 ]; then
    [ -n "${SYLVIA_TASKER_API_KEY:-}" ] || die "--with-tasker requires SYLVIA_TASKER_API_KEY.
       Import dist/mcp_server.prj.xml into Tasker, run 'MCP generate_api_key',
       then re-run:  SYLVIA_TASKER_API_KEY=<key> bash install.sh --with-tasker"
    local tm_bin="$SYLVIA_HOME/tasker-mcp/tasker-mcp-server-cli"
    local tm_tools="$SYLVIA_HOME/tasker-mcp/toolDescriptions.json"
    _cordis_append "tasker-mcp" "$(cat <<EOF
- id: tasker-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: "stdio"
    serverName: tasker
    command: "$tm_bin"
    args:
      - "--tools"
      - "$tm_tools"
      - "--tasker-host"
      - "127.0.0.1"
      - "--tasker-port"
      - "1821"
      - "--tasker-api-key"
      - "$SYLVIA_TASKER_API_KEY"
      - "--mode"
      - "stdio"
    toolCallTimeoutMs: 30000
EOF
)"
  fi

  # --- mitmproxy-mcp --------------------------------------------------------
  {
    local mitm_dir="$SYLVIA_HOME/mitmproxy-mcp"
    _cordis_append "mitmproxy-mcp" "$(cat <<EOF
- id: mitmproxy-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: "stdio"
    serverName: mitmproxy
    command: "uvx"
    args:
      - "--from"
      - "$mitm_dir"
      - "mitmproxy-mcp"
    cwd: "$mitm_dir"
    toolCallTimeoutMs: 30000
EOF
)"
  }
}

# =============================================================================
#  MODULE 7 — launchers + env file
# =============================================================================
module_launchers() {
  CURRENT_MODULE="launchers + env"

  ensure_dir "$SYLVIA_HOME"

  # The env file is the one artifact users hand-edit (ports, DSH_HOME, API
  # routing). Respect that: skip regeneration when it already exists, unless
  # --force was passed. The two shell launchers are always (re)written since
  # they are derived, not user-owned.
  if [ "$FORCE" -eq 0 ] && [ -f "$SYLVIA_HOME/sylvia.env" ]; then
    skip "sylvia.env already exists (pass --force to regenerate)"
  else
    local adb_path_env; adb_path_env="$(command -v adb || echo "/data/data/com.termux/files/usr/bin/adb")"
    cat > "$SYLVIA_HOME/sylvia.env" <<EOF
# Sylvia runtime environment — sourced by start-sylvia.sh.
# Re-run install.sh to regenerate; edit freely, it is not overwritten unless --force.
export SYLVIA_HOME="$SYLVIA_HOME"
export DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
export DSH_PERMISSION_MODE="\${DSH_PERMISSION_MODE:-danger-full-access}"
export DSH_TELEMETRY_DISABLED="\${DSH_TELEMETRY_DISABLED:-1}"
export SYLVIA_WEB_PORT="$SYLVIA_WEB_PORT"
export SYLVIA_DAEMON_PORT="$SYLVIA_DAEMON_PORT"
export SYLVIA_STATE_DIR="$SYLVIA_HOME"
export SYLVIA_ADB_PATH="$adb_path_env"
export SYLVIA_ADB_HOST="127.0.0.1"
export SYLVIA_ADB_PORT="$SYLVIA_ADB_PORT"
export SYLVIA_ADB_MODE="$SYLVIA_ADB_MODE"
EOF
    ok "wrote $SYLVIA_HOME/sylvia.env"
  fi

  # --- start-sylvia.sh -------------------------------------------------------
  local dsh_bin="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
  cat > "$SYLVIA_HOME/start-sylvia.sh" <<EOF
#!/usr/bin/env bash
# Start Sylvia: the control daemon (background) + the DSH harness web UI (foreground).
# Run inside tmux for persistence.
set -euo pipefail
[ -f "$SYLVIA_HOME/sylvia.env" ] && . "$SYLVIA_HOME/sylvia.env"
export PATH="\${PREFIX:-/data/data/com.termux/files/usr}/bin:\$PATH"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

# Start the daemon if it is not already listening (best-effort, non-blocking).
if [ -f "$SYLVIA_HOME/sylvia-daemon/index.js" ]; then
  if ! curl -sf "http://127.0.0.1:\${SYLVIA_DAEMON_PORT:-3090}/api/health" >/dev/null 2>&1; then
    nohup node "$SYLVIA_HOME/sylvia-daemon/index.js" \
      >> "$SYLVIA_HOME/sylvia-daemon.log" 2>&1 &
    echo "  sylvia-daemon started (http://127.0.0.1:\${SYLVIA_DAEMON_PORT:-3090})"
  fi
fi

exec node --expose-internals "$dsh_bin" web --port "\${SYLVIA_WEB_PORT:-3080}"
EOF
  chmod +x "$SYLVIA_HOME/start-sylvia.sh"
  ok "wrote $SYLVIA_HOME/start-sylvia.sh"

  # --- sylvia-adb-connect.sh -------------------------------------------------
  cat > "$SYLVIA_HOME/sylvia-adb-connect.sh" <<EOF
#!/usr/bin/env bash
# Establish the localhost ADB loopback (the agent's "hands").
#   emulator : connects to 127.0.0.1:\${SYLVIA_ADB_PORT:-5555} (adbd already listens on TCP)
#   physical : discovers the Wireless-Debugging TLS port via adb mdns, then connects
set -euo pipefail
[ -f "$SYLVIA_HOME/sylvia.env" ] && . "$SYLVIA_HOME/sylvia.env"
ADB="\${SYLVIA_ADB_PATH:-adb}"
HOST="\${SYLVIA_ADB_HOST:-127.0.0.1}"
PORT="\${SYLVIA_ADB_PORT:-5555}"
MODE="\${SYLVIA_ADB_MODE:-auto}"

is_emulator() {
  "\$ADB" devices 2>/dev/null | grep -q emulator
}

connect_port() {
  local p="\$1"
  echo "  adb connect \$HOST:\$p"
  "\$ADB" connect "\$HOST:\$p" || return 1
}

if [ "\$MODE" = "emulator" ] || { [ "\$MODE" = "auto" ] && is_emulator; }; then
  echo "Emulator loopback -> \$HOST:\$PORT"
  connect_port "\$PORT"
else
  echo "Discovering Wireless-Debugging port via adb mdns ..."
  PORT="\$( "\$ADB" mdns services 2>/dev/null \
      | sed -n 's/.*_adb-tls-connect._tcp[[:space:]]\{1,\}\([0-9]\{1,5\}\).*/\1/p' \
      | head -n1 )"
  if [ -z "\$PORT" ]; then
    echo "  Could not auto-discover a port. Enable Developer options -> Wireless"
    echo "  debugging, then run:  \$0 <port>   (the port is shown on that screen)."
    [ -n "\${1:-}" ] || exit 1
    PORT="\$1"
  fi
  connect_port "\$PORT"
fi

"\$ADB" devices
EOF
  chmod +x "$SYLVIA_HOME/sylvia-adb-connect.sh"
  ok "wrote $SYLVIA_HOME/sylvia-adb-connect.sh"
}

# =============================================================================
#  MODULE 8 (optional) — tasker-mcp binary
# =============================================================================
module_tasker_mcp() {
  CURRENT_MODULE="tasker-mcp"
  [ "$WITH_TASKER" -eq 1 ] || { skip "tasker-mcp not requested (--with-tasker)"; return 0; }

  local dir="$SYLVIA_HOME/tasker-mcp"
  if [ -f "$dir/tasker-mcp-server-cli" ] && [ -f "$dir/toolDescriptions.json" ]; then
    skip "tasker-mcp already installed ($dir)"
    return 0
  fi

  # Select the prebuilt CLI matching this device's CPU. Physical phones are
  # aarch64; the Android Studio emulator is often x86_64. Pick by uname -m so
  # the same script works on both.
  local arch
  case "$(uname -m)" in
    x86_64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) die "unsupported CPU for tasker-mcp: $(uname -m) (expected aarch64 or x86_64)" ;;
  esac

  # Pull only the tasker-mcp repo (sparse) to get the prebuilt CLI + tools JSON.
  if [ -d "$SCRIPT_DIR/reference/tasker-mcp" ]; then
    ensure_dir "$dir"
    cp "$SCRIPT_DIR/reference/tasker-mcp/dist/tasker-mcp-server-cli-$arch" "$dir/tasker-mcp-server-cli" \
      || die "could not copy tasker-mcp CLI from reference/"
    cp "$SCRIPT_DIR/reference/tasker-mcp/dist/toolDescriptions.json" "$dir/toolDescriptions.json" \
      || die "could not copy tasker-mcp toolDescriptions.json"
  else
    local tmp="$SYLVIA_HOME/.tasker-mcp-src"
    rm -rf "$tmp"
    git clone --depth 1 --filter=blob:none --sparse https://github.com/dceluis/tasker-mcp.git "$tmp" \
      || die "git clone of tasker-mcp failed"
    ( cd "$tmp" && git sparse-checkout set dist ) || die "sparse-checkout of tasker-mcp dist failed"
    ensure_dir "$dir"
    cp "$tmp/dist/tasker-mcp-server-cli-$arch" "$dir/tasker-mcp-server-cli" || die "tasker-mcp CLI missing from dist/"
    cp "$tmp/dist/toolDescriptions.json" "$dir/toolDescriptions.json" || die "toolDescriptions.json missing from dist/"
    rm -rf "$tmp"
  fi
  chmod +x "$dir/tasker-mcp-server-cli"
  ok "tasker-mcp installed ($dir)"
}

# =============================================================================
#  MODULE 9 — mitmproxy (CLI via uv) + mitmproxy-mcp source
# =============================================================================
# mitmproxy is a core dependency, not an optional extra. Two pieces:
#   1. the mitmproxy CLI (mitmproxy/mitmdump/mitmweb), installed via
#      `uv tool install mitmproxy` into ~/.local/bin so the agent can launch
#      intercepts directly;
#   2. the mitmproxy-mcp source, registered in module_register_mcp and run via
#      `uvx`, which resolves its own mitmproxy>=12 dependency at launch.
# uv resolves the Termux Python correctly on current uv builds (astral-sh/uv#7373
# closed by #9005), so no pip/rust workaround is needed.
module_mitm_mcp() {
  CURRENT_MODULE="mitmproxy"

  # 1. mitmproxy CLI on PATH (uvx-managed tool env; skip if already present).
  if have mitmdump; then
    skip "mitmproxy CLI already installed ($(command -v mitmdump))"
  else
    note "installing mitmproxy via 'uv tool install' (first run resolves wheels)"
    uv tool install mitmproxy || die "uv tool install mitmproxy failed"
    have mitmdump || {
      # uv installs tool executables to ~/.local/bin; ensure it is on PATH for
      # this session and for future shells before declaring success.
      export PATH="$HOME/.local/bin:$PATH"
      grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
      have mitmdump || die "mitmproxy installed but mitmdump not on PATH. Add ~/.local/bin to PATH and re-run."
    }
    ok "mitmproxy CLI installed ($(command -v mitmdump))"
  fi

  # 2. mitmproxy-mcp source (the MCP server uvx will launch).
  local dir="$SYLVIA_HOME/mitmproxy-mcp"
  if [ -f "$dir/pyproject.toml" ]; then
    skip "mitmproxy-mcp already cloned ($dir)"
    return 0
  fi
  if [ -d "$SCRIPT_DIR/reference/mitmproxy-mcp" ]; then
    ensure_dir "$SYLVIA_HOME"
    rm -rf "$dir"; cp -r "$SCRIPT_DIR/reference/mitmproxy-mcp" "$dir" || die "could not copy mitmproxy-mcp from reference/"
  else
    ensure_dir "$SYLVIA_HOME"
    git clone --depth 1 https://github.com/snapspecter/mitmproxy-mcp.git "$dir" || die "git clone of mitmproxy-mcp failed"
  fi
  ok "mitmproxy-mcp source ready ($dir)"
}

# =============================================================================
#  SUMMARY
# =============================================================================
print_summary() {
  CURRENT_MODULE="summary"
  printf '\n%s\n' "──────────────────────────────────────────────────────────────"
  printf '%sSylvia install complete.%s\n' "$c_grn" "$c_reset"
  printf '──────────────────────────────────────────────────────────────\n'
  cat <<EOF
  Install root   $SYLVIA_HOME
  sylvia-mcp     $SYLVIA_MCP_DIR
  sylvia-daemon  $SYLVIA_DAEMON_DIR
  sylvia-bridge  $SYLVIA_BRIDGE_DIR
  Cordis config  $CORDIS_FILE
  Harness port   http://127.0.0.1:${SYLVIA_WEB_PORT}
  Control panel  http://127.0.0.1:${SYLVIA_DAEMON_PORT}

  1. Connect the ADB loopback (the agent's "hands"):
         tmux new -s sylvia
         $SYLVIA_HOME/sylvia-adb-connect.sh

     Emulator is auto-detected (port ${SYLVIA_ADB_PORT}). On a physical phone enable
     Developer options -> Wireless debugging first; the helper discovers the port.

  2. Start the harness (this also starts sylvia-daemon in the background):
         $SYLVIA_HOME/start-sylvia.sh

  3. Open http://127.0.0.1:${SYLVIA_WEB_PORT} in the phone browser, enter your model
     API key on the Models page, and ask the agent to run something, e.g.
     "use mcp__sylvia__resilient_adb_exec to print the device model".

  4. Open http://127.0.0.1:${SYLVIA_DAEMON_PORT} for the control panel — network
     state, netgate, resource ownership, and module management.

  Tools surface as:  mcp__sylvia__resilient_adb_exec
                     mcp__sylvia__tasker_write_and_reload
                     mcp__sylvia__rclone_exec
                     mcp__sylvia__network_state
                     mcp__sylvia__traffic_gate
                     mcp__sylvia__resource_list
                     mcp__sylvia__resource_resolve
                     mcp__sylvia__resource_call
                     mcp__sylvia__discovery_scan
EOF
  [ "$WITH_TASKER" -eq 1 ] && cat <<EOF

  tasker-mcp registered. In Tasker, import the MCP server project and confirm the
  HTTP service listens on 127.0.0.1:1821. Verify the reload broadcast action
  against your Tasker build (SYLVIA_TASKER_RELOAD_ACTION) in the emulator Logcat.
EOF
  cat <<EOF

  mitmproxy-mcp registered (uvx). Start a mitmproxy instance before using its tools
  (e.g. 'mitmdump' is on PATH, or ask the agent to start one via its MCP tools).
EOF
  printf '──────────────────────────────────────────────────────────────\n'
  cat <<EOF

  Security notes:
    • Web UI is loopback-only and UNAUTHENTICATED — never add --host 0.0.0.0.
    • DSH_PERMISSION_MODE=danger-full-access (Android has no sandbox backend).
      Treat the agent as shell access.
EOF
}

# =============================================================================
#  ARG PARSING + ORCHESTRATION
# =============================================================================
for arg in "$@"; do
  case "$arg" in
    --with-tasker) WITH_TASKER=1 ;;
    --force)       FORCE=1 ;;
    -h|--help)     sed -n '2,45p' "$0" 2>/dev/null || printf '%s\n' \
                     "Usage: bash install.sh [--with-tasker] [--force] [--help]"; exit 0 ;;
    *)             die "unknown argument: $arg (see --help)" ;;
  esac
done

# Fail-fast: --with-tasker is unusable without a Tasker API key, and waiting until
# the MCP-registration module (after all installs) to discover that wastes the run.
if [ "$WITH_TASKER" -eq 1 ] && [ -z "${SYLVIA_TASKER_API_KEY:-}" ]; then
  die "--with-tasker requires SYLVIA_TASKER_API_KEY.
       In Tasker, import reference/tasker-mcp/dist/mcp_server.prj.xml, run the
       \"MCP generate_api_key\" task, then re-run:
         SYLVIA_TASKER_API_KEY=<key> bash install.sh --with-tasker"
fi

head_ "Sylvia installer"
note "repo: $SYLVIA_REPO_URL"
note "home: $SYLVIA_HOME"

module_preconditions
module_base_packages
module_dsh_cli
module_dsh_patch
module_sylvia_mcp
module_sylvia_daemon
module_sylvia_bridge
module_tasker_mcp
module_mitm_mcp
module_register_mcp
module_launchers
print_summary
