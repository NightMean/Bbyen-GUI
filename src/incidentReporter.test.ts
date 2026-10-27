import { expect, test, vi } from 'vitest'
import { init } from './database'
import { IncidentReporter } from './incidentReporter'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

test('deduplicates channel incidents across recreation', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
		const deps = { source: 'videos', emailOnError: true,
			logger, sendErrorEmail }
		const one = new IncidentReporter(db, logger)
		await one.notify('other', new Error('private fixture'), {
			...deps, channelId: first,
		})
		const two = new IncidentReporter(db, logger)
		await two.notify('other', new Error('private fixture'), {
			...deps, channelId: first,
		})
		await two.notify('other', new Error('private fixture'), {
			...deps, channelId: second,
		})
		expect(sendErrorEmail).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(sendErrorEmail.mock.calls))
			.not.toContain('private fixture')
	} finally { await db.close() }
})

test('retries failed alerts after backoff without repeating successful sends',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			let now = new Date('2026-01-01T00:00:00Z')
			const reporter = new IncidentReporter(db, logger, () => now)
			const sendErrorEmail = vi.fn().mockRejectedValueOnce(new Error('offline'))
				.mockResolvedValue(undefined)
			const deps = { source: 'videos', emailOnError: true,
				logger, sendErrorEmail,
				channelId: first }
			await reporter.notify('other', new Error('fixture'), deps)
			await reporter.retryPending(sendErrorEmail, true)
			expect(sendErrorEmail).toHaveBeenCalledTimes(1)
			now = new Date('2026-01-01T00:00:31Z')
			await reporter.retryPending(sendErrorEmail, true)
			await reporter.retryPending(sendErrorEmail, true)
			expect(sendErrorEmail).toHaveBeenCalledTimes(2)
			expect(await db.get('SELECT emailState FROM incidents'))
				.toEqual({ emailState: 'sent' })
		} finally { await db.close() }
	})

test('recovers alert delivery and honors disabled email', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
		const reporter = new IncidentReporter(db, logger)
		await reporter.notify('auth', new Error('fixture'), {
			source: 'service-auth', emailOnError: false, logger, sendErrorEmail,
		})
		expect(sendErrorEmail).not.toHaveBeenCalled()
		await db.run('UPDATE incidents SET emailState=?, attemptCount=1', 'sending')
		await reporter.recoverInterrupted()
		await reporter.retryPending(sendErrorEmail, true)
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
	} finally { await db.close() }
})

test('stops retries after the bounded delivery attempts', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		let time = Date.parse('2026-01-01T00:00:00Z')
		const reporter = new IncidentReporter(db, logger, () => new Date(time))
		const sendErrorEmail = vi.fn().mockRejectedValue(new Error('offline'))
		await reporter.notify('other', new Error('fixture'), {
			source: 'videos', emailOnError: true, logger, sendErrorEmail,
		})
		for (const delay of [31_000, 121_000, 601_000, 3_601_000, 20_000_000]) {
			time += delay
			await reporter.retryPending(sendErrorEmail, true)
		}
		expect(sendErrorEmail).toHaveBeenCalledTimes(5)
		expect(await db.get('SELECT emailState, attemptCount FROM incidents'))
			.toEqual({ emailState: 'exhausted', attemptCount: 5 })
		await reporter.notify('other', new Error('fixture'), {
			source: 'videos', emailOnError: false, logger, sendErrorEmail,
		})
		await reporter.notify('other', new Error('fixture'), {
			source: 'videos', emailOnError: true, logger, sendErrorEmail,
		})
		expect(await db.get('SELECT emailState FROM incidents'))
			.toEqual({ emailState: 'exhausted' })
	} finally { await db.close() }
})

test('concurrent reports do not send duplicate alerts', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		const reporter = new IncidentReporter(db, logger)
		const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
		const deps = { source: 'videos', emailOnError: true, logger, sendErrorEmail,
			channelId: first }
		await Promise.all(Array.from({ length: 5 }, () =>
			reporter.notify('other', new Error('fixture'), deps)))
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
	} finally { await db.close() }
})

test('storage failure does not mask the original operation', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await db.exec(`CREATE TRIGGER reject_incident BEFORE INSERT ON incidents
			BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`)
		const reporter = new IncidentReporter(db, logger)
		const sendErrorEmail = vi.fn().mockRejectedValue(new Error('offline'))
		await expect(reporter.notify('other', new Error('private fixture'), {
			source: 'videos', emailOnError: true, logger, sendErrorEmail,
		})).resolves.toBeUndefined()
		expect(JSON.stringify(sendErrorEmail.mock.calls))
			.not.toContain('private fixture')
	} finally { await db.close() }
})
