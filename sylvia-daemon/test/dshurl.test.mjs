import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractToken, currentToken, dshUrl } from "../src/dshurl.js";

test("extractToken: null on empty/absent, last match wins", () => {
	assert.equal(extractToken(""), null);
	assert.equal(extractToken("no tokens here"), null);
	assert.equal(
		extractToken("dsh web: http://127.0.0.1:3080/?token=AAA111"),
		"AAA111"
	);
	// A restart appends a new line — the LAST one is the live server's token.
	assert.equal(
		extractToken(
			"dsh web: http://127.0.0.1:3080/?token=OLD_old\n" +
			"other output\n" +
			"dsh web: http://127.0.0.1:3080/?token=NEW-new_2"
		),
		"NEW-new_2"
	);
});

test("currentToken: newest log with a token wins; missing files are fine", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-dshurl-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const stale = path.join(dir, "dsh-web.log");
	const fresh = path.join(dir, "token.log");
	fs.writeFileSync(stale, "dsh web: http://127.0.0.1:3080/?token=STALE1\n");
	fs.writeFileSync(fresh, "dsh web: http://127.0.0.1:3080/?token=FRESH2\n");
	// Force a clear mtime ordering (fresh is newer).
	const past = (Date.now() - 60_000) / 1000;
	fs.utimesSync(stale, past, past);

	const hit = currentToken([path.join(dir, "nope.log"), stale, fresh]);
	assert.equal(hit.token, "FRESH2");
	assert.equal(path.basename(hit.file), "token.log");

	// Only the stale file remains → its token is still reported.
	fs.rmSync(fresh);
	assert.equal(currentToken([stale]).token, "STALE1");
	// No candidate holds a token → null.
	fs.writeFileSync(stale, "nothing");
	assert.equal(currentToken([stale]), null);
});

test("dshUrl: builds tokened url + metadata, plain url when no token", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-dshurl-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// Port 1 is never listening → harness "down", but the deep link is still
	// built from the log (the server may just be between restarts).
	fs.writeFileSync(
		path.join(dir, "dsh-web.log"),
		"dsh web: http://127.0.0.1:3080/?token=TLA1AAA\n"
	);
	const withTok = await dshUrl({ stateDir: dir, webPort: 1 });
	assert.equal(withTok.token, "TLA1AAA");
	assert.equal(withTok.url, "http://127.0.0.1:1/?token=TLA1AAA");
	assert.equal(withTok.source, "dsh-web.log");
	assert.equal(withTok.harness, "down");
	assert.ok(withTok.tokenAgeMs >= 0);

	fs.rmSync(path.join(dir, "dsh-web.log"));
	const without = await dshUrl({ stateDir: dir, webPort: 1 });
	assert.equal(without.token, null);
	assert.equal(without.url, "http://127.0.0.1:1");
	assert.equal(without.source, null);
});

test("api: GET /api/dsh-url serves the current token", async (t) => {
	const { createApi, startApi } = await import("../src/api.js");
	const { createNetgate } = await import("../src/netgate.js");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-dshurl-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "token.log"), "dsh web: http://127.0.0.1:3080/?token=ROUTE_OK\n");

	const config = { port: 0, host: "127.0.0.1", gateEnabled: true, resumeOnReconnect: false, stateDir: dir, webPort: 1 };
	const listener = createApi({
		config,
		netgate: createNetgate({ killFn: () => {} }),
		getNetstate: async () => ({ transport: "wifi", metered: false, iface: "wlan0", source: "tier0", at: Date.now() }),
		getMeta: () => ({ uptimeMs: 1, pid: process.pid })
	});
	const server = await startApi(config, listener);
	t.after(() => new Promise((r) => server.close(r)));
	const base = `http://127.0.0.1:${server.address().port}`;

	const body = await (await fetch(`${base}/api/dsh-url`)).json();
	assert.equal(body.ok ?? true, true);
	assert.equal(body.token, "ROUTE_OK");
	assert.equal(body.url, "http://127.0.0.1:1/?token=ROUTE_OK");
	assert.equal(body.port, 1);
});
