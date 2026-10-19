import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createTransport,
	parsePmPath,
	parseStarterOutput,
	rishAlive,
	TRANSPORT_STATE_FILE
} from "../src/transport.js";

// ---------------------------------------------------------------------------
// Transport ladder (§19) — probe → kickstart → adb fallback → teardown.
// Every subprocess effect is injected: these tests assert the LADDER LOGIC
// (order, gating, retry windows, teardown, honest failure), never real
// binaries. The "server" is a scripted object flipped by the events that
// would really bring it up (starter/broadcast/ui), and the clock is virtual
// so probeUntilAlive windows expire instantly instead of burning wall time.
// ---------------------------------------------------------------------------

const ALIVE = { code: 0, stdout: "uid=2000(shell) gid=2000(shell) groups=2000(shell)\n", stderr: "", spawnError: null };
const DEAD = { code: 1, stdout: "", stderr: "Waiting for Shizuku authorization...", spawnError: null };
const STARTER_OK = {
	code: 0,
	stdout: "info: starter begin\ninfo: starting server...\ninfo: shizuku_server pid is 4242\ninfo: shizuku_starter exit with 0\n",
	stderr: "",
	spawnError: null
};

function makeIo(overrides = {}) {
	const calls = [];
	const track = (name, fn) => (...args) => {
		calls.push({ name, args });
		return fn ? fn(...args) : undefined;
	};
	const io = {
		calls,
		names: () => calls.map((c) => c.name),
		rish: track("rish", async () => DEAD),
		am: track("am", async () => ({ code: 0 })),
		pmPath: track("pmPath", async (pkg) => `/data/app/${pkg}/base.apk`),
		getprop: track("getprop", async () => "x86_64"),
		sleep: track("sleep", async () => {}),
		now: track("now", () => Date.now()),
		ensureAdb: track("ensureAdb", async () => ({})),
		adbConnect: track("adbConnect", async () => ({ code: 0 })),
		adbDisconnect: track("adbDisconnect", async () => ({ code: 0 })),
		adbKillServer: track("adbKillServer", async () => ({ code: 0 })),
		adbDevices: track("adbDevices", async () => ({ code: 0, stdout: "List of devices attached\n" })),
		adbSerial: track("adbSerial", async () => null),
		adbShell: track("adbShell", async () => STARTER_OK),
		adbPush: track("adbPush", async () => ({ code: 0 })),
		starterLocal: track("starterLocal", () => "/cached/starter"),
		extractStarter: track("extractStarter", async () => null),
		...overrides
	};
	return io;
}

/**
 * Scripted server + virtual clock. `s` is the test's lever:
 *   s.alive            current ground truth (rish answer)
 *   s.starterRan       set by the test's adbShell override
 *   s.warmupLeft       probes still needed after the starter before alive
 *   s.warmFlipsNow     (not used)…
 */
function scriptedIo({ alive = false } = {}) {
	const io = makeIo();
	const s = { alive, starterRan: false, warmupLeft: 0, probes: 0 };
	let vt = Date.now();
	io.now = () => vt;
	io.sleep = async (ms) => { vt += ms; };
	io.rish = (...args) => {
		io.calls.push({ name: "rish", args });
		s.probes++;
		if (!s.alive && s.starterRan) {
			if (s.warmupLeft <= 0) s.alive = true;
			else s.warmupLeft--;
		}
		return Promise.resolve(s.alive ? { ...ALIVE } : { ...DEAD });
	};
	/** Default "the starter worked" behavior: flips the server up. */
	io.runStarterOk = (stdout = STARTER_OK.stdout) => {
		io.adbShell = (...a) => {
			io.calls.push({ name: "adbShell", args: a });
			s.starterRan = true;
			return Promise.resolve({ code: 0, stdout, stderr: "", spawnError: null });
		};
		return s;
	};
	io.server = s;
	return io;
}

