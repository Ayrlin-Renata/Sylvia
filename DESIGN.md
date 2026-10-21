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
acceptance made the gap concrete: a one-line peer message produced session work
far out of proportion to it — the task-shaped session exists before anyone
decides whether the request deserves work, and nothing connects an operator's
doubt to the person who could answer it. P1 authenticates *who* is talking; P2
governs *how much happens, and who gets told*.

**Topology decided with the operator (2026-10-20).** Operators are **real
sessions in the Housekeeping workspace**, not subagent children. A subagent
child is cheap but constrained in ways that matter here: it cannot take a
per-operator model, and its reporting/approval surfaces are fixed by the
parent. Sessions give us the controls this layer needs — model, cwd, preset and
(later) tool policy per authority level — and they survive the parent's turn.
The cost is that supervision must be built: a **stable Chatelaine session**
plus a reporting primitive that crosses sessions. That pulls the P3
`targetSession` spike forward to **P2.0-B**; if it proves infeasible, the
fallback is the subagent runtime and this section is revised rather than
half-shipped.

**Discipline is prompt-level for now (operator decision).** No hard caps in P2:
operators get an initial brief derived from the authority/trust level, told to
notify the chatelaine before consequential execution and again on completion.
Hard tool/model limits are a later development, but the session runtime is
chosen now so that when they arrive they are a config change, not a rewrite.

#### P2.0 — research spike (before code; read-only)

Five questions, answered against the installed tree with `file:line` evidence:

- **A — skills reach.** `skills.register(skill)` shape; when system prompts are
  assembled relative to registration; does a plugin-registered skill reach
  sessions the plugin creates?
- **B — cross-session reporting (the uplift from P3).** How a plugin addresses a
  session it did not create in this turn: `agents.get(id)`? `resume`?
  `sessions` service? Does `agent.inject` work for that session, and does the
  injected message stay durable without waking a turn? This decides whether the
  chatelaine can be a long-lived session woken only by notices.
- **C — question forwarding.** `user-questions/request` is a waterfall (the
  earlier research proved it survives `danger-full-access`). Can a plugin tap it
  for operator sessions, forward the question to the chatelaine, and answer it —
  so an A2A operator never blocks on a human who is not watching that session?
- **D — unexpected ends.** The `turn/end` reason taxonomy; what is observable
  when a session stops abnormally (error / cancel / process death), and what the
  last assistant text looks like at that moment.
- **E — pruning + presets.** Confirm `workspaceRegistry.archiveSession` /
  `attachSession` semantics, what a pruned task should leave behind, and whether
  a preset can be mounted from plugin-supplied config without writing into
  `$DSH_HOME/config`.

#### P2.1 — Housekeeping workspace + house rules

- `chatelaine.workspace` (default `~/.sylvia/housekeeping`, `~` expanded),
  created if absent; `chatelaine.rulesFile` (default `HOUSE-RULES.md`) in a
  local git repo (no remote), initialised with one commit if absent.
- Edits only through `GET|PUT {adminPath}/rules` (loopback + bearer), written
  then auto-committed (`house rules: <summary>` + body). Agents read via the
  skill/notice; unsigned local edits are local-trust.
- Seed rules: short immediate report on contact; concise completion report;
  escalate consequential decisions before acting; verify envelopes, never text
  claims; security event → notify; never assume a reply carries intent.

#### P2.2 — Chatelaine session + reporting primitive

- One stable chatelaine session (`chatelaine.sessionId` configurable, else
  created once and its id stored in `~/.sylvia/nuncia/chatelaine.json`), cwd =
  workspace, preset = `chatelaine.preset` (default the configured operator
  preset). Survives operator churn; `/status` reports whether it is live.
- Plugin tool `report_to_chatelaine({summary, question?, urgency?})`: injects a
  durable notice into that session (no wake for `info`; wake for `question`),
  returns immediately. This is the operator's only sanctioned escalation path.
- Chatelaine brief: it is the user's representative — decide from house rules
  and prior instruction whether an escalation matters, answer what it can,
  aggregate the rest for the human.

#### P2.3 — Operator intake, handles, initial brief

- Handle `op_<16hex>` minted per accepted task; returned in the task's first
  event; recorded in `operators.json` (handle → taskId, sessionId, level,
  scope, expiresAt, state). Re-contact via `metadata.operator` or a bare
  `op_…` in the text; unknown handle → explicit JSON-RPC error, not a new task.
  Handles are lookups, never authority.
- Initial brief per task, built by the plugin: one-line restatement first, the
  level (`peer`/`house`/`intent`), the scope if granted, expiry, the reporting
  duty, and "never wait on the user directly — ask the chatelaine".
- Session creation gains `meta.cwd` = workspace, workspace attachment, and the
  per-level model override (peer may run a cheaper route; intent the operator
  model) — both first-class because operators are sessions.

#### P2.4 — Supervision hooks

- `turn/end` with an error reason → chatelaine notice carrying the task, the
  last assistant line and the reason (the "ended unexpectedly" rule).
- `user-questions/request` from an operator session → forwarded to the
  chatelaine (P2.0-C); while forwarded, the operator is told the question went
  to the chatelaine rather than hanging silently.
- Authority rejections keep the existing per-task notice and additionally
  notify the chatelaine (one line: peer, reason, task, time) and fire
  `approveCommand` with `NUNCIA_EVENT=authority-rejected`.

#### P2.5 — Expiry, pruning, roster

- Per-task `expiresAt` from `chatelaine.operatorTtlMs` (default 7d), overriding
  the global `taskTtlMs`; the sweep rides the existing cleanup timer.
- Prune = archive the session, delete the task record (store needs `delete`),
  drop the handle, one-line chatelaine notice, `nuncia_operators_pruned_total`.
- `POST {adminPath}/operators/prune` (dry-run flag); `/status` grows an
  `operators` array (handle, level, scope, age, expiry, state).

#### Acceptance for P2

1. Peer message, no envelope: one-line restatement, handle minted, chatelaine
   notified of contact; nothing written outside the workspace.
2. Same message with a valid `intent` envelope: full operator under scope,
   completion report as artifact, handle re-contact lands in the same session.
