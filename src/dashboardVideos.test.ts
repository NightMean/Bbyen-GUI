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
		await db.run('UPDATE video_observations SET durationSeconds=120 ' +
			'WHERE videoId=?', 'c')
		await db.run('UPDATE video_observations SET contentType=? WHERE videoId=?',
			'livestream', 'b')
		const params = new URLSearchParams({ from: '2026-01-02T00:00:00.000Z',
			until: '2026-01-04T00:00:00.000Z', search: 'exam', limit: '1' })
		const first = await listDashboardVideos(db, parseVideoQuery(params))
		expect(first.total).toBe(2)
		expect(first.durationSeconds).toBe(120)
		expect(first.unknownDurationCount).toBe(1)
		expect(first.videos[0].videoId).toBe('c')
		params.set('offset', '1')
		const second = await listDashboardVideos(db, parseVideoQuery(params))
		expect(second.videos[0].videoId).toBe('b')
		params.set('offset', '0'); params.set('contentType', 'unknown')
		const unknown = await listDashboardVideos(db, parseVideoQuery(params))
		expect(unknown.total).toBe(1)
		params.set('contentType', 'livestream')
		expect((await listDashboardVideos(db, parseVideoQuery(params))).videos[0]
			.videoId).toBe('b')
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
		'from=2026-01-01', 'channelId=invalid', 'contentType=other',
		'other=value']) {
		expect(() => parseVideoQuery(new URLSearchParams(input))).toThrow()
	}
})


test('counts filtered videos by viewer calendar day across DST and pages',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelThumbnail, channelTitle)
				VALUES ('channel', '', 'C')`)
			for (const [id, date, title] of [
				['a', '2026-03-28T22:59:00.000Z', 'Match'],
				['b', '2026-03-28T23:01:00.000Z', 'Match'],
				['c', '2026-03-29T21:59:00.000Z', 'Match'],
				['d', '2026-03-29T22:01:00.000Z', 'Different'],
			]) {
				await db.run(`INSERT INTO video_observations
					(videoId, channelId, title, publishedAt, emailOutcome)
					VALUES (?, 'channel', ?, ?, 'sent')`, id, title, date)
			}
			const query = parseVideoQuery(new URLSearchParams({
				timeZone: 'Europe/Bratislava', limit: '1', search: 'Match',
			}))
			const result = await listDashboardVideos(db, query)
			expect(result.total).toBe(3)
			expect(result.videos).toHaveLength(1)
			expect(result.dailyCounts).toEqual({
				'2026-03-28': 1, '2026-03-29': 2,
			})
			query.offset = 1
			expect((await listDashboardVideos(db, query)).dailyCounts)
				.toEqual(result.dailyCounts)
			expect(() => parseVideoQuery(new URLSearchParams({
				timeZone: 'invalid/zone',
			}))).toThrow()
		} finally { await db.close() }
	})
