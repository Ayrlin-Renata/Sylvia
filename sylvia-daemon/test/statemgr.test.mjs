import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StateStore } from "../src/statemgr.js";

async function tempDir(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sylvia-state-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

test("write + read roundtrip, indent is tab-JSON", async (t) => {
	const store = new StateStore(await tempDir(t));
	await store.write("netstate.json", { transport: "wifi", metered: false });
	const got = await store.read("netstate.json");
	assert.deepEqual(got, { transport: "wifi", metered: false });
	const raw = await fs.readFile(path.join(store.dir, "netstate.json"), "utf8");
	assert.ok(raw.startsWith("{\n\t"), "tab-indented");
	assert.ok(raw.endsWith("\n"), "trailing newline");
});

test("read missing file → fallback, never throws", async (t) => {
	const store = new StateStore(await tempDir(t));
	assert.deepEqual(await store.read("nope.json"), {});
	assert.deepEqual(await store.read("nope.json", { a: 1 }), { a: 1 });
});

test("read corrupt JSON → fallback, never throws", async (t) => {
	const dir = await tempDir(t);
	await fs.writeFile(path.join(dir, "bad.json"), "{not json", "utf8");
	const store = new StateStore(dir);
	assert.deepEqual(await store.read("bad.json"), {});
});

test("write is atomic: no .tmp files left behind", async (t) => {
	const store = new StateStore(await tempDir(t));
	await store.write("a.json", { x: 1 });
	await store.write("a.json", { x: 2 });
	const files = await fs.readdir(store.dir);
	assert.deepEqual(files, ["a.json"]);
});

test("file name validation: traversal/no-extension/multi-subdir rejected, one subdir allowed", async (t) => {
	const store = new StateStore(await tempDir(t));
	await assert.rejects(store.write("../evil.json", {}), /invalid state file name/);
	await assert.rejects(store.write("a/../evil.json", {}), /invalid state file name/);
	await assert.rejects(store.write("noext", {}), /invalid state file name/);
	await assert.rejects(store.write("a/b/c.json", {}), /invalid state file name/); // only ONE subdir segment
	await store.write("hosts/x.json", { ok: 1 }); // registry subdir paths are valid
	assert.deepEqual(await store.read("hosts/x.json"), { ok: 1 });
});

test("non-object values serialize fine", async (t) => {
	const store = new StateStore(await tempDir(t));
	await store.write("list.json", [1, 2, 3]);
	assert.deepEqual(await store.read("list.json"), [1, 2, 3]);
});
