import { expect, test, vi } from 'vitest'
import { init } from './database'
import { reconcileCookieSnapshot } from './cookieReconciliation'
import { ChannelAddedAlerts } from './channelAddedAlerts'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const third = 'UC0000000000000000000003'
const channel = (id: string, state: 'all' | 'personalized') => ({
	channelId: id, title: id, notificationState: state,
	isAllNotifications: state === 'all',
})

test('groups newly monitored cookie channels and skips profile switch effects',
	async () => {
		const db = await init({ filename: ':memory:' })
		const send = vi.fn().mockResolvedValue(undefined)
		const alerts = new ChannelAddedAlerts(db, async () => send, () => undefined)
		try {
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				activateProfile: true, suppressNotifications: true,
				channels: [channel(first, 'all'), channel(second, 'personalized')] })
			expect(await db.all('SELECT * FROM channel_added_batches')).toEqual([])
			const changed = { profileKey: 'profile', complete: true,
				channels: [channel(first, 'all'), channel(second, 'all'),
					channel(third, 'all')] }
			await reconcileCookieSnapshot(db, changed)
			await reconcileCookieSnapshot(db, changed)
			expect(await db.all('SELECT * FROM channel_added_batches'))
				.toHaveLength(1)
			expect(await db.all('SELECT * FROM channel_added_events')).toHaveLength(2)
			await alerts.run(true); await alerts.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			expect(send.mock.calls[0][0].map((item: { channelId: string }) =>
				item.channelId)).toEqual([second, third])
			expect((await db.get('SELECT emailState FROM channel_added_batches'))
				.emailState).toBe('sent')
		} finally { await db.close() }
	})

test('does not replay uncertain batches and suppresses disabled alerts',
	async () => {
		const db = await init({ filename: ':memory:' })
		const send = vi.fn().mockRejectedValue(new Error('lost reply'))
		const alerts = new ChannelAddedAlerts(db, async () => send, () => undefined)
		try {
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				activateProfile: true, channels: [channel(first, 'all')] })
			await alerts.run(true); await alerts.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			expect((await db.get('SELECT emailState FROM channel_added_batches'))
				.emailState).toBe('uncertain')
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				channels: [channel(first, 'all'), channel(second, 'all')] })
			await alerts.run(false)
			expect(await db.all(`SELECT emailState FROM channel_added_batches
				ORDER BY observedAt, rowid`)).toEqual([
				{ emailState: 'uncertain' }, { emailState: 'suppressed' },
			])
		} finally { await db.close() }
	})
