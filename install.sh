#!/usr/bin/env bash
# =============================================================================
#  Sylvia — consolidated agentic-AI harness installer for Android (Termux)
# =============================================================================
#  Installs, end to end:
#    1. Termux base packages     nodejs-lts, git, bash, tmux, android-tools (adb), rclone, uv, nmap, iproute2, python, unzip
#    2. DSH Mobile CLI           npm -g @deepseek-ai/dsh
#    3. Mobile/Android patches   Ayrlin-Renata fork -> CLI + 11 local target-train tarballs
#    4. sylvia-mcp server        ADB loopback / Tasker XML / rclone JSON / network+resource+discovery
#    5. sylvia-daemon            control API :3090, network detection, netgate, registry, discovery
#    6. sylvia-bridge plugin     DSH harness gating (pause on metered / offline-gap context)
#    7. MCP registration         appends entries to ~/.dsh/profiles/web/cordis.patch.yml
#    8. Launchers + env          start-sylvia.sh, sylvia-adb-connect.sh, sylvia.env
#    9. mitmproxy + its MCP      CLI + server via prebuilt wheelhouse if given
#                                (build-wheelhouse.sh), else source build
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
#      bash install.sh --force-confnew # auto-answer Y to dpkg conffile prompts
#                                      #   (openssl.cnf, sources.list, bashrc, profile...)
#                                      #   WARNING: overwrites local edits to those files.
#                                      #   Remove this flag if you customized them.
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
#      SYLVIA_WHEELHOUSE_DIR  dir holding sylvia-wheelhouse-<arch>-cp<ver>.tar.gz
#                             (prebuilt mitmproxy; made by build-wheelhouse.sh)
#      SYLVIA_WHEELHOUSE_URL  URL of that tarball (downloaded once, then cached)
#      SYLVIA_MIN_FREE_MB     disk floor before mitmproxy source build (default 3072)
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
FORCE_CONFNEW=0
WITH_TASKER=0
CURRENT_MODULE="bootstrap"
ADB_LOOPBACK_STATUS="not connected"

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
#  PACKAGES-INSTALLED RECORD
# =============================================================================
# install.sh only ever installs MISSING packages, so it records exactly what it
# added (base packages + the mitmproxy toolchain). uninstall.sh removes from
# this record — never a fixed list — so pre-existing packages survive.
PKG_RECORD="${SYLVIA_HOME}/install-packages.txt"
record_packages() {
  [ ${#} -eq 0 ] && return 0
  ensure_dir "$SYLVIA_HOME"
  printf '%s\n' "$@" >> "$PKG_RECORD"
}

# =============================================================================
#  MODULE 2 — Termux base packages
# =============================================================================
module_base_packages() {
  CURRENT_MODULE="base packages"

  # ALWAYS bring the whole Termux tree to lockstep before installing anything.
  # On a fresh install dozens of packages are behind; letting individual
  # `pkg install` calls pull dependencies forward half-way yields mixed-version
  # trees (seen in the wild: apt upgraded curl/libcurl to 8.23.0 but not its
  # TLS/QUIC backend -> "CANNOT LINK EXECUTABLE curl: cannot locate symbol
  # SSL_set_quic_tls_early_data_enabled" -> git/curl/npm all die afterwards).
  # apt-get, NOT pkg, for the update/upgrade: the pkg wrapper shells out to curl
  # (mirror probe), and that is exactly the binary a mixed tree breaks — apt
  # itself has no such dependency. Error output on the field fix also recommends
  # `apt update && apt full-upgrade`.
  note "updating apt indexes and upgrading all Termux packages (a fresh install may download tens of MB)"
  apt-get update >/dev/null 2>&1 || warn "apt-get update returned non-zero; continuing"
  if [ "$FORCE_CONFNEW" -eq 1 ]; then
    apt-get full-upgrade -y -o "Dpkg::Options::=--force-confnew" \
      || die "apt-get full-upgrade failed — the package tree must be consistent before installing. Fix manually: apt-get update && apt-get full-upgrade -y"
  else
    apt-get full-upgrade -y \
      || die "apt-get full-upgrade failed — the package tree must be consistent before installing. Fix manually: apt-get update && apt-get full-upgrade -y"
  fi
  ok "Termux package tree upgraded"

  local missing=()
  have git   || missing+=(git)
  have bash  || missing+=(bash)
  have adb   || missing+=(android-tools)   # provides adb
  have rclone || missing+=(rclone)
  have tmux  || missing+=(tmux)            # launcher persistence (start-sylvia.sh)
  have node  || missing+=(nodejs-lts)      # Node ^22.19 || >=24 for node:sqlite
  have uv    || missing+=(uv)              # mitmproxy install + mitmproxy-mcp launcher
  have nmap  || missing+=(nmap)            # LAN discovery (daemon discovery_scan tool)
  have ip    || missing+=(iproute2)        # 'ip' binary — daemon Tier-0 network detection
  have python || missing+=(python)         # uv/uvx interpreter (mitmproxy CLI + mitmproxy-mcp)
  have unzip || missing+=(unzip)           # lift libshizuku.so out of the Shizuku APK (transport ladder tier-3)
  # termux-api = the termux-* CLI stubs (termux-wake-lock etc.). The companion
  # Termux:API *app* (F-Droid) is a separate manual install; without it the
  # stubs are present but no-ops, which is harmless.
  have termux-wake-lock || missing+=(termux-api)

  if [ ${#missing[@]} -eq 0 ]; then
    skip "all base packages present (git, bash, adb, rclone, tmux, node, uv, nmap, iproute2, python, termux-api)"
  else
    note "installing: ${missing[*]}"
    # --force-confnew auto-answers "Y" (install the maintainer's version) to dpkg's
    # conffile prompts (openssl.cnf, sources.list, bashrc, profile, ...). Without the
    # flag dpkg stops and waits. opt-in: users with custom edits must not set it.
    if [ "$FORCE_CONFNEW" -eq 1 ]; then
      pkg install -y -o "Dpkg::Options::=--force-confnew" "${missing[@]}" \
        || die "pkg install failed for: ${missing[*]}"
    else
      pkg install -y "${missing[@]}" || die "pkg install failed for: ${missing[*]}"
    fi
    ok "installed base packages: ${missing[*]}"
    record_packages "${missing[@]}"
  fi

  # Linker sanity: a mixed-version tree otherwise surfaces much later as a
  # confusing git/npm failure. Repair once with a forced full upgrade (apt-get:
  # pkg itself needs the curl that this state breaks).
  if ! curl --version >/dev/null 2>&1; then
    note "curl cannot execute (mixed-version library tree) — forcing apt-get full-upgrade to repair"
    if [ "$FORCE_CONFNEW" -eq 1 ]; then
      apt-get full-upgrade -y -o "Dpkg::Options::=--force-confnew"
    else
      apt-get full-upgrade -y
    fi
    curl --version >/dev/null 2>&1 \
      || die "curl is still broken after a full upgrade. Inspect manually: apt-get update && apt-get full-upgrade -y ; ldd \$PREFIX/bin/curl"
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

  # The mobile patcher (module_dsh_patch) performs the REAL install: it does
  # `npm install -g` with the CLI spec + all the fork's local tarballs in ONE call, so
  # arborist builds the whole tree atomically. Pre-installing DSH here is not just
  # redundant — it leaves a half-built --ignore-scripts tree that arborist then
  # crashes on ("Cannot read properties of null (reading 'children')") when the
  # patcher reconciles over it. So: if the patcher is going to run, defer to it and
  # do nothing here. (module_dsh_patch is gated by SYLVIA_WITH_DSH_PATCH.)
  #
  # Standalone path (no mobile patch — upstream DSH only): install here with the
  # koffi workaround. koffi always fails on Termux because its loader keys off
  # process.platform ("linux", not "android"), grabs the glibc default .node, cannot
  # dlopen it on bionic, and falls back to a from-source build needing CMake (absent).
  if [ "${SYLVIA_WITH_DSH_PATCH:-1}" -eq 1 ]; then
    skip "deferring DSH install to the mobile patcher (single atomic npm install)"
    return 0
  fi

  if have dsh && [ -f "$DSH_GLOBAL_LIB/lib/bin.js" ]; then
    skip "DSH CLI already installed ($DSH_GLOBAL_LIB)"
    return 0
  fi
  note "installing @deepseek-ai/dsh globally (standalone, no mobile patch)"
  if ! npm install --global @deepseek-ai/dsh; then
    warn "npm install -g @deepseek-ai/dsh failed (likely the koffi native addon)"
    warn "retrying with --ignore-scripts (skips native-addon builds; DSH runs without them)"
    npm install --global @deepseek-ai/dsh --ignore-scripts \
      || die "npm install -g @deepseek-ai/dsh failed even with --ignore-scripts.
       Re-run to see the full error, or install a toolchain and retry without the flag:
         pkg install -y cmake ninja clang make"
  fi
  [ -f "$DSH_GLOBAL_LIB/lib/bin.js" ] || die "DSH bin.js not found at $DSH_GLOBAL_LIB/lib/bin.js after install"
  dsh --help >/dev/null 2>&1 || die "DSH CLI installed but 'dsh --help' failed — the install is incomplete."
  ok "DSH CLI installed (standalone upstream)"
}

# npm can nest stock copies of packages inside the CLI's own node_modules
# (it did this wildly on the old caret-ranged train, resolving to newer
# prereleases; even the exact-pinned 0.2.1 train nests stock copies). Node's
# resolver prefers those nested copies over the fork's patched TOP-LEVEL
# tarballs, so the patches silently stop applying. Prune the nested copies so
# the patched packages win resolution.
_prune_nested_fork_copies() {
  local gmp="$1"; shift
  local nest="$gmp/dsh/node_modules/@deepseek-ai" sib pruned=0
  [ -d "$nest" ] || return 0
  for sib in "$@"; do
    if [ -e "$nest/$sib" ]; then
      rm -rf "$nest/$sib"
      pruned=1
    fi
  done
  if [ "$pruned" -eq 1 ]; then
    ok "pruned nested stock copies of the fork packages (they shadow the patched top-level tarballs)"
  fi
  return 0
}

# RETIRED at 0.2.1-alpha.5 (Phase B re-target): @deepseek-ai/cordis-plugin-hmr
# no longer exists on the 0.2.1 train — HMR is @deepseek-ai/dsh-hmr, a normal
# loader entry, and app-boot no longer calls registerConfig/watchUserPatches at
# all. The 1.0.17 pin implementation is in git history (removed in the re-target
# commit); installing it here would only plant a dead package.

# Client-modules drift guard. On the 0.2.1-alpha.5 train the fork no longer
# ships a client-modules tarball (stock is byte-equivalent to the old patch)
# and the CLI's exact pin installs it NESTED — but the facade contract
# (window.__ModuleLoader__ injection) still has to hold between whatever
# client-modules is installed and the web frontend. This only acts when a
# TOP-LEVEL copy drifts from the frontend (the rc.8-era drift class); the
# nested exact-pinned copy is left alone. Idempotent; fail-fast.
_align_client_modules_to_fe() {
  local gmp="$1"
  local fe="" fe_pkg cm_ver fe_ver
  for fe_pkg in \
    "$gmp/dsh/node_modules/@deepseek-ai/dsh-web-frontend/package.json" \
    "$gmp/dsh-web-frontend/package.json"; do
    [ -f "$fe_pkg" ] && { fe="$fe_pkg"; break; }
  done
  [ -n "$fe" ] || die "dsh-web-frontend not found under $gmp (nested or top-level) — cannot align client-modules to the frontend"
  fe_ver="$(node -p "require(process.argv[1]).version" "$fe" 2>/dev/null)" \
    || die "could not read frontend version from $fe"
  [ -n "$fe_ver" ] || die "frontend version empty in $fe"
  cm_ver=""
  if [ -f "$gmp/dsh-client-modules/package.json" ]; then
    cm_ver="$(node -p "require(process.argv[1]).version" "$gmp/dsh-client-modules/package.json" 2>/dev/null)"
  elif [ -f "$gmp/dsh/node_modules/@deepseek-ai/dsh-client-modules/package.json" ]; then
    # Nested exact-pinned copy (the 0.2.1-train shape) — matches by construction.
    skip "dsh-client-modules is nested (exact-pinned with the CLI, $fe_ver frontend)"
    return 0
  fi
  if [ "$cm_ver" = "$fe_ver" ]; then
    skip "dsh-client-modules already matches the frontend ($fe_ver)"
    return 0
  fi
  note "aligning dsh-client-modules ${cm_ver:-missing} -> $fe_ver (frontend facade contract)"
  npm install --global "@deepseek-ai/dsh-client-modules@$fe_ver" --no-audit --no-fund >/dev/null 2>&1 \
    || die "npm install -g @deepseek-ai/dsh-client-modules@$fe_ver failed (network?) — without it the UI dies with 'window.__ModuleLoader__ bootstrap facade is missing'"
  cm_ver="$(node -p "require(process.argv[1]).version" "$gmp/dsh-client-modules/package.json" 2>/dev/null || true)"
  [ "$cm_ver" = "$fe_ver" ] \
    || die "dsh-client-modules is $cm_ver after install, expected $fe_ver"
  grep -q 'mode:"queue"' "$gmp/dsh-client-modules/lib/index.js" \
    || die "dsh-client-modules@$fe_ver lacks the __ModuleLoader__ facade injection (injectBootManifest)"
  ok "dsh-client-modules aligned to frontend $fe_ver (facade injection present)"
}

# imageLimits.maxImageDimension verification. The rc.8-era contract: the
# session.history projection REQUIRES maxImageDimension, so a dsh-attachment-
# local without it kills chat history ("Failed to load history ..."). On the
# 0.2.1-alpha.5 train this is upstream — verify it, do not patch it. The
# legacy patch path stays only for repairing an old-train (rc.7 baseline)
# install in place; its frozen-baseline hash never changes, so the guard is
# stable. Anything that is neither the legacy baseline nor already-feature-
# present is unknown bytes and must not be overwritten.
_patch_attachment_local_image_dimension() {
  local gmp="$1"
  local target="$gmp/dsh-attachment-local/lib/index.js"
  [ -f "$target" ] || die "dsh-attachment-local missing ($target) — run the mobile-patch module first"
  if grep -q "maxImageDimension" "$target"; then
    skip "attachment-local provides imageLimits.maxImageDimension (upstream or previously patched)"
    return 0
  fi
  local md5_of='const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("md5").update(f.readFileSync(process.argv[1])).digest("hex"))'
  local base=7571b9b552b7e642334a19aa00cd812f now
  now="$(node -e "$md5_of" "$target")" || die "could not hash $target"
  if [ "$now" != "$base" ]; then
    die "attachment-local lacks maxImageDimension and has unexpected bytes ($now — expected legacy baseline $base); refusing to overwrite unknown bytes"
  fi
  local src="$SCRIPT_DIR/patches/attachment-local-rc7-index.js"
  if [ ! -f "$src" ]; then
    local repo_dir="$SYLVIA_HOME/repo"
    if [ ! -f "$repo_dir/patches/attachment-local-rc7-index.js" ]; then
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for patches/attachment-local-rc7-index.js: $SYLVIA_REPO_URL"
      rm -rf "$repo_dir"
      git clone --depth 1 "$SYLVIA_REPO_URL" "$repo_dir" || die "git clone of Sylvia repo failed ($SYLVIA_REPO_URL)"
    fi
    src="$repo_dir/patches/attachment-local-rc7-index.js"
  fi
  local src_md5
  src_md5="$(node -e "$md5_of" "$src")" || die "could not hash $src"
  [ "$src_md5" = "$patched" ] || die "patch source has unexpected bytes ($src_md5, want $patched) — $src"
  cp "$src" "$target" || die "could not write $target"
  grep -q "maxImageDimension" "$target" || die "patched attachment-local lacks maxImageDimension after copy"
  ok "attachment-local patched with imageLimits.maxImageDimension (legacy rc.7 repair)"
}

# RETIRED at 0.2.1-alpha.5 (Phase B re-target): the profile-boot →
# watchUserPatches race needed a fiber-settle patch only because app-boot
# loaded cordis-plugin-hmr and watched immediately. On the 0.2.1 train
# watchUserPatches does not exist and HMR ships as a plain loader entry
# (@deepseek-ai/dsh-hmr) — there is nothing to await and nothing that throws.
# Implementation in git history; a patched-anchor search here would `die` on
# every fresh install (the anchor is gone), which is why the function was
# removed rather than left to its guards.

# =============================================================================
#  MODULE 4 — Mobile/Android patches (CLI spec + the fork's local target-train tarballs)
# =============================================================================
# The fork repo carries the tarballs + its own install.sh; we clone it and
# replicate that installer's spec-by-spec (see below), not run it directly.
module_dsh_patch() {
  CURRENT_MODULE="DSH mobile patch"

  # Target train. The FORK is the source of truth for the exact specs (the CLI
  # spec + tarball version are read out of the fork's own install.sh below),
  # but the idempotency canary needs a version to compare BEFORE the fork is
  # cloned — and a stale clone from a previous train must never satisfy it.
  # Bump SYLVIA_DSH_TARGET_VER when the fork moves trains.
  local TARGET="${SYLVIA_DSH_TARGET_VER:-0.2.1-alpha.5}"
  local fork_dir="$SYLVIA_HOME/dsh-mobile"
  local GMP="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai"
  # The fork's 11 tarballs (client-modules intentionally absent: stock alpha.5
  # is byte-equivalent, so the CLI's exact pin installs it nested).
  local dsh_siblings=(
    dsh-client-ui-layout dsh-subprocess-local dsh-terminal-bash dsh-sandbox
    dsh-sandbox-local dsh-fs-local dsh-session-persistence-jsonl
    dsh-attachment-local dsh-host-directory-picker-native
    dsh-host-directory-picker-browse dsh-client-ui-directory-picker-browse
  )
  local patch_ok=1 sib
  [ -f "$GMP/dsh/package.json" ] || patch_ok=0
  if [ "$patch_ok" -eq 1 ]; then
    for sib in "${dsh_siblings[@]}"; do
      [ -f "$GMP/$sib/package.json" ] || { patch_ok=0; break; }
    done
  fi
  # Canary: every package present AND the layout canary at the TARGET train —
  # any previous train (e.g. the rc.7 installs that predate the 0.2.1 re-target)
  # forces the repair path below.
  if [ "$patch_ok" -eq 1 ] \
     && node -e "process.exit(require(process.argv[1]).version===process.argv[2]?0:1)" "$GMP/dsh-client-ui-layout/package.json" "$TARGET"; then
    # Even when the top-level tree is correct, npm may have nested stock copies
    # inside the CLI's own node_modules where they shadow the patched top-level
    # packages at resolution time — prune before trusting it.
    _prune_nested_fork_copies "$GMP" "${dsh_siblings[@]}"
    _align_client_modules_to_fe "$GMP"
    _patch_attachment_local_image_dimension "$GMP"
    skip "mobile patch already applied (CLI + ${#dsh_siblings[@]} $TARGET packages present)"
    return 0
  fi
  note "mobile patch incomplete or on a previous train — repairing"

  if [ ! -f "$fork_dir/install/install.sh" ]; then
    ensure_dir "$SYLVIA_HOME"
    note "cloning DSH fork: $SYLVIA_DSH_REPO"
    rm -rf "$fork_dir"
    git clone --depth 1 "$SYLVIA_DSH_REPO" "$fork_dir" || die "git clone of DSH fork failed ($SYLVIA_DSH_REPO)"
  else
    skip "fork already cloned ($fork_dir)"
  fi

  # A clone from a PREVIOUS train must not be reused — its tarballs would
  # silently reinstall the old train. Refresh when its pinned tarball version
  # no longer matches the target.
  local fork_pin
  fork_pin="$(grep -oE 'deepseek-ai-dsh-client-ui-layout-[0-9][0-9a-zA-Z.-]*\.tgz' "$fork_dir/install/install.sh" 2>/dev/null | head -n1 || true)"
  fork_pin="${fork_pin#deepseek-ai-dsh-client-ui-layout-}"; fork_pin="${fork_pin%.tgz}"
  if [ "$fork_pin" != "$TARGET" ]; then
    note "fork clone pins '${fork_pin:-unknown}' (target $TARGET) — re-cloning"
    rm -rf "$fork_dir"
    git clone --depth 1 "$SYLVIA_DSH_REPO" "$fork_dir" || die "git clone of DSH fork failed ($SYLVIA_DSH_REPO)"
  fi

  # Clear any half-built global DSH tree + npm's global lock first, so arborist
  # never reconciles over stale state (idempotent: the canary above short-circuits
  # once a COMPLETE install is present).
  npm uninstall --global @deepseek-ai/dsh dsh >/dev/null 2>&1 || true
  rm -rf "${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai" \
         "${PREFIX:-/data/data/com.termux/files/usr}/bin/dsh" 2>/dev/null || true
  rm -f "${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/.package-lock.json" 2>/dev/null || true

  # The fork's install.sh issues ONE `npm install -g` with all its specs at once.
  # Under npm 11 that single multi-spec command reliably crashes arborist's
  # ideal-tree builder: "Cannot read properties of null (reading 'children')".
  # A one-package-per-invocation install never enters that code path, so we
  # replicate the patcher here spec-by-spec instead of calling it. The specs are
  # identical (the CLI registry spec + the fork's local tarballs beside it), so
  # the result is the same install.
  #
  # npm_config_ignore_scripts=1 skips the native-addon builds (koffi/sharp/node-pty).
  # Those ALWAYS fail on Termux — their loaders key off process.platform ("linux", not
  # "android"), grab the glibc default .node, cannot dlopen it on bionic, and fall back
  # to a from-source build needing CMake (absent). The fork tarballs declare these
  # addons optional (and lazy at runtime), so nothing downstream needs them compiled.
  local inst_dir="$fork_dir/install"

  # Read the fork's PINNED versions out of its own install.sh so a fork version bump
  # can never leave this installer stale. (The package SET still mirrors dsh_siblings
  # above — keep that list in sync if the fork adds/removes a tarball.)
  local hits cli_spec tgz_ver
  hits="$(grep -oE '@deepseek-ai/dsh@[0-9][0-9a-zA-Z.-]*' "$inst_dir/install.sh" || true)"
  cli_spec="${hits%%$'\n'*}"
  [ -n "$cli_spec" ] || die "could not read the CLI spec from $inst_dir/install.sh"
  hits="$(grep -oE 'deepseek-ai-dsh-client-ui-layout-[0-9][0-9a-zA-Z.-]*\.tgz' "$inst_dir/install.sh" || true)"
  hits="${hits%%$'\n'*}"
  tgz_ver="${hits#deepseek-ai-dsh-client-ui-layout-}"; tgz_ver="${tgz_ver%.tgz}"
  [ -n "$tgz_ver" ] || die "could not read the tarball version from $inst_dir/install.sh"
  [ "$tgz_ver" = "$TARGET" ] || die "fork install.sh pins $tgz_ver but SYLVIA_DSH_TARGET_VER=$TARGET — the fork moved trains; bump SYLVIA_DSH_TARGET_VER to match"

  # (installed dir under @deepseek-ai, install spec) — one entry per package, so the
  # post-install check never has to parse a name out of a spec (that parsing is what
  # the previous attempt got wrong: "${spec%%@*}" cuts at the SCOPE, not the version).
  local dirs=("dsh") specs=("$cli_spec") sib
  for sib in "${dsh_siblings[@]}"; do
    dirs+=("$sib")
    specs+=("$inst_dir/deepseek-ai-${sib}-${tgz_ver}.tgz")
  done

  local i legacy_used=0
  note "installing $cli_spec + ${#dsh_siblings[@]} local $tgz_ver tarballs (one npm call each)"
  for i in "${!specs[@]}"; do
    # Only the LOCAL tarball specs are file paths — the CLI spec (specs[0]) is a
    # registry spec ("@deepseek-ai/dsh@x.y.z") that npm resolves from the network,
    # so the -f existence check must not reject it.
    case "${specs[$i]}" in
      *.tgz)
        [ -f "${specs[$i]}" ] \
          || die "fork tarball missing: ${specs[$i]} — delete $fork_dir and re-run to re-clone."
        ;;
    esac
    # npm's exit code can be non-zero purely because an OPTIONAL native-addon build
    # script failed (koffi/sharp/node-pty) — expected and harmless on Termux, since
    # the tarballs make those addons optional. So don't trust the exit code: install
    # best-effort, then verify the package actually landed on disk.
    npm_config_ignore_scripts=1 npm install --global "${specs[$i]}" >/dev/null 2>&1 || true
    if [ ! -f "$GMP/${dirs[$i]}/package.json" ]; then
      # One package in the set (dsh-terminal-bash) declares 8 peerDependencies; npm's
      # arborist can crash its tree-builder on the peer graph ("Cannot read properties
      # of null (reading 'children')" — reproduced on npm 10 AND 11, Windows + Termux).
      # --legacy-peer-deps skips that peer reconciliation and lands the package. This
      # ONLY applies to the one package that failed; the rest install normally with
      # peers resolved. Retry once, then verify on disk.
      #
      # DANGER (verified 2026-10-19): legacy mode IGNORES peerDependencies and
      # reifies the global tree from its root specs, which PRUNES nested peers the
      # CLI depends on (@deepseek-ai/dsh-session, dsh-session-persistence, cordis,
      # …) — the package then lands but fails to import and a dozen plugins go
      # inactive. So remember that we used it and repair afterwards.
      npm_config_ignore_scripts=1 npm install --global --legacy-peer-deps "${specs[$i]}" >/dev/null 2>&1 || true
      legacy_used=1
    fi
    [ -f "$GMP/${dirs[$i]}/package.json" ] \
      || die "npm install -g did not produce $GMP/${dirs[$i]} — the package is genuinely broken (re-run to retry)."
  done

  # Repair pass for the legacy-peer-deps fallback above: reinstalling the CLI spec
  # restores the nested peers that legacy mode pruned (and re-nests stock copies of
  # the fork packages, which the prune below removes again — same end state as a
  # clean install). Then PROVE the repair: resolving a nested peer from the CLI must
  # work, or the harness boots into a wall of "could not be resolved".
  if [ "$legacy_used" = 1 ]; then
    note "repairing the global tree after a legacy-peer-deps fallback (legacy mode prunes nested peers)"
    npm_config_ignore_scripts=1 npm install --global "$cli_spec" >/dev/null 2>&1 || true
    _prune_nested_fork_copies "$GMP" "${dsh_siblings[@]}"
    node -e '
      const { createRequire } = require("node:module");
      const req = createRequire(process.argv[1] + "/package.json");
      for (const id of ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-persistence"]) {
        try { req.resolve(id); } catch (error) {
          console.error("cannot resolve " + id + " from the CLI tree: " + error.message);
          process.exit(1);
        }
      }
    ' "$GMP/dsh" \
      || die "the global tree is missing nested peers after the legacy-peer-deps fallback — re-run install.sh (it repairs), or npm install --global $cli_spec by hand."
  fi

  local sib2
  for sib2 in dsh "${dsh_siblings[@]}"; do
    [ -f "$GMP/$sib2/package.json" ] \
      || die "after installing all specs, $GMP/$sib2/package.json is still missing — re-run to repair."
  done
  # npm nests its own stock copies of the fork packages inside the CLI's tree
  # during a fresh install too — prune before declaring success.
  _prune_nested_fork_copies "$GMP" "${dsh_siblings[@]}"
  # Drift guards (no-ops on a healthy exact-pinned install).
  _align_client_modules_to_fe "$GMP"
  _patch_attachment_local_image_dimension "$GMP"
  ok "mobile/Android patches applied ($cli_spec + ${#dsh_siblings[@]} $tgz_ver packages)"
}

# =============================================================================
#  MODULE 4.5 — node-addon-require-builtin native binding (Android)
# =============================================================================
# DSH 0.2.x boots through node-addon-require-builtin ("host preparation"), a
# native binding that loads Node internal modules. Its published platform
# packages cover linux/darwin/win ONLY — npm has no
# node-addon-require-builtin-android-x64 (404) — and the published entry ships
# neither source nor a postinstall, so the loader's three fallbacks
# (optional-package / local-build nodeabi / local-build napi) all miss on
# Termux and every boot dies with:
#   No usable native binding found for node-addon-require-builtin-android-x64
# We supply the binding ourselves: download the prebuilt NAPI artifact from
# this repo (native/<arch>/napi-v9/require_builtin.node — one file per arch;
# NAPI v9 is ABI-stable, so a single build covers every Node version), else
# build it from upstream source on-device. Either path is verified by running
# the exact call app-boot makes (requireBuiltin of an internal module, with
# --expose-internals like the real launcher).
_binding_loads() {
  local pkgdir="$1"
  node --expose-internals -e '
    const { createRequire } = require("module");
    const req = createRequire(process.argv[1] + "/package.json");
    const addon = req("node-addon-require-builtin");
    const esm = addon.requireBuiltin("internal/modules/esm/loader");
    if (typeof esm.getOrInitializeCascadedLoader !== "function") process.exit(2);
  ' "$pkgdir" >/dev/null 2>&1
}

module_native_binding() {
  CURRENT_MODULE="native binding"
  local pkg="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai/dsh/node_modules/node-addon-require-builtin"
  if [ ! -d "$pkg" ]; then
    skip "node-addon-require-builtin not present (DSH tree missing?) — skipped"
    return 0
  fi
  local dest="$pkg/build/napi/napi-v9-android-x64/require_builtin.node"
  if [ -f "$dest" ] && _binding_loads "$pkg"; then
    skip "android binding already present and functional"
    return 0
  fi

  local arch
  case "$(uname -m)" in
    x86_64) arch="android-x64" ;;
    aarch64|arm64) arch="android-arm64" ;;
    *) die "unsupported arch $(uname -m) for the native binding — build it manually, see native/README.md" ;;
  esac
  rm -f "$dest" 2>/dev/null || true
  ensure_dir "$(dirname "$dest")"

  # 1. Prebuilt artifact from this repo (fast path; verified after download —
  #    a wrong-arch/corrupt file fails dlopen and falls through to source).
  local raw="${SYLVIA_RAW_BASE:-https://raw.githubusercontent.com/Ayrlin-Renata/Sylvia/main}"
  local url="$raw/native/$arch/napi-v9/require_builtin.node"
  note "fetching prebuilt binding: $url"
  if curl -fsSL --connect-timeout 10 --max-time 60 -o "$dest.tmp" "$url" 2>/dev/null \
     && [ -s "$dest.tmp" ]; then
    mv "$dest.tmp" "$dest"
    if _binding_loads "$pkg"; then
      ok "android binding installed from prebuilt artifact ($arch)"
      return 0
    fi
    warn "prebuilt binding did not load (wrong arch or corrupt) — falling back to a source build"
    rm -f "$dest"
  else
    rm -f "$dest.tmp" 2>/dev/null || true
    note "no prebuilt binding for $arch in the repo (yet) — building from source"
  fi

  # 2. Source build fallback (the upstream repo is the only other source).
  if ! command -v clang >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
    note "installing build toolchain (make clang)"
    pkg install -y make clang >/dev/null 2>&1 || true
  fi
  command -v clang >/dev/null 2>&1 \
    || die "clang missing and the prebuilt binding was unavailable — install it (pkg install make clang) and re-run"
  command -v python >/dev/null 2>&1 \
    || die "python missing (base packages should provide it) — node-gyp needs it"

  local src="$SYLVIA_HOME/native-build/src"
  local repo="${SYLVIA_NAB_REPO:-https://github.com/deepseek-ai/dsh-node-addon-require-builtin.git}"
  rm -rf "$src"
  git clone --depth 1 "$repo" "$src" || die "clone of $repo failed (network?) — no other binding source exists"
  local nd="$src/packages/native"
  [ -f "$nd/binding.gyp" ] || die "upstream repo layout changed — no binding.gyp under packages/native (see native/README.md)"
  local gyp="$PREFIX/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  [ -f "$gyp" ] || die "npm's bundled node-gyp missing ($gyp) — npm is broken; pkg install nodejs-lts"
  local blog="$SYLVIA_HOME/native-build/build.log"
  (
    cd "$nd" || exit 1
    npm install --no-save --ignore-scripts --no-audit --no-fund node-addon-api >/dev/null 2>&1 || exit 1
    export GYP_DEFINES="narb_product=require-builtin"
    node "$gyp" rebuild --nodedir="$PREFIX"
  ) > "$blog" 2>&1 || die "native binding build failed — see $blog. Last lines:
$(tail -n 8 "$blog" 2>/dev/null || true)"
  [ -f "$nd/build/Release/require_builtin.node" ] || die "build reported success but produced no artifact — see $blog"
  cp "$nd/build/Release/require_builtin.node" "$dest" || die "could not place binding at $dest"
  _binding_loads "$pkg" || die "built binding does not load — see $blog"
  ok "android binding built from source ($arch) — contribute it: native/$arch/napi-v9/require_builtin.node"
}

