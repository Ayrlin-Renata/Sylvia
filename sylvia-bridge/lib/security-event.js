// sylvia-bridge — authority security-event forwarding (pure, no DSH imports).
//
// The adapter (lib/index.js) subscribes to `nuncia/security-event` on the
// ROOT context — cordis emits bubble CHILD → ROOT, so an event emitted
// inside nuncia's own fiber never reaches a sibling plugin's child-scoped
// listener, but does reach the root. This module holds the two pure pieces
// of that path so they can be unit-tested on any machine (the adapter needs
// the DSH packages, which are not installed everywhere).
//
// The forward is best-effort: the daemon may not be running, the network may
// be down, and neither is a reason to fail the plugin.

/**
 * Normalize a raw security event into the shape the daemon accepts.
 * @param {any} event
 * @returns {{kind: string, reason: string|null, detail: any, at: string}}
 */
export function normalizeSecurityEvent(event) {
  return {
    kind: event?.kind ?? 'authority-event',
    reason: event?.reason ?? null,
    detail: event?.detail ?? null,
    at: new Date().toISOString(),
  }
}

/**
 * Forward a security event to the daemon, which owns the notification path.
 *
 * @param {any} cfg - the bridge config (needs `daemonUrl`)
 * @param {any} payload - the normalized event
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {Promise<boolean>} whether the daemon accepted it
 */
export async function forwardSecurityEvent(cfg, payload, deps = {}) {
  if (!cfg?.daemonUrl) return false
  const doFetch = deps.fetchImpl ?? globalThis.fetch
  const url = `${String(cfg.daemonUrl).replace(/\/$/, '')}/api/a2a/event`
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2500),
    })
    return response.ok
  } catch {
    return false
  }
}
