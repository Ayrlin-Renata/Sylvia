// sylvia-bridge — network sample source.
//
// Primary: sylvia-daemon control API (GET /api/network). Fallback: the daemon's
// netstate.json snapshot (the daemon is the single writer). Anything stale or
// unreadable resolves to null = unknown, and the core applies onUnknown.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Normalize a daemon payload or netstate.json body into a fresh sample.
 *  Returns null when the payload is malformed or older than staleAfterMs. */
export function freshSample(body, staleAfterMs, nowMs = Date.now()) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.at !== 'number') return null;
  if (nowMs - body.at > staleAfterMs) return null;
  if (typeof body.metered !== 'boolean') return null;
  const transport = typeof body.transport === 'string' ? body.transport : 'unknown';
  // The daemon's own exemption decision travels with the sample: the daemon
  // is the authority on the network, so it is the authority on what stays up
  // when the gate holds (DESIGN §20.5).
  const a2aExempt = body.a2aExempt === true;
  return { metered: body.metered, transport, at: body.at, a2aExempt };
}

export function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** @param {object} cfg resolved plugin config.
 *  @param {object} [deps] { fetchImpl, readFileSyncImpl, now } for tests. */
export async function sampleNetwork(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const readFileImpl = deps.readFileSyncImpl ?? readFileSync;
  const now = deps.now ?? (() => Date.now());

  try {
    const res = await fetchImpl(`${cfg.daemonUrl}/api/network`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const sample = freshSample(await res.json(), cfg.staleAfterMs, now());
      if (sample) return sample;
    }
  } catch {
    // daemon down or unreachable — fall through to the state file
  }

  try {
    const text = readFileImpl(expandHome(cfg.stateFile), 'utf8');
    const sample = freshSample(JSON.parse(text), cfg.staleAfterMs, now());
    if (sample) return sample;
  } catch {
    // no file / unreadable / corrupt
  }

  return null;
}
