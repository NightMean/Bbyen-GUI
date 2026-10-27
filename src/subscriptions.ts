import axios from 'axios'
import JSSoup from 'jssoup'
import sqlite from 'sqlite'
import SQL from 'sql-template-strings'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import winston from 'winston'

import { Config, ChannelEntry } from './config'
import setupLogger from './lib/logger'
import { subscriptionIterator } from './google/iterators'
import { classifyError } from './lib/classifyError'
import { AlertReporter, defaultAlertReporter } from './lib/alertState'
import { assertChannelId, isChannelId } from './lib/channelId'
import { ISendErrorEmail } from './email'
import { DEFAULT_CHANNEL_THUMBNAIL } from './database'
import { RefreshResult } from './refreshResult'

// Extract canonical channel ids from a list of normalized channel entries.
const channelIds = (entries?: ChannelEntry[]): string[] =>
	(entries ?? []).map(entry => entry.id)

// Scrape a channel's avatar URL from its public page (no API). Best-effort:
// returns a placeholder on any failure so a missing avatar never blocks
// notifications.
const scrapeChannelAvatar = async (channelId: string): Promise<string> => {
	try {
		const url = `https://www.youtube.com/channel/${channelId}`
		const response = await axios(url)
		const soup = new JSSoup(response.data)
		const meta = soup.findAll('meta')
			.find((m: { attrs?: { property?: string, content?: string } }) =>
				m.attrs?.property === 'og:image')
		return meta?.attrs?.content ?? DEFAULT_CHANNEL_THUMBNAIL
	} catch {
		return DEFAULT_CHANNEL_THUMBNAIL
	}
}

interface ChannelDetails {
	title: string,
	thumbnail: string,
}

interface IUpdateSubscriptions {
	db: sqlite.Database,
	service: youtube_v3.Youtube,
	auth?: OAuth2Client,
	config: Config,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
	alerts?: AlertReporter,
}

// Read all known subs from the database
const getSavedSubscriptions = async (db: sqlite.Database) =>
	new Set<string>(
		(await db.all(SQL`
			SELECT channelId FROM subscriptions
			WHERE deleted=0 OR deletedReason='terminated';
		`))
			.map(sub => sub.channelId)
	)

// Add any new subscriptions to the database
const insertNewSubscriptions = async (
	db: sqlite.Database,
	logger: winston.Logger,
	newSubscriptions: string[],
	channelDetails: Map<string, ChannelDetails>,
	insideTransaction = false,
) => {

	const stmtInsert = await db.prepare(SQL`
		INSERT INTO subscriptions (
			channelId,
			channelTitle,
			channelThumbnail,
			firstObservedAt
		)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(channelId) DO UPDATE SET
			channelTitle=CASE WHEN excluded.channelTitle=excluded.channelId
				THEN subscriptions.channelTitle ELSE excluded.channelTitle END,
			channelThumbnail=excluded.channelThumbnail,
			firstObservedAt=COALESCE(
				subscriptions.firstObservedAt, excluded.firstObservedAt),
			deleted=0, deletedReason=NULL, deletedAt=NULL
		WHERE COALESCE(subscriptions.deletedReason, '') <> 'terminated';
	`)

	try {
		if (!insideTransaction) await db.exec('BEGIN IMMEDIATE')
		try {
			for (const [i, channelId] of newSubscriptions.entries()) {
				const res = channelDetails.get(channelId)

				if (!res) {
					logger.warn([
						`Could not find channel ID ${channelId} in channelDetails.`,
						'Skipping.',
					].join(' '))
					continue
				}

				const { title, thumbnail } = res

				logger.info(
					`${i+1}/${newSubscriptions.length} New subscription: ${title}`)

				const existing = await db.get(SQL`
				SELECT deleted, deletedReason FROM subscriptions
				WHERE channelId=${channelId};`)
				if (existing?.deleted && existing.deletedReason !== 'terminated') {
					await db.run(SQL`DELETE FROM video_scan_baselines
					WHERE channelId=${channelId};`)
					await db.run(SQL`DELETE FROM initial_backlog_videos
					WHERE channelId=${channelId};`)
				}
				await stmtInsert.run(
					channelId, title, thumbnail, new Date().toISOString())
			}
			if (!insideTransaction) await db.exec('COMMIT')
		} catch (err) {
			if (!insideTransaction) await db.exec('ROLLBACK')
			throw err
		}
	} finally {
		await stmtInsert.finalize()
	}
}

// Delete any removed subscriptions (unsubscriptions) from the database
const removeDeletedSubscriptions = async (
	db: sqlite.Database,
	logger: winston.Logger,
	removedSubscriptions: Iterable<string>,
) => {
	const now = new Date().toISOString()
	const stmt = await db.prepare(SQL`
		UPDATE subscriptions
		SET deleted=1,
			deletedReason='unsubscribed',
			deletedAt=?
		WHERE channelId=? AND COALESCE(deletedReason, '') <> 'terminated';
	`)

	try {
		for (let channelId of removedSubscriptions) {
			const { channelTitle } = await db.get(SQL`
			SELECT channelTitle
			FROM subscriptions
			WHERE channelId=${channelId};
		`)
			const result = await stmt.run(now, channelId)
			if (result.changes) {
				logger.info(`Removed subscription: ${channelTitle}`)
			}
		}
	} finally {
		await stmt.finalize()
	}
}

