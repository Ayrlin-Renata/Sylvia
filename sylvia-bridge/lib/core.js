// sylvia-bridge — pure gate state machine.
//
// No node built-ins, no @deepseek-ai imports here: the DSH plugin adapter
// (lib/index.js) wires real agents and real cancel/inject calls into this
// core so the gate semantics stay unit-testable on any machine.

/** Resolved plugin config. The cordis loader fills these via the Config
 *  schema; the spread keeps the core usable without the loader (tests). */
export const DEFAULT_CONFIG = {
  enabled: true,
  // 'pause' gates the harness on metered data / no network; 'allow' observes only.
  onMetered: 'pause',
  // 'finish-stream' lets the in-flight model stream commit, then cancels;
  // 'immediate' cancels the running turn as soon as the gate trips.
  pauseMode: 'finish-stream',
  // Locked default (DESIGN.md §14): on return to unmetered do NOT auto-release
  // held work — only inject a notice describing the pause.
  resumeOnReconnect: false,
  // Locked default: inject the pause notice on reconnect so the next message
  // carries 'time elapsed while offline' + held-work context.
  notifyPausedWork: true,
  // Daemon unreachable / no fresh sample: 'allow' keeps running (desktop-safe),
  // 'pause' fails closed. Stale samples (older than staleAfterMs) count as unknown.
  onUnknown: 'allow',
  // A2A sessions (nuncia operators + the chatelaine) are exempt from the
  // metered gate when this is on (DESIGN §20.12 P3.1). Default OFF: the
  // fail-closed posture is that metered data means no work, and an exemption
  // is the human's decision to make.
  allowA2AOnMetered: false,
  daemonUrl: 'http://127.0.0.1:3090',
  stateFile: '~/.sylvia/netstate.json',
  // Custom CSS inlined into every index render (see lib/index.js). Absent or
  // empty file = no injection; edits apply on the next browser refresh.
  cssFile: '~/.sylvia/mobile.css',
  pollIntervalMs: 10000,
  staleAfterMs: 60000,
};

