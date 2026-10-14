#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./src/config.js";
import { AdbManager } from "./src/adb.js";
import { taskerWriteAndReload } from "./src/tasker.js";
import { rcloneJson } from "./src/rclone.js";
import { networkState, trafficGate, registryList, registryResolve, discoveryScan } from "./src/daemon.js";
import { log } from "./src/log.js";

const cfg = loadConfig();
const adb = new AdbManager(cfg);

// MCP tools return content blocks. We always return a single text block whose
// payload is JSON (or plain text on failure) — the harness bridge surfaces text
// to the model, so keeping it structured-but-readable works for both.
function ok(data) {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
	// isError:true makes the bridge throw a tool error the model can react to,
	// instead of silently reading a failure as a normal result.
	return { content: [{ type: "text", text: String(message) }], isError: true };
}

const server = new McpServer({ name: "sylvia-mcp", version: "0.1.0" });

// --- resilient_adb_exec ---------------------------------------------------
server.registerTool(
	"resilient_adb_exec",
	{
		title: "Resilient ADB Exec",
		description:
			"Execute a shell command on the Android device over the local ADB loopback. " +
			"If the ADB connection has dropped, this tool automatically re-establishes the " +
			"loopback (rediscovering the wireless-debugging port on physical devices, or the " +
			"fixed 5555 port on the emulator) and retries before giving up — callers do not " +
			"need to manage ADB connectivity. Use mode='raw' to run a non-shell adb subcommand " +
			"(e.g. ['push','pull','logcat','-L']).",
		inputSchema: {
			command: z
				.string()
				.optional()
				.describe("Shell command to run on the device (required when mode='shell')."),
			args: z
				.array(z.string())
				.optional()
				.describe("Argument vector for the adb binary (required when mode='raw')."),
			mode: z
				.enum(["shell", "raw"])
				.default("shell")
				.describe("'shell' runs `adb shell <command>`; 'raw' runs `adb <args...>`."),
			timeoutMs: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Per-attempt timeout in milliseconds (default 30000)."),
			allowReconnect: z
				.boolean()
				.default(true)
				.describe("If true, re-establish the loopback and retry when the connection drops.")
		}
	},
	async ({ command, args, mode, timeoutMs, allowReconnect }) => {
		try {
			let argv;
			if (mode === "raw") {
				if (!Array.isArray(args) || args.length === 0) {
					return fail("resilient_adb_exec: mode='raw' requires a non-empty `args` array");
				}
				argv = args;
			} else {
				if (typeof command !== "string" || command === "") {
					return fail("resilient_adb_exec: mode='shell' requires a non-empty `command` string");
				}
				argv = ["shell", command];
			}

			// allowReconnect=false collapses retries to a single attempt by
			// temporarily zeroing the retry budget (restored afterward).
			const savedRetries = cfg.adbMaxRetries;
			if (!allowReconnect) cfg.adbMaxRetries = 0;
			let result;
			try {
				result = await adb.exec(argv, { timeoutMs });
			} finally {
				cfg.adbMaxRetries = savedRetries;
			}

			// Path A enrichment (§6.3): if the command mentions IPs, resolve
			// them against the registry so the model sees identity context
			// (allow/ask gates) without a separate resolve round-trip.
			let networkContext;
			try {
				const mentions = [command ?? "", ...(args ?? [])].join(" ");
				networkContext = await resolveCommandIps(mentions);
			} catch {
				networkContext = []; // best-effort; never fail the exec
			}

			return ok({
				ok: result.code === 0,
				exitCode: result.code,
				serial: result.serial,
				reconnected: result.reconnected,
				attempts: result.attempts,
				timedOut: result.timedOut === true || undefined,
				stdout: truncate(result.stdout),
				stderr: truncate(result.stderr),
				...(networkContext.length > 0 ? { networkContext } : {})
			});
		} catch (err) {
			return fail(`resilient_adb_exec failed: ${err.message || err}`);
		}
	}
);

