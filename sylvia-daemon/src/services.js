import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";

/**
 * Single-instance ownership for the processes Sylvia depends on.
 *
 * The failure this exists to prevent is boring and expensive: two `bin.js web`
 * processes racing for :3080 (the second dies with EADDRINUSE, the plugin tree
 * reports `Plugins waiting for services (5): webServer`, and the panel looks
 * broken), or a second `mitmdump` fighting the first for :8080. Neither is a
 * crash — both are two owners for one port.
 *
 * The rule: **a service is identified by (name, port, cmdline pattern), and
 * whoever starts one asks this module first.** `inspect()` answers "is it
 * running, who owns it, is the port held by something else"; `ensure()` adopts
 * a live process instead of starting a second one; `stop()` kills by exact pid
 * (never a blanket kill — the daemon, the harness and the A2A plugin are all
 * `node`).
 *
 * State lives in `<stateDir>/services.json` so a daemon restart remembers what
 * it adopted. Ownership is advisory, not enforcement: the port probe is the
 * truth, and the file only explains who put it there.
 */

export const SERVICES_FILE = "services.json";

/** @typedef {{name: string, port: number, pattern: string, label: string}} ServiceDef */

/** @param {any} config */
export function serviceDefs(config) {
	return [
		{ name: "harness", port: config.webPort ?? 3080, pattern: "bin.js web", label: "DSH harness" },
		{ name: "mitm", port: config.mitmPort ?? 8080, pattern: "mitmdump", label: "mitmproxy" },
		{ name: "nine-router", port: config.nineRouterPort ?? 20128, pattern: "9router", label: "9router" },
		// The 9router module carries its OWN port setting (module.json
		// settingsSchema), which may differ from the config default; the module
		// layer overlays it before planning. The pattern is what identifies the
		// owner either way.
		// SillyTavern's port is module-owned the same way (default 8000).
		{ name: "sillytavern", port: config.sillyTavernPort ?? 8000, pattern: "sillytavern", label: "SillyTavern" },
		{ name: "daemon", port: config.port ?? 3090, pattern: "sylvia-daemon/index.js", label: "Sylvia daemon" }
	];
}

/** Is something accepting connections on host:port right now? */
export function isPortOpen(port, { host = "127.0.0.1", timeoutMs = 1200 } = {}) {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		let settled = false;
		const done = (open) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
		try {
			socket.connect(port, host);
		} catch {
			done(false);
		}
	});
}

/**
 * @param {object} deps
 * @param {any} deps.config
 * @param {(cmd: string, args: string[], opts?: any) => Promise<{code: number, stdout: string, stderr: string}>} [deps.run]
 * @param {(port: number, opts?: any) => Promise<boolean>} [deps.portOpen]
 * @param {(pid: number, signal?: string) => void} [deps.killFn]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {{info: Function, warn: Function}} [deps.logger]
 */