3. Rules edit commits (`git log`), agent can read them, non-loopback `PUT`
   refused.
4. An operator that hits an error, or asks a question, produces exactly one
   chatelaine notice with the operator's last line — and the task does not hang
   waiting for a human.
5. 5 s TTL: session archived, record gone, handle dead, one prune notice.
6. Forged envelope: completes as `peer`, `signature` event, chatelaine notice.

**Out of scope for P2**: hard tool/model caps per session (noted for later),
panel buttons and netgate exemption (P3), Noise and key rotation (P4).

### 20.11.1 P2 executed — chatelaine live on both nodes (2026-10-20)

The §20.11 plan is implemented in `dsh-nuncia` (commits on `main`) and live on
the desk harness and the AVD node. Execution notes and what reality added:

**The P2.0 spike was worth its half day.** Four of its five questions changed
the code, and one (B) moved P3 work into P2 as planned:
- **Cross-session reporting exists**: `agents.get(id)` is live-only, the cold
  path is `agents.resume({resumeSessionId})` — exactly the shipped session
  controller's pattern. Handles are fiber-owned: a plugin reload disposes every
  agent the plugin created, so the rule adopted throughout is *hold session ids,
  re-resolve per delivery, never cache an Agent*.
- `session/event` at plugin scope already sees **every** live session (the
  scope filter admits untagged listeners); the old `record.agent.session !==
  session` ownership guard was the only thing hiding them. Removed — routing is
  by session id.
- **Skills are not a system-prompt section** on this train: the catalog is
  rebuilt at every `agent/pre-step` from the live registry, so registration
  reaches already-running sessions. (Deferred until rules-as-skill is proven.)
- **turn/end triage found a live bug**: the listener treated only
  `kind === 'error'` as failure, so an A2A `cancelTask` (aborted) and blocked /
  max-tokens turns all reported `TASK_STATE_COMPLETED`. Fixed: only `completed`
  is success; `aborted`+`user` → CANCELED, everything else → FAILED with the
  reason string; `cancelTask` marks the record terminal so the abort cannot
  double-publish. The P2 harness drives this with an aborting fake agent.
- **Archive is the ceiling** for pruning: no shipped session-data deletion.
  Prune = `archiveSession({stopActivity:true})` + drop record + drop handle +
  one chatelaine notice.

