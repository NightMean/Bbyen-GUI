import { expect, test } from 'vitest'
import { init } from './database'
import { reconcileCookieSnapshot } from './cookieReconciliation'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const channel = (
	channelId: string, state: 'all' | 'personalized' | 'unknown',
) =>
	({ channelId, title: channelId, notificationState: state,
		isAllNotifications: state === 'all' })

test('complete cookie snapshots control monitoring and preserve unknown state',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				activateProfile: true, channels: [channel(first, 'all'),
					channel(second, 'personalized')] })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0`)).toEqual([{ channelId: first }])
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				channels: [channel(first, 'unknown'), channel(second, 'all')] })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0 ORDER BY channelId`)).toEqual([
				{ channelId: first }, { channelId: second },
			])
			expect(await db.get(`SELECT lastConfirmedBell, latestBell
				FROM cookie_channel_state WHERE channelId=?`, first)).toEqual({
				lastConfirmedBell: 'all', latestBell: 'unknown',
			})
			await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
				channels: [channel(second, 'personalized')] })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0`))
				.toEqual([])
		} finally { await db.close() }
	})

test('incomplete snapshots and unconfirmed profile switches preserve state',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await reconcileCookieSnapshot(db, { profileKey: 'one', complete: true,
				activateProfile: true, channels: [channel(first, 'all')] })
			await expect(reconcileCookieSnapshot(db, { profileKey: 'one',
				complete: false, channels: [] })).rejects.toThrow('incomplete')
			await expect(reconcileCookieSnapshot(db, { profileKey: 'two',
				complete: true, channels: [] })).rejects.toThrow('Confirm')
			expect(await db.get('SELECT deleted FROM subscriptions'))
				.toEqual({ deleted: 0 })
		} finally { await db.close() }
	})

test('terminated channels stay terminated when observed with All', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail, deleted, deletedReason)
			VALUES (?, 'Creator', 'image', 1, 'terminated')`, first)
		await reconcileCookieSnapshot(db, { profileKey: 'profile', complete: true,
			activateProfile: true, channels: [channel(first, 'all')] })
		expect(await db.get('SELECT deleted, deletedReason FROM subscriptions'))
			.toEqual({ deleted: 1, deletedReason: 'terminated' })
	} finally { await db.close() }
})

test('records meaningful changes once and allows confirmed profile switches',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			const initial = { profileKey: 'one', complete: true,
				activateProfile: true, channels: [channel(first, 'all')] }
			await reconcileCookieSnapshot(db, initial)
			await reconcileCookieSnapshot(db, initial)
			await reconcileCookieSnapshot(db, { ...initial,
				channels: [channel(first, 'personalized')] })
			expect(await db.all(`SELECT previousState, currentState
				FROM cookie_channel_events ORDER BY id`)).toEqual([
				{ previousState: null, currentState: 'all' },
				{ previousState: 'all', currentState: 'personalized' },
			])
			await reconcileCookieSnapshot(db, { profileKey: 'two', complete: true,
				activateProfile: true, channels: [channel(second, 'all')] })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0`))
				.toEqual([{ channelId: second }])
			expect(await db.get(`SELECT notifyEligible FROM cookie_channel_events
				WHERE profileKey='two'`)).toEqual({ notifyEligible: 0 })
		} finally { await db.close() }
	})

test('a database failure rolls back the complete cookie snapshot', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await reconcileCookieSnapshot(db, { profileKey: 'one', complete: true,
			activateProfile: true, channels: [channel(first, 'all')] })
		await db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON subscriptions
			WHEN NEW.channelId='${second}'
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		await expect(reconcileCookieSnapshot(db, {
			profileKey: 'one', complete: true,
			channels: [channel(first, 'personalized'), channel(second, 'all')],
		}))
			.rejects.toThrow('fixture failure')
		expect(await db.get(`SELECT deleted, bellState FROM subscriptions
			WHERE channelId=?`, first)).toEqual({ deleted: 0, bellState: 'all' })
		expect(await db.get('SELECT COUNT(*) AS count FROM cookie_channel_events'))
			.toEqual({ count: 1 })
	} finally { await db.close() }
})
