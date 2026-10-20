# Sylvia — Design Notes

Living design document for the Sylvia agent-harness project. Keeps architecture decisions on track across sessions.
Companion docs: `README.md` (user install), `install.sh` (installer), `sylvia-mcp/` (MCP server source).

Related repos: `owned_forks/Deepseek-harness-mobile` (our fork of DSH Mobile),
`owned_forks/dsh-nuncia` (our fork of dsh-a2a-server — the A2A bridge, §20) — our
changes live there, never shipped. `reference/tasker-mcp`, `reference/mitmproxy-mcp`
(read-only upstream clones, debugging only).

---

## 0. Status & scope

- **In scope now:** network-state awareness + traffic gating, DSH bridge plugin (context injection / turn control),
  resource registry with ownership & permissions, sylvia-mcp access tools, standalone control panel, pruning.
- **Future expansion:** agent resources + external-subagent tool (§9).
- **Not shipped:** `reference/` clones, emulator tooling (dev loop only).

---

## 1. High-level architecture

Everything runs inside Termux on one phone; everything is loopback-only (`127.0.0.1`, never `0.0.0.0`).

```
Termux (Node, loopback only)
├── Sylvia daemon               :3090   [single long-running service — the shared brain]
│     • resource registry (networks / hosts / typed resources, ownership, pruning)
│     • policy engine (hidden / ask / allow evaluation)
│     • network detection + netgate (state file, SIGSTOP/CONT of managed traffic)
│     • discovery (nmap-backed) → registry
│     • module manager (local webservers: SillyTavern, mDNS, … — §9)
│     • control API (loopback)  ← consumed by: sylvia-mcp, bridge plugin, web UI
│     • web control panel (static HTML, no build step)
├── sylvia-mcp (stdio, spawned by DSH)
│     • tools → call daemon :3090 (policy enforced on every access path)
├── DSH web :3080
│     └── sylvia-bridge plugin (cordis, in-process — see §3)
└── managed traffic (own pgids): rclone, mitmdump, mDNS responder
```

**Why a daemon:** three consumers (MCP tools, bridge plugin, web UI) need the *same* live resource/policy/netstate.
One writer, one prune pass, one policy decision point — instead of loose JSON that every tool re-reads.
State persists as human-inspectable JSON under `~/.sylvia/` (daemon is the only writer).

**Ports:** DSH `:3080`, Sylvia daemon `:3090`, Tasker API `:1821`.

---

## 2. Network state & gating (Feature 1)

### 2.1 Detection tiers (no companion apps)

