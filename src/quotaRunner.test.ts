import { expect, test, vi } from 'vitest'
import { init } from './database'
import { QuotaBackoff } from './quotaBackoff'
import { QuotaRunner } from './quotaRunner'
import { RefreshCoordinator } from './refreshCoordinator'
import { RefreshResult } from './refreshResult'

const throttled: RefreshResult = { status: 'failed', total: 1, succeeded: 0,
	failed: 1, skipped: 0, failedChannels: [], errorCategory: 'quota' }
const success: RefreshResult = { status: 'success', total: 1, succeeded: 1,
	failed: 0, skipped: 0, failedChannels: [], apiChecked: true }

test('scheduler gates attempts and sends one alert after the retry sequence',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			let time = Date.parse('2026-01-01T00:00:00Z')
			const backoff = new QuotaBackoff(db, () => new Date(time))
			const coordinator = new RefreshCoordinator(db, { warn: vi.fn() })
			const videos = vi.fn().mockResolvedValue(throttled)
			const reportQuota = vi.fn().mockResolvedValue(true)
			const clearQuota = vi.fn().mockResolvedValue(undefined)
			const runner = new QuotaRunner({ coordinator, backoff, enabled: true,
				alertsEnabled: () => true, work: { videos, subscriptions: videos },
				reportQuota, clearQuota, warn: vi.fn() })
			await runner.run('videos')
			expect(await runner.run('videos')).toBeUndefined()
			expect(videos).toHaveBeenCalledTimes(1)
			for (const delay of [30, 60, 120, 240]) {
				time += delay * 60_000
				await runner.tick()
			}
			expect(videos).toHaveBeenCalledTimes(5)
			expect(reportQuota).toHaveBeenCalledTimes(1)
			time += 240 * 60_000
			await runner.tick()
			expect(reportQuota).toHaveBeenCalledTimes(1)
			videos.mockResolvedValue(success)
			time += 240 * 60_000
			await runner.tick()
			expect(clearQuota).toHaveBeenCalledTimes(1)
		} finally { await db.close() }
	})

test('concurrent triggers do not advance backoff twice', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const coordinator = new RefreshCoordinator(db, { warn: vi.fn() })
		const backoff = new QuotaBackoff(db)
		const work = vi.fn().mockResolvedValue(throttled)
		const runner = new QuotaRunner({ coordinator, backoff, enabled: true,
			alertsEnabled: () => true, work: { videos: work, subscriptions: work },
			reportQuota: vi.fn().mockResolvedValue(true),
			clearQuota: vi.fn(), warn: vi.fn() })
		await Promise.all([runner.run('videos'), runner.run('videos')])
		expect(work).toHaveBeenCalledTimes(1)
		expect(await db.get('SELECT failures FROM quota_backoff'))
			.toEqual({ failures: 1 })
	} finally { await db.close() }
})

test('a failed alert record remains eligible for a later retry', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		let time = Date.parse('2026-01-01T00:00:00Z')
		const backoff = new QuotaBackoff(db, () => new Date(time))
		const coordinator = new RefreshCoordinator(db, { warn: vi.fn() })
		const work = vi.fn().mockResolvedValue(throttled)
		const reportQuota = vi.fn().mockResolvedValueOnce(false)
			.mockResolvedValue(true)
		const runner = new QuotaRunner({ coordinator, backoff, enabled: true,
			alertsEnabled: () => true, work: { videos: work, subscriptions: work },
			reportQuota, clearQuota: vi.fn(), warn: vi.fn() })
		await runner.run('videos')
		for (const delay of [30, 60, 120, 240]) {
			time += delay * 60_000
			await runner.tick()
		}
		expect(await db.get('SELECT alerted FROM quota_backoff'))
			.toEqual({ alerted: 0 })
		time += 240 * 60_000
		await runner.tick()
		expect(await db.get('SELECT alerted FROM quota_backoff'))
			.toEqual({ alerted: 1 })
		expect(reportQuota).toHaveBeenCalledTimes(2)
	} finally { await db.close() }
})
