import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'fs/promises'
import open from 'open'
import { OAuth2Client } from 'google-auth-library'
import authorize from './index'
import readline from './readline'

vi.mock('fs/promises')
vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./readline', () => ({ default: vi.fn() }))
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
		vi.mocked(readline).mockResolvedValue('fixture-code')
		const url = vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
			.mockReturnValue('https://example.com/authorize')
		vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
			tokens: { refresh_token: 'replacement-fixture' }, res: null,
		} as never)
		const client = await authorize({ interactive: true })
		expect(client.credentials.refresh_token).toBe('replacement-fixture')
		expect(url).toHaveBeenCalledWith(expect.objectContaining({
			prompt: 'consent', access_type: 'offline',
		}))
		expect(fs.writeFile).toHaveBeenCalledWith(
			expect.stringContaining('.google-auth-token.json'),
			expect.stringContaining('replacement-fixture'),
		)
	})

	test('normal startup reuses credentials without prompting', async () => {
		mockFiles()
		const client = await authorize()
		expect(client.credentials).toEqual(stored)
		expect(fs.writeFile).not.toHaveBeenCalled()
	})

	test('failed consent preserves the existing token', async () => {
		mockFiles()
		vi.mocked(readline).mockResolvedValue('fixture-code')
		vi.spyOn(OAuth2Client.prototype, 'generateAuthUrl')
			.mockReturnValue('https://example.com/authorize')
		vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
			tokens: { access_token: 'short-lived-fixture' }, res: null,
		} as never)
		await expect(authorize({ interactive: true }))
			.rejects.toThrow('no refresh token')
		expect(fs.writeFile).not.toHaveBeenCalled()
	})
})
