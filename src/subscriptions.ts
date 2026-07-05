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
import findNullishValues from './lib/findNullishValues'
import { classifyError } from './lib/classifyError'
import { notifyError, clearErrorState } from './lib/alertState'
import { assertChannelId } from './lib/channelId'
import { ISendErrorEmail } from './email'

// Extract canonical channel ids from a list of normalized channel entries.
const channelIds = (entries?: ChannelEntry[]): string[] =>
	(entries ?? []).map(entry => entry.id)

// Scrape a channel's avatar URL from its public page (no API). Best-effort:
// returns a placeholder on any failure so a missing avatar never blocks
// notifications.
const AVATAR_PLACEHOLDER =
	'https://www.gstatic.com/youtube/img/creator/no_avatar.png'

const scrapeChannelAvatar = async (channelId: string): Promise<string> => {
	try {
		const url = `https://www.youtube.com/channel/${channelId}`
		const response = await axios(url)
		const soup = new JSSoup(response.data)
		const meta = soup.findAll('meta')
			.find((m: { attrs?: { property?: string, content?: string } }) =>
				m.attrs?.property === 'og:image')
		return meta?.attrs?.content ?? AVATAR_PLACEHOLDER
	} catch {
		return AVATAR_PLACEHOLDER
	}
}

interface ChannelDetails {
	title: string,
	thumbnail: string,
}

interface IUpdateSubscriptions {
	db: sqlite.Database,
	service: youtube_v3.Youtube,
	auth: OAuth2Client,
	config: Config,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
}

// Read all known subs from the database
const getSavedSubscriptions = async (db: sqlite.Database) =>
	new Set<string>(
		(await db.all(SQL`SELECT channelId FROM subscriptions WHERE deleted=0;`))
			.map(sub => sub.channelId)
	)

// Add any new subscriptions to the database
const insertNewSubscriptions = async (
	db: sqlite.Database,
	logger: winston.Logger,
	newSubscriptions: string[],
	channelDetails: Map<string, ChannelDetails>,
) => {

	// Prevent double insertion
	const stmtClean = await db.prepare(SQL`
		DELETE FROM subscriptions WHERE channelId=?;`)

	for (const channelId of newSubscriptions) {
		await stmtClean.run(channelId)
	}

	await stmtClean.finalize()

	const stmtInsert = await db.prepare(SQL`
		INSERT INTO subscriptions (
			channelId,
			channelTitle,
			channelThumbnail
		)
		VALUES (?, ?, ?);
	`)

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

		logger.info(`${i+1}/${newSubscriptions.length} New subscription: ${title}`)

		await stmtInsert.run(channelId, title, thumbnail)
	}

	await stmtInsert.finalize()
}

// Delete any removed subscriptions (unsubscriptions) from the database
const removeDeletedSubscriptions = async (
	db: sqlite.Database,
	logger: winston.Logger,
	removedSubscriptions: Iterable<string>,
) => {
	const stmt = await db.prepare(SQL`
		UPDATE subscriptions
		SET deleted=1
		WHERE channelId=?;
	`)

	for (let channelId of removedSubscriptions) {
		const { channelTitle } = await db.get(SQL`
			SELECT channelTitle
			FROM subscriptions
			WHERE channelId=${channelId};
		`)
		await stmt.run(channelId)

		logger.info(`Removed subscription: ${channelTitle}`)
	}
	await stmt.finalize()
}

function* chunks<T>(arr: T[], n: number) {
	for (let i = 0; i < arr.length; i += n) {
		yield arr.slice(i, i + n)
	}
}

export const updateSubscriptionsFromAPI = async (
	{ db, service, auth, config }: IUpdateSubscriptions
) => {
	const logger = await setupLogger({ label: 'subscriptions' })

	logger.info('Checking subscriptions...')

	// Read all known subs from the database
	const savedSubscriptions = await getSavedSubscriptions(db)

	// Get updated list of subs using Google api
	const updatedSubscriptions: Set<string> = new Set()
	const channelDetails: Map<string, ChannelDetails> = new Map()
	for await (let sub of subscriptionIterator(service, auth)) {

		const title = sub.snippet?.title
		const channelId = sub.snippet?.resourceId?.channelId
		const thumbnail = sub.snippet?.thumbnails?.high?.url

		if (!title || !channelId || !thumbnail) {
			const missingKeys = findNullishValues({ title, channelId, thumbnail })
			logger.warn(
				'Could not find all required fields in subscription',
				{ sub, missingKeys })
			continue
		}

		if (channelIds(config.blacklistedChannelIds).includes(channelId)) {
			logger.debug([
				'Ignoring channel in blacklist: ',
				`${title} (${channelId})`,
			].join(''))
			continue
		}

		if (config.whitelistedChannelIds &&
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
			title,
			thumbnail,
		})
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
	await insertNewSubscriptions(
		db, logger, Array.from(newSubscriptions), channelDetails)

	await removeDeletedSubscriptions(db, logger, removedSubscriptions.values())

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

export const updateSubscriptions = async (args: IUpdateSubscriptions) => {
	const logger = await setupLogger({ label: 'subscriptions' })

	try {
		if (args.config.mode === 'whitelist') {
			await updateSubscriptionsFromWhitelistNoApi({
				db: args.db, config: args.config, logger,
			})
		} else if (Array.isArray(args.config.whitelistedChannelIds)) {
			await updateSubscriptionsFromWhitelist(args)
		} else {
			await updateSubscriptionsFromAPI(args)
		}

		// A successful run means auth and quota are healthy account-wide.
		clearErrorState([ 'auth', 'quota', 'other' ])

	} catch (err) {
		logger.debug(JSON.stringify(err, null, '\t'))
		await notifyError(classifyError(err), err, {
			sendErrorEmail: args.sendErrorEmail,
			emailOnError: args.config.logging.emailOnError,
			logger,
		})
	}
}
