import { expect, test } from 'vitest'
import { init } from './database'
import { listActivity, parseActivityPage } from './dashboardActivity'

test('paginates combined activity deterministically across equal timestamps',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			const date = new Date().toISOString()
			for (let i = 0; i < 105; i++) {
				await db.run(`INSERT INTO cookie_channel_events
					(profileKey, channelId, previousState, currentState, notifyEligible,
					observedAt) VALUES ('profile', ?, NULL, 'all', 1, ?)`,
				`channel-${i}`, date)
			}
			await db.run(`INSERT INTO incidents (id, source, category, openedAt,
				lastObservedAt, occurrences, emailState)
				VALUES ('issue', 'cookie', 'auth', ?, ?, 1, 'sent')`, date, date)
			await db.run(`INSERT INTO channel_title_events
				(channelId, previousTitle, currentTitle, observedAt)
				VALUES ('channel-1', 'Before', 'After', ?)`, date)
			await db.run(`INSERT INTO channel_added_batches
				(id, observedAt, emailState)
				VALUES ('batch', ?, 'sent')`, date)
			await db.run(`INSERT INTO channel_added_events (batchId, channelId,
				observedAt) VALUES ('batch', 'channel-1', ?)`, date)
			const first = await listActivity(db, { limit: 100, offset: 0 })
			const second = await listActivity(db, { limit: 100, offset: 100 })
			expect(first.total).toBe(108)
			expect(second.items).toHaveLength(8)
			const all = [...first.items, ...second.items]
			expect(new Set(all.filter(x => x.kind === 'bell')
				.map(x => x.value.channelId)).size).toBe(105)
			expect(new Set(all.map(x => x.kind))).toEqual(
				new Set(['bell', 'incident', 'title', 'added']))
		} finally { await db.close() }
	})

test('validates activity paging parameters', () => {
	expect(parseActivityPage(new URLSearchParams('limit=30&offset=100')))
		.toEqual({ limit: 30, offset: 100 })
	for (const input of ['limit=0', 'limit=201', 'offset=-1', 'search=x',
		'limit=1&limit=2']) {
		expect(() => parseActivityPage(new URLSearchParams(input))).toThrow()
	}
})
