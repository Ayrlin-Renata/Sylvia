// The daemon's side of the secret vault (DESIGN §20.12.3).
//
// The daemon is a separate process from the nuncia plugin, so it cannot share
// the plugin's decrypted environment — but it needs the same admin token to
// drive the panel. Rather than duplicating the crypto, the daemon reads the
// SAME encrypted file with the SAME passphrase from the environment.
//
// This module is intentionally a small, dependency-free mirror of the
// plugin's lib/secrets.js (the daemon ships as a standalone tree on the
// device, so it cannot import across the plugin boundary).

import { createDecipheriv, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The environment variable holding the vault passphrase. */
export const SECRET_KEY_ENV = "SYLVIA_SECRET_KEY";

/** The default vault location. */
export function defaultVaultPath(stateDir) {
	return join(stateDir || join(homedir(), ".sylvia"), "secrets.enc");
}

/**
 * The default passphrase-file location, beside the vault it opens. The
 * installer writes this file (mode 600) so a process can unlock the vault
 * without the secret appearing in its environment.
 *
 * @param {string} [stateDir]
 * @returns {string}
 */
export function defaultKeyFile(stateDir) {
	return join(stateDir || join(homedir(), ".sylvia"), ".secret-key");
}

/**
 * The default audit-trail location — the tripwire log that records every
 * vault decryption.
 *
 * It must be a SIBLING of the vault. An earlier version derived it by
 * stripping ".enc" and appending "/secrets-access.log", which produced
 * "<stateDir>/secrets/secrets-access.log" — a directory that never exists,
 * so every append failed, was swallowed, and the daemon's audit trail
 * silently recorded nothing.
 *
 * @param {string} [stateDir]
 * @returns {string}
 */
export function defaultAuditPath(stateDir) {
	return join(stateDir || join(homedir(), ".sylvia"), "secrets-access.log");
}

/**
 * Decrypt the vault.
 * @param {string} file
 * @param {string} passphrase
 * @returns {Record<string, string>}
 */
export function decryptVault(file, passphrase) {
	const raw = readFileSync(file, "utf8");
	const envelope = JSON.parse(raw);
	if (envelope?.version !== 1) throw new Error(`unsupported vault version ${String(envelope?.version)}`);
	if (envelope.cipher !== "aes-256-gcm") throw new Error(`unsupported vault cipher ${String(envelope?.cipher)}`);
	const kdf = envelope.kdf || {};
	if (kdf.name !== "scrypt") throw new Error(`unsupported vault kdf ${String(kdf.name)}`);
	const key = scryptSync(passphrase, Buffer.from(String(kdf.salt), "base64url"), 32, {
		N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024
	});
	let plaintext;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope.iv), "base64url"));
		decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64url"));
		plaintext = Buffer.concat([
			decipher.update(Buffer.from(String(envelope.data), "base64url")),
			decipher.final()
		]);
	} catch {
		throw new Error("the vault passphrase does not open this file");
	}
	const parsed = JSON.parse(plaintext.toString("utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("the vault did not decrypt to a map");
	}
	return parsed;
}

/**
 * Resolve the admin token for the proxy: the environment first (an explicit
 * override always wins), then the vault.
 *
 * @param {object} options
 * @param {string} [options.envToken] the token from the environment
 * @param {string} [options.vaultFile]
 * @param {string} [options.passphrase]
 * @returns {{token: string, source: string}}
 */
export function resolveAdminToken(options = {}) {
	if (options.envToken) return { token: options.envToken, source: "env" };
	const file = options.vaultFile;
	const passphrase = options.passphrase;
	if (!file || !passphrase || !existsSync(file)) return { token: "", source: "none" };
	try {
		const values = decryptVault(file, passphrase);
		const token = values.NUNCIA_ADMIN_TOKEN;
		if (typeof token === "string" && token !== "") return { token, source: "vault" };
	} catch {
		// A wrong passphrase is not fatal: the daemon simply has no admin
		// token, and the proxy says so with a 503 instead of failing to boot.
	}
	return { token: "", source: "none" };
}

/**
 * Resolve everything the daemon needs from the vault: the passphrase (from
 * the environment) and the admin token (from the vault or the environment).
 *
 * @param {object} options
 * @param {string} [options.stateDir]
 * @param {string} [options.envToken]
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {{token: string, source: string, vaultFile: string, passphrase: string|undefined}}
 */
/**
 * Record that the daemon opened the vault — the same tripwire the plugin
 * keeps. A line here means the daemon decrypted the secrets.
 * @param {string} auditFile
 * @param {{source: string, values?: string[]}} detail
 */
export function recordDaemonSecretAccess(auditFile, detail) {
	try {
		appendFileSync(
			auditFile,
			`${new Date().toISOString()} pid=${process.pid} source=${detail?.source ?? "unknown"} secrets=[${(detail?.values ?? []).join(",")}] reason=daemon\n`,
			{ mode: 0o600 }
		);
	} catch {
		// The audit trail must never break the thing it audits.
	}
}

export function loadDaemonSecrets(options = {}) {
	const env = options.env || process.env;
	const vaultFile = options.vaultFile || defaultVaultPath(options.stateDir);
	// The passphrase normally arrives as an exported variable, but a daemon
	// started by hand (setsid nohup node index.js from an adb shell) inherits
	// no such environment, and then it would report "neither the environment
	// nor the vault has one" while a perfectly good key file sits next to the
	// vault. Read that file as well — it is how the installer leaves the
	// secret, and the plugin already does this.
	const envPassphrase = env[options.keyEnv || SECRET_KEY_ENV];
	const passphrase = firstNonEmpty(
		typeof envPassphrase === "string" ? envPassphrase : undefined,
		readPassphraseFile(options.keyFile || defaultKeyFile(options.stateDir))
	);
	const resolved = resolveAdminToken({
		envToken: options.envToken ?? env.NUNCIA_ADMIN_TOKEN,
		vaultFile,
		passphrase
	});
	if (resolved.source === "vault") {
		recordDaemonSecretAccess(options.auditFile || defaultAuditPath(options.stateDir), { source: "daemon:vault", values: ["NUNCIA_ADMIN_TOKEN"] });
	}
	return { ...resolved, vaultFile, passphrase };
}

/** The first argument that is a non-empty string, else undefined. */
function firstNonEmpty(...values) {
	for (const v of values) if (typeof v === "string" && v !== "") return v;
	return undefined;
}

/**
 * Read a passphrase file, tolerating a trailing newline and surrounding
 * whitespace (the installer writes it with `echo`/`printf`, so both are seen)
 * and returning undefined for anything unreadable.
 *
 * @param {string} file
 * @returns {string|undefined}
 */
export function readPassphraseFile(file) {
	try {
		if (!existsSync(file)) return undefined;
		const text = readFileSync(file, "utf8").trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}
