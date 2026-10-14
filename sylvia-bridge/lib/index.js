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

import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createBridgeCore, DEFAULT_CONFIG } from './core.js';
import { sampleNetwork } from './sample.js';

export const name = 'sylvia-bridge';

export const inject = ['agents'];

export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
  onMetered: z.enum(['pause', 'allow']).default(DEFAULT_CONFIG.onMetered),
  pauseMode: z.enum(['finish-stream', 'immediate']).default(DEFAULT_CONFIG.pauseMode),
  resumeOnReconnect: z.boolean().default(DEFAULT_CONFIG.resumeOnReconnect),
  notifyPausedWork: z.boolean().default(DEFAULT_CONFIG.notifyPausedWork),
  onUnknown: z.enum(['allow', 'pause']).default(DEFAULT_CONFIG.onUnknown),
  daemonUrl: z.string().default(DEFAULT_CONFIG.daemonUrl),
  stateFile: z.string().default(DEFAULT_CONFIG.stateFile),
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
            kind: 'plugin',
            plugin: 'sylvia-bridge',
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

  ctx.on('agent/created', ({ agent }) => core.track(agent));
  ctx.on('agent/disposed', ({ agent }) => core.untrack(agent));
  ctx.on('agent/status', ({ agent, status }) => core.onAgentStatus(agent, status));
  ctx.on('agent/assistant-stream', ({ agent, frame }) => core.onStreamFrame(agent, frame));

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

  // Expose for debugging / future control-panel probes.
  ctx.provide?.('sylviaBridge', core.getState);
}
