import sqlite from 'sqlite'
import truncate from 'truncate'
import { Logger } from 'winston'
import RSSParser from 'rss-parser'
import SQL from 'sql-template-strings'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { parse as parseDuration, Duration } from 'duration-fns'

import setupLogger from './lib/logger'
import { SendVideoEmail, ISendErrorEmail } from './email'
import { Config, ChannelEntry } from './config'
import findNullishValues from './lib/findNullishValues'
import { classifyError } from './lib/classifyError'
import { notifyError, clearErrorState } from './lib/alertState'

const formatDuration = (duration: Duration) => {
	const hours = duration.hours === 0 ? '' : `${duration.hours}:`
	const minutes = String(duration.minutes)
		.padStart(duration.hours > 0 ? 2 : 0, '0') + ':'
	const seconds = String(duration.seconds).padStart(2, '0')

	return [ hours, minutes, seconds ].join('')
}

// Decide whether to send an email for a video from a given channel.
// Muted channels never notify. On a channel's first scan (no videos yet
// recorded), honor the per-channel override else the global flag. Otherwise
// always notify. The video is recorded in the DB regardless of this result.
export const shouldSendEmail = (
	config: Pick<Config, 'notifyOnFirstScan'>,
	entry: ChannelEntry | undefined,
	isFirstScan: boolean,
): boolean => {
	if (entry?.notify === false) {
		return false
	}
	if (isFirstScan) {
		return entry?.notifyOnFirstScan ?? config.notifyOnFirstScan
	}
	return true
}

// Helper to deal with YouTube data API giving back a bunch of options
// Works like Rust Option<T>.map
const mapOption = <Type>(
	fn: (arg: string) => Type,
	value: string | null | undefined,
): Type | null => {
	if (!value) {
		return null
	}
	return fn(value)
}

interface Channel {
	channelId: string,
	channelTitle: string,
	channelThumbnail: string,
}

