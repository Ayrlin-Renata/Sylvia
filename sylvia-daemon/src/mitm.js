import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * mitmproxy is a TOGGLE, not a boot dependency.
 *
 * The honest reason: the `mitmproxy-mcp` MCP server drags a `uv` tool install
 * and (on Termux) a Rust build of `mitmproxy-rs` + `cryptography`. On a 2.4 GB
 * emulator that build owns the whole machine — 48 MB free, swap exhausted, and
 * `node -e` timing out after 60 s — while the harness it is supposed to serve
 * cannot start. So mitmproxy is OFF unless someone asks for it.
 *
 * Two halves, because "enabled" has to mean something at boot:
 *
 *   1. **Registration.** The `mitmproxy-mcp` entry in the profile's
 *      `cordis.patch.yml` is wrapped in `# sylvia:mitm-mcp:begin/end` markers.
 *      Disabling comments the block out; enabling uncomments it. That is the
 *      only mechanism the harness offers — a plugin row is either present or
 *      absent, there is no per-server `enabled: false`.
 *   2. **Process.** Disabling also stops a live `mitmdump` by exact pid, so
 *      "off" means off now, not "off after the next boot".
 *
 * A change needs a harness restart to take effect (the MCP tree is built at
 * boot). This module never restarts anything itself — it reports
 * `needsRestart` and the caller decides (panel button, agent tool, human).
 */

export const MITM_STATE_FILE = "mitmproxy.json";
export const BLOCK_BEGIN = "# sylvia:mitm-mcp:begin";
export const BLOCK_END = "# sylvia:mitm-mcp:end";
const ROW_PREFIX = "- id: mitmproxy-mcp";
const COMMENT = "# ";

/** Default profile patch file for the `web` profile. */
export function defaultProfileFile(home = os.homedir()) {
	return path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
}

/**
 * Locate the mitmproxy block in a cordis patch file.
 *
 * Marker-wrapped blocks win (that is the shape the installer writes). A legacy
 * unwrapped `- id: mitmproxy-mcp` row is found by shape: the row itself plus
 * every following indented/blank line, stopping at the next top-level `- `
 * item. Returns null when the row is not in the file at all — a node where the
 * MCP was never registered is a legitimate "not installed", not an error.
 *
 * @param {string} text
 * @returns {{start: number, end: number, lines: string[], marked: boolean, commented: boolean} | null}
 */
export function findBlock(text) {
	const lines = text.split("\n");
	const begin = lines.findIndex((line) => line.trim() === BLOCK_BEGIN);
	if (begin !== -1) {
		const end = lines.findIndex((line, index) => index > begin && line.trim() === BLOCK_END);
		if (end !== -1) {
			const body = lines.slice(begin + 1, end);
			const meaningful = body.filter((line) => line.trim() !== "");
			return {
				start: begin,
				end,
				lines: body,
				marked: true,
				commented: meaningful.length > 0 && meaningful.every((line) => line.trimStart().startsWith(COMMENT))
			};
		}
	}
	const row = lines.findIndex((line) => line.trim() === ROW_PREFIX);
	if (row === -1) return null;
	let end = row + 1;
	while (end < lines.length) {
		const line = lines[end];
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		end++;
	}
	// Trailing blank lines belong to whatever follows, not to the block.
	while (end > row + 1 && lines[end - 1].trim() === "") end--;
	return { start: row, end, lines: lines.slice(row, end), marked: false, commented: false };
}

/** Comment or uncomment a block's lines (idempotent in both directions). */
export function renderBlock(lines, enabled) {
	return lines.map((line) => {
		const trimmed = line.trimStart();
		const indent = line.slice(0, line.length - trimmed.length);
		if (enabled) {
			if (!trimmed.startsWith(COMMENT)) return line;
			return indent + trimmed.slice(COMMENT.length);
		}
		if (trimmed === "" || trimmed.startsWith(COMMENT)) return line;
		// Comment BEFORE the indentation so the block stays visually aligned
		// and the whole row reads as one unit.
		return COMMENT + line;
	});
}

/**
 * Rewrite `text` so the mitmproxy block is present, marker-wrapped, and either
 * active or commented. Pure: returns the new text plus what changed.
 */
export function applyToggle(text, enabled) {
	const found = findBlock(text);
	if (found === null) return { text, found: false, changed: false, marked: false };
	const lines = text.split("\n");
	const rendered = renderBlock(found.lines, enabled);
	if (found.marked) {
		const next = [...lines.slice(0, found.start + 1), ...rendered, ...lines.slice(found.end)];
		return { text: next.join("\n"), found: true, changed: next.join("\n") !== text, marked: true };
	}
	const wrapped = [BLOCK_BEGIN, ...rendered, BLOCK_END];
	const next = [...lines.slice(0, found.start), ...wrapped, ...lines.slice(found.end)];
	return { text: next.join("\n"), found: true, changed: true, marked: true };
}

/**
 * @param {object} deps
 * @param {any} deps.config
 * @param {ReturnType<import("./services.js").createServices>} [deps.services]
 * @param {{info: Function, warn: Function}} [deps.logger]
 */
