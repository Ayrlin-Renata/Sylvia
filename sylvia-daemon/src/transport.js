import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { run } from "./run.js";
import { ensureAdbServer, resolveSerial } from "./netdetect.js";

// ---------------------------------------------------------------------------
// Shell transport ladder (DESIGN.md §19) — Shizuku first, adb as fallback.
//
//   1. probe      `rish -c id`, hard-capped (loader binder timeout ~5s; rish
//                 timeouts exit 124). Alive ⇒ transport = shizuku.
//   2. kickstart  (server dead, all headless): token broadcast → UI-launch
//                 best-effort → ...
//   3. fallback   ensure in-device adb server + connect target, then run the
//                 DEFINITIVE libshizuku starter as shell uid:
//                 `libshizuku.so --apk=<base.apk>` (zero taps, exit 0 —
//                 verified on the AVD 2026-10-19).
//   4. teardown   once Shizuku is alive again while a fallback was up: kill
//                 the in-device adb server + drop the loopback.
//
// Probe verdicts from the AVD session (kept here as executable context):
//   * rish alive ⇒ uid=2000(shell), instant re-run; grant SURVIVES a full
//     server restart (no re-approval needed).
//   * `am broadcast -a <pkg>.START` reaches ManualStartReceiver from the
//     Termux uid, but the receiver REQUIRES the auth token (garbage token →
//     HIGH-priority "invalid auth" notification) ⇒ tier-2a is gated on
//     SYLVIA_SHIZUKU_AUTH_TOKEN and skipped honestly when unset.
//   * UI-launch from the background is blocked by Android BAL
//     (background activity launch) unless Termux has a visible window —
//     still attempted (cheap; works when Termux is foreground).
//   * termux has `unzip` (needed once to lift lib/<abi>/libshizuku.so out of
//     the installed Shizuku APK on first fallback use).
//
// State file: <stateDir>/transport.json — written only by ensure()/teardown.
// ---------------------------------------------------------------------------

export const TRANSPORT_STATE_FILE = "transport.json";
export const PACKAGE_CANDIDATES = ["af.shizuku.plus.api", "moe.shizuku.privileged.api"];
export const STARTER_REMOTE = "/data/local/tmp/sylvia-shizuku-starter";
export const DEFAULT_STATE = Object.freeze({
	kind: "none",
	alive: false,
	revivedBy: null,
	fallbackUp: false,
	since: null,
	lastProbe: null,
	attempts: []
});

/** pm path → absolute apk path (first line "package:/…"), or null. */
export function parsePmPath(stdout) {
	const m = /^\s*package:(.+)$/m.exec(stdout ?? "");
	return m ? m[1].trim() : null;
}

/** libshizuku starter output → { started, pid|null }. */
export function parseStarterOutput(blob) {
	const m = /shizuku_server pid is (\d+)/.exec(blob ?? "");
	return { started: Boolean(m), pid: m ? Number(m[1]) : null };
}

/** rish -c id result → alive iff exit 0 AND a shell-uid `id` came back. */
export function rishAlive(result) {
	if (!result || result.spawnError || (result.code ?? 1) !== 0) return false;
	// The rish loader flushes child output to EITHER stream nondeterministically
	// (observed live: `id` on stdout in one run, stderr in the next) — check the
	// merged blob or probes flip to false negatives while the server is healthy.
	const blob = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return /\buid=\d+\(shell\)/.test(blob);
}

function firstLine(s) {
	return String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] ?? "";
}

/**
 * Build the transport ladder. `io` overrides (tests inject fakes) the
 * default child-process effects; config knobs come from loadConfig().
 * @param {object} cfg
 * @param {object} [deps] io overrides
 */
