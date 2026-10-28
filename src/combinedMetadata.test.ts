import { expect, test, vi } from 'vitest'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import { refreshCombinedMetadata } from './combinedMetadata'

vi.mock('./lib/logger', () => ({
	default: async () => ({ verbose: () => {} }),
}))
const profileId = 'UC0000000000000000000001'
const channelId = 'UC0000000000000000000002'
const profile = { name: 'Profile', channelId: profileId, selected: true,
	selectable: true }

test('adds API dates and thumbnails without changing cookie bell eligibility',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		try {
			await store.activate('SAPISID=synthetic-fixture', profile, [{ channelId,
				title: 'Channel', notificationState: 'personalized',
				isAllNotifications: false }])
			const service = { channels: { list: async () => ({ data: { items: [
				{ id: profileId },
			] } }) }, subscriptions: { list: async () => ({ data: { items: [
				{ id: 'subscription-fixture', snippet: { resourceId: { channelId },
					publishedAt: '2020-01-02T03:04:05Z',
					thumbnails: { high: { url: 'https://i.ytimg.com/a' } } } },
			] } }) } } as never
			const result = await refreshCombinedMetadata({ db, store, service,
				auth: {} as never, revision: async () => 'stable' })
			expect(result).toEqual({ matched: 1, total: 1 })
			expect(await db.get('SELECT deleted, bellState, channelThumbnail ' +
				'FROM subscriptions WHERE channelId=?', channelId)).toEqual({
				deleted: 1, bellState: 'personalized',
				channelThumbnail: 'https://i.ytimg.com/a' })
			expect(await db.get('SELECT subscribedAt FROM ' +
				'combined_subscription_metadata ' +
				'WHERE channelId=?', channelId)).toEqual({
				subscribedAt: '2020-01-02T03:04:05.000Z' })
		} finally { await db.close() }
	})

test('rejects another API profile before saving metadata', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, [{ channelId,
			title: 'Channel', notificationState: 'all', isAllNotifications: true }])
		const service = { channels: { list: async () => ({ data: { items: [
			{ id: channelId },
		] } }) } } as never
		await expect(refreshCombinedMetadata({ db, store, service,
			auth: {} as never, revision: async () => 'stable' })).rejects.toThrow()
		expect(await db.all('SELECT * FROM channel_sources')).toEqual([])
	} finally { await db.close() }
})
