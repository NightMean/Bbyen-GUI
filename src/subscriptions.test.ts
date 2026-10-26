import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import sqlite3 from 'sqlite3'
import * as sqlite from 'sqlite'
import { Config } from './config'
import { updateSubscriptionsFromWhitelistNoApi } from './subscriptions'

vi.mock('axios', () => ({ default: vi.fn().mockResolvedValue({
	data: '<meta property="og:image" content="https://example.com/avatar">',
}) }))

const id = 'UC0000000000000000000000'
const logger = {
	info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as never

describe('whitelist subscription lifecycle', () => {
	let db: sqlite.Database
	beforeEach(async () => {
		db = await sqlite.open({ filename: ':memory:', driver: sqlite3.Database })
		await db.exec(`CREATE TABLE subscriptions (
			id INTEGER PRIMARY KEY, channelId TEXT UNIQUE,
			channelTitle TEXT, channelThumbnail TEXT, deleted INTEGER DEFAULT 0,
			deletedReason TEXT, deletedAt TEXT, firstObservedAt TEXT,
			bellState TEXT, bellUpdatedAt TEXT
		)`)
	})
	afterEach(async () => { await db.close() })

	test('keeps whitelisted terminated records unchanged', async () => {
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,deleted,deletedReason,deletedAt,bellState)
			VALUES (?, 'Creator', 1, 'terminated', '2026-01-01', 'all')`, id)
		const original = await db.get('SELECT * FROM subscriptions')
		await updateSubscriptionsFromWhitelistNoApi({
			db, config: { whitelistedChannelIds: [{ id }] } as Config, logger,
		})
		expect(await db.get('SELECT * FROM subscriptions')).toEqual(original)
	})

	test('preserves termination reason after whitelist removal', async () => {
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,deleted,deletedReason)
			VALUES (?, 'Creator', 1, 'terminated')`, id)
		await updateSubscriptionsFromWhitelistNoApi({
			db, config: { whitelistedChannelIds: [] } as unknown as Config, logger,
		})
		expect((await db.get('SELECT * FROM subscriptions')).deletedReason)
			.toBe('terminated')
	})

	test('marks removed active subscriptions as unsubscribed', async () => {
		await db.run(`INSERT INTO subscriptions (channelId,channelTitle)
			VALUES (?, 'Creator')`, id)
		await updateSubscriptionsFromWhitelistNoApi({
			db, config: { whitelistedChannelIds: [] } as unknown as Config, logger,
		})
		expect(await db.get('SELECT * FROM subscriptions')).toMatchObject({
			deleted: 1, deletedReason: 'unsubscribed',
			deletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		})
	})

	test('preserves observation and bell history when re-added', async () => {
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,deleted,deletedReason,firstObservedAt,bellState)
			VALUES (?, 'Creator', 1, 'unsubscribed', '2026-01-01', 'all')`, id)
		await updateSubscriptionsFromWhitelistNoApi({
			db, config: { whitelistedChannelIds: [{ id }] } as Config, logger,
		})
		expect(await db.get('SELECT * FROM subscriptions')).toMatchObject({
			id: 1, deleted: 0, deletedReason: null,
			firstObservedAt: '2026-01-01', bellState: 'all',
		})
	})

	test('timestamps new channels and tolerates duplicates', async () => {
		await updateSubscriptionsFromWhitelistNoApi({
			db, config: { whitelistedChannelIds: [{ id }, { id }] } as Config, logger,
		})
		const rows = await db.all('SELECT * FROM subscriptions')
		expect(rows).toHaveLength(1)
		expect(rows[0].firstObservedAt).toEqual(expect.any(String))
	})
})