async function makeCfg(overrides = {}) {
	const dir = await mkdtemp(path.join(tmpdir(), "sylvia-transport-"));
	return {
		dir,
		cfg: {
			stateDir: dir,
			shizukuRishPath: "/data/data/com.termux/files/rish/rish",
			shizukuRishAppId: "com.termux",
			shizukuPackage: "",
			shizukuAuthToken: "",
			shizukuProbeTimeoutMs: 100,
			shizukuSettleMs: 1,
			shizukuLibDir: path.join(dir, "lib"),
			adbPath: "adb",
			adbTarget: "127.0.0.1:5555",
			adbTimeoutMs: 100,
			adbAutoSerial: true,
			unzipPath: "unzip",
			...overrides
		}
	};
}

// --- pure helpers -----------------------------------------------------------

test("parsePmPath", () => {
	assert.equal(parsePmPath("package:/data/app/x/base.apk\n"), "/data/app/x/base.apk");
	assert.equal(parsePmPath("Error: package not found"), null);
	assert.equal(parsePmPath(""), null);
});

test("parseStarterOutput", () => {
	assert.deepEqual(parseStarterOutput("info: shizuku_server pid is 4242\n"), { started: true, pid: 4242 });
	assert.deepEqual(parseStarterOutput("boom"), { started: false, pid: null });
});

test("rishAlive", () => {
	assert.equal(rishAlive(ALIVE), true);
	assert.equal(rishAlive(DEAD), false);
	assert.equal(rishAlive({ ...ALIVE, code: 124 }), false); // timeout
	assert.equal(rishAlive({ ...ALIVE, spawnError: "ENOENT" }), false);
	assert.equal(rishAlive(null), false);
	// The loader flushes child output to EITHER stream — uid on stderr counts.
	assert.equal(rishAlive({ code: 0, stdout: "", stderr: ALIVE.stdout, spawnError: null }), true);
});

// --- ladder: probe-first ----------------------------------------------------

