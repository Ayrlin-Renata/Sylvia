import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// sylvia-daemon HTTP client — loopback control API. Degrades gracefully:
// network_state falls back to the daemon's persisted netstate.json when the
// API is down; traffic_gate reports the error (holding traffic while the
// daemon is dead is a lie — fail loud, not silent).
// ---------------------------------------------------------------------------

/** GET a daemon endpoint; throws on any failure (caller decides fallback). */
async function daemonGet(url, timeoutMs) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ac.signal });
		if (!res.ok) throw new Error(`daemon ${url}: HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

/** POST a daemon endpoint with a JSON body. */
async function daemonPost(url, body, timeoutMs) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal: ac.signal
		});
		if (!res.ok) throw new Error(`daemon ${url}: HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

/**
 * Current network state. Prefer the live daemon API; fall back to reading the
 * state file it persists (staleness returned alongside).
 * @returns {Promise<{state: object, via: "daemon"|"state-file", stale?: boolean, at?: number}>}
 */
export async function networkState(cfg) {
	try {
		const state = await daemonGet(`${cfg.daemonUrl}/api/network`, cfg.daemonTimeoutMs);
		return { state, via: "daemon" };
	} catch (e) {
		// Fallback: netstate.json the daemon writes atomically each tick.
		try {
			const raw = await fs.readFile(cfg.daemonStateFile, "utf8");
			const state = JSON.parse(raw);
			const ageMs = Date.now() - (state.at ?? 0);
			// Older than 2× poll interval → flag stale; daemon probably dead.
			return { state, via: "state-file", stale: ageMs > 60_000, at: state.at };
		} catch {
			throw new Error(
				`network_state unavailable: daemon not reachable at ${cfg.daemonUrl} and no state file at ${cfg.daemonStateFile} (${String(e && e.message ? e.message : e)})`
			);
		}
	}
}

/**
 * Manual netgate control (status | hold | resume). No state-file fallback —
 * acting on a dead daemon would silently no-op; surface the failure instead.
 */
export async function trafficGate(cfg, action, reason) {
	if (action === "status") {
		return daemonGet(`${cfg.daemonUrl}/api/netgate`, cfg.daemonTimeoutMs);
	}
	if (action === "hold" || action === "resume") {
		return daemonPost(`${cfg.daemonUrl}/api/netgate/${action}`, { reason: reason ?? "manual" }, cfg.daemonTimeoutMs);
	}
	throw new Error(`unknown traffic_gate action: ${action} (expected status|hold|resume)`);
}

/**
 * Policy-filtered registry list (hidden items ABSENT, §5).
 * @param {"networks"|"hosts"|"resources"} kind
 */
export async function registryList(cfg, kind) {
	if (!["networks", "hosts", "resources"].includes(kind)) {
		throw new Error(`unknown registry kind: ${kind} (expected networks|hosts|resources)`);
	}
	return daemonGet(`${cfg.daemonUrl}/api/registry/${kind}`, cfg.daemonTimeoutMs);
}

/**
 * Resolve {ip?,hostname?,name?} against the registry with policy applied.
 * Matches carry __gate (allow|ask) — hidden items are absent.
 */
export async function registryResolve(cfg, query) {
	return daemonPost(`${cfg.daemonUrl}/api/registry/resolve`, query ?? {}, cfg.daemonTimeoutMs);
}

/**
 * Run a policy-filtered LAN discovery scan (§7). The daemon refuses to scan on
 * metered/offline networks (scan = outbound traffic), so a 409 surfaces as a
 * clear error. Longer timeout: nmap sweeps can take a while.
 * @param {object} cfg
 * @param {string} [target] CIDR or IPv4 (default: daemon derives from local addrs)
 */
export async function discoveryScan(cfg, target) {
	// Discovery is slow (nmap sweep) — give it room beyond the normal timeout.
	return daemonPost(`${cfg.daemonUrl}/api/discover/scan`, { target: target ?? "" }, Math.max(cfg.daemonTimeoutMs, 60_000));
}
