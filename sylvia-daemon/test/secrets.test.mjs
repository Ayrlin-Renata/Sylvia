/**
 * Tests for the daemon's vault reader (src/secrets.js).
 *
 * The daemon is a separate process from the plugin, so it carries its own
 * small mirror of the vault format. These tests pin the contract between the
 * two: what the plugin writes, the daemon must be able to open.
 *
 * Run: node --test test/secrets.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decryptVault, defaultVaultPath, loadDaemonSecrets, resolveAdminToken } from "../src/secrets.js";

const PASSPHRASE = "daemon vault passphrase";

/** Write a vault exactly the way the plugin's lib/secrets.js does. */
function writeVault(file, values, passphrase) {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(values), "utf8")), cipher.final()]);
	const envelope = {
		version: 1,
		kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: salt.toString("base64url") },
		cipher: "aes-256-gcm",
		iv: iv.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
		data: data.toString("base64url")
	};
	writeFileSync(file, JSON.stringify(envelope, null, 2));
	return file;
}

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "sylvia-vault-"));
	return { dir, file: join(dir, "secrets.enc") };
}

test("the daemon opens a vault the plugin wrote", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "admin-from-vault" }, PASSPHRASE);
	assert.deepEqual(decryptVault(file, PASSPHRASE), { NUNCIA_ADMIN_TOKEN: "admin-from-vault" });
});

test("the wrong passphrase is refused", () => {
	const { file } = scratch();
	writeVault(file, { A: "b" }, PASSPHRASE);
	assert.throws(() => decryptVault(file, "not the passphrase"), /does not open/);
});

test("the environment token wins over the vault", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const resolved = resolveAdminToken({ envToken: "from-env", vaultFile: file, passphrase: PASSPHRASE });
	assert.deepEqual(resolved, { token: "from-env", source: "env" });
});

test("the vault is used when the environment is empty", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const resolved = resolveAdminToken({ envToken: "", vaultFile: file, passphrase: PASSPHRASE });
	assert.deepEqual(resolved, { token: "from-vault", source: "vault" });
});

test("no vault, no key, no token — and no throw", () => {
	const { file } = scratch();
	const resolved = resolveAdminToken({ envToken: "", vaultFile: file, passphrase: undefined });
	assert.deepEqual(resolved, { token: "", source: "none" });
});

test("a wrong passphrase leaves the daemon without a token, not broken", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "x" }, PASSPHRASE);
	const resolved = resolveAdminToken({ envToken: "", vaultFile: file, passphrase: "wrong" });
	assert.deepEqual(resolved, { token: "", source: "none" });
});

test("loadDaemonSecrets wires the whole chain", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const loaded = loadDaemonSecrets({ stateDir: undefined, envToken: "", vaultFile: file, env: { SYLVIA_SECRET_KEY: PASSPHRASE } });
	assert.equal(loaded.token, "from-vault");
	assert.equal(loaded.source, "vault");
	assert.equal(loaded.vaultFile, file);
});

test("the default vault path lives in the state dir", () => {
	assert.equal(defaultVaultPath("/state"), join("/state", "secrets.enc"));
});
