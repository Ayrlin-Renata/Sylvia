import test from "node:test";
import assert from "node:assert/strict";
import { SEVERITY, strictest, identityBase, evaluate, filterVisible, normalizePolicy, KNOWN_TYPES } from "../src/policy.js";

const NOW = 1_000_000_000_000;
const FRESH = NOW - 60_000; // seen 1 min ago
const STALE = NOW - 60 * 60_000; // seen 1 h ago
const THRESH = 15 * 60_000;

test("strictest picks the tighter gate", () => {
	assert.equal(strictest("allow", "allow"), "allow");
	assert.equal(strictest("allow", "ask"), "ask");
	assert.equal(strictest("ask", "hidden"), "hidden");
	assert.equal(strictest("hidden", "ask"), "hidden");
	// order should not matter
	assert.equal(strictest("ask", "allow"), strictest("allow", "ask"));
});

test("severity ranking: hidden > ask > allow", () => {
	assert.ok(SEVERITY.hidden > SEVERITY.ask);
	assert.ok(SEVERITY.ask > SEVERITY.allow);
});

test("identityBase most-specific-wins", () => {
	// resource-level permission beats everything below it
	assert.equal(identityBase({ resource: { permission: "allow" }, host: { permission: "hidden" } }), "allow");
	// host beats network + owner
	assert.equal(identityBase({ host: { permission: "ask" }, network: { permission: "allow" }, owner: "me" }), "ask");
	// network beats owner rule
	assert.equal(identityBase({ network: { permission: "ask" }, owner: "me", ownerRules: { me: "allow" } }), "ask");
	// owner rule applies when nothing above sets permission
	assert.equal(identityBase({ owner: "bob", ownerRules: { bob: "ask" } }), "ask");
	// owner "me" with no rule anywhere → allow
	assert.equal(identityBase({ owner: "me" }), "allow");
	// unlabeled → hidden (default deny)
	assert.equal(identityBase({}), "hidden");
	assert.equal(identityBase({ owner: "bob" }), "hidden");
});

test("evaluate merges type rule via strictest-wins", () => {
	const baseAllow = { owner: "me" };
	const opts = { knownTypes: KNOWN_TYPES, now: NOW, lastSeen: FRESH, offlineThresholdMs: THRESH };

	// no type rule → identity base passes through
	assert.equal(evaluate({}, baseAllow, { ...opts, type: "storage" }), "allow");

	// type rule tightens allow → ask
	const tightened = evaluate(
		{},
		baseAllow,
		{ ...opts, type: "image-generation", typeRules: [{ type: "image-generation", permission: "ask" }] }
	);
	assert.equal(tightened, "ask");

	// type rule CANNOT loosen: hidden base + allow rule stays hidden
	const loosed = evaluate(
		{ permission: undefined, owner: undefined },
		{ owner: undefined },
		{ ...opts, type: "mcp", typeRules: [{ type: "mcp", permission: "allow" }] }
	);
	assert.equal(loosed, "hidden");

	// unknown type (not in knownTypes) → at least ask even on allow base
	assert.equal(evaluate({}, baseAllow, { ...opts, type: "brand-new-thing" }), "ask");
});

test("offline axis overrides everything", () => {
	const opts = { knownTypes: KNOWN_TYPES, now: NOW, lastSeen: STALE, offlineThresholdMs: THRESH };
	// allow base → hidden when stale
	assert.equal(evaluate({ owner: "me" }, { owner: "me" }, opts), "hidden");
	// offlineOverride (panel grace) exempts
	assert.equal(evaluate({ owner: "me" }, { owner: "me" }, { ...opts, offlineOverride: true }), "allow");
	// fresh seen → no hide
	assert.equal(
		evaluate({ owner: "me" }, { owner: "me" }, { ...opts, lastSeen: FRESH }),
		"allow"
	);
});

test("filterVisible annotates __gate and DROPS hidden (absent, not redacted)", () => {
	const opts = { knownTypes: KNOWN_TYPES, now: NOW, offlineThresholdMs: THRESH };
	const out = filterVisible(
		[
			{ id: "res:mine", owner: "me", lastSeen: FRESH }, // allow
			{ id: "res:friend", owner: "bob", lastSeen: FRESH }, // hidden (unlabeled owner w/o rule)
			{ id: "res:locked", owner: "me", permission: "ask", lastSeen: FRESH } // ask
		],
		() => ({}),
		() => opts
	);
	const ids = out.map((e) => e.id);
	assert.deepEqual(ids, ["res:mine", "res:locked"]); // hidden item ABSENT
	assert.equal(out.find((e) => e.id === "res:mine").__gate, "allow");
	assert.equal(out.find((e) => e.id === "res:locked").__gate, "ask");
});

test("normalizePolicy never throws and fills defaults", () => {
	assert.deepEqual(normalizePolicy(undefined).ownerRules, {});
	assert.deepEqual(normalizePolicy("junk").typeRules, []);
	const p = normalizePolicy({ typeRules: [{ type: "mcp", permission: "nope" }, { type: "mcp", permission: "ask" }] });
	assert.deepEqual(p.typeRules, [{ type: "mcp", permission: "ask" }]); // invalid gate dropped
	assert.deepEqual(normalizePolicy({}).knownTypes, KNOWN_TYPES);
	assert.equal(normalizePolicy({}).offlineThresholdMs, null);
});
