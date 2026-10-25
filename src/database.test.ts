import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import SQL from 'sql-template-strings'
import fs from 'fs/promises'
import path from 'path'

import { init, recordSubscriptionBellState } from './database'

const TEST_DB_FILE = 'test_database_bell.sqlite'
const TEST_DB_PATH = path.join(__dirname, '../', TEST_DB_FILE)

describe('recordSubscriptionBellState', () => {
	let db: sqlite.Database

	beforeEach(async () => {
		try {
			await fs.unlink(TEST_DB_PATH)
		} catch {
			// File does not exist yet
		}
		db = await init({ filename: TEST_DB_FILE })
	})

	afterEach(async () => {
		await db.close()
		try {
			await fs.unlink(TEST_DB_PATH)
		} catch {
			// Clean up
		}
	})

	test('inserts new channel with firstObservedAt and bellState', async () => {
		await recordSubscriptionBellState(
			db,
			'UC123',
			'Channel One',
			'all',
			'https://example.com/thumb.jpg',
		)

		const row = await db.get(SQL`
			SELECT * FROM subscriptions WHERE channelId='UC123';
		`)

		expect(row).toBeDefined()
		expect(row.channelTitle).toBe('Channel One')
		expect(row.bellState).toBe('all')
		expect(row.firstObservedAt).toBeDefined()
		expect(row.bellUpdatedAt).toBeDefined()
		expect(row.firstObservedAt).toBe(row.bellUpdatedAt)
	})

	test('updates bellUpdatedAt only when bellState changes', async () => {
		await recordSubscriptionBellState(db, 'UC123', 'Channel One', 'all')
		const firstRow = await db.get(SQL`
			SELECT * FROM subscriptions WHERE channelId='UC123';
		`)

		// Same state: bellUpdatedAt should remain the same
		await recordSubscriptionBellState(db, 'UC123', 'Channel One Updated', 'all')
		const secondRow = await db.get(SQL`
			SELECT * FROM subscriptions WHERE channelId='UC123';
		`)
		expect(secondRow.bellUpdatedAt).toBe(firstRow.bellUpdatedAt)
		expect(secondRow.channelTitle).toBe('Channel One Updated')

		// Changed state: bellUpdatedAt updates
		await new Promise(r => setTimeout(r, 10))
		await recordSubscriptionBellState(
			db,
			'UC123',
			'Channel One',
			'personalized',
		)
		const thirdRow = await db.get(SQL`
			SELECT * FROM subscriptions WHERE channelId='UC123';
		`)
		expect(thirdRow.bellState).toBe('personalized')
		expect(thirdRow.bellUpdatedAt).not.toBe(firstRow.bellUpdatedAt)
		expect(thirdRow.firstObservedAt).toBe(firstRow.firstObservedAt)
	})
})
