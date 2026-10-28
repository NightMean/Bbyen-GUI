import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { expect, test } from 'vitest'
import { init } from './database'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { CombinedMode } from './combinedMode'

const profileId = 'UC0000000000000000000001'
const channelId = 'UC0000000000000000000002'
const profile = { name: 'Profile', channelId: profileId, selected: true,
	selectable: true }
const channels = [{ channelId, title: 'Channel', notificationState: 'all',
	isAllNotifications: true }] as const

const fixture = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-combined-'))
	const token = path.join(directory, '.google-auth-token.json')
	await fs.writeFile(token, 'fixture-token')
	const db = await init({ filename: ':memory:' })
	const store = new CookieConnectionStore(db)
	await store.activate('SAPISID=synthetic-fixture', profile, [...channels])
	const config = { mode: 'cookie' } as Config
	let apiId = profileId
	const service = { channels: { list: async () => ({ data: { items: [
		{ id: apiId, snippet: { title: 'Profile' } },
	] } }) } } as never
	const revision = async () => createHash('sha256')
		.update(await fs.readFile(token).catch(() => Buffer.from('missing')))
		.digest('hex')
	return { db, store, config, directory, token,
		setApiId: (id: string) => { apiId = id },
		mode: new CombinedMode(db, config, store, service,
			async () => ({} as never),
			revision, directory) }
}

test('enables matching sources and disables API with durable cleanup',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.mode.review('enable')
			expect(preview.continuing.map(row => row.channelId)).toEqual([channelId])
			expect(await f.mode.apply(preview.previewId))
				.toEqual({ cleanupPending: false, apiEnrichment: true })
			expect(f.config.apiEnrichment).toBe(true)
			expect(await f.db.get('SELECT profileKey FROM combined_connection'))
				.toEqual({ profileKey: profileId })
			const disable = await f.mode.review('disable')
			expect(await f.mode.apply(disable.previewId))
				.toEqual({ cleanupPending: false, apiEnrichment: false })
			expect(f.config.apiEnrichment).toBe(false)
			expect(await f.store.read()).not.toBeNull()
			await expect(fs.stat(f.token)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await f.db.get('SELECT id FROM combined_connection'))
				.toBeUndefined()
		} finally {
			await f.db.close(); await fs.rm(f.directory, { recursive: true })
		}
	})

test('rejects profile mismatch or changes after review', async () => {
	const f = await fixture()
	try {
		f.setApiId(channelId)
		await expect(f.mode.review('enable')).rejects.toThrow(/differ/)
		f.setApiId(profileId)
		const preview = await f.mode.review('enable')
		await fs.writeFile(f.token, 'replacement-fixture')
		await expect(f.mode.apply(preview.previewId)).rejects.toThrow(/changed/)
		expect(await fs.readFile(f.token, 'utf8')).toBe('replacement-fixture')
		expect(await f.db.get('SELECT id FROM combined_connection')).toBeUndefined()
	} finally {
		await f.db.close(); await fs.rm(f.directory, { recursive: true })
	}
})
