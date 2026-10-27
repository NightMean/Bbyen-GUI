import { AddressInfo } from 'net'
import axios from 'axios'
import { expect, test } from 'vitest'
import { init } from './database'
import { createDashboardServer, dashboardPort } from './dashboardServer'
import { RefreshCoordinator } from './refreshCoordinator'
import { Config } from './config'
import { SubscriptionImportService } from './subscriptionImportService'
import { CookiePreviewService } from './cookiePreview'
import { CookieConnectionStore } from './cookieConnection'
import { ManualSourceSwitch } from './manualSourceSwitch'

test('serves persisted data and rejects unsupported requests', async () => {
	const db = await init({ filename: ':memory:' })
	await db.run(`INSERT INTO subscriptions
		(channelId, channelThumbnail, channelTitle) VALUES ('channel', '', 'Test')`)
	await db.run(`INSERT INTO video_observations
		(videoId, channelId, title, emailOutcome)
		VALUES ('video', 'channel', 'Example', 'sent')`)
	await db.run(`INSERT INTO incidents (id, source, category, openedAt,
		lastObservedAt, occurrences, emailState)
		VALUES ('incident', 'smtp', 'other', '2026-01-01',
			'2026-01-01', 1, 'sent')`)
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
		expect((await axios.get(`${base}/api/incidents`)).data.incidents[0].source)
			.toBe('smtp')
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
	const id = 'UCabcdefghijklmnopqrstuv'
	const config = { mode: 'whitelist', whitelistedChannelIds: [{ id }],
		email: { auth: { pass: 'fixture' } } } as Config
	const cookieStore = new CookieConnectionStore(db)
	const cookiePreviews = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
			profiles: [{ name: 'Profile', selected: true, selectable: true,
				channelId: id }] }),
		fetch: async () => [{ channelId: id, title: 'Channel',
			notificationState: 'all', isAllNotifications: true }],
	})
	const server = createDashboardServer(db, jobs, {
		config,
		imports: new SubscriptionImportService('unused', {} as Config),
		cookiePreviews,
		cookieStatus: () => cookieStore.status(),
		cookieCleanupPending: () => cookieStore.cleanupPending(),
		manualSwitch: new ManualSourceSwitch(db, config, 'unused', 'unused',
			'unused', cookiePreviews),
		activateCookie: async (candidate, preview) => {
			const confirmed = await cookiePreviews.confirm(candidate, preview)
			await cookieStore.activate(confirmed.cookieHeader, confirmed.profile,
				confirmed.channels)
			config.mode = 'cookie'
		},
		add: async id => { calls.push(id) },
		resolve: async input => input,
		setNotify: async (id, notify) => { calls.push(`${id}:${notify}`) },
		remove: async id => { calls.push(`remove:${id}`) },
		manualMode: () => config.mode === 'whitelist',
		manualNotify: () => true,
		emailSettings: () => ({ settings: { host: 'smtp.example.test', port: 465,
			secure: true, sendingContact: 'sender@example.test',
			destination: 'recipient@example.test' }, userFromEnvironment: false,
		passFromEnvironment: false }),
		saveEmail: async () => undefined,
		saveCredentials: async () => undefined,
		testEmail: async () => 'sent',
		saveSchedule: async () => undefined,
		saveGeneral: async () => undefined,
		refresh: kind => { calls.push(kind) },
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	try {
		const exported = await axios.get(`${base}/api/subscriptions/export`)
		expect(exported.data.whitelistedChannelIds).toEqual([{ id }])
		expect(exported.data.blacklistedChannelIds).toBeNull()
		expect(JSON.stringify(exported.data)).not.toContain('fixture')
		const bad = await axios.post(`${base}/api/channels`, { channelId: id }, {
			headers: { Origin: 'http://other.example' }, validateStatus: () => true,
		})
		expect(bad.status).toBe(403)
		const invalid = await axios.post(`${base}/api/channels`,
			{ channelId: 'invalid' }, { validateStatus: () => true })
		expect(invalid.status).toBe(400)
		const invalidBacklog = await axios.post(`${base}/api/channels`,
			{ channelId: id, initialBacklog: { mode: 'newest', count: 0 } },
			{ validateStatus: () => true })
		expect(invalidBacklog.status).toBe(400)
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
		await axios.post(`${base}/api/channels/remove`, { channelId: id })
		expect(calls.slice(-2)).toEqual([`remove:${id}`, 'subscriptions'])
		const inspected = await axios.post(`${base}/api/cookies/inspect`,
			{ cookie: 'SAPISID=synthetic-fixture' })
		expect(JSON.stringify(inspected.data)).not.toContain('synthetic-fixture')
		const compared = await axios.post(`${base}/api/cookies/compare`, {
			candidateId: inspected.data.candidateId,
			profileId: inspected.data.profiles[0].profileId,
		})
		expect(compared.data.start[0].channelId).toBe(id)
		await axios.post(`${base}/api/cookies/activate`, {
			candidateId: inspected.data.candidateId,
			previewId: compared.data.previewId,
		})
		const cookieStatus = await axios.get(`${base}/api/cookies/status`)
		expect(cookieStatus.data.mode).toBe('cookie')
		expect(JSON.stringify(cookieStatus.data)).not.toContain('synthetic-fixture')
		const cookieChannels = (await axios.get(`${base}/api/channels`)).data
		expect(cookieChannels.cookieMode).toBe(true)
		expect(cookieChannels.cookieStale).toBe(false)
		expect(cookieChannels.channels[0].bellState).toBe('all')
		const events = (await axios.get(`${base}/api/channel-events`)).data.events
		expect(events).toMatchObject([{ channelId: id, previousState: null,
			currentState: 'all' }])
		await db.run('UPDATE subscriptions SET channelTitle=? WHERE channelId=?',
			'Renamed', id)
		await db.run(`INSERT INTO channel_title_events
			(channelId, previousTitle, currentTitle, observedAt)
			VALUES (?, 'Old', 'Older', '2000-01-01T00:00:00.000Z')`, id)
		const titles = (await axios.get(`${base}/api/title-events`)).data.events
		expect(titles).toMatchObject([{ previousTitle: 'Channel',
			currentTitle: 'Renamed' }])
		config.cookieStale = true
		expect((await axios.get(`${base}/api/channels`)).data.cookieStale)
			.toBe(true)
		const blocked = await axios.post(`${base}/api/channels`, { channelId: id },
			{ validateStatus: () => true })
		expect(blocked.status).toBe(409)
		expect(calls.filter(call => call === id)).toHaveLength(1)
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
		cookiePreviews.dispose()
		await new Promise<void>((resolve, reject) => server.close(err =>
			err ? reject(err) : resolve()))
		await db.close()
	}
})
