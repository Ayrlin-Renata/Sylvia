import { run } from "./run.js";
import { log } from "./log.js";

/**
 * Run rclone with `--json` forced on, so the agent gets machine-readable output
 * instead of parsing CLI text.
 *
 * @param {object} cfg
 * @param {string[]} args rclone args (subcommand + operands), no binary name.
 * @param {{timeoutMs?: number}} opts
 */
export async function rcloneJson(cfg, args, { timeoutMs } = {}) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new Error("rclone_exec: `args` must be a non-empty array of rclone arguments");
	}
	// Force --json unless the caller already passed it (or --help/--version,
	// which don't accept it).
	const wantsJson = !args.some((a) => a === "--help" || a === "-h" || a === "--version");
	const full = wantsJson && !flagLikeHasJson(args) ? [...args, "--json"] : [...args];

	const r = await run(cfg.rclonePath, full, { timeoutMs: timeoutMs ?? cfg.rcloneTimeoutMs });
	if (r.spawnError) throw new Error(`rclone binary not found at "${cfg.rclonePath}"`);
	log(`rclone ${full.slice(0, 2).join(" ")} -> exit ${r.code}`);

	// rclone writes JSON stats to stdout; try to parse so the model gets an
	// object, but fall back to raw text (rclone sometimes emits plain output).
	let parsed = null;
	const out = r.stdout.trim();
	if (out) {
		try {
			parsed = JSON.parse(out);
		} catch {
			parsed = null;
		}
	}

	return {
		exitCode: r.code,
		args: full,
		json: parsed,
		raw: parsed === null ? out : undefined,
		stderr: r.stderr.trim() || undefined,
		timedOut: r.timedOut
	};
}

function flagLikeHasJson(args) {
	return args.some((a) => a === "--json" || (typeof a === "string" && a.startsWith("--json")));
}
