import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Harness lifecycle control for the control panel's **Restart harness** button.
 *
 * Restart = terminate every `dsh web` process, truncate the launcher-managed
 * startup log (so the next `token=` line is the ONLY one — a fresh token
 * unambiguously wins the newest-file race in dshurl.js), then spawn a new
 * server exactly like start-sylvia.sh does: `--no-open`, output appended to
 * ~/.sylvia/dsh-web.log, environment inherited with the Sylvia posture
 * defaults. The child is detached + unref'd so it survives the daemon.
 *
 * Readiness is NOT this module's job: the panel confirms a restart only when
 * /api/dsh-url reports the NEW token and a real token-exchange probe says the
 * server accepts it (verify: "accepted"). The spawn itself returns immediately.
 *
 * Everything injectable (spawn/exec/kill/sleep) so the test suite can drive
 * the whole sequence without touching real processes.
 */

/** Cmdline substring identifying the harness web process (same as the launcher's). */
export const WEB_PROC_PATTERN = "bin.js web";

export function createHarnessControl({
	config,
	spawnFn = spawn,
	execFileFn = (cmd, args, opts, cb) => execFile(cmd, args, opts, cb),
	killFn = (pid, sig) => process.kill(pid, sig),
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	services = null
} = {}) {
	function pids() {
		return new Promise((resolve) => {
			try {
				execFileFn("pgrep", ["-f", WEB_PROC_PATTERN], { timeout: 4000 }, (err, stdout) => {
					if (err) return resolve([]); // no match → pgrep exits 1
					resolve(String(stdout ?? "").split(/\s+/).filter(Boolean).map(Number));
				});
			} catch {
				resolve([]);
			}
		});
	}

	async function killAll() {
		const initial = await pids();
		for (const pid of initial) {
			try {
				killFn(pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		// Grace: give the plugin tree its normal disposal turn (≤5s).
		for (let i = 0; i < 10; i++) {
			if ((await pids()).length === 0) return { killed: initial, stragglers: [] };
			await sleep(500);
		}
		const stragglers = await pids();
		for (const pid of stragglers) {
			try {
				killFn(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		await sleep(300);
		return { killed: initial, stragglers };
	}

	/**
	 * Full restart sequence. Throws when the old server won't die (nothing is
	 * spawned — a port conflict would only make a bigger mess).
	 */
	async function restart() {
		const { killed, stragglers } = await killAll();
		const survivors = await pids();
		if (survivors.length > 0) {
			return { ok: false, error: `harness process(es) still alive after SIGKILL: ${survivors.join(", ")}`, killed };
		}
		// The port is the real claim on the name. If no `bin.js web` pid holds it
		// yet something is listening, spawning would only add a process that
		// dies with EADDRINUSE — refuse and say who is squatting (§21).
		if (services) {
			const plan = await services.plan("harness").catch(() => null);
			if (plan?.action === "conflict") return { ok: false, error: plan.detail.error, killed };
		}

		const logPath = path.join(config.stateDir, "dsh-web.log");
		fs.closeSync(fs.openSync(logPath, "w")); // truncate: next token is the only token
		const fd = fs.openSync(logPath, "a");

		const home = os.homedir();
		const args = ["--expose-internals", config.dshBinPath, "web", "--port", String(config.webPort), "--no-open"];
		const env = {
			...process.env,
			DSH_HOME: process.env.DSH_HOME || path.join(home, ".dsh"),
			DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || "danger-full-access",
			DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || "1"
		};
		try {
			const child = spawnFn(process.execPath, args, { env, stdio: ["ignore", fd, fd], detached: true });
			if (child && typeof child.unref === "function") child.unref();
			if (services && child?.pid) {
				try {
					services.record("harness", [child.pid]);
				} catch {
					// ownership memory is advisory
				}
			}
			return { ok: true, killed, stragglers, pid: child?.pid ?? null, log: logPath };
		} finally {
			try {
				fs.closeSync(fd); // child holds its own dup
			} catch {
				// already closed / never opened
			}
		}
	}

	return { restart, pids };
}
