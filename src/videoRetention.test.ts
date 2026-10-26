import { expect, test } from 'vitest'
import { init } from './database'
import {
	parseVideoRetentionDays, pruneVideoObservations,
} from './videoRetention'

test('retention removes old details but keeps IDs and in-flight attempts',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await db.exec(`INSERT INTO videos (videoId, channelId) VALUES
				('old', 'channel'), ('new', 'channel'), ('pending', 'channel');
				INSERT INTO video_observations
				(videoId, channelId, observedAt, emailOutcome) VALUES
				('old', 'channel', '2026-01-01T00:00:00.000Z', 'sent'),
				('new', 'channel', '2026-01-09T00:00:00.000Z', 'muted'),
				('pending', 'channel', '2026-01-01T00:00:00.000Z', 'pending');`)
			await pruneVideoObservations(db, 5, new Date('2026-01-10T00:00:00Z'))
			expect((await db.all('SELECT videoId FROM video_observations'))
				.map(row => row.videoId).sort()).toEqual(['new', 'pending'])
			expect(await db.get('SELECT COUNT(*) AS count FROM videos'))
				.toEqual({ count: 3 })
		} finally {
			await db.close()
		}
	})

test('validates retention duration and accepts unlimited retention', () => {
	expect(parseVideoRetentionDays(null)).toBeNull()
	for (const value of [0, -1, 1.5, '3', {}, Number.MAX_SAFE_INTEGER]) {
		expect(() => parseVideoRetentionDays(value)).toThrow('videoRetentionDays')
	}
})

test('unlimited retention keeps old observations', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO video_observations
			(videoId, channelId, observedAt, emailOutcome)
			VALUES ('old', 'channel', '2000-01-01T00:00:00.000Z', 'sent')`)
		await pruneVideoObservations(db, null)
		expect(await db.get('SELECT videoId FROM video_observations'))
			.toEqual({ videoId: 'old' })
	} finally {
		await db.close()
	}
})
