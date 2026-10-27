import { expect, test } from 'vitest'
import { init } from './database'
import { listDashboardVideos, parseVideoQuery } from './dashboardVideos'

test('filters by date and title and paginates deterministically', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO subscriptions
			(channelId, channelThumbnail, channelTitle)
			VALUES ('channel', '', 'Channel')`)
		for (const [id, date] of [['a', '2026-01-01T12:00:00.000Z'],
			['b', '2026-01-02T12:00:00.000Z'],
			['c', '2026-01-03T12:00:00.000Z']]) {
			await db.run(`INSERT INTO video_observations
				(videoId, channelId, title, publishedAt, emailOutcome)
				VALUES (?, ?, ?, ?, 'sent')`, id, 'channel', 'Example', date)
		}
		const params = new URLSearchParams({ from: '2026-01-02T00:00:00.000Z',
			until: '2026-01-04T00:00:00.000Z', search: 'exam', limit: '1' })
		const first = await listDashboardVideos(db, parseVideoQuery(params))
		expect(first.total).toBe(2)
		expect(first.videos[0].videoId).toBe('c')
		params.set('offset', '1')
		const second = await listDashboardVideos(db, parseVideoQuery(params))
		expect(second.videos[0].videoId).toBe('b')
		await db.run('UPDATE subscriptions SET deleted=1 WHERE channelId=?',
			'channel')
		const inactive = await listDashboardVideos(db, parseVideoQuery(params))
		expect(inactive.total).toBe(0)
		expect((await db.get('SELECT COUNT(*) AS count FROM video_observations'))
			.count).toBe(3)
	} finally { await db.close() }
})

test('rejects invalid and repeated query parameters', () => {
	for (const input of ['limit=0', 'limit=201', 'offset=-1', 'search=a&search=b',
		'from=2026-01-01', 'channelId=invalid', 'other=value']) {
		expect(() => parseVideoQuery(new URLSearchParams(input))).toThrow()
	}
})