test("alive probe → shizuku, no kickstart or fallback side effects", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo({ alive: true });
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		assert.equal(r.kind, "shizuku");
		assert.ok(!io.names().includes("am"), "no intents fired");
		assert.ok(!io.names().includes("adbPush"), "no fallback");
		const state = JSON.parse(await readFile(path.join(dir, TRANSPORT_STATE_FILE), "utf8"));
		assert.equal(state.kind, "shizuku");
		assert.equal(state.alive, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// --- ladder: kickstart gating -----------------------------------------------

test("dead + no token → broadcast skipped, ui attempted, fallback revives", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		io.runStarterOk();
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		assert.equal(r.revivedBy, "adb-fallback");
		assert.equal(r.tier, 3);
		assert.equal(r.fallbackUp, true);
		assert.ok(io.names().includes("ensureAdb"), "fallback bootstrapped adb");
		const broadcasts = io.calls.filter((c) => c.name === "am" && c.args[0][0] === "broadcast");
		assert.equal(broadcasts.length, 0, "no token → no broadcast");
		const starts = io.calls.filter((c) => c.name === "am" && c.args[0][0] === "start");
		assert.equal(starts.length, 1, "UI-launch attempted");
		assert.ok(io.names().includes("adbPush"), "fallback pushed the starter");
		assert.equal(r.attempts.find((a) => a.step === "broadcast").skipped,
			"no SYLVIA_SHIZUKU_AUTH_TOKEN configured");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("dead + token → broadcast fires first and short-circuits on success", async () => {
	const { dir, cfg } = await makeCfg({ shizukuAuthToken: "sekrit" });
	try {
		const io = scriptedIo();
		io.am = (...args) => {
			io.calls.push({ name: "am", args });
			if (args[0][0] === "broadcast") io.server.alive = true;
			return Promise.resolve({ code: 0 });
		};
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		assert.equal(r.revivedBy, "broadcast");
		const firstAm = io.calls.find((c) => c.name === "am");
		assert.deepEqual(firstAm.args[0], ["broadcast", "-a", "af.shizuku.plus.api.START", "--es", "auth", "sekrit"]);
		assert.equal(io.calls[0].name, "rish", "probe ran first");
		assert.ok(!io.names().includes("adbShell"), "fallback never reached");
		assert.equal(io.calls.filter((c) => c.name === "am").length, 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("ui-launch success short-circuits the fallback", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		io.am = (...args) => {
			io.calls.push({ name: "am", args });
			if (args[0][0] === "start") io.server.alive = true;
			return Promise.resolve({ code: 0 });
		};
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.revivedBy, "ui-launch");
		assert.equal(r.fallbackUp, false, "no adb fallback left running");
		assert.ok(!io.names().includes("adbShell"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// --- ladder: install check + honest failure ---------------------------------

test("no Shizuku package → fast honest failure, no kickstarts", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		io.pmPath = (...a) => { io.calls.push({ name: "pmPath", args: a }); return Promise.resolve(null); };
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, false);
		assert.equal(r.reason, "shizuku-not-installed");
		assert.ok(!io.names().includes("am"));
		assert.ok(!io.names().includes("adbShell"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("starter fails → ladder-exhausted with the real reason surfaced", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		io.adbShell = (...a) => {
			io.calls.push({ name: "adbShell", args: a });
			return Promise.resolve({ code: 1, stdout: "", stderr: "boom: permission", spawnError: null });
		};
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, false);
		assert.equal(r.reason, "ladder-exhausted");
		const fb = r.attempts.find((a) => a.step === "adb-fallback");
		assert.equal(fb.ok, false);
		assert.match(fb.reason, /boom/);
		const state = JSON.parse(await readFile(path.join(dir, TRANSPORT_STATE_FILE), "utf8"));
		assert.equal(state.kind, "none");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("fallback polls the probe until the server finishes warming up", async () => {
	// Live bug this covers: the starter spawns the server, but the binder
	// lags it by seconds — a single settle+probe once reported
	// "ladder-exhausted" for a server that came up healthy moments later.
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		const s = io.runStarterOk();
		s.warmupLeft = 3; // three dead probes after the starter, then alive
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		assert.equal(r.revivedBy, "adb-fallback");
		assert.equal(r.tier, 3);
		assert.ok(s.probes >= 5, `polled until warm (probes=${s.probes})`);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("extraction path: no cached starter → extractStarter runs, push uses result", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo();
		io.runStarterOk();
		io.starterLocal = (...a) => { io.calls.push({ name: "starterLocal", args: a }); return null; };
		io.extractStarter = (...a) => {
			io.calls.push({ name: "extractStarter", args: a });
			return Promise.resolve("/fresh/starter");
		};
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		const push = io.calls.find((c) => c.name === "adbPush");
		assert.equal(push.args[1], "/fresh/starter");
		const ext = io.calls.find((c) => c.name === "extractStarter");
		assert.equal(ext.args[1], "x86_64", "abi passed through");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// --- teardown ---------------------------------------------------------------

test("alive again while a fallback was up → teardown kills the adb server", async () => {
	const { dir, cfg } = await makeCfg();
	try {
		const io = scriptedIo({ alive: true });
		const seed = { kind: "shizuku", alive: true, revivedBy: "adb-fallback", fallbackUp: true, since: 1, lastProbe: 1 };
		await writeFile(path.join(dir, TRANSPORT_STATE_FILE), JSON.stringify(seed), "utf8");
		const r = await createTransport(cfg, io).ensure();
		assert.equal(r.ok, true);
		assert.equal(r.fallbackUp, false);
		assert.ok(io.names().includes("adbKillServer"), "server torn down");
		const state = JSON.parse(await readFile(path.join(dir, TRANSPORT_STATE_FILE), "utf8"));
		assert.equal(state.fallbackUp, false);
		assert.equal(state.teardown.killedAdbServer, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
