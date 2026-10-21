import test from 'node:test';
import assert from 'node:assert/strict';
import { freshSample, sampleNetwork, expandHome } from '../lib/sample.js';

const CFG = {
  daemonUrl: 'http://127.0.0.1:3090',
  stateFile: '/nonexistent/sylvia/netstate.json',
  staleAfterMs: 60_000,
};
const NOW = 1_000_000_000;

test('freshSample accepts a fresh valid payload', () => {
  const s = freshSample({ metered: true, transport: 'cellular', at: NOW - 5_000 }, 60_000, NOW);
  // The sample carries the daemon's exemption decision (DESIGN §20.5): the
  // bridge honours the daemon's call, so the field travels with the sample.
  assert.deepEqual(s, { metered: true, transport: 'cellular', at: NOW - 5_000, a2aExempt: false });
});

test('freshSample rejects stale / malformed payloads', () => {
  assert.equal(freshSample({ metered: true, at: NOW - 61_000 }, 60_000, NOW), null);
  assert.equal(freshSample({ transport: 'wifi', at: NOW }, 60_000, NOW), null); // no metered
  assert.equal(freshSample({ metered: true }, 60_000, NOW), null); // no at
  assert.equal(freshSample(null, 60_000, NOW), null);
  assert.equal(freshSample('nope', 60_000, NOW), null);
});

test('sampleNetwork prefers the daemon API', async () => {
  const calls = [];
  const deps = {
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ metered: false, transport: 'wifi', at: NOW - 1_000 }) };
    },
    readFileSyncImpl: () => {
      throw new Error('should not read file');
    },
    now: () => NOW,
  };
  const s = await sampleNetwork(CFG, deps);
  assert.deepEqual(s, { metered: false, transport: 'wifi', at: NOW - 1_000, a2aExempt: false });
  assert.equal(calls[0], 'http://127.0.0.1:3090/api/network');
});

test('sampleNetwork falls back to netstate.json when the daemon is down', async () => {
  const deps = {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    readFileSyncImpl: (path) => {
      assert.match(path, /netstate\.json$/);
      return JSON.stringify({ metered: true, transport: 'cellular', at: NOW - 2_000 });
    },
    now: () => NOW,
  };
  const s = await sampleNetwork(CFG, deps);
  assert.deepEqual(s, { metered: true, transport: 'cellular', at: NOW - 2_000, a2aExempt: false });
});

test('sampleNetwork returns null when both sources fail', async () => {
  const deps = {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    readFileSyncImpl: () => {
      throw new Error('ENOENT');
    },
    now: () => NOW,
  };
  assert.equal(await sampleNetwork(CFG, deps), null);
});

test('sampleNetwork treats a stale daemon payload as unknown (tries file)', async () => {
  const deps = {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ metered: true, at: NOW - 5 * 60_000 }),
    }),
    readFileSyncImpl: () => {
      throw new Error('ENOENT');
    },
    now: () => NOW,
  };
  assert.equal(await sampleNetwork(CFG, deps), null);
});

test('expandHome resolves ~/ prefixes', () => {
  assert.notEqual(expandHome('~/x/y.json'), '~/x/y.json');
  assert.equal(expandHome('/abs/path.json'), '/abs/path.json');
});