export function createMitmToggle({ config, services, logger, profileFile } = {}) {
	const stateFile = path.join(config.stateDir, MITM_STATE_FILE);
	const patchFile = profileFile ?? config.dshProfilePatch ?? defaultProfileFile();
	const port = config.mitmPort ?? 8080;

	function readState() {
		try {
			const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			return {
				enabled: raw?.enabled === true,
				updatedAt: raw?.updatedAt ?? null,
				appliedAt: raw?.appliedAt ?? null
			};
		} catch {
			return { enabled: null, updatedAt: null, appliedAt: null }; // null = never chosen
		}
	}

	/**
	 * @param {boolean} enabled
	 * @param {{changed?: boolean}} [options] `changed: false` means the profile
	 *   already had the requested shape, so the running harness is already in
	 *   the requested state and no restart is pending.
	 */
	function writeState(enabled, { changed = true } = {}) {
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		const tmp = `${stateFile}.tmp`;
		const updatedAt = new Date().toISOString();
		const appliedAt = changed ? null : updatedAt;
		const body = JSON.stringify({ version: 1, enabled, updatedAt, appliedAt }, null, 2) + "\n";
		fs.writeFileSync(tmp, body, { mode: 0o600 });
		fs.renameSync(tmp, stateFile);
		return { updatedAt, appliedAt };
	}

	/**
	 * The harness read the file (it was restarted). Until this is called, a
	 * toggle is "recorded but not in force" — the file says one thing and the
	 * running plugin tree says another.
	 */
	function markApplied() {
		const state = readState();
		if (state.enabled === null) return readState();
		const appliedAt = state.updatedAt ?? new Date().toISOString();
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		const tmp = `${stateFile}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, enabled: state.enabled, updatedAt: appliedAt, appliedAt }, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, stateFile);
		return readState();
	}

	/** Rewrite the profile patch file. Returns {found, changed, enabled}. */
	function writeProfile(enabled) {
		let text;
		try {
			text = fs.readFileSync(patchFile, "utf8");
		} catch {
			return { found: false, changed: false, enabled, error: `profile patch not found: ${patchFile}` };
		}
		const result = applyToggle(text, enabled);
		if (!result.found) {
			return { found: false, changed: false, enabled, error: "no mitmproxy-mcp row in the profile patch" };
		}
		if (result.changed) {
			const tmp = `${patchFile}.tmp`;
			fs.writeFileSync(tmp, result.text, { mode: 0o600 });
			fs.renameSync(tmp, patchFile);
		}
		// Adding the markers is not a semantic change: the row was already
		// active (or already commented), so the running harness is already in
		// the requested state and no restart is owed for it.
		const strip = (body) => body.split("\n").filter((line) => line.trim() !== BLOCK_BEGIN && line.trim() !== BLOCK_END).join("\n");
		return { found: true, changed: strip(result.text) !== strip(text), marked: result.changed, enabled };
	}

	async function status() {
		const state = readState();
		let found = null;
		try {
			found = findBlock(fs.readFileSync(patchFile, "utf8"));
		} catch {
			found = null;
		}
		const running = services ? await services.inspect("mitm") : null;
		const active = found === null ? false : !found.commented;
		const installed = fs.existsSync(path.join(os.homedir(), ".local", "bin", "mitmdump"));
		return {
			enabled: state.enabled === true,
			decided: state.enabled !== null,
			updatedAt: state.updatedAt,
			appliedAt: state.appliedAt,
			registered: found !== null,
			active,
			installed,
			port,
			listening: running?.listening ?? false,
			pids: running?.pids ?? [],
			profile: patchFile,
			// The file and the DECISION disagree → nothing is right yet.
			// The file and the decision agree, but the harness has not read it
			// since the change → the running plugin tree is stale.
			needsRestart: found !== null
				&& (active !== (state.enabled === true)
					|| (state.updatedAt !== null && state.appliedAt !== state.updatedAt))
		};
	}

	async function enable() {
		const profile = writeProfile(true);
		writeState(true, { changed: profile.changed });
		logger?.info?.(`mitm: enabled (profile ${profile.changed ? "rewritten" : "already active"}) — a harness restart exposes the tools`);
		return { ok: profile.found, ...(await status()), profile };
	}

	async function disable({ stopProcess = true } = {}) {
		const profile = writeProfile(false);
		writeState(false, { changed: profile.changed });
		let stopped = null;
		if (stopProcess && services) {
			try {
				stopped = await services.stop("mitm");
			} catch (error) {
				stopped = { ok: false, error: String(error?.message ?? error) };
			}
		}
		logger?.info?.("mitm: disabled (row commented, mitmdump stopped)");
		return { ok: profile.found, ...(await status()), profile, stopped };
	}

	/**
	 * Boot pass: make the file agree with the recorded decision. A node with no
	 * decision keeps whatever shape the file already has (an install that
	 * predates the toggle stays as it was installed).
	 */
	async function ensureAtBoot() {
		const state = readState();
		if (state.enabled === null) return { skipped: "no decision recorded", ...(await status()) };
		const profile = writeProfile(state.enabled === true);
		if (state.enabled !== true) {
			// A disabled mitmproxy must not be left running from a previous boot.
			try {
				await services?.stop?.("mitm");
			} catch {
				// best effort
			}
		}
		// The harness boots AFTER the daemon and reads this file, so the boot
		// pass counts as applied — otherwise every boot would claim a restart
		// is pending when the next harness start is exactly what applies it.
		markApplied();
		return { ...(await status()), profile };
	}

	return { status, enable, disable, ensureAtBoot, markApplied, readState, writeState, writeProfile, stateFile, patchFile };
}
