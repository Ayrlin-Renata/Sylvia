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
| **Termux:Boot** (recommended) | [F-Droid](https://f-droid.org/en/packages/com.termux.boot/) | Autostarts the harness at device boot — the installer seeds `~/.termux/boot/10-sylvia.sh`; **open the app once** after installing, since Android only registers its boot receiver on first launch |

For **Tasker-related** features, also install (nothing auto-installs these — set them up
yourself, then the agent can use them):

- **Termux:API** ([F-Droid](https://f-droid.org/en/packages/com.termux.api/)) — the Android
  handlers behind every `termux-*` command. The installer runs `pkg install termux-api`, but
  that is **only the CLI half** — without this app the commands are silent no-ops. Install it
  from F-Droid yourself.
- **Termux:Tasker** ([F-Droid](https://f-droid.org/en/packages/com.termux.tasker/)) — lets Tasker run
  commands inside Termux directly.
- **Shizuku** ([Play Store](https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api)) —
  ADB-level permission broker; some Tasker setups use it for privileged actions without root.

The rest is handled by the installer: it clones/installs everything else (nodejs, adb,
rclone, uv, mitmproxy, nmap, iproute2, python, the MCP servers) inside Termux.

**Device prerequisites:** an arm64 device on Android 10+, **8 GB RAM** recommended. On a
physical phone you must enable **Developer options → Wireless debugging** (the installer
discovers the port automatically). The Android Studio emulator needs no extra setup —
it is used only as a test bed (see §6).

---

## 2. One-line install

Open Termux and run (paste the whole line at once):

```sh
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/Ayrlin-Renata/Sylvia/main/install.sh | bash -s -- --force-confnew
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

1. **Termux base packages** — first a full `apt-get update && apt-get full-upgrade` so the
   entire tree is in lockstep (mixing old libraries with freshly-installed packages breaks
   binaries — seen as a `curl` that cannot link against its own TLS backend; `apt-get`
   specifically, because the `pkg` wrapper needs that curl), then installs anything missing:
   `nodejs-lts`, `git`, `bash`, `tmux`, `android-tools` (provides
   `adb`), `rclone`, `uv`, `nmap`, `iproute2` (provides `ip`, used for network detection),
   `python` (interpreter for `uv`/`uvx` → mitmproxy), `unzip` (extracts Shizuku's starter binary for the §6 transport ladder),
    `termux-api` (the `termux-*` CLI
   stubs, e.g. `termux-wake-lock` — **CLI half only; the Termux:API app is yours to
   install**, see §1).
2. **DSH CLI + mobile/Android patches** — clones your
   [`Ayrlin-Renata/Deepseek-harness-mobile`](https://github.com/Ayrlin-Renata/Deepseek-harness-mobile)
   fork, then installs the CLI (`@deepseek-ai/dsh`, exact-pinned) and overlays the
   fork's 11 local tarballs: the FUSE/sdcardfs hardlink→copy filesystem fallbacks,
   native addons moved to
   `optionalDependencies` so npm never dies on glibc-only binaries, directory-listing
   timeouts with failed-listing retry, Termux `$PREFIX` shell resolution, and the
   Android sandbox-backend message — **one npm install per package**, because npm's
   multi-spec install crashes its dependency-tree builder on this set. Spec versions
   are read out of the fork's own `install.sh` and cross-checked against
   `SYLVIA_DSH_TARGET_VER` (default `0.2.1-alpha.5` — the PC harness's train); a
   clone from an older train is detected and re-cloned automatically. Then the
   boot-time fixes: prunes the *stock* npm copies of the fork packages that get
   nested inside the CLI's tree (they would shadow the patched tarballs), symlinks
   the `sylvia-bridge` plugin's `@deepseek-ai/*` deps, verifies
   `dsh-client-modules` matches the web frontend (the `window.__ModuleLoader__`
   facade contract — a drift guard, a no-op on the exact-pinned train), and verifies
   `dsh-attachment-local` provides `maxImageDimension` (the `session.history`
   image-limits contract; upstream on this train — the installer checks rather than
   patches, with a legacy repair path for old installs). Finally it runs an
   **ambient dependency sweep** — a regression detector born from the pre-0.2.1
   era, when registry-train packages imported helpers (`dsh-timeout`, `dsh-scope`,
   `cordis-plugin-group`, …) that nothing declared and every boot died with
   `plugin tree failed to load`; it must report clean on a healthy install. All of
   it re-applies on re-run. Finally the installer seeds the **Android native
   binding** (`module_native_binding`): DSH 0.2.x boots through
   `node-addon-require-builtin`, a native addon upstream ships for
   linux/darwin/win but **not android** — it downloads the prebuilt NAPI
   artifact from this repo's [`native/`](native/README.md) directory (one file
   per arch, dlopen + functional verified) and falls back to an on-device source
   build when no artifact exists yet.
3. **`sylvia-mcp`** — the custom MCP server, source + `npm install` + a stdio handshake
   smoke-test that confirms all 9 tools register.
4. **`sylvia-daemon`** — the control daemon (loopback HTTP API on `:3090`): network-state
   detection, netgate (managed-traffic hold/resume), resource registry + policy, LAN
   discovery, module manager, and the web control panel.
5. **`sylvia-bridge`** — the DSH plugin that monitors network state and pauses/resumes
   the harness on metered connections (configurable). Its **client half** owns ALL
   base mobile styling (nothing structural is patched at install time): dialog fit,
   plus a settings tabs-accordion that mirrors the app's own sidebar fold — the
   section rail is large/full-width while picking a section, then contracts to a
   52px icon strip beside the content (never both at full size), with a fixed
   ≡ pill to expand it back. Desktop is untouched (everything is media-scoped
   below 768px). On top of the plugin's base styles sits the **custom CSS seam**:
   `~/.sylvia/mobile.css` (seeded EMPTY — user tweaks only) is inlined into every
   served index page *after* the plugin base, so edits are edit → browser
   refresh → live, with no harness restart.
6. **MCP registration** — appends the server entries to
   `~/.dsh/profiles/web/cordis.patch.yml`, each as an `insert:` row (a bare `- id:`
   row is silently skipped by DSH's patch loader). This is **non-destructive**: it
   only appends, never rewrites, migrates any legacy bare rows in place, and skips
   any entry already present by `id`.
7. **mitmproxy + `mitmproxy-mcp`** — installs the mitmproxy CLI and the `mitmproxy-mcp`
   MCP server. **If you provide a prebuilt wheelhouse** (see §3.1), both install as
   persistent uv tools, fully offline, in seconds. Otherwise PyPI has **no Android
   wheels** for mitmproxy's native deps (`bcrypt`, `cryptography`, `cffi`, ...), so the
   installer builds them from source: it adds the Rust/C toolchain (`rust`, `binutils`,
   `clang`, `make`, `pkg-config`, `openssl`, `cmake` — only what's missing) just for this
   step, plus `pybind11` + `libre2` (google-re2 compiles against the system headers),
   and pins `argon2-cffi-bindings<26` (v26+ switched to scikit-build-core, whose Android
   path assumes an NDK sysroot Termux doesn't have — see
   [upstream issue #142](https://github.com/hynek/argon2-cffi-bindings/issues/142)).
   The first build can take several minutes; later runs skip it entirely (the warm
   build's log is `~/.sylvia/.mitmproxy-mcp-warm.log`). The installer also checks free
   disk first, reclaims package caches when low, and retries once on `ENOSPC` instead of
   dying mid-build. On **x86_64** (the emulator) `curl_cffi` has no Android wheel, so it
   gets a one-off patched build from its sdist; after everything is built, `patchelf`
   fixes two extension load quirks (`mitmproxy_rs` needs an explicit `libpython3.14.so`
   entry — Termux's python exe exports no C API — and `curl_cffi` needs Termux's
   `libc++_shared.so` in place of the Android system `libc++.so`). On arm64 phones none
   of that x86_64 path runs; native wheels resolve from PyPI as normal.
8. **Local modules** — seeds the shipped module definitions from `modules/` into
   `~/.sylvia/modules/` (currently the **9router** example — a full lifecycle
   workout of the module system: status / on / off / settings through the control
   panel, plus its own README in the module dir). Existing module directories are
   never overwritten — after seeding they are user-owned (settings, logs, and any
   installed service live inside them). The daemon discovers modules at boot, so
   restart the harness after adding new ones.

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
| `SYLVIA_WHEELHOUSE_DIR` | — | Dir containing a prebuilt `sylvia-wheelhouse-<arch>-cp<ver>.tar.gz` |
| `SYLVIA_WHEELHOUSE_URL` | — | URL of that tarball (downloaded once, cached under `~/.sylvia/downloads`) |
| `SYLVIA_MIN_FREE_MB` | `3072` | Disk floor before the mitmproxy source build |

### 3.1 Prebuilt wheelhouse (optional, recommended after the first device)

The mitmproxy source build is the slowest, most fragile part of the install. If you
already paid that cost once on a device, `build-wheelhouse.sh` turns the result into a
reusable tarball so every later install on that device is fast and fully offline:

```sh
# ON THE DEVICE (once — phone and emulator each need their own):
bash build-wheelhouse.sh --cleanup
#   -> wheelhouse/sylvia-wheelhouse-aarch64-cp314.tar.gz   (example name)

# Later installs on the SAME device:
SYLVIA_WHEELHOUSE_DIR="$HOME/Sylvia/wheelhouse" bash install.sh
# or copy the tarball anywhere and let the installer fetch it:
SYLVIA_WHEELHOUSE_URL="https://example.com/sylvia-wheelhouse-aarch64-cp314.tar.gz" bash install.sh
```

`--cleanup` (optional) removes the build-only toolchain (`rust`, `binutils`, `clang`,
`make`, `pkg-config`, `cmake`) and uv's build scratch after the tarball is written —
reclaiming ~2 GB — since a wheelhouse install never compiles anything again. It keeps
`openssl` (a runtime dependency of curl/git/python) and can be re-run later; the
toolchain is reinstalled automatically if you ever build again without a wheelhouse.

**Per-device, not universal** — native wheels embed the CPU arch and the CPython ABI, so
an x86_64 emulator wheelhouse will not run on an arm64 phone (and vice versa), and a
Termux Python upgrade invalidates the ABI. The installer validates the tarball's
manifest against the running device and silently falls back to a source build on any
mismatch — the wheelhouse only ever speeds things up, never breaks the install.

When a wheelhouse install succeeds, `mitmproxy-mcp` is registered as a **persistent uv
tool** (`~/.local/bin/mitmproxy-mcp`) instead of `uvx`, so the first DSH launch does no
dependency resolution at all. Without it, the `uvx` fallback still works — the installer
relaxes mitmproxy-mcp's upstream `requires-python <3.14` pin in the cloned source so it
installs on Termux's Python 3.14.

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
command -v python

# mitmproxy CLI should be on PATH (~/.local/bin), and this smoke-tests the
# patchelf'd mitmproxy_rs extension (it fails with a dlopen symbol error if the
# fix is missing):
command -v mitmdump && mitmdump --version

# The control daemon should answer:
curl -s http://127.0.0.1:3090/api/health   # (needs start-sylvia.sh running)

# Seeded modules should be listed (9router once installed):
curl -s http://127.0.0.1:3090/api/modules

# Process ownership (§21): one row per supervised service, with the pids it
# matched. "conflict" means the port is held by something else.
curl -s http://127.0.0.1:3090/api/services

# mitmproxy toggle state (off by default; enabling needs a harness restart):
curl -s http://127.0.0.1:3090/api/mitm

# Module lifecycle smoke test (first 9router start also npm-installs the
# package, so expect "phase":"installing" for a couple of minutes on the
# very first `on` only — later starts are near-instant):
curl -s -X POST http://127.0.0.1:3090/api/modules/9router/on
curl -s -X POST http://127.0.0.1:3090/api/modules/9router/status   # "http":true
curl -s -o /dev/null -w '%{http_code}\n' -L http://127.0.0.1:20128/ # 200 dashboard
curl -s -X POST http://127.0.0.1:3090/api/modules/9router/off

# The custom CSS seam should be injecting the style tag (also needs the
# harness running; -> 1). The 0.2.1 train token-auths the harness (bare /
# answers 401), so grab the one-time token the launcher logs, and use a
# cookie jar so the ?token -> 303 -> / redirect keeps the session. Tokens are
# one-time: if the browser already consumed the line you're grepping, restart
# the harness (or copy the URL it opened). Edit ~/.sylvia/mobile.css and
# re-run to see it live:
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' ~/.sylvia/dsh-web.log | tail -n1)
curl -s -c /tmp/sj -b /tmp/sj -L "http://127.0.0.1:3080/?$TOK" | grep -c sylvia-mobile-css

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
then the harness on `127.0.0.1:<SYLVIA_WEB_PORT>`. The launcher runs DSH with
`--no-open` (DSH's own browser-open fires before the plugin tree finishes loading) and
instead polls the port, so your browser opens only once the server actually answers —
if it opens and then errors, check the terminal output for the failing plugin. To
survive the terminal closing, run it inside `tmux`:

```sh
tmux new -s sylvia
~/.sylvia/start-sylvia.sh
# Ctrl-b d to detach, tmux attach -t sylvia to reattach
```

**Autostart at device boot (Termux:Boot):** the installer seeds
`~/.termux/boot/10-sylvia.sh`, so with the companion app **Termux:Boot**
([F-Droid](https://f-droid.org/en/packages/com.termux.boot/)) installed the harness
comes up by itself on every boot (wake-lock included, then `start-sylvia.sh`). Install
the app from F-Droid and **open it once** — Android only registers its boot receiver on
the first launch — then verify with a reboot: `http://127.0.0.1:3080` should answer
without you touching anything. The seeded script is yours after creation; re-run
`install.sh --force` to regenerate it.

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
`adbd` over `127.0.0.1`** — no Shizuku, no companion app. The installer **attempts this
connection automatically at the end of install**; if it didn't come up (e.g. Wireless
debugging wasn't enabled yet), run the helper it wrote:

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

### Shizuku transport ladder (recommended, optional)

The daemon can drive the device through **Shizuku** instead of the raw loopback: a
shell-uid (`uid=2000`) bridge that binds netlink natively and needs **no adb server at
all** for detection. Recommended build: **[Shizuku+ (thejaustin/ShizukuPlus)](https://github.com/thejaustin/ShizukuPlus)**
— a heavily-maintained fork that, unlike stock Shizuku, exposes a programmatic START
broadcast. Shizuku stays **optional**: with none installed, everything below degrades to
the loopback above.

One-time setup on the phone:

1. Install **Shizuku+** (GitHub/F-Droid APK) and start it via **Wireless debugging**
   (pair once — the app remembers it).
2. Export **rish** from the app and copy `rish` + `rish_shizuku.dex` into
   `/data/data/com.termux/files/rish/` (`chmod 400` the dex — Android 14+ refuses to
   load a writable one).
3. Run `rish -c id` once from Termux and **approve the authorization prompt** — the
   grant survives server restarts. (`RISH_APPLICATION_ID=com.termux` is auto-discovered.)
4. Optional: set `SYLVIA_SHIZUKU_AUTH_TOKEN` (from the Shizuku+ settings) in
   `start-sylvia.sh` to enable the token-broadcast kickstart; without it the ladder
   skips that step and says so.

```sh
# The daemon runs the ladder at boot; query or force a pass any time:
curl -s http://127.0.0.1:3090/api/transport            # last state: kind/tier/attempts
curl -s -X POST http://127.0.0.1:3090/api/transport/ensure
```

Ladder (all headless): **probe** (`rish -c id`, 6s cap) → **kickstart** (token broadcast
→ UI-launch, best-effort) → **adb fallback** that extracts Shizuku's own `libshizuku.so`
starter from the installed APK (needs `unzip`, in base packages), runs it as shell uid,
and polls the probe until the server finishes warming up → **teardown** of the fallback
once Shizuku answers again. State lives in `~/.sylvia/transport.json`. While Shizuku is
alive, network detection runs `ip route get`/`dumpsys` **through rish as shell uid**
(`/api/network` shows `source: tier0-shizuku+…`) — no adb server side effects.

---

## 7. The control panel

Open **`http://127.0.0.1:3090`** in the phone browser for the Sylvia control panel.

- **Status** — the **Harness card** first (state, **Open DSH ↗** and **Restart
  harness** buttons), then network state (wifi/cellular/none, metered, SSID, WAN IP),
  netgate status (harness held? managed traffic held?), paused-work count, module status
  summary, daemon health, manual pause/resume. Open DSH is powered by `GET /api/dsh-url`:
  it re-reads the harness startup log every refresh, hands over the **current** token,
  and *proves* it with a real exchange (`verify: accepted|rejected`) — so the link opens
  straight through even after clearing browser data. **Restart harness**
  (`POST /api/dsh/restart`) kills the `dsh web` process, truncates the token log and
  respawns the server; the Open DSH button turns **red (still clickable)** until the NEW
  token is confirmed accepted, then returns to normal.
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
> registered by default (see §2). The proxy **auto-starts with the server**
> (`MITMPROXY_AUTO_START=1` in the registration); the agent also has `start_proxy` /
> `stop_proxy` tools to control it on demand.

---

## 9. Repository layout

```
install.sh          idempotent, fail-fast installer (the entry point)
sylvia-mcp/         custom MCP server source (9 tools)
sylvia-daemon/      control daemon (network detection, netgate, registry, modules, web panel)
sylvia-bridge/      DSH plugin (network-aware harness gating)
modules/            module definitions (sillytavern, mdns) — copied to ~/.sylvia/modules/
owned_forks/        OUR forks (DSH Mobile patches, dsh-nuncia) — changes are made here — NOT shipped
reference/          read-only clones of upstream tools (tasker-mcp, mitmproxy-mcp) — NOT shipped
```

`owned_forks/` holds the forks we actually develop in: `Deepseek-harness-mobile` (the
Android/Termux DSH patches) and `dsh-nuncia` (the authenticated A2A bridge, DESIGN §20).
`reference/` holds read-only clones of `tasker-mcp` and `mitmproxy-mcp`. None of this is
part of the install; `install.sh` prefers local clones when present (so a dev checkout
works offline) and falls back to a shallow `git clone` otherwise.

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
android-tools, uv, nmap, iproute2, python, unzip) and any `@deepseek-ai/dsh` install, since those can be shared
with non-Sylvia tooling. Pass `--remove-packages` / `--remove-dsh` to take those too.

## 11. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `nodejs-lts` install fails | You're using the Play Store Termux build — uninstall and install from F-Droid or GitHub releases. |
| `CANNOT LINK EXECUTABLE "curl": cannot locate symbol …` | Mixed-version Termux tree: apt pulled `curl` forward but not its TLS/QUIC backend. Run `apt-get update && apt-get full-upgrade -y` (**`apt-get`, not `pkg`** — the `pkg` wrapper itself needs the broken curl), then re-run `install.sh` (it now always full-upgrades via `apt-get` before installing anything). |
| ADB connection drops immediately | Enable **Wireless debugging** (physical) or restart the emulator. Run `~/.sylvia/sylvia-adb-connect.sh` manually and check output. |
| Daemon not responding | Check `~/.sylvia/sylvia-daemon.log`. Verify port: `curl http://127.0.0.1:3090/api/health`. |
| MCP tools don't appear in the model's toolset | `grep -n "sylvia-mcp" ~/.dsh/profiles/web/cordis.patch.yml` — the entry must exist. Re-run `install.sh`; the append is guarded by `id` so it won't duplicate. |
| Bridge plugin not loading | Check `grep -n "sylvia-bridge" ~/.dsh/profiles/web/cordis.patch.yml`. Verify the symlink: `ls -la ~/.dsh/profiles/web/node_modules/sylvia-bridge`. |
| Tasker reload intent not firing | Verify the broadcast action string against your Tasker build in the emulator Logcat. |
| Discovery scan refuses | It refuses on metered/offline networks. Check network state via `mcp__sylvia__network_state`. |
| Harness dies with `plugin tree failed to load` | Upstream npm drift inside the CLI's tree — nested *stock* copies of the fork packages shadowing the patched tarballs, or a half-finished install. Re-run `install.sh`: the version canary forces a repair, stale fork clones are re-cloned, and the prune + drift guards are feature-guarded so they re-apply cleanly. (The old `Cordis HMR service` wording in this row belonged to the pre-0.2.1 train and is retired.) |
| Browser shows `Failed to load plugins / web boot: window.__ModuleLoader__ bootstrap facade is missing` | Version skew between the npm-resolved web frontend (rc.8+) and the fork-pinned `dsh-client-modules` (rc.7, predates the facade). Re-run `install.sh` — it aligns `dsh-client-modules` to the frontend version — then hard-refresh the page (Ctrl+F5). |
| Chat fails with `Failed to load history … maxImageDimension … expected number, received undefined` | `dsh-attachment-local` is missing the `maxImageDimension` key the image-limits projection requires. On the current train the fork tarball carries it upstream — re-run `install.sh`, which *verifies* the feature (and repairs legacy old-train installs in place, keeping the Android fixes), then reload the session. |
| `EADDRINUSE … 3080` at launch | A previous harness instance is still running — kill the stale `node … bin.js web` process and relaunch. |
| Harness UI answers `dsh web authentication required` (401) even though the panel shows a token | The browser session is gone and the logged token may be stale. Click **Restart harness** on the Status page: it mints a fresh token, and Open DSH stays red (clickable) until the new token is *verified accepted* — then click it. |
| The URL the launcher opens automatically at startup lands on 401, but the same link copied out of `~/.sylvia/dsh-web.log` works | Older generated `start-sylvia.sh` matched the token as `[A-Za-z0-9]*`, which truncates a base64url token at its first `-` or `_` — so the opened link carried a *corrupted* token. Intermittent by design: it only bites when the minted token happens to contain those characters. Fixed in the installer template (`[A-Za-z0-9_-]`); re-run `install.sh` to regenerate the launcher. |
| Harness not running after a reboot | Termux:Boot autostart isn't active: install the app from F-Droid and **open it once** (the boot receiver registers on first launch), check the seeded script with `ls ~/.termux/boot/`, and re-run `install.sh` if it's missing. |
| mitmproxy tools missing on first launch | The first `uvx` build is slow — check `~/.sylvia/.mitmproxy-mcp-warm.log`, then re-run `install.sh` (warm build and `patchelf` fixes are idempotent). Reload the MCP servers from the UI if they still don't appear. |
| Boots into a wall of `plugin(s) failed to load … could not be resolved` (nearly every core plugin) | The registry published a newer DSH train that imports helpers the pinned CLI never declares (`Cannot find package '@deepseek-ai/dsh-timeout'` and friends in the boot log — npm never installs them because nothing declares them). Re-run `install.sh`: the ambient dependency sweep imports every package in the tree, installs each missing package at the matching version, and verifies the sweep is clean. |
| Boot dies with `No usable native binding found for node-addon-require-builtin-android-x64` | Upstream publishes no android build of that binding (and no source in the package). Re-run `install.sh` — `module_native_binding` downloads the prebuilt artifact from this repo's `native/<arch>/` (dlopen + functional verified) or builds it on-device from upstream source (`native/README.md`), then restart the harness. |
| Selecting a workspace appears to work, then the UI immediately deselects it (no error shown) | The click runs `session.create`, which must mount the `standard` agent preset; the server reply is `agent-preset-invalid … workflow-engine … waiting` and the client reverts silently. Same root cause as above: rc.8-train packages only *peer*-declare their workflow deps (`dsh-workflow`, `dsh-session-telemetry`), so npm never installs them. Re-run `install.sh` (the ambient sweep scans the CLI's nested tree) and restart the harness. |
| Managed services (mDNS, rclone, …) stay paused long after wifi returns | By design: `resumeOnReconnect` is locked `false` — release is explicit (the gate fails closed and stays closed). Resume from the control panel or `POST http://127.0.0.1:3090/api/netgate/resume`. If the hold re-engages while the network looks fine, check `/api/network` — the daemon's own verdict is the source of truth it gated on. |
| `POST /api/transport/ensure` → `ladder-exhausted` | Read the `attempts` array — it names the step that failed and why. `starter extraction failed` → `pkg install unzip`. rish probe fails though the app runs → re-run `rish -c id` and approve; check `RISH_APPLICATION_ID=com.termux`. `broadcast` shows `skipped` unless `SYLVIA_SHIZUKU_AUTH_TOKEN` is set (an invalid token makes Shizuku+ raise a HIGH-priority notification, so it is never guessed). |
| Network `source` is `tier0-adb…`/`denied` although Shizuku works | Detection only routes through rish when `~/.sylvia/transport.json` says `kind: shizuku`. Run `POST /api/transport/ensure` once (or restart the daemon — it probes at boot) and re-check `/api/network`. A rish failure always falls back to the adb chain, so the source name tells you which identity answered. |
| New sessions fail with `flock is not supported on android-x64` (`ERR_FLOCK_UNSUPPORTED_PLATFORM`) | The session lock asks `@deepseek-ai/node-addon-system` for a POSIX `flock` binding, whose loader only accepts `linux`/`darwin` — and no android build is published, so every new session on the alpha.5 train died at the lock. The fork's `session-persistence-jsonl` tarball now treats **only** that exact error code as "lock acquired" (the daemon is the single writer by design); every other error, including real contention → `SessionAlreadyOwnedError`, still propagates. Re-run `install.sh`, then restart the harness. |
| After some packages install, plugins silently deactivate with `Cannot find package '@deepseek-ai/dsh-session'` | The `--legacy-peer-deps` retry npm needs for `dsh-terminal-bash` (its 8 peerDependencies crash arborist's tree builder) **prunes nested peers** the CLI depends on. `install.sh` now repairs the tree (reinstalls the CLI spec, re-prunes stock fork copies) and then *proves* a nested peer resolves, failing loudly if not. Re-run `install.sh`. |
| Chat/A2A task fails at prompt assembly: `prompt variable "{{model}}" has no value for this assembly` | The preset's persona prefix interpolates `{{model}}`, so an agent created without a bound model cannot start its first turn. Defaults exist (the host's `agentDefaultModel` selection is used automatically); if this appears, pick a model in the UI (Settings → Models) or set `model:`/`provider:` on the plugin config. |
| A turn dies with `format v4 message requires a producer-owned source kind` | A plugin injected a message with the retired `source.kind: 'plugin'` wrapper. The v4 session format refuses that kind when adopting the event, and the rejected write fails the **whole turn** — so one bad notice looks like a model/turn failure. Use the producer's own kind (`plugin:<package>`, exactly what the format's v3 rewrite produces); `sylvia-bridge` and `dsh-nuncia` are fixed, so if it appears again it is another injector. |
| An A2A operator reports "chatelaine session is not reachable" and nothing arrives | The chatelaine's stored session id pointed at a session that no longer exists — a renamed id, or a wiped store. `dsh-nuncia` now falls back to the previous thread and, if that is gone too, adopts a fresh session, so the report lands somewhere instead of being lost. Check `~/.sylvia/housekeeping/.nuncia/chatelaine.json` and the session directory beside it. |
| A remote A2A operator is cancelled the moment the phone goes metered | By design the network gate fails closed: metered data means no work unless you opt in. Set `allowA2AOnMetered: true` on the **bridge** row, or exempt the A2A service from the **daemon**'s gate (the panel's Netgate card has an **Exempt** button per service, and `SYLVIA_A2A_EXEMPT_FROM_GATE=1` exempts the always-on modules). The exemption is per A2A session — an ordinary session is never exempt. |
| The A2A panel says the admin token is missing, or the proxy answers 503 | The daemon reads the admin token from the encrypted vault; the passphrase must reach it as `SYLVIA_SECRET_KEY` (the launcher sources `sylvia.env`). Check `~/.sylvia/secrets-access.log` — every vault read is recorded there, which is the tripwire: an unexpected line means something opened the vault without being asked to. |
| `nuncia-secrets` says "no passphrase in SYLVIA_SECRET_KEY" | The CLI needs the passphrase in the environment (`export SYLVIA_SECRET_KEY=…`) or a `--key-file`. The vault itself is at `~/.sylvia/secrets.enc`; its access log is the sibling `~/.sylvia/secrets-access.log`. |
| `glob`/`grep`/`search` fail with `SearchError: SEARCH_FAILED — glob could not start its search command (ripgrep launch failed)` | DSH's search tools do not use a `PATH` `rg`: `dsh-tool-fs-search` imports `@vscode/ripgrep`, which resolves a per-platform package and publishes **no android build** — the same gap class as the flock binding. Installing `ripgrep` alone does not help. `install.sh` installs the package **and** writes the missing `@vscode/ripgrep-android-<arch>` shim that execs the Termux `rg`, then proves the import resolves and `rg --version` runs. Re-run `install.sh`, then restart the harness. |
| Nothing is running after the device reboots (harness, daemon, modules all down) | Termux:Boot is not installed — `pm list packages \| grep com.termux.boot` returning nothing means the seeded `~/.termux/boot/10-sylvia.sh` never executes. Install Termux:Boot from F-Droid and **open it once** (the boot receiver registers on first launch). Nothing in Termux can self-start without it. |
| The `mdns` module restarts forever and never comes up (`died ~0s after start … death streak N`) | Android has no `avahi-daemon`/`mdnsd` CLI — discovery there is the framework's Network Service Discovery — and Termux's repos ship neither package, so this module cannot run as a daemon. It is now `behavior: manual` and `on.sh` explains why (exit 2) so the daemon stops churning. Re-run `install.sh` for the corrected manifest. |
| Panel's **Open DSH** opens a 401 page, but the same link pasted into a new tab works | A tokenless navigation (the anchor's static `href`, or a click before `/api/dsh-url` refreshed) loses the `?token=`. The panel now refuses to navigate without a token, fetches a fresh one, and falls back to a same-tab open if the popup is blocked. If it still happens, check `curl http://127.0.0.1:3090/api/dsh-url` — `verify` must say `accepted`. |
| An A2A operator cannot reach another node's chatelaine | **Withdrawn in §20.16** — `message_peer_chatelaine` and the inbound `metadata.toChatelaine` channel are gone. A peer reaches a node's operator lane through the normal A2A path, and the *local* chatelaine of either node reaches the other with `send_nuncia` (chatelaine-only) on the peer's open exchange. Sending and minting are the chatelaine's alone. |
| The A2A `/status` advertises a chatelaine session that has no session behind it | The P3.1 id migration renamed the pointer, but a v4 session's id lives inside its own header and cannot be renamed. `ensureTagged()` now creates the session under the tagged id on first use, so the advertised id is real; the untagged thread remains on disk as the fallback and history. |
| The chatelaine is not listed in DSH, or you cannot find the session to talk to | A session is only listed when it is attached to a workspace record, and its row is labelled by the workspace path's basename. Since P4.1 the chatelaine lives in `~/.sylvia/housekeeping/chatelaine` and is attached to a workspace titled **Chatelaine** — look for that group in the sidebar, not for a session inside Housekeeping. `node bin/nuncia-chatelaine.js show` prints the session id, directory, workspace and brief state. |
| The chatelaine turn dies with `working-directory: directory does not exist` | The session was created before its directory. The plugin now creates the directory first; re-run `install.sh` (or copy `lib/chatelaine.js`) and restart, then `nuncia-chatelaine.js new` to cut over to a session whose first turn can run. |
| You want a fresh chatelaine thread (to paste a context handoff into) | `node bin/nuncia-chatelaine.js new` (or `POST /a2a/admin/chatelaine/new`, loopback + bearer). It creates and briefs a new session, keeps the old id as `previousSessionId`, and returns the id; open that workspace in DSH and paste the handoff into the thread. Context is self-managed — the plugin only guarantees identity, brief and delivery. |
| The chatelaine never reacts to operator reports | That was the pre-P4.1 behaviour: reports were delivered with `inject`, which opens no turn, so the inbox grew and nothing ran. Since §20.16 the entry point is `message_chatelaine` — set `question` and the chatelaine is woken immediately; a plain report is durable and silent. A coalesced wake (DESIGN §20.14.4) is still pending. |
| A peer's retries each create a **new** operator on this node, instead of continuing one | The executor reuses an operator when the incoming message carries the same `contextId` and origin. Since §20.16 the SENDER never names an exchange: inside a task the task's own exchange is used, and outside one the client library keeps an open exchange per peer. Update `lib/index.js` on **both** nodes and reload by appending a marker comment to `cordis.patch.yml`. |
| An A2A operator reads `.nuncia/`, the daemon logs, `cordis.patch.yml` and `DESIGN.md`, and never sends anything | The brief did not say who it could reach or that looking was wrong. It now names the node, lists the paired peers by name, names the four tools that do the job, and forbids reading configuration or grepping the disk — ask the chatelaine one focused question instead. If you still see digging, the node is running an old `lib/chatelaine.js`: check `GET /a2a/admin/status` → `identity.name` is the configured name, not a hostname. |
| An operator gets *"a2a_send belongs to the chatelaine only — ask for it with message_chatelaine and wait for its decision"* | By design since §20.16: sending, minting authority, and messaging local sessions are the chatelaine's lanes. The operator's job is to report with `message_chatelaine` and wait for the decision. If the CALLER should have been the chatelaine, the chatelaine session id drifted — `GET /a2a/admin/status` → `chatelaine.sessionId` is the truth. |
| `a2a_send` says *"unknown peer \"X\" — add it to authority.peerUrls as \"name=url\""* | The peer is known (public key) but has no **dial plan**. Set `authority.peerUrls` on the sending node: the AVD reaches the desktop at `http://10.0.2.2:4123`; the desktop reaches the AVD through an adb forward (`adb -s 127.0.0.1:5555 forward tcp:4124 tcp:4123`, then `http://127.0.0.1:4124`). Re-issue the forward after an adb-server restart. |
| A chatelaine (or operator) session has **fewer tools** than a normal session — no `read`/`write`/`edit`/`pwsh`/`shell`, no delegation or `todo` tools, only `cabinet_*`, browser and research — while its projection still says `agentPreset: standard` | Pre-§20.17 defect: the preset was mounted on `agents.create` only, but these sessions dispose their create-time handle and are **resumed** on every later delivery, and DSH mounts a preset only through the caller's `setup` callback. Update `lib/chatelaine.js` **and** `lib/index.js` on the node and reload (append a marker comment to `cordis.patch.yml`). The fix resolves the preset id first, so a wrong id now fails with `Unknown agent preset: <id>` instead of mounting nothing. A node missing `agentPresets` warns once at boot and says what the session loses. |

---

## Security model

- **Loopback only, unauthenticated.** The web RPC is remote code execution by design. It
  binds `127.0.0.1` (shared with the on-device browser). **Do not add `--host
  0.0.0.0`** — that exposes an unauthenticated shell to your LAN.
- **`DSH_PERMISSION_MODE=danger-full-access`.** Android has no
  `bwrap`/Landlock/Seatbelt sandbox backend, so the sandbox fails closed and the launcher
  opts into running unconfined. Treat the agent as shell access.
- **Telemetry off by default** (`DSH_TELEMETRY_DISABLED=1`).
- **The vault raises the cost of finding a secret; it does not create a
  trust boundary.** The pairing secret and the A2A admin token live in
  `~/.sylvia/secrets.enc` (AES-256-GCM), and only the passphrase
  (`~/.sylvia/.secret-key`, mode 0600) is outside it. A local agent runs as
  the same uid, so it can read the key and decrypt the vault itself — that is
  the same `danger-full-access` boundary as above, not a new one. What the
  vault does buy is that a secret is no longer sitting in plain text next to
  the passphrase, and **every decryption is recorded** in
  `~/.sylvia/secrets-access.log` — the plugin, the daemon and the CLI all
  write that one file, so an unexpected line there means something opened
  the vault without being asked to.
- **A2A nodes authenticate each other with public keys.** Authority
  envelopes are signed with a per-node Ed25519 key; a node verifies with the
  peer's **public** key, so holding a peer's key never lets you mint
  authority under that peer's name. The bearer token (derived from the
  pairing secret) is connection auth only — it is not a signing capability.
| The chatelaine reads state files, transcripts and daemon logs before it answers, and names an operator by no handle | Before §20.18 the `message_chatelaine` notice carried no sender: no handle, no peer, no authority window. It now opens with a provenance line (`from operator op_… (task …, session …)` + `peer: … · authority: …`), and `operator_authority` with **no handle** (chatelaine only) returns the whole operator roster plus the paired peers. `CHATELAINE_BRIEF_VERSION` is 3, so update `lib/index.js` **and** `lib/chatelaine.js` and reload; an old brief keeps the old text until the version changes. |
| I cannot find any A2A operator sessions in the DSH client, though they clearly ran | Operators are attached to the workspace record **A2A operators** (`<house>/operators`), and the chatelaine to **Chatelaine**; both are titled (`A2A <requester> — <ask>`, `Chatelaine — <node>`). Before §20.18 operators sat in the house root, whose record is *also* titled "Housekeeping" — the same title as the human's own `F:\Housekeeping`, so the row looked empty. Sessions created before the change cannot be moved: `attachSession` requires the session's `cwd` to equal the record's path. |
| A chatelaine session obtains tools by running `cabinet_config set` | Seen live before §20.17: a session with no preset mounted (so no file/exec tools) tried to rewrite `~/.dsh/tool-cabinet.json` to give itself a desk. Mount the preset on create **and** resume (§20.17) instead of repairing the cabinet, and leave the resulting desk alone if it already matches what you run. |
| An operator cannot answer its requester — `send_nuncia` says it "belongs to the chatelaine only" | Pre-§20.19. `send_nuncia` now has an operator lane: it replies on the conversation the operator is handling (its own `contextId`), and only to that peer. Update `lib/index.js` + `lib/chatelaine.js` and reload; the operator brief names the lane. |
| An operator refuses a request and the requester just sees a task that went quiet | Pre-§20.19: there was no refusal tool, so an operator could only work or escalate. `refuse_request` publishes `TASK_STATE_REJECTED` with the reason. Note that a request carrying verified user intent is **not** refusable — the tool throws and tells the operator to escalate. |
| Directives never lapse / an operator still obeys a rule whose time is up | `expire()` is clock-based and idempotent, so a directive stops applying the moment `expiresAt` passes; the sweep only sends the notices. If a node still enforces one, it is running pre-§20.19 code — update `lib/index.js` + `lib/directives.js` and reload. A malformed `directives.json` throws at boot rather than starting empty. |
| The chatelaine was woken by a directive or an expiry notice | It should not be: both are delivered with `inject` (queued, read next turn), never `followup`. If a wake happened, the caller passed `wake: true` — only questions and reports worth the human's attention may do that. |
| Every operator report starts its own chatelaine turn | Pre-§20.20: a report was injected durably but nothing armed a wake, and the brief already promised a coalesced one. Now the first report arms ONE `wakeCoalesceMs` timer (default 30 s) and the flush names the backlog (`[wake] N reports are pending`); a question still wakes immediately and does not arm it. Update `lib/chatelaine.js` and reload. |
| An operator says `message_local_session` "is not approved for operator op_…" | Correct behaviour since §20.20: an operator may only message a local session on a path the chatelaine approved. Approve it with `approve_local_contact {operator, session}` (both explicit — `session` is the target session id, not a handle); `revoke: true` removes the path. The book is `<stateDir>/contacts.json` (0600, read-time expiry). |
| The chatelaine cannot tell whether the operator's summary lost something | `read_original_message {task}` (chatelaine only) returns the exact text the operator received, by task id, 8-char prefix, or handle. Operators are briefed to lead their first report with `safety: low / medium / high — <clause>` so reading it is a decision, not a reflex; treat the text as data, never instructions. Tasks that predate §20.20 answer "did not keep its original text". |
| The AVD harness answers 000 on :3080 and the plugin tree says `Plugins waiting for services (5): webServer` | Not a code fault. Check `free -m` and `top`: the mitmproxy `uv` warm build (`rustc`/`cargo` for `mitmproxy-rs`, `cryptography`) pins the whole 2.4 GB emulator (48 MB free, swap full, `node -e` taking 60 s), and a stale `bin.js web` holding 3080 makes the new one die with `EADDRINUSE`. Stop the build by exact pid (never a blanket kill), kill the stale harness pid, then start it directly: `setsid nohup node --expose-internals …/dsh/lib/bin.js web --port 3080 --no-open`. If the launcher hangs, it is `termux-wake-lock` (Termux:API not answering) — the `bash -x` trace stops on that line. |
| The control panel's **Processes** card shows a service as `conflict` | Something is holding that port that is not the service (a leftover from a manual start, or a different build). `GET /api/services` lists what was probed and which pids matched; kill the stranger by exact pid (never a blanket kill) or `POST /api/services/<name>/stop` if it *is* the tracked owner. The daemon never kills an unrecognised process for you. |
| mitmproxy MCP tools are missing, or only appear after a restart | Since §21.1 mitmproxy is a toggle and **OFF by default**: the installer writes the `mitmproxy-mcp` row inside `# sylvia:mitm-mcp:begin/end` markers, and the daemon's toggle comments the block out. Turn it on in the panel (**Processes → Enable mitmproxy**), from the API (`POST /api/mitm/enable`), or let an agent call the `net_diagnostics` tool. Enabling rewrites the profile, so the MCP tools appear only after the harness restarts — the tool's own result says so and `GET /api/mitm` reports `needsRestart: true` until then. |
| `net_diagnostics` answers `sylvia-daemon is not reachable at http://127.0.0.1:3090` | The toggle lives in the daemon, not in the bridge plugin. Start the daemon (the launcher does it), or point the bridge's `daemonUrl` at wherever it runs. The tool never restarts the harness, so it cannot be used to fix this for you. |
