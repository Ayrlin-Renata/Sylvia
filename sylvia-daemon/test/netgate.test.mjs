import test from "node:test";
import assert from "node:assert/strict";

import { createNetgate } from "../src/netgate.js";

function mockKill() {
	const calls = [];
	const killFn = (pgid, signal) => {
		calls.push({ pgid, signal });
	};
	return { calls, killFn };
}

test("register + list", () => {
	const g = createNetgate({ killFn: mockKill().killFn });
	g.register("rclone-sync", 4242, "module:rclone");
	const [svc] = g.list();
	assert.equal(svc.name, "rclone-sync");
	assert.equal(svc.pgid, 4242);
});

test("register: invalid inputs throw", () => {
	const g = createNetgate({ killFn: mockKill().killFn });
	assert.throws(() => g.register("", 100), /invalid service registration/);
	assert.throws(() => g.register("x", 0), /invalid service registration/);
	assert.throws(() => g.register("x", -5), /invalid service registration/);
	assert.throws(() => g.register("x", 1.5), /invalid service registration/);
});

test("hold: SIGSTOP whole group (negative pgid) per service", () => {
	const { calls, killFn } = mockKill();
	const g = createNetgate({ killFn });
	g.register("rclone", 111);
	g.register("mdns", 222);
	const r = g.hold("metered");
	assert.deepEqual(r.stopped.sort(), ["mdns", "rclone"]);
	assert.equal(r.failed.length, 0);
	assert.ok(calls.every((c) => c.signal === "SIGSTOP" && c.pgid < 0));
	assert.deepEqual(calls.map((c) => c.pgid).sort(), [-111, -222]);
	assert.equal(g.status().held, true);
	assert.equal(g.status().reason, "metered");
});

test("hold: second hold is alreadyHeld, no extra signals", () => {
	const { calls, killFn } = mockKill();
	const g = createNetgate({ killFn });
	g.register("rclone", 111);
	g.hold("metered");
	calls.length = 0;
	const r = g.hold("again");
	assert.equal(r.alreadyHeld, true);
	assert.equal(calls.length, 0);
});

test("resume: SIGCONT released, clears held state", () => {
	const { calls, killFn } = mockKill();
	const g = createNetgate({ killFn });
	g.register("rclone", 111);
	const r = g.hold("metered");
	assert.deepEqual(r.stopped, ["rclone"]);
	calls.length = 0; // forget the hold's SIGSTOP before checking resume
	const r2 = g.resume("manual");
	assert.deepEqual(r2.resumed, ["rclone"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].signal, "SIGCONT");
	assert.equal(calls[0].pgid, -111);
	assert.equal(g.status().held, false);
	assert.equal(g.status().heldSince, null);
});

test("resume: notHeld when nothing held", () => {
	const g = createNetgate({ killFn: mockKill().killFn });
	assert.equal(g.resume("x").notHeld, true);
});

test("ESRCH (dead process) is dropped quietly, not failed", () => {
	const g = createNetgate({
		killFn: () => {
			const e = new Error("kill ESRCH");
			e.code = "ESRCH";
			throw e;
		}
	});
	g.register("ghost", 999);
	const r = g.hold("metered");
	assert.deepEqual(r.stopped, []);
	assert.deepEqual(r.failed, []);
	assert.equal(g.status().held, true);
});

test("non-ESRCH errors surface as failed", () => {
	const g = createNetgate({
		killFn: () => {
			const e = new Error("kill EPERM");
			e.code = "EPERM";
			throw e;
		}
	});
	g.register("locked", 999);
	const r = g.hold("metered");
	assert.deepEqual(r.stopped, []);
	assert.equal(r.failed[0].name, "locked");
	assert.match(r.failed[0].error, /EPERM/);
});

test("unregister + count", () => {
	const g = createNetgate({ killFn: mockKill().killFn });
	g.register("a", 1);
	assert.equal(g.unregister("a"), true);
	assert.equal(g.unregister("a"), false);
	assert.equal(g.status().count, 0);
});
