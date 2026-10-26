import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import * as sqlite from 'sqlite'
import sqlite3 from 'sqlite3'
import SQL from 'sql-template-strings'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import { init, recordSubscriptionBellState } from './database'
import { recoverPendingVideoEmails } from './videoSchema'

describe('recordSubscriptionBellState', () => {
	let db: sqlite.Database

	beforeEach(async () => {
		db = await init({ filename: ':memory:' })
	})

	test('recovers pending sends', async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await db.exec(`INSERT INTO video_observations
			(videoId, channelId, emailOutcome) VALUES
			('v1', 'UC123', 'pending'), ('v2', 'UC123', 'sent');`)
			await recoverPendingVideoEmails(db)
			expect(await db.all(`SELECT videoId, emailOutcome FROM video_observations
			ORDER BY videoId`)).toEqual([
				{ videoId: 'v1', emailOutcome: 'uncertain' },
				{ videoId: 'v2', emailOutcome: 'sent' },
			])
		} finally {
			await db.close()
		}
	})

	afterEach(async () => {
		await db.close()
	})

	test('fills missing first observation without replacing existing rows',
		async () => {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail, deleted, deletedReason)
				VALUES ('UC123', 'Old title', 'old-avatar', 1, 'terminated')`)
			await recordSubscriptionBellState(db, 'UC123', 'New title', 'all')
			expect(await db.get('SELECT * FROM subscriptions')).toMatchObject({
				id: 1, firstObservedAt: expect.any(String), deleted: 1,
				deletedReason: 'terminated', channelThumbnail: 'old-avatar',
			})
		})

	test('serializes concurrent observations through SQLite upsert', async () => {
		await Promise.all(Array.from({ length: 5 }, () =>
			recordSubscriptionBellState(db, 'UC123', 'Creator', 'all')))
		expect((await db.all('SELECT * FROM subscriptions')).length).toBe(1)
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
		expect(row.deleted).toBe(1)
		expect(row.channelThumbnail).toBe('https://example.com/thumb.jpg')
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

test('upgrades an existing database at an absolute path', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-db-test-'))
	const filename = path.join(directory, 'legacy.sqlite')
	const old = await sqlite.open({ filename, driver: sqlite3.Database })
	await old.exec(`CREATE TABLE subscriptions (
		id INTEGER PRIMARY KEY, channelId TEXT UNIQUE, channelTitle TEXT,
		channelThumbnail TEXT, deleted INTEGER DEFAULT 0
	);
	INSERT INTO subscriptions VALUES (1, 'UC123', 'Creator', 'avatar', 0);`)
	await old.close()
	let upgraded: sqlite.Database | undefined
	try {
		upgraded = await init({ filename })
		expect(await upgraded.get('SELECT * FROM subscriptions')).toMatchObject({
			id: 1, channelTitle: 'Creator', firstObservedAt: expect.any(String),
		})
	} finally {
		await upgraded?.close()
		await fs.unlink(filename)
		await fs.rmdir(directory)
	}
})

test('repairs IDs between schema upgrades only once', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-repair-'))
	const filename = path.join(directory, 'data.sqlite')
	let db = await init({ filename })
	try {
		await db.exec(`DELETE FROM video_schema_migrations WHERE version=3;
			INSERT INTO videos (videoId, channelId) VALUES ('v1', 'channel');`)
		await db.close()
		db = await init({ filename })
		expect(await db.get('SELECT emailOutcome FROM video_observations'))
			.toEqual({ emailOutcome: 'unknown' })
		await db.run('DELETE FROM video_observations')
		await db.close()
		db = await init({ filename })
		expect(await db.get('SELECT * FROM video_observations')).toBeUndefined()
	} finally {
		await db.close()
		await fs.unlink(filename)
		await fs.rmdir(directory)
	}
})

test('migrates processed videos without inventing their email outcome',
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-video-'))
		const filename = path.join(directory, 'legacy.sqlite')
		const old = await sqlite.open({ filename, driver: sqlite3.Database })
		await old.exec(`CREATE TABLE videos (
			id INTEGER PRIMARY KEY, videoId TEXT NOT NULL UNIQUE,
			channelId TEXT NOT NULL
		);
		INSERT INTO videos VALUES (1, 'v1', 'UC123');`)
		await old.close()
		let upgraded: sqlite.Database | undefined
		try {
			upgraded = await init({ filename })
			expect(await upgraded.get(`SELECT videoId, emailOutcome
				FROM video_observations WHERE videoId='v1'`)).toEqual({
				videoId: 'v1', emailOutcome: 'unknown',
			})
			expect(await upgraded.get(`SELECT channelId FROM video_scan_baselines
				WHERE channelId='UC123'`)).toEqual({ channelId: 'UC123' })
			await upgraded.close()
			upgraded = await init({ filename })
			expect(await upgraded.get('SELECT COUNT(*) AS count FROM videos'))
				.toEqual({ count: 1 })
		} finally {
			await upgraded?.close()
			await fs.unlink(filename)
			await fs.rmdir(directory)
		}
	})
