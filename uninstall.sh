#!/usr/bin/env bash
# =============================================================================
#  Sylvia uninstall.sh — development/cleanup counterpart to install.sh
# =============================================================================
#  Removes ONLY what install.sh created. It is safe to run on a box that also
#  has other DSH profiles, MCP servers, or a pre-existing @deepseek-ai install:
#  every deletion is id-tagged or scoped to the Sylvia footprint.
#
#  What this REMOVES (by default):
#    • $SYLVIA_HOME (~/.sylvia)  — sources, dsh-mobile clone, launchers, env, state
#    • $DSH_HOME/profiles/web/node_modules/sylvia-bridge   (the install-created symlink)
#    • Every cordis.patch.yml entry whose id is sylvia-owned:
#        - sylvia-mcp      (MCP server)
#        - sylvia-bridge   (DSH plugin, nested "insert" row)
#        - tasker-mcp      (MCP server, only if installed by us)
#        - mitmproxy-mcp   (MCP server)
#
#  What this leaves ALONE by default (must opt in via flags):
#    • Termux base packages (git/bash/android-tools/rclone/tmux/nodejs-lts/uv/nmap)
#        → these are generic; removing them can break other tooling.
#          Use --remove-packages to also `pkg uninstall` them.
#    • @deepseek-ai/dsh + its 12 rc.7 sibling packages + the global `dsh` bin
#        → DSH may be shared with non-Sylvia use. Only touched when the whole
#          ~/.sylvia tree is going away, OR when --remove-dsh is passed.
#
#  Usage:
#      bash uninstall.sh                 # remove Sylvia footprint (keep DSH + pkgs)
#      bash uninstall.sh --remove-dsh    # also remove @deepseek-ai/dsh + siblings + dsh bin
#      bash uninstall.sh --remove-packages  # also pkg uninstall the base packages
#      bash uninstall.sh --purge         # all of the above + force (no prompts)
#      bash uninstall.sh --dry-run       # show what would be removed, change nothing
#      bash uninstall.sh --help
#
#  Exit codes: 0 success · 1 usage error · 2 not in Termux (unless SYLVIA_FORCE)
# =============================================================================

set -Eeuo pipefail

# --- configuration (mirror install.sh) ---------------------------------------
SYLVIA_HOME="${SYLVIA_HOME:-$HOME/.sylvia}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
CORDIS_FILE="$DSH_HOME/profiles/web/cordis.patch.yml"
PROFILE_NM="$DSH_HOME/profiles/web/node_modules"
PREFIX_BIN="${PREFIX:-/data/data/com.termux/files/usr}"
DSH_GLOBAL_SCOPE="$PREFIX_BIN/lib/node_modules/@deepseek-ai"
DSH_BIN="$PREFIX_BIN/bin/dsh"

# The 12 local rc.7 tarballs the mobile patcher installs alongside @deepseek-ai/dsh.
DSH_SIBLINGS=(
  dsh-client-ui-layout
  dsh-subprocess-local
  dsh-terminal-bash
  dsh-sandbox
  dsh-sandbox-local
  dsh-fs-local
  dsh-session-persistence-jsonl
  dsh-attachment-local
  dsh-host-directory-picker-native
  dsh-client-modules
  dsh-host-directory-picker-browse
  dsh-client-ui-directory-picker-browse
)

# Base packages install.sh may have installed (generic tools — kept by default).
# Used only as a fallback when no install-packages.txt record exists (an
# install from before the record file was introduced).
BASE_PACKAGES=(git bash android-tools rclone tmux nodejs-lts uv nmap iproute2 python)

# Rust/C toolchain install.sh adds just-in-time to source-build mitmproxy
# (PyPI has no Android wheels). Fallback list — same caveat as BASE_PACKAGES.
MITM_TOOLCHAIN_PACKAGES=(rust binutils clang make pkg-config openssl)

# Package record written by install.sh: one package name per line, only ever
# packages that were MISSING before install added them. Preferred source.
PKG_RECORD="${SYLVIA_HOME}/install-packages.txt"

# Cordis entry ids owned by Sylvia (both MCP-server and plugin shapes).
CORDIS_OWNED_IDS=(sylvia-mcp sylvia-bridge tasker-mcp mitmproxy-mcp)

# --- flags -------------------------------------------------------------------
DRY_RUN=0
REMOVE_DSH=0
REMOVE_PKGS=0
FORCE=0

# --- output helpers (match install.sh style) --------------------------------
if [ -t 1 ]; then
  c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'
  c_blu=$'\033[34m'; c_reset=$'\033[0m'
