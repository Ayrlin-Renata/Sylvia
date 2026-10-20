// A2A proxy — the daemon talks to the nuncia plugin on the node's own
// loopback (DESIGN §20.12 P3.2).
//
// Why a proxy instead of the panel talking to nuncia directly: nuncia's admin
// surface is loopback-only AND bearer-guarded. The daemon IS a loopback
// client, so it can hold the admin token and let the phone's browser use the
// daemon's own (loopback-bound, session-less) API. The plugin's guard stays
// exactly as it is; nothing is loosened to make the panel work.
//
// The token: `NUNCIA_ADMIN_TOKEN` in sylvia.env — an ADDITIONAL bearer the
// plugin accepts (auth.adminToken), never the peers' derived token. So the
// panel path is explicitly keyed, and nothing token-shaped is discoverable
// (the agent card is auth-gated too).

import http from "node:http";
import https from "node:https";

/** Paths the proxy forwards, mapped to the nuncia admin path. */
const FORWARD = [
	["status", "GET"],
	["mint", "POST"],
	["revoke", "POST"],
	["requests", "GET"],
	["requests/decide", "POST"],
	["announcement", "GET"],
	["announcement", "PUT"],
	["rules", "GET"],
	["rules", "PUT"],
	["operators", "GET"],
	["operators/prune", "POST"]
];

/**
 * @param {object} deps
 * @param {any} deps.config
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createA2AProxy({ config, fetchImpl = fetch }) {
	const base = config.a2aAdminUrl;
	const token = config.a2aAdminToken;

	/**
	 * Forward one request to the plugin.
	 * @param {string} route route under /api/a2a/ (e.g. "status")
	 * @param {string} method
	 * @param {any} body
	 * @returns {Promise<{code: number, body: any}>}
	 */
	async function forward(route, method, body) {
		if (!base) return { code: 503, body: { error: "no A2A admin URL configured (SYLVIA_A2A_ADMIN_URL)" } };
		if (!token) return { code: 503, body: { error: "no A2A admin token configured (NUNCIA_ADMIN_TOKEN)" } };
		const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
		const init = {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json"
			}
		};
		if (body !== undefined) init.body = JSON.stringify(body);
		try {
			const response = await fetchImpl(url, init);
			const text = await response.text();
			let parsed;
			try {
				parsed = text === "" ? {} : JSON.parse(text);
			} catch {
				parsed = { error: "plugin returned a non-JSON body", body: text.slice(0, 400) };
			}
			return { code: response.status, body: parsed };
		} catch (error) {
			return { code: 502, body: { error: `A2A plugin unreachable: ${error instanceof Error ? error.message : String(error)}` } };
		}
	}

	/**
	 * Does this request path+method map to a forwardable route?
	 * @param {string} route
	 * @param {string} method
	 */
	function routeFor(route, method) {
		const normalized = route.replace(/^\/+/, "");
		return FORWARD.find(([name, verb]) => name === normalized && verb === method);
	}

	/**
	 * Handle one /api/a2a/* request.
	 * @param {string} reqMethod
	 * @param {string} route
	 * @param {any} body
	 */
	async function handle(reqMethod, route, body) {
		const match = routeFor(route, reqMethod);
		if (match === undefined) {
			const known = FORWARD.map(([name, verb]) => `${verb} ${name}`).join(", ");
			return { code: 404, body: { error: `unknown A2A admin route "${route}"`, known } };
		}
		return forward(match[0], match[1], body);
	}

	return { handle, forward, routeFor };
}