// --- tasker_write_and_reload ---------------------------------------------
server.registerTool(
	"tasker_write_and_reload",
	{
		title: "Tasker Write + Reload",
		description:
			"Write a Tasker project XML file to the shared Tasker directory (/sdcard/Tasker/) " +
			"via adb push, then fire the reload broadcast so Tasker re-reads it — bypassing " +
			"Tasker's limited HTTP API. The XML must be a Tasker project export rooted at " +
			"<TaskerData>. Filename must end in .prj.xml / .tsk.xml / .prf.xml. Use this to " +
			"author NEW tasks; use tasker-mcp to enable/disable/run existing ones without " +
			"rewriting them.",
		inputSchema: {
			xml: z.string().describe("Full Tasker project XML, rooted at <TaskerData>."),
			filename: z
				.string()
				.optional()
				.describe("Target filename (must end in .prj.xml/.tsk.xml/.prf.xml). Auto-generated if omitted."),
			reload: z
				.boolean()
				.default(true)
				.describe("Fire the reload broadcast after writing.")
		}
	},
	async ({ xml, filename, reload }) => {
		try {
			const result = await taskerWriteAndReload(adb, cfg, { xml, filename, reload });
			return ok(result);
		} catch (err) {
			return fail(`tasker_write_and_reload failed: ${err.message || err}`);
		}
	}
);

// --- rclone_exec ----------------------------------------------------------
server.registerTool(
	"rclone_exec",
	{
		title: "rclone Exec (JSON)",
		description:
			"Run an rclone command with `--json` forced on, returning machine-readable output " +
			"instead of CLI text. Pass the subcommand and operands as an array, e.g. " +
			"['sync','remote:bucket','local:/sdcard/Backup'] or ['size','remote:bucket']. " +
			"--json is appended automatically unless already present.",
		inputSchema: {
			args: z
				.array(z.string())
				.describe("rclone arguments after the binary name (subcommand + operands)."),
			timeoutMs: z.number().int().positive().optional().describe("Timeout in ms (default 60000).")
		}
	},
	async ({ args, timeoutMs }) => {
		try {
			const result = await rcloneJson(cfg, args, { timeoutMs });
			return ok(result);
		} catch (err) {
			return fail(`rclone_exec failed: ${err.message || err}`);
		}
	}
);

// --- network_state --------------------------------------------------------
server.registerTool(
	"network_state",
	{
		title: "Network State",
		description:
			"Report the device's current network state: transport (wifi|cellular|other|none), " +
			"whether it is metered (data-saver / cellular accounting), validation status, egress " +
			"interface, and which detection source produced the verdict. Reads the live " +
			"sylvia-daemon API; falls back to its persisted state file when the daemon is down " +
			"(staleness flagged). Check this BEFORE expensive network work — metered means " +
			"background syncs are being held (see traffic_gate).",
		inputSchema: {}
	},
	async () => {
		try {
			const { state, via, stale, at } = await networkState(cfg);
			return ok({ ...state, via, stale: stale ?? undefined, at: at ?? state.at });
		} catch (err) {
			return fail(`network_state failed: ${err.message || err}`);
		}
	}
);

// --- traffic_gate ---------------------------------------------------------
server.registerTool(
	"traffic_gate",
	{
		title: "Traffic Gate Control",
		description:
			"Inspect or manually control the netgate, which SIGSTOPs managed background " +
			"traffic (rclone syncs, mDNS, mitmproxy, always-on modules) while on metered data " +
			"or offline. action='status' reports hold state + registered services; 'hold' " +
			"pauses them now; 'resume' releases them (manual release is the normal way out " +
			"since auto-resume-on-reconnect defaults off). The gate does NOT touch the agent " +
			"harness itself. Requires the sylvia-daemon to be running.",
		inputSchema: {
			action: z
				.enum(["status", "hold", "resume"])
				.describe("status = read gate state; hold = pause managed traffic; resume = release it."),
			reason: z
				.string()
				.optional()
				.describe("Freeform reason recorded in daemon logs (default 'manual').")
		}
	},
	async ({ action, reason }) => {
		try {
			const result = await trafficGate(cfg, action, reason);
			return ok(result);
		} catch (err) {
			return fail(`traffic_gate failed: ${err.message || err}`);
		}
	}
);

// --- resource_list / resource_resolve / resource_call ----------------------
// Path A enforcement (§6.1): these tools are the policy boundary — the daemon
// evaluates the policy, hidden items are ABSENT (never redacted), ask items
// need explicit user approval before dispatch.

