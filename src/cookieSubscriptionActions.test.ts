import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookieSubscriptionActions } from './cookieSubscriptionActions'
import { RefreshResult } from './refreshResult'
import { initChannelSchema } from './channelSchema'

const id = 'UC0000000000000000000002'
const other = 'UC0000000000000000000003'
const profile = { name: 'Fixture', channelId: 'UC0000000000000000000001',
	pageId: 'fixture-page', selected: false, selectable: true }
const channel = (channelId: string) => ({ channelId, title: 'Channel',
	notificationState: 'all' as const, isAllNotifications: true })
const success: RefreshResult = { status: 'success', total: 1, succeeded: 1,
	failed: 0, skipped: 0, failedChannels: [] }

test('confirms subscribe and unsubscribe on the selected profile', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	let subscribed = false
	const subscribe = vi.fn(async () => { subscribed = true })
	const unsubscribe = vi.fn(async () => { subscribed = false })
	try {
		const generation = await store.activate('SAPISID=synthetic-fixture',
			profile, [channel(other)])
		const sync = async () => {
			await store.refresh(generation,
				subscribed ? [channel(other), channel(id)] : [channel(other)])
			return success
		}
		const actions = new CookieSubscriptionActions(db, config, store, sync,
			{ subscribe, unsubscribe })
		expect(await actions.change(id, true)).toBe('confirmed')
		expect(subscribe).toHaveBeenCalledWith('SAPISID=synthetic-fixture',
			'synthetic-fixture', id, 'fixture-page')
		expect(await actions.change(id, true)).toBe('unchanged')
		expect(await actions.change(id, false)).toBe('confirmed')
		expect(unsubscribe).toHaveBeenCalledTimes(1)
		expect((await db.get('SELECT deleted FROM subscriptions WHERE channelId=?',
			id)).deleted).toBe(1)
	} finally { await db.close() }
})

test('an uncertain subscription request is not silently repeated', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	const subscribe = vi.fn().mockRejectedValue(new Error('lost reply'))
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, [channel(other)])
		const actions = new CookieSubscriptionActions(db, config, store,
			async () => success, { subscribe, unsubscribe: vi.fn() })
		expect(await actions.change(id, true)).toBe('uncertain')
		expect(await actions.change(id, true)).toBe('uncertain')
		expect(subscribe).toHaveBeenCalledTimes(1)
		expect(await actions.review(id)).toEqual({ current: false,
			previousTarget: true })
		await expect(actions.acknowledge(id, true)).rejects.toThrow(/changed/i)
		await actions.acknowledge(id, false)
		const row = await db.get('SELECT state FROM cookie_subscription_actions')
		expect(row.state).toBe('acknowledged')
	} finally { await db.close() }
})

test('undo restores subscription and the previous bell', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie' } as Config
	let subscribed = true
	try {
		const generation = await store.activate('SAPISID=fixture', profile,
			[channel(other), channel(id)])
		const sync = async () => {
			await store.refresh(generation,
				subscribed ? [channel(other), channel(id)] : [channel(other)])
			return success
		}
		const actions = new CookieSubscriptionActions(db, config, store, sync, {
			subscribe: async () => { subscribed = true },
			unsubscribe: async () => { subscribed = false },
		})
		expect(await actions.change(id, false)).toBe('confirmed')
		const restore = vi.fn().mockResolvedValue('confirmed')
		expect(await actions.undo(id, restore)).toEqual({ subscription: 'confirmed',
			bell: 'confirmed' })
		expect(restore).toHaveBeenCalledWith(id, 'all')
		expect(await db.get('SELECT state FROM cookie_unsubscribe_undos'))
			.toEqual({ state: 'completed' })
		await expect(actions.undo(id, restore)).rejects.toThrow(/confirmed/i)
	} finally { await db.close() }
})

test('retains partial undo for review and does not repeat uncertain writes',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie' } as Config
		let subscribed = true
		try {
			const generation = await store.activate('SAPISID=fixture', profile,
				[channel(other), channel(id)])
			const sync = async () => {
				await store.refresh(generation,
					subscribed ? [channel(other), channel(id)] : [channel(other)])
				return success
			}
			const actions = new CookieSubscriptionActions(db, config, store, sync, {
				subscribe: async () => { subscribed = true },
				unsubscribe: async () => { subscribed = false },
			})
			expect(await actions.change(id, false)).toBe('confirmed')
			const restore = vi.fn().mockRejectedValue(new Error('unavailable'))
			expect(await actions.undo(id, restore)).toEqual({
				subscription: 'confirmed', bell: 'unavailable' })
			expect(await db.get('SELECT state FROM cookie_unsubscribe_undos'))
				.toEqual({ state: 'partial' })
			await actions.acknowledgeUndo(id)
			expect(await db.get('SELECT state FROM cookie_unsubscribe_undos'))
				.toEqual({ state: 'acknowledged' })
		} finally { await db.close() }
	})

test('interrupted undo requires unresolved requests to be reviewed',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie' } as Config
		try {
			await store.activate('SAPISID=fixture', profile,
				[channel(other), channel(id)])
			await db.run(`INSERT INTO cookie_unsubscribe_undos
				(id, profileKey, channelId, priorBell, state, startedAt)
				VALUES ('undo', ?, ?, 'all', 'pending', '2026')`,
			profile.channelId, id)
			await db.run(`INSERT INTO cookie_subscription_actions
				(id, profileKey, channelId, target, state, startedAt)
				VALUES ('request', ?, ?, 1, 'uncertain', '2026')`,
			profile.channelId, id)
			const actions = new CookieSubscriptionActions(db, config, store,
				async () => success)
			await expect(actions.change(id, false)).rejects.toThrow(/undo/i)
			await expect(actions.acknowledgeUndo(id)).rejects.toThrow(/review/i)
			await actions.acknowledge(id, true)
			await actions.acknowledgeUndo(id)
			expect(await db.get('SELECT state FROM cookie_unsubscribe_undos'))
				.toEqual({ state: 'acknowledged' })
		} finally { await db.close() }
	})

test('upgrades action history without losing old records', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO cookie_subscription_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES ('old', ?, ?, 0, 'confirmed', '2020')`, profile.channelId, id)
		await db.exec(`ALTER TABLE cookie_subscription_actions
			DROP COLUMN priorBell`)
		await initChannelSchema(db)
		expect(await db.get(`SELECT state, priorBell
			FROM cookie_subscription_actions`))
			.toEqual({ state: 'confirmed', priorBell: null })
	} finally { await db.close() }
})
