import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { ApiSubscriptionActions } from './apiSubscriptionActions'

vi.mock('./lib/logger', () => ({ default: async () => ({
	verbose: () => undefined, info: () => undefined, debug: () => undefined,
}) }))

const profile = 'UC0000000000000000000000'
const channel = 'UCabcdefghijklmnopqrstuv'
const manageScope = 'https://www.googleapis.com/auth/youtube'

const fixture = async () => {
	const db = await init({ filename: ':memory:' })
	let subscribed = true
	let revision = 'first'
	const auth = {
		getAccessToken: vi.fn().mockResolvedValue({ token: 'fixture' }),
		getTokenInfo: vi.fn().mockResolvedValue({ scopes: [manageScope] }) }
	const list = vi.fn().mockImplementation(async () => ({ data: {
		items: subscribed ? [{ id: 'subscription-fixture', snippet: {
			resourceId: { channelId: channel },
		} }] : [],
	} }))
	const remove = vi.fn().mockImplementation(async () => { subscribed = false })
	const insert = vi.fn().mockImplementation(async () => { subscribed = true })
	const service = { channels: { list: vi.fn().mockResolvedValue({ data: {
		items: [{ id: profile }],
	} }) }, subscriptions: { list, delete: remove, insert } }
	const actions = new ApiSubscriptionActions(db, { mode: 'youtube' } as Config,
		service as never, async () => auth as never, async () => revision)
	return { db, actions, auth, remove, insert, list,
		setRevision: (value: string) => { revision = value },
		setSubscribed: (value: boolean) => { subscribed = value } }
}

test('unsubscribes and restores a confirmed subscription without replay',
	async () => {
		const f = await fixture()
		try {
			expect(await f.actions.unsubscribe(channel)).toBe('confirmed')
			expect(f.remove).toHaveBeenCalledTimes(1)
			expect(f.remove.mock.calls[0][1]).toMatchObject({ retry: false })
			expect(f.remove.mock.calls[0][0].auth.credentials.refresh_token)
				.toBeUndefined()
			expect(await f.actions.undo(channel)).toBe('confirmed')
			expect(f.insert).toHaveBeenCalledTimes(1)
			expect((await f.actions.review(channel)).current).toBe(true)
		} finally { await f.db.close() }
	})

test('does not replay an uncertain write and requires explicit review',
	async () => {
		const f = await fixture()
		try {
			f.remove.mockRejectedValue(new Error('lost acknowledgement'))
			expect(await f.actions.unsubscribe(channel)).toBe('uncertain')
			expect(await f.actions.unsubscribe(channel)).toBe('uncertain')
			expect(f.remove).toHaveBeenCalledTimes(1)
			expect(await f.actions.review(channel)).toEqual({
				current: true, previousTarget: false,
			})
			await f.actions.acknowledge(channel, true)
			expect((await f.actions.review(channel)).previousTarget).toBeNull()
		} finally { await f.db.close() }
	})

test('confirms a lost acknowledgement when YouTube shows the change',
	async () => {
		const f = await fixture()
		try {
			f.remove.mockImplementationOnce(async () => {
				f.setSubscribed(false)
				throw new Error('lost acknowledgement')
			})
			expect(await f.actions.unsubscribe(channel)).toBe('confirmed')
			expect(f.remove).toHaveBeenCalledTimes(1)
		} finally { await f.db.close() }
	})

test('rejects read-only access and notices replacement during a write',
	async () => {
		const f = await fixture()
		try {
			f.auth.getTokenInfo.mockResolvedValueOnce({
				scopes: [manageScope + '.readonly'],
			})
			await expect(f.actions.unsubscribe(channel)).rejects.toThrow(/management/)
			expect(f.remove).not.toHaveBeenCalled()
			f.remove.mockImplementationOnce(async () => {
				f.setSubscribed(false); f.setRevision('second')
			})
			expect(await f.actions.unsubscribe(channel)).toBe('uncertain')
		} finally { await f.db.close() }
	})
