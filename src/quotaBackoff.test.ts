import { expect, test } from 'vitest'
import { init } from './database'
import { QuotaBackoff } from './quotaBackoff'
import { RefreshResult } from './refreshResult'

const throttled: RefreshResult = { status: 'failed', total: 1, succeeded: 0,
	failed: 1, skipped: 0, failedChannels: [], errorCategory: 'quota' }
const success: RefreshResult = { status: 'success', total: 1, succeeded: 1,
	failed: 0, skipped: 0, failedChannels: [], apiChecked: true }

test('persists the agreed retry schedule and alerts once after exhaustion',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			let time = Date.parse('2026-01-01T00:00:00Z')
			let backoff = new QuotaBackoff(db, () => new Date(time))
			expect(await backoff.isDue('videos')).toBe(true)
			for (const delay of [30, 60, 120, 240]) {
				expect((await backoff.record('videos', throttled)).notify).toBe(false)
				expect(await backoff.isDue('videos')).toBe(false)
				time += delay * 60_000
				backoff = new QuotaBackoff(db, () => new Date(time))
				expect(await backoff.isDue('videos')).toBe(true)
			}
			expect((await backoff.record('videos', throttled)).notify).toBe(true)
			await backoff.markAlerted('videos')
			time += 240 * 60_000
			expect((await backoff.record('videos', throttled)).notify).toBe(false)
			time += 240 * 60_000
			expect((await backoff.record('videos', success)).fullyRecovered)
				.toBe(true)
			expect(await backoff.isDue('videos')).toBe(true)
		} finally { await db.close() }
	})

test('a no-op refresh does not claim the quota recovered', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		let time = Date.parse('2026-01-01T00:00:00Z')
		const backoff = new QuotaBackoff(db, () => new Date(time))
		await backoff.record('videos', throttled)
		time += 30 * 60_000
		await backoff.record('videos', { ...success, apiChecked: false })
		expect(await backoff.isDue('videos')).toBe(false)
	} finally { await db.close() }
})
