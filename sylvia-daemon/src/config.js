import os from "node:os";
import path from "node:path";

function bool(v, dflt) {
	if (v === undefined || v === "") return dflt;
	return /^(1|true|yes|on)$/i.test(v);
}

function int(v, dflt) {
	const n = Number.parseInt(v ?? "", 10);
	return Number.isFinite(n) ? n : dflt;
}

/**
 * Daemon config — every knob is an env var with a safe default (same style as
 * sylvia-mcp). Pure normalization: no network or filesystem access here.
 *
 * Loopback-only is a hard security posture (see DESIGN.md §10): the API binds
 * 127.0.0.1 and there is deliberately no option to expose it wider.
 */
export function loadConfig(env = process.env) {
	return {
		// --- control API ---------------------------------------------------
		host: "127.0.0.1",
		port: int(env.SYLVIA_DAEMON_PORT, 3090),

		// --- state ---------------------------------------------------------
		// ~/.sylvia — JSON only, human-inspectable, daemon is the single writer.
		stateDir: env.SYLVIA_STATE_DIR || path.join(os.homedir(), ".sylvia"),

		// --- detection -----------------------------------------------------
		// Tier 0: `ip route get <target>` — unprivileged, sub-ms, answers where
		// THIS uid's packets egress (wlan* = wifi, rmnet*/ccmni*/apn*/wwan* =
		// cellular). Metering-blind.
		ipPath: env.SYLVIA_IP_PATH || "ip",
		ipRouteTarget: env.SYLVIA_NET_ROUTE_TARGET || "1.1.1.1",
		// Tier 1: adb shell dumpsys {netpolicy,connectivity} — Android's own
		// metered/validated verdicts. Best-effort: when adb is down the daemon
		// degrades to Tier-0 inference instead of failing.
		adbPath: env.SYLVIA_ADB_PATH || "adb",
		adbSerial: env.SYLVIA_ADB_SERIAL || "",
		// Auto-pick the first live transport when no serial is set: the Termux
		// server often shows TWO entries for one device (explicit loopback
		// connect + mdns discovery), and bare `adb shell` then fails with
		// "more than one device/emulator", collapsing every adb tier.
		adbAutoSerial: bool(env.SYLVIA_ADB_AUTO_SERIAL, true),
		adbHost: env.SYLVIA_ADB_HOST || "127.0.0.1",
		adbPort: int(env.SYLVIA_ADB_PORT, 0), // 0 = don't force `adb connect`
		adbTimeoutMs: int(env.SYLVIA_ADB_TIMEOUT_MS, 6000),
		// FAIL CLOSED (locked, DESIGN.md §2.1): when we cannot determine the
		// network at all, report metered:true so gates hold. A false "stop" is
		// safe; a false "go" costs the user money.
		failClosed: bool(env.SYLVIA_NET_FAIL_CLOSED, true),

		// --- watcher -------------------------------------------------------
		pollIntervalMs: int(env.SYLVIA_NET_POLL_INTERVAL_MS, 20000),

		// --- netgate (managed traffic) --------------------------------------
		// LOCKED default false (DESIGN.md §13): held services stay held when
		// wifi returns; release is explicit (control panel / agent / plugin).
		resumeOnReconnect: bool(env.SYLVIA_RESUME_ON_RECONNECT, false),
		gateEnabled: bool(env.SYLVIA_NET_GATE_ENABLED, true),

		// --- registry / policy (§4–§5) --------------------------------------
		// Offline axis: now - lastSeen > offlineThresholdMs ⇒ hidden regardless
		// of ownership. 15 minutes keeps a lunch-hour wifi blip from wiping
		// visibility while still hiding long-dead devices.
		offlineThresholdMs: int(env.SYLVIA_OFFLINE_THRESHOLD_MS, 15 * 60 * 1000),
		// Identity ladder (§4): provisional (IP-only) → corroborated after this
		// many sightings with a consistent fingerprint → confirmed (serial/MAC
		// or user declaration — set immediately, no ladder).
		corroborateSightings: int(env.SYLVIA_CORROBORATE_SIGHTINGS, 3),

		// --- pruning (§12) -------------------------------------------------
		// Transient entities (unlabeled networks/hosts, dead resources) are
		// removed after pruneAfterMs; labeled (owned/declared) entries are
		// NEVER auto-pruned. Prune runs on this interval + on demand.
		pruneIntervalMs: int(env.SYLVIA_PRUNE_INTERVAL_MS, 6 * 60 * 60 * 1000),
		pruneAfterMs: int(env.SYLVIA_PRUNE_AFTER_MS, 7 * 24 * 60 * 60 * 1000),

		// --- discovery (§7) ------------------------------------------------
		// nmap-backed LAN scan → registry ingest. Refuses to run when the
		// network is metered/offline (a scan is outbound traffic). nmap is
		// optional: when missing the scan endpoint returns a clear error and
		// the daemon keeps running.
		discoverEnabled: bool(env.SYLVIA_DISCOVER_ENABLED, true),
		// CIDR to scan when no target given; empty = derive from local addrs.
		scanCidr: env.SYLVIA_SCAN_CIDR || "",
		scanTimeoutMs: int(env.SYLVIA_SCAN_TIMEOUT_MS, 60 * 1000)
	};
}
