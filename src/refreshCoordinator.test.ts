import { expect, test, vi } from 'vitest'
import { init } from './database'
import { RefreshCoordinator } from './refreshCoordinator'
import { RefreshResult } from './refreshResult'

const success: RefreshResult = { status: 'success', total: 1, succeeded: 1,
	failed: 0, skipped: 0, failedChannels: [] }
const partial: RefreshResult = { status: 'partial', total: 2, succeeded: 1,
	failed: 1, skipped: 0, failedChannels: ['UC0000000000000000000001'],
	errorCategory: 'other' }
const logger = { warn: vi.fn() }

test('coalesces requests and preserves last success after a partial run',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			const coordinator = new RefreshCoordinator(db, logger)
			let release!: () => void
			const gate = new Promise<void>(resolve => { release = resolve })
			const work = vi.fn(async () => { await gate; return success })
			const first = coordinator.run('videos', work)
			const second = coordinator.run('videos', work)
			release()
			await Promise.all([first, second])
			expect(work).toHaveBeenCalledTimes(1)
			await coordinator.run('videos', async () => partial)
			const status = await coordinator.status('videos')
			expect(status.lastRun?.result).toEqual(partial)
			expect(status.lastSuccessfulAt).toBeTruthy()
		} finally { await db.close() }
	})

test('recovers interruptions and redacts errors', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.run(`INSERT INTO refresh_runs (id, kind, status, startedAt)
			VALUES ('old', 'videos', 'running', '2026-01-01T00:00:00.000Z')`)
		const coordinator = new RefreshCoordinator(db, logger)
		await coordinator.recoverInterrupted()
		await coordinator.run('subscriptions', async () => {
			throw new Error('sensitive fixture text')
		})
		expect(await db.get('SELECT status FROM refresh_runs WHERE id=?', 'old'))
			.toEqual({ status: 'interrupted' })
		const stored = await db.all('SELECT resultJson FROM refresh_runs')
		expect(JSON.stringify(stored)).not.toContain('sensitive fixture text')
	} finally { await db.close() }
})

test('exposes queued and running jobs sharing the database', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const coordinator = new RefreshCoordinator(db, logger)
		let release!: () => void
		const gate = new Promise<void>(resolve => { release = resolve })
		let started!: () => void
		const ready = new Promise<void>(resolve => { started = resolve })
		const first = coordinator.run('videos', async () => {
			started()
			await gate
			return success
		})
		const second = coordinator.run('subscriptions', async () => success)
		await ready
		expect((await coordinator.status('videos')).state).toBe('running')
		expect((await coordinator.status('subscriptions')).state).toBe('queued')
		release()
		await Promise.all([first, second])
	} finally { await db.close() }
})

test('serializes alert maintenance with refresh database work', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const coordinator = new RefreshCoordinator(db, logger)
		let release!: () => void
		const gate = new Promise<void>(resolve => { release = resolve })
		let started!: () => void
		const ready = new Promise<void>(resolve => { started = resolve })
		const events: string[] = []
		const refresh = coordinator.run('videos', async () => {
			events.push('start')
			started()
			await gate
			events.push('finish')
			return success
		})
		const maintenance = coordinator.maintenance('alerts', async () => {
			events.push('alerts')
		})
		await ready
		expect(events).toEqual(['start'])
		release()
		await Promise.all([refresh, maintenance])
		expect(events).toEqual(['start', 'finish', 'alerts'])
	} finally { await db.close() }
})

test('diagnostic storage failure does not prevent the refresh', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.exec(`CREATE TRIGGER reject_refresh BEFORE INSERT ON refresh_runs
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		const coordinator = new RefreshCoordinator(db, logger)
		expect(await coordinator.run('videos', async () => success))
			.toEqual(success)
	} finally { await db.close() }
})

test('a failing logger cannot stop refresh work', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.exec(`CREATE TRIGGER reject_refresh BEFORE INSERT ON refresh_runs
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		const coordinator = new RefreshCoordinator(db, {
			warn: () => { throw new Error('logger offline') },
		})
		expect(await coordinator.run('videos', async () => success))
			.toEqual(success)
	} finally { await db.close() }
})

test('bounds and sanitizes channel identifiers in stored results', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const coordinator = new RefreshCoordinator(db, logger)
		const input = { ...partial, failedChannels: ['not-a-channel-secret'],
			unexpected: 'another-secret' }
		await coordinator.run('videos', async () => input)
		const stored = await db.get('SELECT resultJson FROM refresh_runs')
		expect(stored.resultJson).not.toContain('not-a-channel-secret')
		expect(stored.resultJson).not.toContain('another-secret')
		expect(JSON.parse(stored.resultJson)).toMatchObject({
			failedChannels: [], failedChannelsTruncated: true,
		})
	} finally { await db.close() }
})
