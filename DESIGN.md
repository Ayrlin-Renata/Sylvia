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

## 15. Open questions / verify in emulator

- `pre-step` `{kind:'reject'}` semantics (skip step vs end turn) — confirm against bundled types.
- `dumpsys` format drift → tolerant parser; cross-check in emulator Logcat (same session as Tasker-intent verification).
- Post-`SIGCONT` sockets dead → treat as retryable (handled by `agent/request-error` → `{kind:'retry'}`).
- nmap integration: daemon-native vs wrapped `nmap-mcpserver` (§7).
- Module scripts: sandbox/allowlist review for `on.sh`/`off.sh`/`settings-edit.sh` (arbitrary shell executed by the
  daemon — ship only reviewed modules, treat user-added ones as trusted-local).
- Device identity promotion thresholds (sightings/time for provisional → corroborated).
- Off-LAN reachability for §9 (tunnel choice) — deferred.
