import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWebFile, makeStaticHandler } from "../src/web.js";

function fakeRes() {
	const res = {
		code: null,
		headers: null,
		body: undefined,
		writeHead(code, headers) { res.code = code; res.headers = headers; },
		end(body) { res.body = body; }
	};
	return res;
}

test("resolveWebFile: root maps to index.html", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "sylvia-web-"));
	try {
		await mkdir(path.join(dir, "assets"));
		await writeFile(path.join(dir, "index.html"), "<html>");
		await writeFile(path.join(dir, "assets", "app.css"), "body{}");
		await writeFile(path.join(dir, "secret.txt"), "top secret");

		assert.equal(resolveWebFile(dir, "/"), path.join(dir, "index.html"));
		assert.equal(resolveWebFile(dir, "/assets/app.css"), path.join(dir, "assets", "app.css"));
		assert.equal(resolveWebFile(dir, "/index.html?v=3"), path.join(dir, "index.html"), "query strings ignored");
		assert.equal(resolveWebFile(dir, "/secret.txt"), path.join(dir, "secret.txt"));

		// traversal attempts — must all be refused
		assert.equal(resolveWebFile(dir, "/../secret.txt"), null);
		assert.equal(resolveWebFile(dir, "/../../etc/passwd"), null);
		assert.equal(resolveWebFile(dir, "/assets/../../secret.txt"), null);
		assert.equal(resolveWebFile(dir, "/%2e%2e/secret.txt"), null, "encoded traversal refused");
		// extensionless paths refused (no static catch-all)
		assert.equal(resolveWebFile(dir, "/assets"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("makeStaticHandler: serves files, 404s misses, 405s posts", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "sylvia-web-"));
	try {
		await writeFile(path.join(dir, "index.html"), "<html>hi</html>");
		const serve = makeStaticHandler(dir);

		let res = fakeRes();
		await serve({ method: "GET", url: "/" }, res);
		assert.equal(res.code, 200);
		assert.match(res.headers["Content-Type"], /text\/html/);
		assert.ok(Buffer.isBuffer(res.body) && res.body.toString() === "<html>hi</html>");

		res = fakeRes();
		await serve({ method: "HEAD", url: "/" }, res);
		assert.equal(res.code, 200);
		assert.equal(res.body, undefined, "HEAD has no body");

		res = fakeRes();
		await serve({ method: "GET", url: "/missing.css" }, res);
		assert.equal(res.code, 404);

		res = fakeRes();
		await serve({ method: "POST", url: "/" }, res);
		assert.equal(res.code, 405);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
