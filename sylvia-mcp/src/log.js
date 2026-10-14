// stderr-only logging. stdout is reserved for the MCP JSON-RPC stream —
// anything written there corrupts the protocol framing, so every diagnostic
// goes to stderr (visible in `adb logcat` / the Termux session).
export function log(...args) {
	const line = args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
	process.stderr.write(`[sylvia-mcp] ${line}\n`);
}
