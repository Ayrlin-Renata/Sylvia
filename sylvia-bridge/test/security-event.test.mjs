/**
 * Tests for the bridge's security-event forward path (P3.3).
 *
 * The mechanism is the one that needed proving rather than assuming: cordis
 * emits bubble CHILD → ROOT, so an event emitted inside nuncia's own fiber
 * is invisible to a sibling plugin that subscribed on its own child context,
 * but visible to a listener on the ROOT context. The bridge therefore
 * subscribes on `ctx.root`.
 *
 * These tests use a fake context tree that reproduces that shape: a child
 * whose `emit` reaches the root's listeners, and a child-level `on` that is
 * scope-filtered to that child only.
 *
 * Run: node --test test/security-event.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { forwardSecurityEvent, normalizeSecurityEvent } from '../lib/security-event.js'

/**
 * A cordis-shaped context tree.
 *
 * - `root.on` registers a listener that any child's emit reaches.
 * - `child.on` registers a listener scoped to that child: an emit from a
 *   DIFFERENT child does not reach it (this is the scope filter that makes
 *   the root subscription necessary).
 * - `child.emit` bubbles to the root (and to listeners scoped to itself).
 */
function makeContextTree() {
	const rootListeners = new Map()
	const childListeners = new Map()

	const root = {
		on(name, handler) {
			if (!rootListeners.has(name)) rootListeners.set(name, [])
			rootListeners.get(name).push(handler)
		},
		off(name, handler) {
			const list = rootListeners.get(name) ?? []
			const index = list.indexOf(handler)
			if (index >= 0) list.splice(index, 1)
		},
	}

	/**
	 * @param {string} label
	 * @returns {any}
	 */
	function makeChild(label) {
		const own = childListeners.get(label) ?? new Map()
		childListeners.set(label, own)
		return {
			root,
			label,
			on(name, handler) {
				if (!own.has(name)) own.set(name, [])
				own.get(name).push(handler)
			},
			off(name, handler) {
				const list = own.get(name) ?? []
				const index = list.indexOf(handler)
				if (index >= 0) list.splice(index, 1)
			},
			emit(name, payload) {
				for (const handler of rootListeners.get(name) ?? []) handler(payload)
				for (const handler of own.get(name) ?? []) handler(payload)
			},
		}
	}

	return { root, makeChild, rootListeners, childListeners }
}

test('an event emitted on a child reaches a root listener', () => {
	const { makeChild } = makeContextTree()
	const nuncia = makeChild('nuncia')
	const seen = []
	nuncia.root.on('nuncia/security-event', (payload) => seen.push(payload))
	nuncia.emit('nuncia/security-event', { kind: 'authority-rejected', reason: 'signature' })
	assert.equal(seen.length, 1)
	assert.equal(seen[0].kind, 'authority-rejected')
})

test('a sibling child does NOT receive another child\'s emission', () => {
	const { makeChild } = makeContextTree()
	const nuncia = makeChild('nuncia')
	const bridge = makeChild('bridge')
	const seen = []
	bridge.on('nuncia/security-event', (payload) => seen.push(payload))
	nuncia.emit('nuncia/security-event', { kind: 'authority-rejected' })
	assert.equal(seen.length, 0, 'a child-scoped listener must not see a sibling\'s event')
})

test('a security event is forwarded to the daemon', async () => {
	const forwarded = []
	const ok = await forwardSecurityEvent(
		{ daemonUrl: 'http://127.0.0.1:3090' },
		normalizeSecurityEvent({ kind: 'authority-rejected', reason: 'signature', detail: { taskId: 't1' } }),
		{
			fetchImpl: async (url, options) => {
				forwarded.push({ url: String(url), body: JSON.parse(options.body) })
				return { ok: true, status: 202 }
			},
		},
	)
	assert.equal(ok, true)
	assert.equal(forwarded.length, 1)
	assert.equal(forwarded[0].url, 'http://127.0.0.1:3090/api/a2a/event')
	assert.equal(forwarded[0].body.kind, 'authority-rejected')
	assert.equal(forwarded[0].body.reason, 'signature')
	assert.equal(forwarded[0].body.detail.taskId, 't1')
	assert.ok(forwarded[0].body.at, 'the forwarded event carries a timestamp')
})

test('a failed forward is reported, never thrown', async () => {
	const ok = await forwardSecurityEvent(
		{ daemonUrl: 'http://127.0.0.1:3090' },
		normalizeSecurityEvent({ kind: 'authority-rejected' }),
		{ fetchImpl: async () => { throw new Error('daemon not running') } },
	)
	assert.equal(ok, false)
})

test('no daemon URL means no forward', async () => {
	let called = false
	const ok = await forwardSecurityEvent({}, normalizeSecurityEvent({ kind: 'x' }), {
		fetchImpl: async () => { called = true; return { ok: true } },
	})
	assert.equal(ok, false)
	assert.equal(called, false)
})

test('a missing kind is normalized, not dropped', () => {
	const payload = normalizeSecurityEvent({})
	assert.equal(payload.kind, 'authority-event')
	assert.equal(payload.reason, null)
})
