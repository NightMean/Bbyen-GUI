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
import {
	isChannelTerminatedOnYouTube,
	handleTerminatedChannel,
} from './lib/channelTermination'

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
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
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
	sendErrorEmail,
}: IGetChannelsVideos) => {
	const { channelId, channelThumbnail } = channel
	const outcome = { failed: false, stop: false, checkedYouTube: false }
	const alert = async (err: unknown) => {
		outcome.failed = true
		await notifyError(classifyError(err), err, {
			source: 'videos', sendErrorEmail,
			emailOnError: config.logging.emailOnError, logger,
		})
	}

	const videosSent = new Set((await db.all(SQL`
		SELECT videoId FROM videos WHERE channelId=${channelId};
	`)).map(v => v.videoId))

	// An empty successful feed is still a completed first scan.
	const baseline = await db.get(SQL`
		SELECT channelId FROM video_scan_baselines WHERE channelId=${channelId};
	`)
	const isFirstScan = !baseline

	const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
	let feedError: Error | null = null
	const feed = await parser.parseURL(url)
		.catch((err) => {
			feedError = err
			logger.warn(`Error parsing videos from '${url}': ${err.message}`)
			return { items: [], title: undefined }
		})

	if (feedError && /404|status code 404/i.test((feedError as Error).message)) {
		const isTerminated = await isChannelTerminatedOnYouTube(channelId)
		if (isTerminated) {
			await handleTerminatedChannel(
				db,
				channel,
				sendErrorEmail,
				logger,
			)
			return outcome
		}
	}
	if (feedError) {
		await alert(feedError)
		return outcome
	}

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
				outcome.checkedYouTube = true

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
			await alert(err)

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
				outcome.stop = true
				return outcome
			}
			if (classifyError(err) !== 'other') {
				outcome.stop = true
				return outcome
			}
		}
	}

	if (!outcome.failed) {
		await db.run(SQL`
			INSERT OR IGNORE INTO video_scan_baselines (channelId, completedAt)
			VALUES (${channelId}, ${new Date().toISOString()});
		`)
	}
	return outcome
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

		let failed = false
		let checkedYouTube = false
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

			failed ||= result.failed
			checkedYouTube ||= result.checkedYouTube
			if (result.stop) {
				return
			}
		}

		if (!failed) {
			clearErrorState([ 'other' ], 'videos')
			if (checkedYouTube) clearErrorState([ 'auth', 'quota' ], 'videos')
		}

		logger.info('Finished checking for new videos')
	} catch (err) {
		await notifyError(classifyError(err), err, {
			source: 'videos',
			sendErrorEmail: rest.sendErrorEmail,
			emailOnError: rest.config.logging.emailOnError,
			logger,
		})
	}
}
