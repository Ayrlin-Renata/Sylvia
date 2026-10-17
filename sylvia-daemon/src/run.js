import { execFile } from "node:child_process";

/**
 * Run a command and always resolve (never reject) with a normalized result.
 * Identical contract to sylvia-mcp/src/run.js — kept duplicated so the two
 * packages stay independently installable.
 *
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean,
 *   spawnError:string|null, stdout:string, stderr:string}>}
 */
export function run(cmd, args, { timeoutMs = 10000, maxBuffer = 4 * 1024 * 1024, cwd, env, input } = {}) {
	return new Promise((resolve) => {
		// NOTE: async execFile does NOT support the `input` option (only its
		// *Sync siblings do — it is silently ignored there), which hangs any
		// consumer waiting on stdin until the timeout SIGKILLs it. Pipe it
		// manually; EPIPE just means the child exited before reading.
		const child = execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer, killSignal: "SIGKILL", windowsHide: true, cwd, env },
			(error, stdout, stderr) => {
				let code = null;
				let signal = null;
				if (error) {
					if (typeof error.code === "number") code = error.code;
					signal = error.signal ?? null;
				} else {
					code = 0;
				}
				resolve({
					code,
					signal,
					timedOut: Boolean(error && error.killed),
					// ENOENT (and only ENOENT) means the binary itself is missing.
					spawnError: error && error.code === "ENOENT" ? String(error.message) : null,
					stdout: stdout ?? "",
					stderr: stderr ?? ""
				});
			}
		);
		if (input != null && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}
