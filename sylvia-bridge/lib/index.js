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

  // Expose for debugging / future control-panel probes.
  ctx.provide?.('sylviaBridge', core.getState);
}
