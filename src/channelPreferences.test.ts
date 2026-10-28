import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { expect, test, vi } from 'vitest'
import { Config } from './config'
import { init } from './database'
import { CookieConnectionStore } from './cookieConnection'
import {
	setApiChannelNotify, setCookieChannelNotify,
} from './channelPreferences'
import { makeEmailEligibility } from './emailPolicy'

const channel = 'UC0000000000000000000002'
const profile = { name: 'Profile', channelId: 'UC0000000000000000000001',
	selected: true, selectable: true }

test('persists cookie mute without changing membership or other settings',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cookie-mute-'))
		const file = path.join(dir, 'channels.json')
		const db = await init({ filename: ':memory:' })
		const config = { mode: 'cookie' } as Config
		try {
			await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds:
				[{ id: channel, notify: true, notifyOnFirstScan: false }],
			manualChannelIds: [{ id: channel, notify: true }], custom: 'keep' }))
			await new CookieConnectionStore(db).activate('SAPISID=fixture', profile,
				[{ channelId: channel, title: 'Creator', notificationState: 'all',
					isAllNotifications: true }])
			await setCookieChannelNotify(db, file, config, channel, false)
			const stored = JSON.parse(await fs.readFile(file, 'utf8'))
			expect(stored.custom).toBe('keep')
			expect(stored.whitelistedChannelIds[0]).toMatchObject({ notify: false,
				notifyOnFirstScan: false })
			expect(stored.manualChannelIds[0].notify).toBe(false)
			expect(makeEmailEligibility(config)(channel,
				config.channelSettingsById?.get(channel))).toBe('muted')
			expect((await db.get('SELECT subscribed FROM cookie_channel_state'))
				.subscribed).toBe(1)
			await setCookieChannelNotify(db, file, config, channel, true)
			expect(makeEmailEligibility(config)(channel,
				config.channelSettingsById?.get(channel))).toBe('eligible')
			await expect(setCookieChannelNotify(db, file, config,
				'UC0000000000000000000003', false)).rejects.toThrow()
		} finally {
			await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('reconciles runtime settings after a write reports cleanup failure',
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-cookie-lock-'))
		const file = path.join(dir, 'channels.json')
		const db = await init({ filename: ':memory:' })
		const config = { mode: 'cookie' } as Config
		const unlink = fs.unlink.bind(fs)
		let failOnce = true
		const spy = vi.spyOn(fs, 'unlink').mockImplementation(async target => {
			if (target === `${file}.lock` && failOnce) {
				failOnce = false
				throw new Error('synthetic cleanup failure')
			}
			return unlink(target)
		})
		try {
			await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [] }))
			await new CookieConnectionStore(db).activate('SAPISID=fixture', profile,
				[{ channelId: channel, title: 'Creator', notificationState: 'all',
					isAllNotifications: true }])
			await expect(setCookieChannelNotify(db, file, config, channel, false))
				.rejects.toThrow('synthetic cleanup failure')
			expect(config.channelSettingsById?.get(channel)?.notify).toBe(false)
			const stored = JSON.parse(await fs.readFile(file, 'utf8'))
			expect(stored.savedChannelSettings[0].notify).toBe(false)
		} finally {
			spy.mockRestore()
			await db.close()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

test('persists API email mute without changing list membership', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-api-mute-'))
	const file = path.join(dir, 'channels.json')
	const db = await init({ filename: ':memory:' })
	const config = { mode: 'youtube',
		emailSelectionPolicy: 'blocklist' } as Config
	try {
		await fs.writeFile(file, JSON.stringify({ whitelistedChannelIds: [],
			blacklistedChannelIds: [] }))
		await db.run(`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail) VALUES (?, 'Creator', '')`,
		channel)
		await setApiChannelNotify(db, file, config, channel, false)
		expect(config.whitelistedChannelIds).toEqual([])
		expect(config.blacklistedChannelIds).toEqual([])
		expect(makeEmailEligibility(config)(channel,
			config.channelSettingsById?.get(channel))).toBe('muted')
		await setApiChannelNotify(db, file, config, channel, true)
		expect(makeEmailEligibility(config)(channel,
			config.channelSettingsById?.get(channel))).toBe('eligible')
		await expect(setApiChannelNotify(db, file, config,
			'UC0000000000000000000003', false)).rejects.toThrow()
	} finally {
		await db.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
})