function* chunks<T>(arr: T[], n: number) {
	for (let i = 0; i < arr.length; i += n) {
		yield arr.slice(i, i + n)
	}
}

export const updateSubscriptionsFromAPI = async (
	{ db, service, auth, config }: IUpdateSubscriptions
) => {
	if (!auth) throw new Error('YouTube authorization is required for API sync.')
	const logger = await setupLogger({ label: 'subscriptions' })
	logger.info('Checking subscriptions...')

	// Read all known subs from the database
	const savedSubscriptions = await getSavedSubscriptions(db)

	// Get updated list of subs using Google api
	const updatedSubscriptions: Set<string> = new Set()
	const channelDetails: Map<string, ChannelDetails> = new Map()
	const apiSources = new Map<string, {
		subscriptionId: string | null, subscribedAt: string | null,
	}>()
	for await (let sub of subscriptionIterator(service, auth)) {

		const title = sub.snippet?.title
		const channelId = sub.snippet?.resourceId?.channelId
		const thumbnail = sub.snippet?.thumbnails?.high?.url

		if (!channelId) {
			throw new Error('Subscription response is missing a channel ID; ' +
				'the previous snapshot was preserved.')
		}
		if (!isChannelId(channelId)) {
			throw new Error('Subscription response contains an invalid channel ID; ' +
				'the previous snapshot was preserved.')
		}
		const publishedAt = sub.snippet?.publishedAt
		apiSources.set(channelId, {
			subscriptionId: typeof sub.id === 'string' ? sub.id : null,
			subscribedAt: typeof publishedAt === 'string' &&
				Number.isFinite(Date.parse(publishedAt))
				? new Date(publishedAt).toISOString() : null,
		})

		if (!config.emailSelectionPolicy &&
				channelIds(config.blacklistedChannelIds).includes(channelId)) {
			logger.debug([
				'Ignoring channel in blacklist: ',
				`${title} (${channelId})`,
			].join(''))
			continue
		}

		if (!config.emailSelectionPolicy && config.whitelistedChannelIds &&
				!channelIds(config.whitelistedChannelIds).includes(channelId)) {
			logger.debug([
				'Ignoring channel not in whitelist: ',
				`${title} (${channelId})`,
			].join(''))
			continue
		}

		logger.verbose(`${title} (${channelId})`)
		logger.debug(JSON.stringify(sub.contentDetails, null, '	'))

		updatedSubscriptions.add(channelId)
		channelDetails.set(channelId, {
			title: title ?? channelId,
			thumbnail: thumbnail ?? DEFAULT_CHANNEL_THUMBNAIL,
		})
	}
	const manualIds = config.emailSelectionPolicy
		? new Set(channelIds(config.manualChannelIds).map(assertChannelId))
		: new Set<string>()
	for (const channelId of manualIds) {
		updatedSubscriptions.add(channelId)
		if (!channelDetails.has(channelId)) {
			channelDetails.set(channelId, {
				title: channelId, thumbnail: DEFAULT_CHANNEL_THUMBNAIL,
			})
		}
	}

	// Compute difference of both sets to determine new / removed subs
	const newSubscriptions = new Set(
		[...updatedSubscriptions]
			.filter(sub => !savedSubscriptions.has(sub))
	)

	const removedSubscriptions = new Set(
		[...savedSubscriptions]
			.filter(sub => !updatedSubscriptions.has(sub))
	)

	// Add any new subscriptions to the database
	await db.exec('BEGIN IMMEDIATE')
	try {
		if (config.emailSelectionPolicy) {
			await db.run('UPDATE channel_sources SET apiSubscribed=0, manual=0')
			const now = new Date().toISOString()
			for (const [channelId, source] of apiSources) {
				await db.run(SQL`INSERT INTO channel_sources
					(channelId, apiSubscribed, apiSubscriptionId, apiSubscribedAt,
						apiObservedAt)
					VALUES (${channelId}, 1, ${source.subscriptionId},
						${source.subscribedAt}, ${now})
					ON CONFLICT(channelId) DO UPDATE SET apiSubscribed=1,
						apiSubscriptionId=excluded.apiSubscriptionId,
						apiSubscribedAt=excluded.apiSubscribedAt,
						apiObservedAt=excluded.apiObservedAt;`)
			}
			for (const channelId of manualIds) {
				await db.run(SQL`INSERT INTO channel_sources (channelId, manual)
					VALUES (${channelId}, 1)
					ON CONFLICT(channelId) DO UPDATE SET manual=1;`)
			}
		}
		await insertNewSubscriptions(
			db, logger, Array.from(newSubscriptions), channelDetails, true)
		await removeDeletedSubscriptions(db, logger, removedSubscriptions.values())
		await db.exec('COMMIT')
	} catch (err) {
		await db.exec('ROLLBACK')
		throw err
	}

	logger.info('Done checking subscriptions...')
}