export function createServices({
	config,
	run,
	portOpen = isPortOpen,
	killFn = (pid, signal) => process.kill(pid, signal),
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	logger
} = {}) {
	const defs = serviceDefs(config);
	const stateFile = path.join(config.stateDir, SERVICES_FILE);
	/** @type {Record<string, {pids: number[], port: number, owner: string, at: string}>} */
	let tracked = {};

	function load() {
		try {
			const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			tracked = raw && typeof raw.services === "object" && raw.services !== null ? raw.services : {};
		} catch {
			tracked = {}; // missing or unreadable: no memory, not a failure
		}
		return tracked;
	}

	function save() {
		try {
			fs.mkdirSync(path.dirname(stateFile), { recursive: true });
			const tmp = `${stateFile}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify({ version: 1, services: tracked }, null, 2) + "\n", { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch (error) {
			logger?.warn?.(`services: could not persist ${stateFile}: ${String(error?.message ?? error)}`);
		}
	}

	function def(name) {
		const found = defs.find((entry) => entry.name === name);
		if (!found) throw new Error(`unknown service "${name}" — known: ${defs.map((entry) => entry.name).join(", ")}`);
		return found;
	}

	/** pids whose cmdline matches the service pattern (pgrep -f), never throws. */
	async function pidsFor(pattern) {
		if (typeof run !== "function") return [];
		const result = await run("pgrep", ["-f", pattern], { timeoutMs: 4000 });
		if (result.code !== 0) return [];
		return String(result.stdout ?? "")
			.split(/\s+/)
			.filter(Boolean)
			.map(Number)
			.filter((pid) => Number.isFinite(pid) && pid > 0);
	}

	async function inspect(name) {
		const entry = def(name);
		const [open, pids] = await Promise.all([portOpen(entry.port), pidsFor(entry.pattern)]);
		const mine = pids.filter((pid) => (tracked[name]?.pids ?? []).includes(pid));
		const state = pids.length > 0 || open
			? (open && pids.length === 0 ? "conflict" : "running")
			: "stopped";
		return {
			name,
			label: entry.label,
			port: entry.port,
			listening: open,
			pids,
			trackedPids: tracked[name]?.pids ?? [],
			ownedPids: mine,
			owner: tracked[name]?.owner ?? (pids.length > 0 ? "external" : null),
			since: tracked[name]?.at ?? null,
			state
		};
	}

	async function list() {
		const out = [];
		for (const entry of defs) out.push(await inspect(entry.name));
		return out;
	}

	/**
	 * Decide what to do about one service WITHOUT acting: adopt a live process,
	 * start a dead one, or refuse because something else holds the port.
	 * @returns {Promise<{ok: boolean, action: "adopt"|"start"|"conflict", detail: any}>}
	 */
	async function plan(name) {
		const seen = await inspect(name);
		if (seen.listening && seen.pids.length === 0) {
			return {
				ok: false,
				action: "conflict",
				detail: { ...seen, error: `port ${seen.port} is held by a process that does not look like ${seen.label}` }
			};
		}
		if (seen.pids.length > 0) return { ok: true, action: "adopt", detail: seen };
		return { ok: true, action: "start", detail: seen };
	}

	/** Record that we now own (or adopted) these pids for this service. */
	function record(name, pids, owner = "daemon") {
		tracked[name] = { pids: [...new Set(pids)].filter((pid) => Number.isFinite(pid) && pid > 0), port: def(name).port, owner, at: new Date().toISOString() };
		save();
		return tracked[name];
	}

	/**
	 * Adopt every live service we can see and forget the dead ones. Called at
	 * boot: after a crash the daemon must be able to STOP what it previously
	 * started, which means it has to know about processes it did not start.
	 */
	async function reconcile() {
		load();
		const results = [];
		for (const entry of defs) {
			const seen = await inspect(entry.name);
			if (seen.pids.length > 0) {
				if (tracked[entry.name]?.pids?.length === seen.pids.length) {
					results.push({ ...seen, adopted: false });
					continue;
				}
				record(entry.name, seen.pids, "adopted");
				results.push({ ...seen, adopted: true });
			} else if (tracked[entry.name] !== undefined) {
				delete tracked[entry.name];
				save();
				results.push({ ...seen, adopted: false, forgotten: true });
			} else {
				results.push({ ...seen, adopted: false });
			}
		}
		return results;
	}

	/**
	 * Stop a service by exact pid. Refuses to guess: pids are re-read from the
	 * pattern so a stale record cannot kill an unrelated process that reused
	 * the number.
	 */
	async function stop(name, { graceMs = 5000 } = {}) {
		const entry = def(name);
		const pids = await pidsFor(entry.pattern);
		if (pids.length === 0) {
			delete tracked[name];
			save();
			return { ok: true, stopped: [], already: true };
		}
		for (const pid of pids) {
			try {
				killFn(pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		const deadline = Date.now() + graceMs;
		while (Date.now() < deadline) {
			if ((await pidsFor(entry.pattern)).length === 0) break;
			await sleep(250);
		}
		const stragglers = await pidsFor(entry.pattern);
		for (const pid of stragglers) {
			try {
				killFn(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		if (stragglers.length > 0) await sleep(300);
		const survivors = await pidsFor(entry.pattern);
		if (survivors.length === 0) {
			delete tracked[name];
			save();
		}
		return { ok: survivors.length === 0, stopped: pids, stragglers, survivors };
	}

	return { defs, def, load, save, pidsFor, inspect, list, plan, record, reconcile, stop, stateFile, tracked: () => tracked };
}
