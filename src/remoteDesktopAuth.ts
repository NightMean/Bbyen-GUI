import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import {
	DesktopAuthorization, withAuthorizationTimeout,
} from './google/desktopAuthorization'
import { readAccountIdentity, sameAccount } from './google/accountIdentity'
import { updateJsonFile } from './lib/jsonFile'
import { ApiAccountIdentity } from './apiAccountIdentity'

interface Session {
	authorization: DesktopAuthorization,
	revision: string,
	mode: Config['mode'],
	combined: boolean,
	cookieGeneration?: string,
	cookieChannelId?: string | null,
	apiChannelId?: string,
	timer: NodeJS.Timeout,
	busy: boolean,
}

/** One-time Desktop OAuth grants received by a browser-PC loopback helper. */
export class RemoteDesktopAuth {
	private sessions = new Map<string, Session>()
	constructor(private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly service: youtube_v3.Youtube,
		private readonly directory: string,
		private readonly revision: () => Promise<string>,
		private readonly apiIdentity?: ApiAccountIdentity) {}

	private remove(id: string): void {
		const session = this.sessions.get(id)
		if (session) { clearTimeout(session.timer); session.authorization.cancel() }
		this.sessions.delete(id)
	}

	async start(port: unknown) {
		if (typeof port !== 'number' || !Number.isInteger(port) ||
				port < 1024 || port > 65535) throw new Error('Invalid callback port.')
		if (await this.store.oauthCleanupPending()) {
			throw new Error('Authorization cannot be changed in this mode.')
		}
		if (this.sessions.size >= 3) throw new Error('Too many login attempts.')
		const mode = this.config.mode
		const combined = !!this.config.apiEnrichment
		const revision = await this.revision()
		const cookie = mode === 'cookie' ? await this.store.read() : null
		if (mode === 'cookie' && !cookie) throw new Error('Cookie unavailable.')
		const apiChannelId = mode === 'youtube' ?
			await this.apiIdentity?.expected() : undefined
		if (mode === 'youtube' && !apiChannelId) {
			throw new Error('The active API account cannot be verified.')
		}
		const file = await fs.readFile(path.join(this.directory,
			'google-credentials.json'), 'utf8')
		if (file.length > 64 * 1024) throw new Error('Google client is invalid.')
		const credentials = JSON.parse(file)?.installed
		if (typeof credentials?.client_id !== 'string' || !credentials.client_id ||
				typeof credentials.client_secret !== 'string' ||
				!credentials.client_secret) throw new Error('Google client is invalid.')
		if (mode !== this.config.mode || combined !== !!this.config.apiEnrichment ||
				revision !== await this.revision()) {
			throw new Error('Connection changed; start again.')
		}
		const oauth = new OAuth2Client(credentials.client_id,
			credentials.client_secret, `http://127.0.0.1:${port}/authorization_code`)
		const authorization = new DesktopAuthorization(oauth)
		const id = randomBytes(32).toString('base64url')
		const timer = setTimeout(() => this.remove(id), 10 * 60_000)
		timer.unref()
		this.sessions.set(id, { authorization, revision, mode, combined,
			apiChannelId,
			cookieGeneration: cookie?.generation,
			cookieChannelId: cookie?.profile.channelId, timer, busy: false })
		return { id, url: authorization.url() }
	}

	async finish(id: unknown, state: unknown, code: unknown): Promise<void> {
		if (typeof id !== 'string') throw new Error('Invalid login attempt.')
		const session = this.sessions.get(id)
		if (!session || session.busy) throw new Error('Login attempt expired.')
		session.busy = true
		try {
			const tokens = await session.authorization.exchange(state, code)
			const clientFile = JSON.parse(await fs.readFile(path.join(this.directory,
				'google-credentials.json'), 'utf8')).installed
			const client = new OAuth2Client(clientFile.client_id,
				clientFile.client_secret)
			client.setCredentials(tokens)
			const identity = await withAuthorizationTimeout(
				readAccountIdentity(this.service, client))
			const cookie = session.mode === 'cookie' ? await this.store.read() : null
			if (session.mode !== this.config.mode ||
					session.combined !== !!this.config.apiEnrichment ||
					session.revision !== await this.revision() ||
					(session.mode === 'youtube' &&
					(!sameAccount(identity.channelId, session.apiChannelId) ||
					await this.apiIdentity?.stored() !== session.apiChannelId)) ||
					(session.mode === 'cookie' && (!cookie ||
					cookie.generation !== session.cookieGeneration ||
					!sameAccount(identity.channelId, session.cookieChannelId)))) {
				throw new Error('Account or connection changed.')
			}
			await updateJsonFile(path.join(this.directory, '.google-auth-token.json'),
				async () => {
					if (session.revision !== await this.revision() ||
							(session.mode === 'youtube' &&
							await this.apiIdentity?.stored() !== session.apiChannelId) ||
							this.sessions.get(id) !== session) {
						throw new Error('Authorization changed; start again.')
					}
					return tokens
				}, { createIfMissing: true })
		} finally { this.remove(id) }
	}
}
