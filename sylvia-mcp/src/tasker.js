import os from "node:os";
import path from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { log } from "./log.js";

/**
 * Write a Tasker project XML to the shared Tasker directory and (optionally)
 * fire the reload broadcast so Tasker re-reads it — bypassing Tasker's limited
 * HTTP API.
 *
 * @param {AdbManager} adb
 * @param {object} cfg
 * @param {{xml: string, filename?: string, reload?: boolean}} params
 */
export async function taskerWriteAndReload(adb, cfg, { xml, filename, reload = true }) {
	if (typeof xml !== "string" || xml.trim() === "") {
		throw new Error("tasker_write_and_reload: `xml` must be a non-empty string");
	}

	// Sanity-check that this looks like a Tasker export before we touch disk.
	// Tasker project files wrap everything in <TaskerData .../>.
	if (!/<TaskerData[\s>]/.test(xml)) {
		throw new Error(
			"tasker_write_and_reload: `xml` does not contain a <TaskerData> root — this does not look like a Tasker project export"
		);
	}

	// Default to a project file; Tasker reads *.prj.xml / *.tsk.xml / *.prf.xml
	// from this directory on reload.
	const name = filename || `sylvia-${Date.now()}.prj.xml`;
	if (!/\.(prj|tsk|prf)\.xml$/.test(name)) {
		throw new Error(`tasker_write_and_reload: filename must end in .prj.xml / .tsk.xml / .prf.xml (got "${name}")`);
	}

	// Stage the XML in Termux-local temp, then `adb push` to shared storage.
	const tmp = path.join(os.tmpdir(), `sylvia-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
	const remote = `${cfg.taskerDir.replace(/\/+$/, "")}/${name}`;

	let pushResult;
	try {
		await writeFile(tmp, xml, "utf8");
		pushResult = await adb.push(tmp, remote);
	} finally {
		await rm(tmp, { force: true }).catch(() => {});
	}

	if (pushResult.code !== 0) {
		throw new Error(
			`tasker_write_and_reload: adb push to ${remote} failed (exit ${pushResult.code}): ${(pushResult.stderr || pushResult.stdout).trim()}`
		);
	}
	log(`pushed ${remote}`);

	let reloadResult = null;
	if (reload) {
		// Fire the reload broadcast. Exact action string is config-driven because
		// Tasker's intent surface varies by build — verify in the emulator.
		const cmd = cfg.taskerReloadComponent
			? `am broadcast -a ${cfg.taskerReloadAction} -n ${cfg.taskerReloadComponent}`
			: `am broadcast -a ${cfg.taskerReloadAction}`;
		reloadResult = await adb.shell(cmd, { timeoutMs: 10000 });
		log(`reload broadcast sent: ${cfg.taskerReloadAction}`);
	}

	const remotePath = remote;
	return {
		written: remotePath,
		bytes: Buffer.byteLength(xml, "utf8"),
		reload: reload
			? {
					action: cfg.taskerReloadAction,
					component: cfg.taskerReloadComponent || null,
					exitCode: reloadResult.code,
					// am broadcast prints "Broadcast completed: result=..." — surface it.
					output: (reloadResult.stdout || reloadResult.stderr || "").trim()
				}
			: null,
		// adb-level reconnect telemetry so the agent can see the loopback held.
		reconnected: pushResult.reconnected,
		attempts: pushResult.attempts
	};
}
