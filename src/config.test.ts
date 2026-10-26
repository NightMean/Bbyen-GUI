import { vi, expect, describe, test, afterEach, beforeEach } from 'vitest'
import axios from 'axios'
import winston from 'winston'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'

import fs from 'fs/promises'

import  {
	normalizeChannelFactory,
	normalizeChannelEntries,
	buildChannelSettingsMap,
	loadEmailConfig,
	loadConfigRaw,
	CONFIG_FILE,
	SECRETS_FILE,
} from './config'

vi.mock('fs/promises')
vi.mock('axios')

beforeEach(() => {
	vi.mocked(axios.get).mockResolvedValue({
		data: '<meta itemprop="identifier" ' +
			'content="UCzgA9CBrIXPtkB2yNTTiy1w">',
	})
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.clearAllMocks()
})

function createMagicStub<T extends object>(): T {
	return new Proxy({} as T, {
		get: (target: T, prop: string) => {
			if (!(prop in target)) {
				// If the method does not exist, create it as a mock function
				(target as any)[prop] = vi.fn()
			}
			return target[prop as keyof T]
		}
	})
}

describe('normalizeChannel', async () => {
	const logger = createMagicStub<winston.Logger>()
	const service = createMagicStub<youtube_v3.Youtube>()
	const auth = createMagicStub<OAuth2Client>()

	const normalizeChannel = normalizeChannelFactory(logger, service, auth)
	const normalizeWithoutAuth = normalizeChannelFactory(logger)

	test('already a channel id', async () => {
		expect(await normalizeChannel('UCzgA9CBrIXPtkB2yNTTiy1w'))
			.toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})
	test('channel url resolved via scraper', async () => {
		expect(await normalizeChannel('https://www.youtube.com/@Level2Jeff'))
			.toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})
	test('bare handle resolved via scraper without API credentials', async () => {
		expect(await normalizeWithoutAuth('@Level2Jeff'))
			.toBe('UCzgA9CBrIXPtkB2yNTTiy1w')
	})
})

describe('normalizeChannelEntries', () => {
	// Stub normalizeChannel: pretend the handle maps to a known id,
	// everything else passes through unchanged.
	const normalize = async (c: string) =>
		c === 'https://www.youtube.com/@X' ? 'UCX' : c

	test('plain string becomes { id }', async () => {
		const out = await normalizeChannelEntries(normalize, ['UCabc'])
		expect(out).toEqual([{ id: 'UCabc' }])
	})
	test('object preserves flags, normalizes id', async () => {
		const out = await normalizeChannelEntries(normalize, [
			{ id: 'https://www.youtube.com/@X', notify: false },
		])
		expect(out).toEqual([{ id: 'UCX', notify: false }])
	})
	test('undefined passes through', async () => {
		expect(await normalizeChannelEntries(normalize, undefined))
			.toBeUndefined()
	})

	test('consolidates resolved duplicates and preserves flags', async () => {
		expect(await normalizeChannelEntries(normalize, [
			{ id: 'UCX', notify: false }, 'https://www.youtube.com/@X',
		])).toEqual([{ id: 'UCX', notify: false }])
	})
})

describe('buildChannelSettingsMap', () => {
	test('only entries with flags are included', () => {
		const map = buildChannelSettingsMap([
			{ id: 'A' },
			{ id: 'B', notify: false },
			{ id: 'C', notifyOnFirstScan: false },
		])
		expect(map.has('A')).toBe(false)
		expect(map.get('B')).toEqual({ id: 'B', notify: false })
		expect(map.get('C')).toEqual({ id: 'C', notifyOnFirstScan: false })
	})
	test('undefined yields empty map', () => {
		expect(buildChannelSettingsMap(undefined).size).toBe(0)
	})
	test('includes a channel with a backlog policy', () => {
		const policy = { mode: 'newest' as const, count: 2 }
		expect(buildChannelSettingsMap([{ id: 'A', initialBacklog: policy }])
			.get('A')).toEqual({ id: 'A', initialBacklog: policy })
	})
})

describe('loadEmailConfig', () => {
	test('supports inline credentials from existing configurations', async () => {
		vi.stubEnv('BBYEN_EMAIL_USER', undefined)
		vi.stubEnv('BBYEN_EMAIL_PASS', undefined)
		vi.mocked(fs.readFile).mockImplementation(async file => {
			if (file === CONFIG_FILE) return Buffer.from(JSON.stringify({
				email: { auth: { user: 'inline@example.com', pass: 'fixture' } },
			}))
			throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' })
		})
		expect((await loadEmailConfig()).auth).toEqual({
			user: 'inline@example.com', pass: 'fixture',
		})
	})

	test('prefers separate secrets over legacy inline credentials', async () => {
		vi.stubEnv('BBYEN_EMAIL_USER', undefined)
		vi.stubEnv('BBYEN_EMAIL_PASS', undefined)
		vi.mocked(fs.readFile).mockImplementation(async file => {
			const user = file === SECRETS_FILE ? 'secret' : 'inline'
			return Buffer.from(JSON.stringify({
				email: { auth: { user, pass: 'fixture' } },
			}))
		})
		expect((await loadEmailConfig()).auth.user).toBe('secret')
	})

	test('reads email block and resolves env credentials', async () => {
		vi.stubEnv('BBYEN_EMAIL_USER', 'u@example.com')
		vi.stubEnv('BBYEN_EMAIL_PASS', 'pw')
		const general = {
			email: {
				host: 'h', port: 465, secure: true,
				sendingContact: 's', destination: 'd',
			},
			mode: 'youtube',
		}
		vi.mocked(fs.readFile).mockImplementation(async file => {
			if (file === CONFIG_FILE) return Buffer.from(JSON.stringify(general))
			throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' })
		})
		const email = await loadEmailConfig()
		expect(email.auth).toEqual({ user: 'u@example.com', pass: 'pw' })
		expect(email.host).toBe('h')
		expect(fs.writeFile).not.toHaveBeenCalled()
		expect(fs.unlink).not.toHaveBeenCalled()
	})
})

describe('loadConfigRaw', () => {
	test('rejects invalid global backlog policy', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
			initialBacklog: { mode: 'newest', count: 0 },
		})))
		await expect(loadConfigRaw()).rejects.toThrow('initialBacklog')
	})
	test('applies documented defaults to existing configurations', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('{"port":9020}'))
		expect(await loadConfigRaw()).toMatchObject({
			mode: 'youtube', notifyOnFirstScan: true, port: 9020,
		})
	})

	test('preserves explicit mode and first-scan settings', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify({
			mode: 'whitelist', notifyOnFirstScan: false,
		})))
		expect(await loadConfigRaw()).toMatchObject({
			mode: 'whitelist', notifyOnFirstScan: false,
		})
	})
})
