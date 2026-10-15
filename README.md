# Sylvia

A self-contained agentic-AI harness that runs natively on Android. **DeepSeek
Harness Mobile (DSH)** provides the brain and the local web UI, a **loopback ADB
connection** provides root-level shell access with zero extra companion apps, and a
custom **MCP server (`sylvia-mcp`)** translates the model's high-level goals into
atomic Android OS actions.

> The web UI binds `127.0.0.1` only and is **unauthenticated** — it is a remote-code
> execution surface by design. Never add `--host 0.0.0.0`. Treat the agent as shell
> access.

---

## 1. What you need

Install these apps first. This is the only "how" section for most items — just install
them from the linked source.

| App | Source | Why |
|-----|--------|-----|
| **Termux** | [F-Droid](https://f-droid.org/en/packages/com.termux/) **or** the [GitHub releases](https://github.com/termux/termux-app/releases) — **not** the Play Store build, which is stale and will fail on `nodejs-lts` | The Linux container the whole stack runs inside |
| **Tasker** | [Play Store](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm) | Existing-task automation via its HTTP API (bridge) and new-profile authoring via direct XML write |

> **rclone** is installed inside Termux by the installer (via `pkg`) — use that build, not
> the Play Store app, which is a different package and not what the tools call.

For **Tasker-related** features, also install (nothing auto-installs these — set them up
yourself, then the agent can use them):

- **Termux:API** ([F-Droid](https://f-droid.org/en/packages/com.termux.api/), same publisher as Termux) —
  the `termux-*` CLI tools (incl. `termux-wake-lock`, which the launcher uses to keep the
  harness alive when the screen is off) and Tasker↔Termux interop.
- **Termux:Tasker** ([F-Droid](https://f-droid.org/en/packages/com.termux.tasker/)) — lets Tasker run
  commands inside Termux directly.
- **Shizuku** ([Play Store](https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api)) —
  ADB-level permission broker; some Tasker setups use it for privileged actions without root.

The rest is handled by the installer: it clones/installs everything else (nodejs, adb,
rclone, uv, mitmproxy, nmap, iproute2, the MCP servers) inside Termux.

**Device prerequisites:** an arm64 device on Android 10+, **8 GB RAM** recommended. On a
physical phone you must enable **Developer options → Wireless debugging** (the installer
discovers the port automatically). The Android Studio emulator needs no extra setup —
it is used only as a test bed (see §6).

---

## 2. One-line install

Open Termux and run:

```sh
pkg upgrade -y -o Dpkg::Options::=--force-confnew && pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/Ayrlin-Renata/Sylvia/main/install.sh | bash -s -- --force-confnew
```

> **About `--force-confnew`:** during a fresh install, `pkg`/`dpkg` stops and asks whether
> to keep or replace several config files (`usr/etc/tls/openssl.cnf`, `usr/etc/apt/sources.list`,
> `bashrc`, `profile`, ...). This flag auto-answers **"Y" (take the package maintainer's version)**,
> so the install runs unattended. It is on by default here for a clean, one-shot setup.
>
> **Remove `--force-confnew` if you have customized any of those files** (your shell `bashrc`/
> `profile`, a pinned `sources.list` mirror, a tweaked `openssl.cnf`) — otherwise your edits are
> overwritten by the packaged defaults. Without the flag you will be prompted per file and can
> choose `N` to keep your version.

The installer is **idempotent** — every module checks whether its work is already done
and skips if so, so you can re-run it safely at any time. It is also **fail-fast**: it
stops on the first module that fails and tells you which one, so fix the error and
re-run the same command.

> If you prefer to read before you run, `git clone` the repo and `bash install.sh` from
> the checkout — same behaviour, and it lets you pass flags (§3).

### What it installs

1. **Termux base packages** — `nodejs-lts`, `git`, `bash`, `tmux`, `android-tools` (provides
   `adb`), `rclone`, `uv`, `nmap`, `iproute2` (provides `ip`, used for network detection).
2. **DSH CLI + mobile/Android patches** — clones your
   [`Ayrlin-Renata/Deepseek-harness-mobile`](https://github.com/Ayrlin-Renata/Deepseek-harness-mobile)
   fork, then installs the CLI (`@deepseek-ai/dsh`) and overlays the 12 local `rc.7`
   packages (mobile single-column shell, optional native addons, filesystem fallbacks,
   directory-picker timeout + retry, plugin-bundle caching) — **one npm install per
   package**, because npm's multi-spec install crashes its dependency-tree builder on
   this set (a package with 8 peer deps; `--legacy-peer-deps` retries just that one).
3. **`sylvia-mcp`** — the custom MCP server, source + `npm install` + a stdio handshake
   smoke-test that confirms all 9 tools register.
4. **`sylvia-daemon`** — the control daemon (loopback HTTP API on `:3090`): network-state
   detection, netgate (managed-traffic hold/resume), resource registry + policy, LAN
   discovery, module manager, and the web control panel.
5. **`sylvia-bridge`** — the DSH plugin that monitors network state and pauses/resumes
   the harness on metered connections (configurable).
6. **MCP registration** — appends the server entries to
   `~/.dsh/profiles/web/cordis.patch.yml`. This is **non-destructive**: it only appends,
   never rewrites, and skips any entry already present by `id`.
7. **mitmproxy + `mitmproxy-mcp`** — installs the mitmproxy CLI via
   `uv tool install mitmproxy` and clones the `mitmproxy-mcp` MCP server, which is
   registered and run through `uvx`.
8. **Local module definitions** — SillyTavern and mDNS module skeletons under
   `~/.sylvia/modules/`, manageable from the control panel.

Everything lands under `~/.sylvia` (override with `SYLVIA_HOME`).

---

## 3. Installer flags & environment

```
bash install.sh                 # core install
bash install.sh --with-tasker   # + tasker-mcp (requires SYLVIA_TASKER_API_KEY)
bash install.sh --force         # re-run the writer modules even if already present
```

Useful environment variables (all optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `SYLVIA_HOME` | `$HOME/.sylvia` | Install root |
| `SYLVIA_WEB_PORT` | `3080` | DSH web UI port |
| `SYLVIA_DAEMON_PORT` | `3090` | sylvia-daemon control API + web panel port |
| `SYLVIA_ADB_PORT` | `5555` | Loopback ADB port (5555 = emulator) |
| `SYLVIA_ADB_MODE` | `auto` | `auto` \| `emulator` — how the loopback is discovered |
| `SYLVIA_DSH_REPO` | your DSH Mobile fork | Override the patcher source |
| `SYLVIA_TASKER_API_KEY` | — | Required only with `--with-tasker` |

### Reconciling with an existing DSH Mobile install

If you already run DSH Mobile, the installer will **not** reinstall what is present. The
patcher step is guarded by a canary (`dsh-client-ui-layout` at `rc.7`), so it skips if
your fork patches are already applied. MCP entries are appended to your existing
`cordis.patch.yml` rather than replacing it — your LLM-provider and theme config is left
untouched.

---

## 4. Verify the install

```sh
# The core toolchain should resolve:
command -v node && node -v
command -v adb
command -v rclone
command -v uv
command -v nmap
command -v ip

# mitmproxy CLI should be on PATH (~/.local/bin):
command -v mitmdump

# The 9 Sylvia tools should register over the MCP stdio handshake (this is what
# install.sh already smoke-tested):
cd ~/.sylvia/sylvia-mcp && printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node index.js | grep -o 'resilient_adb_exec\|tasker_write_and_reload\|rclone_exec\|network_state\|traffic_gate\|resource_list\|resource_resolve\|resource_call\|discovery_scan'
```

You should see all nine tool names echoed back.

---

## 5. Run it

Everything the installer generated lives in `~/.sylvia`:

```sh
~/.sylvia/start-sylvia.sh          # sources sylvia.env, takes a wake-lock, starts daemon + DSH web
```

`start-sylvia.sh` starts `sylvia-daemon` in the background (if not already running) and
then the harness on `127.0.0.1:<SYLVIA_WEB_PORT>`. To survive the terminal closing, run
it inside `tmux`:

```sh
tmux new -s sylvia
~/.sylvia/start-sylvia.sh
# Ctrl-b d to detach, tmux attach -t sylvia to reattach
```

Then open **`http://127.0.0.1:3080`** in the phone browser, enter your model API key on
the **Models** page, create a session, and send a first command — for example, *"use
`mcp__sylvia__resilient_adb_exec` to print the device model."*

The nine tools surface to the model as:

| Tool | What it does |
|------|-------------|
| `mcp__sylvia__resilient_adb_exec` | Privileged shell with auto-reconnect on dropped ADB |
| `mcp__sylvia__tasker_write_and_reload` | Write a Tasker XML file to `/sdcard/Tasker` and fire the reload intent |
| `mcp__sylvia__rclone_exec` | rclone with `--json` forced for machine-readable output |
| `mcp__sylvia__network_state` | Current network state (wifi/cellular/none, metered, iface) |
| `mcp__sylvia__traffic_gate` | Hold/resume managed traffic (rclone syncs, mDNS, etc.) |
| `mcp__sylvia__resource_list` | List known networks/hosts/resources (policy-filtered) |
| `mcp__sylvia__resource_resolve` | Resolve an IP/hostname/name to a known entity |
| `mcp__sylvia__resource_call` | Call a typed resource endpoint (http/adb transport) |
| `mcp__sylvia__discovery_scan` | Scan the LAN for hosts (nmap, refuses metered/offline) |

---

## 6. The ADB loopback (the "hands")

The harness gets root/ADB shell access by connecting Termux's `adb` **to the device's own
`adbd` over `127.0.0.1`** — no Shizuku, no companion app. The installer writes a helper:

```sh
~/.sylvia/sylvia-adb-connect.sh
```

- **Emulator** — auto-detected; connects to `127.0.0.1:5555` where `adbd` already listens
  on TCP.
- **Physical phone** — discovers the dynamic Wireless-Debugging port via `adb mdns
  services` and connects. If discovery fails, pass the port shown on the Wireless
  debugging screen: `~/.sylvia/sylvia-adb-connect.sh <port>`.

The `sylvia-mcp` `resilient_adb_exec` tool re-establishes this loopback automatically if
the connection drops, so the agent never has to reason about it.

### Emulator "Virtual Twin" (development only)

The emulator is a **test bed, not a shipped target** — the same `install.sh` runs inside
the emulator's Termux, giving 1:1 code parity with zero risk to your phone. Boot it with
`adb root` and forced TCP on `5555`, then use Android Studio's **Device File Explorer**
and **Logcat** to watch the agent's file writes and intent broadcasts before deploying to
hardware. The installer is device-agnostic, so no emulator-specific branch is needed.

---

## 7. The control panel

Open **`http://127.0.0.1:3090`** in the phone browser for the Sylvia control panel.

- **Status** — network state (wifi/cellular/none, metered, SSID, WAN IP), netgate status
  (harness held? managed traffic held?), paused-work count, module status summary, daemon
  health, manual pause/resume.
- **Resources** — all ownership/permission configuration: searchable networks/hosts/
  resources table, inline edit owner + gate, "label as mine / as \<person\>", per-type
  rules, prune-now + prune settings.
- **Modules** — per-module status, on/off toggles, "open frontend" button, behavior-mode
  selector, settings panel rendered from module config protocol, backup-now.

---

## 8. Optional modules

### tasker-mcp (existing-task bridge)

Keeps the agent from rewriting whole Tasker profiles (which is error-prone). Instead the
agent calls small, reliable tools to **enable/disable/run tasks that already exist**,
talking to Tasker's HTTP API on `127.0.0.1:1821`.

```sh
# One-time, in Tasker: import the MCP server project, then run the
# "MCP generate_api_key" task to produce an API key.
SYLVIA_TASKER_API_KEY=<your-key> bash install.sh --with-tasker
```

For authoring **new** profiles, use `mcp__sylvia__tasker_write_and_reload` instead — it
writes the XML directly and bypasses the HTTP API entirely.

> **Note:** `mitmproxy-mcp` (network interception) is **not** optional — it's installed and
> registered by default (see §2.8). Just start a mitmproxy instance (`mitmdump`, or ask the
> agent to start one) before using its tools.

---

## 9. Repository layout

```
install.sh          idempotent, fail-fast installer (the entry point)
sylvia-mcp/         custom MCP server source (9 tools)
sylvia-daemon/      control daemon (network detection, netgate, registry, modules, web panel)
sylvia-bridge/      DSH plugin (network-aware harness gating)
modules/            module definitions (sillytavern, mdns) — copied to ~/.sylvia/modules/
reference/          git clones of the upstream tools, for debugging only — NOT shipped
```

`reference/` holds clones of `Deepseek-harness-mobile`, `tasker-mcp`, and
`mitmproxy-mcp`. They are **not** part of the install; they exist so you can read the
upstream code while developing or debugging. `install.sh` prefers them when present (so a
dev checkout works offline) and falls back to a shallow `git clone` otherwise.

---

## 10. Uninstall (development / emulator iteration)

`uninstall.sh` removes **only** what `install.sh` created — every deletion is scoped to
the Sylvia footprint or id-tagged, so other DSH profiles and non-Sylvia config survive.

```bash
# Preview what would be removed, change nothing:
bash uninstall.sh --dry-run

# Remove the Sylvia footprint (~/.sylvia, the sylvia-bridge symlink, the
# sylvia-mcp / sylvia-bridge / tasker-mcp / mitmproxy-mcp cordis entries).
# Leaves DSH and all Termux packages alone:
bash uninstall.sh

# Also remove @deepseek-ai/dsh + its 12 rc.7 siblings + the global dsh bin:
bash uninstall.sh --remove-dsh

# Everything above + `pkg uninstall` the base packages (git/bash/rclone/...):
bash uninstall.sh --purge
```

By default it keeps the generic Termux packages (git, bash, nodejs-lts, rclone, tmux,
android-tools, uv, nmap, iproute2) and any `@deepseek-ai/dsh` install, since those can be shared
with non-Sylvia tooling. Pass `--remove-packages` / `--remove-dsh` to take those too.

## 11. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `nodejs-lts` install fails | You're using the Play Store Termux build — uninstall and install from F-Droid or GitHub releases. |
| ADB connection drops immediately | Enable **Wireless debugging** (physical) or restart the emulator. Run `~/.sylvia/sylvia-adb-connect.sh` manually and check output. |
| Daemon not responding | Check `~/.sylvia/sylvia-daemon.log`. Verify port: `curl http://127.0.0.1:3090/api/health`. |
| MCP tools don't appear in the model's toolset | `grep -n "sylvia-mcp" ~/.dsh/profiles/web/cordis.patch.yml` — the entry must exist. Re-run `install.sh`; the append is guarded by `id` so it won't duplicate. |
| Bridge plugin not loading | Check `grep -n "sylvia-bridge" ~/.dsh/profiles/web/cordis.patch.yml`. Verify the symlink: `ls -la ~/.dsh/profiles/web/node_modules/sylvia-bridge`. |
| Tasker reload intent not firing | Verify the broadcast action string against your Tasker build in the emulator Logcat. |
| Discovery scan refuses | It refuses on metered/offline networks. Check network state via `mcp__sylvia__network_state`. |

---

## Security model

- **Loopback only, unauthenticated.** The web RPC is remote code execution by design. It
  binds `127.0.0.1` (shared with the on-device browser). **Do not add `--host
  0.0.0.0`** — that exposes an unauthenticated shell to your LAN.
- **`DSH_PERMISSION_MODE=danger-full-access`.** Android has no
  `bwrap`/Landlock/Seatbelt sandbox backend, so the sandbox fails closed and the launcher
  opts into running unconfined. Treat the agent as shell access.
- **Telemetry off by default** (`DSH_TELEMETRY_DISABLED=1`).
