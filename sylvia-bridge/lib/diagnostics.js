// mitmproxy is a TOGGLE, not a boot dependency (§21.1 of DESIGN.md).
//
// The daemon owns the switch: it rewrites the profile's `mitmproxy-mcp` row
// (comment/uncomment, marker-wrapped) and stops a live `mitmdump` on the way
// down. This module is the AGENT-facing surface of that switch, for the case
// the user described: an agent needs traffic-level network diagnostics and has
// no human at the panel to flip it.
//
// What it deliberately does NOT do: restart the harness. Enabling only takes
// effect on the next harness boot, and restarting from inside a turn would
// kill the very session that asked. The tool reports `needsRestart` and says so
// plainly, so the agent can tell the human instead of silently believing the
// tools are there.

/** Minimal daemon client: loopback JSON over the daemon's own API. */
function makeDaemonClient(baseUrl, fetchImpl = globalThis.fetch) {
	const base = String(baseUrl ?? 'http://127.0.0.1:3090').replace(/\/+$/, '');

	async function call(path, init = {}) {
		const url = `${base}${path}`;
		let response;
		try {
			response = await fetchImpl(url, {
				...init,
				headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
				signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(6000) : undefined,
			});
		} catch (error) {
			throw new Error(`sylvia-daemon is not reachable at ${base} (${error?.message ?? error}) — the toggle lives there`);
		}
		let body = null;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		if (!response.ok) {
			const reason = body?.error ?? body?.message ?? `HTTP ${response.status}`;
			throw new Error(String(reason));
		}
		return body;
	}

	return { call, base };
}

/**
 * Build the `net_diagnostics` tool definition.
 *
 * @param {{daemonUrl?: string, fetchImpl?: Function}} options
 */
export function netDiagnosticsTool(options = {}) {
	const client = makeDaemonClient(options.daemonUrl, options.fetchImpl);

	// The harness calls render(args, value) — value is the SECOND argument.
	const render = (_args, value) => {
		if (!value || !value.ok) return [{ type: 'text', text: `net_diagnostics: ${value?.reason ?? 'failed'}` }];
		const state = value.enabled ? 'enabled' : 'disabled';
		const lines = [
			`mitmproxy is ${state} (profile row ${value.registered ? (value.active ? 'active' : 'commented out') : 'missing'}).`,
		];
		if (value.listening) lines.push('A mitmdump is running now.');
		if (value.needsRestart) {
			lines.push(
				'It is NOT in force yet: the MCP tools appear only after the harness restarts, '
				+ 'and a restart ends this session. Ask the human to restart the harness (control panel → Restart harness), '
				+ 'or use the panel\'s toggle yourself if a human is present.',
			);
		} else if (value.enabled) {
			lines.push('The mitmproxy MCP tools are loaded in this harness.');
		}
		if (value.note) lines.push(value.note);
		return [{ type: 'text', text: lines.join(' ') }];
	};

	const shape = (raw) => ({
		ok: true,
		action: raw.action ?? 'status',
		enabled: raw.enabled === true,
		registered: raw.registered === true,
		active: raw.active === true,
		listening: raw.listening === true,
		needsRestart: raw.needsRestart === true,
		port: raw.port,
		...(raw.note === undefined ? {} : { note: raw.note }),
	});

	return {
		name: 'net_diagnostics',
		description:
			'Turn mitmproxy — the traffic-capture proxy behind the mitmproxy MCP tools — on or off for THIS node, '
			+ 'or report its state. Use it when you need packet/proxy-level network diagnostics that ordinary tools '
			+ 'cannot give you: enabling registers the mitmproxy MCP server in the harness profile. Enabling takes '
			+ 'effect only after the harness restarts (a restart ends this session), so report that to the human '
			+ 'instead of assuming the tools are available. Turning it off also stops a running mitmdump. '
			+ 'The proxy listens on loopback only.',
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['status', 'enable', 'disable'],
					description: 'status (default) reports without changing anything; enable/disable flip the switch.',
				},
				note: {
					type: 'string',
					description: 'Optional one-line reason recorded in the daemon log (why diagnostics are needed).',
				},
			},
			required: [],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: true,
				properties: {
					ok: { type: 'boolean' },
					action: { type: 'string' },
					enabled: { type: 'boolean' },
					registered: { type: 'boolean' },
					active: { type: 'boolean' },
					listening: { type: 'boolean' },
					needsRestart: { type: 'boolean' },
					port: { type: 'number' },
					note: { type: 'string' },
				},
				required: ['ok', 'enabled'],
			},
			render,
		},
		async execute(args = {}) {
			const action = args.action ?? 'status';
			try {
				if (action === 'status') {
					const status = await client.call('/api/mitm');
					return shape({ ...status, action, note: args.note });
				}
				const status = await client.call(`/api/mitm/${action}`, {
					method: 'POST',
					body: JSON.stringify({ note: args.note }),
				});
				return shape({
					...status,
					action,
					note: status.registered === false
						? 'This profile has no mitmproxy-mcp row, so there is nothing to toggle — the install never registered it.'
						: args.note,
				});
			} catch (error) {
				return { ok: false, action, enabled: false, reason: String(error?.message ?? error) };
			}
		},
	};
}

/** Register the tool on the harness `tools` service (injected fiber). */
export function registerNetDiagnosticsTool(ctx, config) {
	const register = (tools) => {
		if (tools === undefined || tools === null) return;
		try {
			tools.register(netDiagnosticsTool({ daemonUrl: config?.daemonUrl }));
			ctx.logger?.info?.('[sylvia-bridge] registered net_diagnostics');
		} catch (error) {
			ctx.logger?.warn?.('[sylvia-bridge] net_diagnostics registration failed:', error?.message ?? error);
		}
	};
	if (typeof ctx.inject === 'function') {
		ctx.inject(['tools'], (toolCtx) => register(toolCtx.tools ?? toolCtx.get?.('tools')));
	} else if (ctx.tools !== undefined) {
		register(ctx.tools);
	}
}
