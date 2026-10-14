import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// StateStore — single-writer atomic JSON persistence under ~/.sylvia
// (DESIGN.md §12). Write pattern: tmp file + rename so readers (mcp tools,
// web panel, plugins) never observe a half-written file.
// ---------------------------------------------------------------------------

export class StateStore {
	/** @param {string} dir */
	constructor(dir) {
		this.dir = dir;
		this.initialized = false;
	}

	async init() {
		if (this.initialized) return;
		await fs.mkdir(this.dir, { recursive: true });
		this.initialized = true;
	}

	_path(name) {
		// One optional subdirectory segment (e.g. "networks/net:home.json" for
		// the registry layout of §12). The subdirectory must be alphanumeric;
		// the file segment may carry the id charset. No "..", no extra slashes —
		// traversal is structurally impossible.
		const re = /^(?:[a-z0-9-]+\/)?[a-z0-9_:.-]+\.json$/i;
		if (!re.test(name) || name.includes("..")) {
			throw new Error(`invalid state file name: ${name}`);
		}
		return path.join(this.dir, name);
	}

	/** Read a state file; missing file → fallback (default {}). Never throws. */
	async read(name, fallback = {}) {
		try {
			const raw = await fs.readFile(this._path(name), "utf8");
			return JSON.parse(raw);
		} catch (e) {
			if (e && (e.code === "ENOENT" || e instanceof SyntaxError)) return fallback;
			throw e;
		}
	}

	/** Atomically write a state file (tmp + rename); subdirs created on demand. */
	async write(name, value) {
		const target = this._path(name);
		await fs.mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(value, null, "\t") + "\n", "utf8");
		await fs.rename(tmp, target);
	}

	/** List file names (no paths) in a subdir of the store; missing → []. */
	async list(prefix = "") {
		try {
			const entries = await fs.readdir(path.join(this.dir, prefix));
			return entries.filter((n) => n.endsWith(".json"));
		} catch (e) {
			if (e && e.code === "ENOENT") return [];
			throw e;
		}
	}

	/** Delete a state file; missing file → false. */
	async remove(name) {
		try {
			await fs.unlink(this._path(name));
			return true;
		} catch (e) {
			if (e && e.code === "ENOENT") return false;
			throw e;
		}
	}
}
