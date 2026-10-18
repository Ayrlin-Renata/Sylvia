import { spawn } from "node:child_process";
import { run } from "./run.js";

// ---------------------------------------------------------------------------
// Tier 0 — `ip route get <target>` (unprivileged, sub-ms, THIS uid's egress).
// wlan* = wifi, rmnet*/ccmni*/apn*/wwan* = cellular, anything else = "other".
// Metering-blind: this tier answers WHERE, not whether-metered.
// ---------------------------------------------------------------------------

/**
 * @returns {{iface: string|null, unreachable: boolean, denied: boolean,
 *   error: string|null}}
 */
export function parseIpRoute(stdout, stderr, code) {
	const blob = `${stdout ?? ""}\n${stderr ?? ""}`;
	// "Network is unreachable" → the uid has no egress route at all.
	// (Checked before `denied` because RTNETLINK's unreachable text also
	// contains the word "netlink".)
	if (/unreachable/i.test(blob)) {
		return { iface: null, unreachable: true, denied: false, error: null };
	}
	// Termux's app uid runs under SELinux runas_app and CANNOT bind netlink —
	// `ip route get` fails with "Cannot bind netlink socket: Permission denied".
	// That is an UNKNOWN verdict (wrong identity), NOT "no network": callers
	// must retry as another identity (adbd's uid) instead of failing closed.
	if (code !== 0 && /permission denied|cannot bind netlink/i.test(blob)) {
		const first = blob.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "netlink denied";
		return { iface: null, unreachable: false, denied: true, error: first };
	}
	// Any other non-zero exit → treat as unreachable (legacy behavior).
	if (code !== 0) {
		return { iface: null, unreachable: true, denied: false, error: null };
	}
	// Typical line: `1.1.1.1 via 192.168.1.1 dev wlan0 table wlan0 src 192.168.1.50 uid 10234`
	const m = /(?:^|\s)dev\s+(\S+)/.exec(stdout ?? "");
	if (!m) return { iface: null, unreachable: false, denied: false, error: "no dev in route output" };
	return { iface: m[1], unreachable: false, denied: false, error: null };
}

// ---------------------------------------------------------------------------
// adb server bootstrap — on Termux the client auto-started server dies before
// ACKing because it cannot write /tmp/adb.<uid>.log (root /tmp is shell-owned).
// When that happens we spawn the nodaemon form (logs to stderr, skips /tmp).
// ---------------------------------------------------------------------------

export const ADB_BOOT_SIG = /ADB server didn't ACK|failed to start daemon|cannot open \/tmp\/adb/i;

let adbBootMemo = null;

/** Probe + (if needed) spawn `adb -L tcp:5037 nodaemon server start` detached. */
export async function ensureAdbServer(cfg, runFn, spawnFn = spawn) {
	if (adbBootMemo) return adbBootMemo;
	adbBootMemo = (async () => {
		const probe = await runFn(cfg.adbPath, ["devices"], { timeoutMs: 8000 });
		if (!ADB_BOOT_SIG.test(`${probe.stdout}\n${probe.stderr}`)) return probe;
		try {
			const child = spawnFn(cfg.adbPath, ["-L", "tcp:5037", "nodaemon", "server", "start"], {
				stdio: "ignore",
				detached: true
			});
			if (child && typeof child.unref === "function") child.unref();
		} catch {
			/* fall through to polling — maybe another agent already fixed it */
		}
		let last = probe;
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 500));
			last = await runFn(cfg.adbPath, ["devices"], { timeoutMs: 8000 });
			if (!ADB_BOOT_SIG.test(`${last.stdout}\n${last.stderr}`) && !last.spawnError) return last;
		}
		// Still broken — clear the memo so a later call retries the bootstrap.
		if (ADB_BOOT_SIG.test(`${last.stdout}\n${last.stderr}`)) adbBootMemo = null;
		return last;
	})();
	return adbBootMemo;
}

/**
 * Run an adb command; if it fails with the server-bootstrap signature,
 * bootstrap the server (nodaemon fallback) and retry once. Steady-state
 * commands pay no extra cost — the probe only runs after a signature hit.
 */
