// ---------------------------------------------------------------------------
// Policy engine — the visibility filter (DESIGN.md §5). Pure functions: no
// fs, no clock (caller passes `now`). Three gates:
//   hidden  — absent from every tool result / injection (default for
//             non-owned and offline)
//   ask     — bridge renders an approval prompt before use/reveal
//   allow   — auto-usable
//
// Evaluation: identity rule (most-specific-wins: resource → host → network →
// owner) gives a BASE gate, then strictest-wins merge with the type rule
// (hidden > ask > allow) — a type rule can only TIGHTEN. Unknown types
// default to ask. Offline axis overrides everything.
// ---------------------------------------------------------------------------

/** Gate severity: higher number = stricter. */
export const SEVERITY = { allow: 0, ask: 1, hidden: 2 };

export const GATES = ["allow", "ask", "hidden"];

/** Strictest-wins merge (the only merger policy uses). */
export function strictest(a, b) {
	return (SEVERITY[a] ?? 0) >= (SEVERITY[b] ?? 0) ? a : b;
}

/**
 * Base gate from the identity chain — most specific wins.
 * resource.permission → host.permission → network.permission →
 * owner rule → default hidden.
 *
 * @param {object} ctx
 * @param {{permission?: string}} [ctx.resource]
 * @param {{permission?: string}} [ctx.host]
 * @param {{permission?: string}} [ctx.network]
 * @param {string} [ctx.owner]           owner of the resource (me / <person> / none)
 * @param {Record<string,string>} [ctx.ownerRules]  per-owner default gates
 */
export function identityBase(ctx) {
	const { resource, host, network, owner, ownerRules = {} } = ctx;
	if (resource?.permission) return resource.permission;
	if (host?.permission) return host.permission;
	if (network?.permission) return network.permission;
	if (owner && ownerRules[owner]) return ownerRules[owner];
	// Owner "me" with no explicit rule anywhere → allow; unlabeled/non-owned → hidden.
	if (owner === "me") return "allow";
	return "hidden";
}

/**
 * Full evaluation for one target.
 *
 * @param {object} target  { owner?, permission? } — usually a resource
 * @param {object} ctx     identity chain (resource/host/network/ownerRules)
 * @param {object} opts
 * @param {string|null} opts.type        resource type for the class rule
 * @param {Array<{type:string,permission:string}>} [opts.typeRules]
 * @param {string[]} [opts.knownTypes]   anything not listed ⇒ at least ask
 * @param {number} opts.now              epoch ms
 * @param {number} opts.lastSeen         epoch ms of last sighting
 * @param {number} opts.offlineThresholdMs
 * @param {boolean} [opts.offlineOverride] panel grace: exempt from offline hide
 * @returns {"allow"|"ask"|"hidden"}
 */
export function evaluate(target, ctx, opts) {
	const { type = null, typeRules = [], knownTypes = [], now, lastSeen, offlineThresholdMs, offlineOverride = false } = opts;

	// 1. identity rule → base gate (most-specific-wins)
	let gate = identityBase({ ...ctx, owner: target?.owner ?? ctx.owner, resource: target });

	// 2. strictest-wins merge with the type rule (can only tighten)
	const rule = type ? typeRules.find((r) => r.type === type) : undefined;
	if (rule?.permission) {
		gate = strictest(gate, rule.permission);
	} else if (type && knownTypes.length > 0 && !knownTypes.includes(type)) {
		// Unknown/new type defaults to ask.
		gate = strictest(gate, "ask");
	}

	// 3. offline axis: overrides everything (panel grace excepted)
	if (!offlineOverride && lastSeen && now - lastSeen > offlineThresholdMs) {
		gate = "hidden";
	}

	return gate;
}

/**
 * Filter a list: hidden items are ABSENT, not redacted (§5). Non-hidden items
 * carry their gate so callers can branch on `ask` vs `allow`.
 * @returns {Array<object>} entities + { __gate } annotation
 */
export function filterVisible(entities, ctxFn, opts) {
	const out = [];
	for (const e of entities) {
		const gate = evaluate(e, ctxFn(e), opts(e));
		if (gate !== "hidden") out.push({ ...e, __gate: gate });
	}
	return out;
}

// --- policy.json shape ------------------------------------------------------
// {
//   "ownerRules": { "me": "allow" },            // per-owner default gates
//   "typeRules":  [ { "type": "image-generation", "permission": "ask" } ],
//   "knownTypes": ["image-generation","mcp","llm","storage","printer","agent","subagent-endpoint"],
//   "offlineThresholdMs": 900000,               // optional override of config
//   "offlineOverrides": { "dev:pixel7": true }  // panel grace per id
// }

export const KNOWN_TYPES = [
	"image-generation",
	"mcp",
	"llm",
	"storage",
	"printer",
	"agent",
	"subagent-endpoint"
];

/** Normalize/validate a policy.json object; never throws. */
export function normalizePolicy(raw) {
	const p = raw && typeof raw === "object" ? raw : {};
	return {
		ownerRules: p.ownerRules && typeof p.ownerRules === "object" ? p.ownerRules : {},
		typeRules: Array.isArray(p.typeRules)
			? p.typeRules.filter((r) => r && typeof r.type === "string" && GATES.includes(r.permission))
			: [],
		knownTypes: Array.isArray(p.knownTypes) && p.knownTypes.length ? p.knownTypes : KNOWN_TYPES,
		offlineThresholdMs: Number.isFinite(p.offlineThresholdMs) ? p.offlineThresholdMs : null,
		offlineOverrides: p.offlineOverrides && typeof p.offlineOverrides === "object" ? p.offlineOverrides : {}
	};
}
