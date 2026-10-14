import { execFile } from "node:child_process";

/**
 * Run a command and always resolve (never reject) with a normalized result.
 * Non-zero exits, timeouts, and spawn failures are all reported in-band so the
 * caller decides how to react instead of unwrapping child_process error shapes.
 *
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean,
 *   spawnError:string|null, stdout:string, stderr:string}>}
 */
export function run(cmd, args, { timeoutMs = 30000, maxBuffer = 8 * 1024 * 1024 } = {}) {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer, killSignal: "SIGKILL", windowsHide: true },
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
					// A SIGKILL from our own timeout is the only reliable timeout signal.
					timedOut: Boolean(error && error.killed),
					// ENOENT (and only ENOENT) means the binary itself is missing.
					spawnError: error && error.code === "ENOENT" ? String(error.message) : null,
					stdout: stdout ?? "",
					stderr: stderr ?? ""
				});
			}
		);
	});
}
