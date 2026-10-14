import os from "node:os";
import { run } from "./run.js";
import { hostKey } from "./registry.js";

/**
 * Discovery (§7) — nmap-backed LAN scan → registry ingest.
 *
 * Design constraints:
 * - FAILS LOUDLY when nmap is missing (discover returns an error, daemon keeps
 *   running). nmap is optional; we degrade rather than crash.
 * - REFUSES to scan when the network is metered/offline: a scan is outbound
 *   traffic, and outbound traffic on metered data is exactly what §2 gates.
 * - NEVER returns raw hosts to the caller. Scan results are ingested into the
 *   registry (as provisional hosts) and the caller gets a policy-filtered view
 *   (listVisible), so hidden hosts are ABSENT — not redacted (§5).
 */

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

/**
 * Derive a scan CIDR from this device's non-internal IPv4 addresses when no
 * explicit scanCidr is configured. Picks the first /24 from a private-looking
 * address; returns "" when nothing usable (caller surfaces a clear error).
 */
export function deriveCidr(interfaces = os.networkInterfaces()) {
	for (const addrs of Object.values(interfaces)) {
		for (const a of addrs ?? []) {
			if (a.family !== "IPv4" || a.internal) continue;
			// Force a /24 — the common LAN size. We could read the real prefix
			// length, but /24 is a safe, predictable default for a phone LAN.
			const parts = a.address.split(".");
			if (parts.length !== 4) continue;
			return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
		}
	}
	return "";
}

/**
 * Parse `nmap -sn` output into hosts. We only trust the "Nmap scan report"
 * lines plus any MAC line that follows. Hostname is optional (in parens).
 *
 * Example lines:
 *   Nmap scan report for 192.168.1.1
 *   Nmap scan report for router.lan (192.168.1.1)
 *   Host is up (0.0042s latency).
 *   MAC Address: AA:BB:CC:DD:EE:FF (SomeVendor)
 */
export function parseNmapPing(text) {
	const hosts = [];
	let cur = null;
	for (const line of String(text).split("\n")) {
		const report = /^Nmap scan report for (?:(.+?) \()?(\d{1,3}(?:\.\d{1,3}){3})\)?\s*$/.exec(line);
		if (report) {
			if (cur) hosts.push(cur);
			cur = { ip: report[2], hostname: report[1] || null, mac: null };
			continue;
		}
		const mac = /MAC Address:\s*([0-9A-Fa-f:]{17})/.exec(line);
		if (mac && cur) {
			cur.mac = mac[1].toUpperCase();
		}
	}
	if (cur) hosts.push(cur);
	return hosts;
}

function validTarget(target) {
	// Accept a CIDR or a bare IPv4. Anything else is rejected (no shell passthrough).
	if (CIDR_RE.test(target)) {
		const m = CIDR_RE.exec(target);
		const octets = m[1].split(".").map(Number);
		const prefix = Number(m[2]);
		return octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32;
	}
	const octets = target.split(".");
	return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) >= 0 && Number(o) <= 255);
}

/**
 * Create a discoverer bound to config + registry + netstate.
 *
 * @param {object} cfg daemon config
 * @param {import("./registry.js").Registry} registry
 * @param {() => {metered?:boolean, transport?:string}} getNetstate
 * @param {object} [deps] { runFn } — injectable for tests
 */
export function createDiscoverer(cfg, registry, getNetstate, deps = {}) {
	const runFn = deps.runFn ?? run;

	return {
		/**
		 * Run a ping scan and ingest results into the registry.
		 *
		 * @param {object} [opts] { target }
		 * @returns {Promise<{ok:boolean, error?:string, target:string,
		 *   scanned:number, ingested:number, visible:object[]}>}
		 */
		async scan(opts = {}) {
			if (!cfg.discoverEnabled) {
				return { ok: false, error: "discovery is disabled (set SYLVIA_DISCOVER_ENABLED=1)", target: "", scanned: 0, ingested: 0, visible: [] };
			}

			// Metered/offline guard: a scan is outbound traffic.
			const net = (await getNetstate()) ?? {};
			if (net.transport === "none") {
				return { ok: false, error: "offline — refusing to scan (no network)", target: "", scanned: 0, ingested: 0, visible: [] };
			}
			if (net.metered) {
				return { ok: false, error: "metered network — refusing to scan (would incur data usage)", target: "", scanned: 0, ingested: 0, visible: [] };
			}

			const target = opts.target || cfg.scanCidr || deriveCidr();
			if (!target) {
				return { ok: false, error: "no scan target: set SYLVIA_SCAN_CIDR or connect to a network", target: "", scanned: 0, ingested: 0, visible: [] };
			}
			if (!validTarget(target)) {
				return { ok: false, error: `invalid scan target: ${target} (expected IPv4 or CIDR)`, target, scanned: 0, ingested: 0, visible: [] };
			}

			// -oX - emits XML to stdout; we parse the <host> blocks (single
			// invocation — no second nmap run).
			const res = await runFn("nmap", ["-sn", target, "-oX", "-"], { timeoutMs: cfg.scanTimeoutMs });
			if (res.spawnError) {
				return { ok: false, error: "nmap not installed (pkg install nmap)", target, scanned: 0, ingested: 0, visible: [] };
			}
			if (res.timedOut) {
				return { ok: false, error: `nmap timed out after ${cfg.scanTimeoutMs}ms`, target, scanned: 0, ingested: 0, visible: [] };
			}
			if (res.code !== 0) {
				return { ok: false, error: `nmap exited ${res.code}: ${res.stderr?.slice(0, 200) ?? ""}`.trim(), target, scanned: 0, ingested: 0, visible: [] };
			}

			const hosts = parseNmapXml(res.stdout);
			const now = Date.now();
			// The network label (the CIDR we scanned) keys ip-based identities so
			// the same IP on a different network isn't conflated (§4 identity).
			const networkLabel = target;
			let ingested = 0;
			for (const h of hosts) {
				try {
					const { key, confidence } = hostKey({ mac: h.mac || undefined, ip: h.ip, network: networkLabel });
					const entity = {
						kind: "host",
						id: key,
						name: h.hostname || h.ip,
						ips: [h.ip],
						mac: h.mac || undefined,
						network: networkLabel,
						identityConfidence: h.mac ? "confirmed" : confidence,
						lastSeen: now
					};
					const saved = await registry.upsert("hosts", entity);
					if (saved) ingested += 1;
				} catch {
					// A single bad host must not abort the whole scan.
				}
			}

			const visible = await registry.listVisible("hosts", now);
			return { ok: true, target, scanned: hosts.length, ingested, visible };
		}
	};
}

/**
 * Parse `nmap -sn -oX -` XML into hosts. We pull <address addr= addrtype=>
 * (ipv4 + mac) and the <hostnames><hostname name=> when present.
 */
export function parseNmapXml(xml) {
	const hosts = [];
	const hostBlocks = String(xml).split(/<host\b/).slice(1);
	for (const block of hostBlocks) {
		const ipv4 = /<address[^>]*addr="(\d{1,3}(?:\.\d{1,3}){3})"[^>]*addrtype="ipv4"/.exec(block);
		if (!ipv4) continue;
		const mac = /<address[^>]*addr="([0-9A-Fa-f:]{17})"[^>]*addrtype="mac"/.exec(block);
		const hostname = /<hostname[^>]*name="([^"]+)"/.exec(block);
		hosts.push({ ip: ipv4[1], mac: mac ? mac[1].toUpperCase() : null, hostname: hostname ? hostname[1] : null });
	}
	return hosts;
}