/** '42s' / '5m 3s' / '2h 7m' — same shape as @gorban/dsh-job-stop's helper. */
export function describeElapsed(elapsedMs) {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Reconnect notice text. Injected pending (or delivered as a followup when
 *  resumeOnReconnect is on). */
export function buildResumeNotice({ elapsedMs, heldCount, reason }) {
  const lines = [
    `[sylvia] Network gate: the connection was on ${reason === 'offline' ? 'no usable network' : 'metered data'} for ${describeElapsed(elapsedMs)}; the harness was paused.`,
  ];
  if (heldCount > 0) {
    lines.push(
      `[sylvia] ${heldCount} held task(s) remain parked and were NOT resumed automatically. If the user asks to resume, continue from where the session left off and note that ${describeElapsed(elapsedMs)} elapsed while paused.`,
    );
  }
  return lines.join('\n');
}

/**
 * @param {object} userConfig resolved config (partial ok).
 * @param {object} [deps] side-effect sinks, all injectable for tests:
 *   now()            clock
 *   cancel(agent, reason)  abort an agent turn (adapter maps to agent.cancel)
 *   deliver(agent, text, mode)  'inject' | 'followup' a notice message
 *   log(...args)
 */
export function createBridgeCore(userConfig = {}, deps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  const now = deps.now ?? (() => Date.now());
  const cancel = deps.cancel ?? (() => {});
  const deliver = deps.deliver ?? (() => {});
  const log = deps.log ?? (() => {});

  /** 'run' | 'held' */
  let state = 'run';
  let heldSince = null;
  let holdReason = null;
  let lastSample = null;

  const tracked = new Set();          // agents this bridge has seen
  const status = new Map();           // agent -> 'idle' | 'running' | undefined
  const activeStream = new WeakSet(); // agents with a live assistant stream
  const pendingFinish = new Set();    // finish-stream waits: cancel on frame end
  const paused = new Map();           // agent -> { at, mode } — counted for resume notice
  const exempt = new Set();           // agents that keep running while held

  /**
   * Is this agent an A2A session (nuncia operator or chatelaine)?
   *
   * The tag lives in the session's `origin` field — the one free-form field
   * the v4 session header keeps (`dsh-session` `SessionStore.prepare` copies
   * `meta.origin` verbatim into the header, where it survives restarts). The
   * agent's own id is the session id, so the tag is readable from the live
   * agent without a store lookup.
   *
   * @param {any} agent
   * @returns {boolean}
   */
  function isA2AAgent(agent) {
    const id = agent?.id ?? agent?.session?.header?.id ?? agent?.session?.id
    if (typeof id !== 'string') return false
    // The carrier is the SESSION ID, not the header: the v4 session format
    // accepts only `origin: "subagent"` in the durable header (the live AVD
    // run proved it — "session header origin must be \"subagent\""), and no
    // other header field survives a restart. nuncia therefore names its A2A
    // sessions `a2a-op-<level>-<taskId>` / `a2a-chatelaine-<uuid>`, which
    // survives restarts because the id does.
    return id.startsWith('a2a-op-') || id.startsWith('a2a-chatelaine-')
  }

  /** Mark an agent exempt (or not) from the metered gate. */
  function setExempt(agent, value) {
    if (value) exempt.add(agent)
    else exempt.delete(agent)
  }

  /** Is this agent exempt right now?
   *
   *  The exemption needs BOTH:
   *    - the agent IS an A2A session (an operator or the chatelaine), and
   *    - somebody with the authority to decide said so: this node's
   *      `allowA2AOnMetered` flag, or the daemon's decision (which rides the
   *      network sample).
   *  An ordinary session is never exempt, whatever the flags say.
   */
  function isExempt(agent) {
    const allowed = cfg.allowA2AOnMetered === true || lastSample?.a2aExempt === true
    if (!allowed) return false
    // Explicitly exempted (setExempt) — any agent, by deliberate decision.
    if (exempt.has(agent)) return true
    // Automatically exempt: the agent IS an A2A session.
    return isA2AAgent(agent)
  }

  function decide(sample) {
    if (!cfg.enabled || cfg.onMetered === 'allow') return false;
    if (sample === null) return cfg.onUnknown === 'pause';
    return sample.metered === true || sample.transport === 'none';
  }

  function cancelNow(agent, tag) {
    const reason = `sylvia-netgate: ${holdReason ?? 'metered'}${tag ? ` (${tag})` : ''}`;
    cancel(agent, reason);
    paused.set(agent, { at: now(), mode: tag || holdReason });
  }

  function pauseRunning(agent, isNew) {
    // An A2A session (nuncia operator / chatelaine) keeps working while the
    // gate is held, if the operator allowed that: inbound peer work must not
    // die because the phone is on metered data.
    if (isExempt(agent)) {
      log('[sylvia-bridge] A2A session exempt from the metered gate');
      return;
    }
    if (cfg.pauseMode === 'immediate') {
      cancelNow(agent, isNew ? 'new work while paused' : 'immediate');
      return;
    }
    // finish-stream: let the live stream commit, then cancel.
    if (activeStream.has(agent)) {
      pendingFinish.add(agent);
      if (!paused.has(agent)) paused.set(agent, { at: now(), mode: 'finish-stream' });
    } else {
      // Nothing in flight to finish (mid-tool or already idle-ish): cancel now.
      cancelNow(agent, isNew ? 'new work while paused' : undefined);
    }
  }

  function enterHold(sample) {
    state = 'held';
    heldSince = now();
    holdReason = sample === null ? 'unknown-network' : sample.transport === 'none' ? 'offline' : 'metered';
    log('[sylvia-bridge] hold:', holdReason);
    for (const agent of tracked) {
      if (status.get(agent) === 'running') pauseRunning(agent, false);
    }
  }

  function exitHold(sample) {
    const elapsedMs = now() - heldSince;
    const count = paused.size;
    state = 'run';
    heldSince = null;
    holdReason = null;
    pendingFinish.clear();
    log('[sylvia-bridge] release after', describeElapsed(elapsedMs), `(${count} held)`);
    if (count === 0) {
      paused.clear();
      return;
    }
    const text = buildResumeNotice({ elapsedMs, heldCount: count, reason: sample === null ? 'unknown' : sample.transport === 'none' ? 'offline' : 'metered' });
    const mode = cfg.resumeOnReconnect ? 'followup' : 'inject';
    if (mode === 'followup' || cfg.notifyPausedWork) {
      for (const [agent] of paused) deliver(agent, text, mode);
    }
    paused.clear();
  }

  /** One observation from the daemon: {metered, transport, at} | null (unknown). */
  function onSample(sample) {
    lastSample = sample;
    const want = decide(sample);
    if (want && state === 'run') enterHold(sample);
    else if (!want && state === 'held') exitHold(sample);
  }

  function track(agent) {
    tracked.add(agent);
  }

  function untrack(agent) {
    tracked.delete(agent);
    status.delete(agent);
    pendingFinish.delete(agent);
    paused.delete(agent);
    exempt.delete(agent);
  }

  /** 'agent/status' listener. New work arriving while held is cancelled in
   *  both pause modes (keepInbox is the adapter's cancel concern). */
  function onAgentStatus(agent, next) {
    track(agent);
    status.set(agent, next);
    if (next === 'running' && state === 'held' && !paused.has(agent)) {
      pauseRunning(agent, true);
    }
  }

  /** 'agent/assistant-stream' listener: frames start|chunk|end. */
  function onStreamFrame(agent, frame) {
    track(agent);
    if (frame.type === 'end') {
      activeStream.delete(agent);
      if (state === 'held' && pendingFinish.has(agent)) {
        pendingFinish.delete(agent);
        cancelNow(agent, 'stream committed');
      }
    } else {
      activeStream.add(agent);
      // An already-running agent we only just learned about (loaded mid-turn).
      if (state === 'held' && !paused.has(agent) && status.get(agent) !== 'idle') {
        if (cfg.pauseMode === 'finish-stream') pauseRunning(agent, false);
        else cancelNow(agent, 'immediate');
      }
    }
  }

  function getState() {
    return {
      state,
      holdReason,
      heldSince,
      heldCount: paused.size,
      pendingFinishCount: pendingFinish.size,
      trackedAgents: tracked.size,
      lastSample,
      config: {
        enabled: cfg.enabled,
        onMetered: cfg.onMetered,
        pauseMode: cfg.pauseMode,
        resumeOnReconnect: cfg.resumeOnReconnect,
        notifyPausedWork: cfg.notifyPausedWork,
        onUnknown: cfg.onUnknown,
        allowA2AOnMetered: cfg.allowA2AOnMetered,
      },
    };
  }

  return { onSample, track, untrack, onAgentStatus, onStreamFrame, getState, setExempt, isExempt };
}