# =============================================================================
#  DSH AMBIENT DEPENDENCY SWEEP
# =============================================================================
# Ambient dependency sweep. The 0.1.0-train crisis this was born from: npm
# resolved the CLI's caret-ranged deps to a newer prerelease train whose
# packages imported helpers (dsh-timeout, dsh-scope, cordis-plugin-group,
# dsh-atomic-write, dsh-compaction, …) that NEITHER they NOR the CLI declared
# (some only as peerDependencies), so npm never installed them and every boot
# died with "plugin tree failed to load". The 0.2.1 train exact-pins every
# dsh-* dependency, so this class should be gone — the sweep stays as a
# regression detector (it must report clean on a healthy install). It also
# still catches a hand-edited tree or a future train that reintroduces the
# pattern. Read-only when nothing is missing, so a re-run is a fast
# verification pass.
#
# Fix: sweep every @deepseek-ai package in the global tree, import its entry
# point directly, and collect "Cannot find (package|module)" errors. Missing
# @deepseek-ai packages are npm-installed globally at the matching train
# version (prefer the tree's 0.1.0-rc.* train, else newest release); any
# other bare name is a hard error (too unusual to guess). Repeat until clean
# (the transitive deps of what we install can surface new gaps). The sweep is
# read-only, so a re-run is just a fast verification pass.
module_ambient_deps() {
  CURRENT_MODULE="DSH ambient deps"
  local gmp="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules"
  local sweep="$SYLVIA_HOME/ambient-sweep.mjs"
  local round names other spec pick

  [ -d "$gmp/@deepseek-ai" ] || { skip "no DSH tree yet (skipped)"; return 0; }

  cat > "$sweep" <<'SWEEP_EOF'
// Import every @deepseek-ai package entry in the global tree and report bare
// packages that fail to resolve. Both CJS and ESM work via import(); non-
// resolution errors are expected (plugins assume a cordis ctx at apply()-time)
// and are ignored — only "Cannot find package/module 'x'" counts.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const missing = new Map();
const entries = [];

function entryOf(pkgDir) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')); }
  catch { return null; }
  let rel = pkg.exports && pkg.exports['.'];
  if (rel && typeof rel === 'object') rel = rel.import || rel.default || rel.require;
  if (rel && typeof rel === 'object') rel = rel.import || rel.default || rel.require;
  if (typeof rel !== 'string' || !rel) rel = pkg.module || pkg.main || 'index.js';
  if (rel.startsWith('./')) rel = rel.slice(2);
  for (const file of [join(pkgDir, rel), join(pkgDir, rel + '.js'), join(pkgDir, rel, 'index.js')]) {
    if (existsSync(file)) return file;
  }
  return null;
}

