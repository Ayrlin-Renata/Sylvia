#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
#  build-wheelhouse.sh — build a prebuilt mitmproxy wheelhouse for this device
# =============================================================================
#
#  WHY: mitmproxy (and mitmproxy-mcp's wider tree: curl-cffi, google-re2,
#  pydantic-core, ...) has no PyPI wheels for Termux, so a plain
#  `uv tool install` source-builds everything — Rust + C, multiple GB of peak
#  disk, 15-30 min on a phone, and it re-happens on every fresh install.
#  This script does that build ONCE per device and packages the result as a
#  tarball that install.sh can consume fully offline:
#
#      bash build-wheelhouse.sh
#        -> sylvia-wheelhouse-<arch>-cp<ver>.tar.gz
#
#      SYLVIA_WHEELHOUSE_DIR=<dir-with-tarball>  bash install.sh   # local
#      SYLVIA_WHEELHOUSE_URL=<url-of-tarball>    bash install.sh   # downloaded
#
#  ARCHITECTURE / ABI CAVEAT (the reason this is per-device, not one universal
#  file): native wheels embed the CPU arch and the CPython ABI. A wheelhouse
#  built on the x86_64 emulator will NOT run on an arm64 phone, and a
#  wheelhouse built on python 3.13 will not load on 3.14. install.sh validates
#  the manifest and falls back to a source build on any mismatch — the
#  wheelhouse is strictly a speed/robustness optimization, never a requirement.
#
#  Optional accelerator: --extra-index-url TUR lets pip grab prebuilt
#  android_24 wheels (aioquic, ...) where they exist; anything absent simply
#  builds from source like before. Build-time only; the installed wheelhouse
#  itself is offline.
#
#  Run inside Termux (F-Droid build) on the target device. Requires the same
#  toolchain install.sh uses; this script installs it just-in-time.
#
#  Flags:
#    --force-confnew   pkg installs use -o Dpkg::Options::=--force-confnew
#    -h, --help        this text
#
#  Environment:
#    SYLVIA_WHEELHOUSE_OUT      output directory (default: <repo>/wheelhouse)
#    SYLVIA_MIN_FREE_MB         disk floor before building (default 3072)
#    SYLVIA_MITM_VERSION        pin a mitmproxy version (default: resolver)
#    SYLVIA_FORCE=1             allow running outside Termux (tests only)
#
# =============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYLVIA_HOME="${SYLVIA_HOME:-$HOME/.sylvia}"
OUT_DIR="${SYLVIA_WHEELHOUSE_OUT:-$SCRIPT_DIR/wheelhouse}"
FORCE_CONFNEW=0
TUR_INDEX="https://termux-user-repository.github.io/pypi/"
MIN_PY="3.12"
MAX_PY_EXCL="3.15"   # mitmproxy-mcp's own pin is relaxed to match (see below)

note() { printf '[wheelhouse] %s\n' "$*"; }
ok()   { printf '[wheelhouse] OK: %s\n' "$*"; }
warn() { printf '[wheelhouse] WARN: %s\n' "$*" >&2; }
die()  { printf '[wheelhouse] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

for arg in "$@"; do
  case "$arg" in
    --force-confnew) FORCE_CONFNEW=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

# --- preconditions -----------------------------------------------------------
if [ -z "${SYLVIA_FORCE:-}" ]; then
  [ -n "${TERMUX_VERSION:-}" ] || die "this script must run inside Termux.
   The wheelhouse is per-device (arch + CPython ABI); build it on the device
   that will use it (or an identical one)."
fi
have python || die "python not found (pkg install python)"
have pip || have python-pip || python -m pip --version >/dev/null 2>&1 \
  || die "pip not found (pkg install python includes it; check 'python -m pip --version')"

PYVER="$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
case "$PYVER" in
  3.1[2-4]) : ;;
  *) die "python $PYVER outside supported range ${MIN_PY}..<? (mitmproxy-mcp pins <${MAX_PY_EXCL})" ;;
