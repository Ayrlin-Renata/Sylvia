// Module manager — formalizes local services (SillyTavern, mDNS, …) as modules
// per DESIGN.md §9. Each module lives at <modulesDir>/<id>/ with a module.json
// and optional scripts/{status,on,off,backup,settings-edit}. The manager is a
// uniform wrapper: lifecycle, process groups (netgate SIGSTOP, §2.3), settings
// persistence, and cloud backup via rclone --json. Modules never ship UI — the
// settingsSchema in module.json IS the panel (§8 renders it generically).
//
// Script execution is injectable for tests; production uses a detached spawn
// (own process group on POSIX) plus sh fallback for non-executable scripts.

import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { run } from "./run.js";

export const BEHAVIORS = ["always", "manual", "tasker"];
export const SETTING_TYPES = ["port", "ip", "ip-list", "path", "bool", "enum", "string", "number"];

async function exists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function defaultExec(command, args, options) {
	return run(command, args, options);
}

function defaultSpawn(command, args, options) {
	return spawn(command, args, { stdio: "ignore", ...options });
}

function defaultKill(pid, signal) {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

// Validate one module.json. Returns { ok: true, manifest } or { ok: false, error }.
export function validateManifest(raw, dirName) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "module.json is not an object" };
	const { id, name, behavior, frontend, settingsSchema, backup, scripts, service, available, unavailableReason } = raw;
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: `invalid id: ${JSON.stringify(id)}` };
	if (dirName && id !== dirName) return { ok: false, error: `id "${id}" does not match directory "${dirName}"` };
	if (typeof name !== "string" || !name) return { ok: false, error: "name is required" };
	if (!BEHAVIORS.includes(behavior)) return { ok: false, error: `behavior must be one of ${BEHAVIORS.join("|")}` };
	if (frontend != null && typeof frontend !== "string") return { ok: false, error: "frontend must be a string URL" };
	// Optional: the supervisor service this module IS (services.js def name).
	// When set, start() asks the supervisor first and adopts a live process
	// instead of spawning a second one onto the same port (§21).
	if (service != null && (typeof service !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(service))) {
		return { ok: false, error: `service must be a services.js def name, got ${JSON.stringify(service)}` };
	}
	// Optional: a PLATFORM verdict, not a user preference. `available: false`
	// declares that this module cannot run on the current platform at all (the
	// mDNS case: Android ships neither avahi-daemon nor mdnsd, and no shell
	// process can drive the framework's NSD). start() refuses with the reason
	// instead of spawning a script that is guaranteed to fail, and the panel
	// shows the verdict. Absent/true means "assume runnable" — the module's own
	// scripts remain the authority at runtime.
	if (available !== undefined && typeof available !== "boolean") {
		return { ok: false, error: `available must be a boolean, got ${JSON.stringify(available)}` };
	}
	if (unavailableReason !== undefined && (typeof unavailableReason !== "string" || !unavailableReason)) {
		return { ok: false, error: "unavailableReason must be a non-empty string" };
	}
	if (available === false && unavailableReason === undefined) {
		return { ok: false, error: "available:false requires unavailableReason (say WHY, so the panel can explain itself)" };
	}

	if (settingsSchema !== undefined) {
		if (!Array.isArray(settingsSchema)) return { ok: false, error: "settingsSchema must be an array" };
		for (const s of settingsSchema) {
			if (!s || typeof s !== "object" || typeof s.key !== "string" || !s.key) return { ok: false, error: "settingsSchema entries need a key" };
			if (!SETTING_TYPES.includes(s.type)) return { ok: false, error: `setting ${s.key}: unknown type ${JSON.stringify(s.type)}` };
			if (s.type === "enum" && (!Array.isArray(s.options) || s.options.length === 0)) return { ok: false, error: `setting ${s.key}: enum needs options[]` };
		}
	}

	if (backup !== undefined) {
		if (!backup || typeof backup !== "object") return { ok: false, error: "backup must be an object" };
		if (backup.enabled && typeof backup.remote !== "string") return { ok: false, error: "backup.enabled requires backup.remote" };
		if (backup.paths !== undefined && !Array.isArray(backup.paths)) return { ok: false, error: "backup.paths must be an array" };
	}

	if (scripts !== undefined) {
		if (!scripts || typeof scripts !== "object") return { ok: false, error: "scripts must be an object" };
		for (const [k, v] of Object.entries(scripts)) {
			if (typeof v !== "string" || !v) return { ok: false, error: `scripts.${k} must be a relative path` };
			// script paths must stay inside the module directory
			if (path.isAbsolute(v) || v.split(/[\\/]/).includes("..")) return { ok: false, error: `scripts.${k} escapes the module directory` };
		}
	}

	return { ok: true, manifest: { id, name, behavior, frontend: frontend ?? undefined, settingsSchema: settingsSchema ?? [], backup, scripts: scripts ?? {}, service: service ?? undefined, available: available !== false, unavailableReason: unavailableReason ?? undefined } };
}

