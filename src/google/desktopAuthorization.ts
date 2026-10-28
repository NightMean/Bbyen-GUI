import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { CodeChallengeMethod, Credentials, OAuth2Client }
	from 'google-auth-library'

const LIFETIME_MS = 10 * 60_000
const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube'
const REQUEST_TIMEOUT_MS = 30_000

/** Bound provider calls; late results must never reach persistence. */
export const withAuthorizationTimeout = async <T>(
	work: Promise<T>,
): Promise<T> => {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([work, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Authorization timed out.')),
				REQUEST_TIMEOUT_MS)
			timer.unref()
		})])
	} finally { if (timer) clearTimeout(timer) }
}

/** A single-use Desktop OAuth session; no token is persisted by this class. */
export class DesktopAuthorization {
	private readonly state = randomBytes(32).toString('base64url')
	private readonly verifier = randomBytes(32).toString('base64url')
	private readonly expiresAt: number
	private phase: 'pending' | 'exchanging' | 'complete' | 'cancelled' = 'pending'

	constructor(private readonly client: OAuth2Client,
		private readonly clock: () => number = Date.now) {
		this.expiresAt = clock() + LIFETIME_MS
	}

	url(): string {
		this.checkPending()
		return this.client.generateAuthUrl({ access_type: 'offline',
			prompt: 'consent', scope: [MANAGE_SCOPE], state: this.state,
			code_challenge_method: CodeChallengeMethod.S256,
			code_challenge: createHash('sha256').update(this.verifier)
				.digest('base64url') })
	}

	cancel(): void { this.phase = 'cancelled' }

	private checkPending(): void {
		if (this.phase !== 'pending' || this.clock() >= this.expiresAt) {
			throw new Error('Authorization session is unavailable or expired.')
		}
	}

	async exchange(state: unknown, code: unknown): Promise<Credentials> {
		this.checkPending()
		if (typeof state !== 'string' || typeof code !== 'string' || !code ||
				code.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(state) ||
				state.length !== this.state.length ||
				!timingSafeEqual(Buffer.from(state), Buffer.from(this.state))) {
			throw new Error('Invalid authorization response.')
		}
		this.phase = 'exchanging'
		try {
			const { tokens } = await withAuthorizationTimeout(this.client.getToken({
				code, codeVerifier: this.verifier }))
			if (this.phase !== 'exchanging' || this.clock() >= this.expiresAt) {
				throw new Error('Authorization session expired.')
			}
			if (!tokens.refresh_token ||
					!tokens.scope?.split(/\s+/).includes(MANAGE_SCOPE)) {
				throw new Error('Required YouTube permission was not granted.')
			}
			this.phase = 'complete'
			return tokens
		} catch {
			this.phase = 'cancelled'
			// Provider errors may contain codes or credentials.
			throw new Error('Google authorization failed. Please retry.')
		}
	}
}
