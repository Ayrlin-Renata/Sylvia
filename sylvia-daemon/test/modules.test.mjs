import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModuleManager, validateManifest, BEHAVIORS, SETTING_TYPES } from "../src/modules.js";

// ---- fixtures --------------------------------------------------------------

async function makeModulesDir(specs) {
	const root = await mkdtemp(path.join(tmpdir(), "sylvia-mods-"));
	for (const [dirName, manifest] of Object.entries(specs)) {
		const dir = path.join(root, dirName);
		await mkdir(path.join(dir, "scripts"), { recursive: true });
		await writeFile(path.join(dir, "module.json"), JSON.stringify(manifest, null, "\t"));
	}
	return root;
}

const baseManifest = {
	id: "demo",
	name: "Demo Service",
	behavior: "manual",
	frontend: "http://127.0.0.1:9000",
	settingsSchema: [
		{ key: "port", type: "port", label: "Port", default: 9000 },
		{ key: "bind", type: "ip", label: "Bind", default: "127.0.0.1" },
		{ key: "whitelist", type: "ip-list", label: "Allow" },
		{ key: "enableApi", type: "bool", label: "API", default: false },
		{ key: "theme", type: "enum", label: "Theme", options: ["dark", "light"] }
	],
	backup: { enabled: true, remote: "gdrive:sylvia/backups/demo", paths: ["~/demo/data"] },
	scripts: {
		status: "scripts/status.sh",
		on: "scripts/on.sh",
		off: "scripts/off.sh",
		backup: "scripts/backup.sh",
		settingsEdit: "scripts/settings-edit.sh"
	}
};

// A fake exec that records calls and returns canned results.
function fakeExec(results = {}) {
	const calls = [];
	const exec = async (command, args, options = {}) => {
		calls.push({ command, args, options });
		// On win32 the manager wraps scripts as `sh <script>`; key off the
		// script path (last arg) when present, else the command itself.
		const scriptPath = args.length > 0 ? args[args.length - 1] : command;
		const key = path.basename(scriptPath);
		const r = results[key] ?? { code: 0, stdout: "", stderr: "" };
		return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: false, spawnError: null, signal: null };
	};
	return { exec, calls };
}

function fakeSpawn(runningPids) {
	const calls = [];
	const spawnFn = (command, args, options = {}) => {
		calls.push({ command, args, options });
		const pid = 4242;
		runningPids.add(pid);
		return { pid };
	};
	return { spawnFn, calls };
}

function fakeKill(runningPids, log = []) {
	return (pid, signal) => {
		log.push({ pid, signal });
		const abs = Math.abs(pid);
		if (runningPids.has(abs)) {
			if (signal === 0) return true;
			if (signal === "SIGTERM" || signal === "SIGKILL") runningPids.delete(abs);
			return true;
		}
		return false;
	};
}

// ---- validateManifest ------------------------------------------------------

test("validateManifest: accepts a full valid manifest", () => {
	const v = validateManifest(baseManifest, "demo");
	assert.equal(v.ok, true);
	assert.equal(v.manifest.id, "demo");
	assert.equal(v.manifest.behavior, "manual");
	assert.equal(v.manifest.settingsSchema.length, 5);
});