export class ModuleManager {
	constructor({ modulesDir, store, netgate, log, exec = defaultExec, spawnFn = defaultSpawn, killFn = defaultKill, exemptA2A = false, services = null }) {
		this.modulesDir = modulesDir;
		this.store = store;
		this.netgate = netgate;
		// Whether the A2A module is exempt from the netgate (DESIGN §20.5).
		this.exemptA2A = exemptA2A === true;
		// Single-owner supervisor (§21). Optional: a module without a `service`
		// field keeps the old spawn-and-hope behavior.
		this.services = services;
		this.log = log;
		this.exec = exec;
		this.spawnFn = spawnFn;
		this.killFn = killFn;
		this.modules = new Map(); // id → { manifest, dir, errors: [] }
		this.runtime = new Map(); // id → { pid, startedAt, lastError }
	}

	_scriptPath(mod, rel) {
		return path.join(mod.dir, rel);
	}

	// Build [command, args] for a module script. On POSIX the script runs
	// directly via its shebang; on Windows (dev machines) there is no shebang
	// support, so route through sh when available. Production target is Termux.
	_scriptCommand(scriptPath) {
		if (process.platform === "win32") return ["sh", [scriptPath]];
		return [scriptPath, []];
	}

	_settingsFile(id) {
		return `module-${id}.json`;
	}

	// (Re)scan <modulesDir>/*/module.json. Bad modules are recorded, not thrown.
	async discover() {
		this.modules.clear();
		let dirs = [];
		try {
			const { readdir } = await import("node:fs/promises");
			dirs = (await readdir(this.modulesDir, { withFileTypes: true }))
				.filter((d) => d.isDirectory())
				.map((d) => d.name);
		} catch {
			return { found: 0, errors: [] }; // no modules dir yet
		}
		const errors = [];
		for (const dirName of dirs) {
			const dir = path.join(this.modulesDir, dirName);
			let raw;
			try {
				raw = JSON.parse(await readFile(path.join(dir, "module.json"), "utf8"));
			} catch (e) {
				errors.push(`${dirName}: unreadable module.json (${e.message})`);
				continue;
			}
			const v = validateManifest(raw, dirName);
			if (!v.ok) {
				errors.push(`${dirName}: ${v.error}`);
				continue;
			}
			// every declared script must actually exist
			const missing = [];
			for (const [k, rel] of Object.entries(v.manifest.scripts)) {
				if (!(await exists(this._scriptPath({ dir }, rel)))) missing.push(k);
			}
			this.modules.set(dirName, { manifest: v.manifest, dir, missingScripts: missing });
		}
		return { found: this.modules.size, errors };
	}

	async list() {
		const out = [];
		for (const [id, mod] of this.modules) {
			const rt = this.runtime.get(id);
			const saved = this.store ? await this.store.read(this._settingsFile(id), {}) : {};
			out.push({
				id,
				name: mod.manifest.name,
				behavior: mod.manifest.behavior,
				// Which supervisor service this module IS (§21), if any.
				service: mod.manifest.service,
				// Platform verdict from module.json: false means "cannot run
				// here at all", with the reason the panel should quote. The
				// scripts stay the runtime authority; this is the declared one.
				available: mod.manifest.available !== false,
				unavailableReason: mod.manifest.unavailableReason,
				frontend: mod.manifest.frontend,
				settingsSchema: mod.manifest.settingsSchema,
				settings: saved.settings ?? {},
				scripts: mod.manifest.scripts,
				missingScripts: mod.missingScripts,
				backup: mod.manifest.backup,
				running: rt ? this._alive(rt.pid) : false,
				pid: rt?.pid ?? null,
				startedAt: rt?.startedAt ?? null,
				lastError: rt?.lastError ?? null
			});
		}
		return out;
	}

	_alive(pid) {
		if (!pid) return false;
		return this.killFn(pid, 0);
	}

	_get(id) {
		const mod = this.modules.get(id);
		if (!mod) throw new Error(`unknown module: ${id}`);
		return mod;
	}

