import { expect, test, vi } from 'vitest'
import { serializeJobs } from './serializeJobs'

test('serializes jobs and coalesces duplicate requests', async () => {
	let release!: () => void
	const gate = new Promise<void>(resolve => { release = resolve })
	const events: string[] = []
	const jobs = serializeJobs()
	const first = jobs.run('videos', async () => {
		events.push('start')
		await gate
		events.push('end')
	})
	const duplicate = jobs.run('videos', vi.fn())
	const other = jobs.run('subscriptions', async () => { events.push('other') })
	await Promise.resolve()
	expect(events).toEqual(['start'])
	release()
	await Promise.all([first, duplicate, other])
	expect(events).toEqual(['start', 'end', 'other'])
})

test('a failed job does not block the next job', async () => {
	const jobs = serializeJobs()
	const first = jobs.run('a', async () => { throw new Error('failed') })
	const second = jobs.run('b', async () => 'ok')
	await expect(first).rejects.toThrow('failed')
	await expect(second).resolves.toBe('ok')
})
