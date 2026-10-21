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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The environment variable holding the vault passphrase. */
export const SECRET_KEY_ENV = "SYLVIA_SECRET_KEY";

/** The default vault location. */
export function defaultVaultPath(stateDir) {
	return join(stateDir || join(homedir(), ".sylvia"), "secrets.enc");
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
export function loadDaemonSecrets(options = {}) {
	const env = options.env || process.env;
	const vaultFile = options.vaultFile || defaultVaultPath(options.stateDir);
	const passphrase = env[options.keyEnv || SECRET_KEY_ENV];
	const resolved = resolveAdminToken({
		envToken: options.envToken ?? env.NUNCIA_ADMIN_TOKEN,
		vaultFile,
		passphrase: typeof passphrase === "string" && passphrase !== "" ? passphrase : undefined
	});
	return { ...resolved, vaultFile, passphrase: typeof passphrase === "string" ? passphrase : undefined };
}
