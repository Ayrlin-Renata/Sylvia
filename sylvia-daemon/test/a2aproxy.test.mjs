/**
 * Tests for the A2A proxy (DESIGN §20.12 P3.2).
 *
 * The proxy is the panel's route to the nuncia plugin's admin surface. The
 * rules it must hold:
 *   - it carries the admin token, never the peers' derived token;
 *   - it forwards only the known routes (no path traversal into the plugin);
 *   - it never loosens the plugin's own guard — a missing token is a clear
 *     503, not a silent unauthenticated request.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createA2AProxy } from "../src/a2aproxy.js";

function harness(overrides = {}) {
	const calls = [];
	const config = {
		a2aAdminUrl: "http://127.0.0.1:4123/a2a/admin",
		a2aAdminToken: "admin-token-xyz",
		...overrides
	};
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return {
			status: 200,
			text: async () => JSON.stringify({ ok: true, echoed: url })
		};
	};
	return { proxy: createA2AProxy({ config, fetchImpl }), calls, config };
}

test("status is forwarded with the admin bearer", async () => {
	const { proxy, calls } = harness();
	const result = await proxy.handle("GET", "status", undefined);
	assert.equal(result.code, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://127.0.0.1:4123/a2a/admin/status");
	assert.equal(calls[0].init.headers.authorization, "Bearer admin-token-xyz");
	assert.equal(calls[0].init.method, "GET");
});

test("a mint body is forwarded as JSON", async () => {
	const { proxy, calls } = harness();
	const result = await proxy.handle("POST", "mint", { target: "avd", level: "intent" });
	assert.equal(result.code, 200);
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body), { target: "avd", level: "intent" });
});

test("an unknown route is refused without a request", async () => {
	const { proxy, calls } = harness();
	const result = await proxy.handle("GET", "secrets", undefined);
	assert.equal(result.code, 404);
	assert.match(result.body.error, /unknown A2A admin route/);
	assert.equal(calls.length, 0, "nothing was forwarded");
});

test("a path-traversal attempt never reaches the plugin", async () => {
	const { proxy, calls } = harness();
	for (const route of ["../status", "/status/../../etc", "status/../../rules"]) {
		const result = await proxy.handle("GET", route, undefined);
		assert.equal(result.code, 404, route);
	}
	assert.equal(calls.length, 0);
});

test("a wrong method on a known route is refused", async () => {
	const { proxy, calls } = harness();
	const result = await proxy.handle("DELETE", "status", undefined);
	assert.equal(result.code, 404);
	assert.equal(calls.length, 0);
});

test("a missing admin token is a clear 503, never an unauthenticated call", async () => {
	const { proxy, calls } = harness({ a2aAdminToken: "" });
	const result = await proxy.handle("GET", "status", undefined);
	assert.equal(result.code, 503);
	assert.match(result.body.error, /NUNCIA_ADMIN_TOKEN/);
	assert.equal(calls.length, 0, "the plugin was never called without a bearer");
});

test("a missing admin URL is a clear 503", async () => {
	const { proxy, calls } = harness({ a2aAdminUrl: "" });
	const result = await proxy.handle("GET", "status", undefined);
	assert.equal(result.code, 503);
	assert.match(result.body.error, /SYLVIA_A2A_ADMIN_URL/);
	assert.equal(calls.length, 0);
});

test("an unreachable plugin is a 502 with the reason", async () => {
	const config = { a2aAdminUrl: "http://127.0.0.1:4123/a2a/admin", a2aAdminToken: "t" };
	const proxy = createA2AProxy({
		config,
		fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
	});
	const result = await proxy.handle("GET", "status", undefined);
	assert.equal(result.code, 502);
	assert.match(result.body.error, /unreachable/);
});

test("a non-JSON plugin body is reported, not thrown", async () => {
	const config = { a2aAdminUrl: "http://127.0.0.1:4123/a2a/admin", a2aAdminToken: "t" };
	const proxy = createA2AProxy({
		config,
		fetchImpl: async () => ({ status: 500, text: async () => "<html>boom</html>" })
	});
	const result = await proxy.handle("GET", "status", undefined);
	assert.equal(result.code, 500);
	assert.match(result.body.error, /non-JSON/);
});

test("the announcement route supports both verbs", async () => {
	const { proxy, calls } = harness();
	const get = await proxy.handle("GET", "announcement", undefined);
	assert.equal(get.code, 200);
	const put = await proxy.handle("PUT", "announcement", { announcement: "on the shelf" });
	assert.equal(put.code, 200);
	assert.equal(calls[1].init.method, "PUT");
});
