import { spawn } from "node:child_process";
import { run } from "./run.js";
import { log } from "./log.js";

// stderr/stdout signatures that mean "the loopback died", not "the command
// failed". Only these trigger a reconnect-and-retry; anything else is returned
// to the caller as a normal command failure.
const DROP_PATTERNS = [
	/error: no devices\/emulators found/i,
	/error: device offline/i,
	/error: device '(?:\S+)' not found/i,
	/error: connection reset by peer/i,
	/error: closed/i,
	/connection refused/i,
	/cannot connect to daemon/i,
	/unable to connect/i,
	/protocol fault/i
];

// The adb client auto-starts its server by daemonizing, and that server
// writes /tmp/adb.<uid>.log before ACKing — but on Termux /tmp is
// shell-owned, so the server dies and every client command fails with
// "ADB server didn't ACK". The nodaemon form logs to stderr instead and
// starts fine, so we bootstrap with it and retry.
const BOOT_SIG = /ADB server didn't ACK|failed to start daemon|cannot open \/tmp\/adb/i;

function looksLikeDrop(result) {
	const blob = `${result.stdout}\n${result.stderr}`;
	return DROP_PATTERNS.some((re) => re.test(blob));
}

function adbResult(r) {
	return { code: r.code, stdout: r.stdout, stderr: r.stderr, spawnError: r.spawnError };
}

export class AdbManager {
	constructor(cfg) {
		this.cfg = cfg;
		this.serial = cfg.adbSerial || null;
	}

	// --- discovery -------------------------------------------------------

	async devices() {
		let r = await run(this.cfg.adbPath, ["devices"], { timeoutMs: 10000 });
		if (r.spawnError) throw new Error(`adb binary not found at "${this.cfg.adbPath}" (install android-tools / platform-tools)`);
		if (BOOT_SIG.test(`${r.stdout}\n${r.stderr}`)) {
			// Server cannot auto-start from this uid (Termux /tmp) — bootstrap
			// the nodaemon form and retry once.
			await this.bootstrapServer();
			r = await run(this.cfg.adbPath, ["devices"], { timeoutMs: 10000 });
		}
		const out = [];
		for (const line of r.stdout.split(/\r?\n/).slice(1)) {
			const m = line.match(/^(\S+)\s+(\S+)/);
			if (m) out.push({ serial: m[1], state: m[2] });
		}
		return out;
	}

	// Spawn `adb -L tcp:5037 nodaemon server start` detached (survives our
	// exit), then poll until a `devices` probe stops showing the bootstrap
	// failure. Concurrent callers share one in-flight attempt.
	async bootstrapServer() {
		if (this._booting) return this._booting;
		this._booting = (async () => {
			log("adb server cannot auto-start from this uid — spawning nodaemon fallback");
			try {
				const child = spawn(this.cfg.adbPath, ["-L", "tcp:5037", "nodaemon", "server", "start"], {
					stdio: "ignore",
					detached: true
				});
				if (child && typeof child.unref === "function") child.unref();
			} catch {
				/* poll below decides either way */
			}
			for (let i = 0; i < 12; i++) {
				await new Promise((res) => setTimeout(res, 500));
				const p = await run(this.cfg.adbPath, ["devices"], { timeoutMs: 8000 });
				if (!p.spawnError && !BOOT_SIG.test(`${p.stdout}\n${p.stderr}`)) {
					log("adb server up (nodaemon fallback)");
					break;
				}
			}
			this._booting = null;
		})();
		return this._booting;
	}

	// Parse `adb mdns services` for the wireless-debugging connect port. Physical
	// devices rotate this port, so we rediscover it rather than cache it.
	async discoverMdnsPort() {
		const r = await run(this.cfg.adbPath, ["mdns", "services"], { timeoutMs: 8000 });
		if (r.spawnError || r.code !== 0) return null;
		// Lines look like: "adb-tls-connect._tcp <ip>:<port>"
		for (const line of r.stdout.split(/\r?\n/)) {
			const m = line.match(/adb-tls-connect\.?_?tcp\s+(\S+?):(\d+)/i) || line.match(/_adb-tls-connect\._tcp\s+(\S+?):(\d+)/i);
			if (m) return { host: m[1], port: m[2] };
		}
		return null;
	}

