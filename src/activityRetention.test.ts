import { expect, test } from 'vitest'
import { init } from './database'
import { parseActivityRetentionDays, pruneActivity } from './activityRetention'

test('prunes completed activity but retains active and unresolved work',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await db.exec(`INSERT INTO videos (videoId, channelId)
				VALUES ('processed', 'fixture');
			INSERT INTO cookie_channel_events
				(profileKey, channelId, currentState, notifyEligible, observedAt)
				VALUES ('profile', 'fixture', 'all', 1, '2020-01-01T00:00:00Z');
			INSERT INTO channel_title_events
				(channelId, previousTitle, currentTitle, observedAt, emailState)
				VALUES ('fixture', 'A', 'B', '2020-01-01T00:00:00Z', 'sent'),
					('fixture', 'B', 'C', '2020-01-01T00:00:00Z', 'pending');
			INSERT INTO channel_added_batches VALUES
				('old', '2020-01-01T00:00:00Z', 'sent'),
				('pending', '2020-01-01T00:00:00Z', 'pending');
			INSERT INTO channel_added_events VALUES
				('old', 'fixture', '2020-01-01T00:00:00Z'),
				('pending', 'fixture', '2020-01-01T00:00:00Z');
			INSERT INTO incidents (id, source, category, openedAt, lastObservedAt,
				resolvedAt, occurrences, emailState) VALUES
				('active', 'cookie', 'auth', '2020', '2020', NULL, 1, 'sent'),
				('resolved', 'smtp', 'other', '2020', '2020',
					'2020-01-01T00:00:00Z', 1, 'sent'),
				('retry', 'videos', 'other', '2020', '2020',
					'2020-01-01T00:00:00Z', 1, 'failed');
			INSERT INTO cookie_bell_actions VALUES
				('pending', 'profile', 'fixture', 'all', 'uncertain', '2020', '2020'),
				('done', 'profile', 'fixture', 'all', 'confirmed', '2020', '2020');
			INSERT INTO refresh_runs (id, kind, status, startedAt, finishedAt) VALUES
				('older', 'videos', 'completed', '2019', '2019'),
				('latest', 'videos', 'completed', '2020', '2020');`)
			await pruneActivity(db, 30, new Date('2026-01-01T00:00:00Z'))
			expect(await db.all('SELECT videoId FROM videos')).toHaveLength(1)
			expect(await db.all('SELECT id FROM incidents ORDER BY id'))
				.toEqual([{ id: 'active' }, { id: 'retry' }])
			expect(await db.all('SELECT emailState FROM channel_title_events'))
				.toEqual([{ emailState: 'pending' }])
			expect(await db.all('SELECT id FROM channel_added_batches'))
				.toEqual([{ id: 'pending' }])
			expect(await db.all('SELECT batchId FROM channel_added_events'))
				.toEqual([{ batchId: 'pending' }])
			expect(await db.all('SELECT id FROM cookie_bell_actions'))
				.toEqual([{ id: 'pending' }])
			expect(await db.all('SELECT id FROM refresh_runs'))
				.toEqual([{ id: 'latest' }])
			expect(await db.all('SELECT * FROM cookie_channel_events')).toEqual([])
		} finally { await db.close() }
	})

test('accepts unlimited retention and rejects invalid durations', () => {
	expect(parseActivityRetentionDays(null)).toBeNull()
	for (const value of [0, -1, 1.5, '30', Number.MAX_SAFE_INTEGER]) {
		expect(() => parseActivityRetentionDays(value)).toThrow()
	}
})

test('handles SQLite timestamps at the retention boundary', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.exec(`INSERT INTO email_test_runs
			(id, startedAt, finishedAt, outcome)
			VALUES ('older', '2020', '2026-01-02 11:00:00', 'sent'),
			('newer', '2020', '2026-01-02 13:00:00', 'sent')`)
		await pruneActivity(db, null, new Date('2026-02-01T12:00:00Z'))
		expect(await db.all('SELECT id FROM email_test_runs')).toHaveLength(2)
		await pruneActivity(db, 30, new Date('2026-02-01T12:00:00Z'))
		expect(await db.all('SELECT id FROM email_test_runs'))
			.toEqual([{ id: 'newer' }])
	} finally { await db.close() }
})

test('rolls back the entire cleanup if a deletion fails', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.exec(`INSERT INTO cookie_channel_events
			(profileKey, channelId, currentState, notifyEligible, observedAt)
			VALUES ('profile', 'fixture', 'all', 1, '2020-01-01T00:00:00Z');
			CREATE TRIGGER fail_cleanup BEFORE DELETE ON channel_title_events
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;
			INSERT INTO channel_title_events
			(channelId, previousTitle, currentTitle, observedAt, emailState)
			VALUES ('fixture', 'A', 'B', '2020-01-01T00:00:00Z', 'sent');`)
		await expect(pruneActivity(db, 30, new Date('2026-01-01T00:00:00Z')))
			.rejects.toThrow('fixture failure')
		expect(await db.all('SELECT * FROM cookie_channel_events')).toHaveLength(1)
	} finally { await db.close() }
})