	async start(id) {
		const mod = this._get(id);
		// A module declared unavailable on this platform must not be spawned:
		// its on script is guaranteed to fail (and, historically, could fail
		// while still exiting 0 — see modules/mdns/scripts/on.sh). Refusing here
		// keeps `lastDesired` from latching "on" for something that can never run.
		if (mod.manifest.available === false) {
			throw new Error(`module ${id} is not available on this platform: ${mod.manifest.unavailableReason}`);
		}
		const rel = mod.manifest.scripts.on;
		if (!rel || mod.missingScripts.includes("on")) throw new Error(`module ${id} has no on script`);
		const rt = this.runtime.get(id) ?? { pid: null, startedAt: null, lastError: null };
		if (this._alive(rt.pid)) return { id, running: true, pid: rt.pid, note: "already running" };

		// Ask the supervisor before spawning (§21). Two processes on one port is
		// the failure this prevents: the second one dies with EADDRINUSE while
		// the first keeps the port, and the module looks "started" forever.
		if (this.services && mod.manifest.service) {
			const plan = await this.services.plan(mod.manifest.service);
			if (plan.action === "conflict") throw new Error(`module ${id}: ${plan.detail.error}`);
			if (plan.action === "adopt") {
				rt.pid = plan.detail.pids[0] ?? null;
				rt.startedAt = Date.now();
				rt.lastError = null;
				this.runtime.set(id, rt);
				if (mod.manifest.behavior === "always" && this.netgate && rt.pid) {
					try {
						this.netgate.register(`module:${id}`, rt.pid, `module ${id} (adopted)`, { exempt: this.exemptA2A === true });
					} catch (e) {
						rt.lastError = `netgate register failed: ${e.message}`;
					}
				}
				this.log?.(`module ${id} adopted the live process on port ${plan.detail.port} (pid ${rt.pid}) — not spawning a duplicate`);
				return { id, running: true, pid: rt.pid, adopted: true, note: "already listening" };
			}
		}

		// ensure settings.env exists before the service starts (settings-edit.sh contract)
		await this._writeEnv(mod);
		const [sc, sa] = this._scriptCommand(this._scriptPath(mod, rel));
		const child = this.spawnFn(sc, sa, {
			cwd: mod.dir,
			detached: true // own process group on POSIX → netgate SIGSTOP target (§2.3)
		});
		const pid = child && child.pid;
		// Record on.sh's exit code (detached children aren't waitable, but the
		// child object emits "exit") so checkRestarts can surface WHY the
		// service keeps dying instead of a blind respawn storm.
		if (child && typeof child.on === "function") {
			child.on("exit", (code) => {
				const cur = this.runtime.get(id);
				if (cur && cur.pid === pid) {
					cur.lastExitCode = code ?? null;
					// Stamp the REAL death time: checkRestarts only observes on
					// its next pass (30s later), so observation-based uptime
					// would classify every instant crash as a long-lived death.
					cur.exitedAt = Date.now();
				}
			});
		}
		rt.pid = pid;
		rt.startedAt = Date.now();
		rt.lastError = null;
		rt.lastExitCode = null;
		rt.exitedAt = null;
		this.runtime.set(id, rt);

		if (mod.manifest.behavior === "always" && this.netgate && pid) {
			try {
				this.netgate.register(`module:${id}`, pid, `module ${id} (behavior=always)`, { exempt: this.exemptA2A === true });
			} catch (e) {
				rt.lastError = `netgate register failed: ${e.message}`;
			}
		}
		if (this.store) await this.store.write(this._settingsFile(id), { ...(await this.store.read(this._settingsFile(id), {})), lastDesired: "on" });
		this.log?.(`module ${id} started (pid ${pid})`);
		return { id, running: true, pid };
	}

	async stop(id) {
		const mod = this._get(id);
		const rel = mod.manifest.scripts.off;
		const rt = this.runtime.get(id);

		// service may be SIGSTOPped by the netgate — CONT before TERM so it can exit
		if (rt && this._alive(rt.pid)) {
			this.killFn(-rt.pid, "SIGCONT");
		}

		let scriptResult = null;
		if (rel && !mod.missingScripts.includes("off")) {
			scriptResult = await this._execScript(mod, rel);
		}
		// belt-and-braces: if the group is still alive after off.sh, TERM it
		if (rt && this._alive(rt.pid)) {
			this.killFn(-rt.pid, "SIGTERM");
		}
		if (this.netgate) {
			try {
				this.netgate.unregister(`module:${id}`);
			} catch {
				/* never registered */
			}
		}
		if (rt) {
			rt.pid = null;
			rt.startedAt = null;
		}
		if (this.store) await this.store.write(this._settingsFile(id), { ...(await this.store.read(this._settingsFile(id), {})), lastDesired: "off" });
		return { id, running: false, offExit: scriptResult ? scriptResult.code : null };
	}