test("validateManifest: rejects structural problems with clear errors", () => {
	const bad = (mut, dir = "demo") => {
		const m = JSON.parse(JSON.stringify(baseManifest));
		mut(m);
		return validateManifest(m, dir);
	};
	assert.match(bad(() => {}).error ?? "", null ?? /.*/); // sanity: good one passes
	assert.equal(validateManifest(baseManifest, "demo").ok, true);

	assert.equal(bad((m) => { m.id = "Demo!"; }).ok, false);
	assert.match(bad((m) => { m.id = "Demo!"; }).error, /invalid id/);
	assert.match(bad((m) => {}, "other-dir").error, /does not match directory/);
	assert.match(bad((m) => { m.name = ""; }).error, /name is required/);
	assert.match(bad((m) => { m.behavior = "sometimes"; }).error, /behavior must be one of/);
	assert.match(bad((m) => { m.settingsSchema = [{ key: "x", type: "widget" }]; }).error, /unknown type/);
	assert.match(bad((m) => { m.settingsSchema = [{ key: "x", type: "enum" }]; }).error, /enum needs options/);
	assert.match(bad((m) => { m.backup = { enabled: true }; }).error, /backup.remote/);
	assert.match(bad((m) => { m.scripts = { on: "/abs/path.sh" }; }).error, /escapes the module directory|relative path/);
	assert.match(bad((m) => { m.scripts = { on: "../../evil.sh" }; }).error, /escapes the module directory/);
	assert.match(bad((m) => { m.scripts = { on: 42 }; }).error, /must be a relative path/);
	// available/unavailableReason: a platform verdict must carry its reason.
	assert.match(bad((m) => { m.available = "no"; }).error, /available must be a boolean/);
	assert.match(bad((m) => { m.available = false; }).error, /available:false requires unavailableReason/);
	assert.match(bad((m) => { m.available = false; m.unavailableReason = ""; }).error, /unavailableReason must be a non-empty string/);
	// absent means "assume runnable"; the reason rides along when given.
	const okAvail = validateManifest({ ...baseManifest }, "demo");
	assert.equal(okAvail.ok, true);
	assert.equal(okAvail.manifest.available, true, "no `available` field means runnable");
	const okUnavail = validateManifest({ ...baseManifest, available: false, unavailableReason: "no responder exists here" }, "demo");
	assert.equal(okUnavail.ok, true);
	assert.equal(okUnavail.manifest.available, false);
	assert.equal(okUnavail.manifest.unavailableReason, "no responder exists here");
});

test("behave enumerations stay locked (§9.4 / §5 types)", () => {
	assert.deepEqual(BEHAVIORS, ["always", "manual", "tasker"]);
	assert.deepEqual(SETTING_TYPES, ["port", "ip", "ip-list", "path", "bool", "enum", "string", "number"]);
});

// ---- discover ---------------------------------------------------------------

test("discover: valid modules load, invalid ones report errors, missing dir tolerated", async () => {
	const root = await makeModulesDir({ demo: baseManifest, broken: { ...baseManifest, id: "broken", behavior: "nope" } });
	const store = { read: () => ({}), write: () => {} };
	const mgr = new ModuleManager({ modulesDir: root, store, log: () => {} });
	const r1 = await mgr.discover();
	assert.equal(r1.found, 1, "only the valid module loads");
	assert.equal(r1.errors.length, 1);
	assert.match(r1.errors[0], /broken: behavior must be one of/);

	// no modules dir → found 0, no throw
	const mgr2 = new ModuleManager({ modulesDir: path.join(root, "does-not-exist"), store, log: () => {} });
	const r2 = await mgr2.discover();
	assert.equal(r2.found, 0);

	await rm(root, { recursive: true, force: true });
});

test("discover: declared scripts that are missing are reported per-module", async () => {
	const root = await makeModulesDir({ demo: baseManifest }); // no actual .sh files created
	const mgr = new ModuleManager({ modulesDir: root, store: null, log: () => {} });
	await mgr.discover();
	const list = await mgr.list();
	assert.equal(list[0].missingScripts.sort().join(","), "backup,off,on,status,settingsEdit".split(",").sort().join(","));
	await rm(root, { recursive: true, force: true });
});

// ---- available (platform verdict) --------------------------------------------

test("available:false is reported in list() and start() refuses with the reason", async () => {
	const REASON = "Android ships neither avahi-daemon nor mdnsd";
	const root = await makeModulesDir({ unusable: { ...baseManifest, id: "unusable", available: false, unavailableReason: REASON } });
	// the on script EXISTS, so the refusal cannot be blamed on missingScripts
	await writeFile(path.join(root, "unusable", "scripts", "on.sh"), "#!/bin/sh\nexit 2\n");

	const pids = new Set();
	const { spawnFn, calls } = fakeSpawn(pids);
	const { exec } = fakeExec();
	const writes = {};
	const store = { read: (n, fb) => writes[n] ?? fb, write: (n, v) => { writes[n] = v; } };
	const mgr = new ModuleManager({ modulesDir: root, store, log: () => {}, exec, spawnFn, killFn: fakeKill(pids) });
	await mgr.discover();

	const list = await mgr.list();
	assert.equal(list[0].available, false);
	assert.equal(list[0].unavailableReason, REASON);

	await assert.rejects(() => mgr.start("unusable"), (e) => {
		assert.match(e.message, /is not available on this platform/);
		assert.ok(e.message.includes(REASON), "the refusal must quote the declared reason");
		return true;
	});
	assert.equal(calls.length, 0, "an unavailable module must never be spawned");
	assert.equal(writes["module-unusable.json"], undefined, "and must not latch lastDesired=on");

	await rm(root, { recursive: true, force: true });
});