// Workaround for #19
// If user uses a whitelist, there is no need to use the API to get the
// subscriptions. This works around the issue with the YouTube API that only
// around 1000 results are returned. Unfortunately, it only works for people
// using the whitelist.
export const updateSubscriptionsFromWhitelist = async (
	{ db, auth, service, config }: IUpdateSubscriptions
) => {
	if (!auth) throw new Error('YouTube authorization is required for API sync.')
	const logger = await setupLogger({ label: 'subscriptions' })

	// Read all known subs from the database
	const savedSubscriptions = await getSavedSubscriptions(db)
	const whitelistedChannelIds = new Set<string>(
		channelIds(config.whitelistedChannelIds))

	const newlyWhitelisted = Array.from(whitelistedChannelIds)
		.filter(x => !savedSubscriptions.has(x))
	const channelDetails: Map<string, ChannelDetails> = new Map()

	// Maximum results YT API lets us get at a time
	const MAX_RESULTS = 50

	for (const chunk of chunks(newlyWhitelisted, MAX_RESULTS)) {
		const res = await service.channels.list({
			auth,
			part: ['id,snippet'],
			id: chunk,
			maxResults: MAX_RESULTS,
		})

		for (const channel of res.data.items ?? []) {
			const channelId = channel.id
			const title = channel.snippet?.title
			const thumbnail = channel.snippet?.thumbnails?.high?.url

			if (!title || !channelId || !thumbnail) {
				logger.warn(
					'Could not find all required fields in channel',
					{ channel })
				continue
			}

			channelDetails.set(channelId, {
				title,
				thumbnail,
			})
		}
	}

	const removedSubscriptions = new Set(
		[...savedSubscriptions]
			.filter(sub => !whitelistedChannelIds.has(sub))
	)

	await insertNewSubscriptions(db, logger, newlyWhitelisted, channelDetails)
	await removeDeletedSubscriptions(db, logger, removedSubscriptions.values())
}

// Whitelist discovery without the API (no-login mode). Requires raw channel
// IDs. The channel title is stored as the ID placeholder and refined later from
// the RSS feed by the videos task; the avatar is scraped once per channel.
export const updateSubscriptionsFromWhitelistNoApi = async (
	{ db, config, logger }: {
		db: sqlite.Database,
		config: Config,
		logger: winston.Logger,
	},
) => {
	const savedSubscriptions = await getSavedSubscriptions(db)

	const ids: string[] = []
	for (const entry of config.whitelistedChannelIds ?? []) {
		try {
			ids.push(assertChannelId(entry.id))
		} catch (err) {
			logger.warn((err as Error).message)
		}
	}
	const whitelistedChannelIds = new Set<string>(ids)

	const newlyWhitelisted = ids.filter(x => !savedSubscriptions.has(x))
	const channelDetails: Map<string, ChannelDetails> = new Map()
	for (const channelId of newlyWhitelisted) {
		channelDetails.set(channelId, {
			title: channelId,
			thumbnail: await scrapeChannelAvatar(channelId),
		})
	}

	const removedSubscriptions = new Set(
		[...savedSubscriptions].filter(sub => !whitelistedChannelIds.has(sub)))

	await insertNewSubscriptions(db, logger, newlyWhitelisted, channelDetails)
	await removeDeletedSubscriptions(db, logger, removedSubscriptions.values())
}

export const updateSubscriptions = async (
	args: IUpdateSubscriptions,
): Promise<RefreshResult> => {
	const logger = await setupLogger({ label: 'subscriptions' })
	const alerts = args.alerts ?? defaultAlertReporter

	try {
		if (args.config.mode === 'whitelist') {
			await updateSubscriptionsFromWhitelistNoApi({
				db: args.db, config: args.config, logger,
			})
		} else if (!args.config.emailSelectionPolicy &&
				Array.isArray(args.config.whitelistedChannelIds)) {
			await updateSubscriptionsFromWhitelist(args)
		} else {
			await updateSubscriptionsFromAPI(args)
		}

		await alerts.clear([ 'other' ], 'subscriptions')
		if (args.config.mode !== 'whitelist') {
			await alerts.clear([ 'auth', 'quota' ], 'subscriptions')
		}
		return { status: 'success', total: 1, succeeded: 1, failed: 0,
			skipped: 0, failedChannels: [], apiChecked: args.config.mode === 'youtube'
				&& (!!args.config.emailSelectionPolicy ||
					!Array.isArray(args.config.whitelistedChannelIds)) }

	} catch (err) {
		await alerts.notify(classifyError(err), err, {
			source: 'subscriptions',
			sendErrorEmail: args.sendErrorEmail,
			emailOnError: args.config.logging.emailOnError,
			logger,
		})
		return { status: 'failed', total: 1, succeeded: 0, failed: 1,
			skipped: 0, failedChannels: [], errorCategory: classifyError(err) }
	}
}
