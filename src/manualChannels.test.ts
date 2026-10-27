import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test } from 'vitest'
import { Config } from './config'
import { addManualChannel, setManualChannelNotify } from './manualChannels'

test('adds to both lists and preserves preferences', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-channels-'))
	const file = path.join(directory, 'channels.json')
	const id = 'UCabcdefghijklmnopqrstuv'
	const config = {} as Config
	try {
		await fs.writeFile(file, JSON.stringify({ custom: 'preserved',
			whitelistedChannelIds: [{ id, notify: false }] }))
		await addManualChannel(file, config, id)
		await addManualChannel(file, config, id)
		const saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.custom).toBe('preserved')
		expect(saved.whitelistedChannelIds).toEqual([{ id, notify: false }])
		expect(saved.manualChannelIds).toEqual([{ id }])
		expect(config.channelSettingsById?.get(id)?.notify).toBe(false)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('changes manual notification settings in memory and on disk', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-mute-'))
	const file = path.join(directory, 'channels.json')
	const id = 'UCabcdefghijklmnopqrstuv'
	const config = { mode: 'whitelist' } as Config
	try {
		await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [id],
			manualChannelIds: [{ id, notify: true }] }))
		await setManualChannelNotify(file, config, id, false)
		let saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.whitelistedChannelIds[0].notify).toBe(false)
		expect(saved.manualChannelIds[0].notify).toBe(false)
		expect(config.channelSettingsById?.get(id)?.notify).toBe(false)
		await setManualChannelNotify(file, config, id, true)
		saved = JSON.parse(await fs.readFile(file, 'utf8'))
		expect(saved.whitelistedChannelIds[0].notify).toBe(true)
		expect(config.channelSettingsById?.get(id)?.notify).toBe(true)
		await expect(setManualChannelNotify(file, config,
			'UC0123456789012345678901', false)).rejects.toThrow()
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('rejects invalid inputs and preserves the file', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-channels-'))
	const file = path.join(directory, 'channels.json')
	const original = JSON.stringify({ whitelistedChannelIds: ['bad-id'] })
	try {
		await fs.writeFile(file, original)
		await expect(addManualChannel(file, {} as Config,
			'UCabcdefghijklmnopqrstuv')).rejects.toThrow()
		await expect(addManualChannel(file, {} as Config, 'invalid'))
			.rejects.toThrow()
		expect(await fs.readFile(file, 'utf8')).toBe(original)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
})