test("autoStart: an unavailable module is skipped even with lastDesired=on", async () => {
	const root = await makeModulesDir({ unusable: { ...baseManifest, id: "unusable", available: false, unavailableReason: "not on this platform" } });
	await writeFile(path.join(root, "unusable", "scripts", "on.sh"), "#!/bin/sh\ntrue\n");

	const pids = new Set();
	const { spawnFn, calls } = fakeSpawn(pids);
	const { exec } = fakeExec();
	// the saved state says "on" — exactly the latched state that used to retry forever
	const store = { read: (n, fb) => (n === "module-unusable.json" ? { lastDesired: "on" } : fb), write: () => {} };
	const logs = [];
	const mgr = new ModuleManager({ modulesDir: root, store, log: (m) => logs.push(m), exec, spawnFn, killFn: fakeKill(pids) });
	await mgr.discover();
	await mgr.autoStart();

	assert.equal(calls.length, 0, "no spawn for an unavailable module");
	assert.deepEqual(logs, [], "and no failure noise either — it is skipped, not attempted");

	await rm(root, { recursive: true, force: true });
});

// ---- lifecycle ---------------------------------------------------------------

test("start: spawns detached, registers netgate only for behavior=always, persists desired state", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	await writeFile(path.join(root, "demo", "scripts", "on.sh"), "#!/bin/sh\ntrue\n");
	await writeFile(path.join(root, "demo", "scripts", "off.sh"), "#!/bin/sh\ntrue\n");

	const pids = new Set();
	const { spawnFn, calls } = fakeSpawn(pids);
	const killFn = fakeKill(pids);
	const { exec, calls: execCalls } = fakeExec();
	const writes = {};
	const store = {
		read: (n, fb) => writes[n] ?? fb,
		write: (n, v) => { writes[n] = v; }
	};
	const registered = [];
	const netgate = { register: (n, p, note) => registered.push({ n, p, note }), unregister: () => {}, list: () => [] };

	const mgr = new ModuleManager({ modulesDir: root, store, netgate, log: () => {}, exec, spawnFn, killFn });
	await mgr.discover();

	// manual module → no auto netgate registration
	let r = await mgr.start("demo");
	assert.equal(r.running, true);
	assert.equal(calls[0].options.detached, true, "own process group for netgate SIGSTOP (§9.3)");
	assert.equal(registered.length, 0, "manual module must not register with netgate");
	assert.equal(writes["module-demo.json"].lastDesired, "on");

	// second start while running → idempotent
	r = await mgr.start("demo");
	assert.match(r.note, /already running/);

	// always module → registers
	const always = { ...baseManifest, id: "alwaysy", behavior: "always" };
	await makeModulesDirIn(root, "alwaysy", always);
	await mgr.discover();
	await mgr.start("alwaysy");
	assert.equal(registered.length, 1);
	assert.equal(registered[0].n, "module:alwaysy");
	assert.equal(registered[0].p, 4242);

	await rm(root, { recursive: true, force: true });
});

async function makeModulesDirIn(root, dirName, manifest) {
	const dir = path.join(root, dirName);
	await mkdir(path.join(dir, "scripts"), { recursive: true });
	await writeFile(path.join(dir, "module.json"), JSON.stringify(manifest, null, "\t"));
	await writeFile(path.join(dir, "scripts", "on.sh"), "#!/bin/sh\ntrue\n");
}

