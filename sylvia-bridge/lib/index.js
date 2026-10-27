// sylvia-bridge — DeepSeek Harness plugin adapter.
//
// Contract (matches @gorban/dsh-job-stop):
//   export const name    — cordis plugin name
//   export const inject  — services that must exist before us (agents lifecycle)
//   export const Config  — schemastery schema; the loader resolves defaults
//   export function apply(ctx, config)
//
// Side effects (cancel/inject) stay thin here; all gate semantics live in
// lib/core.js so they can be unit-tested without a running harness.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createBridgeCore, DEFAULT_CONFIG } from './core.js';
import { sampleNetwork } from './sample.js';
import { forwardSecurityEvent, normalizeSecurityEvent } from './security-event.js';
import { registerNetDiagnosticsTool } from './diagnostics.js';

export const name = 'sylvia-bridge';

export const inject = ['agents'];

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  // Termux's schemastery (3.18.5) ships no z.enum — build enums from
  // z.union([z.const(...)]) instead (same schema shape upstream).
  onMetered: z.union([z.const('pause'), z.const('allow')]).default(DEFAULT_CONFIG.onMetered),
  pauseMode: z.union([z.const('finish-stream'), z.const('immediate')]).default(DEFAULT_CONFIG.pauseMode),
  resumeOnReconnect: z.boolean().default(DEFAULT_CONFIG.resumeOnReconnect),
  notifyPausedWork: z.boolean().default(DEFAULT_CONFIG.notifyPausedWork),
  onUnknown: z.union([z.const('allow'), z.const('pause')]).default(DEFAULT_CONFIG.onUnknown),
  // A2A sessions (nuncia operators + the chatelaine) keep working while the
  // metered gate is held when this is on. Default off: metered data means no
  // work unless the operator says otherwise (DESIGN §20.12 P3.1).
  allowA2AOnMetered: z.boolean().default(DEFAULT_CONFIG.allowA2AOnMetered),
  daemonUrl: z.string().default(DEFAULT_CONFIG.daemonUrl),
  stateFile: z.string().default(DEFAULT_CONFIG.stateFile),
  cssFile: z.string().default(DEFAULT_CONFIG.cssFile),
  pollIntervalMs: z.number().min(1000).default(DEFAULT_CONFIG.pollIntervalMs),
  staleAfterMs: z.number().min(5000).default(DEFAULT_CONFIG.staleAfterMs),
});

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };

  const core = createBridgeCore(cfg, {
    now: () => Date.now(),
    // Plugin pause = hook-cause cancellation; keepInbox preserves queued work
    // for a later turn (DESIGN §3: no auto-release — resumeOnReconnect=false).
    cancel: (agent, reason) => {
      try {
        agent.cancel({ kind: 'hook', reason }, { keepInbox: true });
      } catch (error) {
        ctx.logger?.warn?.('[sylvia-bridge] cancel failed:', error?.message ?? error);
      }
    },
    deliver: (agent, text, mode) => {
      try {
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            // NOT the retired `kind: 'plugin'` wrapper: the v4 session format
            // refuses it ("format v4 message requires a producer-owned source
            // kind") and the rejected write fails the whole turn. The canonical
            // producer kind for a third-party plugin is `plugin:<package>` —
            // what the format's own producerKind() fallback produces.
            kind: 'plugin:sylvia-bridge',
            form: 'notice',
            summary: boundContextSummary(text.split('\n')[0]),
          },
        });
        if (mode === 'followup') agent.followup(message);
        else agent.inject(message);
      } catch (error) {
        ctx.logger?.warn?.('[sylvia-bridge] deliver failed:', error?.message ?? error);
      }
    },
    log: (...args) => ctx.logger?.info?.(...args),
  });

  // nuncia republishes its authority security events on the host bus as
  // `nuncia/security-event`. Cordis emits bubble CHILD → ROOT, so a sibling
  // plugin (nuncia) never sees another plugin's emission; only a listener on
  // the root context does. That is why this subscription is made on the root
  // rather than on this plugin's own context: the event originates inside
  // nuncia's fiber and can only be observed from above it.
  //
  // The forwarded event is what lets the daemon raise a notification for a
  // refused authority claim — the human path for "a peer tried to mint
  // something it was not granted".
  const root = ctx.root ?? ctx
  const onSecurityEvent = (event) => {
    try {
      const payload = normalizeSecurityEvent(event)
      ctx.logger?.warn?.(`[sylvia-bridge] authority security event: ${payload.kind}${payload.reason === null ? '' : ` (${payload.reason})`}`)
      void forwardSecurityEvent(cfg, payload)
    } catch (error) {
      ctx.logger?.warn?.('[sylvia-bridge] security-event forward failed:', error?.message ?? error)
    }
  }
  root.on?.('nuncia/security-event', onSecurityEvent)

  ctx.on('agent/created', ({ agent }) => core.track(agent));
  ctx.on('agent/disposed', ({ agent }) => core.untrack(agent));
  ctx.on('agent/status', ({ agent, status }) => core.onAgentStatus(agent, status));
  ctx.on('agent/assistant-stream', ({ agent, frame }) => core.onStreamFrame(agent, frame));

  // A2A sessions announce themselves by their SESSION ID (nuncia names its
  // operator and chatelaine sessions `a2a-op-…` / `a2a-chatelaine-…`). The id
  // is durable — the session header cannot carry a custom `origin` (the v4
  // format allows only "subagent"), so a restarted operator is still
  // recognised as exempt.
  ctx.on('agent/created', ({ agent }) => {
    const id = agent?.id ?? agent?.session?.header?.id ?? agent?.session?.id;
    if (typeof id === 'string' && (id.startsWith('a2a-op-') || id.startsWith('a2a-chatelaine-'))) {
      core.setExempt(agent, true);
      ctx.logger?.info?.(`[sylvia-bridge] A2A session ${id} registered`);
    }
  });

  async function tick() {
    try {
      const sample = await sampleNetwork(cfg);
      core.onSample(sample);
    } catch (error) {
      ctx.logger?.warn?.('[sylvia-bridge] sample failed:', error?.message ?? error);
    }
  }

  ctx.effect(() => {
    void tick();
    const timer = setInterval(() => void tick(), cfg.pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'sylvia-bridge:poll');

  // Mobile custom-CSS seam. DSH ships no user-stylesheet hook, so we mirror the
  // ui-theme plugin's registration: tap the host's index transform and inline
  // cfg.cssFile as a <style> element. The file is read on EVERY index render,
  // so edits apply on the next browser refresh — no restart, no rebuild.
  // Absent/empty file → page untouched (the default state before first use).
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      let announced = false;
      const disposer = httpCtx.webServer.tapIndex((html) => {
        let css = '';
        try {
          const path = cfg.cssFile.startsWith('~')
            ? join(homedir(), cfg.cssFile.slice(1))
            : cfg.cssFile;
          css = readFileSync(path, 'utf8');
        } catch {
          return html; // no stylesheet yet (or unreadable) — leave the page alone
        }
        if (!css.trim()) return html;
        if (!announced) {
          announced = true;
          ctx.logger?.info?.(`[sylvia-bridge] mobile css active (${cfg.cssFile})`);
        }
        // A literal "</style" inside the file would end the element early.
        const safe = css.replace(/<\/style/gi, '<\\/style');
        const tag = `<style id="sylvia-mobile-css">\n${safe}\n</style>`;
        if (html.includes('</head>')) return html.replace('</head>', `${tag}\n</head>`);
        return `${html}\n${tag}`;
      });
      return disposer;
    }, 'sylvia-bridge:mobile-css');
  });

  // mitmproxy toggle (§21.1): the agent-facing side of the daemon's switch.
  // An agent that needs traffic-level diagnostics can turn the proxy on, but
  // the MCP tools only exist after a harness restart — the tool says so rather
  // than pretending. Never restarts anything from inside a turn.
  registerNetDiagnosticsTool(ctx, cfg);

  // Expose for debugging / future control-panel probes.
  ctx.provide?.('sylviaBridge', core.getState);

  // Release the root-level subscription when the plugin unloads.
  ctx.effect(() => () => {
    try { root.off?.('nuncia/security-event', onSecurityEvent) } catch { /* already gone */ }
  }, 'sylvia-bridge:security-events')
}

