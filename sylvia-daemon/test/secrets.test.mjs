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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname as dirOf, join } from "node:path";

import { decryptVault, defaultAuditPath, defaultKeyFile, defaultVaultPath, loadDaemonSecrets, resolveAdminToken } from "../src/secrets.js";

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

test("the default audit path is a SIBLING of the vault, not a subdirectory", () => {
	// The earlier derivation (strip ".enc", append "/secrets-access.log")
	// produced "<stateDir>/secrets/secrets-access.log" — a directory that
	// never exists, so every append failed silently and the audit trail
	// recorded nothing. The two paths must share a parent.
	assert.equal(defaultAuditPath("/state"), join("/state", "secrets-access.log"));
	assert.equal(defaultVaultPath("/state").split(/[\\/]/).slice(0, -1).join("/"), defaultAuditPath("/state").split(/[\\/]/).slice(0, -1).join("/"));
});

test("a vault read actually writes the audit line", () => {
	const { dir, file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const audit = join(dir, "secrets-access.log");
	const loaded = loadDaemonSecrets({
		stateDir: dir,
		envToken: "",
		vaultFile: file,
		auditFile: audit,
		env: { SYLVIA_SECRET_KEY: PASSPHRASE }
	});
	assert.equal(loaded.token, "from-vault");
	assert.ok(existsSync(audit), "the audit file was never created");
	const line = readFileSync(audit, "utf8");
	assert.match(line, /source=daemon:vault/);
	assert.match(line, /NUNCIA_ADMIN_TOKEN/);
	assert.match(line, /reason=daemon/);
});

test("the default audit path is used when no explicit one is given", () => {
	const { dir, file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	loadDaemonSecrets({ stateDir: dir, envToken: "", vaultFile: file, env: { SYLVIA_SECRET_KEY: PASSPHRASE } });
	const audit = join(dir, "secrets-access.log");
	assert.ok(existsSync(audit), "the default audit path must be writable");
	assert.match(readFileSync(audit, "utf8"), /source=daemon:vault/);
});

test("the key env var is a NAME, so a custom name works", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const loaded = loadDaemonSecrets({
		stateDir: undefined,
		envToken: "",
		vaultFile: file,
		keyEnv: "MY_OWN_KEY_NAME",
		env: { MY_OWN_KEY_NAME: PASSPHRASE }
	});
	assert.equal(loaded.token, "from-vault");
});

test("a missing key env var leaves the daemon without a token when no key file exists either", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	// keyFile points at a path that does not exist, so there is genuinely no
	// way in: the daemon reports "none" rather than guessing.
	const loaded = loadDaemonSecrets({
		stateDir: undefined,
		envToken: "",
		vaultFile: file,
		keyFile: join(dirOf(file), "no-such-key"),
		keyEnv: "NOT_SET",
		env: {}
	});
	assert.equal(loaded.token, "");
	assert.equal(loaded.source, "none");
});

test("the daemon reads the passphrase FILE when the variable is absent", () => {
	// This is the hand-started case: `setsid nohup node index.js` from an adb
	// shell inherits no exported variable, but the installer leaves the
	// passphrase beside the vault. Without this fallback the daemon reports
	// "neither the environment nor the vault has one" while the key it needs
	// sits on disk.
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const keyFile = join(dirOf(file), "key.txt");
	// Trailing newline: the installer writes it with echo/printf.
	writeFileSync(keyFile, `${PASSPHRASE}\n`, { mode: 0o600 });

	const loaded = loadDaemonSecrets({ stateDir: undefined, envToken: "", vaultFile: file, keyFile, env: {} });
	assert.equal(loaded.token, "from-vault");
	assert.equal(loaded.source, "vault");
});

test("an exported variable still wins over the key file", () => {
	const { file } = scratch();
	writeVault(file, { NUNCIA_ADMIN_TOKEN: "from-vault" }, PASSPHRASE);
	const keyFile = join(dirOf(file), "key.txt");
	writeFileSync(keyFile, "a-wrong-passphrase\n", { mode: 0o600 });
	const loaded = loadDaemonSecrets({
		stateDir: undefined,
		envToken: "",
		vaultFile: file,
		keyFile,
		env: { SYLVIA_SECRET_KEY: PASSPHRASE }
	});
	// The wrong file cannot even be reached, because the environment answered
	// first - a stale key file must never override a deliberate export.
	assert.equal(loaded.token, "from-vault");
	assert.equal(loaded.source, "vault");
});

test("defaultKeyFile sits beside the vault", () => {
	assert.equal(defaultKeyFile("/tmp/state"), join("/tmp/state", ".secret-key"));
	assert.equal(defaultKeyFile(undefined), join(homedir(), ".sylvia", ".secret-key"));
});