	// Execute a module script through the platform-appropriate command (sh on
	// Windows dev, direct shebang on POSIX) with a uniform exec wrapper.
	_execScript(mod, rel, options = {}) {
		const [sc, sa] = this._scriptCommand(this._scriptPath(mod, rel));
		return this.exec(sc, sa, { cwd: mod.dir, ...options });
	}

	async status(id) {
		const mod = this._get(id);
		const rt = this.runtime.get(id);
		const pid = rt?.pid ?? null;
		const alive = this._alive(pid);
		const rel = mod.manifest.scripts.status;
		let scriptStatus = null;
		if (rel && !mod.missingScripts.includes("status")) {
			const r = await this._execScript(mod, rel);
			let parsed = null;
			try {
				parsed = JSON.parse(r.stdout);
			} catch {
				/* stdout is optional JSON; ignore */
			}
			scriptStatus = { up: r.code === 0, exitCode: r.code, detail: parsed, stderr: r.stderr?.slice(0, 500) || undefined };
		}
		return { id, behavior: mod.manifest.behavior, pid, alive, script: scriptStatus };
	}

	// Apply settings: always persist + rewrite settings.env; call settings-edit.sh
	// with the JSON patch on stdin when the module provides it (§9.2 contract).
	async applySettings(id, settings) {
		const mod = this._get(id);
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings must be an object");
		// reject unknown keys against the schema when one is declared
		const known = new Set((mod.manifest.settingsSchema ?? []).map((s) => s.key));
		if (known.size > 0) {
			for (const k of Object.keys(settings)) {
				if (!known.has(k)) throw new Error(`unknown setting: ${k}`);
			}
		}
		if (this.store) await this.store.write(this._settingsFile(id), { ...(await this.store.read(this._settingsFile(id), {})), settings });
		await this._writeEnv(mod);

		let editResult = null;
		const rel = mod.manifest.scripts.settingsEdit;
		if (rel && !mod.missingScripts.includes("settingsEdit")) {
			const r = await this._execScript(mod, rel, { input: JSON.stringify(settings) });
			editResult = { exitCode: r.code, stderr: r.stderr?.slice(0, 500) || undefined };
			if (r.code !== 0) {
				const why = r.spawnError ? `spawn error: ${r.spawnError}` : r.timedOut ? "timed out" : `exit ${r.code}`;
				throw new Error(`settings-edit.sh failed (${why}): ${editResult.stderr ?? ""}`);
			}
		}
		return { id, settings, edit: editResult };
	}

	async _writeEnv(mod) {
		const { writeFile } = await import("node:fs/promises");
		const saved = this.store ? await this.store.read(this._settingsFile(mod.manifest.id), {}) : {};
		const settings = saved.settings ?? {};
		const lines = Object.entries(settings).map(([k, v]) => {
			const value = Array.isArray(v) ? v.join(" ") : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
			return `SYLVIA_MODULE_${k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}=${value}`;
		});
		await writeFile(path.join(mod.dir, "settings.env"), `# generated by sylvia-daemon — do not edit\n${lines.join("\n")}\n`, "utf8");
	}

	// Backup: backup.sh when present; otherwise the default rclone implementation
	// (§9.3 — module.json names remote + paths, forced --json).
	async backup(id) {
		const mod = this._get(id);
		const cfg = mod.manifest.backup ?? {};
		const rel = mod.manifest.scripts.backup;
		if (rel && !mod.missingScripts.includes("backup")) {
			const r = await this._execScript(mod, rel);
			if (r.code !== 0) throw new Error(`backup.sh failed (exit ${r.code}): ${(r.stderr || "").slice(0, 500)}`);
			return { id, via: "script", exitCode: r.code, stdout: (r.stdout || "").slice(0, 2000) };
		}
		if (!cfg.enabled || !cfg.remote) throw new Error(`module ${id} has no backup script and backup.enabled is false`);
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const results = [];
		for (const src of cfg.paths ?? []) {
			const expanded = src.startsWith("~") ? path.join(home, src.replace(/^~[\\/]/, "")) : src;
			const r = await this.exec("rclone", ["sync", expanded, cfg.remote, "--json"], { timeoutMs: 300_000 });
			if (r.code !== 0) throw new Error(`rclone sync ${src} failed (exit ${r.code}): ${(r.stderr || "").slice(0, 500)}`);
			let parsed = null;
			try {
				parsed = JSON.parse(r.stdout.trim().split("\n").pop());
			} catch {
				/* best effort */
			}
			results.push({ path: src, exitCode: r.code, stats: parsed });
		}
		return { id, via: "rclone", results };
	}

