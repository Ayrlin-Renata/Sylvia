import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Current-harness URL for the control panel's "Open DSH" deep link.
 *
 * 0.2.1+ DSH token-auths the web UI: at startup it prints exactly one line —
 *
 *     dsh web: http://127.0.0.1:3080/?token=<current>
 *
 * — into the log the launcher manages (~/.sylvia/dsh-web.log, truncated on
 * each launcher start; a manual/dev start may append to a different file
 * instead). Opening the plain origin without the token answers 401 and the
 * browser keeps no session cookie if it was cleared, so the panel must hand
 * the CURRENT token, not a hardcoded URL.
 *
 * All of this is loopback-only state on the same box the daemon runs on, so
 * we re-read the logs on every request — a harness restart (new token) is
 * picked up without any coordination.
 */

/** Last `token=<value>` occurrence in a log blob (per-run line, last wins). */
export function extractToken(text) {
	if (!text) return null;
	const re = /token=([A-Za-z0-9_-]+)/g;
	let m;
	let last = null;
	while ((m = re.exec(text)) !== null) last = m[1];
	return last;
}

/**
 * Newest log file that actually holds a token.
 * @param {string[]} files candidate log paths (existence optional)
 * @returns {{token: string, file: string, mtimeMs: number}|null}
 */
export function currentToken(files) {
	let best = null;
	for (const f of files) {
		try {
			const st = fs.statSync(f);
			const token = extractToken(fs.readFileSync(f, "utf8"));
			if (token !== null && (best === null || st.mtimeMs > best.mtimeMs)) {
				best = { token, file: f, mtimeMs: st.mtimeMs };
			}
		} catch {
			// Missing/unreadable log = fine — another candidate may hold it.
		}
	}
	return best;
}

/** True when something is listening on host:port (fast refuse/timeout). */
function probePort(host, port, timeoutMs = 400) {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		const done = (up) => {
			sock.removeAllListeners();
			sock.destroy();
			resolve(up);
		};
		sock.setTimeout(timeoutMs, () => done(false));
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});
}

/**
 * Build the deep link + panel metadata.
 * @param {object} opts
 * @param {string} opts.stateDir       ~/.sylvia (log candidates live here)
 * @param {number} opts.webPort        DSH web port (SYLVIA_WEB_PORT)
 * @param {string[]} [opts.logs]       override candidate logs (tests)
 * @param {()=>number} [opts.now]      clock override (tests)
 */
export async function dshUrl({ stateDir, webPort, logs, now = Date.now }) {
	const files = logs ?? [path.join(stateDir, "dsh-web.log"), path.join(stateDir, "token.log")];
	const hit = currentToken(files);
	const up = await probePort("127.0.0.1", webPort);
	const base = `http://127.0.0.1:${webPort}`;
	return {
		url: hit === null ? base : `${base}/?token=${hit.token}`,
		token: hit === null ? null : hit.token,
		source: hit === null ? null : path.basename(hit.file),
		tokenAgeMs: hit === null ? null : Math.max(0, now() - hit.mtimeMs),
		harness: up ? "up" : "down",
		port: webPort
	};
}
