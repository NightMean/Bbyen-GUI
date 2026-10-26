import { afterEach, expect, test, vi } from 'vitest'
import RSSParser from 'rss-parser'
import { init } from './database'
import { Config } from './config'
import {
	updateSubscriptions, updateSubscriptionsFromAPI,
} from './subscriptions'
import { parseFeedsAndNotify } from './videos'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), debug: vi.fn(),
	warn: vi.fn(), error: vi.fn(),
}) }))

const allowed = 'UC0000000000000000000001'
const other = 'UC0000000000000000000002'
const subscription = (id: string) => ({ snippet: {
	title: id, resourceId: { channelId: id },
	thumbnails: { high: { url: 'img' } },
} })

afterEach(() => vi.restoreAllMocks())

test('API discovery retains all subscriptions and applies allowlist email',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
				whitelistedChannelIds: [{ id: allowed }], blacklistedChannelIds: [],
				notifyOnFirstScan: true,
				logging: { emailOnError: false } } as unknown as Config
			const service = {
				subscriptions: { list: vi.fn().mockResolvedValue({ data: {
					items: [subscription(allowed), subscription(other)],
				} }) },
				videos: { list: vi.fn().mockImplementation(async ({ id }) => ({
					data: { items: [{ snippet: { title: id,
						publishedAt: '2026-01-01T00:00:00Z', channelTitle: 'Creator',
						thumbnails: { high: { url: 'image' } } },
					contentDetails: { duration: 'PT1M' } }] },
				})) },
			} as never
			const auth = {} as never
			const sendVideoEmail = vi.fn().mockResolvedValue(undefined)
			const sendErrorEmail = vi.fn()
			await updateSubscriptions({ db, config, service, auth,
				sendErrorEmail })
			expect(await db.get('SELECT COUNT(*) AS count FROM subscriptions'))
				.toEqual({ count: 2 })
			vi.spyOn(RSSParser.prototype, 'parseURL').mockImplementation(
				async url => ({ items: [{ videoId: String(url).includes(allowed)
					? 'allowed-video' : 'other-video' }] }) as never)
			await parseFeedsAndNotify({ db, config, service, auth,
				sendVideoEmail, sendErrorEmail })
			expect(sendVideoEmail.mock.calls.map(call => call[0].videoId))
				.toEqual(['allowed-video'])
			expect(await db.get(`SELECT emailOutcome FROM video_observations
				WHERE videoId='other-video'`)).toEqual({ emailOutcome: 'excluded' })
		} finally { await db.close() }
	})

test('incomplete API snapshots do not remove existing channels', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, ?, 'img')`,
		allowed, allowed)
		const service = { subscriptions: { list: vi.fn().mockResolvedValue({
			data: { items: [{ snippet: { title: 'missing ID' } }] },
		}) } } as never
		const config = {
			mode: 'youtube', emailSelectionPolicy: 'allowlist',
		} as Config
		await expect(updateSubscriptionsFromAPI({ db, config, service,
			auth: {} as never, sendErrorEmail: vi.fn() })).rejects.toThrow()
		expect(await db.get('SELECT deleted FROM subscriptions')).toEqual({
			deleted: 0,
		})
	} finally { await db.close() }
})

test('subscription refresh reports API failures to its caller', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const service = { subscriptions: { list: vi.fn()
			.mockRejectedValue(new Error('invalid_grant')) } } as never
		const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
			logging: { emailOnError: false } } as unknown as Config
		const result = await updateSubscriptions({ db, config, service,
			auth: {} as never, sendErrorEmail: vi.fn() })
		expect(result).toMatchObject({ status: 'failed', errorCategory: 'auth' })
	} finally { await db.close() }
})

test('repeated API page tokens preserve the previous snapshot', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, ?, 'img')`,
		allowed, allowed)
		const service = { subscriptions: { list: vi.fn().mockResolvedValue({
			data: { items: [subscription(other)], nextPageToken: 'repeat' },
		}) } } as never
		const config = {
			mode: 'youtube', emailSelectionPolicy: 'allowlist',
		} as Config
		await expect(updateSubscriptionsFromAPI({ db, config, service,
			auth: {} as never, sendErrorEmail: vi.fn() })).rejects.toThrow('Repeated')
		expect(await db.all('SELECT channelId, deleted FROM subscriptions'))
			.toEqual([{ channelId: allowed, deleted: 0 }])
	} finally { await db.close() }
})

test('a failed reconciliation rolls back additions and removals', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, ?, 'img')`,
		allowed, allowed)
		await db.run(`INSERT INTO channel_sources (channelId, apiSubscribed, manual)
			VALUES (?, 1, 1)`, allowed)
		await db.exec(`CREATE TRIGGER reject_removal BEFORE UPDATE ON subscriptions
			WHEN NEW.deleted = 1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		const service = { subscriptions: { list: vi.fn().mockResolvedValue({
			data: { items: [subscription(other)] },
		}) } } as never
		const config = {
			mode: 'youtube', emailSelectionPolicy: 'allowlist',
		} as Config
		await expect(updateSubscriptionsFromAPI({ db, config, service,
			auth: {} as never, sendErrorEmail: vi.fn() })).rejects.toThrow()
		expect(await db.all('SELECT channelId, deleted FROM subscriptions'))
			.toEqual([{ channelId: allowed, deleted: 0 }])
		expect(await db.all(`SELECT channelId, apiSubscribed, manual
			FROM channel_sources`)).toEqual([
			{ channelId: allowed, apiSubscribed: 1, manual: 1 },
		])
	} finally { await db.close() }
})

test('manual-only channels remain tracked and eligible after API refresh',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
				whitelistedChannelIds: [], blacklistedChannelIds: [],
				manualChannelIds: [{ id: other }], notifyOnFirstScan: true,
				logging: { emailOnError: false } } as unknown as Config
			const list = vi.fn().mockResolvedValue({ data: {
				items: [subscription(allowed)],
			} })
			const service = {
				subscriptions: { list },
				videos: { list: vi.fn().mockResolvedValue({ data: { items: [{
					snippet: { title: 'Video', channelTitle: 'Creator',
						publishedAt: '2026-01-01T00:00:00Z',
						thumbnails: { high: { url: 'image' } } },
					contentDetails: { duration: 'PT1M' },
				}] } }) },
			} as never
			const auth = {} as never
			const sendErrorEmail = vi.fn()
			const sendVideoEmail = vi.fn().mockResolvedValue(undefined)
			await updateSubscriptions({ db, config, service, auth, sendErrorEmail })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0 ORDER BY channelId`)).toEqual([
				{ channelId: allowed }, { channelId: other },
			])
			vi.spyOn(RSSParser.prototype, 'parseURL').mockImplementation(
				async url => ({ items: [{ videoId: String(url).includes(allowed)
					? 'account-video' : 'manual-video' }] }) as never)
			await parseFeedsAndNotify({ db, config, service, auth,
				sendVideoEmail, sendErrorEmail })
			expect(sendVideoEmail.mock.calls.map(call => call[0].videoId))
				.toEqual(['manual-video'])
			list.mockResolvedValue({ data: { items: [] } })
			await updateSubscriptions({ db, config, service, auth, sendErrorEmail })
			expect(await db.all(`SELECT channelId FROM subscriptions
				WHERE deleted=0`)).toEqual([{ channelId: other }])
			expect(await db.get(`SELECT apiSubscribed, manual FROM channel_sources
				WHERE channelId=?`, other)).toEqual({ apiSubscribed: 0, manual: 1 })
		} finally { await db.close() }
	})
