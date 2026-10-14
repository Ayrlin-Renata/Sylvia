import { run } from "./run.js";

// ---------------------------------------------------------------------------
// Tier 0 — `ip route get <target>` (unprivileged, sub-ms, THIS uid's egress).
// wlan* = wifi, rmnet*/ccmni*/apn*/wwan* = cellular, anything else = "other".
// Metering-blind: this tier answers WHERE, not whether-metered.
// ---------------------------------------------------------------------------

/** @returns {{iface: string|null, unreachable: boolean, error: string|null}} */
export function parseIpRoute(stdout, stderr, code) {
	// "Network is unreachable" → the uid has no egress route at all.
	if (code !== 0 || /unreachable/i.test(stderr ?? "")) {
		return { iface: null, unreachable: true, error: null };
	}
	// Typical line: `1.1.1.1 via 192.168.1.1 dev wlan0 table wlan0 src 192.168.1.50 uid 10234`
	const m = /(?:^|\s)dev\s+(\S+)/.exec(stdout ?? "");
	if (!m) return { iface: null, unreachable: false, error: "no dev in route output" };
	return { iface: m[1], unreachable: false, error: null };
}

const CELL_RE = /^(rmnet|ccmni|apn|wwan)/;
const WIFI_RE = /^wlan/;

/** Classify an interface name. "other" (ethernet/usb/tether) is not cellular. */
export function classifyIface(iface) {
	if (!iface) return "none";
	if (WIFI_RE.test(iface)) return "wifi";
	if (CELL_RE.test(iface)) return "cellular";
	return "other";
}

// ---------------------------------------------------------------------------
// Tier 1 — adb shell dumpsys {netpolicy, connectivity} — Android's own
// verdicts. Format-drifty across Android versions → tolerant parsers.
// ---------------------------------------------------------------------------

