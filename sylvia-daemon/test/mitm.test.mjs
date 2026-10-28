import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	applyToggle,
	BLOCK_BEGIN,
	BLOCK_END,
	createMitmToggle,
	findBlock,
	MITM_STATE_FILE,
	renderBlock
} from "../src/mitm.js";

const PROFILE = `# cordis.patch.yml — profile overlay
- insert:
    - id: sylvia-bridge
      name: sylvia-bridge
- insert:
    - id: mitmproxy-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mitmproxy
        command: mitmproxy-mcp
        env:
          MITMPROXY_AUTO_START: "1"
- insert:
    - id: other-plugin
      name: other
`;

function tmp(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sylvia-mitm-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const profile = path.join(dir, "cordis.patch.yml");
	fs.writeFileSync(profile, PROFILE);
	return { dir, profile };
}

test("findBlock: a legacy row is found by shape, and stops at the next top-level item", () => {
	const found = findBlock(PROFILE);
	assert.ok(found);
	assert.equal(found.marked, false);
	assert.equal(found.commented, false);
	assert.match(found.lines[0], /mitmproxy-mcp/);
	assert.ok(found.lines.some((line) => line.includes("MITMPROXY_AUTO_START")));
	assert.ok(!found.lines.some((line) => line.includes("other-plugin")), "the next insert block is not part of this one");
});

test("findBlock: a marker-wrapped commented block reads as commented", () => {
	const text = [
		"# top",
		BLOCK_BEGIN,
		"# - id: mitmproxy-mcp",
		"#   name: '@deepseek-ai/dsh-mcp-client'",
		BLOCK_END,
		"# tail"
	].join("\n");
	const found = findBlock(text);
	assert.equal(found.marked, true);
	assert.equal(found.commented, true);
	assert.equal(found.lines.length, 2);
});

test("findBlock: no row at all is null, not an error", () => {
	assert.equal(findBlock("# nothing here\n- id: sylvia-bridge\n"), null);
});

test("renderBlock: comment and uncomment are idempotent in both directions", () => {
	const lines = ["- id: mitmproxy-mcp", "  name: x"];
	const off = renderBlock(lines, false);
	assert.deepEqual(off, ["# - id: mitmproxy-mcp", "#   name: x"]);
	assert.deepEqual(renderBlock(off, false), off);
	assert.deepEqual(renderBlock(off, true), lines);
	assert.deepEqual(renderBlock(lines, true), lines);
});

