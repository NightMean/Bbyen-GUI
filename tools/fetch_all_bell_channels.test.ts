import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import axios from 'axios'
import example from '../config.example.json'

vi.mock('axios')
let directory: string
let channelsFile: string
let sync: typeof import('./fetch_all_bell_channels').fetchAllBellChannels
const id = 'UC0000000000000000000000'
const renderer = () => ({ channelRenderer: {
	channelId: id, title: { simpleText: 'Creator' },
	subscriptionButton: { subscriptionNotificationToggleButtonRenderer: {
		currentStateId: 2, states: [{ stateId: 2, state: { buttonRenderer: {
			icon: { iconType: 'NOTIFICATIONS_ACTIVE' },
		} } }],
	} },
} })

beforeEach(async () => {
	vi.resetModules()
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-sync-test-'))
	channelsFile = path.join(directory, 'channels.json')
	vi.stubEnv('CONFIG_DIR', directory)
	vi.stubEnv('YOUTUBE_ACCOUNT', undefined)
	vi.stubEnv('YOUTUBE_PAGE_ID', undefined)
	vi.spyOn(console, 'log').mockImplementation(() => {})
	await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
		...example, database: { filename: path.join(directory, 'test.sqlite') },
	}))
	vi.mocked(axios.post).mockImplementation(async url => ({
		data: String(url).endsWith('/browse') ? renderer() : {
			accountItem: { accountName: { simpleText: 'Fixture' }, isSelected: true },
		},
	}))
	sync = (await import('./fetch_all_bell_channels')).fetchAllBellChannels
})

afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const name of await fs.readdir(directory)) {
		await fs.unlink(path.join(directory, name))
	}
	await fs.rmdir(directory)
})

test('saving preserves preferences and deduplicates normalized entries',
	async () => {
		await fs.writeFile(channelsFile, JSON.stringify({
			whitelistedChannelIds: [{ id, notify: false }],
			blacklistedChannelIds: ['UC1111111111111111111111'],
			note: 'preserved metadata',
		}))
		const options = {
			cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
		}
		await sync(options)
		await sync(options)
		expect(JSON.parse(await fs.readFile(channelsFile, 'utf8'))).toEqual({
			whitelistedChannelIds: [{ id, notify: false }],
			blacklistedChannelIds: ['UC1111111111111111111111'],
			note: 'preserved metadata',
		})
	})

test('malformed existing configuration is preserved and reported', async () => {
	await fs.writeFile(channelsFile, '{malformed')
	await expect(sync({
		cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
	})).rejects.toThrow()
	expect(await fs.readFile(channelsFile, 'utf8')).toBe('{malformed')
})
