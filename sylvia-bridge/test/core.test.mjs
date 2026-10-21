import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeCore, describeElapsed, buildResumeNotice, DEFAULT_CONFIG } from '../lib/core.js';

function harness(overrides = {}, cfg = {}) {
  const events = { cancels: [], delivers: [] };
  let clock = 1_000_000;
  const core = createBridgeCore({ ...DEFAULT_CONFIG, ...cfg }, {
    now: () => clock,
    cancel: (agent, reason) => events.cancels.push({ agent, reason }),
    deliver: (agent, text, mode) => events.delivers.push({ agent, text, mode }),
    log: () => {},
    ...overrides,
  });
  return { core, events, tick: (ms = 1000) => { clock += ms; }, clock: () => clock };
}

const UNMETERED = { metered: false, transport: 'wifi', at: 0 };
const METERED = { metered: true, transport: 'cellular', at: 0 };
const OFFLINE = { metered: true, transport: 'none', at: 0 };

test('describeElapsed formats', () => {
  assert.equal(describeElapsed(42_000), '42s');
  assert.equal(describeElapsed(303_000), '5m 3s');
  assert.equal(describeElapsed(7_620_000), '2h 7m');
  assert.equal(describeElapsed(0), '0s');
});

test('buildResumeNotice names cause, duration, held count', () => {
  const text = buildResumeNotice({ elapsedMs: 303_000, heldCount: 2, reason: 'metered' });
  assert.match(text, /metered data for 5m 3s/);
  assert.match(text, /2 held task\(s\)/);
  assert.match(text, /NOT resumed automatically/);
  assert.match(text, /5m 3s elapsed while paused/);
});

test('metered transition holds; running agent cancelled', () => {
  const { core, events } = harness();
  const agent = { id: 'a1' };
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onSample(UNMETERED);
  core.onSample(METERED);
  assert.equal(core.getState().state, 'held');
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].agent, agent);
  assert.match(events.cancels[0].reason, /sylvia-netgate: metered/);
});

test('immediate mode cancels at hold even with live stream', () => {
  const { core, events } = harness({}, { pauseMode: 'immediate' });
  const agent = { id: 'a1' };
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onStreamFrame(agent, { type: 'start' });
  core.onSample(METERED);
  assert.equal(events.cancels.length, 1);
});

test('finish-stream: live stream waits for end frame, then cancels', () => {
  const { core, events } = harness();
  const agent = { id: 'a1' };
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onStreamFrame(agent, { type: 'start' });
  core.onSample(METERED); // holds — but does not cancel yet
  assert.equal(events.cancels.length, 0);
  assert.equal(core.getState().state, 'held');
  core.onStreamFrame(agent, { type: 'chunk' });
  assert.equal(events.cancels.length, 0);
  core.onStreamFrame(agent, { type: 'end', outcome: { kind: 'committed' } });
  assert.equal(events.cancels.length, 1);
  assert.match(events.cancels[0].reason, /stream committed/);
});

test('finish-stream: running with no live stream cancels at hold', () => {
  const { core, events } = harness();
  const agent = { id: 'a1' };
  core.track(agent);
  core.onAgentStatus(agent, 'running'); // no frames — mid-tool
  core.onSample(METERED);
  assert.equal(events.cancels.length, 1);
});

test('new work while held is cancelled in both pause modes', () => {
  for (const pauseMode of ['finish-stream', 'immediate']) {
    const { core, events } = harness({}, { pauseMode });
    const a = { id: pauseMode };
    core.onSample(METERED); // hold first, no agents yet
    core.track(a);
    core.onAgentStatus(a, 'running'); // wake arrives while held
    assert.equal(events.cancels.length, 1, pauseMode);
    assert.match(events.cancels[0].reason, /new work while paused/);
  }
});

test('release with resumeOnReconnect=false injects notice, never followup', () => {
  const { core, events, tick } = harness();
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample(METERED);
  tick(120_000);
  core.onSample(UNMETERED);
  assert.equal(core.getState().state, 'run');
  assert.equal(events.delivers.length, 1);
  assert.equal(events.delivers[0].mode, 'inject');
  assert.match(events.delivers[0].text, /2m 0s/);
  assert.match(events.delivers[0].text, /1 held task\(s\)/);
});

test('resumeOnReconnect=true releases via followup', () => {
  const { core, events } = harness({}, { resumeOnReconnect: true });
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample(METERED);
  core.onSample(UNMETERED);
  assert.equal(events.delivers.length, 1);
  assert.equal(events.delivers[0].mode, 'followup');
});

test('notifyPausedWork=false + resume=false delivers nothing on release', () => {
  const { core, events } = harness({}, { notifyPausedWork: false });
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample(METERED);
  core.onSample(UNMETERED);
  assert.equal(events.delivers.length, 0);
  assert.equal(core.getState().heldCount, 0);
});

test('no running agents at release => no notice', () => {
  const { core, events } = harness();
  core.onSample(METERED);
  core.onSample(UNMETERED);
  assert.equal(events.delivers.length, 0);
});

test('unknown sample with onUnknown=allow does not hold, but releases a held gate', () => {
  const { core, events } = harness();
  core.onSample(null);
  assert.equal(core.getState().state, 'run');
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample(METERED);
  assert.equal(core.getState().state, 'held');
  core.onSample(null); // daemon died while held — desktop-safe default releases
  assert.equal(core.getState().state, 'run');
  assert.equal(events.delivers.length, 1); // pause context still delivered
});