export async function adbRun(cfg, runFn, args, opts = {}, spawnFn) {
	let r = await runFn(cfg.adbPath, args, opts);
	if (!r.spawnError && ADB_BOOT_SIG.test(`${r.stdout}\n${r.stderr}`)) {
		await ensureAdbServer(cfg, runFn, spawnFn);
		r = await runFn(cfg.adbPath, args, opts);
	}
	return r;
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
export async function detect(cfg, runFn = run, spawnFn = undefined) {
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

	let route = parseIpRoute(r.stdout, r.stderr, r.code ?? 0);
	let tier0 = "tier0"; // source prefix; "tier0-adb" when asked as adbd

	// Netlink denied (Termux app uid): the verdict is UNKNOWN, not offline.
	// Retry the identical query as adbd's identity — `shell` uid binds netlink
	// fine (verified on the emulator).
	if (route.denied && cfg.adbPath) {
		const serialArgs = cfg.adbSerial ? ["-s", cfg.adbSerial] : [];
		const rr = await adbRun(
			cfg,
			runFn,
			[...serialArgs, "shell", "ip", "route", "get", cfg.ipRouteTarget],
			{ timeoutMs: cfg.adbTimeoutMs },
			spawnFn
		);
		if (!rr.spawnError && rr.code === 0) {
			const viaAdb = parseIpRoute(rr.stdout, rr.stderr, 0);
			if (viaAdb.iface) {
				route = viaAdb;
				tier0 = "tier0-adb";
			}
		}
	}

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
		// ...but when tier-0 was DENIED (not truly unreachable), Android's own
		// connectivity service can still name the transport type.
		if (route.denied && cfg.adbPath) {
			const serialArgs = cfg.adbSerial ? ["-s", cfg.adbSerial] : [];
			const conn = await adbRun(
				cfg,
				runFn,
				[...serialArgs, "shell", "dumpsys", "connectivity"],
				{ timeoutMs: cfg.adbTimeoutMs },
				spawnFn
			);
			if (!conn.spawnError && conn.code === 0) {
				const parsed = parseConnectivity(conn.stdout);
				if (parsed && parsed.type) {
					const t =
						parsed.type === "WIFI" ? "wifi" : parsed.type === "MOBILE" ? "cellular" : "other";
					return {
						...base,
						transport: t,
						metered: t === "cellular",
						validated: parsed.validated,
						tier1Available: true,
						source: "tier1-connectivity"
					};
				}
			}
		}
		return {
			...base,
			metered: true,
			source: route.denied ? "tier0-denied" : "tier0-unreachable",
			tier1Available: false
		};
	}

	// --- Tier 1: adb dumpsys (best-effort; degrade to Tier-0 inference) ---
	let metered = transport === "cellular"; // fallback inference: cellular⇒metered, wifi/other⇒unmetered
	let source = `${tier0}-inference`;

	if (cfg.adbPath) {
		const serialArgs = cfg.adbSerial ? ["-s", cfg.adbSerial] : [];
		const np = await adbRun(cfg, runFn, [...serialArgs, "shell", "dumpsys", "netpolicy"], {
			timeoutMs: cfg.adbTimeoutMs
		}, spawnFn);
		if (!np.spawnError && np.code === 0) {
			base.tier1Available = true;
			const meteredIfaces = parseMeteredIfaces(np.stdout);
			if (meteredIfaces && route.iface) {
				metered = meteredIfaces.includes(route.iface);
				source = `${tier0}+netpolicy`;
			} else {
				// netpolicy answered but didn't name our iface — try connectivity.
				const conn = await adbRun(cfg, runFn, [...serialArgs, "shell", "dumpsys", "connectivity"], {
					timeoutMs: cfg.adbTimeoutMs
				}, spawnFn);
				if (!conn.spawnError && conn.code === 0) {
					const parsed = parseConnectivity(conn.stdout);
					if (parsed) {
						base.validated = parsed.validated;
						if (parsed.metered !== null) {
							metered = parsed.metered;
							source = `${tier0}+connectivity`;
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
