import http from "node:http";
import { makeStaticHandler } from "./web.js";
import { dshUrl } from "./dshurl.js";

// ---------------------------------------------------------------------------
// Control API — loopback-only JSON over node:http (zero deps). Trust posture:
// bound to 127.0.0.1 with no auth (DESIGN.md §10) — same model as the DSH
// web UI. Consumers: sylvia-mcp tools, sylvia-bridge plugin, web panel.
// ---------------------------------------------------------------------------

const API_PREFIX = "/api";

function send(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limitBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * @param {object} deps
 * @param {import("./config.js") extends never ? any : any} deps.config
 * @param {ReturnType<import("./netgate.js").createNetgate>} deps.netgate
 * @param {()=>Promise<any>} deps.getNetstate  current detection snapshot
 * @param {()=>any} deps.getMeta               daemon meta (uptime, version…)
 * @param {import("./registry.js").Registry} [deps.registry]  resource registry (§4–§5)
 * @param {import("./modules.js").ModuleManager} [deps.modules]  module manager (§9)
 * @param {ReturnType<import("./discover.js").createDiscoverer>} [deps.discover]  LAN discovery (§7)
 * @param {ReturnType<import("./harness.js").createHarnessControl>} [deps.harness]  harness restart (control panel)
 * @param {ReturnType<import("./transport.js").createTransport>} [deps.transport]  Shizuku transport ladder (§19)
 * @returns {http.RequestListener}
 */
export function createApi({ config, netgate, getNetstate, getMeta, registry, modules, discover, harness, transport, a2a }) {
	const serveStatic = makeStaticHandler();
	// A node without the A2A plugin (or without an admin token) still serves
	// the panel: the A2A card then says "not configured" instead of the whole
	// panel erroring.
	const a2aProxy = a2a ?? { handle: async () => ({ code: 503, body: { error: "A2A proxy unavailable in this build" } }) };
	return async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const p = url.pathname;
		if (!p.startsWith(API_PREFIX)) return serveStatic(req, res);

		try {
			// ---- health ------------------------------------------------------
			if (req.method === "GET" && p === "/api/health") {
				return send(res, 200, { ok: true, ...getMeta() });
			}

			// ---- harness deep link (control panel "Open DSH") ---------------
			// Re-reads the harness startup log per request so the link always
			// carries the CURRENT one-time token (a restart mints a new one,
			// and a cleared browser session can't fall back to a cookie).
			if (req.method === "GET" && p === "/api/dsh-url") {
				return send(res, 200, await dshUrl({
					stateDir: config.stateDir,
					webPort: config.webPort ?? 3080
				}));
			}
			// POST /api/dsh/restart — terminate + respawn the harness web
			// server (fresh token). Fast path: returns once the old process is
			// gone and the new one is spawned; the panel confirms readiness by
			// polling /api/dsh-url until the NEW token verifies as accepted.
			if (req.method === "POST" && p === "/api/dsh/restart") {
				if (!harness) return send(res, 501, { ok: false, error: "harness control unavailable in this build" });
				return send(res, 200, await harness.restart());
			}

			// ---- transport ladder (§19) --------------------------------------
			// GET = last persisted state (cheap, no side effects).
			// POST ensure = one ladder pass: probe → kickstart → adb fallback
			// (+ teardown of a leftover fallback once Shizuku is healthy).
			if (transport) {
				if (req.method === "GET" && p === "/api/transport") {
					return send(res, 200, await transport.state());
				}
				if (req.method === "POST" && p === "/api/transport/ensure") {
					return send(res, 200, await transport.ensure());
				}
			}

			// ---- network -----------------------------------------------------
			if (req.method === "GET" && p === "/api/network") {
				return send(res, 200, await getNetstate());
			}

			// ---- netgate -----------------------------------------------------
			if (req.method === "GET" && p === "/api/netgate") {
				return send(res, 200, {
					...netgate.status(),
					services: netgate.list(),
					gateEnabled: config.gateEnabled,
					resumeOnReconnect: config.resumeOnReconnect
				});
			}
			if (req.method === "POST" && p === "/api/netgate/hold") {
				const body = await readJsonBody(req);
				return send(res, 200, netgate.hold(body.reason ?? "manual"));
			}
			if (req.method === "POST" && p === "/api/netgate/resume") {
				const body = await readJsonBody(req);
				return send(res, 200, netgate.resume(body.reason ?? "manual"));
			}
			if (req.method === "POST" && p === "/api/netgate/services") {
				const body = await readJsonBody(req);
				const svc = netgate.register(String(body.name ?? ""), Number(body.pgid), body.note);
				await persistNetgate();
				return send(res, 200, svc);
			}
			if (req.method === "POST" && p === "/api/netgate/services/unregister") {
				const body = await readJsonBody(req);
				const ok = netgate.unregister(String(body.name ?? ""));
				await persistNetgate();
				return send(res, 200, { unregistered: ok });
			}

			// ---- registry (§4–§5) -------------------------------------------
			if (registry) {
				const REG_KINDS = ["networks", "hosts", "resources"];

				// POST /api/registry/resolve — query {ip?,hostname?,name?} →
				// policy-gated matches (hidden ABSENT, §5). Registered before
				// the kind matcher so "resolve" isn't treated as a kind.
				if (req.method === "POST" && p === "/api/registry/resolve") {
					const body = await readJsonBody(req);
					return send(res, 200, await registry.resolve(body));
				}

				const regMatch = p.match(/^\/api\/registry\/([a-z]+)(?:\/(.*))?$/);
				if (regMatch) {
					const kind = regMatch[1];
					const rest = regMatch[2] ?? "";
					if (!REG_KINDS.includes(kind)) return send(res, 404, { error: "unknown registry kind" });

					// GET /api/registry/<kind> — policy-filtered list (hidden ABSENT)
					if (req.method === "GET" && rest === "") {
						return send(res, 200, { items: await registry.listVisible(kind) });
					}
					// POST /api/registry/<kind>/upsert — create/update (retention applies)
					if (req.method === "POST" && rest === "upsert") {
						const body = await readJsonBody(req);
						if (!body.entity) throw new Error("entity required");
						return send(res, 200, { entity: await registry.upsert(kind, body.entity) });
					}
					// POST /api/registry/<kind>/sighting — counters + identity ladder
					if (req.method === "POST" && rest === "sighting") {
						const body = await readJsonBody(req);
						if (!body.entity) throw new Error("entity required");
						return send(res, 200, { entity: await registry.recordSighting(kind, body.entity) });
					}
					// POST /api/registry/<kind>/label — user declaration/labeling
					if (req.method === "POST" && rest === "label") {
						const body = await readJsonBody(req);
						if (!body.id) throw new Error("id required");
						return send(res, 200, {
							entity: await registry.label(kind, String(body.id), {
								owner: body.owner,
								permission: body.permission
							})
						});
					}
				}

				// POST /api/registry/prune — on-demand prune pass
				if (req.method === "POST" && p === "/api/registry/prune") {
					return send(res, 200, { removed: await registry.prune() });
				}
			}

			// ---- policy --------------------------------------------------------
			if (registry) {
				if (req.method === "GET" && p === "/api/policy") {
					return send(res, 200, await registry.policy());
				}
				if (req.method === "PUT" && p === "/api/policy") {
					const body = await readJsonBody(req);
					return send(res, 200, await registry.setPolicy(body));
				}
			}

			// ---- modules (§9) -------------------------------------------------
			if (modules) {
				const MOD = /^\/api\/modules\/([a-z0-9-]+)(?:\/([a-z-]+))?$/;
				if (req.method === "GET" && p === "/api/modules") {
					return send(res, 200, { modules: await modules.list() });
				}
				const mMatch = p.match(MOD);
				if (mMatch) {
					const id = mMatch[1];
					const action = mMatch[2] ?? "";
					if (req.method === "GET" && action === "") {
						const mod = (await modules.list()).find((x) => x.id === id);
						if (!mod) return send(res, 404, { error: "unknown module" });
						return send(res, 200, mod);
					}
					if (req.method === "POST" && action === "status") return send(res, 200, await modules.status(id));
					if (req.method === "POST" && action === "on") return send(res, 200, await modules.start(id));
					if (req.method === "POST" && action === "off") return send(res, 200, await modules.stop(id));
					if (req.method === "POST" && action === "backup") return send(res, 200, await modules.backup(id));
					if (req.method === "POST" && action === "settings") {
						const body = await readJsonBody(req);
						return send(res, 200, await modules.applySettings(id, body.settings ?? {}));
					}
				}
			}

			// ---- discovery (§7) ----------------------------------------------
			// nmap-backed LAN scan → registry ingest → policy-filtered report.
			// Refuses to run when metered/offline (scan = outbound traffic).
			if (discover && req.method === "POST" && p === "/api/discover/scan") {
				const body = await readJsonBody(req);
				const report = await discover.scan({ target: body.target });
				return send(res, report.ok ? 200 : 409, report);
			}

			// ---- A2A proxy (§20.12 P3.2) --------------------------------------
			// The panel's route to the nuncia plugin's admin surface. The
			// daemon proxies with the admin token; the plugin's loopback-only
			// guard is never loosened (the daemon IS a loopback client).
			if (p.startsWith("/api/a2a/")) {
				const route = p.slice("/api/a2a/".length);
				let body;
				if (req.method === "POST" || req.method === "PUT") {
					body = await readJsonBody(req);
				}
				const result = await a2aProxy.handle(req.method, route, body);
				return send(res, result.code, result.body);
			}

			return send(res, 404, { error: "not found" });
		} catch (e) {
			return send(res, 400, { error: String(e && e.message ? e.message : e) });
		}
	};
}

async function persistNetgate() {
	// Overwritten by index.js wiring (setPersistNetgate) — kept here so the
	// handler stays self-contained and testable without fs.
	if (typeof persistNetgate.hook === "function") await persistNetgate.hook();
}
persistNetgate.hook = null;
export function setPersistNetgate(fn) {
	persistNetgate.hook = fn;
}

/** Start the API server; resolves with the server (port 0 → ephemeral, for tests). */
export function startApi(config, listener) {
	return new Promise((resolve, reject) => {
		const server = http.createServer(listener);
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			resolve(server);
		});
	});
}
