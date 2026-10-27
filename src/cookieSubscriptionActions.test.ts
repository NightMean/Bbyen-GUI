import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookieSubscriptionActions } from './cookieSubscriptionActions'
import { RefreshResult } from './refreshResult'

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
