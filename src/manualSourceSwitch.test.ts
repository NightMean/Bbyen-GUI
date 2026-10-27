import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { ManualSourceSwitch } from './manualSourceSwitch'
import { legacyCookieHash, recoverCookieCleanup } from './cookieCleanup'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const profile = { name: 'Profile', selected: true,
	channelId: 'UC0000000000000000000003', selectable: true }
const channels = [
	{ channelId: first, title: 'First', notificationState: 'all' as const,
		isAllNotifications: true },
	{ channelId: second, title: 'Second',
		notificationState: 'personalized' as const, isAllNotifications: false },
]

test('switches tracked channels to manual and deletes the saved cookies',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-switch-'))
		const configFile = path.join(dir, 'config.json')
		const channelsFile = path.join(dir, 'channels.json')
		const db = await init({ filename: path.join(dir, 'database.sqlite') })
		const config = { mode: 'cookie' } as Config
		const previews = new CookiePreviewService(db)
		try {
			await fs.writeFile(configFile, JSON.stringify({ mode: 'whitelist' }))
			await fs.writeFile(channelsFile, JSON.stringify({ whitelistedChannelIds: [
				{ id: first, notify: false }, { id: second, notify: true },
			] }))
			await fs.writeFile(path.join(dir, 'cookies.txt'), 'synthetic-fixture')
			await new CookieConnectionStore(db).activate(
				'SAPISID=synthetic-fixture', profile, channels)
			const service = new ManualSourceSwitch(db, config, configFile,
				channelsFile, dir, previews)
			const preview = await service.preview()
			expect(preview.continuing.map(c => c.channelId)).toEqual([first])
			expect(preview.legacyCookieFile).toBe(true)
			expect(await service.apply(preview.previewId))
				.toEqual({ cleanupPending: false })
			expect(config.mode).toBe('whitelist')
			expect(config.whitelistedChannelIds?.map(c => c.id)).toEqual([first])
			expect(config.channelSettingsById?.get(first)?.notify).toBe(false)
			expect(config.savedChannelSettings?.some(c => c.id === second)).toBe(true)
			expect(await new CookieConnectionStore(db).status()).toBeNull()
			await expect(fs.stat(path.join(dir, 'cookies.txt')))
				.rejects.toMatchObject({ code: 'ENOENT' })
		} finally { previews.dispose(); await db.close()
			await fs.rm(dir, { recursive: true, force: true }) }
	})

test('rejects a stale source preview before deleting cookies', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-switch-'))
	const configFile = path.join(dir, 'config.json')
	const channelsFile = path.join(dir, 'channels.json')
	const db = await init({ filename: path.join(dir, 'database.sqlite') })
	const config = { mode: 'cookie' } as Config
	const previews = new CookiePreviewService(db)
	try {
		await fs.writeFile(configFile, JSON.stringify({ mode: 'whitelist' }))
		await fs.writeFile(channelsFile,
			JSON.stringify({ whitelistedChannelIds: [] }))
		await new CookieConnectionStore(db).activate(
			'SAPISID=synthetic-fixture', profile, channels)
		const service = new ManualSourceSwitch(db, config, configFile,
			channelsFile, dir, previews)
		const preview = await service.preview()
		await fs.writeFile(channelsFile,
			JSON.stringify({ whitelistedChannelIds: [first] }))
		await expect(service.apply(preview.previewId)).rejects.toThrow(/changed/i)
		expect((await new CookieConnectionStore(db).status())?.channelId)
			.toBe(profile.channelId)
		expect(config.mode).toBe('cookie')
	} finally { previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true }) }
})

test('retains a changed legacy cookie during deferred cleanup', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cleanup-'))
	const db = await init({ filename: path.join(dir, 'database.sqlite') })
	const file = path.join(dir, 'cookies.txt')
	try {
		await fs.writeFile(file, 'original-fixture')
		const digest = await legacyCookieHash(dir)
		await db.run('INSERT INTO cookie_cleanup (id, legacyHash) VALUES (1, ?)',
			digest)
		await fs.writeFile(file, 'replacement-fixture')
		expect(await recoverCookieCleanup(db, dir)).toBe(false)
		expect(await fs.readFile(file, 'utf8')).toBe('replacement-fixture')
		await expect(new CookieConnectionStore(db).activate(
			'SAPISID=synthetic-fixture', profile, channels))
			.rejects.toThrow(/cleanup/i)
	} finally {
		await db.close(); await fs.rm(dir, { recursive: true, force: true })
	}
})

test('keeps cookie authority when deletion fails', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-switch-fail-'))
	const configFile = path.join(dir, 'config.json')
	const channelsFile = path.join(dir, 'channels.json')
	const db = await init({ filename: path.join(dir, 'database.sqlite') })
	const config = { mode: 'cookie' } as Config
	const previews = new CookiePreviewService(db)
	try {
		await fs.writeFile(configFile, JSON.stringify({ mode: 'whitelist' }))
		await fs.writeFile(channelsFile,
			JSON.stringify({ whitelistedChannelIds: [] }))
		await new CookieConnectionStore(db).activate(
			'SAPISID=synthetic-fixture', profile, channels)
		await db.exec(`CREATE TRIGGER reject_cookie_delete BEFORE DELETE
			ON cookie_connection BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
		const service = new ManualSourceSwitch(db, config, configFile,
			channelsFile, dir, previews)
		const preview = await service.preview()
		await expect(service.apply(preview.previewId)).rejects.toThrow()
		expect(config.mode).toBe('cookie')
		expect(await new CookieConnectionStore(db).status()).not.toBeNull()
		expect(JSON.parse(await fs.readFile(channelsFile, 'utf8'))
			.whitelistedChannelIds).toEqual([{ id: first }])
		await db.exec('DROP TRIGGER reject_cookie_delete')
		const retry = await service.preview()
		expect((await service.apply(retry.previewId)).cleanupPending).toBe(false)
	} finally { previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true }) }
})

test('resumes pending legacy cookie cleanup after a restart', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cleanup-restart-'))
	const filename = path.join(dir, 'database.sqlite')
	const cookie = path.join(dir, 'cookies.txt')
	try {
		await fs.writeFile(cookie, 'synthetic-fixture')
		const db = await init({ filename })
		await db.run('INSERT INTO cookie_cleanup (id, legacyHash) VALUES (1, ?)',
			await legacyCookieHash(dir))
		await db.close()
		const reopened = await init({ filename })
		try {
			expect(await recoverCookieCleanup(reopened, dir)).toBe(true)
			await expect(fs.stat(cookie)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await reopened.get('SELECT id FROM cookie_cleanup'))
				.toBeUndefined()
		} finally { await reopened.close() }
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})
