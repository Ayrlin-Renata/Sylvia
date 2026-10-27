import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createServices, isPortOpen, serviceDefs, SERVICES_FILE } from "../src/services.js";

function tmpState(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-services-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const CONFIG = (dir) => ({ stateDir: dir, webPort: 3080, mitmPort: 8080, nineRouterPort: 20128, sillyTavernPort: 8000, port: 3090 });

/** run() stub: pgrep answers from a mutable pattern → pids map. */
function pgrepStub(table) {
	return async (cmd, args) => {
		assert.equal(cmd, "pgrep");
		assert.equal(args[0], "-f");
		const pids = table[args[1]] ?? [];
		return pids.length === 0
			? { code: 1, stdout: "", stderr: "" }
			: { code: 0, stdout: pids.join("\n") + "\n", stderr: "" };
	};
}

test("serviceDefs: every supervised process with its port and cmdline pattern", () => {
	const defs = serviceDefs(CONFIG("/tmp/x"));
	assert.deepEqual(defs.map((d) => d.name), ["harness", "mitm", "nine-router", "sillytavern", "daemon"]);
	assert.deepEqual(defs.map((d) => d.port), [3080, 8080, 20128, 8000, 3090]);
	assert.equal(defs[0].pattern, "bin.js web");
	// Patterns are what identify the owner; a definition without one could never
	// be adopted (only "conflict" or a duplicate spawn would be possible).
	for (const d of defs) assert.ok(d.pattern && d.pattern.length > 0, `${d.name} needs a pattern`);
});

test("isPortOpen: true for a live listener, false for a closed port", async (t) => {
	const server = net.createServer(() => {});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	t.after(() => server.close());
	assert.equal(await isPortOpen(port), true);
	assert.equal(await isPortOpen(port + 1, { timeoutMs: 300 }), false);
});

test("inspect: reports running/stopped/conflict and who owns it", async (t) => {
	const dir = tmpState(t);
	const table = { "bin.js web": [100, 200] };
	const services = createServices({ config: CONFIG(dir), run: pgrepStub(table), portOpen: async () => true });

	const seen = await services.inspect("harness");
	assert.equal(seen.state, "running");
	assert.deepEqual(seen.pids, [100, 200]);
	assert.equal(seen.owner, "external");
	assert.equal(seen.listening, true);

	// Port held but no matching process: someone else owns the name.
	const squatted = createServices({ config: CONFIG(dir), run: pgrepStub({}), portOpen: async () => true });
	const conflict = await squatted.inspect("harness");
	assert.equal(conflict.state, "conflict");
	assert.equal((await squatted.plan("harness")).action, "conflict");
	assert.match((await squatted.plan("harness")).detail.error, /port 3080 is held/);

	// Nothing at all: start it.
	const empty = createServices({ config: CONFIG(dir), run: pgrepStub({}), portOpen: async () => false });
	assert.equal((await empty.plan("harness")).action, "start");
});

test("plan: adopt a live process instead of starting a duplicate", async (t) => {
	const dir = tmpState(t);
	const services = createServices({
		config: CONFIG(dir),
		run: pgrepStub({ mitmdump: [777] }),
		portOpen: async () => true
	});
	const plan = await services.plan("mitm");
	assert.equal(plan.action, "adopt");
	assert.deepEqual(plan.detail.pids, [777]);
});

test("record + reconcile: adoption is remembered, dead services are forgotten", async (t) => {
	const dir = tmpState(t);
	const table = { "bin.js web": [11], mitmdump: [22] };
	const services = createServices({ config: CONFIG(dir), run: pgrepStub(table), portOpen: async () => true });

	const first = await services.reconcile();
	assert.equal(first.find((s) => s.name === "harness").adopted, true);
	assert.equal(first.find((s) => s.name === "mitm").adopted, true);

	const saved = JSON.parse(fs.readFileSync(path.join(dir, SERVICES_FILE), "utf8"));
	assert.deepEqual(saved.services.harness.pids, [11]);
	assert.equal(saved.services.harness.owner, "adopted");
	assert.equal(saved.services.mitm.port, 8080);

	// Second pass sees the same pids → no re-adoption churn.
	const second = await services.reconcile();
	assert.equal(second.find((s) => s.name === "harness").adopted, false);

	// The harness dies: the record must go, not linger as a stale claim.
	table["bin.js web"] = [];
	const third = await services.reconcile();
	const harness = third.find((s) => s.name === "harness");
	assert.equal(harness.forgotten, true);
	const after = JSON.parse(fs.readFileSync(path.join(dir, SERVICES_FILE), "utf8"));
	assert.equal(after.services.harness, undefined);
	assert.deepEqual(after.services.mitm.pids, [22]);
});

test("stop: SIGTERM, poll, SIGKILL stragglers, then forget the record", async (t) => {
	const dir = tmpState(t);
	const table = { "bin.js web": [31, 32] };
	const signals = [];
	const dead = new Set();
	const services = createServices({
		config: CONFIG(dir),
		run: async (cmd, args) => {
			const pids = (args[1] === "bin.js web" ? table["bin.js web"] : []).filter((pid) => !dead.has(pid));
			return pids.length ? { code: 0, stdout: pids.join("\n"), stderr: "" } : { code: 1, stdout: "", stderr: "" };
		},
		portOpen: async () => false,
		killFn: (pid, sig) => {
			signals.push(`${pid}:${sig}`);
			if (sig === "SIGKILL") dead.add(pid);
		},
		sleep: async () => {}
	});
	services.record("harness", [31, 32]);

	const result = await services.stop("harness", { graceMs: 50 });
	assert.deepEqual(result.stopped, [31, 32]);
	assert.ok(signals.includes("31:SIGTERM"));
	assert.ok(signals.includes("32:SIGKILL"), "a process that ignores SIGTERM is force-killed");
	assert.equal(services.tracked().harness, undefined);
});

test("stop: nothing running is a no-op success", async (t) => {
	const dir = tmpState(t);
	const services = createServices({ config: CONFIG(dir), run: pgrepStub({}), portOpen: async () => false });
	const result = await services.stop("mitm");
	assert.equal(result.ok, true);
	assert.equal(result.already, true);
});

test("unknown service names are refused, not guessed", async (t) => {
	const dir = tmpState(t);
	const services = createServices({ config: CONFIG(dir), run: pgrepStub({}), portOpen: async () => false });
	assert.throws(() => services.def("printer"), /unknown service "printer"/);
});

test("state file is written 0600 with a version", async (t) => {
	const dir = tmpState(t);
	const services = createServices({ config: CONFIG(dir), run: pgrepStub({ "bin.js web": [5] }), portOpen: async () => true });
	services.record("harness", [5]);
	const file = path.join(dir, SERVICES_FILE);
	// POSIX only: Windows ignores the mode and reports 0666.
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const body = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(body.version, 1);
});