function collect(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const pkgDir = join(dir, name);
    if (existsSync(join(pkgDir, 'package.json'))) entries.push(pkgDir);
  }
}

collect(join(root, '@deepseek-ai'));                              // fork tarballs etc.
collect(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')); // nested CLI tree (the bulk!) — must include the '@deepseek-ai/' segment

const seen = new Set();
for (const pkgDir of entries) {
  const entry = entryOf(pkgDir);
  if (!entry || seen.has(entry)) continue;
  seen.add(entry);
  try {
    await import(pathToFileURL(entry).href);
  } catch (e) {
    const m = String((e && e.message) || '').match(/Cannot find (?:package|module) '([^']+)'/);
    if (m && !m[1].startsWith('.') && !m[1].startsWith('/')) {
      missing.set(m[1], (missing.get(m[1]) || 0) + 1);
    }
  }
}
process.stdout.write(JSON.stringify([...missing.keys()]));
SWEEP_EOF

  for round in 1 2 3 4 5 6; do
    names=$(node "$sweep" "$gmp" 2>/dev/null) || names="[]"
    [ -z "$names" ] && names="[]"
    if [ "$names" = "[]" ]; then
      ok "ambient dependency sweep clean (round $round) — tree imports resolve"
      return 0
    fi
    # Anything that is not an @deepseek-ai package we can version-pick is
    # unexpected: fail loudly instead of guessing at arbitrary packages.
    other=$(printf '%s' "$names" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);console.log(a.filter(n=>!n.startsWith("@deepseek-ai/")).join(" "))}catch(e){console.log("")}})')
    if [ -n "$other" ]; then
      die "unresolvable non-DSH ambient package(s): $other
           The tree imports them but they are not on npm under @deepseek-ai —
           inspect with: node $sweep $gmp"
    fi
    spec=""
    for name in $(printf '%s' "$names" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).join("\n"))}catch(e){}})'); do
      pick=$(npm view "$name" versions --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const rc=a.filter(v=>v.startsWith("0.1.0-rc."));console.log((rc.length?rc:a).pop())}catch(e){console.log("")}})')
      if [ -n "$pick" ]; then
        spec="$spec $name@$pick"
      else
        die "no published version found for $name (npm view failed) — check registry connectivity"
      fi
    done
    note "round $round: installing missing ambient package(s):$(printf '%s' "$spec" | cut -c1-200)"
    # shellcheck disable=SC2086
    npm install -g $spec --no-audit --no-fund >/dev/null 2>&1 \
      || die "npm install of ambient package(s) failed:$spec"
  done
  die "ambient dependency sweep did not converge after 6 rounds — last: $names"
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

  # Boot probe: start the daemon in the BACKGROUND on a scratch port, require
  # /api/health to answer, then shut it down. (A plain `node -e import(...)` probe
  # must NOT be used: index.js's auto-run guard compares import.meta.url to
  # argv[1], and `node -e` puts the extra argument at argv[1] — so the import
  # itself started the server and blocked the installer until Ctrl-C.)
  local probe_port=$((3990 + RANDOM % 100))
  local probe_log="$SYLVIA_HOME/daemon-probe.log"
  SYLVIA_DAEMON_PORT="$probe_port" node "$SYLVIA_DAEMON_DIR/index.js" >"$probe_log" 2>&1 &
  local probe_pid=$! up=0 t
  for t in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$probe_pid" 2>/dev/null || break   # died during boot — stop polling
    curl -sf "http://127.0.0.1:$probe_port/api/health" >/dev/null 2>&1 && { up=1; break; }
    sleep 0.5
  done
  kill "$probe_pid" 2>/dev/null || true
  wait "$probe_pid" 2>/dev/null || true
  if [ "$up" -ne 1 ]; then
    warn "daemon probe log ($probe_log):"
    cat "$probe_log" >&2 || true
    rm -f "$probe_log"
    die "sylvia-daemon did not become healthy on :$probe_port"
  fi
  rm -f "$probe_log"
  ok "sylvia-daemon verified (healthy on :$probe_port, probe)"
}

