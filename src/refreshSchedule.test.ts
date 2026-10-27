import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test, vi } from 'vitest'
import { Config } from './config'
import {
	RefreshSchedule, parseRefreshIntervals, saveRefreshIntervals,
} from './refreshSchedule'

test('validates complete intervals and normalizes units', () => {
	expect(parseRefreshIntervals({ subscriptions: '2 HOURS', videos: '2 MS' }).ms)
		.toEqual({ subscriptions: 7_200_000, videos: 2 })
	for (const videos of ['garbage 1', '0.5ms', '0 days', '30 days']) {
		expect(() => parseRefreshIntervals({ subscriptions: '1 day', videos }))
			.toThrow()
	}
})

test('replaces timers only after settings are saved', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-schedule-'))
	const file = path.join(dir, 'config.json')
	await fs.writeFile(file, JSON.stringify({ timers: {
		subscriptions: '1 second', videos: '2 seconds' }, keep: 'value' }))
	const config = { timers: { subscriptions: '1 second',
		videos: '2 seconds' } } as Config
	const calls: string[] = []
	vi.useFakeTimers()
	const schedule = new RefreshSchedule(kind => calls.push(kind))
	try {
		schedule.configure({ subscriptions: 1000, videos: 2000 })
		await fs.writeFile(`${file}.lock`, 'fixture')
		await expect(saveRefreshIntervals(file, config, schedule,
			{ subscriptions: '3 seconds', videos: '4 seconds' })).rejects.toThrow()
		vi.advanceTimersByTime(1000)
		expect(calls).toEqual(['subscriptions'])
		await fs.unlink(`${file}.lock`)
		await saveRefreshIntervals(file, config, schedule,
			{ subscriptions: '3 seconds', videos: '4 seconds' })
		calls.length = 0
		vi.advanceTimersByTime(3000)
		expect(calls).toEqual(['subscriptions'])
		expect(config.timers.videos).toBe('4 seconds')
		expect(JSON.parse(await fs.readFile(file, 'utf8')).keep).toBe('value')
	} finally {
		schedule.stop(); vi.useRealTimers()
		await fs.rm(dir, { recursive: true, force: true })
	}
})
