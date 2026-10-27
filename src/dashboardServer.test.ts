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
		const filtered = await axios.get(`${base}/api/videos?search=nomatch`)
		expect(filtered.data.total).toBe(0)
		expect((await axios.get(`${base}/api/videos?limit=0`,
			{ validateStatus: () => true })).status).toBe(400)
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
		setNotify: async (id, notify) => { calls.push(`${id}:${notify}`) },
		manualMode: () => true,
		manualNotify: () => true,
		refresh: kind => { calls.push(kind) },
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
		expect(calls).toEqual([id, 'subscriptions'])
		const resolved = await axios.post(`${base}/api/channels/resolve`,
			{ input: id })
		expect(resolved.data.channelId).toBe(id)
		const refresh = await axios.post(`${base}/api/refresh`, { kind: 'videos' })
		expect(refresh.status).toBe(202)
		expect(calls).toEqual([id, 'subscriptions', 'videos'])
		const invalidRefresh = await axios.post(`${base}/api/refresh`,
			{ kind: 'other' }, { validateStatus: () => true })
		expect(invalidRefresh.status).toBe(400)
		const muted = await axios.post(`${base}/api/channels/notify`,
			{ channelId: id, notify: false })
		expect(muted.data.notify).toBe(false)
		expect(calls).toContain(`${id}:false`)
		let finish!: () => void
		const hold = new Promise<void>(resolve => { finish = resolve })
		const work = jobs.run('videos', async () => {
			await hold
			return { status: 'success', total: 0, succeeded: 0, failed: 0,
				skipped: 0, failedChannels: [] }
		})
		try {
			const status = await axios.get(`${base}/api/refresh`, { timeout: 1000 })
			expect(['queued', 'running']).toContain(status.data.videos.state)
		} finally { finish(); await work }
	} finally {
		await new Promise<void>((resolve, reject) => server.close(err =>
			err ? reject(err) : resolve()))
		await db.close()
	}
})
