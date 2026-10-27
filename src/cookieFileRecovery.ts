import { createHash } from 'crypto'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { normalizeCookieHeader } from './lib/innertubeChannels'

const RETRY_MS = 30 * 60_000

/** Detect a changed export while cookie tracking is stale. */
export class CookieFileRecovery {
	private previous?: { hash: string, attemptedAt: number }
	constructor(private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly load: () => Promise<string | null>,
		private readonly refresh: () => void,
		private readonly clock: () => number = Date.now) {}

	async check(): Promise<void> {
		if (this.config.mode !== 'cookie' || !this.config.cookieStale) {
			this.previous = undefined
			return
		}
		const raw = await this.load()
		if (!raw) return
		const candidate = normalizeCookieHeader(raw)
		const connection = await this.store.read()
		if (!connection || !candidate || candidate === connection.cookieHeader) {
			return
		}
		const hash = createHash('sha256').update(connection.generation)
			.update('\0').update(candidate).digest('hex')
		const now = this.clock()
		if (this.previous?.hash === hash &&
				now - this.previous.attemptedAt < RETRY_MS) return
		this.previous = { hash, attemptedAt: now }
		this.refresh()
	}
}
