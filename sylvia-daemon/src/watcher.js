import { detect } from "./netdetect.js";

// ---------------------------------------------------------------------------
// Watcher — polls Tier-0/Tier-1 detection, persists netstate.json, and drives
// the netgate hold/resume policy:
//   • metered or no-network  → HOLD managed traffic
//   • unmetered (wifi/other) → RESUME, but ONLY if resumeOnReconnect
//     (locked default false — held services stay held; release is explicit).
// The harness ITSELF is never touched here — that's the sylvia-bridge
// plugin's job (DESIGN.md §3). This process may itself be inside a held
// group, so the gate must not depend on being scheduled.
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {any} deps.config
 * @param {ReturnType<import("./netgate.js").createNetgate>} deps.netgate
 * @param {import("./statemgr.js").StateStore} deps.store
 * @param {(...a:any[])=>void} deps.log
 */
export function createWatcher({ config, netgate, store, log }) {
	let timer = null;
	let lastState = null;
	let running = false;

	async function tick() {
		if (running) return; // never overlap polls
		running = true;
		try {
			const state = await detect(config);
			// Persist for consumers (mcp tools read this file as fallback).
			await store.write("netstate.json", state);

			const changed =
				!lastState ||
				lastState.transport !== state.transport ||
				lastState.metered !== state.metered ||
				lastState.source !== state.source;

			if (changed) {
				log("netstate:", state.transport, state.metered ? "METERED" : "unmetered", `via ${state.source}`);
				if (state.source === "unavailable") {
					// fail-closed engaged because the 'ip' binary could not be spawned
					log("hint: Tier-0 detection unavailable — is `ip` installed? (pkg install iproute2)");
				}
			}
			// ALWAYS publish the fresh state (with its fresh `at` stamp), not
			// just on transitions — a frozen snapshot makes /api/network look
			// stale and hides poll liveness from consumers.
			lastState = state;

			if (!config.gateEnabled) return;

			const shouldHold = state.metered || state.transport === "none";
			const st = netgate.status();

			if (shouldHold && !st.held) {
				const reason = state.transport === "none" ? "offline" : "metered";
				const r = netgate.hold(reason);
				log(`netgate HOLD (${reason}):`, r.stopped.length ? r.stopped.join(",") : "(no services)", r.failed.length ? `FAILED: ${JSON.stringify(r.failed)}` : "");
				await store.write("netgate.json", netgate.status());
			} else if (!shouldHold && st.held && config.resumeOnReconnect) {
				const r = netgate.resume("reconnected");
				log("netgate RESUME (reconnected):", r.resumed.join(","));
				await store.write("netgate.json", netgate.status());
			}
			// !shouldHold && st.held && !resumeOnReconnect → stay held (locked policy).
		} catch (e) {
			log("watcher tick error:", String(e && e.message ? e.message : e));
		} finally {
			running = false;
		}
	}

	function start() {
		if (timer) return;
		// First tick immediately so the API serves fresh data at boot.
		tick();
		timer = setInterval(tick, config.pollIntervalMs);
		timer.unref?.();
	}

	function stop() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	return { tick, start, stop, getLastState: () => lastState };
}
