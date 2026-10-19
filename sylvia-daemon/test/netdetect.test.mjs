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

// --- denied netlink (Termux app uid) ---------------------------------------
// Real AVD finding: from the Termux uid, `ip route get` fails with
// "Cannot bind netlink socket: Permission denied" (SELinux runas_app) —
// that must NOT be treated as "no network".

test("parseIpRoute: netlink permission denied → denied, not unreachable", () => {
	const r = parseIpRoute("", "Cannot bind netlink socket: Permission denied\n", 1);
	assert.equal(r.denied, true);
	assert.equal(r.unreachable, false);
	assert.equal(r.iface, null);
});

test("parseIpRoute: unreachable text wins over the word netlink (RTNETLINK)", () => {
	const r = parseIpRoute("", "RTNETLINK answers: Network is unreachable\n", 2);
	assert.equal(r.unreachable, true);
	assert.equal(r.denied, false);
});

const DENIED = { code: 1, stdout: "", stderr: "Cannot bind netlink socket: Permission denied\n" };
const WIFI_ROUTE = { stdout: "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.50\n" };

function seqRunFn(map) {
	// Like fakeRun, but values may be arrays consumed in order per call key.
	const seen = new Map();
	return async (bin, argv) => {
		const key = argv.join(" ");
		let hit = map[key];
		if (Array.isArray(hit)) {
			const i = seen.get(key) ?? 0;
			seen.set(key, i + 1);
			hit = hit[Math.min(i, hit.length - 1)];
		}
		if (!hit) throw new Error(`unexpected command: ${bin} ${key}`);
		return { code: 0, signal: null, timedOut: false, spawnError: false, stdout: "", stderr: "", ...hit };
	};
}

