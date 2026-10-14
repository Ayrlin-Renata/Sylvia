import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Static file server for the web panel (§8) — zero deps, loopback-only (the
// HTTP server itself binds 127.0.0.1). Serves the bundled web/ directory.
// Path traversal is refused: the resolved file must stay inside webRoot.
// ---------------------------------------------------------------------------

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon"
};

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

/**
 * Resolve a request path to a file inside webRoot, or null if unsafe/missing.
 * Exported for tests.
 */
export function resolveWebFile(webRoot, urlPath) {
	let p;
	try {
		p = decodeURIComponent(urlPath.split("?")[0]);
	} catch {
		return null;
	}
	if (p === "/") p = "/index.html";
	// Normalize and require the result to stay under webRoot (traversal guard).
	const abs = path.normalize(path.join(webRoot, p));
	if (abs !== webRoot && !abs.startsWith(webRoot + path.sep)) return null;
	if (path.extname(abs) === "") return null; // only files with extensions + index
	return abs;
}

/**
 * Send a file from webRoot; 404 on missing, 405 on non-GET/HEAD.
 * @param {string} [root] override web root (tests)
 */
export function makeStaticHandler(root = WEB_ROOT) {
	return async function serveStatic(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { "Allow": "GET, HEAD" });
			return res.end();
		}
		const abs = resolveWebFile(root, req.url);
		if (!abs) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			return res.end("not found");
		}
		let data;
		try {
			data = await fsp.readFile(abs);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			return res.end("not found");
		}
		const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
		res.writeHead(200, {
			"Content-Type": type,
			"Content-Length": data.length,
			"Cache-Control": "no-cache"
		});
		res.end(req.method === "HEAD" ? undefined : data);
	};
}

/** Synchronous existence check used by index.js startup logging. */
export function webRootExists() {
	return fs.existsSync(path.join(WEB_ROOT, "index.html"));
}