test('unknown sample with onUnknown=pause holds', () => {
  const { core } = harness({}, { onUnknown: 'pause' });
  core.onSample(null);
  assert.equal(core.getState().state, 'held');
});

test('transport none (offline) holds even when metered=false', () => {
  const { core, events } = harness();
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample({ metered: false, transport: 'none', at: 0 });
  assert.equal(core.getState().state, 'held');
  assert.equal(events.cancels.length, 1);
  assert.match(events.cancels[0].reason, /offline/);
});

test('enabled=false and onMetered=allow never hold', () => {
  for (const cfg of [{ enabled: false }, { onMetered: 'allow' }]) {
    const { core } = harness({}, cfg);
    core.onSample(METERED);
    assert.equal(core.getState().state, 'run', JSON.stringify(cfg));
  }
});

test('disposed agent leaves the held set (no crash, no delivery)', () => {
  const { core, events } = harness();
  const a = { id: 'a1' };
  core.track(a);
  core.onAgentStatus(a, 'running');
  core.onSample(METERED);
  core.untrack(a);
  core.onSample(UNMETERED);
  assert.equal(events.delivers.length, 0);
  assert.equal(core.getState().heldCount, 0);
});

// -- P3.1: the metered exemption for A2A sessions (DESIGN §20.12) ---------------

/** An agent shaped like nuncia's: the A2A tag rides the SESSION ID.
 *  (The v4 session header accepts only `origin: "subagent"`, so the id is the
 *  only durable carrier — DESIGN §20.12 P3.1.) */
function a2aAgent(id, level = 'peer') {
  const sessionId = `a2a-op-${level}-${id}`;
  return { id: sessionId, session: { id: sessionId, header: { id: sessionId } } };
}

test('A2A session is cancelled with the gate when the exemption is off', () => {
  const { core, events } = harness();
  const agent = a2aAgent('op-1');
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onSample(METERED);
  assert.equal(core.getState().state, 'held');
  assert.equal(events.cancels.length, 1, 'default is fail-closed: no exemption');
});

test('A2A session keeps running when the exemption is on', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: true });
  const agent = a2aAgent('op-1');
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onSample(METERED);
  assert.equal(core.getState().state, 'held', 'the gate is still held for everything else');
  assert.equal(events.cancels.length, 0, 'the A2A session was not cancelled');
  assert.equal(core.isExempt(agent), true);
});

test('new work on an exempt A2A session is not cancelled while held', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: true });
  const agent = a2aAgent('op-2', 'intent');
  core.track(agent);
  core.onSample(METERED);
  core.onAgentStatus(agent, 'running');
  assert.equal(events.cancels.length, 0);
});

test('a non-A2A session is still cancelled while an A2A one is exempt', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: true });
  const peer = { id: 'plain' };
  const operator = a2aAgent('op-3');
  core.track(peer);
  core.track(operator);
  core.onAgentStatus(peer, 'running');
  core.onAgentStatus(operator, 'running');
  core.onSample(METERED);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].agent, peer);
});

test('an explicitly exempted agent is exempt even without the a2a tag', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: true });
  const agent = { id: 'manual' };
  core.track(agent);
  core.setExempt(agent, true);
  core.onAgentStatus(agent, 'running');
  core.onSample(METERED);
  assert.equal(events.cancels.length, 0);
  core.untrack(agent);
  assert.equal(core.isExempt(agent), false, 'untracking drops the exemption');
});

test('the exemption requires the flag: setExempt alone does not exempt', () => {
  const { core, events } = harness();
  const agent = a2aAgent('op-4');
  core.track(agent);
  core.setExempt(agent, true);
  core.onAgentStatus(agent, 'running');
  core.onSample(METERED);
  assert.equal(events.cancels.length, 1);
});

test('the chatelaine session is recognised as A2A by its id', () => {
  const { core } = harness({}, { allowA2AOnMetered: true });
  const id = 'a2a-chatelaine-8f1c0a6e-1b2c-4d5e-9f10-223344556677';
  const agent = { id, session: { id, header: { id } } };
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onSample(METERED);
  assert.equal(core.isExempt(agent), true);
});

// -- the daemon's exemption decision (DESIGN §20.5) ---------------------------

test('the daemon exemption exempts an A2A session even when the local flag is off', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: false });
  const agent = a2aAgent('op-daemon');
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  // The daemon says the A2A listener stays up; that rides the sample.
  core.onSample({ metered: true, transport: 'cellular', at: Date.now(), a2aExempt: true });
  assert.equal(events.cancels.length, 0, 'the daemon exemption is honoured');
});

test('the daemon exemption never exempts an ordinary session', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: false });
  const peer = { id: 'plain' };
  core.track(peer);
  core.onAgentStatus(peer, 'running');
  core.onSample({ metered: true, transport: 'cellular', at: Date.now(), a2aExempt: true });
  assert.equal(events.cancels.length, 1, 'only A2A sessions are exempt');
});

test('without the daemon exemption the local flag alone decides', () => {
  const { core, events } = harness({}, { allowA2AOnMetered: false });
  const agent = a2aAgent('op-plain');
  core.track(agent);
  core.onAgentStatus(agent, 'running');
  core.onSample({ metered: true, transport: 'cellular', at: Date.now(), a2aExempt: false });
  assert.equal(events.cancels.length, 1, 'fail-closed by default');
});