test("applyToggle: disabling comments the row in place and wraps it in markers", () => {
	const result = applyToggle(PROFILE, false);
	assert.equal(result.found, true);
	assert.equal(result.changed, true);
	assert.match(result.text, new RegExp(BLOCK_BEGIN));
	assert.match(result.text, new RegExp(BLOCK_END));
	assert.match(result.text, /#\s+- id: mitmproxy-mcp/);
	assert.match(result.text, /#\s+MITMPROXY_AUTO_START/);
	// Everything outside the block is untouched.
	assert.match(result.text, /- id: sylvia-bridge\n      name: sylvia-bridge/);
	assert.match(result.text, /- id: other-plugin/);
	// Re-enabling restores the original bytes (the markers stay, the rows do not).
	const reenabled = applyToggle(result.text, true).text
		.split("\n")
		.filter((line) => line.trim() !== BLOCK_BEGIN && line.trim() !== BLOCK_END)
		.join("\n");
	assert.equal(reenabled, PROFILE);
});

test("applyToggle: no mitmproxy row → reports not found and does not touch the file", () => {
	const text = "# only a bridge\n- id: sylvia-bridge\n";
	const result = applyToggle(text, false);
	assert.equal(result.found, false);
	assert.equal(result.changed, false);
	assert.equal(result.text, text);
});

test("status: a legacy unwrapped row with no decision owes no restart", async (t) => {
	// The AVD's real shape: the installer predated the markers, so the row is
	// present, unwrapped and ACTIVE, and no decision file exists. findBlock
	// still finds it (by row shape), which made the old comparison read
	// `active(true) !== decided(false)` and demand a restart for a switch
	// nobody ever touched.
	const { dir, profile } = tmp(t);
	const toggle = createMitmToggle({ config: { stateDir: dir, mitmPort: 8080 }, profileFile: profile });

	const s = await toggle.status();
	assert.equal(s.registered, true, "the legacy row is found by shape");
	assert.equal(s.active, true, "and it is active as installed");
	assert.equal(s.decided, false, "but nothing was ever decided");
	assert.equal(s.needsRestart, false, "so the toggle must not demand a restart");
});

test("toggle: enable/disable rewrite the profile and record the decision", async (t) => {
	const { dir, profile } = tmp(t);
	const stopped = [];
	const services = { inspect: async () => ({ listening: true, pids: [9] }), stop: async (name) => stopped.push(name) };
	const toggle = createMitmToggle({ config: { stateDir: dir, mitmPort: 8080 }, services, profileFile: profile });

	const initial = await toggle.status();
	assert.equal(initial.decided, false, "no decision yet");
	assert.equal(initial.active, true, "the file is active as installed");
	assert.equal(initial.registered, true);
	assert.equal(
		initial.needsRestart,
		false,
		"a node that never chose must not be nagged: ensureAtBoot leaves it as installed, so nothing is owed"
	);

	const on = await toggle.enable();
	assert.equal(on.ok, true);
	assert.equal(on.enabled, true);
	assert.equal(on.active, true);
	assert.equal(on.needsRestart, false);

	const off = await toggle.disable();
	assert.equal(off.ok, true);
	assert.equal(off.enabled, false);
	assert.equal(off.active, false);
	assert.equal(off.needsRestart, true, "the decision changed; the running harness still has the old tree");
	assert.equal((await toggle.markApplied()).appliedAt !== null, true);
	assert.equal((await toggle.status()).needsRestart, false, "after a restart the file is in force");
	assert.deepEqual(stopped, ["mitm"], "disabling stops a live mitmdump");
	assert.match(fs.readFileSync(profile, "utf8"), /#\s+- id: mitmproxy-mcp/);

	const state = JSON.parse(fs.readFileSync(path.join(dir, MITM_STATE_FILE), "utf8"));
	assert.equal(state.enabled, false);
});

test("toggle: disable can leave the process alone", async (t) => {
	const { dir, profile } = tmp(t);
	const stopped = [];
	const toggle = createMitmToggle({
		config: { stateDir: dir },
		services: { inspect: async () => ({}), stop: async (name) => stopped.push(name) },
		profileFile: profile
	});
	await toggle.disable({ stopProcess: false });
	assert.deepEqual(stopped, []);
});

test("toggle: a profile without the row is reported, not crashed", async (t) => {
	const { dir } = tmp(t);
	const profile = path.join(dir, "other.yml");
	fs.writeFileSync(profile, "# nothing\n");
	const toggle = createMitmToggle({ config: { stateDir: dir }, profileFile: profile });
	const result = await toggle.enable();
	assert.equal(result.ok, false);
	assert.equal(result.registered, false);
	assert.match(result.profile.error, /no mitmproxy-mcp row/);
});

test("toggle: a missing profile file is reported, not crashed", async (t) => {
	const { dir } = tmp(t);
	const toggle = createMitmToggle({ config: { stateDir: dir }, profileFile: path.join(dir, "nope.yml") });
	const status = await toggle.status();
	assert.equal(status.registered, false);
	const result = await toggle.enable();
	assert.equal(result.ok, false);
	assert.match(result.profile.error, /profile patch not found/);
});

test("ensureAtBoot: no decision leaves the file exactly as installed", async (t) => {
	const { dir, profile } = tmp(t);
	const before = fs.readFileSync(profile, "utf8");
	const toggle = createMitmToggle({ config: { stateDir: dir }, profileFile: profile });
	const result = await toggle.ensureAtBoot();
	assert.equal(result.skipped, "no decision recorded");
	assert.equal(fs.readFileSync(profile, "utf8"), before);
});

test("ensureAtBoot: a disabled decision comments the row and stops the process", async (t) => {
	const { dir, profile } = tmp(t);
	const stopped = [];
	const services = { inspect: async () => ({ listening: true, pids: [9] }), stop: async (name) => stopped.push(name) };
	const toggle = createMitmToggle({ config: { stateDir: dir }, services, profileFile: profile });
	await toggle.disable({ stopProcess: false }); // record the decision
	stopped.length = 0;
	// The harness was restarted since: the row is active again in the file.
	fs.writeFileSync(profile, PROFILE);
	const result = await toggle.ensureAtBoot();
	assert.equal(result.enabled, false);
	assert.equal(result.active, false);
	assert.deepEqual(stopped, ["mitm"]);
	assert.match(fs.readFileSync(profile, "utf8"), /#\s+- id: mitmproxy-mcp/);
});

test("ensureAtBoot: an enabled decision restores an accidentally commented row", async (t) => {
	const { dir, profile } = tmp(t);
	const toggle = createMitmToggle({ config: { stateDir: dir }, profileFile: profile });
	await toggle.enable();
	fs.writeFileSync(profile, applyToggle(PROFILE, false).text);
	const result = await toggle.ensureAtBoot();
	assert.equal(result.active, true);
	assert.match(fs.readFileSync(profile, "utf8"), /^ +- id: mitmproxy-mcp/m);
});
