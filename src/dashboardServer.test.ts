import { AddressInfo } from 'net'
import axios from 'axios'
import { expect, test } from 'vitest'
import { init } from './database'
import { createDashboardServer, dashboardPort } from './dashboardServer'
import { RefreshCoordinator } from './refreshCoordinator'

test('serves persisted data and rejects unsupported requests', async () => {
	const db = await init({ filename: ':memory:' })
	await db.run(`INSERT INTO subscriptions
		(channelId, channelThumbnail, channelTitle) VALUES ('channel', '', 'Test')`)
	await db.run(`INSERT INTO video_observations
		(videoId, channelId, title, emailOutcome)
		VALUES ('video', 'channel', 'Example', 'sent')`)
	const jobs = new RefreshCoordinator(db, { warn: () => undefined })
	const server = createDashboardServer(db, jobs)
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	try {
		const channels = await axios.get(`${base}/api/channels`)
		expect(channels.status).toBe(200)
		expect(channels.data.channels[0].channelTitle).toBe('Test')
		expect((await axios.get(`${base}/api/videos`)).data.videos[0].title)
			.toBe('Example')
		expect((await axios.get(`${base}/api/refresh`)).data.videos.state)
			.toBe('idle')
		expect((await axios.post(`${base}/api/channels`, null,
			{ validateStatus: () => true })).status)
			.toBe(405)
		expect((await axios.get(`${base}/api/channels?extra=1`,
			{ validateStatus: () => true })).status).toBe(404)
	} finally {
		await new Promise<void>((resolve, reject) => server.close(err =>
			err ? reject(err) : resolve()))
		await db.close()
	}
})

test('validates the listening port', () => {
	expect(dashboardPort(undefined)).toBe(3031)
	expect(dashboardPort('0')).toBe(0)
	expect(() => dashboardPort('3031x')).toThrow()
	expect(() => dashboardPort('65536')).toThrow()
})

test('validates writes and schedules refresh after saving', async () => {
	const db = await init({ filename: ':memory:' })
	const jobs = new RefreshCoordinator(db, { warn: () => undefined })
	const calls: string[] = []
	const server = createDashboardServer(db, jobs, {
		add: async id => { calls.push(id) },
		resolve: async input => input,
		refresh: () => { calls.push('refresh') },
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const id = 'UCabcdefghijklmnopqrstuv'
	try {
		const bad = await axios.post(`${base}/api/channels`, { channelId: id }, {
			headers: { Origin: 'http://other.example' }, validateStatus: () => true,
		})
		expect(bad.status).toBe(403)
		const invalid = await axios.post(`${base}/api/channels`,
			{ channelId: 'invalid' }, { validateStatus: () => true })
		expect(invalid.status).toBe(400)
		expect(calls).toEqual([])
		const result = await axios.post(`${base}/api/channels`, { channelId: id })
		expect(result.status).toBe(202)
		expect(calls).toEqual([id, 'refresh'])
		const resolved = await axios.post(`${base}/api/channels/resolve`,
			{ input: id })
		expect(resolved.data.channelId).toBe(id)
	} finally {
		await new Promise<void>((resolve, reject) => server.close(err =>
			err ? reject(err) : resolve()))
		await db.close()
	}
})
