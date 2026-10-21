/**
 * Tests for the netgate exemption flag (DESIGN §20.5).
 *
 * The gate SIGSTOPs whole process groups of managed services when the
 * network is metered. An EXEMPT service keeps running: it is not stopped,
 * and it is not "resumed" later (it never stopped).
 *
 * The A2A listener is the reason this exists: the operator may want the node
 * reachable on metered data while everything else is parked.
 *
 * Run: node --test test/netgate-exempt.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createNetgate } from "../src/netgate.js";

/** A kill function that records what it was asked to do. */
function makeKill() {
	const calls = [];
	return {
		calls,
		killFn(pgid, signal) {
			calls.push({ pgid, signal });
		},
	};
}

test("an exempt service is not stopped when the gate holds", () => {
	const { calls, killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:mdns", 111, "mdns");
	netgate.register("module:a2a", 222, "a2a", { exempt: true });

	const result = netgate.hold("metered");

	assert.deepEqual(result.stopped, ["module:mdns"], "only the non-exempt service stops");
	assert.deepEqual(result.exempt, ["module:a2a"]);
	// The exempt service's group was never signalled.
	assert.equal(calls.filter((c) => c.pgid === -222).length, 0);
	assert.equal(calls.filter((c) => c.pgid === -111 && c.signal === "SIGSTOP").length, 1);
});

test("an exempt service is not 'resumed' — it never stopped", () => {
	const { calls, killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:mdns", 111, "mdns");
	netgate.register("module:a2a", 222, "a2a", { exempt: true });

	netgate.hold("metered");
	calls.length = 0;
	const result = netgate.resume("reconnected");

	assert.deepEqual(result.resumed, ["module:mdns"]);
	assert.equal(calls.filter((c) => c.pgid === -222).length, 0, "the exempt service was never stopped, so it is not continued");
});

test("setExempt flips the flag of a registered service", () => {
	const { calls, killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:a2a", 222, "a2a");

	assert.equal(netgate.setExempt("module:a2a", true), true);
	assert.equal(netgate.setExempt("module:nope", true), false, "an unknown service is refused");

	netgate.hold("metered");
	assert.deepEqual(netgate.list().find((s) => s.name === "module:a2a").exempt, true);
	assert.equal(calls.filter((c) => c.pgid === -222).length, 0);
});

test("clearing the exemption puts the service back under the gate", () => {
	const { calls, killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:a2a", 222, "a2a", { exempt: true });

	netgate.setExempt("module:a2a", false);
	netgate.hold("metered");

	assert.deepEqual(netgate.list().find((s) => s.name === "module:a2a").exempt, false);
	assert.equal(calls.filter((c) => c.pgid === -222 && c.signal === "SIGSTOP").length, 1, "the service is stopped again");
});

test("the status reports the exempt set", () => {
	const { killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:mdns", 111, "mdns");
	netgate.register("module:a2a", 222, "a2a", { exempt: true });

	const status = netgate.status();
	assert.equal(status.count, 2);
	assert.deepEqual(status.exempt, ["module:a2a"]);
});

test("the exemption is off unless asked for", () => {
	const { calls, killFn } = makeKill();
	const netgate = createNetgate({ killFn });
	netgate.register("module:a2a", 222, "a2a");

	netgate.hold("metered");
	assert.equal(calls.filter((c) => c.pgid === -222 && c.signal === "SIGSTOP").length, 1, "fail-closed: nothing is exempt by default");
});
