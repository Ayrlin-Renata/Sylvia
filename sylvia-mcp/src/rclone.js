import { run } from "./run.js";
import { log } from "./log.js";

// Subcommands that do not accept --json (verified: `rclone version --json`
// → "unknown flag: --json", exit 2).
const NO_JSON_COMMANDS = new Set(["version", "help"]);

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
	// Force --json unless the caller already passed it. `version`/`help` are
	// subcommands that reject the flag outright ("unknown flag: --json", exit 2).
	// The command is the first bare word (no leading dash, no path separator —
	// test harnesses put the binary path at argv[0]; real rclone subcommands
	// are bare words like `version`/`sync`).
	const firstOperand = args.find(
		(a) => typeof a === "string" && !a.startsWith("-") && !/[\\/]/.test(a)
	);
	const noJsonCommand = typeof firstOperand === "string" && NO_JSON_COMMANDS.has(firstOperand);
	const wantsJson =
		!noJsonCommand &&
		!args.some((a) => a === "--help" || a === "-h" || a === "--version");
	const full = wantsJson && !flagLikeHasJson(args) ? [...args, "--json"] : [...args];

	let r = await run(cfg.rclonePath, full, { timeoutMs: timeoutMs ?? cfg.rcloneTimeoutMs });

	// Self-healing: if some command still rejects --json, rerun once without
	// it rather than surfacing a flag error the model has to decode.
	if (r.code === 2 && /unknown flag: --json/i.test(r.stderr ?? "")) {
		log(`rclone rejected --json for "${firstOperand ?? args[0]}" — retrying without it`);
		r = await run(cfg.rclonePath, args, { timeoutMs: timeoutMs ?? cfg.rcloneTimeoutMs });
	}

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
