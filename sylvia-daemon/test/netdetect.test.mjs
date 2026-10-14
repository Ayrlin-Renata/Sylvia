import test from "node:test";
import assert from "node:assert/strict";

import { parseIpRoute, classifyIface, parseMeteredIfaces, parseConnectivity, detect } from "../src/netdetect.js";

// --- parseIpRoute ----------------------------------------------------------

test("parseIpRoute: normal wifi route", () => {
	const out = "1.1.1.1 via 192.168.1.1 dev wlan0 table wlan0 src 192.168.1.50 uid 10234\n";
	const r = parseIpRoute(out, "", 0);
	assert.equal(r.iface, "wlan0");
	assert.equal(r.unreachable, false);
});

test("parseIpRoute: no gateway (direct route)", () => {
	const out = "1.1.1.1 dev rmnet_data0 table 1014 src 10.123.4.56 uid 10234\n";
	assert.equal(parseIpRoute(out, "", 0).iface, "rmnet_data0");
});

test("parseIpRoute: unreachable network (exit 2)", () => {
	const r = parseIpRoute("", "RTNETLINK answers: Network is unreachable\n", 2);
	assert.equal(r.iface, null);
	assert.equal(r.unreachable, true);
});

test("parseIpRoute: exit 0 but unreachable stderr still unreachable", () => {
	const r = parseIpRoute("", "Network is unreachable\n", 0);
	assert.equal(r.unreachable, true);
});

test("parseIpRoute: malformed output → error, no throw", () => {
	const r = parseIpRoute("garbage\n", "", 0);
	assert.equal(r.iface, null);
	assert.match(r.error, /no dev/);
});

// --- classifyIface ---------------------------------------------------------

test("classifyIface: wifi/cellular/other/none", () => {
	assert.equal(classifyIface("wlan0"), "wifi");
	assert.equal(classifyIface("wlan1"), "wifi");
	assert.equal(classifyIface("rmnet_data0"), "cellular");
	assert.equal(classifyIface("ccmni0"), "cellular");
	assert.equal(classifyIface("apn0"), "cellular");
	assert.equal(classifyIface("wwan0"), "cellular");
	assert.equal(classifyIface("eth0"), "other");
	assert.equal(classifyIface("rndis0"), "other");
	assert.equal(classifyIface(null), "none");
	assert.equal(classifyIface(""), "none");
});

// --- parseMeteredIfaces ----------------------------------------------------

test("parseMeteredIfaces: populated list", () => {
	const out = "  mMeteredIfaces=[rmnet_data0, rmnet_data1]\n";
	assert.deepEqual(parseMeteredIfaces(out), ["rmnet_data0", "rmnet_data1"]);
});

test("parseMeteredIfaces: empty list", () => {
	assert.deepEqual(parseMeteredIfaces("  mMeteredIfaces=[]\n"), []);
});

test("parseMeteredIfaces: field absent → null", () => {
	assert.equal(parseMeteredIfaces("nothing here"), null);
});

// --- parseConnectivity -----------------------------------------------------

const CONN_FIXTURE = `Active default network: 101
NetworkAgentInfo{network{101} ni{[type: MOBILE, subType: NR]} state: CONNECTED/CONNECTED}
Capabilities: NOT_METERED & VALIDATED & INTERNET & TRUSTED & NOT_RESTRICTED
`;

test("parseConnectivity: mobile unmetered validated", () => {
	const r = parseConnectivity(CONN_FIXTURE);
	assert.equal(r.netId, 101);
	assert.equal(r.type, "MOBILE");
	assert.equal(r.metered, false);
	assert.equal(r.validated, true);
});

test("parseConnectivity: 'Current default network' spelling (newer Android)", () => {
	const out = "Current default network: 102\nNetworkAgentInfo{network{102} lp{[METERED] } state: CONNECTED/CONNECTED NOT_VALIDATED}\n";
	const r = parseConnectivity(out);
	assert.equal(r.netId, 102);
	assert.equal(r.metered, true);
	assert.equal(r.validated, false);
});

test("parseConnectivity: default network -1 (none) → netId null", () => {
	const r = parseConnectivity("Active default network: -1\n");
	assert.equal(r.netId, null);
	assert.equal(r.type, null);
});

test("parseConnectivity: unrecognizable shape → null, never throws", () => {
	assert.equal(parseConnectivity("random dumpsys noise"), null);
	assert.equal(parseConnectivity(""), null);
	assert.equal(parseConnectivity(null), null);
});

// --- detect() orchestration (fake runFn) -----------------------------------

const baseCfg = { ipPath: "ip", ipRouteTarget: "1.1.1.1", adbPath: "adb", adbTimeoutMs: 100, failClosed: true };

function fakeRun(map) {
	// map: key → {stdout, stderr, code, spawnError}
	return async (bin, argv) => {
		const key = argv.join(" ");
		const hit = map[key];
		if (!hit) throw new Error(`unexpected command: ${bin} ${key}`);
		return { code: 0, signal: null, timedOut: false, spawnError: false, stdout: "", stderr: "", ...hit };
	};
}

test("detect: wifi + netpolicy says not metered → unmetered", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { stdout: "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.50\n" },
		"shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "wifi");
	assert.equal(s.metered, false);
	assert.equal(s.source, "tier0+netpolicy");
});

test("detect: cellular + netpolicy lists our iface → metered", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { stdout: "1.1.1.1 dev rmnet_data0 src 10.1.2.3\n" },
		"shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "cellular");
	assert.equal(s.metered, true);
	assert.equal(s.source, "tier0+netpolicy");
});

test("detect: netpolicy silent → falls through to connectivity", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { stdout: "1.1.1.1 dev wlan0 src 192.168.1.10\n" },
		"shell dumpsys netpolicy": { stdout: "no mMeteredIfaces field here" },
		"shell dumpsys connectivity": { stdout: CONN_FIXTURE }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.source, "tier0+connectivity");
	assert.equal(s.metered, false);
	assert.equal(s.validated, true);
});

test("detect: adb unreachable → tier-0 inference, cellular ⇒ metered", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { stdout: "1.1.1.1 dev rmnet_data0 src 10.1.2.3\n" },
		"shell dumpsys netpolicy": { code: 1, stdout: "", stderr: "error: closed" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.metered, true);
	assert.equal(s.source, "tier0-inference");
	assert.equal(s.tier1Available, false);
});

test("detect: no network at all → transport none, metered true", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { code: 2, stdout: "", stderr: "Network is unreachable\n" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "none");
	assert.equal(s.metered, true);
	assert.equal(s.source, "tier0-unreachable");
});

test("detect: ip binary missing → fail closed (metered true, source unavailable)", async () => {
	const runFn = async () => ({
		code: null, signal: null, timedOut: false, spawnError: { code: "ENOENT" }, stdout: "", stderr: ""
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.metered, true);
	assert.equal(s.source, "unavailable");
});