/** mMeteredIfaces=[rmnet_data0, rmnet_data1] — authoritative per-iface metering. */
export function parseMeteredIfaces(stdout) {
	const m = /mMeteredIfaces\s*=\s*\[([^\]]*)\]/.exec(stdout ?? "");
	if (!m) return null; // field absent — caller falls through to connectivity
	return m[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * `dumpsys connectivity` default-network summary. Find the default network id
 * first (`Active default network: 101` or `Current default network: 101`),
 * then look for that id's line carrying type/NOT_METERED/VALIDATED. Tolerant:
 * never throws, returns null when the shape isn't recognized.
 * @returns {{netId:number|null, type:string|null, metered:boolean|null,
 *   validated:boolean|null}|null}
 */
export function parseConnectivity(stdout) {
	if (!stdout) return null;
	// Default network id (older: "Active default network:", newer: "Current default network:").
	// id === -1 means "no default network" — a recognized shape with a null id.
	let netId = null;
	let sawDefaultLine = false;
	const idm = /(?:Active|Current) default network:\s*(-?\d+)/.exec(stdout);
	if (idm) {
		sawDefaultLine = true;
		if (idm[1] !== "-1") netId = Number(idm[1]);
	}

	// Find the NetworkAgentInfo / network line for that id.
	// Shapes vary: `network{101}` ... `NetworkAgentInfo{ni{[type: WIFI,...]}`.
	let type = null;
	let metered = null;
	let validated = null;

	const idPat = netId !== null ? new RegExp(`network\\{${netId}\\}`) : null;
	if (idPat) {
		// Grab a window around the id's first occurrence and read attributes.
		const idx = stdout.search(idPat);
		if (idx >= 0) {
			const window = stdout.slice(Math.max(0, idx - 200), idx + 2000);
			const tm = /\btype:\s*([A-Z_]+)/.exec(window);
			if (tm) type = tm[1]; // WIFI | MOBILE | ...
			// Order matters: NOT_METERED contains the substring METERED, so the
			// positive METERED test must require it is not preceded by "NOT_".
			if (/\bNOT_METERED\b/.test(window)) metered = false;
			else if (/(?<!NOT_)\bMETERED\b/.test(window)) metered = true;
			if (/\bNOT_VALIDATED\b/.test(window)) validated = false;
			else if (/(?<!NOT_)\bVALIDATED\b/.test(window)) validated = true;
		}
	}
	// Unrecognized only when we never saw the default-network line nor a
	// network{id} block to anchor on.
	if (!sawDefaultLine && netId === null && type === null) return null;
	return { netId, type, metered, validated };
}

// ---------------------------------------------------------------------------
// Orchestrator — fail closed (locked, DESIGN.md §2.1): undeterminable ⇒
// metered:true. A false "stop" is safe; a false "go" costs money.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} NetState
 * @property {"wifi"|"cellular"|"other"|"none"} transport
 * @property {boolean} metered
 * @property {boolean|null} validated   Tier-1 only; null when unknown
 * @property {string|null} iface
 * @property {string} source            "tier0+netpolicy"|"tier0+connectivity"|"tier0"|…
 * @property {boolean} tier1Available   whether adb dumpsys answered
 * @property {number} at                epoch ms
 */

/**
 * Detect current network state. `runFn` is injectable for tests; defaults to
 * the real execFile runner.
 * @returns {Promise<NetState>}
 */
export async function detect(cfg, runFn = run) {
	const now = Date.now();

	// --- Tier 0: egress interface ----------------------------------------
	const r = await runFn(cfg.ipPath, ["route", "get", cfg.ipRouteTarget], {
		timeoutMs: 5000
	});

	if (r.spawnError) {
		// `ip` binary missing entirely (not Termux) — undeterminable.
		return {
			transport: cfg.failClosed ? "other" : "other",
			metered: true, // fail closed
			validated: null,
			iface: null,
			source: "unavailable",
			tier1Available: false,
			at: now
		};
	}

	const route = parseIpRoute(r.stdout, r.stderr, r.code ?? 0);
	const transport = route.unreachable ? "none" : classifyIface(route.iface);

	const base = {
		transport,
		iface: route.iface,
		validated: null,
		tier1Available: false,
		at: now
	};

	// No network at all → nothing to meter.
	if (transport === "none") {
		return { ...base, metered: true, source: "tier0-unreachable", tier1Available: false };
	}

	// --- Tier 1: adb dumpsys (best-effort; degrade to Tier-0 inference) ---
	let metered = transport === "cellular"; // fallback inference: cellular⇒metered, wifi/other⇒unmetered
	let source = "tier0-inference";

	if (cfg.adbPath) {
		const serialArgs = cfg.adbSerial ? ["-s", cfg.adbSerial] : [];
		const np = await runFn(cfg.adbPath, [...serialArgs, "shell", "dumpsys", "netpolicy"], {
			timeoutMs: cfg.adbTimeoutMs
		});
		if (!np.spawnError && np.code === 0) {
			base.tier1Available = true;
			const meteredIfaces = parseMeteredIfaces(np.stdout);
			if (meteredIfaces && route.iface) {
				metered = meteredIfaces.includes(route.iface);
				source = "tier0+netpolicy";
			} else {
				// netpolicy answered but didn't name our iface — try connectivity.
				const conn = await runFn(cfg.adbPath, [...serialArgs, "shell", "dumpsys", "connectivity"], {
					timeoutMs: cfg.adbTimeoutMs
				});
				if (!conn.spawnError && conn.code === 0) {
					const parsed = parseConnectivity(conn.stdout);
					if (parsed) {
						base.validated = parsed.validated;
						if (parsed.metered !== null) {
							metered = parsed.metered;
							source = "tier0+connectivity";
						}
					}
				}
			}
		}
	}

	// Fail-closed backstop: if somehow neither tier produced an answer and the
	// config demands closed, force metered. (Tier-0 inference above already
	// yields a definite value, so this is belt-and-suspenders.)
	if (cfg.failClosed && source === "unavailable") metered = true;

	return { ...base, metered, source };
}
