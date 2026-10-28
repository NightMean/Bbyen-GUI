import axios from 'axios'
import { Credentials } from 'google-auth-library'

const DEVICE_ENDPOINT = 'https://oauth2.googleapis.com/device/code'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_INTERVAL_MS = 60_000
const MAX_LIFETIME_MS = 3_600_000

export type DeviceScope = 'readonly' | 'manage'
export interface DeviceClient { clientId: string, clientSecret: string }
export interface DevicePrompt {
	userCode: string,
	verificationUrl: string,
	expiresAt: number,
}
type Response = { status: number, data: unknown }
type Post = (url: string, values: URLSearchParams) => Promise<Response>

const post: Post = async (url, values) => {
	try {
		const response = await axios.post(url, values.toString(), {
			timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
			maxContentLength: 64 * 1024, maxBodyLength: 16 * 1024,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		})
		return { status: response.status, data: response.data }
	} catch {
		// Axios errors can contain request bodies with codes and client secrets.
		throw new Error('Google authorization request failed.')
	}
}
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid Google authorization response.')
	}
	return value as Record<string, unknown>
}
const string = (value: unknown, max = 8192): string => {
	if (typeof value !== 'string' || !value || value.length > max) {
		throw new Error('Invalid Google authorization response.')
	}
	return value
}
const seconds = (value: unknown, max: number): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) ||
			value < 1 || value > max) {
		throw new Error('Invalid Google authorization response.')
	}
	return value * 1000
}

/** In-memory candidate; credentials are handed to a caller only once. */
export class DeviceAuthorization {
	private nextPoll: number
	private pending?: Promise<'pending' | 'authorized'>
	private credentials?: Credentials
	private cancelled = false
	private constructor(private readonly client: DeviceClient,
		private readonly deviceCode: string, private readonly scope: DeviceScope,
		readonly prompt: DevicePrompt, private interval: number,
		private readonly request: Post, private readonly clock: () => number) {
		this.nextPoll = clock() + interval
	}

	static async start(client: DeviceClient, scope: DeviceScope,
		request: Post = post, clock: () => number = Date.now) {
		string(client.clientId); string(client.clientSecret)
		const response = await request(DEVICE_ENDPOINT, new URLSearchParams({
			client_id: client.clientId,
			scope: `https://www.googleapis.com/auth/youtube${
				scope === 'readonly' ? '.readonly' : ''}`,
		}))
		if (response.status !== 200) {
			throw new Error('Could not start Google device authorization.')
		}
		const body = object(response.data)
		const verificationUrl = string(body.verification_url, 2048)
		const url = new URL(verificationUrl)
		if (url.protocol !== 'https:' ||
				!(url.hostname === 'google.com' ||
					url.hostname.endsWith('.google.com')) ||
				url.username || url.password || url.port) {
			throw new Error('Invalid Google verification URL.')
		}
		const prompt = { userCode: string(body.user_code, 100),
			verificationUrl,
			expiresAt: clock() + seconds(body.expires_in, MAX_LIFETIME_MS / 1000) }
		return new DeviceAuthorization(client, string(body.device_code), scope,
			prompt, seconds(body.interval, MAX_INTERVAL_MS / 1000), request, clock)
	}

	cancel() { this.cancelled = true; this.credentials = undefined }

	poll(): Promise<'pending' | 'authorized'> {
		if (this.cancelled || this.clock() >= this.prompt.expiresAt) {
			return Promise.reject(new Error('Google authorization expired.'))
		}
		if (this.credentials) return Promise.resolve('authorized')
		if (this.pending) return this.pending
		if (this.clock() < this.nextPoll) return Promise.resolve('pending')
		this.nextPoll = this.clock() + this.interval
		const work = this.fetchToken()
		this.pending = work
		void work.finally(() => {
			if (this.pending === work) this.pending = undefined
		})
			.catch(() => undefined)
		return work
	}

	private async fetchToken(): Promise<'pending' | 'authorized'> {
		const response = await this.request(TOKEN_ENDPOINT, new URLSearchParams({
			client_id: this.client.clientId, client_secret: this.client.clientSecret,
			device_code: this.deviceCode,
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		}))
		if (this.cancelled || this.clock() >= this.prompt.expiresAt) {
			throw new Error('Google authorization expired.')
		}
		const body = object(response.data)
		if (body.error === 'authorization_pending') return 'pending'
		if (body.error === 'slow_down') {
			this.interval = Math.min(MAX_INTERVAL_MS, this.interval + 5000)
			this.nextPoll = this.clock() + this.interval
			return 'pending'
		}
		if (response.status !== 200) {
			throw new Error('Google authorization was denied or failed.')
		}
		const scopes = string(body.scope).split(' ')
		const expected = `https://www.googleapis.com/auth/youtube${
			this.scope === 'readonly' ? '.readonly' : ''}`
		if (!scopes.includes(expected)) {
			throw new Error('Required scope not granted.')
		}
		this.credentials = { access_token: string(body.access_token),
			refresh_token: string(body.refresh_token), scope: scopes.join(' '),
			token_type: string(body.token_type, 64),
			expiry_date: this.clock() + seconds(body.expires_in, 86_400) }
		return 'authorized'
	}

	takeCredentials(): Credentials {
		if (this.cancelled || !this.credentials ||
				this.clock() >= this.prompt.expiresAt) {
			throw new Error('Google authorization is unavailable.')
		}
		const result = this.credentials
		this.cancel()
		return result
	}
}
