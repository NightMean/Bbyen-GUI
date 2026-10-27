import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { createCookieRefresh } from './cookieRefresh'
import { IncidentReporter } from './incidentReporter'
import { CookieSessionError } from './lib/cookieSessionError'

const profile = { name: 'Profile', selected: true,
	channelId: 'UC0000000000000000000001', selectable: true }
const channels = [{ channelId: 'UC0000000000000000000002', title: 'Channel',
	notificationState: 'all' as const, isAllNotifications: true }]
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

test('retains tracking and reports cookie failure, then recovers', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie', logging: { emailOnError: true } } as Config
	const mailers = { sendErrorEmail: vi.fn().mockResolvedValue(undefined) }
	const fetch = vi.fn().mockRejectedValueOnce(new CookieSessionError('expired'))
		.mockResolvedValueOnce(channels)
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, channels)
		const refresh = createCookieRefresh({ store, config,
			alerts: new IncidentReporter(db, logger), logger, fetch })
		expect((await refresh(mailers)).errorCategory).toBe('auth')
		expect(config.cookieStale).toBe(true)
		expect((await store.status())?.stale).toBe(true)
		expect((await db.get('SELECT deleted FROM subscriptions')).deleted).toBe(0)
		expect(mailers.sendErrorEmail).toHaveBeenCalledTimes(1)
		expect((await refresh(mailers)).status).toBe('success')
		expect(config.cookieStale).toBe(false)
		expect((await store.status())?.stale).toBe(false)
		expect((await db.get('SELECT resolvedAt FROM incidents')).resolvedAt)
			.toBeTruthy()
	} finally { await db.close() }
})

test('an old cookie failure cannot mark a replacement stale', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie', logging: { emailOnError: true } } as Config
	const mailers = { sendErrorEmail: vi.fn() }
	try {
		await store.activate('SAPISID=synthetic-fixture', profile, channels)
		const refresh = createCookieRefresh({ store, config, logger,
			alerts: new IncidentReporter(db, logger), fetch: async () => {
				await store.activate('SAPISID=synthetic-fixture-2', profile, channels)
				throw new CookieSessionError('expired')
			} })
		await refresh(mailers)
		expect((await store.status())?.stale).toBe(false)
		expect(config.cookieStale).toBeUndefined()
		expect(mailers.sendErrorEmail).not.toHaveBeenCalled()
	} finally { await db.close() }
})

test('reports unknown bells as stale without revoking confirmed tracking',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie',
			logging: { emailOnError: false } } as Config
		try {
			await store.activate('SAPISID=synthetic-fixture', profile, channels)
			const refresh = createCookieRefresh({ store, config, logger,
				alerts: new IncidentReporter(db, logger), fetch: async () => [{
					...channels[0], notificationState: 'unknown',
					isAllNotifications: false,
				}] })
			expect((await refresh()).status).toBe('failed')
			expect((await store.status())?.stale).toBe(true)
			expect(config.cookieStale).toBe(true)
			expect((await db.get('SELECT deleted FROM subscriptions')).deleted)
				.toBe(0)
		} finally { await db.close() }
	})
