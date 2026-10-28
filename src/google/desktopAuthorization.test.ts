import { OAuth2Client } from 'google-auth-library'
import { expect, test, vi } from 'vitest'
import { DesktopAuthorization, withAuthorizationTimeout }
	from './desktopAuthorization'

const scope = 'https://www.googleapis.com/auth/youtube'
const client = () => new OAuth2Client('fixture-id', 'fixture-secret',
	'http://127.0.0.1:3040/authorization_code')

test('uses PKCE and state and hands out a management grant once', async () => {
	const oauth = client()
	const exchange = vi.spyOn(oauth, 'getToken').mockResolvedValue({ tokens: {
		refresh_token: 'refresh-fixture', scope }, res: null } as never)
	const session = new DesktopAuthorization(oauth)
	const url = new URL(session.url())
	expect(url.searchParams.get('code_challenge_method')).toBe('S256')
	expect(url.searchParams.get('scope')).toBe(scope)
	const state = url.searchParams.get('state')!
	await expect(session.exchange('wrong', 'code')).rejects.toThrow(/Invalid/)
	expect(exchange).not.toHaveBeenCalled()
	expect((await session.exchange(state, 'code')).refresh_token)
		.toBe('refresh-fixture')
	expect(exchange).toHaveBeenCalledWith(expect.objectContaining({
		code: 'code', codeVerifier: expect.any(String) }))
	await expect(session.exchange(state, 'code')).rejects.toThrow(/unavailable/)
})

test('does not release tokens after cancellation, expiry or failed consent',
	async () => {
		let now = 0
		const oauth = client()
		let finish!: (value: never) => void
		vi.spyOn(oauth, 'getToken').mockImplementation(() =>
			new Promise(resolve => { finish = resolve }) as never)
		const session = new DesktopAuthorization(oauth, () => now)
		const state = new URL(session.url()).searchParams.get('state')!
		const pending = session.exchange(state, 'code')
		session.cancel()
		finish({ tokens: { refresh_token: 'fixture', scope }, res: null } as never)
		await expect(pending).rejects.toThrow()
		expect(() => session.url()).toThrow()
		const expired = new DesktopAuthorization(client(), () => now)
		const expiredState = new URL(expired.url()).searchParams.get('state')!
		now += 600_000
		await expect(expired.exchange(expiredState, 'code')).rejects.toThrow()
		const deniedClient = client()
		vi.spyOn(deniedClient, 'getToken').mockResolvedValue({ tokens: {
			refresh_token: 'fixture', scope: `${scope}.readonly`,
		}, res: null } as never)
		const denied = new DesktopAuthorization(deniedClient)
		const deniedState = new URL(denied.url()).searchParams.get('state')!
		await expect(denied.exchange(deniedState, 'code')).rejects.toThrow()
	})

test('bounds a provider request that never returns', async () => {
	vi.useFakeTimers()
	try {
		const work = withAuthorizationTimeout(new Promise(() => undefined))
		const assertion = expect(work).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(30_000)
		await assertion
	} finally { vi.useRealTimers() }
})
