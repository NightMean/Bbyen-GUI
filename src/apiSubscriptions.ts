import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { DEFAULT_CHANNEL_THUMBNAIL } from './database'
import { subscriptionIterator, subscriptionMembershipIterator }
	from './google/iterators'
import { isChannelId } from './lib/channelId'

export interface ApiChannel {
	channelId: string, title: string, thumbnail: string,
	subscriptionId: string | null, subscribedAt: string | null,
}

/** Accumulate and validate pages before any source change can be committed. */
export class ApiSubscriptionSnapshot {
	private readonly entries = new Map<string, ApiChannel>()
	private add(item: youtube_v3.Schema$Subscription, allowed?: Set<string>) {
		const channelId = item.snippet?.resourceId?.channelId
		if (!channelId || !isChannelId(channelId) ||
				(allowed && !allowed.has(channelId)) || this.entries.has(channelId)) {
			throw new Error('API subscription response is invalid.')
		}
		const date = item.snippet?.publishedAt
		this.entries.set(channelId, { channelId,
			title: item.snippet?.title || channelId,
			thumbnail: item.snippet?.thumbnails?.high?.url ||
				DEFAULT_CHANNEL_THUMBNAIL,
			subscriptionId: typeof item.id === 'string' ? item.id : null,
			subscribedAt: typeof date === 'string' &&
				Number.isFinite(Date.parse(date))
				? new Date(date).toISOString() : null })
		if (this.entries.size > 10_000) throw new Error('Too many subscriptions.')
	}

	async read(service: youtube_v3.Youtube, auth: OAuth2Client): Promise<void> {
		for await (const item of subscriptionIterator(service, auth,
			{ timeout: 30_000 })) this.add(item)
	}

	async verifyKnown(service: youtube_v3.Youtube, auth: OAuth2Client,
		ids: string[]): Promise<boolean> {
		const missing = ids.filter(id => !this.entries.has(id))
		for (let offset = 0; offset < missing.length; offset += 50) {
			const batch = missing.slice(offset, offset + 50)
			const allowed = new Set(batch)
			for await (const item of subscriptionMembershipIterator(service, auth,
				batch, { timeout: 30_000 })) this.add(item, allowed)
		}
		return ids.every(id => this.entries.has(id))
	}

	channels(): ApiChannel[] {
		return [...this.entries.values()].sort((a, b) =>
			a.channelId.localeCompare(b.channelId))
	}
}

/** Apply a reviewed snapshot inside the caller's database transaction. */
export const applyApiSnapshot = async (db: sqlite.Database, snapshot: {
	channels: ApiChannel[], manual: string[], terminated: string[],
	tracked: { channelId: string }[],
}): Promise<void> => {
	const now = new Date().toISOString()
	const terminated = new Set(snapshot.terminated)
	const next = new Set(snapshot.channels.map(item => item.channelId)
		.filter(id => !terminated.has(id)))
	for (const id of snapshot.manual) if (!terminated.has(id)) next.add(id)
	await db.run('UPDATE channel_sources SET apiSubscribed=0, manual=0')
	for (const item of snapshot.channels) {
		await db.run(SQL`INSERT INTO channel_sources
			(channelId, apiSubscribed, apiSubscriptionId, apiSubscribedAt,
				apiObservedAt) VALUES (${item.channelId}, 1, ${item.subscriptionId},
				${item.subscribedAt}, ${now}) ON CONFLICT(channelId) DO UPDATE SET
				apiSubscribed=1, apiSubscriptionId=excluded.apiSubscriptionId,
				apiSubscribedAt=excluded.apiSubscribedAt,
				apiObservedAt=excluded.apiObservedAt;`)
	}
	for (const id of snapshot.manual) await db.run(SQL`INSERT INTO
		channel_sources (channelId, manual) VALUES (${id}, 1)
		ON CONFLICT(channelId) DO UPDATE SET manual=1;`)
	const details = new Map(snapshot.channels.map(item => [item.channelId, item]))
	for (const id of next) {
		const old = await db.get(SQL`SELECT deleted, deletedReason
			FROM subscriptions WHERE channelId=${id};`)
		if (old?.deleted && old.deletedReason !== 'terminated') {
			await db.run(SQL`DELETE FROM video_scan_baselines WHERE channelId=${id};`)
			await db.run(SQL`DELETE FROM initial_backlog_videos
				WHERE channelId=${id};`)
		}
		const item = details.get(id)
		await db.run(SQL`INSERT INTO subscriptions
			(channelId, channelTitle, channelThumbnail, firstObservedAt, deleted)
			VALUES (${id}, ${item?.title ?? id},
				${item?.thumbnail ?? DEFAULT_CHANNEL_THUMBNAIL}, ${now}, 0)
			ON CONFLICT(channelId) DO UPDATE SET
				deleted=CASE WHEN deletedReason='terminated' THEN 1 ELSE 0 END,
				deletedReason=CASE WHEN deletedReason='terminated' THEN 'terminated'
					ELSE NULL END,
				deletedAt=CASE WHEN deletedReason='terminated' THEN deletedAt
					ELSE NULL END,
				bellState=NULL;`)
	}
	for (const item of snapshot.tracked) {
		if (next.has(item.channelId)) continue
		await db.run(SQL`UPDATE subscriptions SET deleted=1,
			deletedReason='source-switch', deletedAt=${now}, bellState=NULL
			WHERE channelId=${item.channelId} AND deleted=0;`)
	}
}
