import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { networkState, trafficGate } from "../src/daemon.js";

// Boot a minimal stand-in for sylvia-daemon on an ephemeral port and point
// cfg.daemonUrl at it. One server serves both live-API tests and (after we
// stop it) the state-file fallback test.
async function fakeDaemon(t, handlers) {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const h = handlers[url.pathname];
		if (!h) {
			res.writeHead(404).end("{}");
			return;
		}
		const out = typeof h === "function" ? h(req) : h;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(out));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}`;
	t.after(() => new Promise((r) => server.close(r)));
	return { url, close: () => new Promise((r) => server.close(r)) };
}

test("networkState: live daemon API", async (t) => {
	const { url } = await fakeDaemon(t, {
		"/api/network": { transport: "wifi", metered: false, iface: "wlan0", source: "tier0", at: Date.now() }
	});
	const cfg = { daemonUrl: url, daemonTimeoutMs: 2000, daemonStateFile: "/nonexistent/netstate.json" };
	const r = await networkState(cfg);
	assert.equal(r.via, "daemon");
	assert.equal(r.state.transport, "wifi");
});

test("networkState: daemon down → state-file fallback, fresh file not stale", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sylvia-fb-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "netstate.json");
	await fs.writeFile(file, JSON.stringify({ transport: "cellular", metered: true, at: Date.now() }), "utf8");

	const cfg = {
		daemonUrl: "http://127.0.0.1:1", // nothing listens here
		daemonTimeoutMs: 500,
		daemonStateFile: file
	};
	const r = await networkState(cfg);
	assert.equal(r.via, "state-file");
	assert.equal(r.state.metered, true);
	assert.notEqual(r.stale, true); // written now → fresh
});

test("networkState: old state file flagged stale", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sylvia-fb2-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "netstate.json");
	await fs.writeFile(file, JSON.stringify({ transport: "wifi", metered: false, at: Date.now() - 600_000 }), "utf8");

	const cfg = { daemonUrl: "http://127.0.0.1:1", daemonTimeoutMs: 500, daemonStateFile: file };
	const r = await networkState(cfg);
	assert.equal(r.via, "state-file");
	assert.equal(r.stale, true);
});

test("networkState: daemon down AND no file → throws with both paths", async (t) => {
	const cfg = { daemonUrl: "http://127.0.0.1:1", daemonTimeoutMs: 500, daemonStateFile: "/nope/none.json" };
	await assert.rejects(networkState(cfg), /daemon not reachable.*no state file/s);
});

test("trafficGate: status passthrough", async (t) => {
	const { url } = await fakeDaemon(t, { "/api/netgate": { held: true, reason: "metered", services: [] } });
	const r = await trafficGate({ daemonUrl: url, daemonTimeoutMs: 2000 }, "status");
	assert.equal(r.held, true);
});

test("trafficGate: hold POSTs with reason", async (t) => {
	let seen = null;
	const { url } = await fakeDaemon(t, {
		"/api/netgate/hold": (req) => {
			seen = req; // marker only; body read below is simpler:
			return { stopped: ["rclone"], alreadyHeld: false };
		}
	});
	const r = await trafficGate({ daemonUrl: url, daemonTimeoutMs: 2000 }, "hold", "data-on");
	assert.deepEqual(r.stopped, ["rclone"]);
	assert.ok(seen);
});

test("trafficGate: unknown action → throws before any network call", async (t) => {
	const { url } = await fakeDaemon(t, {});
	await assert.rejects(
		trafficGate({ daemonUrl: url, daemonTimeoutMs: 1000 }, "release"),
		/unknown traffic_gate action/
	);
});

test("trafficGate: daemon down → error propagates (fail loud)", async (t) => {
	await assert.rejects(
		trafficGate({ daemonUrl: "http://127.0.0.1:1", daemonTimeoutMs: 400 }, "hold"),
		/ECONNREFUSED|fetch failed/i
	);
});
