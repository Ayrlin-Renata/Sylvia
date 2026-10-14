import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiscoverer, deriveCidr, parseNmapPing, parseNmapXml } from "../src/discover.js";
import { Registry } from "../src/registry.js";
import { StateStore } from "../src/statemgr.js";

function makeCfg(over = {}) {
	return { discoverEnabled: true, scanCidr: "", scanTimeoutMs: 60000, ...over };
}

// Each test gets a fresh state dir so registry upserts don't leak.
async function withRegistry(fn) {
	const dir = mkdtempSync(path.join(tmpdir(), "sylvia-disc-"));
	const store = new StateStore(dir);
	await store.init();
	const reg = new Registry(store, { corroborateSightings: 3, pruneAfterMs: 7 * 24 * 3600 * 1000 });
	try {
		await fn(reg, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const XML = `<?xml version="1.0"?>
<nmaprun>
<host><status state="up"/><address addr="192.168.1.1" addrtype="ipv4"/><address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="RouterCo"/><hostnames><hostname name="router.lan"/></hostnames></host>
<host><status state="up"/><address addr="192.168.1.50" addrtype="ipv4"/></host>
<host><status state="up"/><address addr="192.168.1.99" addrtype="ipv4"/></host>
</nmaprun>`;

const OK_RUN = { code: 0, signal: null, timedOut: false, spawnError: null, stdout: XML, stderr: "" };

test("deriveCidr picks first non-internal IPv4 as /24", () => {
	const ifaces = { wlan0: [{ family: "IPv4", address: "10.0.5.9", internal: false }] };
	assert.equal(deriveCidr(ifaces), "10.0.5.0/24");
});

test("deriveCidr returns empty when only loopback", () => {
	const ifaces = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
	assert.equal(deriveCidr(ifaces), "");
});

test("parseNmapXml extracts ipv4, mac, hostname", () => {
	const hosts = parseNmapXml(XML);
	assert.equal(hosts.length, 3);
	assert.deepEqual(hosts[0], { ip: "192.168.1.1", mac: "AA:BB:CC:DD:EE:FF", hostname: "router.lan" });
	assert.equal(hosts[1].mac, null);
	assert.equal(hosts[1].hostname, null);
});

test("parseNmapPing extracts text-form hosts", () => {
	const text = [
		"Nmap scan report for 192.168.1.50",
		"Host is up.",
		"Nmap scan report for router.lan (192.168.1.1)",
		"MAC Address: AA:BB:CC:DD:EE:FF (RouterCo)"
	].join("\n");
	const hosts = parseNmapPing(text);
	assert.equal(hosts.length, 2);
	assert.deepEqual(hosts[0], { ip: "192.168.1.50", hostname: null, mac: null });
	assert.equal(hosts[1].ip, "192.168.1.1");
	assert.equal(hosts[1].hostname, "router.lan");
	assert.equal(hosts[1].mac, "AA:BB:CC:DD:EE:FF");
});

test("scan refuses on metered network", async () => {
	const d = createDiscoverer(makeCfg(), null, async () => ({ metered: true, transport: "wlan0" }));
	const r = await d.scan();
	assert.equal(r.ok, false);
	assert.match(r.error, /metered/);
});

test("scan refuses when offline", async () => {
	const d = createDiscoverer(makeCfg(), null, async () => ({ metered: true, transport: "none" }));
	const r = await d.scan();
	assert.equal(r.ok, false);
	assert.match(r.error, /offline/);
});

test("scan refused when discovery disabled", async () => {
	const d = createDiscoverer(makeCfg({ discoverEnabled: false }), null, async () => ({ metered: false, transport: "wlan0" }));
	const r = await d.scan();
	assert.equal(r.ok, false);
	assert.match(r.error, /disabled/);
});

test("scan errors clearly when nmap is missing", async () => {
	const runFn = async () => ({ code: null, signal: null, timedOut: false, spawnError: "spawn nmap ENOENT", stdout: "", stderr: "" });
	const d = createDiscoverer(makeCfg(), null, async () => ({ metered: false, transport: "wlan0" }), { runFn });
	const r = await d.scan({ target: "192.168.1.0/24" });
	assert.equal(r.ok, false);
	assert.match(r.error, /nmap not installed/);
});

test("scan rejects invalid target (no shell passthrough)", async () => {
	const d = createDiscoverer(makeCfg(), null, async () => ({ metered: false, transport: "wlan0" }));
	const r = await d.scan({ target: "; rm -rf /" });
	assert.equal(r.ok, false);
	assert.match(r.error, /invalid scan target/);
});

test("scan ingests hosts; unlabeled hidden, labeled visible", async () => {
	await withRegistry(async (reg) => {
		const runFn = async () => OK_RUN;
		const d = createDiscoverer(makeCfg(), reg, async () => ({ metered: false, transport: "wlan0" }), { runFn });
		const r = await d.scan({ target: "192.168.1.0/24" });
		assert.equal(r.ok, true);
		assert.equal(r.scanned, 3);
		assert.equal(r.ingested, 3);
		assert.equal(r.visible.length, 0, "unlabeled hosts are hidden by default (§5)");

		// Label one as mine → visible with allow.
		const all = await reg.all("hosts");
		const target = all.find((h) => (h.ips ?? []).includes("192.168.1.50"));
		assert.ok(target, "ingested host exists with ips[]");
		await reg.label("hosts", target.id, { owner: "me" });
		const visible = await reg.listVisible("hosts");
		assert.equal(visible.length, 1);
		assert.equal(visible[0].__gate, "allow");
	});
});

test("scan sets confirmed identity when MAC present, provisional otherwise", async () => {
	await withRegistry(async (reg) => {
		const runFn = async () => OK_RUN;
		const d = createDiscoverer(makeCfg(), reg, async () => ({ metered: false, transport: "wlan0" }), { runFn });
		await d.scan({ target: "192.168.1.0/24" });
		const all = await reg.all("hosts");
		const withMac = all.find((h) => h.mac);
		const withoutMac = all.find((h) => !h.mac);
		assert.equal(withMac.identityConfidence, "confirmed");
		assert.equal(withoutMac.identityConfidence, "provisional");
	});
});

test("scan returns error report (409) on nmap non-zero exit", async () => {
	const runFn = async () => ({ code: 2, signal: null, timedOut: false, spawnError: null, stdout: "", stderr: "bad target" });
	const d = createDiscoverer(makeCfg(), null, async () => ({ metered: false, transport: "wlan0" }), { runFn });
	const r = await d.scan({ target: "192.168.1.0/24" });
	assert.equal(r.ok, false);
	assert.match(r.error, /nmap exited 2/);
});