test("stop: runs off.sh, CONT-then-TERMs the group, clears desired state", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	await writeFile(path.join(root, "demo", "scripts", "on.sh"), "#!/bin/sh\ntrue\n");
	await writeFile(path.join(root, "demo", "scripts", "off.sh"), "#!/bin/sh\ntrue\n");

	const pids = new Set();
	const { spawnFn } = fakeSpawn(pids);
	const killLog = [];
	const killFn = fakeKill(pids, killLog);
	const { exec } = fakeExec();
	const writes = {};
	const store = { read: (n, fb) => writes[n] ?? fb, write: (n, v) => { writes[n] = v; } };
	const mgr = new ModuleManager({ modulesDir: root, store, netgate: null, log: () => {}, exec, spawnFn, killFn });
	await mgr.discover();

	await mgr.start("demo");
	await mgr.stop("demo");

	// order: CONT before TERM (netgate may have it stopped, §9.3)
	const groupSignals = killLog.filter((k) => k.pid === -4242).map((k) => k.signal);
	assert.ok(groupSignals.includes("SIGCONT"), "group was CONTed first");
	assert.equal(groupSignals[0], "SIGCONT");
	assert.equal(writes["module-demo.json"].lastDesired, "off");
	const list = await mgr.list();
	assert.equal(list[0].running, false);

	await rm(root, { recursive: true, force: true });
});

test("status: script exit code + pid liveness reported together", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	await writeFile(path.join(root, "demo", "scripts", "status.sh"), "#!/bin/sh\necho '{\"ok\":true}'\n");
	await writeFile(path.join(root, "demo", "scripts", "on.sh"), "#!/bin/sh\ntrue\n");

	const pids = new Set();
	const { spawnFn } = fakeSpawn(pids);
	const killFn = fakeKill(pids);
	const { exec } = fakeExec({
		"status.sh": { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }
	});
	const mgr = new ModuleManager({ modulesDir: root, store: null, netgate: null, log: () => {}, exec, spawnFn, killFn });
	await mgr.discover();

	let s = await mgr.status("demo");
	assert.equal(s.script.up, true);
	assert.deepEqual(s.script.detail, { ok: true });
	assert.equal(s.alive, false, "never started");

	await mgr.start("demo");
	s = await mgr.status("demo");
	assert.equal(s.alive, true);
	assert.equal(s.pid, 4242);

	// script failing → up:false, no throw
	const mgr2 = new ModuleManager({
		modulesDir: root, store: null, netgate: null, log: () => {},
		exec: async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false, spawnError: null, signal: null }),
		spawnFn, killFn
	});
	await mgr2.discover();
	s = await mgr2.status("demo");
	assert.equal(s.script.up, false);
	assert.equal(s.script.exitCode, 2);

	await rm(root, { recursive: true, force: true });
});

// ---- settings ----------------------------------------------------------------

test("applySettings: validates against schema, persists, writes settings.env, pipes JSON to settings-edit.sh", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	await writeFile(path.join(root, "demo", "scripts", "settings-edit.sh"), "#!/bin/sh\ncat > /dev/null\n");

	const inputs = [];
	const { exec } = fakeExec();
	const wrapped = async (cmd, args, opts) => {
		inputs.push(opts.input ?? null);
		return exec(cmd, args, opts);
	};
	const writes = {};
	const store = { read: (n, fb) => writes[n] ?? fb, write: (n, v) => { writes[n] = v; } };
	const mgr = new ModuleManager({ modulesDir: root, store, netgate: null, log: () => {}, exec: wrapped });
	await mgr.discover();

	const settings = { port: 9100, whitelist: ["127.0.0.1", "192.168.1.0/24"], enableApi: true, theme: "dark" };
	const r = await mgr.applySettings("demo", settings);
	assert.deepEqual(r.settings, settings);
	assert.deepEqual(writes["module-demo.json"].settings, settings);
	assert.equal(inputs[0], JSON.stringify(settings), "JSON patch on stdin (§9.2)");

	const { readFile } = await import("node:fs/promises");
	const env = await readFile(path.join(root, "demo", "settings.env"), "utf8");
	assert.match(env, /SYLVIA_MODULE_PORT=9100/);
	assert.match(env, /SYLVIA_MODULE_WHITELIST=127.0.0\.1 192\.168\.1\.0\/24/);
	assert.match(env, /SYLVIA_MODULE_ENABLEAPI=1/);

	// unknown key rejected when schema declared
	await assert.rejects(() => mgr.applySettings("demo", { bogus: 1 }), /unknown setting: bogus/);
	// non-object rejected
	await assert.rejects(() => mgr.applySettings("demo", "nope"), /must be an object/);

	await rm(root, { recursive: true, force: true });
});

