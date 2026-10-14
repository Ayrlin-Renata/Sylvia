import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/statemgr.js";
import { Registry, hostKey, stableHash, isPrivate } from "../src/registry.js";

async function makeRegistry(opts = {}) {
	const dir = await mkdtemp(join(tmpdir(), "sylvia-reg-"));
	const store = new StateStore(dir);
	await store.init();
	const registry = new Registry(store, opts);
	return { registry, store, dir };
}

test("hostKey: serial > mac > fingerprint+(ip,network); bare ip is provisional", () => {
	assert.deepEqual(hostKey({ serial: "S1", ip: "10.0.0.5", network: "net:Home:x" }), {
		key: "serial:S1",
		confidence: "confirmed"
	});
	assert.deepEqual(hostKey({ mac: "aa:bb:cc:dd:ee:ff", ip: "10.0.0.5", network: "net:Home:x" }), {
		key: "mac:aa:bb:cc:dd:ee:ff",
		confidence: "confirmed"
	});
	const fp = hostKey({ fingerprint: { os: "linux" }, ip: "10.0.0.5", network: "net:Home:x" });
	assert.equal(fp.confidence, "corroborated");
	assert.ok(fp.key.startsWith("fp:"));
	const bare = hostKey({ ip: "10.0.0.5", network: "net:Home:x" });
	assert.equal(bare.confidence, "provisional");
	assert.equal(bare.key, "ip:10.0.0.5|net:Home:x");
	// bare (ip,network) must NOT equal the same ip on a different network
	assert.notEqual(bare.key, hostKey({ ip: "10.0.0.5", network: "net:Cafe:y" }).key);
});

test("isPrivate: LAN kept, public dropped", () => {
	assert.ok(isPrivate("192.168.1.10"));
	assert.ok(isPrivate("10.1.2.3"));
	assert.ok(isPrivate("172.16.0.1"));
	assert.ok(isPrivate("fd00::1")); // ULA
	assert.ok(!isPrivate("8.8.8.8"));
	assert.ok(!isPrivate("2001:4860:4860::8888"));
});