server.registerTool(
	"resource_list",
	{
		title: "List Known Resources",
		description:
			"List networks, devices, and resources Sylvia knows about, filtered by the " +
			"access policy. Items the policy hides are ABSENT from the result (not redacted). " +
			"Each item carries __gate: 'allow' (usable now) or 'ask' (needs user approval).",
		inputSchema: {
			query: z
				.string()
				.optional()
				.describe("Substring filter over name/id/ip (case-insensitive)."),
			types: z
				.array(z.string())
				.optional()
				.describe("Only return resources of these types (e.g. ['image-generation','llm']).")
		}
	},
	async ({ query, types }) => {
		try {
			const [networks, hosts, resources] = await Promise.all([
				registryList(cfg, "networks"),
				registryList(cfg, "hosts"),
				registryList(cfg, "resources")
			]);
			const q = (query ?? "").toLowerCase();
			const match = (e) =>
				!q ||
				[e.name, e.id, e.ssid, ...(e.ips ?? [])]
					.filter(Boolean)
					.some((s) => String(s).toLowerCase().includes(q));
			const wantTypes = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
			const out = {
				networks: networks.items.filter(match),
				hosts: hosts.items.filter(match),
				resources: resources.items.filter(
					(e) => match(e) && (!wantTypes || wantTypes.has(e.type))
				)
			};
			return ok({
				...out,
				counts: {
					networks: out.networks.length,
					hosts: out.hosts.length,
					resources: out.resources.length
				}
			});
		} catch (err) {
			return fail(`resource_list failed: ${err.message || err}`);
		}
	}
);

server.registerTool(
	"resource_resolve",
	{
		title: "Resolve Network Identity",
		description:
			"Resolve an IP, hostname, or name to a known network/host/resource with its " +
			"identity confidence (confirmed|corroborated|provisional) and access gate. " +
			"Hidden items come back as an empty match list (indistinguishable from unknown — " +
			"this is intentional fail-closed behavior).",
		inputSchema: {
			ip: z.string().optional().describe("IPv4/IPv6 address to resolve."),
			hostname: z.string().optional().describe("Hostname or mDNS name to resolve."),
			name: z.string().optional().describe("Registry name or id to look up.")
		}
	},
	async ({ ip, hostname, name }) => {
		if (!ip && !hostname && !name) {
			return fail("resource_resolve requires at least one of: ip, hostname, name");
		}
		try {
			const res = await registryResolve(cfg, { ip, hostname, name });
			return ok({
				...res,
				note:
					res.matches.length === 0
						? "No visible match — either unknown to the registry, or hidden by policy."
						: undefined
			});
		} catch (err) {
			return fail(`resource_resolve failed: ${err.message || err}`);
		}
	}
);

server.registerTool(
	"resource_call",
	{
		title: "Call a Resource",
		description:
			"Dispatch an action to a known resource, enforcing the access policy: hidden → " +
			"refused, ask → requires explicit user approval in chat first, then retry with " +
			"confirmedByUser=true. Supported transports: http (fetch), adb (device shell). " +
			"Other transports (mcp-stdio/mcp-http/custom) are not yet dispatched by this tool.",
		inputSchema: {
			id: z.string().describe("Resource id (from resource_list / resource_resolve)."),
			action: z
				.string()
				.optional()
				.describe("Action name (transport-specific; http defaults to GET)."),
			args: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Transport-specific arguments: http → {method, path, headers, body}; " +
						"adb → {command}."
				),
			confirmedByUser: z
				.boolean()
				.default(false)
				.describe("Set true ONLY after the user explicitly approved this call in chat.")
		}
	},
	async ({ id, action, args, confirmedByUser }) => {
		try {
			const res = await registryResolve(cfg, { name: id });
			const entity = res.matches.find((m) => m.kind === "resource" && m.id === id);
			if (!entity) {
				// Unknown AND hidden are deliberately indistinguishable (§5).
				return fail(
					`resource_call refused: '${id}' is not a visible resource (unknown or hidden by policy).`
				);
			}
			if (entity.__gate === "ask" && !confirmedByUser) {
				return fail(
					`resource_call blocked by policy: '${id}' (type ${entity.type ?? "?"}) is gated 'ask'. ` +
						`Ask the user for explicit permission to use it in chat; if they agree, call again ` +
						`with confirmedByUser=true.`
				);
			}
			// Re-resolve as if gate were allow (confirmed) — hidden never reaches here.

			const transport = entity.transport ?? "http";
			const a = args ?? {};

			if (transport === "http") {
				const method = (a.method ?? action ?? "GET").toUpperCase();
				const base = String(entity.endpoint ?? "").replace(/\/+$/, "");
				const path = a.path ? (a.path.startsWith("/") ? a.path : `/${a.path}`) : "";
				const url = `${base}${path}`;
				const ac = new AbortController();
				const t = setTimeout(() => ac.abort(), cfg.daemonTimeoutMs * 3);
				let r;
				try {
					r = await fetch(url, {
						method,
						headers: a.headers,
						body: a.body === undefined ? undefined : typeof a.body === "string" ? a.body : JSON.stringify(a.body),
						signal: ac.signal
					});
				} finally {
					clearTimeout(t);
				}
				const text = truncate(await r.text());
				return ok({ ok: r.ok, status: r.status, url, method, body: text });
			}

			if (transport === "adb") {
				if (typeof a.command !== "string" || a.command === "") {
					return fail("resource_call adb transport requires args.command");
				}
				const result = await adb.exec(["shell", a.command], { timeoutMs: cfg.adbExecTimeoutMs });
				return ok({
					ok: result.code === 0,
					exitCode: result.code,
					stdout: truncate(result.stdout ?? ""),
					stderr: truncate(result.stderr ?? "")
				});
			}

			return fail(
				`resource_call: transport '${transport}' is not dispatched yet (supported: http, adb). ` +
					`Use the resource's own tooling if one is registered.`
			);
		} catch (err) {
			return fail(`resource_call failed: ${err.message || err}`);
		}
	}
);