test("applySettings: failing settings-edit.sh surfaces stderr", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	await writeFile(path.join(root, "demo", "scripts", "settings-edit.sh"), "#!/bin/sh\nexit 3\n");
	const { exec } = fakeExec({ "settings-edit.sh": { code: 3, stdout: "", stderr: "bad value" } });
	const mgr = new ModuleManager({ modulesDir: root, store: null, netgate: null, log: () => {}, exec });
	await mgr.discover();
	await assert.rejects(() => mgr.applySettings("demo", { port: 1 }), /settings-edit\.sh failed \(exit 3\): bad value/);
	await rm(root, { recursive: true, force: true });
});

// ---- backup -------------------------------------------------------------------

test("backup: uses backup.sh when present; otherwise rclone --json per path", async () => {
	const root = await makeModulesDir({ demo: baseManifest });
	// no backup.sh → default rclone impl
	const { exec, calls } = fakeExec({ rclone: { code: 0, stdout: JSON.stringify({ stats: { totalBytes: 10 } }), stderr: "" } });
	const mgr = new ModuleManager({ modulesDir: root, store: null, netgate: null, log: () => {}, exec });
	await mgr.discover();

	const r = await mgr.backup("demo");
	assert.equal(r.via, "rclone");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "rclone");
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	assert.deepEqual(calls[0].args.slice(0, 2), ["sync", path.join(home, "demo", "data")]);
	assert.ok(calls[0].args.includes("--json"), "forced --json (§9.3)");
	assert.equal(calls[0].args[2], "gdrive:sylvia/backups/demo");

	// script path preferred when backup.sh exists
	await writeFile(path.join(root, "demo", "scripts", "backup.sh"), "#!/bin/sh\necho done\n");
	await mgr.discover();
	const r2 = await mgr.backup("demo");
	assert.equal(r2.via, "script");

	await rm(root, { recursive: true, force: true });
});

test("backup: no script + disabled config → clear error", async () => {
	const root = await makeModulesDir({ demo: { ...baseManifest, backup: { enabled: false } } });
	const { exec } = fakeExec();
	const mgr = new ModuleManager({ modulesDir: root, store: null, netgate: null, log: () => {}, exec });
	await mgr.discover();
	await assert.rejects(() => mgr.backup("demo"), /no backup script and backup\.enabled is false/);
	await rm(root, { recursive: true, force: true });
});

// ---- behavior modes ------------------------------------------------------------

test("autoStart: always starts immediately; manual only when lastDesired=on; tasker never", async () => {
	const root = path.join(await mkdtemp(path.join(tmpdir(), "sylvia-mods-")), "mods");
	await makeModulesDirIn(root, "alwaysy", { ...baseManifest, id: "alwaysy", behavior: "always" });
	await makeModulesDirIn(root, "manualy", { ...baseManifest, id: "manualy", behavior: "manual" });
	await makeModulesDirIn(root, "taskery", { ...baseManifest, id: "taskery", behavior: "tasker" });

	const spawned = [];
	const spawnFn = (cmd, args = []) => { spawned.push(path.join(cmd, ...args)); return { pid: 5000 + spawned.length }; };
	const writes = { "module-manualy.json": { lastDesired: "on" } };
	const store = { read: (n, fb) => writes[n] ?? fb, write: (n, v) => { writes[n] = v; } };
	const mgr = new ModuleManager({ modulesDir: root, store, netgate: null, log: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }), spawnFn, killFn: () => true });
	await mgr.discover();
	await mgr.autoStart();

	assert.ok(spawned.some((c) => c.includes(path.join("alwaysy", "scripts", "on.sh"))), "always auto-starts");
	assert.ok(spawned.some((c) => c.includes(path.join("manualy", "scripts", "on.sh"))), "manual restored from persisted state");
	assert.ok(!spawned.some((c) => c.includes("taskery")), "tasker lifecycle belongs to Tasker (§9.4)");

	await rm(root, { recursive: true, force: true });
});

