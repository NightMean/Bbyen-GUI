import { randomUUID } from 'crypto'
import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { assertChannelId } from './lib/channelId'
import {
	extractSapisidFromCookie, subscribeToChannel, unsubscribeFromChannel,
} from './lib/innertubeChannels'
import { RefreshResult } from './refreshResult'

interface Mutations {
	subscribe: typeof subscribeToChannel,
	unsubscribe: typeof unsubscribeFromChannel,
}

/** Called from the shared queue; uncertain writes are never replayed. */
export class CookieSubscriptionActions {
	constructor(private readonly db: sqlite.Database,
		private readonly config: Config,
		private readonly store: CookieConnectionStore,
		private readonly sync: () => Promise<RefreshResult>,
		private readonly mutations: Mutations = {
			subscribe: subscribeToChannel, unsubscribe: unsubscribeFromChannel,
		}) {}

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
		const row = await this.db.get(SQL`SELECT subscribed
			FROM cookie_channel_state WHERE profileKey=${after.profile.channelId}
			AND channelId=${channelId};`)
		return { connection: after, subscribed: !!row?.subscribed }
	}

	async review(channelId: string) {
		assertChannelId(channelId)
		const current = await this.observe(channelId)
		const pending = await this.db.get(SQL`SELECT target
			FROM cookie_subscription_actions
			WHERE profileKey=${current.connection.profile.channelId}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			ORDER BY startedAt DESC LIMIT 1;`)
		return { current: current.subscribed,
			previousTarget: pending ? !!pending.target : null }
	}

	async acknowledge(channelId: string, expected: boolean) {
		assertChannelId(channelId)
		const current = await this.observe(channelId)
		if (current.subscribed !== expected) throw new Error('State changed.')
		await this.db.run(SQL`UPDATE cookie_subscription_actions
			SET state='acknowledged', finishedAt=${new Date().toISOString()}
			WHERE profileKey=${current.connection.profile.channelId}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain');`)
	}

	async change(channelId: string, target: boolean) {
		assertChannelId(channelId)
		if (typeof target !== 'boolean') throw new Error('Invalid subscription.')
		const observed = await this.observe(channelId)
		const profile = observed.connection.profile
		const pendingBell = await this.db.get(SQL`SELECT id FROM cookie_bell_actions
			WHERE profileKey=${profile.channelId} AND channelId=${channelId}
			AND state IN ('pending', 'uncertain') LIMIT 1;`)
		if (pendingBell) return 'uncertain'
		const pending = await this.db.get(SQL`SELECT id, target
			FROM cookie_subscription_actions WHERE profileKey=${profile.channelId}
			AND channelId=${channelId} AND state IN ('pending', 'uncertain')
			ORDER BY startedAt DESC LIMIT 1;`)
		if (pending) {
			if (observed.subscribed !== !!pending.target) return 'uncertain'
			await this.db.run(SQL`UPDATE cookie_subscription_actions
				SET state='confirmed', finishedAt=${new Date().toISOString()}
				WHERE id=${pending.id};`)
		}
		if (observed.subscribed === target) return 'unchanged'
		const cookie = observed.connection.cookieHeader
		const sapisid = extractSapisidFromCookie(cookie)
		if (!sapisid) throw new Error('Cookie connection is invalid.')
		const id = randomUUID()
		await this.db.run(SQL`INSERT INTO cookie_subscription_actions
			(id, profileKey, channelId, target, state, startedAt)
			VALUES (${id}, ${profile.channelId}, ${channelId}, ${target ? 1 : 0},
				'pending', ${new Date().toISOString()});`)
		try {
			await (target ? this.mutations.subscribe : this.mutations.unsubscribe)(
				cookie, sapisid, channelId, profile.pageId)
		} catch {
			// A lost acknowledgement cannot prove that YouTube rejected the request.
		}
		let confirmed = false
		try {
			const after = await this.observe(channelId)
			confirmed = after.connection.generation ===
				observed.connection.generation && after.subscribed === target
		} catch {
			// Preserve uncertainty; a later explicit review can reconcile it.
		}
		const state = confirmed ? 'confirmed' : 'uncertain'
		await this.db.run(SQL`UPDATE cookie_subscription_actions SET state=${state},
			finishedAt=${new Date().toISOString()} WHERE id=${id};`)
		return state
	}
}