else
  c_red=""; c_grn=""; c_yel=""; c_blu=""; c_reset=""
fi
log()  { printf '%s\n' "$*"; }
head_(){ printf '\n%s=== %s ===%s\n' "$c_blu" "$*" "$c_reset"; }
ok()   { printf '%s  ✓ %s%s\n' "$c_grn" "$*" "$c_reset"; }
note() { printf '%s  · %s%s\n' "$c_reset" "$*" "$c_reset"; }
warn() { printf '%s  ! %s%s\n' "$c_yel" "$*" "$c_reset"; }
skip() { printf '%s  ○ %s (skipped)%s\n' "$c_reset" "$*" "$c_reset"; }
die()  { printf '\n%s✗ UNINSTALL FAILED: %s%s\n' "$c_red" "$*" "$c_reset" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '3,38p' "$0" | sed 's/^#  \{0,1\}//'
  exit 0
}

# --- argument parsing --------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --remove-dsh)      REMOVE_DSH=1 ;;
    --remove-packages) REMOVE_PKGS=1 ;;
    --purge)           REMOVE_DSH=1; REMOVE_PKGS=1; FORCE=1 ;;
    --dry-run)         DRY_RUN=1 ;;
    --force)           FORCE=1 ;;
    -h|--help)         usage ;;
    *) printf '%sunknown flag: %s%s\n' "$c_red" "$1" "$c_reset" >&2; exit 1 ;;
  esac
  shift
done

# --- action helper (dry-run aware) -------------------------------------------
# Runs a destructive action, or just reports it under --dry-run.
act() {
  local desc="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s  [dry-run] would: %s%s\n' "$c_reset" "$desc" "$c_reset"
  else
    "$@" && ok "$desc" || warn "could not complete: $desc (continuing)"
  fi
}

# --- guard: Termux ------------------------------------------------------------
if [ -z "${TERMUX_VERSION:-}" ] && [ "${SYLVIA_FORCE:-0}" != "1" ]; then
  die "not a Termux session. This is the Android uninstaller. Set SYLVIA_FORCE=1 to override."
fi

log "${c_blu}=== Sylvia uninstaller ===${c_reset}"
[ "$DRY_RUN" -eq 1 ] && warn "DRY RUN — nothing will be changed"
note "sylvia home: $SYLVIA_HOME"
note "dsh home:    $DSH_HOME"
note "cordis file: $CORDIS_FILE"

head_ "Sylvia sources + launchers + state ($SYLVIA_HOME)"
if [ -d "$SYLVIA_HOME" ]; then
  act "remove $SYLVIA_HOME (sources, dsh-mobile clone, launchers, env, state)" rm -rf "$SYLVIA_HOME"
else
  skip "$SYLVIA_HOME not present"
fi

head_ "sylvia-bridge plugin symlink (profile node_modules)"
if [ -L "$PROFILE_NM/sylvia-bridge" ]; then
  act "unlink $PROFILE_NM/sylvia-bridge" rm -f "$PROFILE_NM/sylvia-bridge"
else
  skip "no sylvia-bridge symlink at $PROFILE_NM/sylvia-bridge"
fi