test("checkRestarts: dead always-module restarts; manual module untouched", async () => {
	const root = path.join(await mkdtemp(path.join(tmpdir(), "sylvia-mods-")), "mods");
	await makeModulesDirIn(root, "alwaysy", { ...baseManifest, id: "alwaysy", behavior: "always" });
	await makeModulesDirIn(root, "manualy", { ...baseManifest, id: "manualy", behavior: "manual" });

	const pids = new Set();
	let nextPid = 4242;
	const spawnFn = () => { const pid = ++nextPid; pids.add(pid); return { pid }; };
	const killFn = fakeKill(pids);
	const exec = async () => ({ code: 0, stdout: "", stderr: "" });
	const mgr = new ModuleManager({ modulesDir: root, store: null, netgate: null, log: () => {}, exec, spawnFn, killFn });
	await mgr.discover();

	await mgr.start("alwaysy");
	await mgr.start("manualy");
	const beforeAlways = (await mgr.list()).find((m) => m.id === "alwaysy").pid;
	const beforeManual = (await mgr.list()).find((m) => m.id === "manualy").pid;

	// simulate crash of the always module only
	pids.delete(beforeAlways);

	await mgr.checkRestarts();
	const after = await mgr.list();
	const always = after.find((m) => m.id === "alwaysy");
	const manual = after.find((m) => m.id === "manualy");
	assert.equal(always.running, true, "always module was restarted");
	assert.notEqual(always.pid, beforeAlways, "new pid");
	assert.equal(manual.pid, beforeManual, "manual pid untouched by restart pass");
	assert.equal(manual.running, true, "manual still running from its own start");

	await rm(root, { recursive: true, force: true });
});

test("checkRestarts: crash-looping always-module backs off instead of respawning every cycle", async () => {
	// AVD finding: missing mdns daemon → on.sh exits instantly → 356
	// respawns in 105 minutes. Rapid repeated deaths must back off.
	const root = path.join(await mkdtemp(path.join(tmpdir(), "sylvia-mods-")), "mods");
	await makeModulesDirIn(root, "alwaysy", { ...baseManifest, id: "alwaysy", behavior: "always" });

	const pids = new Set();
	let nextPid = 7000;
	const spawnFn = () => { const pid = ++nextPid; pids.add(pid); return { pid }; };
	const logs = [];
	const mgr = new ModuleManager({
		modulesDir: root, store: null, netgate: null,
		log: (...a) => logs.push(a.join(" ")),
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		spawnFn, killFn: fakeKill(pids)
	});
	await mgr.discover();
	await mgr.start("alwaysy");
	const pid1 = (await mgr.list()).find((m) => m.id === "alwaysy").pid;

	// Death 1 (rapid) → immediate restart, streak = 1.
	pids.delete(pid1);
	await mgr.checkRestarts();
	const pid2 = (await mgr.list()).find((m) => m.id === "alwaysy").pid;
	assert.notEqual(pid2, pid1, "first rapid death restarts immediately");

	// Death 2 (rapid) → streak = 2 → backoff engages, NO restart.
	pids.delete(pid2);
	await mgr.checkRestarts();
	let mod = (await mgr.list()).find((m) => m.id === "alwaysy");
	assert.equal(mod.running, false, "no restart while backing off");
	assert.ok(mod.lastError, "lastError surfaces the crash loop");
	assert.ok(logs.some((l) => /backing off/.test(l)), "backoff logged");

	// Within the backoff window → still untouched.
	await mgr.checkRestarts();
	assert.equal((await mgr.list()).find((m) => m.id === "alwaysy").running, false, "still waiting out the window");

	// Expire the window manually → the next pass restarts.
	mgr.runtime.get("alwaysy").backoffUntil = Date.now() - 1;
	await mgr.checkRestarts();
	mod = (await mgr.list()).find((m) => m.id === "alwaysy");
	assert.equal(mod.running, true, "restart after backoff expiry");

	await rm(root, { recursive: true, force: true });
});
