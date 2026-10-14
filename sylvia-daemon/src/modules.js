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
	const { id, name, behavior, frontend, settingsSchema, backup, scripts } = raw;
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: `invalid id: ${JSON.stringify(id)}` };
	if (dirName && id !== dirName) return { ok: false, error: `id "${id}" does not match directory "${dirName}"` };
	if (typeof name !== "string" || !name) return { ok: false, error: "name is required" };
	if (!BEHAVIORS.includes(behavior)) return { ok: false, error: `behavior must be one of ${BEHAVIORS.join("|")}` };
	if (frontend != null && typeof frontend !== "string") return { ok: false, error: "frontend must be a string URL" };

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

	return { ok: true, manifest: { id, name, behavior, frontend: frontend ?? undefined, settingsSchema: settingsSchema ?? [], backup, scripts: scripts ?? {} } };
}

export class ModuleManager {
	constructor({ modulesDir, store, netgate, log, exec = defaultExec, spawnFn = defaultSpawn, killFn = defaultKill }) {
		this.modulesDir = modulesDir;
		this.store = store;
		this.netgate = netgate;
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
			const saved = this.store ? this.store.read(this._settingsFile(id), {}) : {};
			out.push({
				id,
				name: mod.manifest.name,
				behavior: mod.manifest.behavior,
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
		const rel = mod.manifest.scripts.on;
		if (!rel || mod.missingScripts.includes("on")) throw new Error(`module ${id} has no on script`);
		const rt = this.runtime.get(id) ?? { pid: null, startedAt: null, lastError: null };
		if (this._alive(rt.pid)) return { id, running: true, pid: rt.pid, note: "already running" };

		// ensure settings.env exists before the service starts (settings-edit.sh contract)
		await this._writeEnv(mod);
		const [sc, sa] = this._scriptCommand(this._scriptPath(mod, rel));
		const { pid } = this.spawnFn(sc, sa, {
			cwd: mod.dir,
			detached: true // own process group on POSIX → netgate SIGSTOP target (§2.3)
		});
		rt.pid = pid;
		rt.startedAt = Date.now();
		rt.lastError = null;
		this.runtime.set(id, rt);

		if (mod.manifest.behavior === "always" && this.netgate && pid) {
			try {
				this.netgate.register(`module:${id}`, pid, `module ${id} (behavior=always)`);
			} catch (e) {
				rt.lastError = `netgate register failed: ${e.message}`;
			}
		}
		if (this.store) this.store.write(this._settingsFile(id), { ...(this.store.read(this._settingsFile(id), {})), lastDesired: "on" });
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
		if (this.store) this.store.write(this._settingsFile(id), { ...(this.store.read(this._settingsFile(id), {})), lastDesired: "off" });
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
		if (this.store) this.store.write(this._settingsFile(id), { ...(this.store.read(this._settingsFile(id), {})), settings });
		await this._writeEnv(mod);

		let editResult = null;
		const rel = mod.manifest.scripts.settingsEdit;
		if (rel && !mod.missingScripts.includes("settingsEdit")) {
			const r = await this._execScript(mod, rel, { input: JSON.stringify(settings) });
			editResult = { exitCode: r.code, stderr: r.stderr?.slice(0, 500) || undefined };
			if (r.code !== 0) throw new Error(`settings-edit.sh failed (exit ${r.code}): ${editResult.stderr ?? ""}`);
		}
		return { id, settings, edit: editResult };
	}

	async _writeEnv(mod) {
		const { writeFile } = await import("node:fs/promises");
		const saved = this.store ? this.store.read(this._settingsFile(mod.manifest.id), {}) : {};
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
				if (mod.manifest.behavior === "always") {
					await this.start(id);
				} else if (mod.manifest.behavior === "manual") {
					const saved = this.store ? this.store.read(this._settingsFile(id), {}) : {};
					if (saved.lastDesired === "on") await this.start(id);
				}
				// tasker: lifecycle belongs to Tasker profiles — manager does nothing
			} catch (e) {
				this.log?.(`autoStart ${id} failed: ${e.message}`);
			}
		}
	}

	// Auto-restart pass for behavior=always modules whose process died (§9.4).
	async checkRestarts() {
		for (const [id, mod] of this.modules) {
			if (mod.manifest.behavior !== "always") continue;
			const rt = this.runtime.get(id);
			if (rt && rt.pid && !this._alive(rt.pid)) {
				this.log?.(`module ${id} (always) died — restarting`);
				rt.pid = null;
				try {
					await this.start(id);
				} catch (e) {
					rt.lastError = e.message;
					this.log?.(`restart ${id} failed: ${e.message}`);
				}
			}
		}
	}
}
