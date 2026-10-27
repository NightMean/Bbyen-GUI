import { expect, test, vi } from 'vitest'
import { init } from './database'
import { IncidentStore } from './incidents'
import { IncidentRecoveries } from './incidentRecoveries'
import { IncidentReporter } from './incidentReporter'

test('the reporter queues recovery when the issue clears', async () => {
	const db = await init({ filename: ':memory:' })
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
	const reporter = new IncidentReporter(db, logger, undefined, () => true)
	try {
		await reporter.notify('auth', new Error('private fixture'), {
			source: 'cookie', emailOnError: false, logger,
			sendErrorEmail: vi.fn(),
		})
		await reporter.clear(['auth'], 'cookie')
		expect(await db.all('SELECT state FROM incident_recovery_alerts'))
			.toEqual([{ state: 'pending' }])
	} finally { await db.close() }
})

test('sends one recovery when enabled and none for earlier disabled incidents',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new IncidentStore(db)
		const send = vi.fn().mockResolvedValue(undefined)
		const recoveries = new IncidentRecoveries(db, async () => send,
			() => undefined)
		try {
			await store.record({ source: 'cookie', category: 'auth',
				emailEnabled: false })
			await store.resolve('cookie', ['auth'])
			await store.record({ source: 'cookie', category: 'auth',
				emailEnabled: false })
			await store.resolve('cookie', ['auth'], undefined, true)
			await store.resolve('cookie', ['auth'], undefined, true)
			await recoveries.run(true); await recoveries.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			expect(send.mock.calls[0][0].subject).toMatch(/recovered/i)
			expect(await db.all('SELECT state FROM incident_recovery_alerts'))
				.toEqual([{ state: 'sent' }])
		} finally { await db.close() }
	})

test('retries and can suppress a queued recovery', async () => {
	const db = await init({ filename: ':memory:' })
	let now = new Date('2026-01-01T00:00:00Z')
	const clock = () => now
	const store = new IncidentStore(db, clock)
	const send = vi.fn().mockRejectedValueOnce(new Error('fixture'))
		.mockResolvedValue(undefined)
	const recoveries = new IncidentRecoveries(db, async () => send,
		() => undefined, clock)
	try {
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await store.resolve('cookie', ['auth'], undefined, true)
		await recoveries.run(true); await recoveries.run(true)
		expect(send).toHaveBeenCalledTimes(1)
		now = new Date('2026-01-01T00:00:31Z')
		await recoveries.run(true)
		expect(send).toHaveBeenCalledTimes(2)
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await store.resolve('cookie', ['auth'], undefined, true)
		await recoveries.run(false); await recoveries.run(true)
		expect(send).toHaveBeenCalledTimes(2)
		expect(await db.all(`SELECT state FROM incident_recovery_alerts
			ORDER BY rowid`)).toEqual([{ state: 'sent' }, { state: 'suppressed' }])
	} finally { await db.close() }
})

test('rolls back recovery alert if incident resolution fails', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new IncidentStore(db)
	try {
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await db.exec(`CREATE TRIGGER fail_resolution BEFORE UPDATE ON incidents
			WHEN NEW.resolvedAt IS NOT NULL
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		await expect(store.resolve('cookie', ['auth'], undefined, true))
			.rejects.toThrow('fixture failure')
		expect(await db.all('SELECT * FROM incident_recovery_alerts')).toEqual([])
		expect((await db.get('SELECT resolvedAt FROM incidents')).resolvedAt)
			.toBeNull()
	} finally { await db.close() }
})

test('does not send a stale recovery after the issue recurs', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new IncidentStore(db)
	const send = vi.fn()
	const recoveries = new IncidentRecoveries(db, async () => send,
		() => undefined)
	try {
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await store.resolve('cookie', ['auth'], undefined, true)
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await recoveries.run(true)
		expect(send).not.toHaveBeenCalled()
		expect((await db.get('SELECT state FROM incident_recovery_alerts')).state)
			.toBe('suppressed')
	} finally { await db.close() }
})

test('recovers an interrupted send and bounds repeated failures', async () => {
	const db = await init({ filename: ':memory:' })
	let time = Date.parse('2026-01-01T00:00:00Z')
	const clock = () => new Date(time)
	const store = new IncidentStore(db, clock)
	const send = vi.fn().mockRejectedValue(new Error('offline'))
	const recoveries = new IncidentRecoveries(db, async () => send,
		() => undefined, clock)
	try {
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		await store.resolve('cookie', ['auth'], undefined, true)
		await db.run(`UPDATE incident_recovery_alerts SET state='sending',
			attemptCount=1`)
		await recoveries.recoverInterrupted()
		await recoveries.run(true)
		for (const delay of [121_000, 601_000, 3_601_000, 9_000_000]) {
			time += delay; await recoveries.run(true)
		}
		expect(send).toHaveBeenCalledTimes(4)
		expect((await db.get('SELECT state FROM incident_recovery_alerts')).state)
			.toBe('exhausted')
	} finally { await db.close() }
})