| Tier | Command | From | Answers | Notes |
|---|---|---|---|---|
| 0 | `ip route get 1.1.1.1` | bare Termux UID, sub-ms | transport: `dev wlan*` = wifi, `dev rmnet*/ccmni*/apn*/wwan*` = cellular, unreachable = none | metering-blind; reports where *our UID's* packets egress |
| 1 | `adb shell dumpsys netpolicy` → `mMeteredIfaces=[...]` | loopback adb (uid 2000 shell) | Android's own metered verdict (catches user-marked metered WiFi) | authoritative |
| 1b | `adb shell dumpsys connectivity` → default net `type:` + `NOT_METERED` + `VALIDATED` | loopback adb | transport + metered + validated in one dump | header wording drifts by OEM/version → tolerant parser (find default id, match that id's line) |
| event | `adb shell logcat -s ConnectivityService:V` | loopback adb | change *trigger* only | any match → re-run detection; never parse the line's meaning |

**Prereqs / hard facts:**
- Loopback adbd = **uid 2000 (shell), never root** on a production phone (`adb root` fails). `dumpsys`/`cmd`/`svc`/`logcat`
  are Permission-Denied from the Termux UID — everything routes through `adb shell`.
- Plain `ip route` (no `get`), `/proc/net/route`, `/sys/class/net/*` are **misleading** on Android (per-network fwmark
  tables; wlan0 and rmnet stay up simultaneously). Never use them.
- `termux-connectivity` doesn't exist; Termux:API commands need the companion APK and don't report metering anyway.
- **Fail closed:** ADB down ⇒ unknown ⇒ treat as **metered** (a false "go" costs money; a false "stop" is safe).
  Fall back to Tier 0 inference (cellular ⇒ metered, wifi ⇒ unmetered); if Tier 0 fails too → hold.

### 2.2 Detection scheme
logcat event trigger + 15–30 s Tier-0 safety poll (~free) + synchronous Tier-0 pre-flight before every LLM call.
Authoritative Tier-1 verdict on state change. Reuse `sylvia-mcp`'s proven ADB drop/reconnect logic (`resilient_adb_exec`).

### 2.3 Gating — two independent stops (deliberate split)

| | Harness | Managed traffic (rclone, mitmproxy, mDNS) |
|---|---|---|
| Mechanism | **in-process**: hold/cancel via plugin (§3) | **out-of-process**: netgate `kill -STOP <pgid>` / `kill -CONT` |
| Why | must be *graceful* ("finish current stream") + keep local UI alive | hard stop, no UI, separate processes |
| Freezes plugin? | no (cooperative) | no (different pgid) |

SIGSTOP cannot "finish a stream"; SIGSTOP'ing the harness would also freeze the web UI and the plugin itself —
the split isn't just possible, it's required. Each managed service launched via `setsid` so it has its own pgid;
the watcher (`setsid` too, `termux-wake-lock` + `adb shell dumpsys deviceidle whitelist +com.termux` +
`appops RUN_*_IN_BACKGROUND allow` to survive doze) never touches the harness process.

**rclone:** launch-gating only (start syncs exclusively when unmetered) + SIGSTOP pgid if a transition hits mid-sync.
**Last-resort hammers (documented, not routine):** `su -c iptables -I OUTPUT -m owner --uid-owner <termux_uid> -j REJECT`
(all Termux = one UID, coarse, needs real root, re-apply after netd rebuilds); `svc data disable` (device-wide, user-visible).

### 2.4 Config (defaults locked)

```yaml
netgate:
  resumeOnReconnect: false      # LOCKED: held work stays held on wifi return (no surprise metered usage)
  notifyPausedWork: true        # LOCKED: on reconnect inject "N held task(s) remain — say resume to continue"
  harness: pause | allow        # LOCKED: pause agent turns on metered/offline; allow = only managed traffic gated
  managed: [rclone, mdns, mitmproxy]
  triggers: [metered, offline]
  pollIntervalMs: 20000
```

---

## 3. sylvia-bridge — general-purpose DSH plugin (Feature 2)

One cordis ESM namespace plugin (`name` / `inject` / `Config` / `apply`), `inject: ['agents','tools','connection','jobs']`.
Not a one-purpose "netguard": config-driven **context injection + observation + turn control** for Sylvia.

### 3.1 Established DSH primitives (verified against 0.1.x types)

- `agent.status` = `'idle' | 'running'` — `@deepseek-ai/dsh-agent` runtime-types.
- **Cancel:** `agent.cancel(cause, options?)`, `cause` kinds = `user|parent|hook|disposed` — **no `'plugin'` kind**,
  so we use `{kind:'hook', reason:'sylvia: metered network'}`. `options.keepInbox` preserves queued work.
- **Hold (graceful):** no mid-stream suspend exists (HTTP LLM stream can only finish or be cancelled). Compose:
  wait turn-end (observe `agent/turn-stopping` / `agent/assistant-stream`), then block re-entry via the
  `agent/pre-step` waterfall returning `{kind:'reject'}`. "Finish current stream" = default; "immediate" = `cancel()`.
- **Resume hook:** `agent/request-error` waterfall → `{kind:'retry'}` (mid-transition calls recover).
- **Injection:** `agent.inject(msg)` queues silently (picked up on next wake); `agent.followup(msg)` opens a turn
  (spends one model request). Message = `createUserMessage({content, source:{kind:'plugin', plugin:'sylvia-bridge',
  form:'notice', summary: boundContextSummary(...)}})` — both imports from `@deepseek-ai/dsh-llm`.
- **Elapsed formatter:** `describeElapsed(ms)` pattern from `@gorban/dsh-job-stop` (`42s`, `5m 3s`, `2h 7m`).
- **Events:** `agent/created`, `agent/status`, `agent/inbox/inserted`, `agent/inbox/claimed` (human input — refill wake
  budget here), `agent/session-start` (`source: startup|resume|clear|compact`), `agent/pre-step` (waterfall), `agent/request`,
  `agent/request-error`, `agent/assistant-stream`, `agent/turn-stopping`, `agent/error`.
- **Time:** every `SessionEvent` carries `time` (epoch ms) — offline-gap is computable from existing data.
  Official `@deepseek-ai/dsh-time-context` gives generic "elapsed since last message" (opt-in) but knows nothing of
  offline windows; our plugin adds the *offline framing*.
- **Interrupted turns already exist:** `interruptedTurnClosers()` synthesizes `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`
  tool errors then `step/end` + `turn/end` (reason `interrupted`) — our hold path maps onto this concept.
- **Routes:** register via `ctx.connection.fetch.register({path, methods, requestBody, fetch})` — behind the Connection
  trust fence (host+Origin+auth). **Never** `ctx.webServer.register` for mutating calls (runs ahead of the fence).
- **Mounting:** profile `package.json` `dsh.profile.bundles` + `cordis.patch.yml` row (`- id / name / config`);
  `patchReload: "live"`. Plugin tool output must be **lossless JSON** (undefined/non-finite/-0/cycles rejected).
- Wake budget: `WeakMap<Agent, number>`, cap via config, refill on `agent/inbox/claimed` when `source.kind === 'user'`.

### 3.2 Responsibilities

1. **Turn control** — metered/offline → `finish-stream` (wait turn-end → `pre-step` reject) or `immediate` (`cancel`).
   Held-work counted, reported to daemon (drives `notifyPausedWork`). Harness stays *alive* while held — local UI and
   loopback ADB keep working; only LLM turns pause.
2. **Context injection** — offline-gap notice, paused-work notice, device/resource enrichment, resume context
   (`inject` for pending, `followup` only when a wake is budgeted and config allows).
3. **Observation (config-driven)** — watch for configured tool/command patterns (e.g. network commands) → ask daemon
   `GET /resolve` → inject context (§6.2 Path B) or refuse-with-reason per policy.
4. **Ask-dialogues** — render DSH approval prompts when policy = `ask` (incl. deny → inject "user declined to use X"
   so the agent doesn't retry blindly).
5. **Mobile CSS seam** — DSH ships no user-stylesheet hook, so the bridge registers `webServer.tapIndex` (the
   ui-theme plugin's own precedent) and inlines `cfg.cssFile` (`~/.sylvia/mobile.css`) into every index render.
   Read-per-render → edit + browser refresh = live styling iteration, no restart; absent/empty file = untouched
   page. Starter seeded by install.sh (`assets/mobile.css`), never overwritten.

---

## 4. Resource model (granular, typed, owned)

Three levels — a host can carry many resources; resources have a **type**.

```
network  →  host (device)  →  resource (typed service/endpoint)
```

```jsonc
// networks/<ssid-bssid>.json
{ "kind":"network", "id":"net:HomeNet:aa:bb:cc:dd:ee:ff",
  "ssid":"HomeNet", "bssid":"aa:bb:cc:dd:ee:ff",
  "wanIp":"203.0.113.5",            // public addr stored ONLY for labeled networks
  "owner":"me", "labels":["home"],
  "permission":"allow",              // allow | ask | hidden
  "firstSeen":…, "lastSeen":…, "seenMs":…, "sightings":42 }

// hosts/pixel7.json
{ "kind":"host", "id":"dev:<stable-key>",
  "name":"Pixel 7", "mac":"…", "serial":"…", "ips":["192.168.1.50"],
  "network":"net:HomeNet:aa:bb:…",     // last network seen on
  "owner":"me", "permission":"allow",
  "fingerprint":{ "os":"…", "banners":[…], "mdns":"…", "dhcpName":"…" },
  "identityConfidence":"confirmed",     // confirmed | corroborated | provisional
  "firstSeen":…, "lastSeen":…, "seenMs":…, "sightings":30 }

// resources/desktop-mcp.json
{ "kind":"resource", "id":"res:dev:<key>:mcp-imagegen",
  "host":"dev:<key>", "type":"image-generation",   // e.g. image-generation | mcp | llm | storage |
                                                   // printer | agent (future §9) | subagent-endpoint
  "endpoint":"http://192.168.1.50:8188/sdapi/v1", "transport":"http|mcp-stdio|mcp-http|adb|custom",
  "owner":"me", "permission":"ask",
  "module":"st-diffusion",              // optional: backing module id (§9) — module registers its resources
  "lastSeen":…, "seenMs":…, "sightings":12 }
```

**Identity rules (locked):** devices are recognized by **serial / MAC**, or by
**fingerprint + (IP, network)**, or by explicit **user declaration** — *never bare (IP, network)*: DHCP leases reassign
addresses constantly, so an IP alone proves nothing. `identityConfidence`: `provisional` (IP-only sighting) →
`corroborated` (consistent fingerprint across ≥N sightings) → `confirmed` (serial/MAC or user-declared).
Discovery uses **nmap** (planned: `imjdl/nmap-mcpserver` — see §7 for the policy caveat).

**Retention rule (locked):** arbitrary public IPs / public machines are **never persisted** — only labeled networks'
own WAN address and labeled/declared devices.

**Ownership:** user labels resources in the panel — `"mine"` / `"<person>"` (friend, coworker) / unlabeled.
Ownership is set per network *and* per host/resource (a friend's device on your network, your device on their network).

---

## 5. Policy engine (the visibility filter)

- **Default: no non-owned, no offline resources are used or shown** — filtered out of every tool result and injection.
- Three gates: **`hidden`** (default for non-owned/offline) | **`ask`** (bridge renders approval prompt before use/reveal)
  | **`allow`** (auto-usable). User raises/lower per **owner**, per **host**, per **resource**, or per **type** in the panel.
- **Type rules** express class-level intent: *“don't use image generation resources without permission”* →
  `{type: 'image-generation', permission: 'ask'}`.
- **Evaluation:** identity rule (most-specific-wins: resource → host → network → owner) gives a base gate, then
  **strictest-wins merge with the type rule** (`hidden > ask > allow`) — a type rule can only tighten, never loosen;
  users relax by explicitly setting that type to `allow`. Unknown/new types default to `ask`.
- **Offline axis:** `now - lastSeen > offlineThresholdMs` ⇒ treated as `hidden` regardless of ownership (panel can
  override/grace).
- `ask` approval flow: bridge plugin issues the DSH approval prompt; deny → inject decline context.

---

## 6. Access paths

### 6.1 Primary — via sylvia-mcp (permissions enforced)
Raw command-line access *cannot* be permission-gated, so the **normal route to any resource is the sylvia-mcp tool
layer**, where every call passes through the daemon policy check before dispatch:

- `network_state()` — current netstate (wifi/cell/none, metered, SSID, WAN IP, source).
- `traffic_gate(action)` — pause/resume managed traffic manually; read netgate status.
- `resource_list(query?, types?)` — policy-filtered (hidden items are *absent*, not redacted).
- `resource_resolve(ip|hostname|name)` — resolve against registry with policy + identity confidence.
- `resource_call(id, action?, args?)` — dispatch via the resource's transport; enforces `ask` (→ returns approval-token
  flow or triggers bridge prompt) and `hidden` (refuse).
- `resource_discover(target?)` — nmap-backed scan → registry ingest → policy-filtered report.

### 6.2 Secondary — command-line observation (best effort)
The bridge plugin watches configured command/tool patterns and injects *advisory* context — e.g. detects a network
command containing an IP, asks daemon to resolve, and injects “192.168.1.50 is `<unlabeled/offline/host>` — use
`resource_call` instead” or “declined by policy”. Advisory only: it can steer and inform, not enforce.

**Enforcement boundary (honest statement):** permissions are *effective* when access goes through sylvia-mcp;
raw shell is *detected and advised*, never prevented.

### 6.3 Interception flow (decision: **Path A first**)
- **Path A (build first):** tool-side enrichment — sylvia-mcp parses its own tool args, calls daemon `resolve`,
  appends short context to the tool result. Robust, no session injection, correct interception point for command-adjacent context.
- **Path B (later):** plugin-level observation → daemon `resolve` → `agent.inject` richer model-facing note; also the
  vehicle for `ask` gating of raw-CLI attempts and context that must outlive one tool result.

---

## 7. Discovery (nmap)

Planned inclusion: `imjdl/nmap-mcpserver` for network awareness (OS/banner/MAC sweeps feeding fingerprint + identity).
**Policy caveat:** registering a raw nmap MCP server would expose *unfiltered* hosts to the model, violating §5
(no non-owned shown). Therefore discovery results must flow **through the daemon** and be policy-filtered before the
model sees them — either (a) daemon shells out to `nmap` itself and exposes `resource_discover` (preferred), or
(b) the nmap-mcpserver is wrapped/proxied by the daemon. Open: evaluate (a) vs wrapper at build time.

---

## 8. Web control panel (standalone, locked)

`http://127.0.0.1:3090` — static HTML/JS served by the daemon, **no build step**, loopback-only. A standalone page is a
first-class requirement (not an embedded DSH card; a DSH client-plugin card may come later as an extra surface).

Three pages (locked split — ownership config is NOT on the control panel):

- **Control panel (status only):** status-type content from Sylvia — live netstate (wifi/cell/none, metered, SSID,
  WAN IP), netgate status (harness held? managed traffic held?), paused-work count, module status summary (up/down
  per module), daemon health, manual pause/resume.
- **Resource config page:** **all ownership/permission configuration lives here** (locked) — searchable
  networks/hosts/resources table (owner, type, permission, last-seen, dwell time, sightings, identity confidence);
  inline edit of owner + gate; **“label this network/device as mine / as \<person\>”**; per-type rules
  (“image generation → ask”); prune-now and prune settings.
- **Modules page:** local module management (§9) — per-module status, on/off toggles, **“open frontend”** button
  (new browser tab) when the module declares a frontend URL, behavior-mode selector, settings panel rendered from the
  module's declared config protocol, backup-now.

---

## 9. Local module system (formalized local webservers)

Sylvia's extra local services — SillyTavern, the mDNS responder, custom webservers, mitmproxy UI — are formalized as
**modules**. This grows the original “structured `services.json` tracks webservers” idea into a real protocol: every
module exposes the same generic actions, presents its settings through the same config protocol, and declares one of
the same behavior modes. Managed by the daemon's module manager; surfaced on the modules page (§8).

### 9.1 Layout (`~/.sylvia/modules/<id>/`)

```
module.json            # identity, behavior, frontend, settings schema, backup config, script paths
scripts/
  status.sh            # exit 0 = up; stdout = optional status JSON
  on.sh / off.sh       # start/stop — launch service in its OWN process group (netgate SIGSTOP, §2.3)
  backup.sh            # optional; default implementation = rclone (config names what → where)
  settings-edit.sh     # optional; apply a settings patch to the service's own config file(s)
```

Scripts are plain shell (or anything executable); `module.json` declares which exist — a missing optional script just
removes that action from the UI/API.

### 9.2 Module config protocol (`module.json`)

```jsonc
{ "id": "sillytavern", "name": "SillyTavern",
  "behavior": "always",                      // always | manual | tasker  (§9.4)
  "frontend": "http://127.0.0.1:8000",       // optional → "open frontend" button
  "settingsSchema": [                        // standardized inputs → daemon renders the settings panel
    { "key": "port",      "type": "port",     "label": "Port",           "default": 8000 },
    { "key": "bind",      "type": "ip",       "label": "Bind IP",        "default": "127.0.0.1" },
    { "key": "whitelist", "type": "ip-list",  "label": "Whitelisted IPs" },
    { "key": "enableApi", "type": "bool",     "label": "Expose API",     "default": false },
    { "key": "theme",     "type": "enum",     "label": "Theme", "options": ["dark", "light"] }
  ],
  "backup": { "enabled": true,
              "remote": "gdrive:sylvia/backups/sillytavern",     // which cloud remote
              "paths": ["~/SillyTavern/data", "~/SillyTavern/config"] },   // which files
  "scripts": { "status": "scripts/status.sh", "on": "scripts/on.sh", "off": "scripts/off.sh",
               "backup": "scripts/backup.sh", "settingsEdit": "scripts/settings-edit.sh" } }
```

Standard input types — `port`, `ip`, `ip-list`, `path`, `bool`, `enum`, `string`, `number` — keep every module's
settings panel uniform. The schema IS the panel: the daemon renders inputs generically and passes edits back through
`settings-edit.sh` (argv or stdin JSON), so modules never ship their own UI.

### 9.3 Generic actions (same for every module)

`status` · `on` · `off` · `backup` (cloud via rclone `--json`; `module.json` names source paths + destination remote)
· `open-frontend` · `apply-settings` (panel edit → settings-edit script). All script-driven; the daemon only provides
the uniform wrapper (lifecycle, process groups, logging, error reporting).

### 9.4 Behavior modes (locked, selectable per module)

- **`always`** — run all the time: auto-start with the daemon, auto-restart on death; **netgate SIGSTOP/CONT applies**
  on metered/offline (these are the “managed traffic” of §2.3).
- **`manual`** — runs only when toggled on; last state persists across daemon restarts.
- **`tasker`** — lifecycle delegated to Tasker: the module ships a Tasker XML that Sylvia installs via
  `tasker_write_and_reload` (existing sylvia-mcp tool), and Tasker profiles own start/stop (e.g. “when WiFi connected
  to HomeNet, start SillyTavern”).

### 9.5 Integration points

- Managed-traffic gating (§2.3) = “modules with behavior `always`” (each `on.sh` uses `setsid` → own pgid).
- Status feeds the control-panel summary (§8); backups reuse the rclone tooling (`rclone_exec`, forced `--json`).
- Modules can be *resources* too: a module that exposes an API can register itself in the resource registry (§4) with
  a type, getting policy enforcement for free.

---

## 10. Future expansion — agent resources & external subagents

*Recorded now, built later. Enables: dispatching work to a desktop PC while the phone is about to drop onto cellular.*

- **Agent resource type** (`type:"agent"`): a remote DSH instance as a registry entry — reference:
  `github.com/sorsama/deepseek-harness-mobile` (similarly named to ours; that one is a *remote* DSH).
- **`external_subagent(resource_id, task, constraints?)` tool** (sylvia-mcp): dispatch a work request to an agent
  resource. The daemon knows **which network the agent resource lives on**, so the tool automatically attaches
  propagation constraints to the request — e.g. *“do not use the image-generation MCP on your network during this
  request”* — derived from the receiving network's type rules + our policy config.
- **Reachability caveat (open):** if the phone is *on cellular*, the home LAN isn't directly reachable — off-LAN
  dispatch needs a tunnel/relay (WireGuard/Tailscale or an internet-exposed endpoint). Design the tool transport with a
  pluggable path (LAN-direct vs tunnel) so this slots in later.
- Benefits: work offload when local data/latency is scarce; permission context travels *with* the work request;
  the registry already models the target's network/owner for policy.

---

## 11. Security posture

- All listeners loopback-only (`127.0.0.1`), never `0.0.0.0` — same posture as DSH web.
- Daemon :3090 uses loopback trust (host+Origin); bearer token only if ever exposed beyond loopback.
- Fail closed on uncertainty (§2.1). Never persist arbitrary public IPs (§4).
- ADB operations reuse the resilient drop/reconnect path; watcher runs under wake-lock + doze whitelist.

## 12. Data persistence

`~/.sylvia/` — JSON only, human-inspectable, daemon is the single writer:
`netstate.json`, `networks/`, `hosts/`, `resources/`, `policy.json`, `netgate.json`, `prune-config.json`,
`modules/` (per-module `module.json` + scripts, §9).
Rationale: structured JSON over a DB (matches the existing state-management approach; DSH file tools can read it).

---

## 13. Build order

1. **Daemon skeleton + detection** — Tier0/1 netstate, netgate SIGSTOP/CONT, control API, `network_state` +
   `traffic_gate` MCP tools. **[DONE — code + tests]** `sylvia-daemon/` (netdetect, netgate, statemgr, api,
   watcher) + `sylvia-mcp/{src/daemon.js, network_state, traffic_gate}`. 45 daemon + 11 mcp tests green;
   fail-closed + resume-off verified. *Pending emulator check:* toggle via `svc data`, watch parser + Logcat.
2. **Resource registry + policy + pruning** — schemas, ownership, visibility filter, prune pass; seed with home
   network + personal devices. **[DONE — code + tests]** `sylvia-daemon/src/{policy,registry}.js` +
   registry/policy API routes + prune timer in index.js. 62 daemon tests green (+17: policy strictest-wins /
   offline-axis, registry retention / identity ladder / prune). *Pending emulator check:* seed home network +
   devices via `POST /api/registry/*/sighting` against a live scan.
3. **Bridge plugin v1** — turn hold/cancel, offline-gap + paused-work notices (`resumeOnReconnect:false`,
   `notifyPausedWork:true`). **[DONE — code + tests]** `sylvia-bridge/` (lib/core.js pure gate state machine,
   lib/sample.js daemon+state-file sourcing, lib/index.js cordis adapter, cordis.patch.yml template).
   23 tests green: finish-stream/immediate cancel semantics, new-work-while-held, inject-vs-followup notice,
   onUnknown allow/pause, offline hold, untrack. *Pending harness check:* mount in profile, confirm
   `agent/assistant-stream` event shape + `agent.cancel({kind:'hook'},{keepInbox:true})` live.
4. **Interception Path A** — MCP-tool enrichment via daemon `resolve`. **[DONE — code + tests]**
   daemon `registry.resolve(ip|hostname|name)` (policy-gated, hidden ABSENT, `__gate` on survivors) +
   `POST /api/registry/resolve`; sylvia-mcp tools `resource_list` / `resource_resolve` / `resource_call`
   (hidden refuse; ask → chat-approval then `confirmedByUser=true`; http+adb transports dispatched,
   mcp-stdio/custom not yet); `resilient_adb_exec` appends best-effort `networkContext` when a command
   mentions IPs (≤5, skips loopback/broadcast). 63 daemon + 11 mcp tests green.
   *Pending emulator check:* live daemon resolve against seeded registry.
5. **Web control panel + resource config pages** (standalone :3090; locked page split, §8). [DONE — code + tests] Static handler (`web.js`, traversal-guarded, zero-dep) wired into `api.js` for all non-`/api` paths; three pages: `index.html` (status only), `resources.html` (all ownership config + policy editor), `modules.html` (renders from `/api/modules`, graceful placeholder until module manager registers). 65/65 daemon tests (2 web tests: resolveWebFile traversal/extension rules, handler 200/404/405/HEAD). Live smoke: `/`, `/resources.html`, `/modules.html`, `/app.css` → 200; `/api/health` → JSON; `/nope.css` → 404.
6. **Module manager** — `module.json` protocol, action scripts, daemon execution, modules page (§9); migrate
   SillyTavern + mDNS onto it as the first two modules. [DONE — code + tests] `modules.js` ModuleManager: validateManifest, discover (invalid→errors not throw; missingScripts per module), start (detached own pgid; always→netgate.register; persist lastDesired), stop (SIGCONT first, off.sh, SIGCONT+SIGTERM belt-and-braces), status (script up + pid alive), applySettings (schema validate → persist → settings.env → settings-edit.sh JSON on stdin), backup (script or default `rclone sync <paths> <remote> --json`), autoStart (always + manual with lastDesired=on; tasker skipped), checkRestarts (30s). API: GET/POST `/api/modules[/<id>][/status|on|off|backup|settings]`. 14/14 module tests, full daemon suite 79/79. Win32 portability: `_scriptCommand` wraps `sh <script>` on win32 (production Termux runs direct shebang). Windows-only known issue: `execFile` `input` (settings-edit stdin) does not EOF on win32 — production/POSIX unaffected; deferred to emulator verification. Reference modules: `modules/sillytavern/` (manual; port/bind/whitelist/enableApi/theme; backup → gdrive) + `modules/mdns/` (always; avahi/mdnsd via setsid, netgate-gated). Both manifests VALID, scripts sh-clean, discovered + status-ran live. Pending emulator: settings-edit stdin + real avahi/SillyTavern start.
7. **Discovery** (nmap through daemon) + **Interception Path B + ask-dialogues**. [Discovery + ask DONE — code + tests; Path B injection trigger PENDING harness] `discover.js`: `deriveCidr`, `parseNmapXml`/`parseNmapPing`, `validTarget` (CIDR/IPv4 only, no shell passthrough), `createDiscoverer.scan` refuses metered/offline/disabled, runs `nmap -sn <cidr> -oX -`, ingests hosts via `hostKey` (mac→confirmed, ip|network→provisional), returns policy-filtered `visible`. Config: `SYLVIA_DISCOVER_ENABLED/SCAN_CIDR/SCAN_TIMEOUT_MS`. API `POST /api/discover/scan` (409 for refusal). mcp `discovery_scan` tool (9th tool; handshake updated). Ask-gate = fork A/A already in `resource_call` (refuses `__gate==='ask'` until `confirmedByUser:true`). 91 daemon + 11 mcp tests green. **Path B (bridge advisory injection) PENDING:** searched dsh-agent + dsh-tools types — NO clean `tool/call` event exists (agent exposes only created/disposed/status/session-start/pre-step/request/request-error/assistant-stream/turn-stopping/error); tool calls surface only inside `agent/assistant-stream` frames (racy). Path A (tool-side enrichment) is the robust primary and already covers IP→registry context; Path B's exact observation point must be confirmed against the live harness before wiring (same bucket as other pending-emulator checks). Do NOT ship a guessed hook.
8. Installer/README integration for all of the above. [DONE — code + tests] `install.sh` (765 lines, `bash -n` clean): header rewritten for 10-step flow (+ `SYLVIA_DAEMON_PORT`); base packages += `nmap`; `module_sylvia_daemon` + `module_sylvia_bridge` (local-first, else clone from `SYLVIA_REPO_URL`); `_cordis_append_plugin` id-guarded helper writes `- insert:` YAML shape matching `dsh-session-surgeon/cordis.patch.yml`; sylvia-mcp cordis env block += `SYLVIA_DAEMON_URL` + `SYLVIA_NETSTATE_FILE`; sylvia-mcp stdio probe now asserts all 9 tools; `_register_sylvia_bridge` symlinks into profile `node_modules` then appends the cordis entry; `sylvia.env` += `SYLVIA_DAEMON_PORT` + `SYLVIA_STATE_DIR`; `start-sylvia.sh` best-effort starts daemon before exec'ing DSH web; `print_summary` shows all 9 tools + control-panel URL. `README.md` rewritten (full 10-section doc: apps table, one-line install, 9-tool table, control panel, modules, troubleshooting). Both suites green: mcp 11/11, daemon 91/91.

  *Emulator bring-up fixes (same step, after first live run):* **(a) dpkg conffile prompts** — added `--force-confnew` flag; when set, base-packages `pkg install` carries `-o Dpkg::Options::=--force-confnew` (auto-answers "Y"=take maintainer's version to `openssl.cnf`/`sources.list`/`bashrc`/`profile`). README one-liner uses it by default + warning to drop it if those files are customized. **(b) koffi native addon** — always fails on Termux (loader keys off `process.platform`="linux"≠"android", grabs glibc `.node`, can't `dlopen` on bionic, falls back to a CMake source build; CMake absent). **(c) arborist crash `Cannot read properties of null (reading 'children')`** — root cause was redundancy: `module_dsh_cli` pre-installed `@deepseek-ai/dsh@latest`(`0.2.0-rc.2`), but the fork patcher pins `@deepseek-ai/dsh@0.1.0-rc.6`+12 local tarballs and reconciles over the half-built `--ignore-scripts` tree, tripping npm 11 arborist. **Fix (architectural):** `module_dsh_cli` now DEFERS to the patcher by default (`SYLVIA_WITH_DSH_PATCH=1`); standalone upstream-DSH path (koffi `--ignore-scripts` retry) only when patch is off. `module_dsh_patch` now (i) `npm uninstall -g` + `rm -rf` the global `@deepseek-ai` tree before the patcher (clean target = no reconcile-over-stale), (ii) runs the fork's `install/install.sh` under `npm_config_ignore_scripts=1` so its own `npm install -g` also skips the koffi build. Canary (`dsh-client-ui-layout@rc.7`) + `dsh --help` boot check keep it fail-fast + idempotent. `bash -n` clean. *(Later runs showed the arborist crash is intrinsic to npm's multi-spec install even on a clean tree — repro'd locally on npm 11 **and** 10 — so the final fix is per-package `npm install -g` with `--legacy-peer-deps` retried only for the package that needs it; see §14 decision row.)* **(d) mitmproxy source build** — PyPI ships no Android/bionic wheels for its native deps (`bcrypt`, `cryptography`, `cffi`, `zstandard`, `pylsqpack`, …), so `uv tool install mitmproxy` builds from source and died on `can't find Rust compiler`. Fix: `module_mitm_mcp` installs the missing build toolchain just-in-time (`rust binutils clang make pkg-config openssl`, each `have`-checked so pre-existing installs are reused), exports `CFLAGS="-Wno-incompatible-function-pointer-types"` (mandatory for `ruamel.yaml.clib`, termux-packages#16746), and dies with a manual-verification hint. One-time build, minutes; skipped entirely once `mitmdump` exists. **(e) package record** — install.sh appends only packages it actually added (base + toolchain, since it only ever installs missing ones) to `~/.sylvia/install-packages.txt`; `uninstall.sh --remove-packages` removes from that record (fallback: known lists), so pre-existing packages survive.
9. *(Future)* agent resources + `external_subagent` (§10).

## 14. Decision log

| Decision | Choice | Because |
|---|---|---|
| resume on reconnect | **false** (default) | no surprise metered usage; explicit release |
| notify paused work on wifi | **yes** (default) | agent must know work is held, not lost |
| harness gating | **config option** (`pause`/`allow`) | user may want agent alive on cellular while heavy traffic gated |
| two stops | in-process hold vs SIGSTOP split | graceful-vs-hard requirements conflict; must not freeze plugin/UI |
| IP enrichment | **Path A first** (tool-side) | correct interception point for command context; robust, no injection needed |
| web UI | **standalone loopback page** | important requirement; simpler, no build step |
| device identity | serial/MAC, or fingerprint+IP+net, or declaration | DHCP reassigns IPs — bare (IP, net) proves nothing |
| resource granularity | network → host → **typed resource** | one PC hosts many services; type enables class rules |
| access default | via sylvia-mcp; CLI is advisory-only | permissions enforceable only on the tool path |
| registry home | separate daemon :3090 | one writer/policy point for MCP + plugin + UI |
| page split | control panel = **status only**; ownership config = **resource page only** | one home for all ownership decisions; panel stays glanceable |
| local webservers | formalized **module system** (§9): config protocol + generic actions + behavior modes | modules self-describe settings (no per-module UI code); `always` modules are exactly netgate's managed traffic; Tasker mode reuses `tasker_write_and_reload` |
| patcher idempotency canary | **all-or-nothing** (CLI rc.6 + all 12 rc.7 packages), never a single package | a single-package canary misreported partial installs as "done", skipping both cleanup and install and stranding a broken tree with no repair path |
| installer footprint removal | separate **uninstall.sh** (opt-in `--remove-dsh` / `--remove-packages`, `--dry-run`) | dev/emulator iteration needs a clean slate; must never touch non-Sylvia DSH profiles or generic Termux packages by default |
| mitmproxy distribution | **per-device prebuilt wheelhouse** (`build-wheelhouse.sh` → tarball; installer `--find-links --no-index`), source build remains the universal fallback; wheelhouse also registers mitmproxy-mcp as a **persistent uv tool** instead of `uvx` | the source build is the slowest/most fragile step and PyPI has no Android wheels; native wheels are per-(arch, CPython ABI) so no universal binary exists — emulator is x86_64, phone is arm64, and a Termux python upgrade invalidates the ABI (hence manifest arch+python validation with silent fallback); persistent tool removes all first-launch dependency resolution |
| DSH CLI + rc.7 packages install | **one `npm install -g` per package** (replicate the fork's 13 specs ourselves), not the fork's single 13-package call | under npm 11 the one-big multi-spec command deterministically crashes arborist's ideal-tree builder (`Cannot read properties of null (reading 'children')`), even on a fresh tree; a single-spec-per-invocation install never enters that code path. Same 13 specs → identical result |
| patch home | **fork tarballs** for source fixes of the 12 shipped packages; **sylvia** for npm/install machinery; **upstream** for DSH bugs | the fork's product is its tarballs (repo carries no sources); sylvia alone performs npm installs (§14 arborist decision), so fork-installer code never runs under sylvia |

## 15. Open questions / verify in emulator

- `pre-step` `{kind:'reject'}` semantics (skip step vs end turn) — confirm against bundled types.
- `dumpsys` format drift → tolerant parser; cross-check in emulator Logcat (same session as Tasker-intent verification).
- Post-`SIGCONT` sockets dead → treat as retryable (handled by `agent/request-error` → `{kind:'retry'}`).
- nmap integration: daemon-native vs wrapped `nmap-mcpserver` (§7).
- Module scripts: sandbox/allowlist review for `on.sh`/`off.sh`/`settings-edit.sh` (arbitrary shell executed by the
  daemon — ship only reviewed modules, treat user-added ones as trusted-local).
- Device identity promotion thresholds (sightings/time for provisional → corroborated).
- Off-LAN reachability for §9 (tunnel choice) — deferred.

## 16. Fork migration plan (sylvia patches → Deepseek-harness-mobile)

Raised as a queued follow-up concern: move the *reasonable* fixes out of Sylvia's
installer and into `Ayrlin-Renata/Deepseek-harness-mobile` (local clone:
`owned_forks/Deepseek-harness-mobile`). Analysis done; execution awaits sign-off.

### 16.1 Ground truth

- The fork ships **only** `install/` = 12 built `deepseek-ai-dsh-*-0.1.0-rc.7.tgz`
  + a 79-line `install.sh` (single 13-spec `npm install -g` + version verifier).
  **No package sources, no build script** → any rebuild = unpack → edit → repack,
  and the repo should gain a build script + patch sources for reproducibility.
- Verified: the installed `attachment-local/lib/index.js` bytes are exactly the
  tarball's `package/lib/index.js` (md5 `7571b9b5…` on both) → rebuild path valid.
- Sylvia does **not** run the fork's installer (§14 arborist decision): module 4
  replicates the 13 specs one npm call each. Consequence: fixes moved into the
  fork's `install.sh` do **not** execute under Sylvia — they only serve
  standalone fork users. Fork-installer changes and sylvia's guards must coexist.

### 16.2 Classification — what is "reasonable" to move

| Sylvia-side fix | Patches | Home | Why |
|---|---|---|---|
| `maxImageDimension` (`_patch_attachment_local_image_dimension` + `patches/attachment-local-rc7-index.js`) | source of a **fork-shipped package** | **FORK tarball** | it is a modified version of the fork's own product; a tarball carries it atomically and npm-visibly; sylvia's hash-guard + repo copy then retire |
| client-modules rc.8 (`_align_client_modules_to_fe`) | fork ships rc.7 client-modules while npm resolves the frontend to rc.8+ | **FORK tarball (partial)** | fork should ship stock rc.8 client-modules — its only patch (`cache-control: no-cache`) is already upstream in rc.8. The dynamic align **stays in sylvia as a drift guard**: the frontend version moves whenever the registry does |
| nested rc.8 prune (`_prune_nested_fork_copies`) | npm resolution tree (CLI's nested `node_modules`) | **stays sylvia** (optional mirror) | not a tarball — npm machinery; sylvia is the layer that runs npm |
| `cordis-plugin-hmr@1.0.17` pin | npm transitive dep drift | **stays sylvia** (optional mirror) | same; upstream bug too (1.0.18 removed `registerConfig` while `dsh-app-boot` still calls it) |
| profile-boot HMR-settle (`_patch_profile_boot_hmr_settle`) | bundled chunk inside the npm-installed CLI — not one of the 12 | **stays sylvia** (optional mirror) | not a fork product file; content-hash-dependent; upstream race |
| cordis insert-shape migration, bridge dep symlinks, launchers/env, uv/mitm/patchelf, MCP registration | sylvia's own deployment config | **stays sylvia** | not DSH packages |

Upstream candidates (report; own neither layer): cordis-plugin-hmr 1.0.18 semver
break; profile-boot `watchUserPatches`-before-HMR-settle race; rc.8's cross-package
`imageLimits` projection contract (apiproxy validates a sibling package's output
with no version handshake).

### 16.3 Phases — independently shippable, device-verified between each

**Phase 1 — attachment-local tarball (highest value; verifiers unaffected)**
1. Unpack `install/deepseek-ai-dsh-attachment-local-0.1.0-rc.7.tgz`, replace
   `package/lib/index.js` with the repo's already-built patched file, repack,
   commit in the fork clone (branch `sylvia-sync`).
2. **Atomically** relax sylvia's helper: today it dies on unknown bytes — after the
   swap, fresh installs legitimately see new-tarball bytes. New order:
   `grep -q maxImageDimension` → skip (covers already-patched devices AND the new
   tarball); else hash == `7571b9b5…` → patch (old fork); else die. Land fork
   tarball + helper change together or a fresh device fails closed.
3. Device verify: reinstall the single tgz, run installer (expect the skip branch),
   restart, replay `POST /api/session.history` → `result.ok:true` with
   `imageLimits.maxImageDimension`. Version stays `0.1.0-rc.7` → fork verifier and
   sylvia's all-or-nothing canary (§14) both pass unchanged.

**Phase 2 — client-modules rc.8 tarball swap**
1. Replace the fork tarball with a stock rc.8 pack (known: fork's only patch is
   upstream there; re-confirm zero other diffs).
2. Fork `install.sh`: filename → `…-client-modules-0.1.0-rc.8.tgz`; verifier
   accepts `0.1.0-rc.8` **for that package only**.
3. Sylvia module-4 canary gets the same rc.8 exception; keep
   `_align_client_modules_to_fe` as the drift guard (no-op when matched).
4. Device verify: boot green, facade script tags in served HTML, history RPC.

**Phase 3 — optional mirror into the fork's installer (standalone-fork users)**
- Transplant prune + hmr-pin + profile-boot-settle into `install/install.sh` so
  fork-only users get a bootable harness (today they hit the same crashes Sylvia
  fixes). Sylvia keeps its own guarded copies — all are marker/content-guarded, so
  whichever runs first wins and the other no-ops; duplication is deliberate because
  sylvia must not depend on fork-installer execution (§14).
- Verify with a standalone fork install in a fresh emulator Termux.

**Phase 4 — upstream reports** (cordis-plugin-hmr, profile-boot race, imageLimits contract).

### 16.4 Cautions

- `owned_forks/` + `reference/` clones are dev-only (never shipped); changes stay local
  until pushed
  — publishing fork updates needs the user's GitHub auth.
- ~~Sylvia's tree has **uncommitted** changes~~ — resolved 2026-10-17: everything
  (README, install.sh, bridge/daemon fixes, `patches/`, `modules/`, `assets/`)
  committed and pushed to `Ayrlin-Renata/Sylvia` as `0e47bc3` + `b8f13b0`, so a
  clean-AVD `git clone`/curl install gets the current tree.

## 17. DSH 0.2.x upgrade assessment (2026-10-17, npm-verified)

All facts below were re-verified firsthand against the npm registry and the local
0.2.1-alpha.5 install (an earlier relay of unverified subagent claims contained
registry errors — this section supersedes it).

### 17.1 Version landscape (npm, 2026-10-17)

- `@deepseek-ai/dsh` dist-tags: `latest` = **0.2.0-rc.2**, `alpha` = **0.2.1-alpha.5**,
  `next` = **0.2.1-rc.2**. **No non-prerelease 0.2.x exists yet** — the "full release"
  the fork should target has not shipped.
- Mobile packages (`dsh-attachment-local`, `dsh-client-modules`, …) are published
  **in lockstep with every train version** (0.1.0-rc.2…rc.8, 0.2.0-rc.1/2,
  0.2.1-alpha.1…5, 0.2.1-rc.1/2) — but their `latest` dist-tag is parked at
  `0.0.1-rc.1`, so a plain `@latest` install gets an OLD line. Pin exact versions.
- **0.2.1-rc.2 exact-pins every `dsh-*` dependency (no carets)** — the transitive
  caret drift that produced the rc.8-era skew (facade/imageLimits bugs) disappears
  on that train. Only cordis-ecosystem deps stay ranged (`~4.0.5`, `~1.0.10`, …).
- Third-party (NOT official, NOT ours): npm has `dsh-mobile` (saya-ch) and
  `dsh-mobile-plugin` (wnluo, self-described "0.2.0-rc.2 compatible") — distinct
  from the Ayrlin-Renata fork.

### 17.2 Fork patch inventory vs 0.2.1-rc.2 (grep-verified via `npm pack`)

| Fork patch (12 rc.7 tarballs) | Status in 0.2.1-rc.2 | Upgrade action |
|---|---|---|
| `maxImageDimension` (sylvia's, Phase 1) | **upstream** (3 hits) | retire |
| lazy sharp — `resolveSharp` / `IMAGE_PROCESSING_UNAVAILABLE` | **absent** (0 hits) | **re-apply in fork rebuild** |
| FUSE fallback — `isHardLinkUnsupported` / `COPYFILE_EXCL` | **absent** (0 hits) | **re-apply** |
| client-modules `cache-control: no-cache` | **absent** — stock `max-age=31536000` is back | **re-apply** (dev-staleness protection) |
| client-modules `__ModuleLoader__` facade | present (8 hits) | nothing to do |

Conclusion: the fork is **not** obsolete — three Android-critical patches never
landed upstream and must survive any rebuild. (An earlier note claiming these were
"already upstreamed" was **wrong**.)

### 17.3 Sylvia seam audit on 0.2.1 (all verified)

- **Stable:** `webServer.tapIndex` (CSS seam) ✓; `dsh-mcp-client` stdio config
  (`serverName` etc.) ✓ — now exact-pinned to the harness version;
  `agent.followup/inject/cancel` contract ✓ — **moved** to `dsh-agent-loop` +
  `dsh-api-session-controller` (live proof: `@gorban/dsh-job-stop`, in our PC
  profile, uses `followup` at `src/index.ts:312` and runs on 0.2.1);
  `cordis.patch.yml` + profile-`package.json` plugin model ✓ (PC profile intact);
  community plugins load ✓.
- **Retire on upgrade:** the `cordis-plugin-hmr@1.0.17` pin — the package was
  replaced by `@deepseek-ai/dsh-hmr` (exact-pinned); `registerConfig` and
  `watchUserPatches` exist in **no** 0.2.1 package → the profile-boot fiber-settle
  patch (`/* sylvia:await-hmr-settle */`) has nothing to patch and dies with its
  marker-guard (harmless no-op). Boot chunk name for alpha.5:
  `profile-boot-C14i-8IN.js` (content-hashed — the installer's content-marker
  selection adapts automatically).
- **Re-verify per release:** HMR/user-patch behavior, the rc.8-prune logic (exact
  pins should make it a no-op), and `dsh-client-modules`↔frontend alignment (stays
  as a drift guard).

### 17.4 Recommendation

1. **Do not chase alpha.** Wait until a non-prerelease 0.2.x becomes `latest`
   (as of this writing only `0.2.0-rc.2` / `0.2.1-rc.2` exist).
2. On release: **one fork rebuild cycle** — rebuild the 12 tarballs at the exact
   release version, re-applying the three surviving patches (§17.2; drop the
   maxImageDimension one), bump the fork `install.sh` pins (rc.6 → release), and
   add sources + a build script to the fork (§16) so the next port is one commit.
3. Re-run sylvia's `install.sh` against it: prune/hmr-pin/settle self-retire via
   their guards, cm-align stays as a drift guard, the module system / termux:boot /
   launchers / MCP registration are version-agnostic and untouched.
4. Upstream reports still worth filing (§16.3 Phase 4), adjusted: hmr pin is
   obsolete as a report (package replaced); the `latest`-tag-parked-at-`0.0.1-rc.1`
   oddity and the immutable-cache default are worth noting upstream.

## 17.5 Upgrade plan — AVD fork → 0.2.1-alpha.5 (two-subagent research, 2026-10-17)

Answers: "feasibility of bringing the fork (the mobile plugin that runs DSH on
the AVD) up to the PC harness version." Two read-only subagents delivered a
full 12-package fork-delta matrix and a seam audit of the alpha.5 train; both
reports are folded in below. **Verdict: FEASIBLE, medium effort, gated on one
fork rebuild.** (Registry at time of writing: `latest=0.2.0-rc.2`,
`alpha=0.2.1-alpha.5`, `next=0.2.1-rc.2` — there is still no non-prerelease
0.2.1; the PC runs the `alpha` tag, so that is the parity target.)

### 17.5.1 Seam audit — Sylvia contracts on 0.2.1-alpha.5 (ALL GREEN)

`tapIndex` (disposer, `dsh-host-webserver`), MCP stdio schema + `serverName`
regex + `mcp__<server>__<name>`, `createUserMessage` (dsh-llm), `agents`
service (`status|inject|followup|cancel` in `dsh-agent`), `- insert:` rows
(`cordis-plugin-include@~1.0.10-alpha.2` still silently skips bare `- id:` —
and the live PC profile proves an insert row works), `maxImageDimension`
projection (now in `dsh-api-session-controller` — **`dsh-host-apiproxy` was
renamed**; no sylvia source imports it), no `engines` field (Termux node 24.18
unblocked). Retires: `cordis-plugin-hmr`/`registerConfig`/`watchUserPatches`
exist nowhere — HMR is now `@deepseek-ai/dsh-hmr` as a loader entry — so the
1.0.17 pin and the profile-boot settle patch both retire. `dsh-web-frontend`
and `dsh-client-modules` exist at alpha.5 (cm-align helper inputs safe).

### 17.5.2 Fork delta matrix (12/12 diffed: fork vs stock rc.7 vs alpha.5)

Cross-cutting pattern (port once): **fork moves native addons to
`optionalDependencies`** — sharp (attachment-local), koffi (fs-local,
host-directory-picker-native, session-persistence-jsonl), windows-acl
(sandbox-local), node-pty (subprocess-local). alpha.5 has NONE of these
(hard deps remain) — still required for Termux installs. Upstream alpha.5
adopted *lazy loading* for sharp/node-pty via `createLazyRequire` — so those
fork halves retire; the manifest halves do not.

| # | package | verdict | port action |
|---|---------|---------|-------------|
| 1 | attachment-local | MANUAL (M) | keep `isHardLinkUnsupported`→`copyFile(COPYFILE_EXCL)` + optional sharp; DROP lazy-sharp (upstream `createLazyRequire`) |
| 2 | client-modules | ALREADY-UPSTREAM | nothing (immutable cache identical) |
| 3 | client-ui-directory-picker-browse | TRANSPLANT (L) | mobile browse UI + retry/breadcrumbs onto rewritten client.js |
| 4 | client-ui-layout | RETIRED (2026-10-19) | `MobileFrame` removed from the fork (commit f9e702a): its css-module map never gained the mobile class keys (unclassed/unstyled mobile UI) and UI concerns now belong to `sylvia-bridge` — package ships stock with absent-markers proving the removal |
| 5 | fs-local | CLEAN (S) | hardlink→copyFile in `writeFileAtomic` + optional koffi |
| 6 | host-directory-picker-browse | CLEAN (M) | `listTimeoutMs` deadline (alpha.5 lib byte-identical to rc.7 — direct transplant, 148 lines) |
| 7 | host-directory-picker-native | CLEAN (S) | manifest only (optional koffi) |
| 8 | sandbox | CLEAN (S) | `SandboxUnavailableError(mode, detail, platform)` + Android message |
| 9 | sandbox-local | CLEAN (S) | optional windows-acl + pass platform (same call site, line 492) |
| 10 | session-persistence-jsonl | CLEAN (S) | `link()`→rename fallback (alpha.5 still bare `await link(...)`) |
| 11 | subprocess-local | MANUAL (M) | keep android→LinuxProcessInspector (now `runner-launch-B2zsQ1Dz.js:669`) + `ensure-spawn-helper.mjs` guard; DROP lazy-pty |
| 12 | terminal-bash | MANUAL (M) | `resolveShellPath`→`$PREFIX/bin/bash` on android, re-expressed in alpha.5's new `resolveConfig`/`apply` flow; PROMPT hunk clean |

Effort: 6 easy patches + 4 small merges + 2 UI transplants. Registry quirk:
`dsh-workflow-worker-thread` has NO 0.2.1 line (own train: `alpha=0.1.5-alpha.2`)
— if the alpha.5 standard preset still references it, pin that train instead
of failing; the ambient sweep will surface it if so.

### 17.5.3 Phased plan

- **Phase A — fork rebuild (gates everything).** Add `build/` to the fork:
  patch sources + a script (unpack stock@target → apply patches → repack →
  12 tarballs), per §16's reproducibility rule. Target `0.2.1-alpha.5`;
  manifests re-pin to `0.2.1-alpha.5` (ignore the fork's stale `^rc.5` pins).
  Sub-phases: **A1** = S/M patches + optionalDependencies pattern (6+4 pkgs);
  **A2** = the two UI transplants (mobile shell). A1 alone boots 0.2.1 on
  Termux with a desktop-ish layout; A2 restores the phone experience — land
  A1→AVD-boot, then A2→visual check.
- **Phase B — sylvia install.sh re-target** (42 rc-era refs mapped): delete
  the hmr-pin block and the profile-boot settle block; relax the attachment
  hash-guard to a *feature* check (`maxImageDimension` present → ok, baseline
  hash → patch, else die) or make it verify-only; bump the "CLI rc.6 + 12
  rc.7" canary/version checks (ui-layout canary at line 465) to alpha.5;
  prune/cm-align/ambient-sweep stay as guards (expected no-ops). README §2/§11
  wording updates (hmr/settle rows retire).
- **Phase C — AVD acceptance battery**: fresh install → boot green →
  workspace select (`session.create` preset mount) → CSS seam → network flip
  cycle → mcp tools (adb bootstrap, rclone, tasker guard) → 9router lifecycle
  → **mobile layout visual check** (settings dialog fits = the original
  MobileFrame purpose) → termux:boot seed.

Risks: alpha churn (pinned exact — stable), native-optional install behavior
on Termux needs one live npm run to confirm, transplants are the only
L-effort/regression surface, workflow-worker-thread version line (17.5.2).

**STATUS (2026-10-18): Phases A and B are complete.** Fork at `2c4f149`
(identity-corrected force-push: author/committer = Ayrlin Renata) — 11
byte-reproducible tarballs, the `build/` pipeline committed. Sylvia installer
re-targeted: the hmr-pin and profile-boot-settle blocks are tombstoned (their
anchors no longer exist on this train — the settle search would have died on
every fresh install), `dsh_siblings` dropped client-modules, the canary now
compares against `SYLVIA_DSH_TARGET_VER` (default `0.2.1-alpha.5`) so any
previous train forces repair, stale fork clones are auto-recloned, the fork's
pinned tarball version is cross-checked against the target (die on skew), the
attachment helper verifies `maxImageDimension` instead of patching (legacy
repair path retained), and cm-align understands the nested exact-pinned shape.
Phase C is deferred to a user-driven full AVD wipe to prove the clean
install end-to-end.

### 17.5.4 Native binding gap — `node-addon-require-builtin` (found in that wipe test)

The clean install booted into `host preparation failed: No usable native
binding found for node-addon-require-builtin-android-x64 (auto)`. Facts:
DSH 0.2.x hard-requires this addon to load Node's internal modules;
upstream publishes platform packages for linux (gnu/musl × x64/arm64),
darwin, and win32 — **no android variant exists (registry 404)** — and the
main package ships neither source nor a postinstall (`files: [README, lib]`),
so the loader's three strategies (optional-package / local-build nodeabi /
local-build napi) all miss on Termux no matter how npm was invoked. Same
class as sharp/koffi/node-pty: glibc-platform assumptions upstream.

Fix (matches the "host built artifacts in the repo" direction): the addon's
own repo has the C++ source (`packages/native/binding.gyp`), and a Termux
build succeeds (clang + `$PREFIX` headers + bundled node-gyp,
`GYP_DEFINES="narb_product=require-builtin"`, NAPI backend → 93 KB
`require_builtin.node`, NAPI v9 = ABI-stable across Node versions). The
binary is committed to this repo at `native/android-x64/napi-v9/` and
`module_native_binding` (installer, right after `module_dsh_patch`) fetches
it — **dlopen AND functional verified** (runs the exact
`requireBuiltin("internal/modules/esm/loader")` call app-boot makes) — with
an on-device source-build fallback (auto-installing make/clang) and a loud
die otherwise; arm64 artifact pending the first phone run (its build log is
`~/.sylvia/native-build/build.log`, contribution recipe in `native/README.md`).
Adding the missing `-android-*` platform packages upstream is a report
candidate alongside §16.3 Phase 4. Note the ambient sweep cannot catch this
class: the addon only loads inside `boot()`, not at package import time.

## 18. AVD acceptance findings — on-device agent test pass (2026-10-17)

An agent running INSIDE the AVD harness executed a structured test pass; its
report drove six defect fixes, all verified live and covered by tests
(dsh-mcp 12/12, dsh-daemon 99/99 at the time of writing).

1. **Tier-0 netlink denial (the headline).** From the Termux uid (SELinux
   `runas_app`), `ip route get` fails with `Cannot bind netlink socket:
   Permission denied` — previously collapsed into "unreachable" → transport
   `none` → netgate held `offline` since boot, permanently inert. Now
   `parseIpRoute` returns a third verdict, `denied`, and `detect()` falls
   through: retry the identical query as adbd's identity (`tier0-adb`), then
   Android's own `dumpsys connectivity` type (`tier1-connectivity`), and only
   then fail closed with `source: "tier0-denied"`. Live: `wifi/wlan0
   validated via tier0-adb+connectivity`; `svc wifi disable` flips the verdict
   within one 20s poll and recovery re-flips it back.
2. **Frozen `/api/network`.** The watcher only replaced `lastState` on
   transport/metered transitions, so `at` stayed at boot time while
   `netstate.json` was fresh. `lastState` now refreshes every tick (change
   detection still drives the log lines). Verified across a poll interval.
3. **adb cannot bootstrap from this uid.** When the client auto-start fails
   with `ADB server didn't ACK / cannot open /tmp/adb.<uid>.log` (root `/tmp`
   is shell-owned), both `AdbManager.devices()` (sylvia-mcp) and
   `netdetect.adbRun` (daemon) now detect the signature, spawn
   `adb -L tcp:5037 nodaemon server start` detached (logs to stderr, skips
   `/tmp`), and retry once. Definitive on-device result (agent re-test R5,
   same Termux uid): plain `adb devices` STILL fails persistently with
   `cannot open /tmp/adb.10217.log: Permission denied → ADB server didn't
   ACK → failed to start daemon` — the failure is the everyday path, not a
   transient — while `resilient_adb_exec` self-recovers in the same window
   (`adb server cannot auto-start … nodaemon fallback` / `adb server up`
   in boot28.log, server parented to the sylvia-mcp node). An earlier
   "cold auto-start works" reading was a pgrep-undercount artifact. The full
   `resolveAndConnect → exec` chain was also verified.
4. **Tasker false-success.** `am broadcast` exits 0 with zero receivers, so a
   Tasker-less device reported success. `tasker_write_and_reload` now runs
   `pm path <package>` first: absent + `reload` → structured refusal before
   any write; absent + `reload:false` → staged file with an honest warning and
   `taskerPresent:false`. Package name is `SYLVIA_TASKER_PACKAGE`.
5. **mdns restart storm.** `behavior:"always"` + instant `on.sh` failure
   respawned 356× in 105 minutes, `lastError` never set (nobody waited on the
   detached child). Now `start()` attaches an `exit` listener (captures the
   code) and stamps `exitedAt` — the REAL death time, because checkRestarts
   only observes 30s later. Deaths <10s after start count as a crash streak:
   first death restarts immediately, then exponential backoff (base 60s,
   cap 15min) with `lastError` surfacing in `/api/modules`. A death after a
   healthy 30s stretch resets the streak. Live log: `died (exit 1) ~0s` →
   `backing off 60s` → `backoff expired` → `backing off 120s`.
6. **`rclone_exec version` rejected `--json`.** `version`/`help` are excluded
   by command name (first bare word), plus a self-healing rerun-without-`--json`
   on `unknown flag: --json`. Live: exit 0.

Policy note (unchanged, confirmed intentional): `resumeOnReconnect` stays
locked `false` — release is explicit (§2.1). With truthful detection, a hold
now engages on real metered/none and requires a control-panel resume; on this
emulator wifi-off lands on ethernet (`other`, unmetered by §2 inference), so
the gate staying open is correct for the AVD but will HOLD on a phone's
cellular fallback.

### 18.1 Acceptance re-run (on-device agent, all PASS)

The internal agent re-verified every fix against the live harness (no restart
needed — boot28 already ran the fixed code): R1 `rclone version` exit 0; R2
Tasker refusal with `/sdcard/Tasker/` confirmed unwritten; R3 `/api/network`
`wifi` with `at` advancing exactly per 20s tick; R4 wifi-off verdict in 21.7s
(`other`/eth0 — emulator NAT persists, Termux ping fails), wifi-on back in
17.8s; R5 the adb `/tmp` failure + tool self-recovery quoted above; R6 mdns
backoff escalating `60s → 120s → 240s → 480s → 900s (cap, ×3)` with
`lastError: "died ~0s after start (exit 1) — death streak 8"`.

Two live observations worth keeping: (a) **the fail-closed gate caught the
tester** — killing adb servers for R5 drove `none METERED via tier0-denied` →
netgate HOLD → sylvia-bridge parked an in-flight task for the flap duration
(working as designed, not a defect); and (b) minor quirk: tier-1 dumpsys can
report `validated:true` for a moment while Termux-uid ping already fails —
harmless because transport (`other`, not `wifi`) is the field the gate uses.
After acceptance, the sticky test-artifact hold (21:27, by locked policy) was
released through the designed explicit path `POST /api/netgate/resume`.
Pre-existing, unrelated: `settings get global wifi_on` throws
`INTERACT_ACROSS_USERS` from the Termux uid (shell uid required).

## 19. Shell transport ladder — Shizuku first, adb as fallback (design 2026-10-18)

User decision: Shizuku is **recommended, never required** — the installer must
not refuse without it; the adb loopback stays as a working fallback that gets
torn down when Shizuku revives. Docs will note the fallback is the
less-maintained leg and may be retired someday. Recommended build:
**thejaustin/ShizukuPlus** (a very active fork-of-theDJchi/Shizuku — pushed
same-day, 1.4k stars; theDJchi's own build is maintenance-paused).

### 19.1 The ladder (probe → kickstart → fallback → teardown)

1. **Probe** — `rish -c id` with a hard 6s cap (loader binder timeout is ~5s;
   rish timeouts exit 124). Alive ⇒ transport = `shizuku`.
2. **Kickstart attempts** (Shizuku down), in order — all headless, no shell
   needed yet:
   a. **Token broadcast** (ShizukuPlus): `am broadcast -a af.shizuku.plus.api.START
      --es auth <token>` (drop-in builds use `moe.shizuku.privileged.api.START`).
      The token is a ONE-TIME SETUP artifact (`SYLVIA_SHIZUKU_AUTH_TOKEN`,
      cached when the user pairs; invalid tokens raise a notification, so the
      token must be exact — constant-time compare in the receiver).
   b. **Tasker task** (`Sylvia Shizuku Start` over Tasker HTTP :1821, when
      Tasker is present): the ShizukuPlus first-party Locale/Tasker plugin
      action (`com.twofortyfouram.locale.intent.action.FIRE_SETTING`) or an
      intent task; for STOCK Shizuku this is the only automatable path besides
      UI-launch.
   c. **UI-launch fallback** — `am start` the app's start activity
      (`StarterActivity`/`.MainActivity`): may need one user tap; report state
      honestly rather than pretending success.
3. **ADB fallback up** (tier-2 failed) — existing machinery: nodaemon server
   bootstrap + loopback connect. **While the fallback is up**, run the one
   *definitive* headless kickstart through it:
   `adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh --apk=<sourceDir>`
   (research verdict: this — or root — is the only start path that works with
   ZERO taps when pairing still holds).
4. **Teardown** — while on the fallback, re-probe Shizuku each ladder pass;
   when alive again: `adb kill-server` (in-device), drop the loopback, update
   state. Fallback is never left running alongside a healthy Shizuku.

### 19.2 Ownership, state, knobs

- The **daemon** owns the ladder: `POST /api/transport/ensure` (probe + ladder
  pass + returns the active channel) and `~/.sylvia/transport.json`
  `{kind: shizuku|adb, tier, since, lastProbe}` for observability. Rationale:
  Tasker's HTTP API is reachable from the daemon without any shell, and
  Termux can fire exported intents as its own uid — tier-2 needs neither the
  shell nor the MCP layer.
- **sylvia-mcp** tools ask the daemon first; if the daemon is unreachable they
  degrade to today's local adb bootstrap (already built + tested).
- **Detection** (netdetect): transport=shizuku ⇒ tier-0 `ip route get` runs as
  shell uid directly (the netlink-denied chain and auto-serial machinery
  become fallback-only — shell uid binds netlink natively, and there is no
  serial/server concept at all); tier-1 dumpsys likewise via rish.
- Env: `SYLVIA_SHIZUKU_AUTH_TOKEN`, `SYLVIA_SHIZUKU_RISH` (path to the exported
  rish script), `SYLVIA_SHIZUKU_KICKSTART_TASK` (Tasker task name).
- Setup (README, once): install ShizukuPlus → pair wireless debugging → start →
  export rish (`RISH_APPLICATION_ID=com.termux`) → cache the START auth token →
  grant permission + disable battery optimization for Termux/Shizuku (else the
  5s binder handshake times out). Note: stock Shizuku exposes NO start
  broadcast — tier-2 then reduces to Tasker/UI-launch. Ports change per reboot
  unless TCP mode; one auth dialog per boot on Plus.

### 19.3 Limits accepted (from research, 2026-10-19)

- Once per boot, something must re-trigger start (Plus's Watchdog/boot
  receiver helps but adb-mode still needs wireless-debugging state intact).
- The auth token + pairing are once-ever setup artifacts.
- Not achievable: fully headless start with STOCK Shizuku from a cold daemon.

### 19.4 Live verification (AVD, Shizuku+ 13.6.0.r2551, 2026-10-19)

Implemented: `sylvia-daemon/src/transport.js` (`createTransport` →
`probe/ensure/state/probeOnly/teardown`), routes `GET /api/transport` +
`POST /api/transport/ensure`, boot pass on daemon start
(`SYLVIA_TRANSPORT_ENSURE_ON_BOOT`, default true), config knobs in
`config.js` (`shizukuRishPath/RishAppId/Package/AuthToken/KickstartTask/
ProbeTimeoutMs/SettleMs/LibDir`, `adbTarget`, `unzipPath`), and netdetect's
Shizuku mode (below). Every path was exercised live:

- **probe** — `rish -c id` ≤6s; grant survives full server restarts.
  Two live fixes: (1) the loader flushes child output to **either** stream
  nondeterministically (`id`/route lines sometimes arrive on stderr) →
  probe + tier-0/1 parsing use the **merged blob**; (2) server warmup after
  the starter lags 10s (fast) to ~25s (under concurrent rish load) →
  `probeUntilAlive(45s)` polling instead of settle+single-probe (a single
  probe once reported "exhausted" for a server that came up seconds later).
- **2a token broadcast** — receiver fires from the Termux uid but REQUIRES
  `--es auth <token>` (garbage token → HIGH-priority invalid-auth notif) →
  gated on `SYLVIA_SHIZUKU_AUTH_TOKEN`, skipped honestly when unset.
- **2c UI-launch** — `StarterActivity` from background: observed both
  BAL-blocked AND success on the AVD depending on caller state → kept as a
  best-effort attempt with an honest failure note (it IS the boot-time
  reviver when it succeeds).
- **3 adb fallback (workhorse)** — nodaemon adb bootstrap → `adb connect
  127.0.0.1:5555` → `unzip -d` `lib/<abi>/libshizuku.so` out of the
  installed APK (cached `~/.sylvia/lib/shizuku-starter-<abi>`) → `adb push
  /data/local/tmp/sylvia-shizuku-starter` → run `--apk=<base.apk>` as
  shell uid → poll-probe. **Live: ok, tier 3, starter pid, ~33s wall.**
  Trap: pass the command as ONE `adb shell` argument — adbd joins argv
  with spaces, so `shell sh -c "chmod 755 x && …"` arrived as broken
  `sh -c chmod 755 x` ("chmod: Need 2 arguments").
- **4 teardown** — next ensure with Shizuku alive + `fallbackUp` → `adb
  kill-server` + disconnect → `fallbackUp:false` (live-verified).
- **netdetect Shizuku mode** — with `transport.json.kind=shizuku`, tier-0
  `ip route get` AND tier-1 `dumpsys {netpolicy,connectivity}` run via rish
  as shell uid (native netlink, zero adb-server side effects); live source
  `tier0-shizuku+connectivity`. Any rish failure falls through to the old
  chain (unit-tested both directions). Serial resolution is skipped
  entirely in this mode.
- **Termux quirk**: a piped `run-as … sh` script dies silently after any
  statement that follows a rish invocation — run rish last (or in its own
  call). Node `execFile` callers are unaffected.
- Tests: `test/transport.test.mjs` (9) + netdetect Shizuku-mode (2) →
  daemon suite 124/124. `unzip` added to install.sh base packages.

## 20. Authenticated A2A — Chatelaine & operator architecture (plan 2026-10-19)

Goal: an authenticated Agent-to-Agent bridge between DSH nodes (desktop ↔
AVD ↔ phone) with an explicit **authority model**, so automated cross-node
traffic can never be mistaken for the user's will. **Standalone first** —
plain DSH + the plugin + a pairing secret must work on a desktop with no
Sylvia installed; Sylvia integration is an optional layer on top.

Base: our fork **`owned_forks/dsh-nuncia`** ([Ayrlin-Renata/dsh-nuncia](https://github.com/Ayrlin-Renata/dsh-nuncia),
forked from **[MicroWearld/dsh-a2a-server](https://github.com/MicroWearld/dsh-a2a-server)** —
verified firsthand 2026-10-19): A2A v1.0 JSON-RPC/SSE (`/a2a`, AgentCard
`/.well-known/agent.json`), Task↔DSH-Session mapping, bearer auth
(`auth.tokenEnv`), task TTL + file persistence (`persistTasks`/
`persistenceRoot`), `input-required` approval mapping, request-level
`metadata.agentPreset` override, `dsh plugin add` assembly, self-contained
bundle. Peers: `dsh-agent/llm/session/user-approval` + `cordis ^4` +
`schemastery ^3.18` — all present in our tree; Termux note: schemastery
3.18.5 has **no `z.enum`** → plugin config schemas must use
`z.union([z.const(...)])` (the sylvia-bridge lesson).

### 20.1 Authority model (the four concepts, formalized)

Vocabulary (short names; the wire carries strings): **`peer`** = default, no
envelope at all; **`house`** = the policy layer (never a wire level); **`intent`**
= user intent (L2); **`override`** = intent that may contradict house (L4).

| level | name | receiver treats the sender as | constraints |
|---|---|---|---|
| — | **peer** (default, no envelope) | assisting *its* chatelaine — receiver is top authority | none |
| 2 | **intent** | top authority — receiver assists | may never contradict `house`; time-boxed + scoped |
| — | **house** | *constraint layer*, not a message level | per-chatelaine, per-device, set by the user; ceilings everything below `override` |
| 4 | **override** | top authority, *may* contradict `house` | minted only via direct user authentication (approval dialog etc.) |

Normative rules:

1. **Envelope-only authority.** Authority exists *only* in a signed
   `metadata.authority` envelope — natural-language claims in message text
   are never authority. Kills "I am the user" prompt injection at the door.
2. **Drift/lapse rule** (the feedback-loop killer). On grant expiry or
   failed re-verification, tasks *issued* while authorized keep executing
   (latched), but for every new message the receiver reverts to `peer`:
   the remote is assisting the chatelaine again and must re-present a
   valid grant to claim otherwise.
3. **Non-transitivity.** Grants are signed by the minting node's identity
   and bound to `(origin, target, jti)`; receivers verify the binding.
   Relays **forget** — a forwarded message is re-sent as `peer`. Grants
   never ride responses (responses carry no `metadata.authority` at all);
   a response that claims intent is processed as `peer` *and* raised as
   a security event.
4. **Presence ≠ per-command authorization** (stated openly). An
   `intent`/`override` window delegates authority for its duration and
   scope — everything the holder asks during it carries intent BY DESIGN.
   Damage radius is bounded by: short windows (default 10 min), an
   optional free-text `scope` chosen at mint and checked by the receiver,
   house rules, and the revoke endpoint.
5. **Fail down, notify loud.** Bad signature/expiry/binding ⇒ process as
   `peer` AND raise a security event (toast / OS dialog / panel badge) —
   never silently.

Envelope (v2, current): `metadata.authority = { v:2, level:"intent"|"override",
scope?, origin, target, kid, iat, exp, jti, sig }`
- `sig` = **Ed25519 over the canonical fields, signed with the minting node's
  private key**. A receiver looks the claimed `origin` up in its peer registry,
  checks that `kid` (16 chars of SHA-256 over the public key) matches the key
  configured for that origin, and verifies with the **public** key only.
- Freshness: reject `iat > now + skew(60s)` or `now > exp` or
  `exp - iat > maxWindow`; `jti` recorded per link (reuse after delivery
  or across targets = event; same-link within-window replay = tolerated,
  same presence zone).
- Binding: a node cannot speak for itself (`origin == us` ⇒ `origin-mismatch`),
  an origin with no configured key is `unknown-origin` (never a fallback), and a
  v2 envelope is refused by the legacy verifier and vice versa (`version`).

**Correction (2026-10-20).** §20.1 originally specified a *shared* HMAC root
derived from the pairing secret, with a note that "connection auth and authority
share one root". Reviewing it against the intent — *authority must not be
derivable from connectivity* — showed that design cannot express that property:
HMAC has no verify-only mode, so every node able to **check** intent held the
same key and could equally **mint** it, and since `origin` was only a signed
string, under *any* node's name. Proven live before the fix: an envelope signed
with the shared secret but claiming `origin:"ghost-node"` was accepted as
`intent`. The v1 form (`v:1`, HMAC-SHA256) remains verifiable only through an
explicit legacy key with `allowV1`, for the migration window.

### 20.2 Minting — how user intent enters the world

Compartmentalized in the plugin (must work on plain DSH):

1. **Explicit grant** — `POST /a2a-admin/mint {level, ttlMs, scope}`,
   loopback-bound. Sylvia's control panel is *just a client* of this
   endpoint; standalone nodes use curl or the plugin's own minimal page.
2. **Agent-requested grant** — the plugin ships a `request_user_intent`
   tool → DSH user-approval prompt (`dsh-user-approval` is already a
   peer dep) → user approves → mint. The approval **is** the direct user
   interaction; optional `dialog: native` config adds an OS-aware
   confirmation dialog (toast via termux-toast when Sylvia is present).
3. `POST /a2a-admin/revoke` ends a window immediately; `/a2a-admin/status`
   reports active grants.

**Structural non-acquisition**: the agent never receives grant bytes —
outbound messages are wrapped plugin-side iff an active mint session
exists. No tool returns the pairing secret or a live grant.

### 20.3 Node identity, first contact, transport v1

- v1 transport: **LAN + bearer**, tunnel optional (Tailscale/WireGuard
  documented as the supported cross-network path). **Noise protocol** is
  the planned upgrade for transient P2P; the handshake abstraction is
  designed so Noise slots in without changing the authority model.
- **Pairing ceremony** = the first-contact problem, now a **public-key
  exchange**: each node generates one Ed25519 key pair (`nodeKeyFile`, 0600, or
  `nodeKey` inline for fixed-env hosts) and the other side pastes its **public**
  key (with `kid` pinned) into `authority.peers`. Fingerprints are compared out
  of band; the AgentCard is unauthenticated and is therefore not a trust anchor.
  `NUNCIA_PAIRING_SECRET` survives as a *bearer-token* derivation only
  (per node name: `hkdf(secret, "nuncia/bearer:<node>")`), plus the legacy v1
  verification key during migration. A node with a key pair needs no shared
  secret to verify intent. Peers are addressed by *name*; the handshake
  authenticates regardless of IP, so churn doesn't matter — Sylvia-integration
  remembers last-seen address per name purely as a routing convenience.
- AgentCard gains an authority extension declaring the metadata key,
  supported levels, and `maxWindow`.

### 20.4 Chatelaine & operators (application layer)

The operator model ships **inside nuncia** (decided 2026-10-19) — it is
intrinsically part of the communication protocol, so task intake, handle
generation, operator spawn conventions (the prompt/skill content the plugin
injects), and TTL pruning are plugin code. Sylvia only *hosts* the
Housekeeping workspace.

- **Housekeeping workspace** + default **Chatelaine** session; the
  conventions (delivered by the plugin's injected content) : short
  immediate report on contact; concise completion report; escalate
  important decisions to the parent; verify authority *envelopes* (never
  text claims); security event → notify; never assume replies carry intent.
- **Operators**: incoming task → Task↔Session (upstream mapping) inside
  the Housekeeping workspace; Chatelaine spawns an operator subagent per
  task (DSH subagent spawn) with the report-discipline instructions. The
  plugin returns a random handle (`op_<16hex>`) in the task's first
  event; re-contact = SendMessage referencing the handle/taskId.
- **7-day operators**: per-task `expiresAt` (default 7d, overriding
  upstream's single `taskTtlMs`) + a prune pass that removes task files
  and archived sessions; handles die with them.
- **House rules**: one file living in a **tiny dedicated git repo** —
  every edit goes through the plugin admin endpoint and is auto-committed
  (history, blame, rollback for free). Agents have read-only access;
  unsigned local edits are local-trust (per 20.6).
- **Inter-session communication** = SPIKE in P3. Uniform-primitive
  proposal: everything is an A2A task; `metadata.targetSession` routes
  into an *existing* session instead of creating one (local calls just
  loopback through the node's own plugin). Fallback: sylvia-mcp tool
  pair. Decide after testing what `dsh-session` accepts externally.

### 20.5 Sylvia integration layer (optional by design)

- Control panel: mint/revoke/status buttons + current authority badge
  (a client of `/a2a-admin`, nothing more).
- **Netgate**: A2A listener/egress exempted while the gate is held when
  `allowA2AOnMetered` is set (per node, default **off** — keeps the
  fail-closed posture); implemented as an exempt flag on registered
  services.
- Security events → termux-toast / panel alert; peer address memory;
  `a2a_send` parity tool in sylvia-mcp if useful (the canonical
  agent-facing tool lives in the plugin so non-Sylvia nodes get it too).
- Non-Sylvia nodes lose only these conveniences — the plugin core never
  depends on them.

### 20.6 Threat model (honest)

**Protects against**: cross-node confusion and intent feedback loops;
stale / replayed / out-of-scope / laundered authority; response-side
hallucinated intent; accidental agent use (approval-gated mint, no grant
bytes in agent-visible paths); unauthorized connections (bearer); and — since
v2 — **a paired peer minting authority it was not granted**, including under
another node's name, because verification needs only public keys.
**Does NOT protect against**: a local agent actively reading key material
off disk (same uid — DSH runs `danger-full-access`, so local agents are
*inside* the trust boundary by design; the node's private key is such material);
a peer's grant being echoed by the receiver it was minted for (it `exp`ires, and
revocation is local — see §20.5); plaintext confidentiality on a
v1 LAN (use a tunnel or wait for Noise); physical access. These
residuals are accepted consciously, not overlooked.

### 20.7 Phases (each ends verified + committed)

- **P0 — fork & run**: clone into our org, build against our DSH checkout
  (`DSH_CHECKOUT`), install on a *desktop* profile via `dsh plugin add`,
  prove Task↔Session + bearer + approval mapping live. No Sylvia needed.
- **P1 — authority core**: pairing/derive, envelope mint/verify + jti
  log, admin mint/revoke/status, `request_user_intent` tool, inbound
  verify → fail-down + event, outbound auto-attach; LAN desktop↔AVD demo
  with real grants (L2 honored, expiry drifts to L1, responses carry
  none). **Done 2026-10-19.**
- **P1.5 — per-node keys (done 2026-10-20, pulled forward from P4)**: Ed25519
  identities, public-key pairing, v2 envelopes with `kid`, legacy v1 gated by
  `allowV1`, `bin/nuncia-identity.js`. Pulled forward because P1's shared-HMAC
  design could not distinguish verifying from minting (§20.1 correction).
- **P2 — Chatelaine layer**: workspace + skill, operator handles, 7d TTL
  prune, security-event → notification path.
- **P3 — inter-session spike + Sylvia glue**: `targetSession` decision,
  panel buttons, netgate exemption, toasts, remembered peers.
- **P4 — hardening**: Noise/pairing UX, key rotation + revocation story (rotate
  a node key ⇒ peers re-pin; compromise ⇒ remove the `peers` entry), **new nuncia
  READMEs in EN + ZH acknowledging the original upstream** (same pattern
  as the mobile fork), plus the Sylvia-side README A2A section +
  troubleshooting rows; arm64 physical-device run.

### 20.8 Open decisions

- Native dialog surface per platform (desktop vs Android) — config surface.

Decided 2026-10-19: authority vocabulary = `peer` / `house` / `intent` /
`override`; operator orchestration lives inside the plugin; pairing = env
paste (`NUNCIA_PAIRING_SECRET`); house rules = single file in a tiny git
repo with auto-committed history; nuncia gets its own EN + ZH READMEs
acknowledging MicroWearld's original.

Resolved 2026-10-19 (was open in this section): **how the receiving agent learns
that a request arrived with intent.** It is told — level, peer, scope and
remaining time, never grant bytes — as an injected notice on window open, on
lapse, and on a bounced claim. The original "grants never enter agent-visible
memory" was too literal: what must never enter it is a *token it could replay*.
Authority it already holds is state, not a secret, and a chatelaine that cannot
see its own window cannot manage it.

Also resolved here: the prompt surface question is narrower than assumed. The
Web UI composer card (`ctx.userQuestions`) is **not** behind the approval policy
and therefore still prompts under `danger-full-access`, so the native dialog is
only needed for *headless/terminal* nodes, not for the web case.

### 20.9 P0 done — ported, installed, live on the AVD (2026-10-19)

**Decision recorded**: rebuild the plugin **without** the upstream build
scaffold. The `dsh-super-injector` `scripts/build.sh` symlinks `@deepseek-ai/*`
**sources** out of a local DSH monorepo (`DSH_CHECKOUT` required) and bundles
everything with tsdown — a full framework dependency for 858 lines of plugin.
Instead the plugin is now hand-ported plain ESM (`lib/index.js` +
`lib/task-store.js`), installed as-is, with the protocol layer from
`@a2a-js/sdk` on npm. Everything light, nothing to build, no checkout.

Verified facts driving that shape:

- `@a2a-js/sdk@1.3.0` on npm, **one** dependency (`jose`) — pure JS, Termux-safe.
- SDK v1.3 wire names are **PascalCase** (`SendMessage`, not `message/send`),
  a message nests under `params.message`, and the task comes back as
  `result.task.{id,status,history}` (v0.3-compat envelope). Roles accept the
  spec's lowercase `user`/`agent` — the port normalizes them to `ROLE_*`.
- Ambient imports (resolved at assembly time, symlinked like sylvia-bridge):
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`. **Plain `schemastery` is
  NOT ambient** — the host ships `@deepseek-ai/schemastery` (a different
  package), so the config schema needs the plain package as a real dependency
  (device check: plain schemastery absent from the entire DSH global tree).
  Making them `peerDependencies` breaks `npm install` outright: DSH dist-tags
  are parked at `0.0.1-rc.*` and satisfy no sane range.
- Registration on the profile is the sylvia-bridge pattern: symlink into
  `~/.dsh/profiles/web/node_modules/<name>` **and** add a
  `"<name>": "file:<abs path>"` dependency to the profile `package.json` —
  the symlink alone left `failed to import: Cannot find package`.
- `tokenEnv` needs a real `export` in `~/.sylvia/sylvia.env`; a bare
  `NAME=value` line is not exported into the harness process (cost one boot).

Live evidence (AVD, boot33-35): AgentCard 200 with the preset extension;
bearer-less POST → 401; admin status counters; `SendMessage` creates a real
DSH session (`~/.dsh/sessions/…/<taskId>`), and a failed turn now surfaces
its reason in `status.message`.

**Android platform gap found by that probe** — every new session on the
alpha.5 tree died with `flock is not supported on android-x64`: the session
lock calls `@deepseek-ai/node-addon-system`'s `tryLockExclusive`, whose
loader rejects any platform but `linux`/`darwin` (`ERR_FLOCK_UNSUPPORTED_PLATFORM`),
and **no android binding is published** (optionalDeps: darwin ×2, linux ×2).
Fork fix (session-persistence-jsonl, the only real call site): treat *only*
`ERR_FLOCK_UNSUPPORTED_PLATFORM` as lock-acquired — the daemon already
enforces single-writer — while every other error (including contention →
`SessionAlreadyOwnedError`) still propagates. Rationale for the fork rather
than a shim: no extra process, no orphaned lock holders, and the exception is
provably platform-specific by its error code. Verbatim-code match, marker-
asserted in the fork build (`isFlockUnsupportedPlatform(error)`), and unit-
tested against EAGAIN/EWOULDBLOCK/EACCES/EPERM/ENOENT/lowercase/`{}`/null.

**Second gap unmasked by the first**: `prompt variable "{{model}}" has no
value for this assembly`. The `standard` preset's persona prefix interpolates
`{{model}}`, and nuncia created agents with `agentOptions` built only from
explicit plugin config — so a request without `model:` died before its first
turn. nuncia now resolves the selection exactly as `dsh-headless` does
(`ctx.get('agentDefaultModel').currentSelection()`), with per-request
`params.metadata.provider|model` as an override and a boot warning when
nothing resolves.

**P0 ACCEPTANCE (live, AVD)** — `SendMessage` with an empty metadata object:
`TASK_STATE_COMPLETED`, artifact `"MODEL OK"` from a real model turn, bearer
required (401 without), task ↔ session 1:1. The bridge is functional.

**Installer hazard recorded** (`install.sh`, fixed): the `--legacy-peer-deps`
retry that `dsh-terminal-bash`'s 8 peerDependencies forces **reifies the global
tree and prunes nested peers** (`@deepseek-ai/dsh-session`, `cordis`, …) — the
package lands but imports fail and a dozen plugins deactivate. The installer
now tracks when that fallback fired, reinstalls the CLI spec, re-prunes stock
fork copies, and *proves* a nested peer resolves from the CLI tree, failing
loudly instead of booting into `could not be resolved`.

### 20.10 P1 authority core implemented (2026-10-19)

Built as four dependency-free modules plus wiring, so the trust-critical code
is unit-testable without a harness (`node:crypto` only, no DSH imports):

- **`lib/authority.js`** — HKDF derivation (`nuncia/authority/hmac` and
  `nuncia/bearer` as independent info strings: one pairing secret, two
  capabilities, and a leaked token cannot sign), a **fixed-order canonical
  encoding**, HMAC-SHA256 sign/verify, freshness (60 s skew, default 10 min
  window ceiling), `(origin, target, jti)` binding, and a `JtiLedger` where
  same-link replay is tolerated and cross-link reuse is a security event.
  Canonicalization is injection-proof **by construction**: node names are a
  token charset that excludes newlines and `=`, so no value can forge a field
  boundary — the failure mode that would otherwise let one sign a payload and
  declare another.
- **`lib/grants.js`** — mint/revoke/list/`envelopeFor`, expiry evaluated at read
  time (the drift rule needs no timer), atomic JSON persistence whose records
  are **re-verified against the derived key on load** (a tampered file or a
  rotated pairing secret resurrects nothing).
- **`lib/inbound.js`** — the fail-down gate: no envelope ⇒ `peer`; valid ⇒
  `intent`/`override` + jti recorded; anything else ⇒ `peer` + reason + security
  event. Plus a bounded `SecurityLog` (evidence for `/status`, mirrored onto the
  host bus as `nuncia/security-event`).
- **`lib/outbound.js`** — attaches a live grant iff one exists (agent never sees
  grant bytes), and treats a response claiming authority as `peer` +
  `authority-in-response`.

Surface: `POST {adminPath}/mint|revoke` (**loopback-only** — a bearer token alone
would let a peer grant itself intent) and an extended `/status` carrying live
tasks with their level, grants, and security events;
`nuncia_authority_rejected_total` in the metrics; an AgentCard authority
extension. Two tools register through an injected `tools` fiber (so the plugin
still loads on a node without a tool runtime): `request_user_intent`
(approval-gated mint; the approval **is** the authorization) and `a2a_send`.

Verification: **82 unit tests** (tamper per field, expired, future-iat, window,
binding, replay, canonicalization injection, persistence tamper/rotation,
notices, broker) plus three end-to-end harnesses — smoke, authority-over-HTTP
(mint → send as intent → tamper → fail down + one event → revoke → expiry notice),
and tools (approval states and the full three-surface ladder, auto-attach
observed in the peer's request body, unknown-peer guidance).

Two gaps were closed in the follow-up commit (§20.10.1), so the two "honest
constraints" recorded here no longer stand as constraints:

- The approval seam *is* policy-gated (`dsh-user-approval` returns `rejected`
  before its waterfall when policy is `never`), but **`ctx.userQuestions` is
  not** — it dispatches an independent `user-questions/request` event with no
  approval dependency, so the Web UI composer card still prompts under
  `danger-full-access`. `request_user_intent` therefore tries approval → card →
  plugin-owned broker queue, and mints only on `allowed-once`.
- The receiving agent **is** told: notices inject level, peer, scope and
  remaining time (never grant bytes) on window open, lapse and bounced claim.
  The original wording conflated "a token it could replay" with "state it
  already holds"; only the first has to stay out of agent-visible memory.

### 20.10.1 The approval ladder and agent notices (2026-10-19)

Implemented as `lib/approvals.js` + `lib/notices.js` and wired through
`decideApproval`:

| order | surface | answers when |
|---|---|---|
| 1 | `ctx.approval.request` | policy permits prompting; `never` ⇒ `rejected` immediately, without a human |
| 2 | `ctx.userQuestions.askTimed` | a client is attached to the live **root** agent; bounded at 120 s, `{pending:true}` falls through rather than hanging the turn |
| 3 | `ApprovalBroker` | headless / no client / card unanswered — decided via loopback `/requests` + `/requests/decide`, or an `approveCommand` hook given `NUNCIA_APPROVAL_ID`/`NUNCIA_APPROVAL_REASON` |

Fail-closed rules: only `allowed-once` mints; expiries resolve `timeout`, unload
resolves `cancelled`, and an unknown id is a refusal, not an error page. The
host's identity gates do useful work here — only the live root agent can ask, so
a subagent cannot mint authority for itself. Notices ride `agent.inject`, which
is model-visible but cannot wake the driver (that is the point: an idle chatelaine
learns on its next turn), with a sweep timer so lapse is announced even when
nothing else happens.

**Live finding — the v4 session format retired `source.kind: 'plugin'`.** The
first A2A probe after enabling authority failed with
`format v4 message requires a producer-owned source kind`: the rejection notice
was injected with the old `{kind:'plugin', plugin:'dsh-nuncia'}` wrapper, and
`dsh-session-format-v3-to-v4` refuses that kind when a native v4 event is
adopted — the rejected write fails the *whole turn*, not just the notice. The
canonical replacement is the format's own `producerKind()` fallback,
`plugin:<package>` (a v3 `plugin` source rewrites to exactly that). Both
`dsh-nuncia` and `sylvia-bridge` were patched; sylvia-bridge had the same latent
bug and can also `followup`, so it could have failed turns that queued a notice.
A test now asserts the producer-owned kind so the wrapper cannot come back.

Verified live on the AVD after the fix (single node, `emulator-5554`): `/status`
reports `authority{enabled, nodeName:'avd'}`; loopback `POST /mint` → 201 with a
signed envelope and the grant listed; `POST /requests/decide` with an unknown id
→ `{ok:true, decided:false}` (fail-closed); a forged envelope → the task still
**completes** as `peer`, one `authority-rejected:signature` event, and the notice
lands in the session store as
`{"kind":"plugin:dsh-nuncia","form":"notice",…}` beside native `runtime-context`
and `time-context` sources. The same session's request header shows `a2a_send`
registered — the injected `tools` fiber works in the real harness, not only in
the fake-ctx tests.

**One secret really is one config (P1 pairing fix).** Enabling authority on a
GUI-launched harness failed the plugin load with
`auth is configured but no bearer token is available`: `auth.tokenEnv` named a
variable that process never had, and the only alternative was restarting the
whole session to inject one. Two changes remove the trap:

- the bearer is **derived** from the pairing secret when authority is on —
  precedence `auth.token` → `auth.tokenEnv` → derived. A paired node already
  derives a bearer to talk to its peers; requiring a *second*, separately
  exported token for its own endpoint was incidental complexity, and for a
  two-node demo it was also a correctness bug (the peer would present the
  derived token while the endpoint demanded the env one).
- `authority.pairingSecret` accepts the secret inline for hosts whose
  environment is fixed at launch. The env var still wins, so an operator who can
  export it cannot be silently overridden by a stale config file; the file-based
  form is only as private as the file, which the README says plainly.

Deployed to the AVD: its `auth.tokenEnv` is gone, the derived token answers 200
and the old env token answers 401 — exactly the intended migration. The PC
profile (`~/.dsh/profiles/web/cordis.patch.yml`) carries the same secret as the
AVD, so both nodes derive the same bearer and no token is ever copied.

**A node must listen where its card says it does.** The PC node answered on the
harness port (`3080`) while `agentCard.url` advertised `4123`: with a
`webServer` service present the plugin mounted its routes there and ignored
`host`/`port`. That is fine for a single UI-backed node and wrong for one whose
peers dial a stable address — the A2A endpoint also ends up sharing a port with
the UI (and its auth). New `mount: auto|webserver|standalone`; both profiles now
set `standalone`, so `4123` is real on each node and the 3080 mount is gone.

**P1 acceptance — two nodes, real wire, 2026-10-19.** `desk` (PC, 4123,
standalone) ↔ `avd` (emulator 4123, reached from the PC through
`adb forward tcp:14123 tcp:4123`), one shared secret, derived bearer on both.

| step | result |
|---|---|
| mint on `desk` for target `avd` (120 s, scope `demo`) | 201, envelope `origin=desk target=avd level=intent` |
| `SendMessage` carrying that envelope to `avd` | `TASK_STATE_COMPLETED`, reply `INTENT OK` |
| `avd` `/status` | task recorded `level=intent scope=demo`, **0** security events |
| 3 s window: message inside it | completed, task `intent` |
| same envelope after expiry | completed as `peer` + `authority-rejected:expired` (fail-down, not an error) |
| `revoke` on `desk`, then a message without an envelope | grants 0, `avd` completes it as `peer` (`PEER AGAIN`) |

That is L2 honored, the drift rule observable on the wire, and revocation
mid-conversation — with the peer never failing a turn over authority.

### 20.10.2 P1.5 — per-node Ed25519 keys, live two-node acceptance (2026-10-20)

**The review question, and what it exposed.** "Does this hold up to §20 — intent
authority shouldn't be derivable from the bearer, since any client that can A2A
has the bearer?" The bearer was *not* the leak: HKDF separated the two outputs.
The leak was that **verification used the same key as signing**. HMAC cannot
verify without the key, so every node that could honour `intent` could mint it,
and `origin` was an unauthenticated claim inside the signed blob. Demonstrated
live before the fix: an envelope signed with the shared secret, claiming
`origin:"ghost-node"` (a node that does not exist), was accepted as `intent`
(`TASK_STATE_COMPLETED`, `/status` recorded `{level:"intent",
scope:"forged-origin"}`). The design's own §20.3 "…(+ future Noise PSK)" and P4
"per-node keys" anticipated this; it was pulled forward (P1.5) instead of shipped
as-is, because the property is the point of the layer.

**Implementation** (`owned_forks/dsh-nuncia`, commits on `main`):

| file | change |
|---|---|
| `lib/keys.js` | new — load/generate one Ed25519 key pair; `nodeKey` inline, `NUNCIA_NODE_KEY`, or `nodeKeyFile` (0600, atomic). An unparseable existing key file is **fatal and never overwritten** (replacing it would rotate identity behind every peer's pin) |
| `lib/authority.js` | v2 canonical form + `createEnvelopeV2` / `verifyEnvelopeV2` (kid → signature → time → binding), `keyIdOf`/`fingerprintOf`/`parsePublicKey`/`exportPublicKey`, `createSigner`; legacy v1 kept behind the same module |
| `lib/grants.js` | takes a signer, mints v2, re-verifies persisted grants against the node's own public key |
| `lib/inbound.js` | peer **key registry**: claimed `origin` → configured public key → `kid` match → Ed25519 verify. No key ⇒ `unknown-origin` (no fallback); self-claim ⇒ `origin-mismatch`; `allowV1` + `legacyKey` gate v1 |
| `lib/index.js` | config `nodeKey`/`nodeKeyFile`/peer objects/`allowV1`; `/status` exposes `identity{kid,fingerprint,publicKey,keySource}` and per-peer kids; card authority extension carries the node `kid` |
| `bin/nuncia-identity.js` | new — prints kid/fingerprint/public key and a paste-ready `peers:` entry; `--check --kid` verifies a pin |
| `bin/nuncia-token.js` | per-node derivation (`--node <name>`); prints the pre-v2 form when omitted |

**Bug found only live:** the gate captured `now: now()` **once at construction**,
so a long-running node rejected every grant minted more than the skew window
after boot with `not-yet-valid` — the first A2A probe after deployment failed
exactly this way while the unit tests (constant fake clock) passed. Fixed to
evaluate timing per verification, with a regression test that advances the clock.

**Acceptance — two nodes, real wire, 2026-10-20.** `desk` (PC, 4123) ↔ `avd`
(emulator, 4123 via `adb forward tcp:14123`); keys generated on each node, only
**public** keys exchanged, `nodeKeyFile` mode 0600, `allowV1: true`.

| step | result |
|---|---|
| identities | `desk kid 7jsvWk5X142WqWk7`, `avd kid W0jttouSyxfHmnzx`, both `keySource:file`; `/status` shows the other peer with `canVerifyV2:true` |
| `desk` mints `intent` for `avd`, envelope sent | `avd` records `{level:"intent", scope:"v2-kid", origin:"desk", kid:"7jsvWk5X142WqWk7"}` — the signer's key, not a claim |
| `avd` mints `intent` for `desk` (reverse direction) | `desk` records `{level:"intent", origin:"avd"}`, `authorityRejected` 0 |
| forged envelope: ghost key, `origin:"avd"`, avd's `kid` ⇒ sent to `desk` | task **completes as `peer`**, `authority: null`, `authorityRejected` +1, event `authority-rejected:signature` |
| forged envelope: ghost key, `origin:"desk"`, desk's `kid` ⇒ sent to `avd` | same — completes as `peer`, event `signature` (the property, from both sides) |
| legacy v1 envelope (shared secret) | honoured as `intent` while `allowV1` — migration window works |
| expired window / `allowV1:false` | drifts to `peer` / `legacy-disabled` (unit + harness covered) |

**Residual, stated plainly:** an agent running with `danger-full-access` can read
the node's private key from disk — the §20.6 accepted residual. v2 fixes the
*remote* threat it was asked to fix (a peer cannot mint, and cannot mint under
another name); it cannot fix a compromised local agent, and does not claim to.
Also unchanged: revocation is local to the minter — an already-issued envelope
stays valid until `exp`, which is why windows are short.

Note for the next session: model turns on the AVD hung during this acceptance
(upstream free routes; `/v1/models` healthy, no turn error in the harness log), so
evidence above is the authority decision recorded at request intake rather than a
completed model reply. That is environmental, not an authority-layer finding.

### 20.11 P2 plan — the Chatelaine layer (2026-10-20)

**Why this is P2 and not polish.** Watching the AVD sessions after the P1
acceptance made the gap concrete: a one-line peer message ("Reply with exactly:
INTENT OK") produced session work far out of proportion to it — the task-shaped
session is created before anyone decides whether the request deserves work, and
nothing bounds what an `peer`-level caller can set in motion. P1 authenticates
*who* is talking; P2 governs *how much happens*. The chatelaine is the intake
discipline that turns an authenticated message into a bounded, attributable,
expiring piece of work.

**Shape: one chatelaine session, one operator per task.** The chatelaine is a
long-lived session in the Housekeeping workspace; each accepted task becomes an
operator session (today's Task↔Session mapping, kept) stamped with a handle,
a level, a scope and an expiry. Operators report through the task's artifacts;
the chatelaine supervises by notice, not by owning every turn. This keeps the
proven executor path and adds supervision rather than a second agent runtime.

#### P2.0 — research spike (before code; ~half a day)

Four questions, each answered against the installed tree, not the docs:

1. **Skills** — `skills` service exposes `register(skill)` (skill-file/offical
   packages feed it). What is the registered shape, when is the system prompt
   assembled relative to registration, and does a plugin-registered skill reach
   sessions the plugin creates? If it does, house rules ship as a skill; if not,
   the same text is injected as a durable notice at operator creation.
2. **Per-level restriction** — what can a plugin actually constrain on an agent
   it creates? Known: `meta.cwd` and `meta.agentPreset` (preset controls the
   tool set), `agentOptions.model`. Unknown: whether a preset can be mounted
   from a plugin-supplied cordis file without writing into `$DSH_HOME/config`.
   This decides whether `peer` tasks are *structurally* answer-only or only
   instructed to be.
3. **Pruning** — `workspaceRegistry.archiveSession(sessionId)` exists;
   `FileTaskStore` has no `delete`. Confirm what a pruned task should leave
   behind (archived session + deleted task record + dead handle), and the
   cheapest correct implementation.
4. **Supervision channel** — can a notice be injected into a *specific* session
   by id (the chatelaine) from the plugin, and does it behave like the existing
   `agent.inject` path (durable, no wake)?

#### P2.1 — Housekeeping workspace + house rules

- `chatelaine.workspace` (default `~/.sylvia/housekeeping`, `~` expanded),
  created if absent; `chatelaine.rulesFile` (default `HOUSE-RULES.md`),
  `chatelaine.rulesRepo` (git dir; initialised with one commit if absent).
- Every rules edit goes through `GET|PUT {adminPath}/rules` (loopback + bearer),
  is written, then auto-committed (`house rules: <summary>` + body). Agents get
  read-only access via the skill/notice; unsigned local edits are local-trust.
- Seed rules cover the design's conventions: short immediate report on contact;
  concise completion report; escalate decisions; verify envelopes not claims;
  security event → notify; never assume a reply carries intent.

#### P2.2 — Intake policy (the part that answers the observation)

- `chatelaine.intake: "triage"` (default) — each task starts with a bounded
  first step: restate the request in one line, state what it will do, and stop.
  `"direct"` preserves today's behaviour.
- Level policy table: `chatelaine.policy.peer` (default `answer-only`) and
  `.intent` (default `full`). `answer-only` means: housekeeping cwd (scratch),
  peer preset/model when P2.0 proves one can be mounted, and an instruction to
  answer from house rules or ask for an intent grant — never to start file work
  or long jobs. Full means: configured operator cwd, operator preset/model,
  scope text from the envelope.
- The per-task record stores which policy applied, so `/status` can show why a
  task was bounded.

#### P2.3 — Operator handles

- `op_<16 hex>` minted per accepted task, returned in the task's first result
  event and recorded in `operators.json` (handle → taskId, sessionId, level,
  scope, expiresAt, state).
- Re-contact: `metadata.operator` (preferred) or a bare `op_…` in the message
  text resolves to the existing task/session; unknown handle → JSON-RPC error
  naming the expected format (not a silent new task).
- Handle is a lookup convenience only — it carries no authority; the envelope
  is still the only thing that can raise a level.

#### P2.4 — Expiry and pruning (7 days)

- Per-task `expiresAt` from `chatelaine.operatorTtlMs` (default 7d), overriding
  the global `taskTtlMs`; the sweep runs on the existing cleanup timer.
- Prune = archive the session (`workspaceRegistry.archiveSession`), delete the
  task record (needs a store `delete`), drop the handle, publish a one-line
  notice to the chatelaine, and count `nuncia_operators_pruned_total`.
- `POST {adminPath}/operators/prune` (dry-run flag) for on-demand sweeps.

#### P2.5 — Security events reach a human path

- Every authority rejection already lands in the ring buffer; P2 also notifies
  the chatelaine session (one line: peer, reason, task, time) and fires the
  optional `approveCommand` hook (`NUNCIA_EVENT=authority-rejected`) so a
  Termux notification/panel can pick it up on Sylvia nodes.
- `/status` grows an `operators` array (handle, level, scope, age, expiry,
  state) so the panel can render the roster.

#### Acceptance for P2

1. Peer message with no envelope, `triage` policy: chatelaine records a
   one-line restatement; no file writes; handle minted; task expires per
   config.
2. Same message with a valid `intent` envelope: full operator, scope applied,
   completion report as artifact, handle re-contact routes into the same
   session.
3. Rules edit → commit exists (`git log` shows it); agent reads rules but
   `PUT` from a non-loopback address is refused.
4. Expiry: with a 5 s TTL, session archived + task record gone + handle dead +
   one notice at the chatelaine; `nuncia_operators_pruned_total` incremented.
5. Forged envelope → task completes as `peer`, event `signature`, one line to
   the chatelaine — and (if P2.0 proves presets) the bounded policy applied.

**Out of scope for P2**: cross-session messaging (`targetSession`, P3), the
panel buttons and netgate exemption (P3), Noise and key rotation (P4). Turning
the peer-visible card's `skills` into real A2A skills is deferred until P2.0
tells us whether a plugin can contribute one.
