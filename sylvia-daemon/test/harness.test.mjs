import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHarnessControl, WEB_PROC_PATTERN } from "../src/harness.js";

function tmpState(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-harness-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "dsh-web.log"), "dsh web: http://127.0.0.1:3080/?token=OLD1\n");
	return dir;
}

/** Scripted pgrep: each pids() call shifts the next entry (last repeats). */
function pidQueue(...seq) {
	let i = 0;
	return (cmd, args, opts, cb) => {
		assert.equal(cmd, "pgrep");
		assert.deepEqual(args, ["-f", WEB_PROC_PATTERN]);
		const next = seq[Math.min(i++, seq.length - 1)];
		if (next.length === 0) return cb(new Error("no match"), "", "");
		cb(null, next.join("\n"), "");
	};
}

test("restart: no old process → truncate log + spawn detached with launcher args", async (t) => {
	const dir = tmpState(t);
	const spawns = [];
	const ctl = createHarnessControl({
		config: { stateDir: dir, dshBinPath: "/x/dsh/bin.js", webPort: 1 },
		execFileFn: pidQueue([]),
		killFn: () => { throw new Error("nothing to kill"); },
		spawnFn: (cmd, args, opts) => {
			spawns.push({ cmd, args, opts });
			return { pid: 4242, unref() {} };
		},
		sleep: async () => {}
	});
	const r = await ctl.restart();
	assert.equal(r.ok, true);
	assert.equal(r.pid, 4242);
	assert.equal(spawns.length, 1);
	assert.deepEqual(spawns[0].args, ["--expose-internals", "/x/dsh/bin.js", "web", "--port", "1", "--no-open"]);
	assert.equal(spawns[0].opts.detached, true);
	assert.equal(spawns[0].opts.env.DSH_PERMISSION_MODE !== undefined, true);
	// Log truncated: the next token line will be the ONLY one (no stale race).
	assert.equal(fs.readFileSync(path.join(dir, "dsh-web.log"), "utf8"), "");
});

test("restart: TERM one pid, wait for exit, then spawn", async (t) => {
	const dir = tmpState(t);
	const kills = [];
	let spawned = false;
	// pgrep: initial [123] → after TERM: [] (grace loop exits immediately)
	const ctl = createHarnessControl({
		config: { stateDir: dir, dshBinPath: "/x/dsh/bin.js", webPort: 1 },
		execFileFn: pidQueue([123], []),
		killFn: (pid, sig) => kills.push({ pid, sig }),
		spawnFn: () => { spawned = true; return { pid: 7, unref() {} }; },
		sleep: async () => {}
	});
	const r = await ctl.restart();
	assert.deepEqual(kills, [{ pid: 123, sig: "SIGTERM" }]);
	assert.equal(spawned, true);
	assert.equal(r.ok, true);
	assert.deepEqual(r.killed, [123]);
});

test("restart: SIGKILL stragglers; refuse to spawn while survivors remain", async (t) => {
	const dir = tmpState(t);
	const kills = [];
	let spawned = false;
	// 12 alive readings (initial + 10 grace checks + stragglers), then the
	// post-SIGKILL survivor check still sees it → no spawn.
	const alive = Array(12).fill([123]);
	const ctl = createHarnessControl({
		config: { stateDir: dir, dshBinPath: "/x/dsh/bin.js", webPort: 1 },
		execFileFn: pidQueue(...alive, [123]),
		killFn: (pid, sig) => kills.push({ pid, sig }),
		spawnFn: () => { spawned = true; return { pid: 7, unref() {} }; },
		sleep: async () => {}
	});
	const r = await ctl.restart();
	assert.equal(r.ok, false);
	assert.match(r.error, /still alive after SIGKILL/);
	assert.equal(spawned, false, "must not spawn against a live port");
	assert.equal(kills.filter((k) => k.sig === "SIGTERM").length, 1);
	assert.equal(kills.filter((k) => k.sig === "SIGKILL").length, 1);
});