esac
ARCH="$(uname -m)"
TARBALL="$OUT_DIR/sylvia-wheelhouse-$ARCH-cp${PYVER/./}.tar.gz"
note "arch=$ARCH python=$PYVER out=$TARBALL"

# --- disk preflight (source builds peak at multiple GB) ----------------------
sylvia_free_mb() {
  local _kb
  _kb=$(df -k "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
  case "$_kb" in ''|*[!0-9]*) echo 0 ;; *) echo $(( _kb / 1024 )) ;; esac
}
sylvia_reclaim_caches() {
  npm cache clean --force >/dev/null 2>&1 || true
  uv cache clean >/dev/null 2>&1 || true
  apt clean >/dev/null 2>&1 || true
}
min_mb="${SYLVIA_MIN_FREE_MB:-3072}"
free_mb=$(sylvia_free_mb)
if [ "$free_mb" -lt "$min_mb" ]; then
  note "only ${free_mb}MB free (need ${min_mb}MB) — reclaiming package caches"
  sylvia_reclaim_caches
  free_mb=$(sylvia_free_mb)
  [ "$free_mb" -ge "$min_mb" ] || die "low disk: ${free_mb}MB free, need ${min_mb}MB.
   Check with: df -h  (on an emulator: config.ini disk.dataPartition.size=16G)"
  ok "disk after reclaim: ${free_mb}MB free"
fi

