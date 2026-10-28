import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { Config } from './config'
import { assertChannelId } from './lib/channelId'
import { readAccountIdentity } from './google/accountIdentity'
import { subscriptionMembershipIterator } from './google/iterators'

const MANAGE_SCOPES = [ 'https://www.googleapis.com/auth/youtube',
	'https://www.googleapis.com/auth/youtube.force-ssl' ]

/** Never replay uncertain writes; review the authoritative state first. */
export class ApiSubscriptionActions {
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly service: youtube_v3.Youtube,
		private readonly loadAuth: () => Promise<OAuth2Client>,
		private readonly revision: () => Promise<string>) {}

	private async context() {
		if (this.config.mode !== 'youtube') throw new Error('API mode required.')
		const revision = await this.revision()
		const auth = await this.loadAuth()
		const identity = await readAccountIdentity(this.service, auth)
		if (revision !== await this.revision() || this.config.mode !== 'youtube') {
			throw new Error('YouTube authorization changed.')
		}
		return { auth, profileKey: identity.channelId, revision }
	}

	private async membership(auth: OAuth2Client, channelId: string) {
		let subscriptionId: string | null = null
		for await (const item of subscriptionMembershipIterator(
			this.service, auth, [channelId])) {
			if (item.snippet?.resourceId?.channelId !== channelId ||
					typeof item.id !== 'string' || !item.id || subscriptionId) {
				throw new Error('YouTube membership response is invalid.')
			}
			subscriptionId = item.id
		}
		return subscriptionId
	}

	async review(channelId: string) {
		assertChannelId(channelId)
		const context = await this.context()
		const id = await this.membership(context.auth, channelId)
		if (context.revision !== await this.revision() ||
				this.config.mode !== 'youtube') {
			throw new Error('Authorization changed.')
		}
		const pending = await this.db.get(SQL`SELECT target
			FROM api_subscription_actions WHERE profileKey=${context.profileKey}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			ORDER BY startedAt DESC, rowid DESC LIMIT 1;`)
		return { current: !!id, previousTarget: pending ? !!pending.target : null }
	}

	async acknowledge(channelId: string, expected: boolean) {
		assertChannelId(channelId)
		const context = await this.context()
		if (!!await this.membership(context.auth, channelId) !== expected ||
				context.revision !== await this.revision()) {
			throw new Error('YouTube subscription state changed.')
		}
		await this.db.run(SQL`UPDATE api_subscription_actions
			SET state=CASE WHEN target=${expected ? 1 : 0} THEN 'confirmed'
			ELSE 'acknowledged' END, finishedAt=${new Date().toISOString()}
			WHERE profileKey=${context.profileKey} AND channelId=${channelId}
			AND state IN ('pending', 'uncertain');`)
	}

	async unsubscribe(channelId: string) { return this.change(channelId, false) }
	async undo(channelId: string) { return this.change(channelId, true) }

	private async change(channelId: string, target: boolean) {
		assertChannelId(channelId)
		const context = await this.context()
		const pending = await this.db.get(SQL`SELECT id
			FROM api_subscription_actions WHERE profileKey=${context.profileKey}
			AND channelId=${channelId}
			AND state IN ('pending', 'uncertain') LIMIT 1;`)
		if (pending) return 'uncertain'
		const current = await this.membership(context.auth, channelId)
		if (!!current === target) return 'unchanged'
		if (target) {
			const last = await this.db.get(SQL`SELECT target, state
				FROM api_subscription_actions WHERE profileKey=${context.profileKey}
				AND channelId=${channelId}
				ORDER BY startedAt DESC, rowid DESC LIMIT 1;`)
			if (!last || last.target !== 0 || last.state !== 'confirmed') {
				throw new Error('No confirmed unsubscribe is available to undo.')
			}
		}
		const access = await context.auth.getAccessToken()
		if (!access.token) throw new Error('YouTube authorization is unavailable.')
		const info = await context.auth.getTokenInfo(access.token)
		if (!info.scopes.some(scope => MANAGE_SCOPES.includes(scope))) {
			throw new Error('YouTube management access is required.')
		}
		if (context.revision !== await this.revision() ||
				this.config.mode !== 'youtube') {
			throw new Error('Authorization changed.')
		}
		// A token-only client prevents OAuth from replaying a non-idempotent write.
		const writeAuth = new OAuth2Client()
		writeAuth.setCredentials({ access_token: access.token })
		const id = randomUUID()
		await this.db.run(SQL`INSERT INTO api_subscription_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES (${id}, ${context.profileKey}, ${channelId}, ${target ? 1 : 0},
				'pending', ${new Date().toISOString()});`)
		try {
			if (target) {
				await this.service.subscriptions.insert({ auth: writeAuth,
					part: ['snippet'], requestBody: { snippet: { resourceId: {
						kind: 'youtube#channel', channelId,
					} } } }, { retry: false, timeout: 15_000 })
			} else {
				await this.service.subscriptions.delete({ auth: writeAuth,
					id: current! }, { retry: false, timeout: 15_000 })
			}
		} catch {
			// A lost acknowledgement cannot prove whether the write took effect.
		}
		let confirmed = false
		try {
			const subscribed = !!await this.membership(context.auth, channelId)
			confirmed = subscribed === target &&
				context.revision === await this.revision() &&
				this.config.mode === 'youtube'
		} catch {
			// Preserve uncertainty until an explicit review.
		}
		const state = confirmed ? 'confirmed' : 'uncertain'
		await this.db.run(SQL`UPDATE api_subscription_actions SET state=${state},
			finishedAt=${new Date().toISOString()} WHERE id=${id};`)
		return state
	}
}
