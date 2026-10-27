import sqlite from 'sqlite'
import truncate from 'truncate'
import { Logger } from 'winston'
import RSSParser from 'rss-parser'
import SQL from 'sql-template-strings'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { parse as parseDuration, Duration } from 'duration-fns'
import {
	BacklogItem, BacklogPolicy, chooseInitialVideos,
} from './initialBacklog'
import { pruneVideoObservations } from './videoRetention'
import { EmailEligibility, makeEmailEligibility } from './emailPolicy'

import setupLogger from './lib/logger'
import { SendVideoEmail, ISendErrorEmail } from './email'
import { ChannelEntry, Config } from './config'
import findNullishValues from './lib/findNullishValues'
import { classifyError, ErrorCategory } from './lib/classifyError'
import { RefreshResult } from './refreshResult'
import { AlertReporter, defaultAlertReporter } from './lib/alertState'
import {
	isChannelTerminatedOnYouTube,
	handleTerminatedChannel,
} from './lib/channelTermination'

const MAX_METADATA_ENRICHMENT_PER_CHANNEL = 20
const MAX_METADATA_ENRICHMENT_PER_REFRESH = 50

const formatDuration = (duration: Duration) => {
	const hours = duration.hours === 0 ? '' : `${duration.hours}:`
	const minutes = String(duration.minutes)
		.padStart(duration.hours > 0 ? 2 : 0, '0') + ':'
	const seconds = String(duration.seconds).padStart(2, '0')

	return [ hours, minutes, seconds ].join('')
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

const parseDate = (value: string): Date | null => {
	const date = new Date(value)
	return Number.isFinite(date.getTime()) ? date : null
}

interface Channel {
	channelId: string,
	channelTitle: string,
	channelThumbnail: string,
}

interface IGetChannelsVideos {
	channel: Channel,
	logger: Logger,
	auth?: OAuth2Client,
	service: youtube_v3.Youtube,
	parser: RSSParser,
	sendVideoEmail: SendVideoEmail,
	db: sqlite.Database,
	config: Config,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
	alerts: AlertReporter,
	rssOnly?: boolean,
	metadataBudget: { remaining: number },
	getEligibility: (id: string, entry?: ChannelEntry) =>
		EmailEligibility,
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
	getEligibility,
	alerts,
	rssOnly = false,
	metadataBudget,
}: IGetChannelsVideos) => {
	const { channelId, channelThumbnail } = channel
	const outcome: { failed: boolean; stop: boolean; checkedYouTube: boolean;
		category?: ErrorCategory } = {
			failed: false, stop: false, checkedYouTube: false,
		}
	const alert = async (err: unknown) => {
		outcome.failed = true
		outcome.category ??= classifyError(err)
		await alerts.notify(classifyError(err), err, {
			source: 'videos', channelId, sendErrorEmail,
			emailOnError: config.logging.emailOnError, logger,
		})
	}

	const videosSent = new Set((await db.all(SQL`
		SELECT videoId FROM videos WHERE channelId=${channelId};
	`)).map(v => v.videoId))
	const useApi = config.mode !== 'whitelist' && !rssOnly
	const limit = Math.min(metadataBudget.remaining,
		MAX_METADATA_ENRICHMENT_PER_CHANNEL)
	const pendingMetadata = useApi ? new Set((await db.all(SQL`
		SELECT videoId FROM video_observations WHERE channelId=${channelId}
		AND apiMetadataAt IS NULL ORDER BY observedAt DESC
		LIMIT ${limit};
	`)).map(row => row.videoId as string)) : new Set<string>()

	// An empty successful feed is still a completed first scan.
	const baseline = await db.get(SQL`
		SELECT channelId FROM video_scan_baselines WHERE channelId=${channelId};
	`)

	const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
	let feedError: Error | null = null
	const feed = await parser.parseURL(url)
		.catch((err) => {
			feedError = err
			logger.warn(`Could not read the video feed for channel ${channelId}.`)
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
	const feedItems = feed.items as BacklogItem[]
	if (!Array.isArray(feedItems) || feedItems.some(item => !item ||
			typeof item.videoId !== 'string' || !item.videoId)) {
		await alert(new Error('Feed contains an item without a video ID.'))
		return outcome
	}

	const entry = config.channelSettingsById?.get(channelId)
	if (!baseline) {
		const candidates = feedItems.filter(item => !videosSent.has(item.videoId))
		const legacy = entry?.notifyOnFirstScan ?? config.notifyOnFirstScan
		const policy: BacklogPolicy = entry?.initialBacklog ??
			(entry?.notifyOnFirstScan !== undefined ?
				{ mode: legacy ? 'all' : 'none' } : config.initialBacklog) ??
			{ mode: legacy ? 'all' : 'none' }
		const selected = chooseInitialVideos(candidates, policy)
		if (policy.mode === 'newest' && candidates.some(item =>
			!Number.isFinite(Date.parse(item.isoDate ?? item.pubDate ?? '')))) {
			logger.warn('Initial feed has missing or invalid publication dates; ' +
				'newest selection used video IDs to break ties.')
		}
		// Commit the entire first-feed decision before processing any item.
		await db.exec('BEGIN IMMEDIATE')
		try {
			await db.run(SQL`INSERT INTO video_scan_baselines (channelId, completedAt)
				VALUES (${channelId}, ${new Date().toISOString()});`)
			for (const videoId of new Set(candidates.map(item => item.videoId))) {
				const notify = selected.has(videoId) ? 1 : 0
				await db.run(SQL`INSERT INTO initial_backlog_videos
					(channelId, videoId, notify)
					VALUES (${channelId}, ${videoId}, ${notify});`)
			}
			await db.exec('COMMIT')
		} catch (err) {
			await db.exec('ROLLBACK')
			throw err
		}
	}
	const initialVideos = new Map((await db.all(SQL`
		SELECT videoId, notify FROM initial_backlog_videos
		WHERE channelId=${channelId};
	`)).map(row => [row.videoId as string, row.notify as number]))

	// In whitelist mode there is no API channel title; the RSS feed title is the
	// channel name.
	const rssChannelTitle = (feed as { title?: string }).title
	// Previously collected RSS videos may no longer appear in the current feed.
	const feedIds = new Set(feedItems.map(item => item.videoId))
	const queued = [...pendingMetadata].filter(id => !feedIds.has(id))
	const seen = new Set<string>()
	const items = [...feedItems, ...queued.map(videoId => ({ videoId }))]

	for (let { videoId } of items) {
		try {
			if (seen.has(videoId)) continue
			seen.add(videoId)

			const alreadyProcessed = videosSent.has(videoId)
			if (alreadyProcessed && (!useApi || !pendingMetadata.has(videoId))) {
				continue
			}
			if (useApi && (alreadyProcessed || !feedIds.has(videoId))) {
				if (metadataBudget.remaining <= 0) continue
				metadataBudget.remaining--
			}

			let videoDate: Date | null
			let videoTitle: string | null
			let channelTitle: string | null
			let videoThumbnail: string | null
			let videoDuration: Duration | null
			let isLiveStreamOrPremere: boolean
			let isLiveActive = false

			if (!useApi) {
				// RSS-only: no duration, no livestream status. Notify all.
				const item = feed.items.find(it => it.videoId === videoId) as
					{ title?: string, isoDate?: string, pubDate?: string }
					| undefined
				videoDate = mapOption(parseDate, item?.isoDate ?? item?.pubDate)
				videoTitle = mapOption(s => s, item?.title)
				channelTitle = rssChannelTitle ?? channel.channelTitle
				videoThumbnail =
					`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
				videoDuration = null
				isLiveStreamOrPremere = false
			} else {
				const details = (await service.videos.list({
					auth,
					part: ['contentDetails,snippet,liveStreamingDetails'],
					id: [videoId],
				}))?.data?.items?.[0]
				outcome.checkedYouTube = true

				if (details === undefined) {
					logger.warn(`Video list is unedfined for video '${videoId}'`)
					await alert(new Error('Video metadata is unavailable.'))
					continue
				}

				videoDate = mapOption(parseDate, details.snippet?.publishedAt)
				videoTitle = mapOption(s => s, details.snippet?.title)
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

				isLiveActive = isLiveStreamOrPremere &&
					!details.liveStreamingDetails?.actualEndTime
			}

			logger.verbose(
				`New video from ${channelTitle} (id: ${videoId}):`,
				videoTitle,
			)

			// Not really a better way to do this in TypeScript
			// https://stackoverflow.com/questions/57928920/typescript-narrowing-of-keys-in-objects-when-passed-to-function
			// Publication date and duration can be unknown without blocking a video.
			if (videoTitle === null ||
					channelTitle === null ||
					videoThumbnail === null) {

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
				await alert(new Error('Video metadata is incomplete.'))
				continue
			}

			const eligibility = getEligibility(channelId, entry)
			const sendEmail = eligibility === 'eligible' &&
				(initialVideos.get(videoId) ?? 1) === 1
			const emailOutcome = sendEmail ? 'pending' :
				eligibility !== 'eligible' ? eligibility : 'backlog_skipped'
			const seconds = videoDuration
				? videoDuration.weeks * 604800 + videoDuration.days * 86400 +
					videoDuration.hours * 3600 + videoDuration.minutes * 60 +
					videoDuration.seconds : null
			if (alreadyProcessed) {
				const metadataAt = isLiveActive ? null : new Date().toISOString()
				await db.run(SQL`UPDATE video_observations SET title=${videoTitle},
					publishedAt=COALESCE(${videoDate?.toISOString() ?? null},
						publishedAt),
					thumbnailUrl=${videoThumbnail},
					durationSeconds=COALESCE(${seconds}, durationSeconds),
					contentType=COALESCE(
						${isLiveStreamOrPremere ? 'livestream' : null}, contentType),
					apiMetadataAt=${metadataAt} WHERE videoId=${videoId};`)
				continue
			}
			if (isLiveActive) {
				// Preserve the video for the dashboard while waiting for its VOD.
				await db.run(SQL`INSERT INTO video_observations (
					videoId, channelId, title, publishedAt, thumbnailUrl,
					durationSeconds, contentType, observedAt, emailOutcome, apiMetadataAt
				) VALUES (
					${videoId}, ${channelId}, ${videoTitle},
					${videoDate?.toISOString() ?? null}, ${videoThumbnail}, ${seconds},
					'livestream', ${new Date().toISOString()}, 'discovered', NULL
				) ON CONFLICT(videoId) DO UPDATE SET
					title=excluded.title, publishedAt=excluded.publishedAt,
					thumbnailUrl=excluded.thumbnailUrl,
					durationSeconds=excluded.durationSeconds;`)
				continue
			}
			// Record the attempt before SMTP: after a crash it must not be replayed.
			const metadataAt = useApi ? new Date().toISOString() : null
			await db.exec('BEGIN IMMEDIATE')
			try {
				await db.run(SQL`
					INSERT INTO videos (videoId, channelId)
					VALUES (${videoId}, ${channelId});
				`)
				await db.run(SQL`
					INSERT INTO video_observations (
						videoId, channelId, title, publishedAt, thumbnailUrl,
						durationSeconds, contentType, observedAt, emailOutcome,
						apiMetadataAt
					) VALUES (
						${videoId}, ${channelId}, ${videoTitle},
						${videoDate?.toISOString() ?? null}, ${videoThumbnail}, ${seconds},
						${isLiveStreamOrPremere ? 'livestream' : null},
						${new Date().toISOString()}, ${emailOutcome}, ${metadataAt}
					) ON CONFLICT(videoId) DO UPDATE SET
						title=excluded.title, publishedAt=excluded.publishedAt,
						thumbnailUrl=excluded.thumbnailUrl,
						durationSeconds=excluded.durationSeconds,
						contentType=excluded.contentType,
						emailOutcome=excluded.emailOutcome,
						apiMetadataAt=excluded.apiMetadataAt;
				`)
				await db.exec('COMMIT')
			} catch (err) {
				await db.exec('ROLLBACK')
				throw err
			}

			if (sendEmail) {
				try {
					await sendVideoEmail({
						date: videoDate ?? new Date(),
						channelId,
						channelTitle,
						channelThumbnail,
						videoId,
						videoThumbnail,
						videoTitle: truncate(videoTitle, 70),
						isLiveStreamOrPremere,
						videoDuration: videoDuration
							? formatDuration(videoDuration) : '',
						videoURL: `https://www.youtube.com/watch?v=${videoId}`,
					})
				} catch (err) {
					const code = (err as { responseCode?: unknown })?.responseCode
					const result = typeof code === 'number' && code >= 400 &&
						code < 600 ? 'failed' : 'uncertain'
					try {
						await db.run(SQL`UPDATE video_observations
							SET emailOutcome=${result} WHERE videoId=${videoId};`)
					} catch {
						logger.error('Could not record video email outcome.')
					}
					throw err
				}
				await db.run(SQL`UPDATE video_observations
					SET emailOutcome='sent', sentAt=${new Date().toISOString()}
					WHERE videoId=${videoId};`)
			} else {
				logger.verbose([
					`Skipping email for ${channelTitle} (${channelId}):`,
					eligibility === 'muted' ? 'channel muted' :
						eligibility === 'excluded' ? 'excluded by email policy' :
							'first-scan backlog suppressed',
				].join(' '))
			}

		} catch (err) {
			await alert(err)

			if ([
				// EMESSAGE
				550,
				// Gmail uses these
				421, 454,
			].includes((err as { responseCode: number }).responseCode)) {
				logger.warn(
					'SMTP rejected the message; stopping this scan.',
					'The recorded video will not be retried automatically.',
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

	return outcome
}

interface IParseFeedsAndNotify {
	db: sqlite.Database,
	auth?: OAuth2Client,
	service: youtube_v3.Youtube,
	sendVideoEmail: SendVideoEmail,
	config: Config,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
	alerts?: AlertReporter,
	rssOnly?: boolean,
}
export const parseFeedsAndNotify = async (
	{ db, ...rest }: IParseFeedsAndNotify,
): Promise<RefreshResult> => {
	const logger = await setupLogger({ label: 'videos' })
	const alerts = rest.alerts ?? defaultAlertReporter
	let total: number | null = null
	let succeeded = 0
	let failed = 0
	let activeChannel: string | undefined
	let category: ErrorCategory | undefined
	let checkedYouTube = false
	const failedChannels: string[] = []
	const result = (): RefreshResult => ({
		status: failed ? succeeded ? 'partial' : 'failed' : 'success',
		total, succeeded, failed,
		skipped: total === null ? 0 : total - succeeded - failed,
		failedChannels, apiChecked: checkedYouTube,
		...(category ? { errorCategory: category } : {}),
	})

	try {

		logger.info('Checking for new videos...')
		if (rest.config.mode !== 'whitelist' && !rest.rssOnly && !rest.auth) {
			throw new Error('YouTube authorization is required for API video checks.')
		}
		await pruneVideoObservations(db, rest.config.videoRetentionDays ?? null)

		const parser = new RSSParser({
			customFields: {
				item: [
					[ 'yt:videoId', 'videoId' ],
				],
			},
		})
		const manualRows = rest.config.mode === 'youtube' &&
			rest.config.emailSelectionPolicy ? await db.all(`
				SELECT channelId FROM channel_sources
				WHERE manual=1 AND apiSubscribed=0`) : []
		const manualOnly = new Set<string>(manualRows.map(row => row.channelId))
		const getEligibility = makeEmailEligibility(rest.config, manualOnly)
		const metadataBudget = { remaining: MAX_METADATA_ENRICHMENT_PER_REFRESH }

		const channels: Channel[] = await db.all(SQL`
			SELECT channelId, channelTitle, channelThumbnail
			FROM subscriptions
			WHERE deleted=0;
		`)
		total = channels.length

		for (const [i, channel] of channels.entries()) {
			activeChannel = channel.channelId
			logger.verbose([
				`${i + 1}/${channels.length}`,
				`Checking channel ${channel.channelTitle} (${channel.channelId})`,
			].join(' '))

			const channelResult = await getChannelsVideos({
				channel,
				parser,
				logger,
				db,
				getEligibility,
				metadataBudget,
				...rest,
				alerts,
			})

			if (channelResult.failed) {
				failed++
				failedChannels.push(channel.channelId)
				category ??= channelResult.category
			} else {
				succeeded++
				if (!rest.rssOnly) {
					await alerts.clear(['other'], 'videos', channel.channelId)
				}
				if (channelResult.checkedYouTube) {
					await alerts.clear(['auth', 'quota'], 'videos', channel.channelId)
				}
			}
			activeChannel = undefined
			checkedYouTube ||= channelResult.checkedYouTube
			if (channelResult.stop) {
				return result()
			}
		}

		if (!failed && channels.length > 0 && !rest.rssOnly) {
			await alerts.clear([ 'other' ], 'videos')
			if (checkedYouTube) await alerts.clear([ 'auth', 'quota' ], 'videos')
		}

		logger.info('Finished checking for new videos')
		return result()
	} catch (err) {
		category ??= classifyError(err)
		if (activeChannel) {
			failed++
			failedChannels.push(activeChannel)
		}
		await alerts.notify(classifyError(err), err, {
			source: 'videos',
			sendErrorEmail: rest.sendErrorEmail,
			emailOnError: rest.config.logging.emailOnError,
			logger,
		})
		return { ...result(), status: succeeded ? 'partial' : 'failed' }
	}
}