test("retention: network wanIp kept ONLY when labeled; unlabeled stripped", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		await registry.upsert("networks", { id: "net:Home:x", kind: "network", ssid: "Home", wanIp: "203.0.113.7" });
		let n = await registry.get("networks", "net:Home:x");
		assert.equal(n.wanIp, undefined, "unlabeled network must not persist public WAN ip");

		await registry.label("networks", "net:Home:x", { owner: "me" });
		await registry.upsert("networks", { id: "net:Home:x", wanIp: "203.0.113.7" });
		n = await registry.get("networks", "net:Home:x");
		assert.equal(n.wanIp, "203.0.113.7", "labeled network keeps its WAN ip");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("retention: public machine (no private ip, no mac/serial/fingerprint) is dropped", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		const dropped = await registry.upsert("hosts", {
			id: "ip:8.8.8.8|net:Home:x",
			kind: "host",
			ips: ["8.8.8.8"]
		});
		assert.equal(dropped, null);
		assert.equal(await registry.get("hosts", "ip:8.8.8.8|net:Home:x"), null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("retention: host keeps only private ips (public stripped)", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		const h = await registry.upsert("hosts", {
			id: "mac:aa:bb:cc:dd:ee:ff",
			kind: "host",
			mac: "aa:bb:cc:dd:ee:ff",
			ips: ["192.168.1.20", "198.51.100.9"]
		});
		assert.deepEqual(h.ips, ["192.168.1.20"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("identity ladder: serial/mac ⇒ confirmed; fingerprint streak ⇒ corroborated", async () => {
	const { registry, dir } = await makeRegistry({ corroborateSightings: 3 });
	try {
		// serial → confirmed immediately
		const s = await registry.recordSighting("hosts", {
			id: "serial:S1",
			kind: "host",
			serial: "S1",
			ips: ["10.0.0.5"]
		});
		assert.equal(s.identityConfidence, "confirmed");

		// fingerprint-only: provisional until 3 consistent sightings
		const id = "fp:" + stableHash({ os: "android" }) + "|10.0.0.9|net:Home:x";
		const fp = { os: "android" };
		let last;
		for (let i = 0; i < 3; i++) {
			last = await registry.recordSighting("hosts", {
				id,
				kind: "host",
				fingerprint: fp,
				ips: ["10.0.0.9"],
				network: "net:Home:x"
			});
		}
		assert.equal(last.sightings, 3);
		assert.equal(last.identityConfidence, "corroborated");

		// confirmed is sticky: no demotion after fewer sightings
		const again = await registry.recordSighting("hosts", { id: "serial:S1", serial: "S1" });
		assert.equal(again.identityConfidence, "confirmed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("dwell accrual capped at 1h per gap", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		const first = await registry.recordSighting("hosts", { id: "mac:aa:bb", kind: "host", mac: "aa:bb" });
		// fabricate a 5h gap
		const stale = { ...first, lastSeen: Date.now() - 5 * 3600_000 };
		await registry.store.write("hosts/mac_aa_bb.json", stale);
		const second = await registry.recordSighting("hosts", { id: "mac:aa:bb", kind: "host", mac: "aa:bb" });
		assert.equal(second.seenMs, 3600_000); // capped: 3600s not 5h
		assert.equal(second.sightings, 2);
		assert.ok(second.lastSeen > stale.lastSeen);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("label: declaration sets owner + confirmed, throws on unknown id", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		await registry.upsert("hosts", { id: "ip:10.0.0.7|net:Home:x", kind: "host", ips: ["10.0.0.7"] });
		const labeled = await registry.label("hosts", "ip:10.0.0.7|net:Home:x", { owner: "me" });
		assert.equal(labeled.owner, "me");
		assert.equal(labeled.identityConfidence, "confirmed");
		await assert.rejects(() => registry.label("hosts", "dev:nope", { owner: "me" }), /unknown/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("listVisible applies policy: unlabeled hidden, labeled visible, offline hidden", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		await registry.setPolicy({ ownerRules: { me: "allow" } });
		const now = Date.now();
		await registry.upsert("networks", { id: "net:Mine:x", kind: "network", ssid: "Mine", owner: "me", lastSeen: now });
		await registry.upsert("networks", { id: "net:Stranger:y", kind: "network", ssid: "Stranger", lastSeen: now });
		// stale labeled network → offline hide
		await registry.upsert("networks", { id: "net:Old:z", kind: "network", ssid: "Old", owner: "me", lastSeen: now - 60 * 60_000 });

		const visible = await registry.listVisible("networks", now);
		const ids = visible.map((n) => n.id);
		assert.ok(ids.includes("net:Mine:x"), "labeled + fresh → visible");
		assert.ok(!ids.includes("net:Stranger:y"), "unlabeled → hidden (absent)");
		assert.ok(!ids.includes("net:Old:z"), "labeled but stale → offline-hidden");
		assert.equal(visible.find((n) => n.id === "net:Mine:x").__gate, "allow");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("prune: unlabeled + stale removed; labeled NEVER touched", async () => {
	const { registry, dir } = await makeRegistry({ pruneAfterMs: 7 * 24 * 3600_000 });
	try {
		const now = Date.now();
		const old = now - 8 * 24 * 3600_000;
		await registry.upsert("hosts", { id: "mac:old", kind: "host", mac: "old", lastSeen: old });
		await registry.upsert("hosts", { id: "mac:keep", kind: "host", mac: "keep", owner: "me", lastSeen: old });
		await registry.upsert("hosts", { id: "mac:fresh", kind: "host", mac: "fresh", lastSeen: now });

		const removed = await registry.prune(now);
		assert.deepEqual(removed.hosts, ["mac:old"]);
		assert.equal(await registry.get("hosts", "mac:old"), null);
		assert.ok(await registry.get("hosts", "mac:keep"), "labeled survives prune");
		assert.ok(await registry.get("hosts", "mac:fresh"), "fresh survives prune");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolve: by ip / hostname / name with policy gates", async () => {
	const { registry, dir } = await makeRegistry();
	try {
		await registry.setPolicy({ ownerRules: { me: "allow" } });
		const now = Date.now();
		// owned host + its resource (endpoint embeds ip)
		await registry.upsert("hosts", {
			id: "mac:aa:bb:cc", kind: "host", mac: "aa:bb:cc", name: "pixel", owner: "me",
			ips: ["192.168.1.50"], lastSeen: now,
			fingerprint: { dhcpName: "pixel.local" }
		});
		await registry.upsert("resources", {
			id: "res:mac:aa:bb:cc:st", kind: "resource", host: "mac:aa:bb:cc", name: "st-diffusion",
			type: "image-generation", transport: "http", endpoint: "http://192.168.1.50:7860", owner: "me", lastSeen: now
		});
		// unlabeled host → hidden
		await registry.upsert("hosts", {
			id: "mac:zz", kind: "host", mac: "zz", ips: ["192.168.1.99"], lastSeen: now
		});

		const byIp = await registry.resolve({ ip: "192.168.1.50" }, now);
		const ids = byIp.matches.map((m) => m.id);
		assert.ok(ids.includes("mac:aa:bb:cc"), "host by ip");
		assert.ok(ids.includes("res:mac:aa:bb:cc:st"), "resource endpoint embeds ip");
		assert.ok(!ids.includes("mac:zz"), "unlabeled host absent (hidden)");
		assert.equal(byIp.matches.find((m) => m.id === "mac:aa:bb:cc").__gate, "allow");

		const byHost = await registry.resolve({ hostname: "PIXEL.LOCAL" }, now);
		assert.ok(byHost.matches.some((m) => m.id === "mac:aa:bb:cc"), "hostname (dhcpName, case-insensitive)");

		const byName = await registry.resolve({ name: "st-diffusion" }, now);
		assert.deepEqual(byName.matches.map((m) => m.id), ["res:mac:aa:bb:cc:st"], "resource by name");

		const unknown = await registry.resolve({ ip: "10.9.9.9" }, now);
		assert.deepEqual(unknown.matches, [], "no match → empty");

		await assert.rejects(() => registry.resolve({}, now), /ip, hostname, or name/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
