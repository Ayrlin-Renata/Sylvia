import { evaluate, normalizePolicy } from "./policy.js";

// ---------------------------------------------------------------------------
// Registry — networks/hosts/resources under ~/.sylvia (DESIGN.md §4, §12).
// Single-writer (the daemon) via StateStore. Responsibilities:
//   • stable identity: serial/MAC, or fingerprint+(ip,network), or declaration
//     — never bare (IP, network); DHCP reassigns addresses (§4, locked)
//   • identityConfidence ladder: provisional → corroborated (≥N consistent
//     fingerprint sightings) → confirmed (serial/MAC or user-declared)
//   • retention (locked): public WAN IPs and public machines are NEVER
//     persisted — only labeled networks' own WAN IP, and labeled/declared or
//     LAN-visible devices
//   • prune: transient (unlabeled, stale) entities removed; labeled entries
//     are never auto-pruned
// ---------------------------------------------------------------------------

const KINDS = ["networks", "hosts", "resources"];
/** Store dir (plural) → entity kind field (singular, DESIGN.md §4). */
const KIND_ONE = { networks: "network", hosts: "host", resources: "resource" };
const IPV4_PRIVATE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Filesystem-safe name for an id (ids carry ':' which Windows rejects). */
function safeName(id) {
	return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Is this a private/LAN IPv4 address? Public IPv4s are never persisted. */
export function isPrivateIp(ip) {
	return IPV4_PRIVATE.test(ip || "");
}

/** IPv6: ULA/link-local are private; global unicast is not. */
function isPrivateIp6(ip) {
	return /^(fc|fd|fe80|::1)/i.test(ip || "");
}

export function isPrivate(ip) {
	return ip.includes(":") ? isPrivateIp6(ip) : isPrivateIp(ip);
}

/**
 * Stable key for a host sighting — the §4 identity rule. Preference:
 * serial > mac > fingerprint+(ip,network). Bare (ip,network) is NOT an
 * identity; it produces a provisional key that can be re-keyed later.
 * @returns {{key: string, confidence: "confirmed"|"corroborated"|"provisional"}}
 */
export function hostKey({ serial, mac, fingerprint, ip, network }) {
	if (serial) return { key: `serial:${serial}`, confidence: "confirmed" };
	if (mac) return { key: `mac:${mac}`, confidence: "confirmed" };
	if (fingerprint && ip && network) {
		return { key: `fp:${stableHash(fingerprint)}|${ip}|${network}`, confidence: "corroborated" };
	}
	return { key: `ip:${ip}|${network}`, confidence: "provisional" };
}

/** Deterministic non-crypto hash for fingerprint bucketing. */
export function stableHash(obj) {
	const s = JSON.stringify(obj, Object.keys(obj ?? {}).sort());
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(16);
}

export class Registry {
	/**
	 * @param {import("./statemgr.js").StateStore} store
	 * @param {{corroborateSightings?: number, pruneAfterMs?: number}} [opts]
	 */
	constructor(store, opts = {}) {
		this.store = store;
		this.corroborateN = opts.corroborateSightings ?? 3;
		this.pruneAfterMs = opts.pruneAfterMs ?? 7 * 24 * 60 * 60 * 1000;
		this._policy = null;
	}

	// --- policy -------------------------------------------------------------

	async policy() {
		if (!this._policy) {
			this._policy = normalizePolicy(await this.store.read("policy.json", {}));
		}
		return this._policy;
	}

	async setPolicy(raw) {
		this._policy = normalizePolicy(raw);
		await this.store.write("policy.json", this._policy);
		return this._policy;
	}

	// --- persistence ---------------------------------------------------------

	_file(kind, id) {
		if (!KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
		return `${kind}/${safeName(id)}.json`;
	}

	async get(kind, id) {
		const v = await this.store.read(this._file(kind, id), null);
		return v;
	}

	async all(kind) {
		if (!KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
		const names = await this.store.list(kind);
		const out = [];
		for (const n of names) {
			const v = await this.store.read(`${kind}/${n}`, null);
			if (v && v.id) out.push(v);
		}
		return out;
	}

	// --- retention (locked §4) ----------------------------------------------

	/**
	 * Sanitize before persisting:
	 *  • network: wanIp kept ONLY when labeled (owner set)
	 *  • host: only private/LAN IPs persisted; public IPs stripped; public
	 *    machines (no private ip, no mac/serial, no fingerprint) are dropped
	 */
	_retain(entity) {
		if (entity.kind === "network") {
			if (!entity.owner) delete entity.wanIp;
			return entity;
		}
		if (entity.kind === "host") {
			entity.ips = (entity.ips || []).filter(isPrivate);
			const hasIdentity = entity.mac || entity.serial || entity.fingerprint;
			if (entity.ips.length === 0 && !hasIdentity) return null; // public machine — never persisted
			return entity;
		}
		return entity; // resources reference a host; endpoints are user-configured
	}

	// --- upsert + sighting ---------------------------------------------------

	/**
	 * Create or update an entity. Returns the stored entity (null if dropped
	 * by the retention rule). Merge: existing fields win over undefined;
	 * arrays replace.
	 */
	async upsert(kind, entity) {
		const now = Date.now();
		const id = entity.id;
		if (!id) throw new Error(`entity requires an id (${kind})`);
		const existing = (await this.get(kind, id)) || {
			kind,
			id,
			firstSeen: now,
			sightings: 0,
			seenMs: 0
		};
		const merged = { ...existing };
		for (const [k, v] of Object.entries(entity)) {
			if (v !== undefined) merged[k] = v;
		}
		merged.kind = KIND_ONE[kind] ?? kind;
		merged.id = id;
		// Honor an explicitly provided lastSeen (import/backfill), else now.
		merged.lastSeen = entity.lastSeen ?? now;
		const retained = this._retain(merged);
		if (!retained) return null;
		await this.store.write(this._file(kind, id), retained);
		return retained;
	}

	/**
	 * Record a sighting (discovery/scan input). Bumps counters, merges
	 * observable fields, and advances the identity ladder:
	 *  • serial/MAC present → confirmed
	 *  • fingerprint stable across ≥corroborateN sightings → corroborated
	 * A sighting of a DIFFERENT key re-keys provisional hosts (new file, old
	 * provisional file removed only if still provisional).
	 */
	async recordSighting(kind, entity) {
		const now = Date.now();
		const prev = entity.id ? await this.get(kind, entity.id) : null;
		const base = prev || { kind, id: entity.id, firstSeen: now, sightings: 0, seenMs: 0 };
		if (prev?.lastSeen) {
			// dwell accrual (capped at 1h per gap — heuristic, not billing)
			base.seenMs = (base.seenMs || 0) + Math.min(now - prev.lastSeen, 3600_000);
		}
		base.sightings = (base.sightings || 0) + 1;
		const merged = { ...base, ...entity, kind: KIND_ONE[kind] ?? kind, id: entity.id, lastSeen: now };
		merged.firstSeen = base.firstSeen;

		// --- identity ladder ------------------------------------------------
		if (KIND_ONE[kind] === "host") {
			if (merged.serial || merged.mac) {
				merged.identityConfidence = "confirmed";
			} else if (merged.identityConfidence !== "confirmed") {
				const sameFp =
					prev?.fingerprintHash && merged.fingerprint
						? prev.fingerprintHash === stableHash(merged.fingerprint)
						: false;
				if (merged.fingerprint) merged.fingerprintHash = stableHash(merged.fingerprint);
				if (sameFp || merged.identityConfidence === "corroborated") {
					merged.fpStreak = (prev?.fpStreak && sameFp ? prev.fpStreak : 0) + 1;
					if (merged.fpStreak >= this.corroborateN) merged.identityConfidence = "corroborated";
					else merged.identityConfidence = merged.identityConfidence === "corroborated" ? "corroborated" : "provisional";
				} else {
					merged.fpStreak = 1;
					if (merged.identityConfidence !== "corroborated") merged.identityConfidence = "provisional";
				}
			}
		}

		const retained = this._retain(merged);
		if (!retained) return null;
		await this.store.write(this._file(kind, merged.id), retained);
		return retained;
	}

	/**
	 * User declaration / labeling from the panel. Sets owner (mine | <person> |
	 * null to unlabel) and permission; declared devices jump to confirmed.
	 */
	async label(kind, id, { owner, permission }) {
		const existing = await this.get(kind, id);
		if (!existing) throw new Error(`unknown ${kind}: ${id}`);
		if (owner !== undefined) {
			if (owner === null || owner === "") delete existing.owner;
			else existing.owner = owner;
		}
		if (permission !== undefined) {
			if (permission === null) delete existing.permission;
			else existing.permission = permission;
		}
		if (KIND_ONE[kind] === "host" && owner) existing.identityConfidence = "confirmed";
		existing.lastSeen = existing.lastSeen ?? Date.now();
		const retained = this._retain(existing);
		if (!retained) return null;
		await this.store.write(this._file(kind, id), retained);
		return retained;
	}

	// --- policy-filtered listing ---------------------------------------------

	/**
	 * List entities with the policy filter applied (hidden items ABSENT, §5).
	 * Resources are resolved against their host + host's network for the
	 * identity chain.
	 */
	async listVisible(kind, now = Date.now()) {
		const policy = await this.policy();
		const offlineThresholdMs = policy.offlineThresholdMs ?? this.pruneOfflineThresholdMs ?? 15 * 60 * 1000;
		const entities = await this.all(kind);
		const hosts = kind === "resources" ? await this._index("hosts") : null;
		const networks = kind !== "networks" ? await this._index("networks") : null;

		const out = [];
		for (const e of entities) {
			const host = e.host ? hosts?.[e.host] : undefined;
			const network = e.network ?? host?.network;
			const net = network ? networks?.[network] : undefined;
			const ctx = {
				owner: e.owner,
				host,
				network: net,
				ownerRules: policy.ownerRules
			};
			const gate = evaluate(e, ctx, {
				type: e.type ?? null,
				typeRules: policy.typeRules,
				knownTypes: policy.knownTypes,
				now,
				lastSeen: e.lastSeen,
				offlineThresholdMs,
				offlineOverride: policy.offlineOverrides[e.id] === true
			});
			if (gate !== "hidden") out.push({ ...e, __gate: gate });
		}
		return out;
	}

	// --- resolution (§6.1 resource_resolve) ----------------------------------

	/**
	 * Resolve a query (ip | hostname | name) to registry entities with policy
	 * applied. Hidden entities are ABSENT (§5: absent, not redacted) — a query
	 * matching only hidden items returns empty matches, indistinguishable from
	 * unknown. Each surviving match carries __gate (allow|ask) so callers can
	 * enforce ask-flows (§5).
	 * @param {string|{ip?:string,hostname?:string,name?:string}} query
	 */
	async resolve(query, now = Date.now()) {
		const q = typeof query === "string" ? { ip: query } : query ?? {};
		const ip = (q.ip ?? "").trim();
		const hostname = (q.hostname ?? "").trim().toLowerCase();
		const name = (q.name ?? "").trim();
		if (!ip && !hostname && !name) throw new Error("resolve() needs ip, hostname, or name");

		const policy = await this.policy();
		const offlineThresholdMs = policy.offlineThresholdMs ?? this.pruneOfflineThresholdMs ?? 15 * 60 * 1000;
		const hosts = await this.all("hosts");
		const resources = await this.all("resources");
		const networks = await this._index("networks");

		const seen = new Set();
		const matches = [];
		const consider = (e, host) => {
			if (!e || seen.has(e.id)) return;
			const network = e.network ?? host?.network;
			const net = network ? networks?.[network] : undefined;
			const ctx = { owner: e.owner, host, network: net, ownerRules: policy.ownerRules };
			const gate = evaluate(e, ctx, {
				type: e.type ?? null,
				typeRules: policy.typeRules,
				knownTypes: policy.knownTypes,
				now,
				lastSeen: e.lastSeen,
				offlineThresholdMs,
				offlineOverride: policy.offlineOverrides?.[e.id] === true
			});
			if (gate === "hidden") return;
			seen.add(e.id);
			matches.push({ ...e, __gate: gate });
		};

		for (const h of hosts) {
			if (ip && (h.ips ?? []).includes(ip)) consider(h, h);
			else if (
				hostname &&
				(h.name?.toLowerCase() === hostname ||
					h.fingerprint?.dhcpName?.toLowerCase() === hostname ||
					h.fingerprint?.mdns?.toLowerCase() === hostname)
			) consider(h, h);
			else if (name && (h.name === name || h.id === name)) consider(h, h);
		}
		for (const r of resources) {
			const host = hosts.find((h) => h.id === r.host);
			if (name && (r.name === name || r.id === name)) consider(r, host);
			else if (ip && r.endpoint?.includes(ip)) consider(r, host);
		}
		if (name) {
			for (const n of Object.values(networks ?? {})) {
				if (n.id === name || n.ssid === name) consider(n, undefined);
			}
		}

		return { query: { ip, hostname, name }, matches };
	}

	async _index(kind) {
		const idx = {};
		for (const e of await this.all(kind)) idx[e.id] = e;
		return idx;
	}

	// --- pruning ---------------------------------------------------------------

	/**
	 * Prune pass: remove transient (UNLABELED) entities whose lastSeen is
	 * older than pruneAfterMs. Labeled/owned entries are never touched (§4
	 * retention: labeled things are kept). Returns removed ids by kind.
	 */
	async prune(now = Date.now()) {
		const removed = { networks: [], hosts: [], resources: [] };
		for (const kind of KINDS) {
			for (const e of await this.all(kind)) {
				if (e.owner) continue; // labeled → never auto-pruned
				const lastSeen = e.lastSeen ?? e.firstSeen ?? 0;
				if (now - lastSeen > this.pruneAfterMs) {
					await this.store.remove(this._file(kind, e.id));
					removed[kind].push(e.id);
				}
			}
		}
		return removed;
	}
}
