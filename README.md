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
| Harness not running after a reboot | Termux:Boot autostart isn't active: install the app from F-Droid and **open it once** (the boot receiver registers on first launch), check the seeded script with `ls ~/.termux/boot/`, and re-run `install.sh` if it's missing. |
| mitmproxy tools missing on first launch | The first `uvx` build is slow — check `~/.sylvia/.mitmproxy-mcp-warm.log`, then re-run `install.sh` (warm build and `patchelf` fixes are idempotent). Reload the MCP servers from the UI if they still don't appear. |
| Boots into a wall of `plugin(s) failed to load … could not be resolved` (nearly every core plugin) | The registry published a newer DSH train that imports helpers the pinned CLI never declares (`Cannot find package '@deepseek-ai/dsh-timeout'` and friends in the boot log — npm never installs them because nothing declares them). Re-run `install.sh`: the ambient dependency sweep imports every package in the tree, installs each missing package at the matching version, and verifies the sweep is clean. |
| Boot dies with `No usable native binding found for node-addon-require-builtin-android-x64` | Upstream publishes no android build of that binding (and no source in the package). Re-run `install.sh` — `module_native_binding` downloads the prebuilt artifact from this repo's `native/<arch>/` (dlopen + functional verified) or builds it on-device from upstream source (`native/README.md`), then restart the harness. |
| Selecting a workspace appears to work, then the UI immediately deselects it (no error shown) | The click runs `session.create`, which must mount the `standard` agent preset; the server reply is `agent-preset-invalid … workflow-engine … waiting` and the client reverts silently. Same root cause as above: rc.8-train packages only *peer*-declare their workflow deps (`dsh-workflow`, `dsh-session-telemetry`), so npm never installs them. Re-run `install.sh` (the ambient sweep scans the CLI's nested tree) and restart the harness. |
| Managed services (mDNS, rclone, …) stay paused long after wifi returns | By design: `resumeOnReconnect` is locked `false` — release is explicit (the gate fails closed and stays closed). Resume from the control panel or `POST http://127.0.0.1:3090/api/netgate/resume`. If the hold re-engages while the network looks fine, check `/api/network` — the daemon's own verdict is the source of truth it gated on. |
| `POST /api/transport/ensure` → `ladder-exhausted` | Read the `attempts` array — it names the step that failed and why. `starter extraction failed` → `pkg install unzip`. rish probe fails though the app runs → re-run `rish -c id` and approve; check `RISH_APPLICATION_ID=com.termux`. `broadcast` shows `skipped` unless `SYLVIA_SHIZUKU_AUTH_TOKEN` is set (an invalid token makes Shizuku+ raise a HIGH-priority notification, so it is never guessed). |
| Network `source` is `tier0-adb…`/`denied` although Shizuku works | Detection only routes through rish when `~/.sylvia/transport.json` says `kind: shizuku`. Run `POST /api/transport/ensure` once (or restart the daemon — it probes at boot) and re-check `/api/network`. A rish failure always falls back to the adb chain, so the source name tells you which identity answered. |

---

## Security model

- **Loopback only, unauthenticated.** The web RPC is remote code execution by design. It
  binds `127.0.0.1` (shared with the on-device browser). **Do not add `--host
  0.0.0.0`** — that exposes an unauthenticated shell to your LAN.
- **`DSH_PERMISSION_MODE=danger-full-access`.** Android has no
  `bwrap`/Landlock/Seatbelt sandbox backend, so the sandbox fails closed and the launcher
  opts into running unconfined. Treat the agent as shell access.
- **Telemetry off by default** (`DSH_TELEMETRY_DISABLED=1`).
