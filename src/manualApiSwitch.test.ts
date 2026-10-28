import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config, buildChannelSettingsMap } from './config'
import { ManualApiSwitch, recoverManualApiSwitch } from './manualApiSwitch'
import { makeEmailEligibility } from './emailPolicy'

vi.mock('./lib/logger', () => ({
	default: async () => ({ verbose: () => {} }),
}))
const profile = 'UC0000000000000000000001'
const first = 'UC0000000000000000000002'
const second = 'UC0000000000000000000003'
const newApi = 'UC0000000000000000000004'
const inactive = 'UC0000000000000000000005'
const newlyManual = 'UC0000000000000000000006'
const item = (channelId: string) => ({ id: `sub-${channelId}`,
	snippet: { resourceId: { channelId }, title: channelId,
		publishedAt: '2020-01-01T00:00:00Z' } })

const fixture = async () => {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'bbyen-manual-api-'))
	const configFile = path.join(directory, 'config.json')
	const channelsFile = path.join(directory, 'channels.json')
	const token = path.join(directory, '.google-auth-token.json')
	const filename = path.join(directory, 'database.sqlite')
	await fs.writeFile(configFile, JSON.stringify({ mode: 'whitelist',
		emailSelectionPolicy: 'allowlist', keep: true }))
	const firstEntry = { id: first, apiAllowlisted: true,
		manualPolicyExcluded: false }
	const secondEntry = { id: second, apiAllowlisted: false,
		manualPolicyExcluded: true }
	const manualEntry = { id: newlyManual }
	await fs.writeFile(channelsFile, JSON.stringify({
		whitelistedChannelIds: [firstEntry, secondEntry, manualEntry],
		manualChannelIds: [firstEntry, secondEntry, manualEntry],
		blacklistedChannelIds: [],
		savedChannelSettings: [{ id: inactive, apiAllowlisted: true }],
	}))
	await fs.writeFile(token, 'token-fixture')
	let db = await init({ filename })
	for (const id of [first, second, newlyManual]) {
		await db.run('INSERT INTO subscriptions (channelId, channelTitle, ' +
			'channelThumbnail) VALUES (?, ?, ?)', id, id, 'image')
	}
	const config = { mode: 'whitelist', emailSelectionPolicy: 'allowlist',
		whitelistedChannelIds: [firstEntry, secondEntry, manualEntry],
		manualChannelIds: [firstEntry, secondEntry, manualEntry],
		blacklistedChannelIds: [],
		channelSettingsById: buildChannelSettingsMap([firstEntry, secondEntry]),
	} as unknown as Config
	const service = { channels: { list: async () => ({ data: { items: [
		{ id: profile, snippet: { title: 'Profile' } },
	] } }) }, subscriptions: { list: async () => ({ data: {
		items: [item(first), item(newApi)],
	} }) } } as never
	const revision = async () => createHash('sha256')
		.update(await fs.readFile(token).catch(() => Buffer.from('missing')))
		.digest('hex')
	const onPending = vi.fn().mockResolvedValue(undefined)
	const switcher = new ManualApiSwitch(db, config, directory, configFile,
		channelsFile, service, async () => ({} as never), revision, Date.now,
		onPending)
	return { directory, configFile, channelsFile, token, filename, config,
		switcher,
		revision, onPending, get db() { return db }, reopen: async () => {
			await db.close(); db = await init({ filename })
		} }
}

test('adds API subscriptions and restores saved allowlist membership',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			expect(preview.profile.channelId).toBe(profile)
			expect(preview.start.map(item => item.channelId)).toEqual([newApi])
			expect(preview.emailChanges).toEqual([])
			expect(await f.switcher.apply(preview.previewId))
				.toEqual({ pending: false })
			expect(f.config.mode).toBe('youtube')
			expect(f.config.whitelistedChannelIds?.map(item => item.id).sort())
				.toEqual([first, inactive, newlyManual].sort())
			const manualOnly = new Set([second, newlyManual])
			const eligibility = makeEmailEligibility(f.config, manualOnly)
			expect(eligibility(second, f.config.channelSettingsById?.get(second)))
				.toBe('excluded')
			expect(eligibility(newlyManual,
				f.config.channelSettingsById?.get(newlyManual))).toBe('eligible')
			expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			expect(await f.db.all('SELECT id FROM channel_added_batches')).toEqual([])
		} finally {
			await f.db.close()
			await fs.rm(f.directory, { recursive: true })
		}
	})

test('recovers a confirmed transition after restart without replacing a grant',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			await fs.writeFile(`${f.configFile}.lock`, 'fixture')
			expect(await f.switcher.apply(preview.previewId))
				.toEqual({ pending: true })
			expect(f.config.manualTransitionPending).toBe(true)
			expect(f.onPending).toHaveBeenCalledTimes(1)
			await fs.unlink(`${f.configFile}.lock`)
			await f.reopen()
			const result = await recoverManualApiSwitch(f.db, f.directory,
				f.configFile, f.channelsFile, f.revision)
			expect(result?.policy).toBe('allowlist')
			expect(JSON.parse(await fs.readFile(f.configFile, 'utf8')).mode)
				.toBe('youtube')
			expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			expect(await f.db.get('SELECT id FROM manual_api_switch')).toBeUndefined()
		} finally {
			await f.db.close()
			await fs.rm(f.directory, { recursive: true })
		}
	})

test('preserves the journal if the grant changes', async () => {
	const f = await fixture()
	try {
		const preview = await f.switcher.review()
		await fs.writeFile(`${f.configFile}.lock`, 'fixture')
		await f.switcher.apply(preview.previewId)
		await fs.unlink(`${f.configFile}.lock`)
		await fs.writeFile(f.token, 'replacement-fixture')
		await expect(recoverManualApiSwitch(f.db, f.directory,
			f.configFile, f.channelsFile, f.revision)).rejects.toThrow(/changed/)
		expect(JSON.parse(await fs.readFile(f.configFile, 'utf8')).mode)
			.toBe('whitelist')
		expect(await f.db.get('SELECT id FROM manual_api_switch'))
			.toEqual({ id: 1 })
	} finally {
		await f.db.close()
		await fs.rm(f.directory, { recursive: true })
	}
})
