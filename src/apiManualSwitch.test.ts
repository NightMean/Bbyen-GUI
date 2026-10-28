import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { expect, test, vi } from 'vitest'
import { init } from './database'
import { Config, buildChannelSettingsMap } from './config'
import { ApiManualSwitch, recoverApiManualSwitch } from './apiManualSwitch'
import { recoverOAuthCleanup } from './oauthCleanup'
import { makeEmailEligibility } from './emailPolicy'

const first = 'UC0000000000000000000001'
const second = 'UC0000000000000000000002'
const third = 'UC0000000000000000000003'

const fixture = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-manual-'))
	const configFile = path.join(directory, 'config.json')
	const channelsFile = path.join(directory, 'channels.json')
	const token = path.join(directory, '.google-auth-token.json')
	const filename = path.join(directory, 'database.sqlite')
	await fs.writeFile(configFile,
		JSON.stringify({ mode: 'youtube', keep: true }))
	await fs.writeFile(channelsFile, JSON.stringify({
		whitelistedChannelIds: [{ id: first, notify: true }],
		blacklistedChannelIds: [second], manualChannelIds: [third],
	}))
	await fs.writeFile(token, 'token-fixture')
	let db = await init({ filename })
	for (const id of [first, second, third]) {
		await db.run('INSERT INTO subscriptions (channelId, channelTitle, ' +
			'channelThumbnail) VALUES (?, ?, ?)', id, id, 'image')
	}
	await db.run('INSERT INTO channel_sources (channelId, apiSubscribed) ' +
		'VALUES (?, 1), (?, 1)', first, second)
	await db.run('INSERT INTO channel_sources (channelId, manual) VALUES (?, 1)',
		third)
	await db.run('INSERT INTO videos (videoId, channelId) VALUES (?, ?)',
		'video-fixture', first)
	const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
		whitelistedChannelIds: [{ id: first, notify: true }],
		blacklistedChannelIds: [{ id: second }], manualChannelIds: [{ id: third }],
		channelSettingsById: buildChannelSettingsMap([{ id: first, notify: true }]),
	} as Config
	const revision = async () => createHash('sha256')
		.update(await fs.readFile(token).catch(() => Buffer.from('missing')))
		.digest('hex')
	const onPending = vi.fn().mockResolvedValue(undefined)
	const switcher = new ApiManualSwitch(db, config, directory, configFile,
		channelsFile, revision, Date.now, onPending)
	return { directory, configFile, channelsFile, token, filename, config,
		switcher, onPending,
		get db() { return db }, reopen: async () => {
			await db.close(); db = await init({ filename })
		} }
}

test('snapshots API channels without enabling previously excluded emails',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			expect(preview.continuing.map(item => item.manualPolicyExcluded))
				.toEqual([false, true, false])
			expect(await f.switcher.apply(preview.previewId))
				.toEqual({ pending: false, cleanupPending: false })
			expect(f.config.mode).toBe('whitelist')
			const eligibility = makeEmailEligibility(f.config)
			expect([first, second, third].map(id => eligibility(id,
				f.config.channelSettingsById?.get(id))))
				.toEqual(['eligible', 'muted', 'eligible'])
			expect(await f.db.get('SELECT videoId FROM videos'))
				.toEqual({ videoId: 'video-fixture' })
			await expect(fs.stat(f.token)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(JSON.parse(await fs.readFile(f.configFile, 'utf8')))
				.toEqual({ mode: 'whitelist', keep: true })
		} finally {
			await f.db.close(); await fs.rm(f.directory, { recursive: true })
		}
	})

test('recovers an interrupted file update after reopening the database',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			await fs.writeFile(`${f.configFile}.lock`, 'fixture')
			expect(await f.switcher.apply(preview.previewId))
				.toEqual({ pending: true, cleanupPending: false })
			expect(f.config.manualTransitionPending).toBe(true)
			expect(f.onPending).toHaveBeenCalledTimes(1)
			expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			await fs.unlink(`${f.configFile}.lock`)
			await f.reopen()
			const lists = await recoverApiManualSwitch(f.db, f.directory,
				f.configFile, f.channelsFile)
			expect(lists?.whitelistedChannelIds?.map(item => item.id))
				.toEqual([first, second, third])
			expect(await f.db.get('SELECT id FROM api_manual_switch')).toBeUndefined()
			expect(await recoverOAuthCleanup(f.db, f.directory)).toBe(true)
			await expect(fs.stat(f.token)).rejects.toMatchObject({ code: 'ENOENT' })
		} finally {
			await f.db.close(); await fs.rm(f.directory, { recursive: true })
		}
	})

test('does not overwrite unrelated edits after an interrupted switch',
	async () => {
		const f = await fixture()
		try {
			const preview = await f.switcher.review()
			await fs.writeFile(`${f.configFile}.lock`, 'fixture')
			await f.switcher.apply(preview.previewId)
			await fs.unlink(`${f.configFile}.lock`)
			const changed = JSON.stringify({ mode: 'youtube', other: 'user edit' })
			await fs.writeFile(f.configFile, changed)
			await expect(recoverApiManualSwitch(f.db, f.directory,
				f.configFile, f.channelsFile)).rejects.toThrow(/changed/)
			expect(await fs.readFile(f.configFile, 'utf8')).toBe(changed)
			expect(await fs.readFile(f.token, 'utf8')).toBe('token-fixture')
			expect(await f.db.get('SELECT id FROM api_manual_switch'))
				.toEqual({ id: 1 })
		} finally {
			await f.db.close(); await fs.rm(f.directory, { recursive: true })
		}
	})
