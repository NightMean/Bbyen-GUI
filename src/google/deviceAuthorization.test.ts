import { expect, test, vi } from 'vitest'
import { DeviceAuthorization } from './deviceAuthorization'

const client = { clientId: 'test-client', clientSecret: 'test-secret' }
const prompt = { device_code: 'private-code', user_code: 'TEST-CODE',
	verification_url: 'https://www.google.com/device',
	expires_in: 60, interval: 5 }
const token = { access_token: 'access-fixture',
	refresh_token: 'refresh-fixture',
	token_type: 'Bearer', expires_in: 3600,
	scope: 'https://www.googleapis.com/auth/youtube' }

test('honors intervals, slowdown and one-time handoff', async () => {
	let now = 0
	const post = vi.fn()
		.mockResolvedValueOnce({ status: 200, data: prompt })
		.mockResolvedValueOnce({ status: 428,
			data: { error: 'authorization_pending' } })
		.mockResolvedValueOnce({ status: 403, data: { error: 'slow_down' } })
		.mockResolvedValueOnce({ status: 200, data: token })
	const session = await DeviceAuthorization.start(client, 'manage', post,
		() => now)
	expect(session.prompt).toEqual({ userCode: 'TEST-CODE',
		verificationUrl: 'https://www.google.com/device', expiresAt: 60_000 })
	expect(await session.poll()).toBe('pending')
	expect(post).toHaveBeenCalledTimes(1)
	now = 5000
	expect(await session.poll()).toBe('pending')
	now = 10_000
	expect(await session.poll()).toBe('pending')
	now = 19_999
	expect(await session.poll()).toBe('pending')
	expect(post).toHaveBeenCalledTimes(3)
	now = 20_000
	expect(await session.poll()).toBe('authorized')
	expect(session.takeCredentials().refresh_token).toBe('refresh-fixture')
	expect(() => session.takeCredentials()).toThrow()
})

test('shares a poll and discards a successful response after cancellation',
	async () => {
		let finish!: (value: unknown) => void
		const delayed = vi.fn().mockResolvedValueOnce({ status: 200, data: prompt })
			.mockImplementationOnce(() => new Promise(resolve => {
				finish = resolve
			}))
		let now = 0
		const active = await DeviceAuthorization.start(client, 'manage', delayed,
			() => now)
		now = 5000
		const first = active.poll(), second = active.poll()
		expect(first).toBe(second)
		active.cancel()
		finish({ status: 200, data: token })
		await expect(first).rejects.toThrow(/expired/)
		expect(() => active.takeCredentials()).toThrow()
	})

test('rejects unexpected verification destinations and insufficient scope',
	async () => {
		const badUrl = vi.fn().mockResolvedValue({ status: 200, data: {
			...prompt, verification_url: 'https://google.com.example.test/device',
		} })
		await expect(DeviceAuthorization.start(client, 'readonly', badUrl))
			.rejects.toThrow(/verification URL/)
		let now = 0
		const post = vi.fn().mockResolvedValueOnce({ status: 200, data: prompt })
			.mockResolvedValueOnce({ status: 200, data: {
				...token, scope: 'https://www.googleapis.com/auth/youtube.readonly',
			} })
		const session = await DeviceAuthorization.start(client, 'manage', post,
			() => now)
		now = 5000
		await expect(session.poll()).rejects.toThrow(/scope/)
		expect(() => session.takeCredentials()).toThrow()
	})

test('expires without polling or releasing credentials', async () => {
	let now = 0
	const post = vi.fn().mockResolvedValue({ status: 200, data: prompt })
	const session = await DeviceAuthorization.start(client, 'readonly', post,
		() => now)
	now = 60_000
	await expect(session.poll()).rejects.toThrow(/expired/)
	expect(post).toHaveBeenCalledTimes(1)
	expect(() => session.takeCredentials()).toThrow()
})
