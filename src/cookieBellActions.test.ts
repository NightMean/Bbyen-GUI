import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookieBellActions } from './cookieBellActions'
import { RefreshResult } from './refreshResult'

const id = 'UC0000000000000000000002'
const profile = { name: 'Fixture', channelId: 'UC0000000000000000000001',
	pageId: 'fixture-page', selected: false, selectable: true }
const channel = (state: 'all' | 'personalized' | 'none') => ({
	channelId: id, title: 'Channel', notificationState: state,
	isAllNotifications: state === 'all',
})
const success: RefreshResult = { status: 'success', total: 1, succeeded: 1,
	failed: 0, skipped: 0, failedChannels: [] }
const failure: RefreshResult = { ...success, status: 'failed' }

test('confirms a delegated bell change after a fresh snapshot', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	let current: 'all' | 'personalized' = 'all'
	const mutate = vi.fn(async () => { current = 'personalized' })
	try {
		const generation = await store.activate('SAPISID=synthetic-fixture',
			profile, [channel('all')])
		const sync = async () => {
			await store.refresh(generation, [channel(current)])
			return success
		}
		const actions = new CookieBellActions(db, config, store, sync, mutate,
			async () => 'fixture-action')
		expect(await actions.change(id, 'personalized')).toBe('confirmed')
		expect(mutate).toHaveBeenCalledWith('SAPISID=synthetic-fixture',
			'synthetic-fixture', id, 'personalized', 'fixture-page', 'fixture-action')
		expect((await db.get('SELECT deleted FROM subscriptions')).deleted).toBe(1)
		expect(await actions.change(id, 'personalized')).toBe('unchanged')
		expect(mutate).toHaveBeenCalledTimes(1)
	} finally { await db.close() }
})

test('does not repeat an unconfirmed request', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	const mutate = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
	let calls = 0
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, [channel('all')])
		const actions = new CookieBellActions(db, config, store, async () => {
			calls++
			return calls === 2 ? failure : success
		}, mutate, async () => 'fixture-action')
		expect(await actions.change(id, 'personalized')).toBe('uncertain')
		expect(await actions.change(id, 'personalized')).toBe('uncertain')
		expect(mutate).toHaveBeenCalledTimes(1)
		expect((await db.get('SELECT state FROM cookie_bell_actions')).state)
			.toBe('uncertain')
	} finally { await db.close() }
})

test('reviews an interrupted request before another change', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	const mutate = vi.fn()
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, [channel('all')])
		await db.run(`INSERT INTO cookie_bell_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES ('interrupted', ?, ?, 'personalized', 'pending', '2026-01-01')`,
		profile.channelId, id)
		const actions = new CookieBellActions(db, config, store,
			async () => success, mutate)
		expect(await actions.review(id)).toEqual({ current: 'all',
			previousTarget: 'personalized' })
		await expect(actions.acknowledge(id, 'none')).rejects.toThrow(/changed/i)
		expect(await actions.change(id, 'personalized')).toBe('uncertain')
		await actions.acknowledge(id, 'all')
		expect((await db.get('SELECT state FROM cookie_bell_actions')).state)
			.toBe('acknowledged')
		expect(mutate).not.toHaveBeenCalled()
	} finally { await db.close() }
})

test('does not send a bell mutation without an offered action', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	const mutate = vi.fn()
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, [channel('all')])
		const actions = new CookieBellActions(db, config, store,
			async () => success, mutate, async () => {
				throw new Error('YouTube did not offer this bell action.')
			})
		await expect(actions.change(id, 'personalized')).rejects.toThrow(/action/i)
		expect(mutate).not.toHaveBeenCalled()
		expect(await db.get('SELECT COUNT(*) AS count FROM cookie_bell_actions'))
			.toEqual({ count: 0 })
	} finally { await db.close() }
})

test('allows a known target when other channels are unknown', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	let current: 'all' | 'personalized' = 'all'
	try {
		const generation = await store.activate('SAPISID=fixture', profile,
			[channel('all')])
		const actions = new CookieBellActions(db, config, store, async () => {
			await store.refresh(generation, [channel(current)])
			return { ...success, status: 'partial',
				failedChannels: ['UC0000000000000000000003'] }
		}, async () => { current = 'personalized' }, async () => 'fixture-action')
		expect(await actions.change(id, 'personalized')).toBe('confirmed')
	} finally { await db.close() }
})

test('does not send an action after cookie renewal', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	const mutate = vi.fn()
	try {
		await store.activate('SAPISID=old-fixture', profile, [channel('all')])
		const actions = new CookieBellActions(db, config, store,
			async () => success, mutate, async () => {
				await store.activate('SAPISID=new-fixture', profile, [channel('all')])
				return 'fixture-action'
			})
		await expect(actions.change(id, 'personalized')).rejects.toThrow(/changed/i)
		expect(mutate).not.toHaveBeenCalled()
		expect(await db.get('SELECT COUNT(*) AS count FROM cookie_bell_actions'))
			.toEqual({ count: 0 })
	} finally { await db.close() }
})
