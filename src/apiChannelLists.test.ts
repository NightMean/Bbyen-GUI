import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test, vi } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { removeApiManualChannel, setApiChannelList } from './apiChannelLists'
import { makeEmailEligibility } from './emailPolicy'

const id = 'UC0000000000000000000001'

test('updates separate lists and preserves channel settings and membership',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-lists-'))
		const file = path.join(dir, 'channels.json')
		const db = await init({ filename: ':memory:' })
		const config = { mode: 'youtube',
			emailSelectionPolicy: 'allowlist' } as Config
		try {
			await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [
				{ id, notify: false, initialBacklog: { mode: 'all' } },
			], blacklistedChannelIds: [], custom: 3 }))
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail) VALUES (?, 'Creator', '')`,
			id)
			await setApiChannelList(db, file, config, id, 'allowlist', false)
			expect(config.whitelistedChannelIds).toEqual([])
			expect(config.channelSettingsById?.get(id)).toMatchObject({
				notify: false, initialBacklog: { mode: 'all' },
			})
			await setApiChannelList(db, file, config, id, 'blocklist', true)
			await setApiChannelList(db, file, config, id, 'allowlist', true)
			expect(config.whitelistedChannelIds).toEqual([{ id }])
			expect(config.blacklistedChannelIds).toEqual([{ id }])
			expect(makeEmailEligibility(config)(id,
				config.channelSettingsById?.get(id))).toBe('muted')
			const saved = JSON.parse(await fs.readFile(file, 'utf8'))
			expect(saved.custom).toBe(3)
			expect(await db.get(
				'SELECT deleted FROM subscriptions WHERE channelId=?', id))
				.toEqual({ deleted: 0 })
			await expect(setApiChannelList(db, file, config,
				'UC0000000000000000000002', 'allowlist', true)).rejects.toThrow()
		} finally {
			await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('rejects legacy and non-API mode changes', async () => {
	const db = await init({ filename: ':memory:' })
	try {
		await expect(setApiChannelList(db, 'unused', { mode: 'youtube' } as Config,
			id, 'allowlist', true)).rejects.toThrow(/unavailable/i)
		await expect(setApiChannelList(db, 'unused', { mode: 'cookie',
			emailSelectionPolicy: 'allowlist' } as Config, id, 'blocklist', true))
			.rejects.toThrow(/unavailable/i)
	} finally { await db.close() }
})

test('reconciles a completed write when lock cleanup fails', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-list-lock-'))
	const file = path.join(dir, 'channels.json')
	const db = await init({ filename: ':memory:' })
	const config = { mode: 'youtube',
		emailSelectionPolicy: 'allowlist' } as Config
	const unlink = fs.unlink.bind(fs)
	const spy = vi.spyOn(fs, 'unlink').mockImplementation(async target => {
		if (target === `${file}.lock`) throw new Error('fixture cleanup failed')
		return unlink(target)
	})
	try {
		await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [] }))
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, 'Creator', '')`,
		id)
		await expect(setApiChannelList(db, file, config, id, 'allowlist', true))
			.rejects.toThrow('fixture cleanup failed')
		expect(config.whitelistedChannelIds).toEqual([{ id }])
		const saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.whitelistedChannelIds).toEqual([{ id }])
	} finally {
		spy.mockRestore()
		await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})

test('removes manual tracking without changing email lists or preferences',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-remove-'))
		const file = path.join(dir, 'channels.json')
		const config = { mode: 'youtube',
			emailSelectionPolicy: 'allowlist' } as Config
		try {
			await fs.writeFile(file, JSON.stringify({
				whitelistedChannelIds: [{ id }], blacklistedChannelIds: [{ id }],
				manualChannelIds: [{ id, notify: false,
					initialBacklog: { mode: 'all' } }],
			}))
			await removeApiManualChannel(file, config, id)
			expect(config.manualChannelIds).toEqual([])
			expect(config.whitelistedChannelIds).toEqual([{ id }])
			expect(config.blacklistedChannelIds).toEqual([{ id }])
			expect(config.channelSettingsById?.get(id)).toMatchObject({
				notify: false, initialBacklog: { mode: 'all' },
			})
			await expect(removeApiManualChannel(file, config, id))
				.rejects.toThrow(/not manually tracked/i)
		} finally { await fs.rm(dir, { recursive: true, force: true }) }
	})
