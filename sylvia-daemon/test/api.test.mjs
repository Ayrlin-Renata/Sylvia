import test from "node:test";
import assert from "node:assert/strict";

import { createApi, startApi } from "../src/api.js";
import { createNetgate } from "../src/netgate.js";

// Spin the API on an ephemeral port (port 0) with a stub config, then drive
// it with real fetches — exactly how sylvia-mcp's daemon client will.
async function withApi(t, overrides = {}) {
	const calls = [];
	const killFn = (pgid, signal) => calls.push({ pgid, signal });
	const netgate = createNetgate({ killFn });
	const config = { port: 0, host: "127.0.0.1", gateEnabled: true, resumeOnReconnect: false, ...overrides };
	const netstate = { transport: "wifi", metered: false, iface: "wlan0", source: "tier0", at: Date.now() };
	const listener = createApi({
		config,
		netgate,
		getNetstate: async () => netstate,
		getMeta: () => ({ uptimeMs: 1, pid: process.pid })
	});
	const server = await startApi(config, listener);
	const base = `http://127.0.0.1:${server.address().port}`;
	t.after(() => new Promise((r) => server.close(r)));
	return { base, netgate, calls, config };
}

test("GET /api/health → ok + meta", async (t) => {
	const { base } = await withApi(t);
	const res = await fetch(`${base}/api/health`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.ok, true);
	assert.equal(body.pid, process.pid);
});

test("GET /api/network → netstate snapshot", async (t) => {
	const { base } = await withApi(t);
	const body = await (await fetch(`${base}/api/network`)).json();
	assert.equal(body.transport, "wifi");
	assert.equal(body.metered, false);
});

test("GET /api/netgate → status + config echo", async (t) => {
	const { base } = await withApi(t);
	const body = await (await fetch(`${base}/api/netgate`)).json();
	assert.equal(body.held, false);
	assert.deepEqual(body.services, []);
	assert.equal(body.gateEnabled, true);
	assert.equal(body.resumeOnReconnect, false);
});

test("POST /api/netgate/hold → SIGSTOPs registered services", async (t) => {
	const { base, netgate, calls } = await withApi(t);
	netgate.register("rclone", 111);
	const body = await (await fetch(`${base}/api/netgate/hold`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason: "metered" })
	})).json();
	assert.deepEqual(body.stopped, ["rclone"]);
	assert.equal(body.alreadyHeld, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].signal, "SIGSTOP");
});

test("POST /api/netgate/resume → releases", async (t) => {
	const { base, netgate } = await withApi(t);
	netgate.register("rclone", 111);
	netgate.hold("x");
	const body = await (await fetch(`${base}/api/netgate/resume`, { method: "POST", body: "{}" })).json();
	assert.deepEqual(body.resumed, ["rclone"]);
});

test("POST /api/netgate/services → register + persists via hook", async (t) => {
	const { base } = await withApi(t);
	let persisted = null;
	const { setPersistNetgate } = await import("../src/api.js");
	setPersistNetgate(async () => { persisted = true; });
	t.after(() => setPersistNetgate(null));
	const res = await fetch(`${base}/api/netgate/services`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "mdns", pgid: 222, note: "module:mdns" })
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.pgid, 222);
	assert.equal(persisted, true);
});

test("POST /api/netgate/services → invalid pgid → 400", async (t) => {
	const { base } = await withApi(t);
	const res = await fetch(`${base}/api/netgate/services`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "bad", pgid: 0 })
	});
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.match(body.error, /invalid service registration/);
});

test("unknown route → 404; non-JSON body → 400", async (t) => {
	const { base } = await withApi(t);
	assert.equal((await fetch(`${base}/api/nope`)).status, 404);
	const res = await fetch(`${base}/api/netgate/hold`, { method: "POST", body: "{not json" });
	assert.equal(res.status, 400);
});