# =============================================================================
#  MODULE 5d — local modules (§9) — seed ~/.sylvia/modules/ from repo modules/
# =============================================================================
# Modules are user-owned after seeding (settings.env, logs, run.pid, and
# node_modules all live inside the module dir), so an EXISTING module directory
# is never overwritten — re-running install.sh only adds modules that are
# missing. The daemon discovers modules at boot, so a restart of the harness
# (start-sylvia.sh) is needed after new ones appear.
module_local_modules() {
  CURRENT_MODULE="local modules"

  local src=""
  if [ -d "$SCRIPT_DIR/modules" ]; then
    src="$SCRIPT_DIR/modules"
    note "using local modules ($src)"
  else
    local repo_dir="$SYLVIA_HOME/repo"
    if [ ! -d "$repo_dir/modules" ]; then
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for modules: $SYLVIA_REPO_URL"
      rm -rf "$repo_dir"
      git clone --depth 1 "$SYLVIA_REPO_URL" "$repo_dir" || die "git clone of Sylvia repo failed ($SYLVIA_REPO_URL)"
    fi
    src="$repo_dir/modules"
  fi

  ensure_dir "$SYLVIA_HOME/modules"
  local seeded=0 dir id dest
  for dir in "$src"/*/; do
    [ -f "$dir/module.json" ] || continue
    id="$(basename "$dir")"
    dest="$SYLVIA_HOME/modules/$id"
    if [ -d "$dest" ]; then
      skip "module $id already present ($dest)"
      continue
    fi
    cp -r "$dir" "$dest" || die "could not copy module $id to $dest"
    chmod +x "$dest/scripts/"*.sh 2>/dev/null || true
    seeded=$((seeded + 1))
    ok "module $id seeded ($dest)"
  done

  if [ "$seeded" -gt 0 ]; then
    ok "modules seeded: $seeded (restart the daemon to discover them)"
  else
    note "no new modules to seed"
  fi
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
  # The bridge has no build step, so it bare-imports @deepseek-ai/schemastery
  # and @deepseek-ai/dsh-llm at runtime. npm keeps those nested inside the
  # CLI's own tree, invisible to plain ESM resolution from ~/.sylvia — symlink
  # them into the bridge's node_modules, resolved the same way the harness does.
  node -e '
    const { createRequire } = require("module");
    const path = require("path");
    const fs = require("fs");
    const req = createRequire(path.join(process.argv[1], "probe.js"));
    const dest = process.argv[2];
    fs.mkdirSync(dest, { recursive: true });
    for (const pkg of ["schemastery", "dsh-llm"]) {
      let root = null;
      try { root = path.dirname(req.resolve("@deepseek-ai/" + pkg + "/package.json")); }
      catch {
        try { root = path.dirname(path.dirname(req.resolve("@deepseek-ai/" + pkg))); }
        catch { console.error("cannot resolve @deepseek-ai/" + pkg + " from " + process.argv[1]); process.exitCode = 1; continue; }
      }
      const link = path.join(dest, pkg);
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(root, link, "dir");
      console.log("linked @deepseek-ai/" + pkg + " -> " + root);
    }
  ' "$DSH_GLOBAL_LIB/lib" "$SYLVIA_BRIDGE_DIR/node_modules/@deepseek-ai" \
    || warn "could not link bridge runtime deps (sylvia-bridge may fail to load)"
  _cordis_append_plugin "sylvia-bridge" "sylvia-bridge"
}

# Append one MCP server entry to the cordis patch layer, guarded by its id so a
# re-run never duplicates. We APPEND as text (never parse+reserialize) because
# the file may contain !!js expressions and comments a YAML round-trip would drop.
#
# SHAPE MATTERS: cordis-plugin-include's applyEntryPatches only CREATES entries
# from `insert` items (data.push(...insert)). A bare top-level "- id: ..." item
# is an id-targeted OVERRIDE of an existing bundle entry — when the id is not in
# any bundle it warns "patch: entry %C not found" and is silently SKIPPED, so
# the server never loads. Every payload row is therefore wrapped in its own
# insert item, and legacy bare rows are converted in place on re-run.
_cordis_append() {
  local id="$1" payload="$2"
  ensure_dir "$(dirname "$CORDIS_FILE")"
  if [ ! -f "$CORDIS_FILE" ]; then
    printf '# Sylvia-managed MCP registrations (appended by install.sh).\n' > "$CORDIS_FILE"
  fi
  # Match any indentation so insert rows count too; distinguish shapes below.
  if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${id}[[:space:]]*\$" "$CORDIS_FILE"; then
    if grep -qE "^- id:[[:space:]]*${id}[[:space:]]*\$" "$CORDIS_FILE"; then
      # Legacy bare row from an older install.sh: convert it in place to an
      # insert item — indent the row and everything until the next top-level
      # "- " item (top-level bare rows are dead config: cordis skips them).
      awk -v id="$id" '
        BEGIN { inrow = 0 }
        $0 == "- id: " id { print "- insert:"; print "    " $0; inrow = 1; next }
        inrow && /^- / { inrow = 0 }
        { print (inrow ? "    " : "") $0 }
      ' "$CORDIS_FILE" > "$CORDIS_FILE.tmp.$$" && mv "$CORDIS_FILE.tmp.$$" "$CORDIS_FILE"
      if grep -qE "^- id:[[:space:]]*${id}[[:space:]]*\$" "$CORDIS_FILE"; then
        warn "legacy bare cordis entry $id could not be converted — fix $CORDIS_FILE by hand"
      else
        ok "converted legacy bare cordis entry to insert shape (id: $id)"
      fi
    else
      skip "cordis entry already present (id: $id)"
    fi
    return 0
  fi
  # Ensure a separating newline, then append the insert item (payload indented
  # one level under "- insert:").
  [ -s "$CORDIS_FILE" ] && [ "$(tail -c1 "$CORDIS_FILE" | wc -l)" -eq 0 ] && printf '\n' >> "$CORDIS_FILE"
  printf '%s\n' '- insert:' >> "$CORDIS_FILE"
  printf '%s\n' "$payload" | sed 's/^/    /' >> "$CORDIS_FILE"
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
    # Prefer the persistent uv tool (installed by the wheelhouse path): no
    # launch-time dependency resolution at all. Otherwise fall back to uvx,
    # which resolves from the local source dir on each cold start.
    if [ -x "$HOME/.local/bin/mitmproxy-mcp" ]; then
      _cordis_append "mitmproxy-mcp" "$(cat <<EOF
- id: mitmproxy-mcp
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    transport: "stdio"
    serverName: mitmproxy
    command: "$HOME/.local/bin/mitmproxy-mcp"
    args: []
    env:
      MITMPROXY_AUTO_START: "1"
    cwd: "$mitm_dir"
    toolCallTimeoutMs: 30000
EOF
)"
    else
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
    env:
      MITMPROXY_AUTO_START: "1"
    cwd: "$mitm_dir"
    toolCallTimeoutMs: 30000
EOF
)"
    fi
  }
}

# =============================================================================
#  MODULE 6.5 — default community plugins (github: specs, npm-only profile)
# =============================================================================
# DSH activates plugins ONLY through dsh.profile.bundles (bundle deps are
# presence-checked at boot; cordis.patch.yml rows are NOT needed — each plugin
# ships its own bundle patch). `dsh plugin --profile web add` is a pnpm
# forwarder and Termux has no pnpm (it would exit 127), so we do exactly what
# it would: install into the profile with npm (boot tolerates npm-produced
# node_modules — it never reads pnpm-lock.yaml) and append the INSTALLED
# package names to dsh.profile.bundles ourselves. --legacy-peer-deps mirrors
# pnpm's autoInstallPeers:false so npm cannot drop a duplicate
# @deepseek-ai/cordis into the profile (profile-first resolution would hand
# plugins a second cordis instance).
module_default_plugins() {
  CURRENT_MODULE="default plugins"
  local profile="$HOME/.dsh/profiles/web"
  local pkg_json="$profile/package.json"

  # Boot self-bootstraps the profile on first run — pre-boot, seed the same
  # minimal shape it writes (bundles = the two core bundles; cordis.yml and
  # pnpm-workspace.yaml are boot's own to create).
  if [ ! -f "$pkg_json" ]; then
    ensure_dir "$profile"
    cat > "$pkg_json" <<'SEED_EOF'
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
SEED_EOF
    note "seeded minimal profile package.json (boot-compatible shape)"
  fi

  # sylvia-bridge must be a DECLARED profile dep: npm prunes anything not in
  # package.json on every install into this dir, which used to delete the
  # module_sylvia-bridge symlink right after this module's npm runs (boot then
  # failed its import). file: deps are installed as symlinks — same target,
  # and the bridge declares no dependencies, so npm fetches nothing for it.
  local bridge_dir="$SYLVIA_HOME/sylvia-bridge"
  if [ -f "$bridge_dir/package.json" ]; then
    PLUGIN_PKG_JSON="$pkg_json" PLUGIN_BRIDGE_PATH="$bridge_dir" node <<'BRIDGE_DEP_EOF'
const fs = require("fs");
const f = process.env.PLUGIN_PKG_JSON;
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.dependencies = j.dependencies || {};
const want = "file:" + process.env.PLUGIN_BRIDGE_PATH;
if (j.dependencies["sylvia-bridge"] === want) process.exit(0);
j.dependencies["sylvia-bridge"] = want;
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
process.stdout.write("added");
BRIDGE_DEP_EOF
    # npm prunes + relinks on its next run; materialize the link NOW so a
    # skip-installs re-run still leaves a working symlink behind. Bare install
    # (no spec names — a spec of "sylvia-bridge" would look up the REGISTRY).
    if [ ! -e "$profile/node_modules/sylvia-bridge" ]; then
      ( cd "$profile" && npm install --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1 ) \
        || note "npm did not materialize the sylvia-bridge link (bridge module creates it on its own pass)"
    fi
  fi

  # spec=installed-dir pairs. Spec choice mirrors the PC profile that already
  # runs these three: cabinet from github (ships its source loadable), the
  # other two from the REGISTRY — their repos are source-only (billion's
  # `prepare` hook deliberately fails git installs: "install the published
  # package instead of the git source").
  local specs=(
    "github:Ayrlin-Renata/dsh-tool-cabinet=dsh-tool-cabinet"
    "billion-context@^0.1.201=billion-context"
    "@liustack/modsearch@^5.10.7=@liustack/modsearch"
  )
  local e spec dir
  for e in "${specs[@]}"; do
    spec="${e%%=*}"; dir="${e#*=}"
    if [ -f "$profile/node_modules/$dir/package.json" ]; then
      skip "plugin already installed: $dir"
    else
      # One npm call per plugin: github prep is slow (git-clone + prepare) and
      # a batch is all-or-nothing — per-spec attribution beats one merged wall.
      note "installing profile plugin: $spec"
      ( cd "$profile" && npm install --legacy-peer-deps --no-audit --no-fund "$spec" ) \
        || die "npm install of '$spec' failed in $profile (github: specs need git + network; registry specs need npm reachability)"
    fi
  done

  # Append the ACTUAL installed package names (package.json "name" can differ
  # from the spec, e.g. @liustack/modsearch) to dsh.profile.bundles.
  # Idempotent: existing names are left alone.
  local names=""
  for e in "${specs[@]}"; do
    dir="${e#*=}"
    if [ -f "$profile/node_modules/$dir/package.json" ]; then
      names="$names$(node -p "require(process.argv[1]).name" "$profile/node_modules/$dir/package.json" 2>/dev/null)
"
    fi
  done
  names="$(printf '%s' "$names" | sed '/^$/d')"
  [ -n "$names" ] || die "default plugins landed but their package.json names are unreadable in $profile"
  local bundles_out
  bundles_out="$(PLUGIN_PKG_JSON="$pkg_json" PLUGIN_BUNDLE_NAMES="$names" node <<'BUNDLES_EOF'
const fs = require("fs");
const f = process.env.PLUGIN_PKG_JSON;
const names = (process.env.PLUGIN_BUNDLE_NAMES || "").split("\n").filter(Boolean);
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
const b = (j.dsh.profile.bundles = j.dsh.profile.bundles || []);
const added = names.filter((n) => n && !b.includes(n));
for (const n of added) b.push(n);
if (added.length) fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
process.stdout.write(added.length ? added.join(" ") : "already");
BUNDLES_EOF
)"
  if [ "$bundles_out" = "already" ]; then
    skip "dsh.profile.bundles already lists the default plugins"
  else
    ok "bundles registered: $bundles_out"
  fi

  # engines.dsh gating: boot silently SKIPS a bundle whose engines.dsh the
  # current train doesn't satisfy. The DSH-owned allow-version subcommand runs
  # WITHOUT pnpm — use it proactively when a plugin declares engines.dsh.
  local pj ver eng
  for e in "${specs[@]}"; do
    dir="${e#*=}"
    pj="$profile/node_modules/$dir/package.json"
    [ -f "$pj" ] || continue
    eng="$(node -p "const x=require(process.argv[1]).engines; x && x.dsh ? x.dsh : ''" "$pj" 2>/dev/null || true)"
    [ -n "$eng" ] || continue
    ver="$(node -p "require(process.argv[1]).version" "$pj" 2>/dev/null || true)"
    note "$dir declares engines.dsh '$eng' — accepting for ${SYLVIA_DSH_TARGET_VER:-0.2.1-alpha.5}"
    dsh plugin --profile web allow-version "$dir@$ver" \
      --dsh-version "${SYLVIA_DSH_TARGET_VER:-0.2.1-alpha.5}" --accept-risk \
      >/dev/null 2>&1 || note "allow-version did not confirm for $dir (boot will be the judge)"
  done
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
#!/data/data/com.termux/files/usr/bin/bash
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

# --no-open: DSH's own auto-open fires BEFORE the plugin tree finishes
# loading, so it pops a browser even when boot crashes. Open it ourselves
# from captured output instead:
#   - 0.2.1+ serves token auth (bare / answers 401; the server prints a
#     one-time http://.../?token= URL) → open THAT url.
#   - older trains answer 200 directly → open the plain url.
web_log="$SYLVIA_HOME/dsh-web.log"
rm -f "\$web_log"
node --expose-internals "$dsh_bin" web --port "\${SYLVIA_WEB_PORT:-3080}" --no-open >> "\$web_log" 2>&1 &
web_pid=\$!
( for i in \$(seq 1 90); do
    # Token is base64url: it may contain '-' and '_'. Matching only
    # [A-Za-z0-9] truncates the token at the first of those characters,
    # which makes the browser open a corrupted link and land on 401 --
    # intermittently, depending on the minted token. Hence the full class.
    tok=\$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-][A-Za-z0-9_-]*' "\$web_log" 2>/dev/null | head -n1 || true)
    if [ -n "\$tok" ]; then
      sleep 2   # let the plugin tree settle before the first page request
      termux-open-url "\$tok" >/dev/null 2>&1 || true
      exit 0
    fi
    if curl -sf "http://127.0.0.1:\${SYLVIA_WEB_PORT:-3080}/" >/dev/null 2>&1; then
      termux-open-url "http://127.0.0.1:\${SYLVIA_WEB_PORT:-3080}" >/dev/null 2>&1 || true
      exit 0
    fi
    kill -0 \$web_pid 2>/dev/null || exit 0
    sleep 1
  done ) >/dev/null 2>&1 &
trap 'kill \$web_pid 2>/dev/null || true' INT TERM
wait "\$web_pid"
EOF
  chmod +x "$SYLVIA_HOME/start-sylvia.sh"
  ok "wrote $SYLVIA_HOME/start-sylvia.sh"

  # --- sylvia-adb-connect.sh -------------------------------------------------
  cat > "$SYLVIA_HOME/sylvia-adb-connect.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
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

  # --- mobile.css starter (the custom-CSS seam's target file) ----------------
  # sylvia-bridge inlines $SYLVIA_HOME/mobile.css into every index render, so
  # edits apply on the next browser refresh (no restart). Seed a starter once
  # and never overwrite — this file is the user/agent's mobile-styling
  # workspace. Missing starter is not fatal: the bridge simply injects nothing.
  if [ -f "$SYLVIA_HOME/mobile.css" ]; then
    skip "$SYLVIA_HOME/mobile.css already exists"
  else
    local css_src="$SCRIPT_DIR/assets/mobile.css"
    if [ ! -f "$css_src" ] && [ ! -f "$SYLVIA_HOME/repo/assets/mobile.css" ]; then
      # curl | bash runs with no repo beside the script — clone once (shared
      # with the patches/ module, which may already have done this).
      ensure_dir "$SYLVIA_HOME"
      note "cloning Sylvia repo for assets/mobile.css: $SYLVIA_REPO_URL"
      rm -rf "$SYLVIA_HOME/repo"
      git clone --depth 1 "$SYLVIA_REPO_URL" "$SYLVIA_HOME/repo" \
        || note "repo clone failed (skipped) — CSS seam stays inert until $SYLVIA_HOME/mobile.css exists"
    fi
    [ -f "$css_src" ] || css_src="$SYLVIA_HOME/repo/assets/mobile.css"
    if [ -f "$css_src" ]; then
      cp "$css_src" "$SYLVIA_HOME/mobile.css" || die "could not seed $SYLVIA_HOME/mobile.css"
      ok "seeded $SYLVIA_HOME/mobile.css (edit + browser refresh applies live)"
    else
      note "starter assets/mobile.css not found (skipped) — nothing is injected until $SYLVIA_HOME/mobile.css exists"
    fi
  fi
}

# =============================================================================
#  MODULE 8.4 — Termux:Boot autostart (non-fatal; inert unless app installed)
# =============================================================================
# Termux:Boot runs every script in ~/.termux/boot/ once, at device boot. We
# seed a launcher there so the harness survives reboots with zero manual
# steps. Two platform facts make this graceful rather than fragile:
#   * The Termux:Boot companion app may not be installed — the script is
#     seeded anyway (it is inert without the app) and the user is told.
#   * Android only registers Termux:Boot's receiver after the app has been
#     opened at least once post-install — we print that reminder.
module_termux_boot() {
  CURRENT_MODULE="termux boot"
  local boot_dir="$HOME/.termux/boot"
  local boot_script="$boot_dir/10-sylvia.sh"
  mkdir -p "$boot_dir" || { note "could not create $boot_dir (skipped)"; return 0; }

  if [ -f "$boot_script" ] && [ "${SYLVIA_FORCE:-}" != "1" ]; then
    skip "$boot_script already exists"
  else
    cat > "$boot_script" << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Sylvia harness autostart — executed by Termux:Boot once, at device boot.
# Take the wake lock first so doze does not strangle the harness on boot.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
exec bash "$HOME/.sylvia/start-sylvia.sh"
EOF
    chmod +x "$boot_script"
    ok "seeded $boot_script (harness autostarts at device boot)"
  fi

  # Detect the companion app; absent it, the boot script is harmless but dead.
  if command -v pm >/dev/null 2>&1 && pm list packages 2>/dev/null | grep -q "com.termux.boot"; then
    note "Termux:Boot installed — if freshly installed, OPEN the app once before"
    note "the next reboot (Android only registers the boot receiver then)"
  else
    note "Termux:Boot app not detected — install it from F-Droid (same source as"
    note "Termux) and open it once; the seeded script stays inert until then"
  fi
}

# =============================================================================
#  MODULE 8.5 — attempt the ADB loopback now (non-fatal)
# =============================================================================
# Best-effort: on an emulator (or with Wireless debugging already enabled) the
# loopback comes up immediately; otherwise this fails harmlessly and the
# summary tells the user how to run it later.
module_adb_connect() {
  CURRENT_MODULE="adb loopback"
  ADB_LOOPBACK_STATUS="not connected"
  if bash "$SYLVIA_HOME/sylvia-adb-connect.sh"; then
    ADB_LOOPBACK_STATUS="connected"
    ok "ADB loopback established"
  else
    note "could not connect yet — enable Developer options -> Wireless"
    note "debugging (phone) or start the emulator, then run:"
    note "  ${SYLVIA_HOME/#$HOME/\~}/sylvia-adb-connect.sh"
  fi
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
# NOTE: PyPI ships no android/bionic wheels for mitmproxy's native deps
# (bcrypt, cryptography, cffi, zstandard, pylsqpack, ...), so uv builds them
# from source and the build needs a Rust + C toolchain on Termux. The
# toolchain is installed just-in-time here, only when mitmdump is missing —
# a one-time source build that can take several minutes. References:
# termux-packages#25440 (mitmproxy build), #16746 (the CFLAGS below are
# Free MB on the filesystem holding $HOME (echoes 0 when df is unparseable).
sylvia_free_mb() {
  local _kb
  _kb=$(df -k "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
  case "$_kb" in ''|*[!0-9]*) echo 0 ;; *) echo $(( _kb / 1024 )) ;; esac
}

# Reclaim package-manager caches (safe: re-downloadable). Source builds leave
# large debris behind after a failed run — this clears it before retrying.
sylvia_reclaim_caches() {
  npm cache clean --force >/dev/null 2>&1 || true
  uv cache clean >/dev/null 2>&1 || true
  apt clean >/dev/null 2>&1 || true
}

# uv installs tool executables (mitmdump, mitmproxy-mcp, ...) to ~/.local/bin.
# Make them visible to THIS run and to future shells. Idempotent.
sylvia_ensure_local_bin() {
  case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
  grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null \
    || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
}

# Resolve + validate a prebuilt wheelhouse (see build-wheelhouse.sh) into
# $SYLVIA_HOME/wheelhouse. Sets WHEELHOUSE_DIR and returns 0 on success.
# The tarball name AND its manifest must both match this device's arch and
# CPython version — a wheelhouse from a different device/ABI cannot work, so
# a mismatch is a warning + source-build fallback, never a hard install.
WHEELHOUSE_DIR=""
sylvia_wheelhouse_resolve() {
  local tarball="" arch pyver expected
  arch=$(uname -m)
  pyver=$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo unknown)
  expected="sylvia-wheelhouse-$arch-cp${pyver/./}.tar.gz"

  if [ -n "${SYLVIA_WHEELHOUSE_DIR:-}" ]; then
    if [ -f "${SYLVIA_WHEELHOUSE_DIR%/}/$expected" ]; then
      tarball="${SYLVIA_WHEELHOUSE_DIR%/}/$expected"
    else
      warn "no wheelhouse for this device in $SYLVIA_WHEELHOUSE_DIR (want $expected)"
      return 1
    fi
  elif [ -n "${SYLVIA_WHEELHOUSE_URL:-}" ]; then
    local base dl
    base=$(basename "${SYLVIA_WHEELHOUSE_URL%%\?*}")
    dl="$SYLVIA_HOME/downloads/$base"
    if [ ! -f "$dl" ]; then
      ensure_dir "$SYLVIA_HOME/downloads"
      note "downloading wheelhouse: $SYLVIA_WHEELHOUSE_URL"
      if ! curl -fL --retry 3 -o "$dl.part" "$SYLVIA_WHEELHOUSE_URL"; then
        rm -f "$dl.part"
        warn "wheelhouse download failed"
        return 1
      fi
      mv "$dl.part" "$dl"
    fi
    tarball="$dl"
  else
    return 1
  fi

  # Trust, but verify: even a correctly-named file may be a stale build.
  local tmp m_arch m_py
  tmp=$(mktemp -d)
  if ! tar -xzf "$tarball" -C "$tmp" 2>/dev/null; then
    rm -rf "$tmp"; warn "wheelhouse tarball unreadable: $tarball"
    return 1
  fi
  m_arch=$(sed -n 's/^arch=//p' "$tmp/manifest.txt" 2>/dev/null | head -1)
  m_py=$(sed -n 's/^python=//p' "$tmp/manifest.txt" 2>/dev/null | head -1)
  if [ "$m_arch" != "$arch" ] || [ "$m_py" != "$pyver" ]; then
    warn "wheelhouse built for arch=$m_arch python=$m_py, but this device is arch=$arch python=$pyver — ignoring it (source build will be used)"
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$SYLVIA_HOME/wheelhouse"
  mv "$tmp" "$SYLVIA_HOME/wheelhouse"
  WHEELHOUSE_DIR="$SYLVIA_HOME/wheelhouse"
  return 0
}

# mandatory for ruamel.yaml.clib), drygdryg's gist (proven recipe).
# =============================================================================
#  Native extension load fixes for Termux (patchelf; idempotent)
# =============================================================================
#  Two native extensions in the mitm trees fail to dlopen on Termux as
#  built, both verified by import tests on the emulator:
#   * mitmproxy_rs.abi3.so (abi3 wheel) carries NO libpython NEEDED, and
#     Termux's python exe exports no C API at all (.dynsym is a 6-entry
#     stub around Py_BytesMain; Termux's own extensions all link
#     libpython3.14.so explicitly) -> add that NEEDED entry so the C API
#     resolves from libpython3.14.so instead of the global scope.
#   * curl_cffi/_wrapper.abi3.so NEEDs "libc++.so", which bionic resolves
#     to the Android SYSTEM libc++ (its std::__ndk1 symbols are hidden)
#     instead of Termux's $PREFIX/lib/libc++_shared.so (1909 exported
#     __ndk1 symbols, including the sort instantiations the static
#     libcurl-impersonate references) -> replace-needed with
#     libc++_shared.so, which bionic finds via LD_LIBRARY_PATH.
#  Re-runs re-patch any copy uv re-created from an unpatched cache entry.
_mitm_patchelf_fixes() {
  local root so
  for root in "$HOME/.cache/uv" "$HOME/.local/share/uv"; do
    [ -d "$root" ] || continue
    while IFS= read -r so; do
      [ -n "$so" ] || continue
      case "$so" in
        *mitmproxy_rs*)
          if ! patchelf --print-needed "$so" 2>/dev/null | grep -q '^libpython3\.14\.so$'; then
            patchelf --add-needed libpython3.14.so "$so" \
              && note "patchelf: +libpython3.14.so ${so##*/uv/}"
          fi
          ;;
        *_wrapper*)
          if patchelf --print-needed "$so" 2>/dev/null | grep -q '^libc++\.so$'; then
            patchelf --replace-needed libc++.so libc++_shared.so "$so" \
              && note "patchelf: libc++.so -> libc++_shared.so ${so##*/uv/}"
          fi
          ;;
      esac
    done < <(find "$root" \( -name 'mitmproxy_rs.abi3.so' -o -name '_wrapper*.so' \) 2>/dev/null)
  done
}

