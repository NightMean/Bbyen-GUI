import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { activateConfirmedCookie } from './activateCookie'
import { oauthTokenHash, recoverOAuthCleanup } from './oauthCleanup'

test('activates a confirmed profile in the real database store', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-activate-'))
	const filename = path.join(dir, 'database.sqlite')
	const db = await init({ filename })
	const config = { mode: 'whitelist', database: { filename } } as Config
	const store = new CookieConnectionStore(db)
	const previews = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
			profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
				selected: true, selectable: true }] }),
		fetch: async () => [{ channelId: 'UC0000000000000000000002',
			title: 'Channel', notificationState: 'all', isAllNotifications: true }],
	})
	try {
		const candidate = await previews.inspect('fixture')
		const preview = await previews.compare(candidate.candidateId,
			candidate.profiles[0].profileId)
		await activateConfirmedCookie(config, store, previews,
			candidate.candidateId, preview.previewId)
		expect(config.mode).toBe('cookie')
		expect((await store.status())?.channelId).toBe('UC0000000000000000000001')
		expect((await db.get('SELECT deleted FROM subscriptions')).deleted).toBe(0)
	} finally {
		previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test('switches API tracking to cookies and removes only the reviewed grant',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-cookie-'))
		const filename = path.join(dir, 'database.sqlite')
		const token = path.join(dir, '.google-auth-token.json')
		const client = path.join(dir, 'google-credentials.json')
		const db = await init({ filename })
		const config = { mode: 'youtube', database: { filename } } as Config
		const store = new CookieConnectionStore(db)
		const sourceRevision = async () => `${config.mode}:${
			await oauthTokenHash(dir) ?? 'missing'}`
		const previews = new CookiePreviewService(db, {
			discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
				profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
					selected: true, selectable: true }] }),
			fetch: async () => [{ channelId: 'UC0000000000000000000002',
				title: 'Channel', notificationState: 'all', isAllNotifications: true }],
		}, Date.now, sourceRevision)
		try {
			await fs.writeFile(token, 'old-token-fixture')
			await fs.writeFile(client, 'client-fixture')
			const candidate = await previews.inspect('fixture')
			const preview = await previews.compare(candidate.candidateId,
				candidate.profiles[0].profileId)
			await activateConfirmedCookie(config, store, previews,
				candidate.candidateId, preview.previewId, { directory: dir,
					sourceRevision, recover: () => recoverOAuthCleanup(db, dir) })
			expect(config.mode).toBe('cookie')
			expect(await store.status()).not.toBeNull()
			await expect(fs.stat(token)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await fs.readFile(client, 'utf8')).toBe('client-fixture')
			expect(await store.oauthCleanupPending()).toBe(false)
			expect(await db.all('SELECT id FROM channel_added_batches')).toEqual([])
		} finally {
			previews.dispose(); await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('preserves API authority if its grant changes after the preview',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-cookie-'))
		const filename = path.join(dir, 'database.sqlite')
		const token = path.join(dir, '.google-auth-token.json')
		const db = await init({ filename })
		const config = { mode: 'youtube', database: { filename } } as Config
		const store = new CookieConnectionStore(db)
		const sourceRevision = async () => `${config.mode}:${
			await oauthTokenHash(dir) ?? 'missing'}`
		const previews = new CookiePreviewService(db, {
			discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
				profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
					selected: true, selectable: true }] }),
			fetch: async () => [{ channelId: 'UC0000000000000000000002',
				title: 'Channel', notificationState: 'all', isAllNotifications: true }],
		}, Date.now, sourceRevision)
		try {
			await fs.writeFile(token, 'old-fixture')
			const candidate = await previews.inspect('fixture')
			const preview = await previews.compare(candidate.candidateId,
				candidate.profiles[0].profileId)
			await fs.writeFile(token, 'replacement-fixture')
			await expect(activateConfirmedCookie(config, store, previews,
				candidate.candidateId, preview.previewId, { directory: dir,
					sourceRevision, recover: () => recoverOAuthCleanup(db, dir) }))
				.rejects.toThrow()
			expect(config.mode).toBe('youtube')
			expect(await store.status()).toBeNull()
			expect(await fs.readFile(token, 'utf8')).toBe('replacement-fixture')
		} finally {
			previews.dispose(); await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('retains a replaced grant and resumes cleanup after restart', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-cookie-'))
	const filename = path.join(dir, 'database.sqlite')
	const token = path.join(dir, '.google-auth-token.json')
	let db = await init({ filename })
	const config = { mode: 'youtube', database: { filename } } as Config
	const store = new CookieConnectionStore(db)
	const sourceRevision = async () => `${config.mode}:${
		await oauthTokenHash(dir) ?? 'missing'}`
	const previews = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
			profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
				selected: true, selectable: true }] }),
		fetch: async () => [{ channelId: 'UC0000000000000000000002',
			title: 'Channel', notificationState: 'all', isAllNotifications: true }],
	}, Date.now, sourceRevision)
	try {
		await fs.writeFile(token, 'old-fixture')
		const candidate = await previews.inspect('fixture')
		const preview = await previews.compare(candidate.candidateId,
			candidate.profiles[0].profileId)
		await activateConfirmedCookie(config, store, previews,
			candidate.candidateId, preview.previewId, { directory: dir,
				sourceRevision, recover: async () => {
					await fs.writeFile(token, 'replacement-fixture')
					return recoverOAuthCleanup(db, dir)
				} })
		expect(config.mode).toBe('cookie')
		expect(await store.oauthCleanupPending()).toBe(true)
		await db.close()
		db = await init({ filename })
		expect(await recoverOAuthCleanup(db, dir)).toBe(false)
		expect(await fs.readFile(token, 'utf8')).toBe('replacement-fixture')
		await fs.unlink(token)
		expect(await recoverOAuthCleanup(db, dir)).toBe(true)
		expect(await new CookieConnectionStore(db).status()).not.toBeNull()
	} finally {
		previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test('adds a matching cookie profile to API mode without deleting its grant',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-combined-'))
		const filename = path.join(dir, 'database.sqlite')
		const token = path.join(dir, '.google-auth-token.json')
		let db = await init({ filename })
		const config = { mode: 'youtube', database: { filename } } as Config
		const store = new CookieConnectionStore(db)
		const revision = async () => `${config.mode}:${await oauthTokenHash(dir)}`
		const profileId = 'UC0000000000000000000001'
		const verify = async (id: string) => {
			if (id !== profileId) throw new Error('Profiles differ.')
		}
		const previews = new CookiePreviewService(db, {
			discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
				profiles: [{ name: 'Profile', channelId: profileId,
					selected: true, selectable: true }] }),
			fetch: async () => [{ channelId: 'UC0000000000000000000002',
				title: 'Channel', notificationState: 'all', isAllNotifications: true }],
		}, Date.now, revision)
		try {
			await fs.writeFile(token, 'grant-fixture')
			const candidate = await previews.inspect('fixture')
			const preview = await previews.compare(candidate.candidateId,
				candidate.profiles[0].profileId, verify)
			await activateConfirmedCookie(config, store, previews,
				candidate.candidateId, preview.previewId, { directory: dir,
					sourceRevision: revision, verifyApiProfile: verify,
					recover: () => recoverOAuthCleanup(db, dir) })
			expect(config.mode).toBe('cookie')
			expect(config.apiEnrichment).toBe(true)
			expect(await fs.readFile(token, 'utf8')).toBe('grant-fixture')
			expect(await store.oauthCleanupPending()).toBe(false)
			await db.close()
			db = await init({ filename })
			expect(await db.get('SELECT profileKey FROM combined_connection'))
				.toEqual({ profileKey: profileId })
			expect(await db.all('SELECT id FROM channel_added_batches')).toEqual([])
		} finally {
			previews.dispose(); await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('does not switch when the API profile changes after review', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-combined-'))
	const filename = path.join(dir, 'database.sqlite')
	const db = await init({ filename })
	const config = { mode: 'youtube', database: { filename } } as Config
	const store = new CookieConnectionStore(db)
	let matches = true
	const verify = async () => {
		if (!matches) throw new Error('Profiles differ.')
	}
	const previews = new CookiePreviewService(db, {
		discover: async () => ({ cookieHeader: 'SAPISID=synthetic-fixture',
			profiles: [{ name: 'Profile', channelId: 'UC0000000000000000000001',
				selected: true, selectable: true }] }),
		fetch: async () => [{ channelId: 'UC0000000000000000000002',
			title: 'Channel', notificationState: 'all', isAllNotifications: true }],
	})
	try {
		const candidate = await previews.inspect('fixture')
		const preview = await previews.compare(candidate.candidateId,
			candidate.profiles[0].profileId, verify)
		matches = false
		await expect(activateConfirmedCookie(config, store, previews,
			candidate.candidateId, preview.previewId, { directory: dir,
				sourceRevision: async () => '', verifyApiProfile: verify,
				recover: () => recoverOAuthCleanup(db, dir) })).rejects.toThrow()
		expect(config.mode).toBe('youtube')
		expect(await store.read()).toBeNull()
		expect(await db.get('SELECT id FROM combined_connection')).toBeUndefined()
	} finally {
		previews.dispose(); await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})