interface IGetChannelsVideos {
	channel: Channel,
	logger: Logger,
	auth: OAuth2Client,
	service: youtube_v3.Youtube,
	parser: RSSParser,
	sendVideoEmail: SendVideoEmail,
	db: sqlite.Database,
	config: Config,
}
const getChannelsVideos = async ({
	channel,
	logger,
	parser,
	service,
	auth,
	sendVideoEmail,
	db,
	config,
}: IGetChannelsVideos): Promise<boolean> => {
	const { channelId, channelThumbnail } = channel

	const videosSent = new Set((await db.all(SQL`
		SELECT videoId FROM videos WHERE channelId=${channelId};
	`)).map(v => v.videoId))

	// A channel with no recorded videos is being scanned for the first time.
	// Computed once so every video in this run shares the same value.
	const isFirstScan = videosSent.size === 0

	const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
	const feed = await parser.parseURL(url)
		.catch((err) => {
			logger.warn(`Error parsing videos from '${url}': ${err.message}`)
			return { items: [], title: undefined }
		})

	// In whitelist mode there is no API channel title; the RSS feed title is the
	// channel name.
	const rssChannelTitle = (feed as { title?: string }).title

	for (let { videoId } of feed.items) {
		try {

			if (videosSent.has(videoId)) continue

			let videoDate: Date | null
			let videoTitle: string | null
			let channelTitle: string | null
			let videoThumbnail: string | null
			let videoDuration: Duration | null
			let isLiveStreamOrPremere: boolean

			if (config.mode === 'whitelist') {
				// RSS-only: no duration, no livestream status. Notify all.
				const item = feed.items.find(it => it.videoId === videoId) as
					{ title?: string, isoDate?: string, pubDate?: string }
					| undefined
				videoDate = mapOption(
					s => new Date(s), item?.isoDate ?? item?.pubDate)
				videoTitle = mapOption(s => truncate(s, 70), item?.title)
				channelTitle = rssChannelTitle ?? channel.channelTitle
				videoThumbnail =
					`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
				videoDuration = null
				isLiveStreamOrPremere = false
			} else {
				const details = (await service.videos.list({
					auth,
					part: ['contentDetails,snippet,liveStreamingDetails'],
					id: videoId,
				}))?.data?.items?.[0]

				if (details === undefined) {
					logger.warn(`Video list is unedfined for video '${videoId}'`)
					continue
				}

				videoDate =
					mapOption(s => new Date(s), details.snippet?.publishedAt)
				videoTitle =
					mapOption(s => truncate(s, 70), details.snippet?.title)
				channelTitle = details.snippet?.channelTitle ?? null
				videoThumbnail = (
					details.snippet?.thumbnails?.maxres?.url ??
					details.snippet?.thumbnails?.standard?.url ??
					details.snippet?.thumbnails?.high?.url
				) ?? null
				videoDuration =
					mapOption(parseDuration, details.contentDetails?.duration)
				isLiveStreamOrPremere =
					details && 'liveStreamingDetails' in details

				// Only send the notification once the livestream ended
				// I prefer to watch the VOD later
				if (isLiveStreamOrPremere &&
						!details.liveStreamingDetails?.actualEndTime) {
					continue
				}
			}

			logger.verbose(
				`New video from ${channelTitle} (id: ${videoId}):`,
				videoTitle,
			)

			// Not really a better way to do this in TypeScript
			// https://stackoverflow.com/questions/57928920/typescript-narrowing-of-keys-in-objects-when-passed-to-function
			// Duration is only required in youtube mode (RSS has no duration).
			if (videoDate === null ||
					videoTitle === null ||
					channelTitle === null ||
					videoThumbnail === null ||
					(config.mode !== 'whitelist' && videoDuration === null)) {

				const missingKeys = findNullishValues({
					videoDate,
					channelTitle,
					videoThumbnail,
					videoTitle,
					videoDuration,
				})

				logger.warn(
					`Could not find all required fields for video '${videoId}'`,
					{ missingKeys },
				)
				continue
			}

			const entry = config.channelSettingsById?.get(channelId)
			const sendEmail = shouldSendEmail(config, entry, isFirstScan)

			if (sendEmail) {
				await sendVideoEmail({
					date: videoDate,
					channelId,
					channelTitle,
					channelThumbnail,
					videoId,
					videoThumbnail,
					videoTitle,
					isLiveStreamOrPremere,
					videoDuration: videoDuration
						? formatDuration(videoDuration) : '',
					videoURL: `https://www.youtube.com/watch?v=${videoId}`,
				})
			} else {
				logger.verbose([
					`Skipping email for ${channelTitle} (${channelId}):`,
					entry?.notify === false
						? 'channel muted'
						: 'first-scan backlog suppressed',
				].join(' '))
			}

			// Always record the video so muted / suppressed videos are not
			// re-notified on a later run.
			await db.run(SQL`
				INSERT INTO videos (videoId, channelId)
				VALUES (${videoId}, ${channelId});
			`)

		} catch (err) {

			if ([
				// EMESSAGE
				550,
				// Gmail uses these
				421, 454,
			].includes((err as { responseCode: number }).responseCode)) {
				logger.warn(
					'Email quota has run out.',
					'Abandoning, will retry on next timer trigger.',
				)
				return false
			}

			logger.error(err)
		}
	}

	return true
}

interface IParseFeedsAndNotify {
	db: sqlite.Database,
	auth: OAuth2Client,
	service: youtube_v3.Youtube,
	sendVideoEmail: SendVideoEmail,
	config: Config,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
}
export const parseFeedsAndNotify = async (
	{ db, ...rest }: IParseFeedsAndNotify,
) => {
	const logger = await setupLogger({ label: 'videos' })

	try {

		logger.info('Checking for new videos...')

		const parser = new RSSParser({
			customFields: {
				item: [
					[ 'yt:videoId', 'videoId' ],
				],
			},
		})

		const channels: Channel[] = await db.all(SQL`
			SELECT channelId, channelTitle, channelThumbnail
			FROM subscriptions
			WHERE deleted=0;
		`)

		for (const [i, channel] of channels.entries()) {
			logger.verbose([
				`${i + 1}/${channels.length}`,
				`Checking channel ${channel.channelTitle} (${channel.channelId})`,
			].join(' '))

			const result = await getChannelsVideos({
				channel,
				parser,
				logger,
				db,
				...rest
			})

			if (!result) {
				return
			}
		}

		// A successful run means auth and quota are healthy account-wide.
		clearErrorState([ 'auth', 'quota', 'other' ])

		logger.info('Finished checking for new videos')
	} catch (err) {
		await notifyError(classifyError(err), err, {
			sendErrorEmail: rest.sendErrorEmail,
			emailOnError: rest.config.logging.emailOnError,
			logger,
		})
	}
}
