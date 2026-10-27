import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import axios from 'axios'
import { init } from '../src/database'
import example from '../config.example.json'

vi.mock('axios')
let directory: string
let channelsFile: string
let sync: typeof import('./fetch_all_bell_channels').fetchAllBellChannels
const id = 'UC0000000000000000000000'
const renderer = (icon = 'NOTIFICATIONS_ACTIVE') => ({ channelRenderer: {
	channelId: id, title: { simpleText: 'Creator' },
	subscriptionButton: { subscriptionNotificationToggleButtonRenderer: {
		currentStateId: 2, states: [{ stateId: 2, state: { buttonRenderer: {
			icon: { iconType: icon },
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

test.each([
	['NOTIFICATIONS_NONE', 'personalized'], ['NOTIFICATIONS_OFF', 'none'],
])('records %s without discarding manual entries', async (icon, state) => {
	const options = {
		cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
	}
	await sync(options)
	vi.mocked(axios.post).mockImplementation(async url => ({
		data: String(url).endsWith('/browse')
			? renderer(icon) : {},
	}))
	await sync(options)
	const db = await init({ filename: path.join(directory, 'test.sqlite') })
	try {
		expect(await db.get('SELECT * FROM subscriptions')).toMatchObject({
			channelId: id, bellState: state, firstObservedAt: expect.any(String),
		})
	} finally { await db.close() }
	expect(JSON.parse(await fs.readFile(channelsFile, 'utf8')))
		.toMatchObject({ whitelistedChannelIds: [{ id }] })
})

test('reports a partial save when the configured database is unavailable',
	async () => {
		await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
			...example, database: {
				filename: path.join(directory, 'missing-directory', 'test.sqlite'),
			},
		}))
		await expect(sync({
			cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
		})).rejects.toThrow(/channels.*saved.*database/i)
		expect(JSON.parse(await fs.readFile(channelsFile, 'utf8')))
			.toMatchObject({ whitelistedChannelIds: [{ id }] })
	})

test('rejects continuation cycles without writing a partial whitelist',
	async () => {
		vi.mocked(axios.post).mockImplementation(async url => ({
			data: String(url).endsWith('/browse') ? {
				...renderer(), continuationCommand: { token: 'repeated-token' },
			} : {},
		}))
		await expect(sync({
			cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
		})).rejects.toThrow(/continuation/i)
		await expect(fs.stat(channelsFile))
			.rejects.toMatchObject({ code: 'ENOENT' })
	})

test('rejects a logged-out account before fetching channels', async () => {
	vi.mocked(axios.post).mockResolvedValue({ data: { responseContext: {
		mainAppWebResponseContext: { loggedOut: true },
	} } } as any)
	await expect(sync({ cookie: 'SAPISID=synthetic-fixture',
		saveToChannelsJson: true })).rejects.toThrow(/session cookie/i)
	expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1)
	await expect(fs.stat(channelsFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rolls back failed bell batches and safely retries the saved whitelist',
	async () => {
		const second = renderer()
		second.channelRenderer.channelId = 'UC1111111111111111111111'
		vi.mocked(axios.post).mockImplementation(async url => ({
			data: String(url).endsWith('/browse')
				? { contents: [renderer(), second] } : {},
		}))
		const db = await init({ filename: path.join(directory, 'test.sqlite') })
		try {
			await db.exec(`CREATE TRIGGER reject_fixture BEFORE INSERT
				ON subscriptions WHEN NEW.channelId='UC1111111111111111111111'
				BEGIN SELECT RAISE(ABORT, 'Fixture write failure'); END`)
			const options = {
				cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
			}
			await expect(sync(options)).rejects.toThrow('database failed')
			expect(await db.all('SELECT * FROM subscriptions')).toHaveLength(0)
			await db.exec('DROP TRIGGER reject_fixture')
			await sync(options)
			expect(await db.all('SELECT * FROM subscriptions')).toHaveLength(2)
		} finally { await db.close() }
	})

test('does not save a logged-out HTTP 200 response', async () => {
	vi.mocked(axios.post).mockResolvedValue({ data: {
		responseContext: { mainAppWebResponseContext: { loggedOut: true } },
	} })
	await expect(sync({
		cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
	})).rejects.toThrow('rejected the session')
	await expect(fs.stat(channelsFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each([
	['empty', {}],
	['malformed', { channelRenderer: { title: { simpleText: 'Missing ID' } } }],
])('does not save an unverifiable %s response', async (_, data) => {
	vi.mocked(axios.post).mockImplementation(async url => ({
		data: String(url).endsWith('/browse') ? data : {},
	}))
	await expect(sync({
		cookie: 'SAPISID=synthetic-fixture', saveToChannelsJson: true,
	})).rejects.toThrow(/nothing was saved/i)
	await expect(fs.stat(channelsFile)).rejects.toMatchObject({ code: 'ENOENT' })
})