head_ "cordis.patch.yml entries (id-tagged, only Sylvia-owned)"
_remove_cordis_entries() {
  [ -f "$CORDIS_FILE" ] || { skip "no cordis file at $CORDIS_FILE"; return 0; }

  local backup="$CORDIS_FILE.bak.$(date +%Y%m%d%H%M%S)"
  if [ "$DRY_RUN" -eq 1 ]; then
    local id
    for id in "${CORDIS_OWNED_IDS[@]}"; do
      if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${id}[[:space:]]*$" "$CORDIS_FILE"; then
        printf '%s  [dry-run] would strip cordis entry id=%s%s\n' "$c_reset" "$id" "$c_reset"
      fi
    done
    return 0
  fi

  # Real run: back up, then strip owned entries in two phases so unrelated
  # cordis entries (other MCP servers / plugins) survive intact.
  cp "$CORDIS_FILE" "$backup" || die "could not back up cordis file"
  local owned_re
  owned_re="$(printf '%s|' "${CORDIS_OWNED_IDS[@]}")"
  owned_re="${owned_re%|}"   # sylvia-mcp|sylvia-bridge|tasker-mcp|mitmproxy-mcp

  local stripped="$CORDIS_FILE.stripped"

  # Phase 1 — top-level MCP-server entries. install.sh appends these as
  #   - id: <id>
  #     name: ...
  #     config: ...
  # We drop the matching `- id: <owned>` line and every subsequent indented or
  # blank line (its body), stopping at the next top-level `- ` item.
  awk -v ids="$owned_re" '
    BEGIN { n=split(ids,a,"|"); for(i=1;i<=n;i++) own[a[i]]=1 }
    skip==1 {
      # A top-level item starts at column 0 with "- ". Anything else (incl. deeper
      # list items like args entries) is part of the owned block body — keep skipping.
      if ($0 ~ /^- /) { skip=0 } else { next }
    }
    /^- [[:space:]]*id:[[:space:]]*/ {
      id=$0; sub(/^- [[:space:]]*id:[[:space:]]*/,"",id); sub(/[[:space:]].*$/,"",id)
      if (id in own) { skip=1; next }
    }
    { print }
  ' "$CORDIS_FILE" > "$stripped" || die "cordis phase-1 strip failed"

  # Phase 2 — the sylvia-bridge plugin, registered as a nested insert block:
  #   - insert:
  #       - id: sylvia-bridge
  #         name: "sylvia-bridge"
  # Remove the three-line block (opener + nested id + name). Safe because
  # sylvia-bridge is Sylvia-owned and this is the only insert shape we emit.
  awk '
    $0 ~ /^[[:space:]]*-[[:space:]]*insert:[[:space:]]*$/ { ins=NR; o=$0; next }
    ins && NR==ins+1 && $0 ~ /^[[:space:]]*-[[:space:]]*id:[[:space:]]*sylvia-bridge[[:space:]]*$/ { nid=$0; next }
    ins && NR==ins+2 && nid!="" && $0 ~ /^[[:space:]]*name:/ { ins=0; nid=""; next }  # drop whole block
    { if(ins && NR==ins){ print o; ins=0 } else print }
  ' "$stripped" > "$stripped.2" || die "cordis phase-2 strip failed"

  mv "$stripped.2" "$CORDIS_FILE" || die "could not rewrite cordis file"
  rm -f "$stripped" 2>/dev/null || true
  ok "cordis entries stripped (backup at $backup)"
}
_remove_cordis_entries

head_ "@deepseek-ai/dsh global packages"
if [ "$REMOVE_DSH" -eq 1 ]; then
  act "npm uninstall -g @deepseek-ai/dsh" \
    bash -c 'npm uninstall --global @deepseek-ai/dsh dsh >/dev/null 2>&1 || true'
  act "rm -rf $DSH_GLOBAL_SCOPE + $DSH_BIN" \
    bash -c "rm -rf '$DSH_GLOBAL_SCOPE' '$DSH_BIN' 2>/dev/null || true"
else
  skip "leaving @deepseek-ai/dsh installed (pass --remove-dsh to delete)"
fi

head_ "Termux base packages"
if [ "$REMOVE_PKGS" -eq 1 ]; then
  # Prefer the install record: it lists ONLY packages install.sh actually
  # added (they were missing beforehand), so pre-existing ones survive.
  record_pkgs=()
  if [ -f "$PKG_RECORD" ]; then
    while IFS= read -r _p; do
      case "$_p" in ''|'#'*) continue ;; esac
      record_pkgs+=("$_p")
    done < "$PKG_RECORD"
    note "using package record: $PKG_RECORD"
  else
    warn "no package record found — falling back to the known install list"
    record_pkgs=("${BASE_PACKAGES[@]}" "${MITM_TOOLCHAIN_PACKAGES[@]}")
  fi
  if [ ${#record_pkgs[@]} -eq 0 ]; then
    skip "package record is empty — nothing to remove"
  else
    act "pkg uninstall ${record_pkgs[*]}" \
      bash -c "pkg uninstall -y ${record_pkgs[*]} 2>/dev/null || true"
    act "rm $PKG_RECORD" bash -c "rm -f '$PKG_RECORD'"
  fi
else
  skip "leaving base packages + mitmproxy toolchain installed (pass --remove-packages to delete)"
fi

head_ "Done"
if [ "$DRY_RUN" -eq 1 ]; then
  note "dry run complete — nothing was changed. Re-run without --dry-run to apply."
else
  ok "Sylvia uninstalled."
  note "Left in place: Termux packages$([ "$REMOVE_DSH" -eq 0 ] && echo ', @deepseek-ai/dsh')."
  note "Your DSH profile config ($DSH_HOME) and any non-Sylvia cordis entries were preserved."
fi


