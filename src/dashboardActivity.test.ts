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

test('includes refresh outcomes and tolerates unreadable history', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO refresh_runs
			(id, kind, status, startedAt, finishedAt, resultJson)
			VALUES ('complete', 'videos', 'completed', '2026-01-01', '2026-01-02',
			?)`, JSON.stringify({ status: 'partial', succeeded: 3, failed: 1,
			secret: 'not-returned' }))
		await db.run(`INSERT INTO refresh_runs
			(id, kind, status, startedAt, resultJson)
			VALUES ('broken', 'subscriptions', 'interrupted', '2026-01-03', '{')`)
		const result = await listActivity(db, { limit: 30, offset: 0 })
		expect(result.total).toBe(2)
		expect(result.items[0].value).toMatchObject({ kind: 'subscriptions',
			status: 'interrupted', resultStatus: null })
		expect(result.items[1].value).toMatchObject({ kind: 'videos',
			resultStatus: 'partial', succeeded: 3, failed: 1 })
		expect(result.items[1].value).not.toHaveProperty('secret')
	} finally { await db.close() }
})

test('shows API subscription actions without account credentials', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO api_subscription_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES ('action', 'private-profile', 'channel', 0, 'uncertain', '2026')`)
		const result = await listActivity(db, { limit: 30, offset: 0 })
		expect(result.items[0]).toMatchObject({ kind: 'apiSubscription',
			value: { channelId: 'channel', target: 0, state: 'uncertain' } })
		expect(JSON.stringify(result)).not.toContain('private-profile')
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

test('shows cookie actions without exposing the account profile', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO cookie_subscription_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES ('one', 'private-profile', 'channel', 0, 'uncertain', '2026')`)
		await db.run(`INSERT INTO cookie_bell_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES ('two', 'private-profile', 'channel', 'all', 'confirmed', '2026')`)
		const result = await listActivity(db, { limit: 30, offset: 0 })
		expect(result.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'cookieSubscription', value:
				expect.objectContaining({ target: 0, state: 'uncertain' }) }),
			expect.objectContaining({ kind: 'cookieBell', value:
				expect.objectContaining({ target: 'all', state: 'confirmed' }) }),
		]))
		expect(JSON.stringify(result)).not.toContain('private-profile')
	} finally { await db.close() }
})
