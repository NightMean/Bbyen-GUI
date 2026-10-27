import * as sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { ChannelBellState } from './lib/innertubeChannels'
import { isChannelId } from './lib/channelId'
import { DEFAULT_CHANNEL_THUMBNAIL } from './database'

interface CookieSnapshot {
	profileKey: string,
	complete: boolean,
	activateProfile?: boolean,
	suppressNotifications?: boolean,
	channels: ChannelBellState[],
}

interface PreviousState {
	channelId: string,
	subscribed: number,
	lastConfirmedBell: string | null,
}

/** Apply only a complete, explicitly selected profile snapshot. */
export const reconcileCookieSnapshot = async (
	db: sqlite.Database, snapshot: CookieSnapshot,
): Promise<void> => {
	if (snapshot.complete !== true) {
		throw new Error('Cookie snapshot is incomplete.')
	}
	if (typeof snapshot.profileKey !== 'string' || !snapshot.profileKey.trim() ||
			!Array.isArray(snapshot.channels)) {
		throw new Error('Cookie snapshot needs a profile and channel list.')
	}
	const ids = new Set<string>()
	for (const channel of snapshot.channels) {
		if (!channel || !isChannelId(channel.channelId) ||
				typeof channel.title !== 'string' ||
				!['all', 'personalized', 'none', 'unknown']
					.includes(channel.notificationState) || ids.has(channel.channelId)) {
			throw new Error('Cookie snapshot contains invalid or duplicate channels.')
		}
		ids.add(channel.channelId)
	}
	const profileKey = snapshot.profileKey
	const now = new Date().toISOString()
	await db.exec('BEGIN IMMEDIATE')
	try {
		const active = await db.get('SELECT profileKey FROM cookie_active_profile')
		if (active?.profileKey !== profileKey && !snapshot.activateProfile) {
			throw new Error('Confirm the cookie profile before applying changes.')
		}
		const notifyEligible = snapshot.suppressNotifications ||
			(active && active.profileKey !== profileKey) ? 0 : 1
		const previous = new Map<string, PreviousState>((await db.all(SQL`
			SELECT channelId, subscribed, lastConfirmedBell
			FROM cookie_channel_state WHERE profileKey=${profileKey};
		`)).map(row => [row.channelId, row]))
		const monitored = new Set<string>()
		for (const channel of snapshot.channels) {
			const prior = previous.get(channel.channelId)
			const confirmed = channel.notificationState === 'unknown'
				? prior?.subscribed ? prior.lastConfirmedBell : null
				: channel.notificationState
			const last = prior?.subscribed ? prior.lastConfirmedBell : null
			if (confirmed && confirmed !== last) {
				await db.run(SQL`INSERT INTO cookie_channel_events
					(profileKey, channelId, previousState, currentState,
						notifyEligible, observedAt)
					VALUES (${profileKey}, ${channel.channelId}, ${last},
						${confirmed}, ${notifyEligible}, ${now});`)
			}
			await db.run(SQL`INSERT INTO cookie_channel_state
				(profileKey, channelId, subscribed, latestBell,
					lastConfirmedBell, observedAt)
				VALUES (${profileKey}, ${channel.channelId}, 1,
					${channel.notificationState}, ${confirmed}, ${now})
				ON CONFLICT(profileKey, channelId) DO UPDATE SET
					subscribed=1, latestBell=excluded.latestBell,
					lastConfirmedBell=excluded.lastConfirmedBell,
					observedAt=excluded.observedAt;`)
			const existing = await db.get(SQL`SELECT deleted, deletedReason
				FROM subscriptions WHERE channelId=${channel.channelId};`)
			// A first unknown bell must not revoke an already tracked channel.
			// It remains unconfirmed until YouTube supplies a definite state.
			const track = confirmed === 'all' || (confirmed === null &&
				channel.notificationState === 'unknown' && existing?.deleted === 0)
			if (track) monitored.add(channel.channelId)
			if (confirmed === 'all' && existing?.deleted &&
					existing.deletedReason !== 'terminated') {
				await db.run(SQL`DELETE FROM video_scan_baselines
					WHERE channelId=${channel.channelId};`)
				await db.run(SQL`DELETE FROM initial_backlog_videos
					WHERE channelId=${channel.channelId};`)
			}
			const inactive = track ? 0 : 1
			const reason = inactive ? 'cookie-ineligible' : null
			await db.run(SQL`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail, firstObservedAt,
					bellState, bellUpdatedAt, deleted, deletedReason, deletedAt)
				VALUES (${channel.channelId}, ${channel.title || channel.channelId},
					${DEFAULT_CHANNEL_THUMBNAIL}, ${now}, ${channel.notificationState},
					${now}, ${inactive}, ${reason}, ${inactive ? now : null})
				ON CONFLICT(channelId) DO UPDATE SET
					channelTitle=CASE WHEN ${channel.title} <> '' AND
						${channel.title} <> ${channel.channelId} THEN ${channel.title}
						ELSE subscriptions.channelTitle END,
					bellUpdatedAt=CASE WHEN subscriptions.bellState IS NOT
						${channel.notificationState} THEN ${now}
						ELSE subscriptions.bellUpdatedAt END,
					bellState=${channel.notificationState},
					deleted=CASE WHEN deletedReason='terminated' THEN 1
						ELSE ${inactive} END,
					deletedReason=CASE WHEN deletedReason='terminated' THEN 'terminated'
						ELSE ${reason} END,
					deletedAt=CASE WHEN deletedReason='terminated' THEN deletedAt
						WHEN ${inactive}=0 THEN NULL
						WHEN deleted=0 THEN ${now} ELSE deletedAt END;`)
		}
		for (const prior of previous.values()) {
			if (!prior.subscribed || ids.has(prior.channelId)) continue
			await db.run(SQL`UPDATE cookie_channel_state SET subscribed=0,
				latestBell=NULL, observedAt=${now} WHERE profileKey=${profileKey}
				AND channelId=${prior.channelId};`)
			await db.run(SQL`INSERT INTO cookie_channel_events
				(profileKey, channelId, previousState, currentState,
					notifyEligible, observedAt)
				VALUES (${profileKey}, ${prior.channelId}, ${prior.lastConfirmedBell},
					'unsubscribed', ${notifyEligible}, ${now});`)
		}
		const activeChannels = await db.all(`SELECT channelId FROM subscriptions
			WHERE deleted=0`)
		for (const row of activeChannels) {
			if (monitored.has(row.channelId)) continue
			await db.run(SQL`UPDATE subscriptions SET deleted=1,
				deletedReason='cookie-ineligible', deletedAt=${now}
				WHERE channelId=${row.channelId} AND deleted=0;`)
		}
		await db.run(SQL`INSERT INTO cookie_active_profile (id, profileKey)
			VALUES (1, ${profileKey}) ON CONFLICT(id) DO UPDATE SET
				profileKey=excluded.profileKey;`)
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}
}
