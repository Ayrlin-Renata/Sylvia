// ---------------------------------------------------------------------------
// Netgate — the EXTERNAL managed-traffic stop (DESIGN.md §2.3). Independent
// of the in-process harness hold: netgate SIGSTOPs whole process groups of
// managed services (rclone syncs, mDNS, mitmproxy, module `always` services)
// when the network is metered/offline. No root needed — every Termux process
// is one UID, so kill(-pgid) to a setsid'd group is allowed.
//
// POSIX signals only: on Windows SIGSTOP/SIGCONT don't exist, so the daemon
// refuses to run the gate there (killFn is injectable for tests anyway).
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ManagedService
 * @property {string} name
 * @property {number} pgid        process group id (service must own its group)
 * @property {string} [note]      freeform (e.g. "module:sillytavern")
 * @property {number} registeredAt
 * @property {boolean} [exempt]   kept RUNNING while the gate is held (DESIGN §20.5)
 */

/**
 * @param {object} opts
 * @param {(pgid:number, signal:string)=>void} [opts.killFn]  injectable for tests
 * @returns {{
 *   register:(name:string, pgid:number, note?:string, opts?:{exempt?:boolean})=>ManagedService,
 *   unregister:(name:string)=>boolean,
 *   list:()=>ManagedService[],
 *   setExempt:(name:string, exempt:boolean)=>boolean,
 *   hold:(reason:string)=>{stopped:string[], failed:{name:string,error:string}[], exempt:string[], alreadyHeld:boolean},
 *   resume:(reason:string)=>{resumed:string[], failed:{name:string,error:string}[], notHeld:boolean},
 *   status:()=>{held:boolean, reason:string|null, heldSince:number|null, count:number, exempt:string[]}
 * }}
 */
export function createNetgate({ killFn = defaultKill } = {}) {
	/** @type {Map<string, ManagedService>} */
	const services = new Map();
	let held = false;
	let heldSince = null;
	let holdReason = null;

	function register(name, pgid, note, opts = {}) {
		if (!name || !Number.isInteger(pgid) || pgid <= 0) {
			throw new Error(`invalid service registration: name=${name} pgid=${pgid}`);
		}
		const svc = { name, pgid, note, registeredAt: Date.now(), exempt: opts.exempt === true };
		services.set(name, svc);
		return svc;
	}

	/**
	 * Mark a registered service exempt from the gate (DESIGN §20.5).
	 *
	 * An exempt service keeps RUNNING while the gate is held: it is not
	 * SIGSTOPped, and it is not SIGCONTed on resume (it never stopped). This
	 * is what lets the A2A listener stay reachable on metered data when the
	 * node says so — while everything else stays stopped.
	 *
	 * @param {string} name
	 * @param {boolean} exempt
	 * @returns {boolean} whether the service exists
	 */
	function setExempt(name, exempt) {
		const svc = services.get(name);
		if (svc === undefined) return false;
		svc.exempt = exempt === true;
		return true;
	}

	function unregister(name) {
		return services.delete(name);
	}

	function list() {
		return [...services.values()];
	}

	function hold(reason) {
		if (held) {
			return { stopped: [], failed: [], exempt: exemptNames(), alreadyHeld: true };
		}
		const stopped = [];
		const failed = [];
		for (const svc of services.values()) {
			// An exempt service keeps running: metered data stops the managed
			// traffic, not the A2A listener the operator asked to keep up.
			if (svc.exempt === true) continue;
			try {
				// Negative pgid = whole process group (services run under setsid).
				killFn(-svc.pgid, "SIGSTOP");
				stopped.push(svc.name);
			} catch (e) {
				// ESRCH = process already gone; drop it from the registry quietly.
				if (e.code !== "ESRCH") failed.push({ name: svc.name, error: String(e.message ?? e) });
			}
		}
		held = true;
		heldSince = Date.now();
		holdReason = reason ?? null;
		return { stopped, failed, exempt: exemptNames(), alreadyHeld: false };
	}

	function resume(reason) {
		if (!held) {
			return { resumed: [], failed: [], notHeld: true };
		}
		const resumed = [];
		const failed = [];
		for (const svc of services.values()) {
			// An exempt service was never stopped — sending it SIGCONT would
			// be harmless but is a lie about what the gate did.
			if (svc.exempt === true) continue;
			try {
				killFn(-svc.pgid, "SIGCONT");
				resumed.push(svc.name);
			} catch (e) {
				if (e.code !== "ESRCH") failed.push({ name: svc.name, error: String(e.message ?? e) });
			}
		}
		held = false;
		heldSince = null;
		holdReason = null;
		return { resumed, failed, notHeld: false };
	}

	function exemptNames() {
		return [...services.values()].filter((svc) => svc.exempt === true).map((svc) => svc.name);
	}

	function status() {
		return { held, reason: holdReason, heldSince, count: services.size, exempt: exemptNames() };
	}

	return { register, unregister, list, setExempt, hold, resume, status };
}

function defaultKill(pgid, signal) {
	process.kill(pgid, signal);
}