	// Boot behavior (§9.4): always → start now; manual → restore last desired state.
	async autoStart() {
		for (const [id, mod] of this.modules) {
			try {
				if (mod.manifest.available === false) {
					// Never even consider it: an unavailable module that latched
					// lastDesired=on would otherwise fail on every single boot.
					continue;
				}
				if (mod.manifest.behavior === "always") {
					await this.start(id);
				} else if (mod.manifest.behavior === "manual") {
					const saved = this.store ? await this.store.read(this._settingsFile(id), {}) : {};
					if (saved.lastDesired === "on") await this.start(id);
				}
				// tasker: lifecycle belongs to Tasker profiles — manager does nothing
			} catch (e) {
				this.log?.(`autoStart ${id} failed: ${e.message}`);
			}
		}
	}

	// Auto-restart pass for behavior=always modules whose process died (§9.4).
	// Crash-loop protection: a service that dies within RAPID_MS of every
	// start (e.g. `on.sh` exits instantly because a dependency is missing)
	// gets exponential backoff instead of a per-cycle respawn storm — the
	// AVD saw 356 respawns in 105 minutes of a missing mdns daemon before
	// this guard existed. A death after a healthy stretch resets the streak,
	// and lastError records the exit code for the control panel.
	async checkRestarts() {
		const RAPID_MS = 10_000;
		const now = Date.now();
		for (const [id, mod] of this.modules) {
			if (mod.manifest.behavior !== "always") continue;
			const rt = this.runtime.get(id);
			if (!rt || !rt.pid) continue;
			if (this._alive(rt.pid)) {
				// Survived a healthy stretch → clear any crash-loop state.
				if (rt.deathStreak && rt.startedAt && now - rt.startedAt > 30_000) {
					rt.deathStreak = 0;
					rt.backoffUntil = null;
				}
				continue;
			}

			// Dead. Honor an active backoff window; restart when it expires.
			if (rt.backoffUntil && now < rt.backoffUntil) continue;
			if (rt.backoffUntil) {
				rt.backoffUntil = null;
				this.log?.(`module ${id} (always) backoff expired — restarting`);
				try {
					await this.start(id);
				} catch (e) {
					rt.lastError = e.message;
					this.log?.(`restart ${id} failed: ${e.message}`);
				}
				continue;
			}

			// Classify the death. Prefer the exit-event timestamp (real death
			// time); fall back to observation-window uptime when the spawn
			// didn't give us an exit-capable child (tests, odd platforms).
			const diedAt = rt.exitedAt ?? null;
			const uptimeMs = diedAt !== null && rt.startedAt ? diedAt - rt.startedAt
				: rt.startedAt ? now - rt.startedAt : null;
			const rapid = uptimeMs !== null && uptimeMs < RAPID_MS;
			const exitNote =
				rt.lastExitCode !== null && rt.lastExitCode !== undefined ? ` (exit ${rt.lastExitCode})` : "";

			if (rapid) {
				rt.deathStreak = (rt.deathStreak ?? 0) + 1;
				rt.lastError = `died ~${Math.round(uptimeMs / 1000)}s after start${exitNote} — death streak ${rt.deathStreak}`;
				if (rt.deathStreak >= 2) {
					// Base 60s so the retry cadence is visible (the old storm
					// was one respawn per 30s pass); cap at 15 minutes.
					const delay = Math.min(60_000 * 2 ** (rt.deathStreak - 2), 15 * 60_000);
					rt.backoffUntil = now + delay;
					// pid stays (dead) as the liveness marker; the expired-window
					// branch above performs the actual retry.
					this.log?.(
						`module ${id} (always) died ${rt.deathStreak}× within ${RAPID_MS / 1000}s of start${exitNote} — backing off ${Math.round(delay / 1000)}s`
					);
					continue;
				}
				this.log?.(`module ${id} (always) died${exitNote} ~${Math.round(uptimeMs / 1000)}s after start — restarting`);
			} else {
				rt.deathStreak = 0;
				this.log?.(`module ${id} (always) died${exitNote} — restarting`);
			}
			try {
				await this.start(id);
			} catch (e) {
				rt.lastError = e.message;
				this.log?.(`restart ${id} failed: ${e.message}`);
			}
		}
	}
}
