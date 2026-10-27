import test from "node:test";
import assert from "node:assert/strict";

import { netDiagnosticsTool, registerNetDiagnosticsTool } from "../lib/diagnostics.js";

/** fetch stub: routes → {status, body}; records calls. */
function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, init = {}) => {
		const path = new URL(url).pathname;
		calls.push({ path, method: init.method ?? "GET", body: init.body ?? null });
		const route = routes[path];
		if (!route) return { ok: false, status: 404, json: async () => ({ error: `no route ${path}` }) };
		return { ok: route.status === undefined || route.status < 400, status: route.status ?? 200, json: async () => route.body };
	};
	return { impl, calls };
}

const STATUS = {
	enabled: false,
	decided: true,
	registered: true,
	active: false,
	listening: false,
	installed: true,
	port: 8080,
	needsRestart: false
};

test("net_diagnostics: status reads the daemon and renders the state", async () => {
	const { impl, calls } = fakeFetch({ "/api/mitm": { body: STATUS } });
	const tool = netDiagnosticsTool({ daemonUrl: "http://127.0.0.1:3099/", fetchImpl: impl });
	assert.equal(tool.name, "net_diagnostics");
	const value = await tool.execute({});
	assert.equal(value.ok, true);
	assert.equal(value.enabled, false);
	assert.equal(value.active, false);
	assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/mitm"]);
	const [text] = tool.output.render({}, value);
	assert.match(text.text, /mitmproxy is disabled/);
	assert.match(text.text, /commented out/);
});

test("net_diagnostics: enable posts to the daemon and warns that a restart is owed", async () => {
	const { impl, calls } = fakeFetch({
		"/api/mitm/enable": { body: { ...STATUS, enabled: true, active: true, needsRestart: true } }
	});
	const tool = netDiagnosticsTool({ fetchImpl: impl });
	const value = await tool.execute({ action: "enable", note: "need packet capture for a DNS question" });
	assert.equal(value.ok, true);
	assert.equal(value.enabled, true);
	assert.equal(value.needsRestart, true);
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].path, "/api/mitm/enable");
	const [text] = tool.output.render({}, value);
	assert.match(text.text, /NOT in force yet/);
	assert.match(text.text, /ends this session/);
});

test("net_diagnostics: disable posts and reports the stopped process", async () => {
	const { impl, calls } = fakeFetch({
		"/api/mitm/disable": { body: { ...STATUS, enabled: false, active: false, listening: false, needsRestart: false } }
	});
	const tool = netDiagnosticsTool({ fetchImpl: impl });
	const value = await tool.execute({ action: "disable" });
	assert.equal(value.ok, true);
	assert.equal(value.enabled, false);
	assert.equal(calls[0].path, "/api/mitm/disable");
});

test("net_diagnostics: an unreachable daemon is a plain error, not a crash", async () => {
	const impl = async () => {
		throw new Error("connect ECONNREFUSED");
	};
	const tool = netDiagnosticsTool({ fetchImpl: impl });
	const value = await tool.execute({ action: "enable" });
	assert.equal(value.ok, false);
	assert.match(value.reason, /not reachable/);
	const [text] = tool.output.render({}, value);
	assert.match(text.text, /net_diagnostics: sylvia-daemon is not reachable/);
});

test("net_diagnostics: a daemon-side refusal keeps its reason", async () => {
	const { impl } = fakeFetch({ "/api/mitm/enable": { status: 409, body: { error: "port 8080 is held by a process that does not look like mitmproxy" } } });
	const tool = netDiagnosticsTool({ fetchImpl: impl });
	const value = await tool.execute({ action: "enable" });
	assert.equal(value.ok, false);
	assert.match(value.reason, /port 8080 is held/);
});

test("net_diagnostics: a profile without the row says so instead of claiming success", async () => {
	const { impl } = fakeFetch({
		"/api/mitm/enable": { body: { ...STATUS, registered: false, active: false, enabled: true } }
	});
	const tool = netDiagnosticsTool({ fetchImpl: impl });
	const value = await tool.execute({ action: "enable" });
	assert.equal(value.registered, false);
	assert.match(value.note, /no mitmproxy-mcp row/);
});

test("registerNetDiagnosticsTool: registers through an injected tools service", async () => {
	const registered = [];
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		inject: (names, fn) => {
			assert.deepEqual(names, ["tools"]);
			fn({ tools: { register: (tool) => registered.push(tool.name) } });
		}
	};
	registerNetDiagnosticsTool(ctx, { daemonUrl: "http://127.0.0.1:3090" });
	assert.deepEqual(registered, ["net_diagnostics"]);
});

test("registerNetDiagnosticsTool: a throwing register is logged, never fatal", async () => {
	const warnings = [];
	const ctx = {
		logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
		inject: (names, fn) => fn({ tools: { register: () => { throw new Error("duplicate tool"); } } })
	};
	registerNetDiagnosticsTool(ctx, {});
	assert.match(warnings.join(" "), /registration failed/);
});
