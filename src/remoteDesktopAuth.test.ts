import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import { afterEach, expect, test, vi } from 'vitest'
import { RemoteDesktopAuth } from './remoteDesktopAuth'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'

const id = 'UCabcdefghijklmnopqrstuv'
const other = 'UC0000000000000000000000'
const scope = 'https://www.googleapis.com/auth/youtube'
afterEach(() => vi.restoreAllMocks())

const fixture = async (apiId = id) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbyen-remote-'))
	await fs.writeFile(path.join(directory, 'google-credentials.json'),
		JSON.stringify({ installed: { client_id: 'fixture-id',
			client_secret: 'fixture-secret' } }))
	let generation = 'first'
	const store = { oauthCleanupPending: async () => false,
		read: async () => ({ generation,
			profile: { channelId: id } }) } as unknown as CookieConnectionStore
	const config = { mode: 'cookie' } as Config
	const service = { channels: { list: async () => ({ data: { items: [
		{ id: apiId, snippet: { title: 'Profile' } },
	] } }) } } as never
	const revision = async () => {
		const parts = await Promise.all(['google-credentials.json',
			'.google-auth-token.json'].map(name => fs.readFile(path.join(directory,
			name)).catch(() => Buffer.from('missing'))))
		return createHash('sha256').update(Buffer.concat(parts)).digest('hex')
	}
	vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: {
		refresh_token: 'refresh-fixture', scope }, res: null } as never)
	return { manager: new RemoteDesktopAuth(config, store, service, directory,
		revision, { expected: async () => id, stored: async () => id } as never),
	directory, config,
	changeCookie: () => { generation = 'second' } }
}

test('stores the original Desktop client grant only for a matching profile',
	async () => {
		const f = await fixture()
		try {
			const start = await f.manager.start(3040)
			const url = new URL(start.url)
			expect(url.searchParams.get('redirect_uri'))
				.toBe('http://127.0.0.1:3040/authorization_code')
			await f.manager.finish(start.id, url.searchParams.get('state'), 'code')
			const token = JSON.parse(await fs.readFile(path.join(f.directory,
				'.google-auth-token.json'), 'utf8'))
			expect(token.refresh_token).toBe('refresh-fixture')
			await expect(f.manager.finish(start.id, 'state', 'code'))
				.rejects.toThrow()
		} finally { await fs.rm(f.directory, { recursive: true }) }
	})

test('renews API mode only for its previously verified profile', async () => {
	for (const matching of [true, false]) {
		const f = await fixture(matching ? id : other)
		f.config.mode = 'youtube'
		try {
			const token = path.join(f.directory, '.google-auth-token.json')
			await fs.writeFile(token, '{"refresh_token":"previous-fixture"}')
			const start = await f.manager.start(3040)
			const state = new URL(start.url).searchParams.get('state')
			if (matching) {
				await f.manager.finish(start.id, state, 'code')
				expect(JSON.parse(await fs.readFile(token, 'utf8')).refresh_token)
					.toBe('refresh-fixture')
			} else {
				await expect(f.manager.finish(start.id, state, 'code'))
					.rejects.toThrow()
				expect(await fs.readFile(token, 'utf8'))
					.toBe('{"refresh_token":"previous-fixture"}')
			}
		} finally { await fs.rm(f.directory, { recursive: true }) }
	}
})

test('preserves prior authorization for mismatched or changed connections',
	async () => {
		for (const reason of ['mismatch', 'cookie', 'grant', 'mode']) {
			const f = await fixture(reason === 'mismatch' ? other : id)
			try {
				const token = path.join(f.directory, '.google-auth-token.json')
				await fs.writeFile(token, '{"refresh_token":"previous-fixture"}')
				const start = await f.manager.start(3040)
				const state = new URL(start.url).searchParams.get('state')
				if (reason === 'cookie') f.changeCookie()
				if (reason === 'grant') await fs.writeFile(token, '{"new":true}')
				if (reason === 'mode') f.config.mode = 'whitelist'
				const previous = await fs.readFile(token, 'utf8')
				await expect(f.manager.finish(start.id, state, 'code'))
					.rejects.toThrow()
				expect(await fs.readFile(token, 'utf8')).toBe(previous)
			} finally { await fs.rm(f.directory, { recursive: true }) }
		}
	})

test('renews combined authorization only for the saved cookie profile',
	async () => {
		for (const reason of ['matching', 'mismatch', 'mode-change']) {
			const f = await fixture(reason === 'mismatch' ? other : id)
			f.config.apiEnrichment = true
			try {
				const token = path.join(f.directory, '.google-auth-token.json')
				await fs.writeFile(token, '{"refresh_token":"previous-fixture"}')
				const start = await f.manager.start(3040)
				const state = new URL(start.url).searchParams.get('state')
				if (reason === 'mode-change') f.config.apiEnrichment = false
				if (reason === 'matching') {
					await f.manager.finish(start.id, state, 'code')
					expect(JSON.parse(await fs.readFile(token, 'utf8')).refresh_token)
						.toBe('refresh-fixture')
				} else {
					await expect(f.manager.finish(start.id, state, 'code'))
						.rejects.toThrow()
					expect(await fs.readFile(token, 'utf8'))
						.toBe('{"refresh_token":"previous-fixture"}')
				}
			} finally { await fs.rm(f.directory, { recursive: true }) }
		}
	})
