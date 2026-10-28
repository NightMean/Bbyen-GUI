import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CookiePreviewService } from './cookiePreview'
import { ApiSourceSwitch, IncompleteApiSnapshot, UnconfirmedCookieSnapshot }
	from './apiSourceSwitch'

vi.mock('./lib/logger', () => ({
	default: async () => ({ verbose: () => {} }),
}))
const profileId = 'UC0000000000000000000001'
const first = 'UC0000000000000000000002'
const second = 'UC0000000000000000000003'
const extra = 'UC0000000000000000000004'
const manual = 'UC0000000000000000000005'
const item = (channelId: string) => ({ id: `sub-${channelId}`,
	snippet: { resourceId: { channelId }, title: channelId,
		publishedAt: '2020-01-01T00:00:00Z' } })

const fixture = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(),
		'bbyen-api-switch-'))
	const file = path.join(directory, 'config.json')
	const token = path.join(directory, '.google-auth-token.json')
	await fs.writeFile(file, JSON.stringify({ mode: 'whitelist', other: true }))
	await fs.writeFile(token, 'token-fixture')
	await fs.writeFile(path.join(directory, 'cookies.txt'), 'cookie-fixture')
	const db = await init({ filename: path.join(directory, 'database.sqlite') })
	const store = new CookieConnectionStore(db)
	await store.activate('SAPISID=synthetic-fixture', { name: 'Profile',
		channelId: profileId, selected: true, selectable: true }, [
		{ channelId: first, title: 'First', notificationState: 'all',
			isAllNotifications: true },
		{ channelId: second, title: 'Second', notificationState: 'personalized',
			isAllNotifications: false },
	])
	await db.run('INSERT INTO videos (videoId, channelId) VALUES (?, ?)',
		'video', first)
	await db.run(`INSERT INTO subscriptions
		(channelId, channelTitle, channelThumbnail, deleted, deletedReason)
		VALUES (?, 'Deleted', 'image', 1, 'terminated')`, extra)
	const config = { mode: 'cookie', apiEnrichment: true,
		manualChannelIds: [{ id: manual }],
		emailSelectionPolicy: 'blocklist' } as Config
	const cookies = new CookiePreviewService(db)
	let omit = false
	let revision = 'first'
	const service = { channels: { list: async () => ({ data: { items: [
		{ id: profileId },
	] } }) }, subscriptions: { list: async (args: { forChannelId?: string }) => ({
		data: { items: args.forChannelId ? [] :
			[ item(first), ...(omit ? [] : [item(second)]), item(extra) ] },
	}) } } as never
	return { db, store, config, file, token, directory, cookies,
		omit: () => { omit = true }, changeRevision: () => { revision = 'second' },
		switcher: new ApiSourceSwitch(db, config, store, cookies, service,
			async () => ({} as never), async () => revision, directory, file) }
}

test('switches to API, preserving history and deleting only the cookie',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			expect(preview.continuing.map(x => x.channelId)).toEqual([first])
			expect(preview.start.map(x => x.channelId)).toEqual([second, manual])
			expect(preview.stop).toEqual([])
			expect(await f.switcher.apply(preview.previewId))
				.toEqual({ cleanupPending: false })
			expect(f.config.mode).toBe('youtube')
			expect(f.config.apiEnrichment).toBe(false)
			expect(JSON.parse(await fs.readFile(f.file, 'utf8')))
				.toMatchObject({ mode: 'youtube', emailSelectionPolicy: 'blocklist' })
			expect(await f.store.read()).toBeNull()
			await expect(fs.stat(path.join(f.directory, 'cookies.txt')))
				.rejects.toMatchObject({ code: 'ENOENT' })
			expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			expect(await f.db.all('SELECT videoId FROM videos'))
				.toEqual([{ videoId: 'video' }])
			expect(await f.db.get('SELECT deleted FROM subscriptions ' +
				'WHERE channelId=?',
			extra)).toEqual({ deleted: 1 })
			expect(await f.db.all('SELECT id FROM channel_added_batches')).toEqual([])
		} finally {
			f.cookies.dispose(); await f.db.close()
			await fs.rm(f.directory, { recursive: true })
		}
	})

test('rejects an incomplete API snapshot without changing cookie authority',
	async () => {
		const f = await fixture()
		try {
			f.omit()
			await expect(f.switcher.review())
				.rejects.toBeInstanceOf(IncompleteApiSnapshot)
			expect(f.config.mode).toBe('cookie')
			expect(await f.store.read()).not.toBeNull()
		} finally {
			f.cookies.dispose(); await f.db.close()
			await fs.rm(f.directory, { recursive: true })
		}
	})

test('requires a confirmed cookie snapshot before switching', async () => {
	const f = await fixture()
	try {
		await f.db.run('UPDATE cookie_connection SET stale=1')
		await expect(f.switcher.review())
			.rejects.toBeInstanceOf(UnconfirmedCookieSnapshot)
		expect(await f.store.read()).not.toBeNull()
	} finally {
		f.cookies.dispose(); await f.db.close()
		await fs.rm(f.directory, { recursive: true })
	}
})

test('preserves cookie authority if the API grant changes or commit fails',
	async () => {
		for (const failure of ['revision', 'transaction']) {
			const f = await fixture()
			try {
				const preview = await f.switcher.review()
				if (failure === 'revision') f.changeRevision()
				else await f.db.exec(`CREATE TRIGGER block_switch BEFORE DELETE
					ON cookie_connection BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
				await expect(f.switcher.apply(preview.previewId)).rejects.toThrow()
				expect(f.config.mode).toBe('cookie')
				expect(await f.store.read()).not.toBeNull()
				expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			} finally {
				f.cookies.dispose(); await f.db.close()
				await fs.rm(f.directory, { recursive: true })
			}
		}
	})
