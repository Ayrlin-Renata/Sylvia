# Sylvia — Design Notes

Living design document for the Sylvia agent-harness project. Keeps architecture decisions on track across sessions.
Companion docs: `README.md` (user install), `install.sh` (installer), `sylvia-mcp/` (MCP server source).

Related repos (reference only, not shipped): `reference/Deepseek-harness-mobile` (our fork of DSH Mobile),
`reference/tasker-mcp`, `reference/mitmproxy-mcp`.

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
`reference/Deepseek-harness-mobile`). Analysis done; execution awaits sign-off.

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

- `reference/` clones are dev-only (never shipped); changes stay local until pushed
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