module_mitm_mcp() {
  CURRENT_MODULE="mitmproxy"
  sylvia_ensure_local_bin   # so `have mitmdump` sees ~/.local/bin right away

  # 0. Prebuilt wheelhouse fast path (build-wheelhouse.sh): installs BOTH the
  #    mitmproxy CLI and the mitmproxy-mcp server as persistent uv tools,
  #    fully offline, skipping the source build entirely. On any failure we
  #    fall through to the source path below — the wheelhouse is an
  #    optimization, never a requirement.
  local used_wheelhouse=0
  if sylvia_wheelhouse_resolve; then
    note "installing from prebuilt wheelhouse ($WHEELHOUSE_DIR)"
    if ! have mitmdump; then
      if uv tool install --find-links "$WHEELHOUSE_DIR" --no-index mitmproxy; then
        ok "mitmproxy CLI installed from wheelhouse ($(command -v mitmdump))"
        used_wheelhouse=1
      else
        warn "wheelhouse install of mitmproxy failed — falling back to source build"
      fi
    fi
    # Persistent tool replaces the launch-time `uvx` (which would otherwise
    # re-resolve mitmproxy's whole tree on first start). Built by
    # build-wheelhouse.sh with its requires-python pin already relaxed.
    if ! have mitmproxy-mcp; then
      if uv tool install --find-links "$WHEELHOUSE_DIR" --no-index mitmproxy-mcp; then
        ok "mitmproxy-mcp installed from wheelhouse (persistent tool, no uvx)"
        used_wheelhouse=1
      elif [ "$used_wheelhouse" -eq 0 ]; then
        warn "wheelhouse install of mitmproxy-mcp failed — uvx fallback will be used"
      fi
    fi
  fi

  # 1. mitmproxy CLI on PATH (uv-managed tool env; skip if already present).
  if have mitmdump; then
    skip "mitmproxy CLI already installed ($(command -v mitmdump))"
  else
    # Preflight: source builds (cmake bootstrap, rust crates) peak at multiple
    # GB. Check BEFORE touching pkg/apt, reclaim caches if low, die with
    # actionable advice instead of hitting ENOSPC mid-build.
    local min_mb="${SYLVIA_MIN_FREE_MB:-3072}"
    local free_mb
    free_mb=$(sylvia_free_mb)
    if [ "$free_mb" -lt "$min_mb" ]; then
      note "only ${free_mb}MB free (need ${min_mb}MB) — reclaiming package caches first"
      sylvia_reclaim_caches
      free_mb=$(sylvia_free_mb)
      if [ "$free_mb" -lt "$min_mb" ]; then
        die "low disk space: ${free_mb}MB free, need ${min_mb}MB to source-build mitmproxy.
       Check with:  df -h
       Fix: free space on the device. On an emulator, enlarge the AVD data
       partition (config.ini: disk.dataPartition.size=16G, then cold-boot or
       recreate the AVD).  You can lower the threshold only if you are sure:
       SYLVIA_MIN_FREE_MB=<MB> bash install.sh"
      fi
      ok "disk after reclaim: ${free_mb}MB free"
    fi

    # Each dep is have-checked, so a pre-existing toolchain is reused as-is.
    local build_deps=()
    have cargo      || build_deps+=(rust)       # bcrypt/cryptography/pylsqpack (Rust)
    have ld         || build_deps+=(binutils)   # linker for the Rust builds
    have clang      || build_deps+=(clang)      # C extensions (cffi, tornado, msgpack, ...)
    have make       || build_deps+=(make)       # some sdists drive make
    have pkg-config || build_deps+=(pkg-config) # cryptography locates OpenSSL with it
    have openssl    || build_deps+=(openssl)    # cryptography's build needs its headers
    # argon2-cffi-bindings >=26 (pulled in by mitmproxy) uses scikit-build-core,
    # which otherwise DOWNLOADS and COMPILES CMake from source when PyPI ships no
    # cmake wheel for the platform (Android) — a slow bootstrap that can crash the
    # build (exit 11). A system cmake on PATH is used instead and skips it
    # entirely (hynek/argon2-cffi-bindings#142). Native pkg, cheap to keep.
    have cmake      || build_deps+=(cmake)
    if [ ${#build_deps[@]} -gt 0 ]; then
      note "installing mitmproxy build toolchain: ${build_deps[*]}"
      pkg update -y >/dev/null 2>&1 || warn "pkg update returned non-zero; continuing"
      if [ "$FORCE_CONFNEW" -eq 1 ]; then
        pkg install -y -o "Dpkg::Options::=--force-confnew" "${build_deps[@]}" \
          || die "pkg install failed for: ${build_deps[*]}"
      else
        pkg install -y "${build_deps[@]}" || die "pkg install failed for: ${build_deps[*]}"
      fi
      record_packages "${build_deps[@]}"
    fi

    # The build: stream output to a log so ENOSPC can be detected. One
    # cache-reclaim retry (failed builds leave debris that itself fills disk).
    note "building mitmproxy from source (no android wheels on PyPI; one-time, can take minutes)"
    # -Wno-incompatible-function-pointer-types: required to compile
    # ruamel.yaml.clib with Termux clang>=15 (termux-packages#16746).
    local mitm_log="$SYLVIA_HOME/.mitmproxy-build.log"
    ensure_dir "$SYLVIA_HOME"
    : > "$mitm_log"
    local mitm_attempt
    for mitm_attempt in 1 2; do
      if CFLAGS="-Wno-incompatible-function-pointer-types" \
          uv tool install --with 'argon2-cffi-bindings<26' mitmproxy 2>&1 | tee -a "$mitm_log"; then
        break
      fi
      if grep -q "No space left on device" "$mitm_log" 2>/dev/null; then
        if [ "$mitm_attempt" -eq 1 ]; then
          warn "build ran out of disk space — reclaiming caches and retrying once"
          sylvia_reclaim_caches
          free_mb=$(sylvia_free_mb)
          note "free space now: ${free_mb}MB"
          continue
        fi
        die "mitmproxy build is out of disk space (again: ${free_mb}MB free).
       Full log: $mitm_log
       Check with:  df -h  — free space or enlarge the AVD data partition
       (config.ini: disk.dataPartition.size=16G), then re-run this installer."
      fi
      die "uv tool install mitmproxy failed (source build).
       Full log: $mitm_log
       The build toolchain was installed above. Verify manually with:
         pkg install rust binutils clang make pkg-config openssl cmake
         CFLAGS='-Wno-incompatible-function-pointer-types' uv tool install --with 'argon2-cffi-bindings<26' mitmproxy"
    done
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
  local fresh_clone=0
  if [ -f "$dir/pyproject.toml" ]; then
    skip "mitmproxy-mcp already cloned ($dir)"
  elif [ -d "$SCRIPT_DIR/reference/mitmproxy-mcp" ]; then
    ensure_dir "$SYLVIA_HOME"
    rm -rf "$dir"; cp -r "$SCRIPT_DIR/reference/mitmproxy-mcp" "$dir" || die "could not copy mitmproxy-mcp from reference/"
    fresh_clone=1
  else
    ensure_dir "$SYLVIA_HOME"
    git clone --depth 1 https://github.com/snapspecter/mitmproxy-mcp.git "$dir" || die "git clone of mitmproxy-mcp failed"
    fresh_clone=1
  fi
  if [ "$fresh_clone" -eq 1 ]; then
    ok "mitmproxy-mcp source ready ($dir)"
  fi

  # --- pyproject patches: re-checked on EVERY run (a clone made by an older
  # --- installer version must still receive them; both seds are idempotent).

  # Upstream pins 'requires-python = ">=3.12,<3.14"', which rejects Termux's
  # python 3.14 even though mitmproxy 12.2.3 itself supports 3.14 — without
  # this, `uvx --from <dir> mitmproxy-mcp` fails at first launch. Relax the
  # pin in place (idempotent).
  if grep -q 'requires-python = ">=3.12,<3.14"' "$dir/pyproject.toml" 2>/dev/null; then
    sed -i.bak 's/requires-python = ">=3.12,<3.14"/requires-python = ">=3.12,<'\
'3.15"/' "$dir/pyproject.toml" && rm -f "$dir/pyproject.toml.bak"
    note "relaxed mitmproxy-mcp requires-python pin (<3.14 -> <3.15) for python $(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  fi

  # playwright>=1.58.0 is a phantom dependency: the runtime never imports it
  # (only code-gen templates + tests mention it), yet it is wheel-only with
  # no android tag, so uvx cannot resolve the project on Termux at all
  # ("no wheels with a matching platform tag (e.g. android_24_x86_64)").
  # Comment the line out — TOML comments are legal inside arrays.
  if grep -q '^[[:space:]]*"playwright>=1.58.0",' "$dir/pyproject.toml" 2>/dev/null; then
    sed -i 's|^[[:space:]]*"playwright>=1.58.0",|# sylvia: playwright dep removed (no Android wheel; runtime never imports it — code-gen templates only)|' \
      "$dir/pyproject.toml"
    note "removed unresolvable playwright dep from mitmproxy-mcp pyproject"
  fi

  # argon2-cffi-bindings >=26 switched to scikit-build-core, whose Android
  # handling assumes an NDK cross-compile (empty CMAKE_SYSROOT on Termux ->
  # CMake dies with "file failed to open for reading:
  # /include/android/api-level.h"). v25 and earlier build with plain cffi +
  # clang. mitmproxy's tree accepts 25.x (argon2-cffi wants >=21.2.0), so a
  # local dep line constrains the resolve; uv intersects it automatically.
  if ! grep -q '"argon2-cffi-bindings' "$dir/pyproject.toml" 2>/dev/null; then
    sed -i 's|^\([[:space:]]*\)"python-dotenv>=1.0.0",|\1"python-dotenv>=1.0.0",\n\1"argon2-cffi-bindings<26",  # sylvia: v26+ needs scikit-build Android/NDK sysroot; v25 builds natively on Termux|' \
      "$dir/pyproject.toml"
    if grep -q '"argon2-cffi-bindings<26"' "$dir/pyproject.toml" 2>/dev/null; then
      note "pinned argon2-cffi-bindings<26 in mitmproxy-mcp pyproject (v26 scikit-build cannot build on Termux)"
    else
      die "could not add the argon2-cffi-bindings pin to mitmproxy-mcp/pyproject.toml.
       Upstream likely changed the dependencies layout. Inspect:
         $dir/pyproject.toml
       then add \"argon2-cffi-bindings<26\", to [project] dependencies and re-run."
    fi
  fi

  # curl-cffi: its build script matches the host against libs.json, which
  # only lists Android/aarch64 — an x86_64 device dies with
  # "Unsupported arch: uname_result(system='Android', machine='x86_64')"
  # (and curl_cffi IS imported at runtime: core/server.py), so the dep
  # cannot be dropped. Upstream DOES publish the x86_64-android
  # libcurl-impersonate asset, so build a one-time wheel from a sdist with
  # that entry added and point the project at it via a PEP 508 file URL.
  # arm64 devices have a matching upstream entry and resolve PyPI normally
  # (no local wheel, no file reference).
  if [ "$(uname -m)" = "x86_64" ]; then
    local ccffi_ver="0.16.3"
    local wh="$dir/wheelhouse"
    ensure_dir "$wh"
    local ccffi_wheel
    # pipefail: a not-yet-existing glob makes `ls` exit 2 through the pipe.
    ccffi_wheel=$(ls "$wh"/curl_cffi-*.whl 2>/dev/null | head -n 1) || true
    if [ -z "$ccffi_wheel" ]; then
      note "building patched curl-cffi wheel (upstream libs.json has no Android/x86_64 entry)"
      local tmp
      tmp=$(mktemp -d "${TMPDIR:-${PREFIX:-/data/data/com.termux/files/usr}/tmp}/ccffi.XXXXXX")
      curl -fsSL -o "$tmp/curl_cffi-$ccffi_ver.tar.gz" \
        "https://files.pythonhosted.org/packages/source/c/curl-cffi/curl_cffi-$ccffi_ver.tar.gz" \
        || { rm -rf "$tmp"; die "download of curl-cffi $ccffi_ver sdist failed"; }
      tar -xzf "$tmp/curl_cffi-$ccffi_ver.tar.gz" -C "$tmp" \
        || { rm -rf "$tmp"; die "extraction of curl-cffi sdist failed"; }
      python - "$tmp/curl_cffi-$ccffi_ver/libs.json" <<'PYEOF' \
        || { rm -rf "$tmp"; die "patching curl-cffi libs.json failed"; }
import json, sys
path = sys.argv[1]
with open(path) as f:
    table = json.load(f)
if not any(e.get("system") == "Android" and e.get("machine") == "x86_64" for e in table):
    table.append({
        "system": "Android", "machine": "x86_64", "pointer_size": 64,
        "sysname": "linux-android", "link_type": "static", "libc": "android",
        "obj_name": "libcurl-impersonate.a", "arch": "x86_64",
    })
    with open(path, "w") as f:
        json.dump(table, f, indent=4)
    print("libs.json: added Android/x86_64 entry")
else:
    print("libs.json: Android/x86_64 entry already present")
PYEOF
      uv build --wheel -o "$wh" "$tmp/curl_cffi-$ccffi_ver" \
        || { local rc=$?; rm -rf "$tmp"; die "uv build of patched curl-cffi failed (exit $rc).
       Needs: pkg install clang (see the mitmproxy build toolchain above) + network to
       github.com/lexiforest/curl-impersonate (static libcurl download)."; }
      rm -rf "$tmp"
      ccffi_wheel=$(ls "$wh"/curl_cffi-*.whl 2>/dev/null | head -n 1) || true
      [ -n "$ccffi_wheel" ] || die "patched curl-cffi wheel not found in $wh after build"
      ok "patched curl-cffi wheel built ($(basename "$ccffi_wheel"))"
    else
      skip "patched curl-cffi wheel already built ($(basename "$ccffi_wheel"))"
    fi
    # Point the dependency at the local wheel (idempotent).
    if ! grep -q '"curl-cffi @ file:' "$dir/pyproject.toml" 2>/dev/null; then
      sed -i "s|^[[:space:]]*\"curl-cffi>[^\"]*\",|    \"curl-cffi @ file://${ccffi_wheel}\",|" "$dir/pyproject.toml"
      if grep -q '"curl-cffi @ file:' "$dir/pyproject.toml" 2>/dev/null; then
        note "mitmproxy-mcp pyproject now uses the local patched curl-cffi wheel"
      else
        die "could not repoint curl-cffi at the local wheel in $dir/pyproject.toml.
       Upstream changed the dependencies layout — edit it by hand:
         \"curl-cffi>=...\ -> \"curl-cffi @ file://${ccffi_wheel}\",
       then re-run this installer."
      fi
    fi
  fi

  # 3. google-re2 build headers. uv compiles every C dependency from source
  # on Termux (PyPI wheels carry only manylinux/macos/win tags), and
  # google-re2's sdist expects SYSTEM pybind11 headers (its build backend
  # doesn't declare pybind11, so the isolated build env lacks them —
  # "fatal error: 'pybind11/buffer_info.h' file not found") plus libre2 to
  # link against. re2 IS imported at module top level (core/server.py,
  # core/interceptor.py), so the dependency itself cannot be dropped.
  local inc="${PREFIX:-/data/data/com.termux/files/usr}/include"
  if [ ! -d "$inc/pybind11" ] || [ ! -f "$inc/re2/re2.h" ]; then
    note "installing pybind11 + libre2 headers (google-re2 source build needs them)"
    if ! pkg install -y pybind11 libre2 2>/dev/null; then
      pkg update -y >/dev/null 2>&1 || warn "pkg update returned non-zero; continuing"
      pkg install -y pybind11 libre2 || die "pkg install pybind11 libre2 failed — mitmproxy-mcp cannot build google-re2 without them.
       Fix (then re-run this installer):  pkg install pybind11 libre2"
    fi
    record_packages pybind11 libre2
    ok "google-re2 build headers installed"
  fi

  # 4. Native extension load fixes (see _mitm_patchelf_fixes for the why).
  # Idempotent, and re-run every time to repair copies uv re-created from
  # an unpatched cache entry.
  if ! have patchelf; then
    note "installing patchelf (mitm native-extension load fixes)"
    pkg install -y patchelf || die "pkg install patchelf failed — install it manually and re-run"
    record_packages patchelf
  fi
  _mitm_patchelf_fixes

  # 5. Warm-build the uvx env NOW instead of at first harness boot. The MCP
  # client's initial handshake runs on a timeout, while the first source
  # build takes minutes (every C dep compiles) — booting into that would
  # time the mitmproxy server out and leave its tools missing until a manual
  # reload. stdin is closed: the server builds, starts, reads EOF and exits;
  # uv caches the env so later launches are seconds. Best-effort only — on
  # failure/timeout the first boot builds it instead (tools may then need a
  # reload to appear).
  if ! have mitmproxy-mcp; then
    note "pre-building mitmproxy-mcp venv (one-time source compile, can take minutes)"
    local warm_log="$SYLVIA_HOME/.mitmproxy-mcp-warm.log"
    if timeout 600 uvx --from "$dir" mitmproxy-mcp </dev/null >"$warm_log" 2>&1; then
      ok "mitmproxy-mcp venv built and cached (first launch will be fast)"
    else
      warn "mitmproxy-mcp pre-build incomplete (timeout or error) — first boot will build it;
       mitmproxy tools may need a reload to appear. Full log: $warm_log"
    fi

    # 6. Re-patch AFTER the warm build. curl_cffi (a mitmproxy-mcp dep, NOT
    #    mitmproxy) only compiles here, so its _wrapper.abi3.so did not exist
    #    during step 4's scan — as built it NEEDs the Android system
    #    "libc++.so" (hidden std::__ndk1 symbols) and dies with a dlopen
    #    "cannot locate symbol _ZNSt6__ndk16__sort..." error. Step 4 already
    #    rewrites it to libc++_shared.so once it exists; without this second
    #    pass the just-compiled copy stays broken and every boot fails the
    #    same way. Both copies uv keeps are hardlinks to one cache object, so
    #    patching the found path covers them. Idempotent: step 4's
    #    grep-guard makes a re-run a no-op.
    _mitm_patchelf_fixes
  fi
}

# =============================================================================
#  SUMMARY
# =============================================================================
print_summary() {
  CURRENT_MODULE="summary"
  local bar="────────────────────────────────────────────"
  # Keep every line narrow (Termux on a phone wraps ~50 cols) and only
  # actionable info: ports + first steps. No paths, no tool listings.
  printf '\n%s\n' "$bar"
  printf '%sSylvia install complete.%s\n' "$c_grn" "$c_reset"
  printf '%s\n' "$bar"
  cat <<EOF
  Harness        http://127.0.0.1:${SYLVIA_WEB_PORT}
  Control panel  http://127.0.0.1:${SYLVIA_DAEMON_PORT}

  1. Start the harness (also starts
     the daemon):
        ${SYLVIA_HOME/#$HOME/\~}/start-sylvia.sh

  2. Open the harness URL and enter
     your model API key on the
     Models page.

  3. The control panel URL shows
     network state, netgate,
     resources, and modules.

  ADB loopback: ${ADB_LOOPBACK_STATUS}
EOF
  [ "$ADB_LOOPBACK_STATUS" = "not connected" ] && cat <<EOF
     (enable Wireless debugging or
     start the emulator, then run
     ${SYLVIA_HOME/#$HOME/\~}/sylvia-adb-connect.sh)
EOF
  cat <<EOF

  The web UI is loopback-only and
  unauthenticated: never add
  --host 0.0.0.0.
EOF
  [ "$WITH_TASKER" -eq 1 ] && printf '  tasker-mcp: import the MCP project\n  in Tasker to finish setup.\n'
  printf '%s\n' "$bar"
}

# =============================================================================
#  ARG PARSING + ORCHESTRATION
# =============================================================================
for arg in "$@"; do
  case "$arg" in
    --with-tasker) WITH_TASKER=1 ;;
    --force)       FORCE=1 ;;
    --force-confnew) FORCE_CONFNEW=1 ;;
    -h|--help)     sed -n '2,48p' "$0" 2>/dev/null || printf '%s\n' \
                     "Usage: bash install.sh [--with-tasker] [--force] [--force-confnew] [--help]"; exit 0 ;;
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
module_native_binding
module_ambient_deps
module_sylvia_mcp
module_sylvia_daemon
module_local_modules
module_sylvia_bridge
module_tasker_mcp
module_mitm_mcp
module_register_mcp
module_default_plugins
module_launchers
module_termux_boot
module_adb_connect
print_summary
