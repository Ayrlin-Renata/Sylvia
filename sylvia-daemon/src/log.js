// stderr-only logging (stdout stays clean for any future stdio concerns and
// keeps `node index.js 2>daemon.log` meaningful).
export function makeLog(prefix = "sylvia-daemon") {
	return (...args) => {
		const line = args
			.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
			.join(" ");
		process.stderr.write(`[${prefix}] ${line}\n`);
	};
}
