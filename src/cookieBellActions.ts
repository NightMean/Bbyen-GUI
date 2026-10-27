import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { assertChannelId } from './lib/channelId'
import {
	BellNotificationPreference, extractSapisidFromCookie,
	setChannelNotificationPreference,
} from './lib/innertubeChannels'
import { RefreshResult } from './refreshResult'

type Mutation = typeof setChannelNotificationPreference
type BellOutcome = 'confirmed' | 'unchanged' | 'uncertain'

/** Run within the shared maintenance queue to serialize source changes. */
export class CookieBellActions {
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly sync: () => Promise<RefreshResult>,
		private readonly mutate: Mutation = setChannelNotificationPreference) {}

	private async observe(channelId: string) {
		if (this.config.mode !== 'cookie') throw new Error('Cookie mode required.')
		const before = await this.store.read()
		if (!before) throw new Error('Cookie connection unavailable.')
		const result = await this.sync()
		const after = await this.store.read()
		if (result.status !== 'success' || !after ||
				after.generation !== before.generation ||
				this.config.mode !== 'cookie') {
			throw new Error('Could not confirm the current YouTube state.')
		}
		const row = await this.db.get(SQL`SELECT subscribed, latestBell
			FROM cookie_channel_state WHERE profileKey=${after.profile.channelId}
			AND channelId=${channelId};`)
		if (!row?.subscribed || !['all', 'personalized', 'none']
			.includes(row.latestBell)) {
			throw new Error('The channel subscription or bell is unconfirmed.')
		}
		return { connection: after,
			bell: row.latestBell as BellNotificationPreference }
	}

	async review(channelId: string) {
		assertChannelId(channelId)
		const observed = await this.observe(channelId)
		const pending = await this.db.get(SQL`SELECT target FROM cookie_bell_actions
			WHERE profileKey=${observed.connection.profile.channelId}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			ORDER BY startedAt DESC LIMIT 1;`)
		return { current: observed.bell, previousTarget: pending?.target ?? null }
	}

	async acknowledge(channelId: string, expected: BellNotificationPreference) {
		assertChannelId(channelId)
		const observed = await this.observe(channelId)
		if (observed.bell !== expected) throw new Error('Bell state changed.')
		await this.db.run(SQL`UPDATE cookie_bell_actions
			SET state='acknowledged', finishedAt=${new Date().toISOString()}
			WHERE profileKey=${observed.connection.profile.channelId}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain');`)
	}

	async change(channelId: string, target: BellNotificationPreference)
		: Promise<BellOutcome> {
		assertChannelId(channelId)
		if (!['all', 'personalized', 'none'].includes(target)) {
			throw new Error('Invalid bell preference.')
		}
		const observed = await this.observe(channelId)
		const profileKey = observed.connection.profile.channelId!
		const pendingSubscription = await this.db.get(SQL`SELECT id
			FROM cookie_subscription_actions WHERE profileKey=${profileKey}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			LIMIT 1;`)
		if (pendingSubscription) return 'uncertain'
		const unresolved = await this.db.get(SQL`SELECT id, target
			FROM cookie_bell_actions WHERE profileKey=${profileKey}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			ORDER BY startedAt DESC LIMIT 1;`)
		if (unresolved) {
			if (observed.bell !== unresolved.target) return 'uncertain'
			await this.db.run(SQL`UPDATE cookie_bell_actions SET state='confirmed',
				finishedAt=${new Date().toISOString()} WHERE id=${unresolved.id};`)
		}
		if (observed.bell === target) return 'unchanged'
		const sapisid = extractSapisidFromCookie(observed.connection.cookieHeader)
		if (!sapisid) throw new Error('Cookie connection is invalid.')
		const id = randomUUID()
		await this.db.run(SQL`INSERT INTO cookie_bell_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES (${id}, ${profileKey}, ${channelId}, ${target}, 'pending',
				${new Date().toISOString()});`)
		try {
			await this.mutate(observed.connection.cookieHeader, sapisid, channelId,
				target, observed.connection.profile.pageId)
		} catch {
			// The request may have succeeded even if its acknowledgement was lost.
		}
		let confirmed = false
		try {
			const after = await this.observe(channelId)
			confirmed = after.connection.generation ===
				observed.connection.generation && after.bell === target
		} catch {
			// Keep the operation uncertain and never replay it automatically.
		}
		const outcome = confirmed ? 'confirmed' : 'uncertain'
		await this.db.run(SQL`UPDATE cookie_bell_actions SET state=${outcome},
			finishedAt=${new Date().toISOString()} WHERE id=${id};`)
		return outcome
	}
}
