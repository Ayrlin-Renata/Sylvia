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
import { createHarnessControl } from "./src/harness.js";
import { createTransport } from "./src/transport.js";
import { createA2AProxy } from "./src/a2aproxy.js";
import { createServices } from "./src/services.js";
import { createMitmToggle } from "./src/mitm.js";
import { defaultAuditPath, loadDaemonSecrets } from "./src/secrets.js";
import { run } from "./src/run.js";
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

	// Process ownership (§21). Created BEFORE the module manager so a module
	// can ask "is this port already mine?" instead of spawning a duplicate.
	// `run` is REQUIRED here, not a nicety: pidsFor() shells out to `pgrep -f`
	// to find the process behind a port, and without it every service that is
	// merely LISTENING looks ownerless — inspect() then reports `conflict` for
	// Sylvia's own daemon and its own modules (the port is held, but no
	// matching pid can be found), which is the loudest possible false alarm
	// from the component whose whole job is to tell owners apart.
	const services = createServices({ config, run, logger: { info: log, warn: log } });
	const mitm = createMitmToggle({ config, services, logger: { info: log, warn: log } });

	// Module manager (§9) — local services formalized as modules.
	const modules = new ModuleManager({
		modulesDir: path.join(config.stateDir, "modules"),
		store,
		netgate,
		log,
		services,
		// The A2A listener keeps serving while the gate is held when the node
		// opts in (DESIGN §20.5). Off by default: fail-closed.
		exemptA2A: config.a2aExemptFromGate === true
	});
	const { found, errors } = await modules.discover();
	for (const err of errors) log("module error:", err);
	if (found) log(`discovered ${found} module${found === 1 ? "" : "s"}`);

	// Boot reconcile (§21): adopt whatever is already running and forget what is
	// dead. A daemon restart must still be able to STOP the harness/mitmdump it
	// started last time, which means it has to know about processes it did not
	// spawn in this pass.
	if (config.servicesReconcileOnBoot) {
		const seen = await services.reconcile().catch((error) => {
			log("services: reconcile failed:", String(error?.message ?? error));
			return [];
		});
		for (const svc of seen) {
			if (svc.adopted) log(`services: adopted ${svc.label} on :${svc.port} (pid ${svc.pids.join(", ")})`);
			else if (svc.state === "conflict") log(`services: WARNING port ${svc.port} is held by a process that does not look like ${svc.label}`);
		}
	}

	// mitmproxy is OPT-IN (§21.1): make the profile row agree with the stored
	// decision before the harness reads it, so "off" is off at boot and not
	// "off after the next restart".
	const mitmBoot = await mitm.ensureAtBoot().catch((error) => ({ error: String(error?.message ?? error) }));
	if (mitmBoot.error) log(`mitm: boot pass failed: ${mitmBoot.error}`);
	else if (mitmBoot.skipped) log(`mitm: ${mitmBoot.skipped} — leaving the profile as installed`);
	else if (mitmBoot.needsRestart) log(`mitm: ${mitmBoot.enabled ? "enabled" : "disabled"} — restart the harness to apply`);

	await modules.autoStart();
	// Auto-restart pass for behavior=always modules (§9.4).
	const restartTimer = setInterval(() => {
		modules.checkRestarts().catch((e) => log("restart pass failed:", String(e)));
	}, 30_000).unref();

	// Shizuku transport ladder (§19) — probe/kickstart/fallback/teardown.
	const transport = createTransport(config);

	// A2A proxy (§20.12 P3.2) — the panel's route to the nuncia plugin's
	// admin surface. The daemon is a loopback client, so the plugin's own
	// loopback-only guard stays exactly as it is.
	// The admin token: the environment wins, else the encrypted vault
	// (DESIGN §20.12.3). A missing token is not fatal — the proxy answers
	// 503 with a clear reason, and the panel says so.
	const daemonSecrets = loadDaemonSecrets({
		stateDir: config.stateDir,
		envToken: config.a2aAdminToken,
		vaultFile: config.a2aVaultFile,
		keyEnv: config.a2aVaultKeyEnv,
		auditFile: config.a2aVaultAuditFile || defaultAuditPath(config.stateDir),
		env: process.env
	});
	if (daemonSecrets.source === "vault") {
		log("a2a: admin token read from the encrypted vault");
	} else if (daemonSecrets.source === "env") {
		log("a2a: admin token read from the environment");
	} else {
		log("a2a: no admin token (neither the environment nor the vault has one) — the panel's A2A controls will report 503");
	}
	const a2a = createA2AProxy({ config: { ...config, a2aAdminToken: daemonSecrets.token } });

	const api = createApi({
		config,
		netgate,
		registry,
		modules,
		discover: createDiscoverer(config, registry, async () => watcher.getLastState() ?? (await watcher.tick(), watcher.getLastState())),
		harness: createHarnessControl({ config, services }),
		services,
		mitm,
		transport,
		a2a,
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

	// Boot pass of the transport ladder (§19.1): a server that died with the
	// previous session comes back headless (probe → kickstart → fallback) —
	// fire-and-forget so a slow fallback never delays API readiness. A device
	// with no Shizuku resolves quickly to "not installed" and logs once.
	if (config.transportEnsureOnBoot) {
		transport.ensure().then((r) => {
			log(r.ok
				? `transport: shizuku alive (via ${r.revivedBy ?? "probe"}${r.tier ? `, tier ${r.tier}` : ""})`
				: `transport: ladder not satisfied (${r.reason ?? "unknown"}${r.detail ? `: ${r.detail}` : ""})`);
		}).catch((e) => log("transport ensure failed:", String(e)));
	}

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
