import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { OAuth2Client } from 'google-auth-library'
import { youtube_v3 } from 'googleapis'
import { CookieConnectionStore } from './cookieConnection'
import { subscriptionMembershipIterator } from './google/iterators'
import { isChannelId } from './lib/channelId'
import { readAccountIdentity, sameAccount } from './google/accountIdentity'
import { withAuthorizationTimeout } from './google/desktopAuthorization'

/** Enrich cookie channels without changing their monitoring state. */
export const refreshCombinedMetadata = async (options: {
	db: sqlite.Database, service: youtube_v3.Youtube, auth: OAuth2Client,
	store: CookieConnectionStore, revision: () => Promise<string>,
}) => {
	const connection = await options.store.read()
	if (!connection?.profile.channelId) throw new Error('Cookie is unavailable.')
	const revision = await options.revision()
	const identity = await withAuthorizationTimeout(
		readAccountIdentity(options.service, options.auth))
	if (!sameAccount(identity.channelId, connection.profile.channelId) ||
			revision !== await options.revision()) {
		throw new Error('YouTube account identity does not match the cookie.')
	}
	const rows = await options.db.all(SQL`SELECT channelId
		FROM cookie_channel_state
		WHERE profileKey=${connection.profile.channelId} AND subscribed=1
		ORDER BY channelId LIMIT 10001;`)
	if (rows.length > 10_000 || rows.some(row => !isChannelId(row.channelId))) {
		throw new Error('Cookie channel list is invalid.')
	}
	const entries = new Map<string, { subscriptionId: string | null,
		subscribedAt: string | null, thumbnail: string | null }>()
	for (let offset = 0; offset < rows.length; offset += 50) {
		const requested = new Set<string>(rows.slice(offset, offset + 50)
			.map(row => row.channelId))
		for await (const item of subscriptionMembershipIterator(options.service,
			options.auth, [...requested], { timeout: 30_000 })) {
			const id = item.snippet?.resourceId?.channelId
			if (!id || !requested.has(id) || entries.has(id)) {
				throw new Error('API subscription response is invalid.')
			}
			const date = item.snippet?.publishedAt
			entries.set(id, {
				subscriptionId: typeof item.id === 'string' ? item.id : null,
				subscribedAt: typeof date === 'string' &&
					Number.isFinite(Date.parse(date))
					? new Date(date).toISOString() : null,
				thumbnail: item.snippet?.thumbnails?.high?.url ?? null,
			})
		}
	}
	if ((await options.store.read())?.generation !== connection.generation ||
			revision !== await options.revision()) {
		throw new Error('Connections changed during API refresh.')
	}
	await options.db.exec('BEGIN IMMEDIATE')
	try {
		for (const [id, entry] of entries) {
			await options.db.run(SQL`INSERT INTO combined_subscription_metadata
				(profileKey, channelId, subscriptionId, subscribedAt, observedAt)
				VALUES (${connection.profile.channelId}, ${id}, ${entry.subscriptionId},
					${entry.subscribedAt}, ${new Date().toISOString()})
				ON CONFLICT(profileKey, channelId) DO UPDATE SET
					subscriptionId=excluded.subscriptionId,
					subscribedAt=CASE WHEN excluded.subscriptionId IS NOT NULL AND
						excluded.subscriptionId=
							combined_subscription_metadata.subscriptionId
						THEN COALESCE(excluded.subscribedAt,
							combined_subscription_metadata.subscribedAt)
						ELSE excluded.subscribedAt END,
					observedAt=excluded.observedAt;`)
			if (entry.thumbnail) await options.db.run(SQL`UPDATE subscriptions
				SET channelThumbnail=${entry.thumbnail} WHERE channelId=${id};`)
		}
		await options.db.exec('COMMIT')
	} catch (error) { await options.db.exec('ROLLBACK'); throw error }
	return { matched: entries.size, total: rows.length }
}
