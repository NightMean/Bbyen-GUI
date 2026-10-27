import { expect, test, vi } from 'vitest'
import { init } from './database'
import { IncidentStore } from './incidents'
import { IncidentReminders } from './incidentReminders'

test('reminds after 24 hours, repeats daily, and stops after recovery',
	async () => {
		const db = await init({ filename: ':memory:' })
		let now = new Date('2026-01-01T00:00:00Z')
		const clock = () => now
		const store = new IncidentStore(db, clock)
		const send = vi.fn().mockResolvedValue(undefined)
		const reminders = new IncidentReminders(db, async () => send,
			() => undefined, clock)
		try {
			await store.record({ source: 'cookie', category: 'auth',
				emailEnabled: false })
			await reminders.run(true)
			now = new Date('2026-01-02T00:00:00Z')
			await reminders.run(false)
			expect(send).not.toHaveBeenCalled()
			await reminders.run(true); await reminders.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			expect(send.mock.calls[0][0].subject).toMatch(/reminder/i)
			now = new Date('2026-01-03T00:00:00Z')
			await reminders.run(true)
			expect(send).toHaveBeenCalledTimes(2)
			await store.resolve('cookie', ['auth'])
			now = new Date('2026-01-04T00:00:00Z')
			await reminders.run(true)
			expect(send).toHaveBeenCalledTimes(2)
		} finally { await db.close() }
	})

test('retries a failed reminder with backoff and recovers interruption',
	async () => {
		const db = await init({ filename: ':memory:' })
		let now = new Date('2026-01-01T00:00:00Z')
		const clock = () => now
		const store = new IncidentStore(db, clock)
		const send = vi.fn().mockRejectedValueOnce(new Error('fixture'))
			.mockResolvedValue(undefined)
		const reminders = new IncidentReminders(db, async () => send,
			() => undefined, clock)
		try {
			await store.record({ source: 'cookie', category: 'auth',
				emailEnabled: false })
			now = new Date('2026-01-02T00:00:00Z')
			await reminders.run(true); await reminders.run(true)
			expect(send).toHaveBeenCalledTimes(1)
			now = new Date('2026-01-02T00:00:31Z')
			await reminders.run(true)
			expect(send).toHaveBeenCalledTimes(2)
			await db.run(`UPDATE incident_reminders SET state='sending',
				attemptCount=1`)
			await reminders.recoverInterrupted()
			expect((await db.get('SELECT state FROM incident_reminders')).state)
				.toBe('failed')
		} finally { await db.close() }
	})

test('stops after bounded reminder attempts', async () => {
	const db = await init({ filename: ':memory:' })
	let time = Date.parse('2026-01-01T00:00:00Z')
	const clock = () => new Date(time)
	const store = new IncidentStore(db, clock)
	const send = vi.fn().mockRejectedValue(new Error('fixture'))
	const reminders = new IncidentReminders(db, async () => send,
		() => undefined, clock)
	try {
		await store.record({ source: 'cookie', category: 'auth',
			emailEnabled: false })
		time += 24 * 60 * 60 * 1000
		await reminders.run(true)
		for (const delay of [31_000, 121_000, 601_000, 3_601_000, 9_000_000]) {
			time += delay; await reminders.run(true)
		}
		expect(send).toHaveBeenCalledTimes(5)
		expect((await db.get('SELECT state FROM incident_reminders')).state)
			.toBe('exhausted')
	} finally { await db.close() }
})
