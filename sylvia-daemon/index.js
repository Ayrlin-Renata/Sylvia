#!/usr/bin/env node
// ---------------------------------------------------------------------------
// sylvia-daemon — network detection + netgate + loopback control API.
// Zero runtime dependencies. Wire-up only: config → store → netgate →
// watcher → API. Every piece lives in src/ with its own tests.
// ---------------------------------------------------------------------------

import { loadConfig } from "./src/config.js";
import { makeLog } from "./src/log.js";
import { StateStore } from "./src/statemgr.js";
import { createNetgate } from "./src/netgate.js";
import { createWatcher } from "./src/watcher.js";
import { createApi, startApi, setPersistNetgate } from "./src/api.js";
import { Registry } from "./src/registry.js";
import { ModuleManager } from "./src/modules.js";
import { createDiscoverer } from "./src/discover.js";
import path from "node:path";

const log = makeLog();
const startedAt = Date.now();

export async function main(env = process.env) {
	const config = loadConfig(env);
	const store = new StateStore(config.stateDir);
	await store.init();

	const netgate = createNetgate();
	// Restore any previously-registered managed services so a daemon restart
	// doesn't orphan a held group.
	const persisted = await store.read("netgate-services.json", { services: [] });
	for (const svc of persisted.services) {
		try {
			netgate.register(svc.name, svc.pgid, svc.note);
		} catch {
			/* skip corrupt entries */
		}
	}
	setPersistNetgate(async () => {
		await store.write("netgate-services.json", {
			services: netgate.list().map(({ name, pgid, note }) => ({ name, pgid, note }))
		});
	});

	const watcher = createWatcher({ config, netgate, store, log });

	const registry = new Registry(store, {
		corroborateSightings: config.corroborateSightings,
		pruneAfterMs: config.pruneAfterMs
	});

	// Periodic prune (§12) — unowned transients older than pruneAfterMs.
	const pruneTimer = setInterval(() => {
		registry.prune().then((r) => {
			const n = r.networks.length + r.hosts.length + r.resources.length;
			if (n) log(`pruned ${n} transient entit${n === 1 ? "y" : "ies"}`);
		}).catch((e) => log("prune failed:", String(e)));
	}, config.pruneIntervalMs).unref();

	// Module manager (§9) — local services formalized as modules.
	const modules = new ModuleManager({
		modulesDir: path.join(config.stateDir, "modules"),
		store,
		netgate,
		log
	});
	const { found, errors } = await modules.discover();
	for (const err of errors) log("module error:", err);
	if (found) log(`discovered ${found} module${found === 1 ? "" : "s"}`);
	await modules.autoStart();
	// Auto-restart pass for behavior=always modules (§9.4).
	const restartTimer = setInterval(() => {
		modules.checkRestarts().catch((e) => log("restart pass failed:", String(e)));
	}, 30_000).unref();

	const api = createApi({
		config,
		netgate,
		registry,
		modules,
		discover: createDiscoverer(config, registry, async () => watcher.getLastState() ?? (await watcher.tick(), watcher.getLastState())),
		getNetstate: async () => watcher.getLastState() ?? (await watcher.tick(), watcher.getLastState()),
		getMeta: () => ({
			uptimeMs: Date.now() - startedAt,
			pid: process.pid,
			stateDir: config.stateDir,
			pollIntervalMs: config.pollIntervalMs
		})
	});

	const server = await startApi(config, api);
	log(`listening on http://${config.host}:${config.port} (state: ${config.stateDir})`);

	watcher.start();

	const shutdown = () => {
		log("shutting down");
		watcher.stop();
		clearInterval(restartTimer);
		server.close(() => process.exit(0));
		// Hard exit if a keep-alive connection stalls close.
		setTimeout(() => process.exit(0), 1500).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return { config, server, watcher, netgate, store, modules };
}

// Only auto-run when executed directly (tests import main()).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((e) => {
		log("FATAL:", String(e && e.stack ? e.stack : e));
		process.exit(1);
	});
}
