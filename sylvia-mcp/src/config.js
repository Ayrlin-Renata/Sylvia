import os from "node:os";

function bool(v, dflt) {
	if (v === undefined || v === "") return dflt;
	return /^(1|true|yes|on)$/i.test(v);
}

function int(v, dflt) {
	const n = Number.parseInt(v ?? "", 10);
	return Number.isFinite(n) ? n : dflt;
}

/**
 * Config is injected through the DSH mcp-client `env` block (see cordis config),
 * so every knob is an env var with a safe default. Nothing here talks to the
 * network or filesystem — it is pure normalization.
 */
export function loadConfig(env = process.env) {
	return {
		// --- ADB loopback -------------------------------------------------
		adbPath: env.SYLVIA_ADB_PATH || "adb",
		// Explicit serial (e.g. "127.0.0.1:5555"). When empty we auto-connect.
		adbSerial: env.SYLVIA_ADB_SERIAL || "",
		adbHost: env.SYLVIA_ADB_HOST || "127.0.0.1",
		// 0 = unset. Emulator uses a fixed 5555; physical devices rotate a
		// dynamic wireless-debugging port (rediscovered via `adb mdns services`).
		adbPort: int(env.SYLVIA_ADB_PORT, 0),
		// "emulator" pins 5555; "auto" prefers any live device then rediscover.
		adbMode: env.SYLVIA_ADB_MODE || "auto",
		adbConnectTimeoutMs: int(env.SYLVIA_ADB_CONNECT_TIMEOUT_MS, 8000),
		adbExecTimeoutMs: int(env.SYLVIA_ADB_EXEC_TIMEOUT_MS, 30000),
		adbMaxRetries: int(env.SYLVIA_ADB_MAX_RETRIES, 2),

		// --- Tasker -------------------------------------------------------
		taskerDir: env.SYLVIA_TASKER_DIR || "/sdcard/Tasker",
		// The broadcast action fired after an XML write to make Tasker re-read.
		// VERIFY against your Tasker build in the emulator before trusting it —
		// overridable per-install because Tasker's intent surface is not stable.
		taskerReloadAction: env.SYLVIA_TASKER_RELOAD_ACTION || "net.dinglisch.android.tasker.RELOAD_VARIABLES",
		// Optional explicit component (pkg/.Receiver) for the reload broadcast.
		taskerReloadComponent: env.SYLVIA_TASKER_RELOAD_COMPONENT || "",
		// Package name checked via `pm path` before write+reload claims success
		// (am broadcast exits 0 even with zero receivers — a silent false-success).
		taskerPackage: env.SYLVIA_TASKER_PACKAGE || "net.dinglisch.android.tasker",

		// --- rclone -------------------------------------------------------
		rclonePath: env.SYLVIA_RCLONE_PATH || "rclone",
		rcloneTimeoutMs: int(env.SYLVIA_RCLONE_TIMEOUT_MS, 60000),

		// --- sylvia-daemon ------------------------------------------------
		// Loopback control API (network_state / traffic_gate tools). When the
		// daemon is unreachable these tools degrade to reading the state file
		// the daemon persists (network_state) or report an error (traffic_gate).
		daemonUrl: env.SYLVIA_DAEMON_URL || "http://127.0.0.1:3090",
		daemonTimeoutMs: int(env.SYLVIA_DAEMON_TIMEOUT_MS, 4000),
		// Fallback state file for network_state when the daemon is down.
		daemonStateFile: env.SYLVIA_NETSTATE_FILE || `${env.SYLVIA_HOME || os.homedir()}/.sylvia/netstate.json`,

		// --- misc ---------------------------------------------------------
		// Cap on bytes of stdout/stderr returned per tool call, so one huge
		// `logcat` dump cannot blow the model's context window.
		maxOutputBytes: int(env.SYLVIA_MAX_OUTPUT_BYTES, 48 * 1024),
		home: env.SYLVIA_HOME || os.homedir()
	};
}