export function createTransport(cfg, deps = {}) {
	const stateFile = path.join(cfg.stateDir, TRANSPORT_STATE_FILE);
	const rishEnv = { ...process.env, RISH_APPLICATION_ID: cfg.shizukuRishAppId || "com.termux" };
	const settleMs = cfg.shizukuSettleMs ?? 3500;

	const io = {
		// ---- privileged probes/actions -----------------------------------
		rish: (args, opts = {}) => run(cfg.shizukuRishPath, args, {
			timeoutMs: cfg.shizukuProbeTimeoutMs ?? 6000,
			env: rishEnv,
			...opts
		}),
		am: (args) => run("/system/bin/am", args, { timeoutMs: 8000 }),
		pmPath: async (pkg) => {
			const r = await run("/system/bin/pm", ["path", pkg], { timeoutMs: 5000 });
			return r.spawnError || (r.code ?? 1) !== 0 ? null : parsePmPath(r.stdout);
		},
		getprop: async (name) => {
			const r = await run("/system/bin/getprop", [name], { timeoutMs: 3000 });
			return (r.stdout ?? "").trim();
		},
		sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
		// Injectable clock for probeUntilAlive's deadline (tests run on a
		// virtual clock so retry windows expire instantly).
		now: () => Date.now(),

		// ---- adb fallback ------------------------------------------------
		ensureAdb: () => ensureAdbServer(cfg, run),
		adbConnect: (target) => run(cfg.adbPath, ["connect", target], { timeoutMs: 8000 }),
		adbDisconnect: (target) => run(cfg.adbPath, ["disconnect", target], { timeoutMs: 5000 }),
		adbKillServer: () => run(cfg.adbPath, ["kill-server"], { timeoutMs: 5000 }),
		adbDevices: () => run(cfg.adbPath, ["devices"], { timeoutMs: 8000 }),
		adbSerial: () => (cfg.adbAutoSerial ? resolveSerial(cfg, run) : Promise.resolve(cfg.adbSerial || null)),
		adbShell: async (serialArgs, command) => run(cfg.adbPath, [...serialArgs, "shell", command], {
			// NOTE: pass the WHOLE command as ONE adb-shell argument — adbd
			// joins `adb shell a b c` with spaces (losing all quoting), so
			// `shell sh -c "chmod 755 x && x"` used to arrive as a broken
			// `sh -c chmod 755 x` ("chmod: Need 2 arguments").
			timeoutMs: Math.max(cfg.adbTimeoutMs ?? 6000, 15000)
		}),
		adbPush: async (serialArgs, local, remote) => run(cfg.adbPath, [...serialArgs, "push", local, remote], {
			timeoutMs: 20000
		}),

		// ---- starter (libshizuku.so) extraction --------------------------
		starterLocal: (abi) => {
			const p = path.join(cfg.shizukuLibDir, `shizuku-starter-${abi}`);
			return existsSync(p) ? p : null;
		},
		extractStarter: async (apkPath, abi) => {
			const dir = cfg.shizukuLibDir;
			const target = path.join(dir, `shizuku-starter-${abi}`);
			const tmp = `${target}.part`;
			await mkdir(dir, { recursive: true });
			await rm(tmp, { force: true });
			const u = await run(cfg.unzipPath || "unzip", [
				"-o", "-q", apkPath, `lib/${abi}/libshizuku.so`, "-d", dir
			], { timeoutMs: 30000 });
			// unzip -d recreates the archive's tree under dir.
			const extracted = path.join(dir, "lib", abi, "libshizuku.so");
			if (u.spawnError || (u.code ?? 1) !== 0 || !existsSync(extracted)) return null;
			await rename(extracted, tmp);
			await rm(path.join(dir, "lib"), { recursive: true, force: true });
			await rename(tmp, target);
			return target;
		},
		...deps
	};

	async function readState() {
		try {
			const raw = await readFile(stateFile, "utf8");
			return { ...DEFAULT_STATE, ...JSON.parse(raw) };
		} catch {
			return { ...DEFAULT_STATE };
		}
	}

	async function saveState(partial) {
		const next = { ...DEFAULT_STATE, ...partial };
		await mkdir(cfg.stateDir, { recursive: true });
		await writeFile(stateFile, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
		return next;
	}

	/** Tier-1 probe: rish -c id, hard-capped. Never throws. */
	async function probe() {
		let r;
		try {
			r = await io.rish(["-c", "id"]);
		} catch (e) {
			return { alive: false, detail: String(e?.message ?? e) };
		}
		if (rishAlive(r)) return { alive: true, detail: firstLine(r.stdout) };
		const detail = r.spawnError ? `rish missing: ${r.spawnError}`
			: firstLine(r.stderr) || firstLine(r.stdout) || `probe exit ${r.code}`;
		return { alive: false, detail };
	}

	/**
	 * Poll-probe until alive or deadline. The server's binder lags the
	 * starter by several seconds (zygote fork + ART warmup), so a single
	 * settle+probe produced false "exhausted" verdicts while the server
	 * came up healthy moments later (verified live on the AVD).
	 */
	async function probeUntilAlive(totalMs) {
		const deadline = io.now() + totalMs;
		for (;;) {
			const p = await probe();
			if (p.alive || io.now() >= deadline) return p;
			await io.sleep(2500);
		}
	}

	/** Resolve the Shizuku manager package (Plus first, drop-in fallback). */
	async function resolvePackage() {
		if (cfg.shizukuPackage) return cfg.shizukuPackage;
		for (const cand of PACKAGE_CANDIDATES) {
			if (await io.pmPath(cand)) return cand;
		}
		return null;
	}

	/**
	 * Tier-3: adb fallback + the definitive starter run as shell uid.
	 * Returns { ok, reason?, starterPid?, ... } — never throws.
	 */
	async function fallbackStart(pkg) {
		try {
			await io.ensureAdb();
			if (cfg.adbTarget) await io.adbConnect(cfg.adbTarget);
			const apk = await io.pmPath(pkg);
			if (!apk) return { ok: false, reason: `package ${pkg} not installed` };

			const abiRaw = (await io.getprop("ro.product.cpu.abi")).trim() || "arm64-v8a";
			const abi = abiRaw.replace(/[^a-z0-9_.-]/gi, "") || "arm64-v8a";

			let local = io.starterLocal(abi);
			if (!local) local = await io.extractStarter(apk, abi);
			if (!local) {
				return { ok: false, reason: "starter extraction failed (is Termux `unzip` installed?)" };
			}

			const serial = await io.adbSerial();
			const serialArgs = serial ? ["-s", serial] : [];
			const pushed = await io.adbPush(serialArgs, local, STARTER_REMOTE);
			if (pushed.spawnError || (pushed.code ?? 1) !== 0) {
				return { ok: false, reason: `adb push failed: ${firstLine(pushed.stderr) || pushed.code}` };
			}
			const r = await io.adbShell(
				serialArgs,
				`chmod 755 ${STARTER_REMOTE} && ${STARTER_REMOTE} --apk=${apk}`
			);
			const blob = `${r.stdout}\n${r.stderr}`;
			const started = parseStarterOutput(blob);
			if (r.spawnError || (r.code ?? 1) !== 0) {
				return { ok: false, reason: `starter failed: ${firstLine(r.stderr) || `exit ${r.code}`}` };
			}
			// The binder lags the starter (zygote + ART warmup) — poll, don't
			// single-shot (a lone settle+probe once reported "exhausted" for
			// a server that came up healthy seconds later).
			const p = await probeUntilAlive(45_000);
			if (p.alive) return { ok: true, starterPid: started.pid, via: "adb-fallback" };
			return { ok: false, reason: `starter ran (pid ${started.pid ?? "?"}) but rish probe still failing` };
		} catch (e) {
			return { ok: false, reason: String(e?.message ?? e) };
		}
	}

	/** Tier-4: drop the fallback once Shizuku is healthy again. */
	async function teardown() {
		const out = { killedAdbServer: false, disconnected: cfg.adbTarget || null };
		try {
			await io.adbKillServer();
			out.killedAdbServer = true;
		} catch { /* best-effort */ }
		if (cfg.adbTarget) {
			try { await io.adbDisconnect(cfg.adbTarget); } catch { /* best-effort */ }
		}
		return out;
	}

	/**
	 * One full ladder pass. Order: probe → (teardown leftover fallback) →
	 * token broadcast → UI-launch → adb fallback. Persists transport.json
	 * and returns the resulting state.
	 */
	async function ensure() {
		const now = Date.now();
		const prev = await readState();

		// --- 1. probe -------------------------------------------------------
		const p = await probe();
		if (p.alive) {
			const result = {
				kind: "shizuku",
				alive: true,
				revivedBy: prev.kind === "shizuku" ? (prev.revivedBy || "probe") : "probe",
				fallbackUp: false,
				since: prev.kind === "shizuku" && prev.since ? prev.since : now,
				lastProbe: now,
				attempts: []
			};
			if (prev.fallbackUp) {
				// Fallback no longer needed — tear it down (§19.1 step 4).
				result.teardown = await teardown();
			}
			return { ok: true, ...(await saveState(result)) };
		}

		// --- resolve the manager package (kickstarts need it) ---------------
		const pkg = await resolvePackage();
		if (!pkg) {
			return {
				ok: false,
				reason: "shizuku-not-installed",
				detail: p.detail,
				...(await saveState({ kind: "none", alive: false, lastProbe: now, attempts: [
					{ step: "install-check", ok: false, reason: "no Shizuku manager package found" }
				] }))
			};
		}

		const attempts = [];
		const revived = async (revivedBy, tier) => ({
			ok: true,
			...(await saveState({
				kind: "shizuku",
				alive: true,
				revivedBy,
				fallbackUp: tier === 3,
				since: now,
				lastProbe: now,
				attempts: attempts.slice()
			})),
			revivedBy,
			tier
		});

		// --- 2a. token broadcast (gated: invalid token = HIGH notif) ---------
		if (cfg.shizukuAuthToken) {
			await io.am(["broadcast", "-a", `${pkg}.START`, "--es", "auth", cfg.shizukuAuthToken]);
			if ((await probeUntilAlive(settleMs + 4000)).alive) return await revived("broadcast", 2);
			attempts.push({ step: "broadcast", ok: false, note: "server did not come up" });
		} else {
			attempts.push({ step: "broadcast", skipped: "no SYLVIA_SHIZUKU_AUTH_TOKEN configured" });
		}

		// --- 2c. UI-launch (best effort — BAL often blocks background) ------
		await io.am(["start", "-n", `${pkg}/af.shizuku.manager.starter.StarterActivity`]);
		if ((await probeUntilAlive(settleMs + 4000)).alive) return await revived("ui-launch", 2);
		attempts.push({ step: "ui-launch", ok: false, note: "background activity launch may be blocked (BAL)" });

		// --- 3. adb fallback + definitive starter ---------------------------
		const fb = await fallbackStart(pkg);
		if (fb.ok) {
			attempts.push({ step: "adb-fallback", ok: true, starterPid: fb.starterPid ?? null });
			return await revived("adb-fallback", 3);
		}
		attempts.push({ step: "adb-fallback", ok: false, reason: fb.reason });

		// --- everything failed ----------------------------------------------
		return {
			ok: false,
			reason: "ladder-exhausted",
			...(await saveState({
				kind: "none",
				alive: false,
				revivedBy: null,
				fallbackUp: false,
				since: prev.since ?? now,
				lastProbe: now,
				attempts
			}))
		};
	}

	/** Cheap GET: last persisted state (no probe side effects). */
	async function state() {
		return readState();
	}

	/** Probe-only pass — updates lastProbe in the state file, no kickstarts. */
	async function probeOnly() {
		const now = Date.now();
		const p = await probe();
		const prev = await readState();
		await saveState({ ...prev, alive: p.alive, kind: p.alive ? "shizuku" : (prev.kind === "adb" ? "adb" : "none"), lastProbe: now });
		return { alive: p.alive, detail: p.detail };
	}

	return { probe, ensure, state, probeOnly, teardown };
}
