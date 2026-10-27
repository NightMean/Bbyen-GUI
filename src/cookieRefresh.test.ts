import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { createCookieRefresh } from './cookieRefresh'
import { IncidentReporter } from './incidentReporter'
import { CookieSessionError } from './lib/cookieSessionError'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { readCookieFile } from './cookieFile'
import { CookieFileRecovery } from './cookieFileRecovery'
import { RefreshResult } from './refreshResult'

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

test('renews from an updated file for the same selected profile', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-renew-'))
	const db = await init({ filename: path.join(dir, 'database.sqlite') })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie', logging: { emailOnError: true } } as Config
	const mailers = { sendErrorEmail: vi.fn() }
	const fetch = vi.fn(async options => {
		if (options.cookie === 'SAPISID=old-fixture') {
			throw new CookieSessionError('expired')
		}
		expect(options.targetProfile?.channelId).toBe(profile.channelId)
		return [{ ...channels[0], notificationState: 'personalized' as const,
			isAllNotifications: false }]
	})
	try {
		const old = await store.activate('SAPISID=old-fixture', profile, channels)
		await fs.writeFile(path.join(dir, 'cookies.txt'), JSON.stringify([
			{ name: 'SAPISID', value: 'new-fixture', domain: '.youtube.com',
				path: '/' },
		]))
		const refresh = createCookieRefresh({ store, config, logger, fetch,
			loadReplacement: () => readCookieFile(dir),
			alerts: new IncidentReporter(db, logger) })
		expect((await refresh(mailers)).status).toBe('success')
		const stored = await store.read()
		expect(stored?.cookieHeader).toBe('SAPISID=new-fixture')
		expect(stored?.generation).not.toBe(old)
		expect(await store.markStale(old)).toBe(false)
		expect((await db.get('SELECT deleted FROM subscriptions')).deleted).toBe(1)
		expect(mailers.sendErrorEmail).toHaveBeenCalledTimes(1)
		expect((await db.get('SELECT resolvedAt FROM incidents')).resolvedAt)
			.toBeTruthy()
	} finally {
		await db.close(); await fs.rm(dir, { recursive: true, force: true })
	}
})

test('rejects an unverifiable replacement and preserves the old connection',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie',
			logging: { emailOnError: true } } as Config
		const mailers = { sendErrorEmail: vi.fn().mockResolvedValue(undefined) }
		const fetch = vi.fn(async options => {
			if (options.cookie === 'SAPISID=old-fixture') {
				throw new CookieSessionError('expired')
			}
			throw new Error('Selected profile changed')
		})
		try {
			await store.activate('SAPISID=old-fixture', profile, channels)
			const refresh = createCookieRefresh({ store, config, logger, fetch,
				loadReplacement: async () => 'SAPISID=other-fixture',
				alerts: new IncidentReporter(db, logger) })
			expect((await refresh(mailers)).errorCategory).toBe('auth')
			expect((await store.read())?.cookieHeader).toBe('SAPISID=old-fixture')
			expect((await store.status())?.stale).toBe(true)
			expect(mailers.sendErrorEmail).toHaveBeenCalledTimes(1)
		} finally { await db.close() }
	})

test('a stale renewal cannot replace a newer cookie generation', async () => {
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	const config = { mode: 'cookie', logging: { emailOnError: true } } as Config
	const mailers = { sendErrorEmail: vi.fn() }
	try {
		await store.activate('SAPISID=old-fixture', profile, channels)
		const refresh = createCookieRefresh({ store, config, logger,
			alerts: new IncidentReporter(db, logger),
			loadReplacement: async () => 'SAPISID=file-fixture',
			fetch: async options => {
				if (options.cookie === 'SAPISID=old-fixture') {
					throw new CookieSessionError('expired')
				}
				await store.activate('SAPISID=newer-fixture', profile, channels)
				return channels
			} })
		expect((await refresh(mailers)).status).toBe('failed')
		expect((await store.read())?.cookieHeader).toBe('SAPISID=newer-fixture')
		expect((await store.status())?.stale).toBe(false)
		expect(mailers.sendErrorEmail).not.toHaveBeenCalled()
	} finally { await db.close() }
})

test('keeps tracking stale when a renewed cookie has unconfirmed bells',
	async () => {
		const db = await init({ filename: ':memory:' })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie',
			logging: { emailOnError: true } } as Config
		const mailers = { sendErrorEmail: vi.fn().mockResolvedValue(undefined) }
		try {
			await store.activate('SAPISID=old-fixture', profile, channels)
			const refresh = createCookieRefresh({ store, config, logger,
				alerts: new IncidentReporter(db, logger),
				loadReplacement: async () => 'SAPISID=new-fixture',
				fetch: async options => {
					if (options.cookie === 'SAPISID=old-fixture') {
						throw new CookieSessionError('expired')
					}
					return [{ ...channels[0], notificationState: 'unknown',
						isAllNotifications: false }]
				} })
			expect((await refresh(mailers)).status).toBe('failed')
			expect((await store.read())?.cookieHeader).toBe('SAPISID=new-fixture')
			expect((await store.status())?.stale).toBe(true)
			expect((await db.get('SELECT deleted FROM subscriptions')).deleted)
				.toBe(0)
			expect(mailers.sendErrorEmail).toHaveBeenCalledTimes(2)
		} finally { await db.close() }
	})

test('detects an updated export and recovers without recreating the service',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-auto-renew-'))
		const db = await init({ filename: path.join(dir, 'database.sqlite') })
		const store = new CookieConnectionStore(db)
		const config = { mode: 'cookie',
			logging: { emailOnError: true } } as Config
		const mailers = { sendErrorEmail: vi.fn().mockResolvedValue(undefined) }
		try {
			await store.activate('SAPISID=old-fixture', profile, channels)
			const refresh = createCookieRefresh({ store, config, logger,
				alerts: new IncidentReporter(db, logger),
				loadReplacement: () => readCookieFile(dir),
				fetch: async options => {
					if (options.cookie === 'SAPISID=old-fixture') {
						throw new CookieSessionError('expired')
					}
					return channels
				} })
			expect((await refresh(mailers)).status).toBe('failed')
			expect(config.cookieStale).toBe(true)
			let pending: Promise<RefreshResult> | undefined
			const watcher = new CookieFileRecovery(config, store,
				() => readCookieFile(dir), () => { pending = refresh(mailers) })
			await fs.writeFile(path.join(dir, 'cookies.txt'), 'SAPISID=new-fixture')
			await watcher.check()
			expect((await pending)?.status).toBe('success')
			expect(config.cookieStale).toBe(false)
			expect((await store.read())?.cookieHeader).toBe('SAPISID=new-fixture')
			expect((await db.get('SELECT resolvedAt FROM incidents')).resolvedAt)
				.toBeTruthy()
		} finally {
			await db.close(); await fs.rm(dir, { recursive: true, force: true })
		}
	})