# --- build toolchain (have-checked: reused when already present) -------------
build_deps=()
have cargo      || build_deps+=(rust)       # bcrypt/cryptography/pydantic-core/pylsqpack (Rust)
have ld         || build_deps+=(binutils)   # linker for the Rust builds
have clang      || build_deps+=(clang)      # C/C++ extensions (cffi, curl-cffi, google-re2, ...)
have make       || build_deps+=(make)       # some sdists drive make
have pkg-config || build_deps+=(pkg-config) # cryptography locates OpenSSL with it
have openssl    || build_deps+=(openssl)    # cryptography/curl-cffi build headers
if [ ${#build_deps[@]} -gt 0 ]; then
  note "installing build toolchain: ${build_deps[*]}"
  pkg update -y >/dev/null 2>&1 || warn "pkg update returned non-zero; continuing"
  if [ "$FORCE_CONFNEW" -eq 1 ]; then
    pkg install -y -o "Dpkg::Options::=--force-confnew" "${build_deps[@]}" \
      || die "pkg install failed for: ${build_deps[*]}"
  else
    pkg install -y "${build_deps[@]}" || die "pkg install failed for: ${build_deps[*]}"
  fi
fi

# --- mitmproxy-mcp source (needed: its dep tree IS the wheelhouse scope) -----
MCP_DIR="$SYLVIA_HOME/mitmproxy-mcp"
if [ -f "$MCP_DIR/pyproject.toml" ]; then
  note "using existing mitmproxy-mcp source ($MCP_DIR)"
elif [ -f "$SCRIPT_DIR/reference/mitmproxy-mcp/pyproject.toml" ]; then
  mkdir -p "$SYLVIA_HOME"
  cp -r "$SCRIPT_DIR/reference/mitmproxy-mcp" "$MCP_DIR" \
    || die "could not copy mitmproxy-mcp from reference/"
  note "copied mitmproxy-mcp from reference/"
else
  mkdir -p "$SYLVIA_HOME"
  git clone --depth 1 https://github.com/snapspecter/mitmproxy-mcp.git "$MCP_DIR" \
    || die "git clone of mitmproxy-mcp failed"
  note "cloned mitmproxy-mcp"
fi

# Upstream pin 'requires-python = ">=3.12,<3.14"' rejects Termux's python 3.14
# even though mitmproxy 12.2.3 itself supports 3.14 — relax it in place
# (idempotent). This exact patch is also applied by install.sh to its copy.
if grep -q 'requires-python = ">=3.12,<3.14"' "$MCP_DIR/pyproject.toml"; then
  sed -i.bak 's/requires-python = ">=3.12,<3.14"/requires-python = ">=3.12,<'\
'3.15"/' "$MCP_DIR/pyproject.toml" && rm -f "$MCP_DIR/pyproject.toml.bak"
  note "relaxed mitmproxy-mcp requires-python pin (<3.14 -> <3.15) for python $PYVER"
fi

# --- the build ---------------------------------------------------------------
# pip wheel resolves the FULL tree (mitmproxy + mitmproxy-mcp + every transitive
# dep) and drops one .whl per package into OUT_DIR, including the local
# mitmproxy-mcp project itself (py3-none-any) — which is what lets install.sh
# do a fully offline `uv tool install` later with no build isolation.
mkdir -p "$OUT_DIR"
# -Wno-incompatible-function-pointer-types: required to compile
# ruamel.yaml.clib with Termux clang>=15 (termux-packages#16746).
export CFLAGS="-Wno-incompatible-function-pointer-types"
mitm_args=(mitmproxy)
[ -n "${SYLVIA_MITM_VERSION:-}" ] && mitm_args=("mitmproxy==${SYLVIA_MITM_VERSION}")

BUILD_LOG="$SYLVIA_HOME/.wheelhouse-build.log"
: > "$BUILD_LOG"
note "building wheels for: ${mitm_args[*]} + mitmproxy-mcp (one-time; can take 15-30 min)"
attempt=1
while :; do
  if python -m pip wheel --wheel-dir "$OUT_DIR" \
       --extra-index-url "$TUR_INDEX" \
       "${mitm_args[@]}" "$MCP_DIR" 2>&1 | tee -a "$BUILD_LOG"; then
    break
  fi
  if grep -q "No space left on device" "$BUILD_LOG" 2>/dev/null; then
    if [ "$attempt" -eq 1 ]; then
      warn "build ran out of disk space — reclaiming caches and retrying once"
      sylvia_reclaim_caches
      attempt=2
      continue
    fi
    die "build is out of disk space (again: $(sylvia_free_mb)MB free).
     Full log: $BUILD_LOG — free space (df -h) or enlarge the AVD data
     partition (config.ini disk.dataPartition.size=16G) and re-run."
  fi
  die "pip wheel failed. Full log: $BUILD_LOG
   Verify the toolchain manually:
     pkg install rust binutils clang make pkg-config openssl
     python -m pip wheel --wheel-dir \"$OUT_DIR\" ${mitm_args[*]} \"$MCP_DIR\""
done

have tar || die "tar not found (pkg install tar)"
cd "$OUT_DIR"
manifest="manifest.txt"
{
  echo "arch=$ARCH"
  echo "python=$PYVER"
  echo "abi=cp${PYVER/./}"
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "termux=${TERMUX_VERSION:-unknown}"
  echo "wheels=$(ls -1 ./*.whl 2>/dev/null | wc -l | tr -d ' ')"
} > "$manifest"
tar -czf "$TARBALL" ./*.whl "$manifest" || die "tar failed"
rm -f ./*.whl "$manifest"
cd "$SCRIPT_DIR"

size=$(du -h "$TARBALL" | awk '{print $1}')
count=$(tar -tzf "$TARBALL" | grep -c '\.whl$' || true)
ok "wheelhouse tarball: $TARBALL ($size, $count wheels)"
note "use it with install.sh:"
note "  SYLVIA_WHEELHOUSE_DIR=$(dirname "$TARBALL") bash install.sh"
note "or serve/copy it somewhere and:"
note "  SYLVIA_WHEELHOUSE_URL=<url>/$(basename "$TARBALL") bash install.sh"
note "NOTE: this tarball is valid ONLY for arch=$ARCH + python=$PYVER."
note "      Build a separate one on each distinct device (phone vs emulator)."