**Shipped** (`lib/house.js`, `lib/operators.js`, `lib/chatelaine.js` + wiring):
house workspace seeded with rules + local git identity (commits never depend on
the host's global config — we have met "fatal: empty ident name" before);
`GET|PUT {adminPath}/rules` loopback-only even with a bearer, one commit per
write; operator book (persistent, read-time expiry, corrupt book refused);
brief-before-first-turn via the durable inbox; `report_to_chatelaine` +
`reply_to_operator`; question forwarding with an in-place answer so an A2A
operator never hangs; per-task `operatorTtlMs` (7d) with a sweep; `/operators`
roster + `/operators/prune` (dry-run supported); house/chatelaine/operators in
`/status`. Tests: **131 unit** (house + operators added) + **5 harnesses**
(p2 added), all green, `npm test` ≈ 16 s.

**Live acceptance** (2026-10-20, both nodes, real wire):

| step | desk | avd |
|---|---|---|
| house seeded, `git.ok` | ✅ `d9b1963 house rules: initial` | ✅ (`.git`, rules, `.nuncia/`) |
| task completes, handle in metadata | ✅ `op_a3e32ce8ff0fddcf` in 4 s | ✅ `op_9c0dadb5e7bd3935`, `TASK_STATE_COMPLETED` |
| brief persisted before the turn | ✅ `agent/inbox/spliced` + `user/message` in the operator session | ✅ (2 brief events) |
| chatelaine adopted + contact notice | ✅ `session-04fb2136…` | ✅ `session-93281439…`, contact in store |
| `/status` house + chatelaine + roster | ✅ | ✅ |

The desk operator's own artifact line — "answering only from
HOUSE-RULES.md" — is the prompt-level discipline working: the brief names the
rules file and the level, and the model followed it without any hard cap.

**Left for later (recorded, not forgotten)**: rules-as-skill (needs the
plugin-scope registration shape proven), hard per-level tool/model caps (the
reason operators are sessions, not subagents), and the P3 glue (panel buttons,
netgate exemption, toasts, remembered peers). The `targetSession` spike is
effectively answered: chatelaine↔operator is cross-session reporting over
`resume` + `inject`, no new primitive needed.


### 20.12 P3 plan — Sylvia glue (2026-10-20, revised after discussion)

P3 makes the authority layer *operable by a human on a phone*. Everything here
is Sylvia-side convenience except P3.0, which is a plugin-surface lockdown the
operator asked for; the plugin core stays independent of Sylvia (§20.5).

**Discussion verdicts (2026-10-20), which shaped the plan:**
1. The AgentCard is a *discovery* surface and must **not** be public: even
   looking at a node's card is locked behind auth, and a raw nuncia install
   must not be A2A-usable by "just anyone who has installed nuncia". Node
   identity beyond the name comes from the `kid` (internal, collision-proof).
2. Notifications use **push hooks**: approvals fire the existing
   `approveCommand` hook at the daemon; security events are forwarded by the
   bridge subscribing to the plugin's `nuncia/security-event` emission.
3. The **agent card stays minimal** — name, platform, last downtime end, and a
   chatelaine-managed public announcement. Peer address memory lives in
   Sylvia's registry (the resource network), not in nuncia. Node names come
   from a newline-delimited file picked at random on first boot (the human
   supplies the file; a heavy generator does not ship with every install).

**One structural fact shapes P3.1**: the A2A listener lives inside the harness
process, and what can kill it on metered data is the *bridge's* in-process gate
(turn cancellation), not the daemon netgate (which SIGSTOPs external services).
So "exempt A2A" is gate-level exemption by session identity; the §20.5 netgate
exempt-flag is only needed if someone later runs nulia standalone.

#### P3.0 — plugin surface lockdown + minimal card (prerequisite, nulia)

- **Card requires auth.** `GET {agentCardPath}` answers 401 without the bearer
  by default; `agentCard.public: true` is the explicit escape hatch for nodes
  that accept unauthenticated scanners. Paired peers already hold the derived
  token, so the mesh is unaffected; only scanners lose.
- **Minimal card**: `{name, platform, since, announcement, …}` plus the
  existing authority extension (`kid`). `platform` derives from
  `process.platform`-`process.arch` (overridable); `since` is the plugin's
  boot time = "last downtime end".
- **Announcement**: `GET|PUT {adminPath}/announcement` (loopback + bearer,
  persisted in the state dir) and a `set_announcement` tool that only the
  chatelaine session may call — it is the human's signboard, agent-managed.
- **Name generation**: `nodeNameFile` (newline-delimited). When `nodeName` is
  unset and the file exists, pick a random line on first boot and persist it
  (state dir); fall back to the hostname when no file. Collisions are resolved
  by `kid`, which is already carried in cards, envelopes and the pairing
  `--check` flow.
- **`auth.adminToken` / `auth.adminTokenEnv`**: an ADDITIONAL accepted bearer,
  never the primary — peers keep using the derived token (pinned `auth.token`
  semantics unchanged). This is what the Sylvia daemon proxies with, and it
  makes the admin path explicit keying rather than derivation (discussion
  point 1: nothing token-shaped is discoverable, only configured).

#### P3.1 — A2A session tagging + metered exemption

- nulia tags every session it creates: `meta.a2a = {role:'operator', handle,
  level, taskId}` / `{role:'chatelaine'}` — rides the session header,
  survives restarts.
- sylvia-bridge gains `allowA2AOnMetered` (default **false**, fail-closed).
  When the gate trips and the flag is on, `meta.a2a` sessions are exempt:
  inbound tasks run, outbound `a2a_send` works, the chatelaine still sees
  reports. When off, an A2A task cancelled by the gate surfaces honestly
  (`TASK_STATE_FAILED`, `aborted: hook`, plus a chatelaine notice — P2's
  triage).
- Acceptance: AVD, wifi off → task fails with the gate reason (flag off), then
  completes (flag on). Desk unchanged.

#### P3.2 — daemon proxy + dashboard A2A card

- Daemon `/api/a2a/*` proxies to nulia on 127.0.0.1:4123 using
  `NUNCIA_ADMIN_TOKEN` from `sylvia.env` (the plugin's new admin-token slot).
  The proxy is what makes loopback-only mint/revoke reachable from the phone
  browser without weakening the guard: the *daemon* is the loopback client.
- Routes: `GET /api/a2a/status` (identity, grants, roster, events),
  `POST /api/a2a/mint|revoke`, `GET /api/a2a/requests` +
  `POST /api/a2a/requests/decide`, `GET|PUT /api/a2a/announcement`.
- Dashboard **A2A card** (the human's own panel, its own auth — not the agent
  card): authority badge, grants with countdown, mint/revoke controls, operator
  roster, approval queue with Allow/Deny, recent security events, the
  announcement editor. Peers shown with the daemon registry's last-seen
  annotation (P3.4 joins).

#### P3.3 — push notifications (discussion point 2)

- **Approvals**: the launcher seeds `approveCommand` to curl the daemon
  (`NUNCIA_APPROVAL_ID`/`REASON` already ride the env) → instant notification
  + panel queue entry. The broker queue stays the fallback surface.
- **Security events**: nulia already emits `nuncia/security-event`; the bridge
  subscribes **on the root context** (cordis emit bubbles child→root; a sibling
  listener never sees it) and forwards to `POST /api/a2a/event` → log +
  termux-notification when Termux:API is present (best-effort; the AVD has no
  Termux:API app, so it degrades to log + panel) + panel list.
- One test proves the root-level subscription receives the plugin's emission.

#### P3.4 — peer memory join, names, docs, acceptance

- The panel joins configured peers (from `/status`) with registry last-seen —
  display only; nulia stays barebones (discussion point 3).
- Sylvia ships `assets/node-names.txt` (human-supplied list), seeded to
  `~/.sylvia/node-names.txt` on install, wired as `nodeNameFile` for fresh
  nodes.
- Docs: README A2A section (install → pair → panel), troubleshooting rows
  (mint 401: admin token mismatch; card 401: expected — fetch with a bearer),
  DESIGN §20.12.1 acceptance record.
- Full acceptance on desk + AVD: card locked (401 unauth / 200 with bearer),
  minimal fields present, name generated from the file on a fresh node, admin
  token mint from the panel, approval Allow path, security-event notification,
  metered exemption both ways.

**Deferred (not assumed):** the `a2a_send` parity tool in sylvia-mcp — the
canonical agent-facing tool lives in the plugin; an MCP copy only adds value
for outside-harness callers (Tasker scenes). Marked optional until wanted.

**Not in P3:** Noise, key rotation (P4), hard per-level caps (P2 leftover), any
change to the authority semantics themselves.

### 20.12.1 P3.0 executed — the auth posture and the minimal card (2026-10-20)

The first half of P3 is implemented in `dsh-nuncia` and live on both nodes.
The operator's rule drove the design: *the endpoint serves, but only to
requests that carry a valid bearer; a client without one gets an invalid-auth
notice and never reaches a session or an agent.*

**What was wrong before.** A raw install — no `auth` block, no authority layer
— resolved to **no token at all**, and every bearer check was conditional on
a token existing (`if (authToken !== undefined && …)`). So the endpoint was
open to anyone who could reach the port. That was the "anyone who has
installed nuncia" gap.

**The posture now.**
- A node with no configured token **generates** one, persists it at
  `<stateDir>/bearer.token` (0600, never overwritten — a silent rotation would
  lock every peer out) and reports it once at boot. The endpoint is closed
  from the first second without a config step.
- The bearer is checked with a constant-time comparison, and two tokens may be
  accepted: the primary (config → env → derived-from-pairing-secret →
  generated) and an optional `auth.adminToken` / `auth.adminTokenEnv` — the
  Sylvia daemon's proxy key, an *additional* bearer, never the primary.
- A refused request gets `401 {"error":"unauthorized","detail":"a valid bearer
  token is required"}` and touches nothing: the P3 test asserts **zero
  sessions created** by a rejected request.

**The card is now a private surface.** `agentCard.public` defaults to false:
reading a node's card takes the same bearer as speaking to it
(`agentCard.public: true` is the explicit opt-out for scanners). The card
carries only what the operator asked for — **name, platform, last downtime end
(`since`), and a chatelaine-managed announcement** — in a
`capabilities.extensions` entry, because the SDK's `AgentCard.toJSON` drops
unknown top-level fields and extensions are the protocol's own place for
node-specific data. Peer address memory stays in Sylvia's registry; nuncia
stays barebones.

**Names.** `authority.nodeNameFile` (newline-delimited, `#` comments allowed):
with no configured name, the first boot picks one at random and remembers it in
`<stateDir>/identity.json`; with no file, the hostname. Precedence is
configured → persisted → file → hostname. The 5000-name list the operator
supplied lives at `assets/node-names.txt` in the Sylvia repo and is seeded to
`~/.sylvia/node-names.txt` by the installer (P3.4). Names are cosmetic:
collisions resolve by `kid`, which is already in every card, envelope and the
pairing `--check` flow.

**The announcement** is one bounded line (≤280 chars, whitespace collapsed):
`PUT {adminPath}/announcement` (loopback + bearer) and a `set_announcement`
tool that **only the chatelaine session may call** — what is worth publishing
is a judgement about the human's attention, not the operator's alone.

**Live acceptance** (2026-10-20):

| check | desk | avd |
|---|---|---|
| card without a bearer | 401 | 401 |
| card with a bearer | 200 + minimal node extension | 200 + `{"name":"avd","platform":"android-x64","since":…,"announcement":""}` |
| `/status` identity block | `{"name":"desk","nameSource":"config","platform":"win32-x64","kid":"7jsvWk5X142WqWk7","authSource":"derived","cardPublic":false}` | `{"name":"avd",…,"kid":"W0jttouSyxfHmnzx"}` |
| announcement round-trip | — | `PUT` → card shows it |
| raw install (generated token) | ✅ `test-p3-auth.mjs`: persisted 43-char token, 401 without it, no session created | — |

**Tests**: 139 unit (+8 identity) and **six** harnesses (+ `test-p3-auth.mjs`),
all green; `npm test` ≈ 19 s.

**A bug the tests caught**: the generated-token path used `dirname` without
importing it, and the surrounding `try/catch` swallowed the ReferenceError —
so the token was never persisted and every authenticated request failed. The
catch now logs, because a token nobody can read is a token nobody can share.

**Remaining in P3**: P3.1 (session tagging + `allowA2AOnMetered`), P3.2 (daemon
proxy + dashboard card), P3.3 (push notifications), P3.4 (installer seeding of
the names file, registry join, docs).

### 20.12.1 P3.1 executed — the A2A tag, and what the session format actually allows

**The plan was wrong about the carrier, and only a live device could say so.**
§20.12 P3.1 assumed the A2A tag would ride the durable session header
(`meta.origin`). The v4 format refuses it: `dsh-session` validates the header
on creation and allows **only** `origin: "subagent"` — anything else throws
`session header origin must be "subagent"`, and the throw happens *inside* the
agent creation, so the A2A task failed outright with
`Agent execution error: session header origin must be "subagent"`. No other
header field survives a restart, so there is no second durable field either.

**What replaced it: the session id.** A2A sessions are now named
`a2a-op-<level>-<taskId>` and `a2a-chatelaine-<uuid>`. The id is durable by
construction (it *is* the session identity), it is what every other surface
already keys on (records, events, the operator book, `agents.get`/`resume`), and
it needs no host support. Consequences, all handled:
- The record stays keyed by **task id**; `taskIdOfSessionId()` maps a tagged
  session id back to its task, and the `session/event` and
  `user-questions/request` listeners resolve records both ways.
- The operator book stores the **tagged** session id, so the chatelaine can
  reach a resumed operator after a restart.
- sylvia-bridge recognises an A2A session by the id prefix
  (`a2a-op-` / `a2a-chatelaine-`) instead of the header.

**Live acceptance on the AVD (2026-10-20)** — a fake metered daemon on
:3099 (the bridge's `daemonUrl` pointed at it) so the gate could be exercised
without real metered data on an emulator; the bridge's poll hits confirmed it
was live:

| run | `allowA2AOnMetered` | turn/end | task |
|---|---|---|---|
| 1 | `false` | `aborted: hook — sylvia-netgate: metered` | killed by the gate |
| 2 | `false` | `aborted: hook — metered (stream committed)` | killed after the stream committed |
| 3 | `true` | **`completed`** | `TASK_STATE_COMPLETED`, artifact `EXEMPT OK` |

So the gate really does stop A2A work by default (fail-closed), and the
exemption really does let it finish. The abort reason also proves the P2 triage
work: a gate-killed turn is reported as an abort, not as a success.

**Two smaller findings from the same run.** (1) The v4 header has no room for
"who made this session", so the id prefix is the only honest carrier — worth
remembering before proposing any other header field. (2) The standalone P3
harness ended with a win32 libuv assertion (`UV_HANDLE_CLOSING`) because the
plugin's HTTP server was still open when `process.exit()` ran; the fix is to
await the plugin's disposers and set `process.exitCode` instead of forcing the
exit — the same trip the smoke harness hit earlier.

**State now:** P3.0 done (auth always-on, generated bearer, private minimal
card, announcement, admin token, name pool); P3.1 done (tag + metered
exemption, unit + live); P3.2 in progress (daemon proxy + dashboard card —
the proxy and the first card exist, the revoke/roster/events/badge work and
the live daemon→nuncia→dashboard acceptance do not).

### 20.12.2 P3.2 executed — the daemon proxy and the panel's A2A card

The panel reaches nuncia through the **daemon**, not directly: the plugin's
mint/revoke are loopback-only (a bearer alone must never let a paired peer
grant itself intent), and the daemon *is* the loopback client. The proxy
speaks to the plugin with the additional `auth.adminToken` (a second accepted
bearer, never the primary peer token).

**The proxy** (`sylvia-daemon/src/a2aproxy.js`) allows a fixed route set
(`status`, `mint`, `revoke`, `requests`, `requests/decide`, `announcement`,
`rules`, `operators`, `operators/prune`), blocks unknown routes, wrong
methods and path traversal, and never makes an unauthenticated plugin call.
Its failures are explicit: `503` when no admin URL or token is configured,
`502` when the plugin is unreachable, and a non-JSON body is reported rather
than swallowed.

**The card** reads one payload (`/api/a2a/status`) and renders: node name +
kid, authority badge, live grants, rejected-claim count, operator roster,
chatelaine state, the announcement editor, pending approvals with
Allow-once/Deny, recent security events, and mint/revoke controls.

**A contract bug the live run caught.** The card had been written against an
*imagined* status shape: it read `authority.grants` as an array (the plugin
returns `{origin, grants:[…]}`) and read `grant.exp` (the plugin sends
`expiresAt`). Both would have rendered an empty grant table forever. Fixed
after diffing the card's reads against the plugin's actual payload — the
lesson is the same one from the P1 work: a client written from a shape
*believed* to be right is worth nothing until it runs against the real one.

**Live acceptance (2026-10-20), both nodes:**

| step | desk | AVD |
|---|---|---|
| `/api/a2a/status` through the proxy | ✅ | ✅ |
| mint (intent, scope, ttl) | ✅ `mF3IdWCH…` → avd | ✅ `KzIAaJlK…` → desk |
| grant visible in `/status` | ✅ | ✅ |
| revoke | ✅ `revoked: true` → list empty | ✅ `revoked: true` → list empty |
| operators roster | ✅ | ✅ (2 operators, ages, expiries) |
| announcement set/read | ✅ | ✅ `P3.2 acceptance: panel proxy live` |
| approval queue | ✅ (`{ok, approvalMode, pending:[]}`) | ✅ |
| dashboard serves the card | ✅ | ✅ (`a2a-kv`, `a2a-operators`, `g.expiresAt` present) |

The PC daemon needed an `auth.adminToken` in the profile to match the
daemon's `NUNCIA_ADMIN_TOKEN`; without it the proxy answers 401 — a clear,
correct failure (the two sides must agree on the admin key).

**State now:** P3.0 done, P3.1 done, P3.2 done (proxy + card, contract
verified live on both nodes). Next: **P3.3** — the push path (approvals via
`approveCommand`, security events via a root-context bridge subscription) and
**P3.4** (the installer's name-pool seeding is in; the registry last-seen join
and the README A2A section remain).

---

### 20.12.3 P3.3 executed — the vault, the tripwire, and the netgate exemption (2026-10-20)

Three things closed in this pass, and two of them were defects that only
showed up when the pieces met.

#### The encrypted secret vault

The pairing secret and the A2A admin token used to live in `sylvia.env` as
plaintext `export` lines, on the same disk as everything else. They are now
in ONE AES-256-GCM file (`secrets.enc`) under a scrypt-derived key, and the
only thing outside the vault is the passphrase (`~/.sylvia/.secret-key`,
mode 0600, and `SYLVIA_SECRET_KEY` in the env file).

The plugin decrypts at boot (`loadVaultIntoEnvironment`) and **fills only the
names the environment does not already set** — the environment still wins, so
a one-off override keeps working and a node with no vault behaves exactly as
before. A missing vault, a wrong key, a tampered file: all non-fatal. The
vault is an improvement, not a new way to fail at boot.

**What this does and does not buy.** It stops accidental disclosure — grep,
a copied config, a profile patch, a chat log. It does **not** stop a local
agent: DSH runs `danger-full-access`, so a same-uid agent can read the key
and call the decryptor itself. That residual is the §20.6 one, stated
honestly: the vault raises the cost of *finding* the key, and makes every
use of it **visible**.

#### One tripwire, not three

That visibility is the point, so the audit log has to be complete. It was
not: the plugin wrote `<stateDir>/secrets-access.log`, the daemon wrote
`<stateDir>/secrets/secrets-access.log` — a **directory that never exists**,
so every daemon append failed and was swallowed, and the daemon's trail
recorded *nothing* — and the CLI pointed at the home directory.

All three now default to a **sibling of the vault** (`dirname(vault)/
secrets-access.log`), so they agree with no configuration at all, and
`config.secrets.auditFile` can point them elsewhere on purpose. The
installer reports the path when it writes the vault.

The lesson is the same one as the P2 panel: *a tripwire that silently
records nothing is worse than no tripwire*, because it is a false assurance.

#### The secrets leave the env file

The vault bought nothing while the plaintext was still sitting next to the
passphrase. `install.sh` now deletes the `NUNCIA_PAIRING_SECRET` /
`NUNCIA_ADMIN_TOKEN` exports once the vault is written — the env file keeps
the passphrase and nothing else.

#### The netgate exemption (§20.5, finally built)

§20.5 promised that A2A work survives a metered network when the operator
says so. Nothing implemented it: the netgate stopped every managed service
and the bridge cancelled every session, so a remote operator died the moment
the phone metered.

The **daemon** now owns that decision:

- `netgate.register(name, pgid, note, {exempt})`; `hold()` skips an exempt
  service and reports it, and `resume()` never SIGCONTs a service that
  never stopped.
- `POST /api/netgate/services` accepts `{exempt}`, and
  `POST /api/netgate/services/exempt {name, exempt}` flips one service.
- `SYLVIA_A2A_EXEMPT_FROM_GATE` (default **FALSE** — fail closed) makes
  always-on modules exempt by default.
- `GET /api/network` carries `a2aExempt`, so the bridge sees the decision.

The **bridge** honours it: `isExempt(agent)` is true when the operator
opted in **or** the daemon says so, **and** the session is an A2A one. An
ordinary session is never exempt — the exemption is per-session, never a
blanket "ignore the network".

#### The chatelaine resilience fix

A separate defect, found while proving the above: the P3.1 id migration
renamed the chatelaine session id **without moving the session directory**,
so the stored id pointed at nothing and `agents.resume()` found no session.
Every `report_to_chatelaine` on **both** nodes failed with "chatelaine
session is not reachable" — silently, on every operator, forever.

`resolveAgentFrom()` now tries the candidates in order (the current id, the
id it replaced, the configured one) and returns the first that resolves. A
report falls back to the **previous thread** when the current one is gone,
and only if nothing resolves does it create a fresh session and deliver into
that. It never throws into the calling turn: a failed report returns
`{delivered:false, reason}`.

The deeper lesson: **renaming an identifier is not renaming the thing.**
Anything that survives a restart — a session id, a state file, a key — has to
be migrated *with* whatever it points at, or the pointer is a lie. The
tagged id is what the metered gate recognises; the untagged directory is
where the thread actually lives; the two must agree.

**Live acceptance (2026-10-20), both nodes:**

| step | desk | AVD |
|---|---|---|
| vault opens; `authSource: derived` | ✅ | ✅ |
| tripwire records the read | ✅ `source=vault:file:…` | ✅ `source=vault:env:SYLVIA_SECRET_KEY` |
| plugin and daemon write the SAME file | ✅ (one `secrets-access.log`) | ✅ |
| `report_to_chatelaine` lands in the chatelaine thread | ✅ `CHATELAINE RESILIENCE OK` in `session-04fb2136…` | ✅ `AVD CHATELAINE RESILIENCE OK` in `session-93281439…` |
| node identity / peer pin agree | ✅ desk `7jsvWk5X142WqWk7` ⇄ avd `W0jttouSyxfHmnzx` | ✅ |
| `/status` reports `a2aExempt` | ✅ | ✅ |

**The key reconciliation.** Three identities existed: the PC plugin was
actually running with `LKlivB0WOSTdG6p6` (a stray key in the repo root),
while the profile pointed at `7jsvWk5X142WqWk7` — which is what the AVD had
pinned as peer `desk`. The live node now reports `7jsvWk5X142WqWk7` and the
AVD pins exactly that, so the pair verifies. The stray root key is gitignored
(`.gitignore` now tracks `*.key`, `secrets.enc`, `.secret-key`,
`secrets-access.log`) and is not used.

**State now:** P3.0–P3.3 done and verified live on both nodes. P3.4 remains:
the registry last-seen join, the README's A2A section, and the arm64
physical-device acceptance.

## 20.13 P3.4 review round — the chatelaine channel, the materialised tag, and an audit (2026-10-20)

Six questions from the operator produced one new capability, three defects, and
an audit of §20 against the shipped build. All of it is implemented and live.

### 20.13.1 `message_peer_chatelaine` — the missing relationship

The plugin could already speak to its OWN chatelaine (`report_to_chatelaine`),
to a local operator (`reply_to_operator`), and to a peer node as a task
(`a2a_send`) — but there was no way for one node's chatelaine to reach a
PAIRED node's chatelaine. `a2a_send` was the wrong instrument: it opens an
operator task on the far side, i.e. it asks the peer's *worker* to do
something. Two humans' representatives talking is not an operator task.

The channel is a *delivery*, not an execution:

* sender — `message_peer_chatelaine({peer, message})`, chatelaine-only
  (ownership check against `chatelaine.peekId()`; anyone else is told to
  report the intent to the chatelaine instead). It rides `a2a_send` with
  `metadata.toChatelaine = true` beside the authority envelope.
* receiver — the executor branches BEFORE operator creation. With a verified
  `intent`/`override` grant it publishes an acknowledgement task and calls
  `chatelaine.report(text, {wake:true})`; no operator session is created and
  nothing executes on the receiving node. Without such a grant it refuses
  outright: *"this node accepts chatelaine-to-chatelaine messages only with a
  verified intent grant carrying metadata.toChatelaine — no such grant
  arrived, so the message was not delivered"*.

The grant requirement is not ceremony. The bearer proves a paired *client*;
injecting text into the human's representative is precisely the
social-engineering surface the authority layer exists to close, so the peer
must have asked its own human for the privilege first.

Live: desk minted `intent`/`chatelaine-channel` for avd and delivered
`Greetings from desk…`; it landed in `a2a-chatelaine-93281439…` as
`agent/inbox/spliced` + a `plugin:dsh-nuncia` message. The same message with
no envelope failed with the text above.

### 20.13.2 The chatelaine session now actually exists

The operator suspected it was never created. Correct, for a specific reason.

P3.1 renamed the stored chatelaine id from `session-<uuid>` to
`a2a-chatelaine-<uuid>` so the metered gate could recognise it by prefix. But
a v4 session's id lives INSIDE its own header — `dsh-session`
`validateSessionHeader` throws *"session header id … does not match session
id …"* — so a session cannot be renamed. The migration rewrote the pointer and
left the old directory behind: `/status` advertised a tagged id that no
session answered to, the prefix matched, and the gate's exemption applied to
nothing.

`ensureTagged()` closes it: it resolves the stored tagged id, probes whether
a session exists, and if not CREATES one under that exact id. `resolveId()`
calls it before returning, and `report()` resolves the tagged id FIRST and
only then tries the historical ids as fallbacks — so a report lands in the
tagged thread rather than silently in the untagged one. The untagged thread is
never deleted; it is the fallback and the history.

Live: `a2a-chatelaine-93281439…` now exists on the AVD and
`a2a-chatelaine-04fb2136…` on the PC, both created by this path.

### 20.13.3 `glob`/`grep`/`search` failed: a platform-gated npm package, again

`SEARCH_FAILED … ripgrep launch failed` was not a Termux problem and not
fixable by putting `rg` on `PATH`. `dsh-tool-fs-search.resolveRgPath()`
imports `@vscode/ripgrep`, which resolves
`@vscode/ripgrep-${process.platform}-${arch}/bin/rg`. Termux reports
`platform === 'android'`, and `@vscode/ripgrep@1.18.0` publishes **no android
package** — the same class of gap as `node-addon-system`'s missing flock
binding (§20.9). The resolution is inside a stock DSH package, so the fix
supplies the missing platform package rather than patching code.

`install.sh` now installs `ripgrep` and writes
`<dsh>/node_modules/@vscode/ripgrep-android-<arch>/` containing a
`package.json` and a `bin/rg` shell shim that `exec`s the Termux binary, then
PROVES it from the CLI's own root: the import must resolve and
`rg --version` must exit 0. Verified on the AVD (resolution →
`…/ripgrep-android-x64/bin/rg`; `rg --files --glob *.md` returned the file).

### 20.13.4 The audit: §20 against the build

Everything specified through P3.3 is implemented and live-verified. What this
round changed or found:

| item | state |
| --- | --- |
| P2.4 authority rejection → chatelaine notice | **closed now.** `recordSecurityEvent` fires `securityHooks.chatelaine` with peer, reason, task and the "treat it as an attempt to act in your name" instruction. Live on the AVD (forged envelope → one notice in the chatelaine thread). |
| P2.4 `approveCommand` with `NUNCIA_EVENT` | **closed now.** `fireApproveCommand()` is shared by the approval announcement (`approval-requested`) and the security hook (`authority-rejected`); one script does both jobs. |
| P2.2 stable chatelaine session | **corrected** (§20.13.2): the id was tagged but the session did not exist. |
| P3.4 registry last-seen join | open. |
| P3.4 README A2A section | open. |
| P3.4 arm64 physical-device acceptance | open. |
| chatelaine → peer chatelaine | **new** (§20.13.1), unspecified before this round. |

Two findings outside §20 that affect it:

* **Termux:Boot is not installed on the AVD** (`pm list packages` has no
  `com.termux.boot`), so `~/.termux/boot/10-sylvia.sh` never runs and nothing
  survives a device restart — harness, daemon and modules all stay down. The
  installer seeds the script and warns; the app must be installed from F-Droid
  and opened once.
* **the `mdns` module can never run on Termux.** Android has no
  `avahi-daemon`/`mdnsd` CLI (discovery is the framework's NSD) and Termux
  ships neither package, yet the module was `behavior: always`. The daemon
  restarted it forever (death streak 7, exponential backoff) — an "always on"
  service that is never on. It is now `manual`, and `on.sh` explains why and
  exits 2. `9router` is `manual` by design, so a reboot leaves the model route
  down until it is started.

### 20.13.5 The dashboard's "Open DSH" link

`GET /api/dsh-url` was already correct — the AVD returned a tokened URL with
`verify: accepted`. The failure is the client: the anchor's static `href` was a
tokenless `http://127.0.0.1:3080`, so any navigation before (or without) a
successful refresh landed on a 401 page with the query string gone. The static
href is now empty and a click handler refuses to navigate without a token: it
fetches `/api/dsh-url` first, refuses if the harness has not minted one, and
falls back to a same-tab assignment if the popup is blocked.

### 20.13.6 Tests

plugin 155/155 + six harnesses (SMOKE, AUTHORITY, TOOLS, AUTH, P2, P3-AUTH);
daemon 153/153; bridge 39/39. `test-tools.mjs` now asserts six tools and that
a non-chatelaine caller is refused `message_peer_chatelaine`;
`test-chatelaine-resilience.test.mjs` asserts a migrated-but-absent id is
created UNDER THAT ID rather than silently using the untagged thread.
## 20.14 P4 plan — one chatelaine per device, and it must actually run (2026-10-20)

The §20.13 chatelaine-to-chatelaine channel is withdrawn. The chatelaine's
job is to **centralize decision-making for the local device**; a mesh of
chatelaines has no single decision authority per device, and every cross-node
conversation becomes a second thread that can diverge from the operator task
carrying the work. Peers reach this node as *tasks* (`a2a_send` → operator);
an operator escalates to its own chatelaine; the chatelaine decides. That is
the whole topology.

### 20.14.1 Two defects that made the layer decorative

**It was never woken.** `report()` delivered with `inject` unless `wake` was
requested, and `report_to_chatelaine` requested it only for a `question`.
`inject` is `send(msg, "next-step", false)` — durable inbox, no turn. Both
chatelaine sessions had exactly one `turn/start`, and on both nodes that turn
was started by a test message using `wake: true`; **no operator report ever
caused a turn.** The tool's render said "the chatelaine will see this on its
next turn" and there was never a next turn.

**It had no role.** `createSession()` passed `{cwd, agentPreset}` and
nothing else. `operatorBrief()` exists for operators only, so the chatelaine
woke as an unlabelled session with one message and no idea what it was —
which is why operators narrated as the chatelaine: nothing distinguished the
roles, and the report render invited the model to continue in that voice.

There is also no title API in this train (`title` appears in no field of
`dsh-agent-loop`, `dsh-session-query` or `dsh-api-session-controller`;
`session/title` is an allowlisted event with no consumer), so a chatelaine
cannot be "labelled" — it is identified by its `a2a-chatelaine-<uuid>` session
id and by its brief.

### 20.14.2 The tool set (decided 2026-10-20)

| tool | caller | effect |
| --- | --- | --- |
| `message_chatelaine` | **any local session** | delivers to the local chatelaine, labelled with the caller's identity (operator task/handle, or a local session id). The entry point for a non-nuncia local agent that wants A2A reach. |
| `a2a_send` | **chatelaine only** | sends to any A2A endpoint. A nuncia peer gets an operator session; anything else gets a plain task. |
| `send_nuncia` | **chatelaine** (initiate) and **operator** (reply on its own task only) | nuncia-to-nuncia. First contact and replies are the same operator task, so a peer's follow-up continues the conversation it already started. |
| `message_local_session` | **operator**, only on a path the chatelaine approved for that (operator, session) pair | delivers to a local session. |
| `approve_local_contact` | **chatelaine only** | records/revokes an (operator → local session) path. |
| `request_user_intent` | **chatelaine only** | mints a grant. An operator no longer asks the human directly; it asks the chatelaine. |
| `set_announcement` | chatelaine only | unchanged. |

Removed: `report_to_chatelaine` (merged into `message_chatelaine`),
`reply_to_operator` (replaced by `send_nuncia`; the chatelaine answers a local
operator through `message_local_session`), `message_peer_chatelaine` (§20.13
withdrawn), and the inbound `metadata.toChatelaine` executor branch.

Rationale for the ownership inversion: today `a2a_send` and
`request_user_intent` are unguarded while `set_announcement` is gated — any
local session, or any operator, can send A2A tasks and mint authority in this
node's name. The rule is now: **outbound reach and authority are the
chatelaine's; operators execute inside a grant and escalate.**

### 20.14.3 The chatelaine must persist and must be briefed

The session is a normal v4 session on disk; the plugin never stores its
content. What it stores is the identity, in `<stateDir>/chatelaine.json`:

```
{ "version": 1, "sessionId": "a2a-chatelaine-…", "previousSessionId": "…",
  "briefVersion": 1, "briefedAt": "…" }
```

That file lives outside the plugin tree, and a reloaded plugin *resumes* the
session rather than recreating it, so **both survive a plugin upgrade**. The
guards that make that true:

* never create over an id that already has a session — probe `agents.get`,
  then `agents.resume`, and treat "exists" as success;
* never rewrite `sessionId` except through the explicit new-session command
  (which records `previousSessionId`);
* the brief is injected once per `briefVersion` per session id, not on every
  boot (an unbriefed-but-existing session must still get it).

At boot the plugin creates the session if it is missing, briefs it, and wakes
it **once when it was newly created** — so a fresh node has a real, visible
chatelaine with an actual first turn — but does not burn a turn on every
restart.

`POST {adminPath}/chatelaine/new` (loopback + bearer) and
`bin/nuncia-chatelaine.js new|show|brief` create a **new** chatelaine session,
brief it, record the previous id, and return the new id. The operator then
pastes a billion-context handoff into that thread by hand. Context remains
self-managed; the plugin only guarantees identity, brief and delivery.

### 20.14.4 Wake policy (decided 2026-10-20)

A report must not be a silent write. Delivery is durable `inject` plus a
**coalesced wake**:

* `question: true` wakes immediately (`followup`, no timer);
* ordinary reports arm a single unref'd 30 s timer; when it fires the
  chatelaine gets one `followup` carrying a "N reports are pending — read them
  before acting" notice, so a burst of reports costs one turn, not N;
* a report that arrives while a wake is armed does not re-arm it;
* if the chatelaine is mid-turn the inbox item is consumed at the next step,
  and the timer still fires so the turn is not left half-informed.

Delivery is still durable-first: a crash between inject and wake leaves the
report in the inbox, and the next wake picks it up.

### 20.14.5 Order of work

1. **P4.1 identity** — `chatelaineBrief()`, boot create/brief/wake-once,
   `briefVersion` bookkeeping, `POST /chatelaine/new` + CLI, persistence
   guards. Acceptance: a fresh node has a briefed chatelaine with one turn; a
   plugin reload keeps the same id and does not re-brief; `new` produces a
   second session with `previousSessionId` recorded.
2. **P4.2 ownership** — the matrix in 20.14.2, including the three removals
   and the inbound-branch deletion. Acceptance: an operator calling
   `a2a_send`/`request_user_intent` is refused by name; a local session cannot
   call them but can call `message_chatelaine`; an operator cannot call
   `send_nuncia` for a task that is not its own.
3. **P4.3 wake** — coalescing, question bypass, crash-safe ordering.
   Acceptance: one report produces exactly one turn within ~30 s; five
   reports in a burst produce one turn naming five; a question produces a turn
   immediately.
4. **P4.4 local contact** — `approve_local_contact` + `message_local_session`
   with a path table (TTL optional). Acceptance: an unapproved pair is
   refused with the reason; after approval the message lands; revoking stops
   it.
5. **P4.5 docs/tests/deploy** — suite additions, README table, DESIGN
   record, deploy to desk and the AVD, two-node acceptance.

### 20.14.6 Still open from P3.4

The registry last-seen join, a dedicated README A2A section, and the arm64
physical-device acceptance. None of them block P4; they should be picked up
before calling §20 finished.
### 20.14.7 P4.1 as built — two DSH constraints that decide visibility

The chatelaine is now created at boot, in its own directory, attached to its own
workspace, briefed and woken once. The implementation had to respect two
properties of DSH that are not obvious and that the first attempt got wrong:

**A session is listed only if it is attached to a workspace record.** The client
groups by `workspace.sessionIds` and everything else falls into an ungrouped
bucket (`dsh-client-ui-workspace`, `owningGroupKey`). The plugin created the
session and never called `attachSession`, so the human could not see or open it
— verified in `~/.dsh/storages/workspace.json`, where the `Housekeeping` record
listed three operators and no chatelaine.

**The label is the basename of the workspace path, and the workspace path must
equal the session's own `header.cwd`.** `attachSession` normalizes
`header.cwd`, requires it to resolve, and validates it against the workspace
path. A session's cwd is fixed in its v4 header and cannot be changed, so a
chatelaine created under the operators' directory can NEVER be attached to a
`Chatelaine` workspace. Sharing the operators' directory would also label it
`housekeeping`, indistinguishable from a worker.

Consequences, all implemented:

* default `chatelaine.cwd` is `<housekeeping workspace>/chatelaine`, giving a
  workspace titled `Chatelaine` whose basename reads as the chatelaine's name;
* the directory is created **before** the session. A session created ahead of
  its directory fails its first turn with
  `working-directory: directory does not exist` — observed live on the AVD;
* on boot, a stored session whose cwd differs from the configured one is
  **relocated**: a fresh session is created in the right directory and the old
  id is kept as `previousSessionId`. Without this, an upgraded node keeps an
  invisible chatelaine forever;
* `ensure()` is idempotent: an existing session is resumed (never recreated) and
  a briefed session is not re-briefed, so a plugin reload costs no turn;
* `POST {adminPath}/chatelaine/new` and `bin/nuncia-chatelaine.js new` cut over
  to a fresh session, brief it and wake it, so a handoff can be pasted in by
  hand. `GET {adminPath}/chatelaine` (and `nuncia-chatelaine.js show`) report
  where the thread is.

Live: PC `a2a-chatelaine-15bfde54…` and AVD `a2a-chatelaine-98d88e68…`, both in
`<housekeeping>/chatelaine`, both attached (`workspace.json` shows the session
in the record), both briefed (`briefVersion: 1`) and both running a real first
turn. Acceptance is `tests/test-p4-chatelaine.mjs` (28 checks), which uses a
strict `agents.resume` (a session that was never created cannot be resumed) and
a `workspaceRegistry` that refuses to attach a session whose header cwd is
missing — the two permissive fakes that hid this class of bug.