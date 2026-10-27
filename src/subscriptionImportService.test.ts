import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { SubscriptionImportService } from './subscriptionImportService'

test('previews conflicts and requires consent for partial import', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-import-'))
	const file = path.join(dir, 'channels.json')
	const id = 'UCabcdefghijklmnopqrstuv'
	const added = 'UC0123456789012345678901'
	const config = {} as Config
	try {
		await fs.writeFile(file, JSON.stringify({ keep: 'unrelated',
			whitelistedChannelIds: [{ id, notify: false, custom: 'preserved' }] }))
		const service = new SubscriptionImportService(file, config)
		const input = { whitelistedChannelIds: [{ id, notify: true }, added, 'bad'],
			blacklistedChannelIds: [] }
		const preview = await service.preview(input)
		expect(preview.added).toBe(1)
		expect(preview.problems).toHaveLength(1)
		expect(preview.createdLists).toContain('blacklistedChannelIds')
		expect(preview.conflicts[0]).toMatchObject({ field: 'notify',
			existing: false, incoming: true })
		await expect(service.apply(preview.id, 'keep', false)).rejects.toThrow()
		await service.apply(preview.id, 'keep', true)
		const saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.keep).toBe('unrelated')
		expect(saved.whitelistedChannelIds).toEqual([{ id, notify: false,
			custom: 'preserved' },
		{ id: added }])
		expect(config.channelSettingsById?.get(id)?.notify).toBe(false)
		const next = await service.preview(input)
		await service.apply(next.id, 'replace', true)
		expect(config.channelSettingsById?.get(id)?.notify).toBe(true)
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('rejects stale and expired previews without writing', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-import-'))
	const file = path.join(dir, 'channels.json')
	let now = 0
	try {
		await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [] }))
		const service = new SubscriptionImportService(file, {} as Config, () => now)
		const preview = await service.preview({ whitelistedChannelIds: [
			'UCabcdefghijklmnopqrstuv',
		] })
		const changed = JSON.stringify({ whitelistedChannelIds: [
			'UC0123456789012345678901',
		] })
		await fs.writeFile(file, changed)
		await expect(service.apply(preview.id, 'replace', false)).rejects.toThrow()
		expect(await fs.readFile(file, 'utf8')).toBe(changed)
		const expired = await service.preview({ whitelistedChannelIds: [] })
		now += 600_001
		await expect(service.apply(expired.id, 'keep', false)).rejects.toThrow()
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('detects preferences that conflict across channel lists', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-import-cross-'))
	const file = path.join(dir, 'channels.json')
	const id = 'UCabcdefghijklmnopqrstuv'
	const config = {} as Config
	try {
		await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [
			{ id, notify: false },
		] }))
		const service = new SubscriptionImportService(file, config)
		const input = { manualChannelIds: [{ id, notify: true }] }
		const preview = await service.preview(input)
		expect(preview.conflicts[0]).toMatchObject({
			existing: false, incoming: true })
		await service.apply(preview.id, 'keep', false)
		expect(config.channelSettingsById?.get(id)?.notify).toBe(false)
		const replace = await service.preview(input)
		await service.apply(replace.id, 'replace', false)
		expect(config.channelSettingsById?.get(id)?.notify).toBe(true)
	} finally { await fs.rm(dir, { recursive: true, force: true }) }
})