	// Decide the serial we should be talking to, then make sure it is connected.
	async resolveAndConnect() {
		const { cfg } = this;

		// 1. A live device already matches our explicit serial.
		if (this.serial) {
			const live = (await this.devices()).find((d) => d.serial === this.serial && d.state === "device");
			if (live) return this.serial;
		}

		// 2. Any device already online (covers emulator auto-detect).
		const online = (await this.devices()).find((d) => d.state === "device" && !d.serial.startsWith("offline"));
		if (online && cfg.adbMode !== "emulator") {
			this.serial = online.serial;
			return this.serial;
		}

		// 3. Establish the loopback ourselves.
		let target = null;
		if (cfg.adbPort) {
			target = `${cfg.adbHost}:${cfg.adbPort}`;
		} else if (cfg.adbMode === "emulator") {
			target = `${cfg.adbHost}:5555`;
		} else {
			const mdns = await this.discoverMdnsPort();
			if (mdns) target = `${cfg.adbHost}:${mdns.port}`;
			else target = `${cfg.adbHost}:5555`; // last-ditch: emulator-style fixed port
		}

		log(`connecting to ${target}`);
		const r = await run(this.cfg.adbPath, ["connect", target], { timeoutMs: cfg.adbConnectTimeoutMs });
		if (r.spawnError) throw new Error(`adb binary not found at "${this.cfg.adbPath}"`);
		// adb connect prints "connected to X" / "already connected to X" on success.
		if (!/connected/i.test(r.stdout + r.stderr) && r.code !== 0) {
			throw new Error(`adb connect ${target} failed: ${(r.stdout + r.stderr).trim() || `exit ${r.code}`}`);
		}
		this.serial = target;
		return this.serial;
	}

	// --- execution -------------------------------------------------------

	// Re-establish the loopback if the current serial is dead. Returns the serial
	// to use. Used internally by exec, and safe to call any time.
	async ensureConnected() {
		try {
			if (this.serial) {
				const live = (await this.devices()).find((d) => d.serial === this.serial && d.state === "device");
				if (live) return this.serial;
			}
		} catch {
			// fall through to a full reconnect
		}
		return await this.resolveAndConnect();
	}

	/**
	 * Run `adb [-s serial] <args>`. On a connection-drop signature, rebuild the
	 * loopback and retry up to cfg.adbMaxRetries times. Command failures (the
	 * command ran but failed) are NOT retried — they are returned as-is.
	 *
	 * @returns {Promise<{code, stdout, stderr, reconnected, attempts, serial}>}
	 */
	async exec(args, { timeoutMs } = {}) {
		const { cfg } = this;
		let reconnected = false;
		let attempts = 0;
		let last = null;

		for (let i = 0; i <= cfg.adbMaxRetries; i++) {
			attempts = i + 1;
			const serial = await this.ensureConnected();
			const fullArgs = serial ? ["-s", serial, ...args] : [...args];
			const r = await run(cfg.adbPath, fullArgs, { timeoutMs: timeoutMs ?? cfg.adbExecTimeoutMs });
			last = adbResult(r);

			if (r.spawnError) throw new Error(`adb binary not found at "${cfg.adbPath}"`);
			if (!looksLikeDrop(r)) {
				return { ...last, reconnected, attempts, serial };
			}

			// Connection dropped — force a fresh loopback before the next try.
			log(`adb connection dropped (attempt ${i + 1}/${cfg.adbMaxRetries + 1}), re-establishing:`, r.stderr.trim());
			reconnected = true;
			this.serial = null; // invalidate so ensureConnected rediscovers
			await new Promise((res) => setTimeout(res, 500 * (i + 1)));
		}
		return { ...last, reconnected, attempts, serial: this.serial };
	}

	// Convenience: run a shell command on the device.
	async shell(command, { timeoutMs } = {}) {
		return await this.exec(["shell", command], { timeoutMs });
	}

	// Push a local file to the device.
	async push(localPath, remotePath, { timeoutMs } = {}) {
		return await this.exec(["push", localPath, remotePath], { timeoutMs });
	}
}
