import assert from "node:assert";
import { taskerWriteAndReload } from "../src/tasker.js";
import { loadConfig } from "../src/config.js";

// AVD finding: `am broadcast` exits 0 with zero receivers, so a Tasker-less
// device previously reported a silent false-success. The tool must verify a
// receiving package exists BEFORE claiming anything worked.

const XML = `<?xml version="1.0"?><TaskerData sr="" dversion="6.1.13"></TaskerData>`;

function fakeAdb({ taskerInstalled }) {
	const calls = [];
	return {
		calls,
		async shell(cmd) {
			calls.push(cmd);
			if (cmd.startsWith("pm path")) {
				return taskerInstalled
					? { code: 0, stdout: "package:/data/app/Tasker/base.apk\n", stderr: "", spawnError: false }
					: { code: 1, stdout: "", stderr: "Error: unable to find package", spawnError: false };
			}
			if (cmd.startsWith("am broadcast")) {
				return { code: 0, stdout: "Broadcast completed: result=0\n", stderr: "", spawnError: false, reconnected: false, attempts: 1 };
			}
			return { code: 0, stdout: "", stderr: "", spawnError: false };
		},
		async push(local, remote) {
			calls.push(`push:${remote}`);
			return { code: 0, stdout: "", stderr: "", reconnected: false, attempts: 1 };
		}
	};
}

const cfg = loadConfig({});

// 1. Tasker absent + reload requested → structured refusal, nothing written.
{
	const adb = fakeAdb({ taskerInstalled: false });
	await assert.rejects(
		() => taskerWriteAndReload(adb, cfg, { xml: XML, filename: "probe.tsk.xml" }),
		/not installed on this device/,
		"refuses when Tasker is missing and a reload was requested"
	);
	assert.ok(!adb.calls.some((c) => c.startsWith("push:")), "refuses BEFORE pushing the file");
}

// 2. Tasker present → write + broadcast, taskerPresent true, no warning.
{
	const adb = fakeAdb({ taskerInstalled: true });
	const r = await taskerWriteAndReload(adb, cfg, { xml: XML, filename: "probe.tsk.xml" });
	assert.equal(r.taskerPresent, true);
	assert.ok(r.written.endsWith("/probe.tsk.xml"), "pushed to the Tasker dir");
	assert.match(r.reload.output, /result=0/, "broadcast output surfaced");
	assert.ok(!r.warning, "no warning when Tasker is present");
}

// 3. Tasker absent + reload:false → stages the file but warns (no false success).
{
	const adb = fakeAdb({ taskerInstalled: false });
	const r = await taskerWriteAndReload(adb, cfg, { xml: XML, filename: "probe.tsk.xml", reload: false });
	assert.equal(r.taskerPresent, false, "presence is reported honestly");
	assert.ok(r.warning, "write-only path warns about the missing package");
	assert.equal(r.reload, null, "no broadcast attempted");
	assert.ok(adb.calls.some((c) => c.startsWith("push:")), "file still staged when reload:false");
}

console.log("tasker: OK (absent refusal / present path / write-only warning)");