server.registerTool(
	"discovery_scan",
	{
		title: "Discover LAN Hosts",
		description:
			"Scan the local network (nmap-backed, via the daemon) for live hosts and ingest them " +
			"into the resource registry. Refuses on metered/offline networks (a scan is outbound " +
			"traffic). Returns a policy-filtered view: unlabeled hosts are hidden by default — " +
			"label them via the resource config page to keep them visible. Pass a CIDR or IPv4 to " +
			"override the auto-derived target.",
		inputSchema: {
			target: z
				.string()
				.optional()
				.describe("CIDR (e.g. 192.168.1.0/24) or a single IPv4. Empty = derive from this device's network.")
		},
		async handler({ target }) {
			try {
				const r = await discoveryScan(cfg, target);
				if (!r.ok) {
					// Metered/offline/nmap-missing — surface clearly, not as a crash.
					return fail(`discovery_scan refused: ${r.error}`);
				}
				return ok({
					ok: true,
					target: r.target,
					scanned: r.scanned,
					ingested: r.ingested,
					visible: r.visible,
					note:
						r.visible.length === 0 && r.ingested > 0
							? `${r.ingested} host(s) found but all are unlabeled (hidden by policy). Label them on the resource page to see them here.`
							: undefined
				});
			} catch (err) {
				return fail(`discovery_scan failed: ${err.message || err}`);
			}
		}
	}
);

// --- Path A enrichment (§6.3) ----------------------------------------------
// Best-effort: extract IPs from a command string and resolve them against the
// registry, appending a short context note to the tool result. Never throws —
// if the daemon is down the tool still returns its normal output.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const SKIP_IP = new Set(["0.0.0.0", "127.0.0.1", "255.255.255.255"]);

async function resolveCommandIps(text) {
	const found = [...new Set(String(text).match(IPV4_RE) ?? [])]
		.filter((ip) => !SKIP_IP.has(ip))
		.slice(0, 5);
	if (found.length === 0) return [];
	const out = [];
	for (const ip of found) {
		try {
			const r = await registryResolve(cfg, { ip });
			if (r.matches.length > 0) {
				out.push({ ip, known: true, matches: r.matches.map((m) => ({ id: m.id, kind: m.kind, __gate: m.__gate })) });
			} else {
				out.push({ ip, known: false });
			}
		} catch {
			out.push({ ip, resolved: false }); // daemon down — enrichment is best-effort
			break;
		}
	}
	return out;
}

// --- truncation helper ----------------------------------------------------
function truncate(s) {
	if (typeof s !== "string" || s.length === 0) return s ?? "";
	if (Buffer.byteLength(s, "utf8") <= cfg.maxOutputBytes) return s;
	// Keep the head (usually where the error is) and mark the cut.
	const head = Buffer.from(s, "utf8").subarray(0, cfg.maxOutputBytes).toString("utf8");
	return `${head}\n…[truncated ${Buffer.byteLength(s, "utf8") - cfg.maxOutputBytes} bytes]`;
}

// --- stdio bootstrap ------------------------------------------------------
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log("sylvia-mcp connected over stdio");
}

main().catch((err) => {
	log("fatal:", err?.stack || String(err));
	process.exit(1);
});
