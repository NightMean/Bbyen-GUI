import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs/promises'
import open from 'open'
import { OAuth2Client } from 'google-auth-library'
import authorize from './index'
import readline from './readline'
import { updateJsonFile } from '../../lib/jsonFile'
import http from 'http'
import net from 'net'

vi.mock('fs/promises')
vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./readline', () => ({ default: vi.fn() }))
vi.mock('../../lib/jsonFile', () => ({ updateJsonFile: vi.fn() }))
vi.mock('../../lib/logger', () => ({
	default: async () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))

afterEach(() => {
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

const stored = { refresh_token: 'revoked-fixture', expiry_date: 1 }

const mockFiles = () => {
	vi.mocked(open).mockResolvedValue({} as never)
	vi.mocked(fs.mkdir).mockResolvedValue(undefined)
	vi.mocked(fs.writeFile).mockResolvedValue(undefined)
	vi.mocked(fs.readFile).mockImplementation(async file => {
		const name = String(file)
		const data = name.endsWith('google-credentials.json')
			? { installed: { client_id: 'fixture', client_secret: 'fixture' } }
			: name.endsWith('.google-auth-token.json') ? stored : { port: 0 }
		return Buffer.from(JSON.stringify(data))
	})
}

describe('authorization recovery', () => {
	test('interactive login replaces a stored revoked grant', async () => {
		mockFiles()
		const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
			.mockReturnValue('https://example.com/authorize')
		vi.mocked(readline).mockImplementation(async () =>
			`http://localhost:0/authorization_code?code=fixture-code&state=${
				url.mock.calls[0][0]!.state}`)
		vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
			tokens: { refresh_token: 'replacement-fixture' }, res: null,
		} as never)
		const client = await authorize({ interactive: true })
		expect(client.credentials.refresh_token).toBe('replacement-fixture')
		expect(url).toHaveBeenCalledWith(expect.objectContaining({
			prompt: 'consent', access_type: 'offline', code_challenge_method: 'S256',
		}))
		expect(updateJsonFile).toHaveBeenCalledWith(
			expect.stringContaining('.google-auth-token.json'),
			expect.any(Function), { createIfMissing: true },
		)
	})

	test('normal startup reuses credentials without prompting', async () => {
		mockFiles()
		const client = await authorize()
		expect(client.credentials).toEqual(stored)
		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	test('reloads a device grant with its issuing client', async () => {
		mockFiles()
		vi.mocked(fs.readFile).mockImplementation(async file => {
			const data = String(file).endsWith('.google-auth-token.json')
				? { format: 'device-v1', client: { clientId: 'device-id',
					clientSecret: 'device-fixture' },
				token: { refresh_token: 'device-refresh-fixture' } }
				: { port: 0 }
			return Buffer.from(JSON.stringify(data))
		})
		const client = await authorize()
		expect(client.credentials.refresh_token).toBe('device-refresh-fixture')
		expect(client._clientId).toBe('device-id')
	})

	test('failed consent preserves the existing token', async () => {
		mockFiles()
		const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
			.mockReturnValue('https://example.com/authorize')
		vi.mocked(readline).mockImplementation(async () =>
			`http://localhost:0/authorization_code?code=fixture-code&state=${
				url.mock.calls[0][0]!.state}`)
		vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
			tokens: { access_token: 'short-lived-fixture' }, res: null,
		} as never)
		await expect(authorize({ interactive: true }))
			.rejects.toThrow('no refresh token')
		expect(updateJsonFile).not.toHaveBeenCalled()
	})

	test('requests management access only when selected', async () => {
		mockFiles()
		const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
			.mockReturnValue('https://example.com/authorize')
		vi.mocked(readline).mockImplementation(async () =>
			`http://localhost:0/authorization_code?code=fixture-code&state=${
				url.mock.calls[0][0]!.state}`)
		vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
			tokens: { refresh_token: 'fixture',
				scope: 'https://www.googleapis.com/auth/youtube' }, res: null,
		} as never)
		await authorize({ interactive: true, manage: true })
		expect(url.mock.calls[0][0]!.scope).toEqual([
			'https://www.googleapis.com/auth/youtube',
		])
	})

	test('rejects a mismatched callback state without replacing the grant',
		async () => {
			mockFiles()
			vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
				.mockReturnValue('https://example.com/authorize')
			vi.mocked(readline).mockResolvedValue(
				'http://localhost:0/authorization_code?code=fixture&state=wrong')
			await expect(authorize({ interactive: true })).rejects.toThrow(/Invalid/)
			expect(updateJsonFile).not.toHaveBeenCalled()
		})

	test('preserves the old grant when management access is not granted',
		async () => {
			mockFiles()
			const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
				.mockReturnValue('https://example.com/authorize')
			vi.mocked(readline).mockImplementation(async () =>
				`http://localhost:0/authorization_code?code=fixture&state=${
					url.mock.calls[0][0]!.state}`)
			vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
				tokens: { refresh_token: 'fixture',
					scope: 'https://www.googleapis.com/auth/youtube.readonly' },
				res: null,
			} as never)
			await expect(authorize({ interactive: true, manage: true }))
				.rejects.toThrow(/permission/)
			expect(updateJsonFile).not.toHaveBeenCalled()
		})

	test('responds to a valid local callback only after storing the grant',
		async () => {
			const probe = net.createServer()
			await new Promise<void>(resolve => probe.listen(0, 'localhost', resolve))
			const port = (probe.address() as net.AddressInfo).port
			await new Promise<void>(resolve => probe.close(() => resolve()))
			mockFiles()
			vi.mocked(fs.readFile).mockImplementation(async file => {
				const name = String(file)
				const data = name.endsWith('google-credentials.json')
					? { installed: { client_id: 'fixture', client_secret: 'fixture' } }
					: name.endsWith('.google-auth-token.json') ? stored : { port }
				return Buffer.from(JSON.stringify(data))
			})
			const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
				.mockReturnValue('https://example.com/authorize')
			vi.mocked(readline).mockImplementation(() => new Promise(() => {}))
			vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
				tokens: { refresh_token: 'replacement-fixture' }, res: null,
			} as never)
			let release!: () => void
			let ready!: () => void
			const storing = new Promise<void>(resolve => { ready = resolve })
			vi.mocked(updateJsonFile).mockImplementation(async () => {
				ready()
				await new Promise<void>(resolve => { release = resolve })
				return {} as never
			})
			const login = authorize({ interactive: true })
			while (!url.mock.calls.length) await new Promise(r => setTimeout(r, 5))
			const state = url.mock.calls[0][0]!.state
			await new Promise(r => setTimeout(r, 50))
			let ended = false
			const response = new Promise<number>((resolve, reject) => {
				http.get(`http://localhost:${port}/authorization_code?code=fixture&` +
					`state=${state}`, res => {
					ended = true; res.resume(); resolve(res.statusCode!)
				}).on('error', reject)
			})
			await storing
			expect(ended).toBe(false)
			release()
			expect(await response).toBe(200)
			await login
		})
})