test("detect: netlink denied → retries as adbd (tier0-adb+netpolicy)", async () => {
	const runFn = seqRunFn({
		"route get 1.1.1.1": DENIED,
		"shell ip route get 1.1.1.1": WIFI_ROUTE,
		"shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "wifi");
	assert.equal(s.iface, "wlan0");
	assert.equal(s.metered, false);
	assert.equal(s.source, "tier0-adb+netpolicy");
});

test("detect: denied + adb route dead → connectivity-type fallback (tier1-connectivity)", async () => {
	const runFn = seqRunFn({
		"route get 1.1.1.1": DENIED,
		"shell ip route get 1.1.1.1": { code: 1, stdout: "", stderr: "error: device offline" },
		"shell dumpsys connectivity": {
			stdout: "Active default network: 101\nNetworkAgentInfo{ni{[type: WIFI]}} network{101} NOT_METERED VALIDATED\n"
		}
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "wifi");
	assert.equal(s.metered, false);
	assert.equal(s.validated, true);
	assert.equal(s.source, "tier1-connectivity");
	assert.equal(s.tier1Available, true);
});

test("detect: denied + everything dead → tier0-denied, fail closed", async () => {
	const runFn = seqRunFn({
		"route get 1.1.1.1": DENIED,
		"shell ip route get 1.1.1.1": { code: 1, stdout: "", stderr: "error: device offline" },
		"shell dumpsys connectivity": { code: 1, stdout: "", stderr: "error: closed" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.transport, "none");
	assert.equal(s.metered, true);
	assert.equal(s.source, "tier0-denied");
});

test("detect: adb bootstrap signature → nodaemon fallback spawns, command retried", async () => {
	const spawned = [];
	const runFn = seqRunFn({
		"route get 1.1.1.1": WIFI_ROUTE,
		"devices": [
			{ code: 1, stdout: "", stderr: "adb: ADB server didn't ACK\nfailed to start daemon: cannot open /tmp/adb.10217.log\n" },
			{ stdout: "List of devices attached\n127.0.0.1:5555\tdevice\n" }
		],
		"shell dumpsys netpolicy": [
			{ code: 1, stdout: "", stderr: "adb: ADB server didn't ACK\n" },
			{ stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
		]
	});
	const spawnFn = (bin, args) => {
		spawned.push(args.join(" "));
		return { unref() {} };
	};
	const s = await detect(baseCfg, runFn, spawnFn);
	assert.equal(spawned.length, 1, "nodaemon server spawned once");
	assert.ok(spawned[0].includes("nodaemon"), "spawned the nodaemon form");
	assert.equal(s.metered, false, "netpolicy retry succeeded");
	assert.equal(s.source, "tier0+netpolicy");
});

test("detect: multi-transport server → auto serial passed as -s (adbAutoSerial)", async () => {
	// Fresh-install AVD shape: loopback connect + mdns discovery give TWO
	// device entries; bare `adb shell` fails "more than one device/emulator"
	// and used to collapse every adb tier into tier0-denied.
	const runFn = seqRunFn({
		"route get 1.1.1.1": DENIED,
		"devices": { stdout: "List of devices attached\n127.0.0.1:5555\tdevice\nemulator-5554\tdevice\n" },
		"-s 127.0.0.1:5555 shell ip route get 1.1.1.1": WIFI_ROUTE,
		"-s 127.0.0.1:5555 shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect({ ...baseCfg, adbAutoSerial: true }, runFn);
	assert.equal(s.source, "tier0-adb+netpolicy", "adb tier worked because -s was applied");
	assert.equal(s.transport, "wifi");
	assert.equal(s.metered, false);
});

test("detect: adbAutoSerial off → no devices probe, legacy serialArgs behavior", async () => {
	// Without the opt-in flag, nothing calls `devices` (this seqRunFn throws
	// on unexpected commands, proving the probe is skipped).
	const runFn = seqRunFn({
		"route get 1.1.1.1": WIFI_ROUTE,
		"shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect(baseCfg, runFn);
	assert.equal(s.source, "tier0+netpolicy");
});

// --- Shizuku transport mode (§19): shell uid via rish ------------------------
// When the ladder's state file says Shizuku is alive, tier-0 (and tier-1)
// run as SHELL uid through rish — no bare `ip`, no adb server, no serial
// resolution. Any rish failure falls through to the old chain untouched.

const SHIZUKU_RISH_ROUTE = {
	code: 0,
	stdout: "1.1.1.1 via 10.0.2.2 dev wlan0 table 1016 src 10.0.2.16 uid 2000\n",
	stderr: "",
	spawnError: false
};

test("detect: transport=shizuku → tier0 via rish, zero adb/bare-ip side effects", async () => {
	const runFn = fakeRun({}); // throws on ANY call — proves nothing else ran
	const asked = [];
	const s = await detect(
		{ ...baseCfg, shizukuRishPath: "/data/data/com.termux/files/rish/rish" },
		runFn,
		undefined,
		{
			transportState: { kind: "shizuku", alive: true },
			rishRun: async (cfg, cmd) => {
				asked.push(cmd);
				if (cmd.startsWith("ip route get")) return SHIZUKU_RISH_ROUTE;
				return { code: 1, stdout: "", stderr: "unavailable", spawnError: false };
			}
		}
	);
	assert.equal(asked[0], "ip route get 1.1.1.1", "tier0 asked as shell uid");
	assert.equal(s.source, "tier0-shizuku-inference", "rish dumpsys failed → tier0 inference");
	assert.equal(s.transport, "wifi");
	assert.equal(s.metered, false);
});

test("detect: transport=shizuku but rish broken → falls back to the old chain", async () => {
	const runFn = fakeRun({
		"route get 1.1.1.1": { stdout: "1.1.1.1 dev rmnet_data0 src 10.1.2.3\n" },
		"shell dumpsys netpolicy": { stdout: "  mMeteredIfaces=[rmnet_data0]\n" }
	});
	const s = await detect(
		{ ...baseCfg, shizukuRishPath: "/x/rish" },
		runFn,
		undefined,
		{
			transportState: { kind: "shizuku" },
			rishRun: async () => ({ code: 124, stdout: "", stderr: "timeout", spawnError: false })
		}
	);
	assert.equal(s.source, "tier0+netpolicy", "old chain intact after rish failure");
	assert.equal(s.metered, true);
});
