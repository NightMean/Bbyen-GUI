import { expect, describe, test, vi, beforeEach, afterEach } from 'vitest'
import RSSParser from 'rss-parser'
import * as sqlite from 'sqlite'

import { parseFeedsAndNotify } from './videos'
import { Config } from './config'
import { init } from './database'
import { _resetAlertState, notifyError } from './lib/alertState'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn(),
}) }))

describe('video failure recovery', () => {
	let db: sqlite.Database
	const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
	const sendVideoEmail = vi.fn().mockResolvedValue(undefined)
	const list = vi.fn()
	const config = {
		mode: 'youtube', notifyOnFirstScan: true,
		logging: { emailOnError: true },
	} as Config
	const args = () => ({
		db, config, service: { videos: { list } } as never,
		auth: {} as never, sendErrorEmail, sendVideoEmail,
	})
	beforeEach(async () => {
		vi.clearAllMocks()
		_resetAlertState()
		db = await init({ filename: ':memory:' })
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,channelThumbnail)
			VALUES ('UCfixture', 'Creator', 'avatar')`)
		vi.spyOn(RSSParser.prototype, 'parseURL').mockResolvedValue({
			items: [{ videoId: 'new-video', title: 'Video',
				isoDate: '2026-01-01T00:00:00Z' }],
		} as never)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await db.close()
	})

	test('alerts once for repeated API authentication failures', async () => {
		list.mockRejectedValue(new Error('invalid_grant'))
		await parseFeedsAndNotify(args())
		await parseFeedsAndNotify(args())
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
		expect(await db.all('SELECT * FROM videos')).toHaveLength(0)
	})

	test('alerts on RSS failures instead of clearing the outage', async () => {
		vi.mocked(RSSParser.prototype.parseURL)
			.mockRejectedValue(new Error('RSS timeout'))
		const result = await parseFeedsAndNotify(args())
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({ status: 'failed', failed: 1, total: 1 })
	})

	test('reports partial success when a channel feed fails', async () => {
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,channelThumbnail)
			VALUES ('UCsecond', 'Second', 'avatar')`)
		vi.mocked(RSSParser.prototype.parseURL).mockImplementation(async url => {
			if (String(url).includes('UCsecond')) throw new Error('RSS timeout')
			return { title: 'Creator', items: [] } as never
		})
		const result = await parseFeedsAndNotify({ ...args(), config: {
			...config, mode: 'whitelist',
		} } as never)
		expect(result).toMatchObject({ status: 'partial', total: 2,
			succeeded: 1, failed: 1, skipped: 0 })
	})

	test('reports skipped channels after SMTP failure', async () => {
		await db.run(`INSERT INTO subscriptions
			(channelId,channelTitle,channelThumbnail)
			VALUES ('UCsecond', 'Second', 'avatar')`)
		sendVideoEmail.mockRejectedValueOnce(Object.assign(new Error('rejected'), {
			responseCode: 550,
		}))
		const result = await parseFeedsAndNotify({ ...args(), config: {
			...config, mode: 'whitelist',
		} } as never)
		expect(result).toMatchObject({ status: 'failed', total: 2,
			succeeded: 0, failed: 1, skipped: 1, failedChannels: ['UCfixture'] })
	})

	test('alerts again after API recovery and recurrence', async () => {
		list.mockRejectedValueOnce(new Error('invalid_grant'))
		await parseFeedsAndNotify(args())
		list.mockResolvedValueOnce({ data: { items: [{
			snippet: { publishedAt: '2026-01-01T00:00:00Z', title: 'Video',
				channelTitle: 'Creator', thumbnails: { high: { url: 'thumb' } } },
			contentDetails: { duration: 'PT1M' },
		}] } })
		await parseFeedsAndNotify(args())
		expect(await db.all('SELECT * FROM videos')).toHaveLength(1)
		vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({
			items: [{ videoId: 'next-video' }],
		} as never)
		list.mockRejectedValueOnce(new Error('invalid_grant'))
		await parseFeedsAndNotify(args())
		expect(sendErrorEmail).toHaveBeenCalledTimes(2)
	})

	test('an empty video run cannot clear a subscription outage', async () => {
		const deps = { sendErrorEmail, emailOnError: true,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			source: 'subscriptions' }
		await notifyError('auth', new Error('invalid_grant'), deps)
		vi.mocked(RSSParser.prototype.parseURL)
			.mockResolvedValue({ items: [] } as never)
		await parseFeedsAndNotify(args())
		await notifyError('auth', new Error('invalid_grant'), deps)
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
	})

	test('an empty successful feed establishes the first-scan baseline',
		async () => {
			const manual = { ...config, mode: 'whitelist', notifyOnFirstScan: false }
			vi.mocked(RSSParser.prototype.parseURL)
				.mockResolvedValueOnce({ items: [] } as never)
				.mockResolvedValueOnce({ title: 'Creator', items: [{
					videoId: 'later', title: 'Video',
					isoDate: '2026-01-01T00:00:00Z',
				}] } as never)
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
		})

	test('a failed feed does not establish a first-scan baseline', async () => {
		const manual = { ...config, mode: 'whitelist', notifyOnFirstScan: false }
		vi.mocked(RSSParser.prototype.parseURL)
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ title: 'Creator', items: [{
				videoId: 'old', title: 'Video', isoDate: '2026-01-01T00:00:00Z',
			}] } as never)
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(sendVideoEmail).not.toHaveBeenCalled()
	})

	test('persists newest selection through metadata failures and feed changes',
		async () => {
			const newest = { ...config, initialBacklog: { mode: 'newest', count: 1 } }
			const item = (id: string, date: string) => ({
				videoId: id, title: id, isoDate: date,
			})
			vi.mocked(RSSParser.prototype.parseURL)
				.mockResolvedValueOnce({ items: [
					item('old', '2026-01-01T00:00:00Z'),
					item('new', '2026-01-02T00:00:00Z'),
				] } as never)
				.mockResolvedValueOnce({ items: [
					item('later', '2026-01-03T00:00:00Z'),
					item('new', '2026-01-02T00:00:00Z'),
				] } as never)
			list.mockResolvedValueOnce({ data: { items: [] } })
			const details = { data: { items: [{
				snippet: { publishedAt: '2026-01-02T00:00:00Z', title: 'Video',
					channelTitle: 'Creator', thumbnails: { high: { url: 'thumb' } } },
				contentDetails: { duration: 'PT1M' },
			}] } }
			list.mockRejectedValueOnce(new Error('invalid_grant'))
			list.mockResolvedValue(details)
			await parseFeedsAndNotify({ ...args(), config: newest } as never)
			await parseFeedsAndNotify({ ...args(), config: newest } as never)
			expect(sendVideoEmail.mock.calls.map(call => call[0].videoId))
				.toEqual(['later', 'new'])
			expect(await db.get(`SELECT notify FROM initial_backlog_videos
				WHERE videoId='old'`)).toEqual({ notify: 0 })
		})

	test('records metadata and skipped backlog outcome', async () => {
		const manual = { ...config, mode: 'whitelist', notifyOnFirstScan: false }
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(await db.get(`SELECT title, emailOutcome FROM video_observations
			WHERE videoId='new-video'`)).toEqual({
			title: 'Video', emailOutcome: 'backlog_skipped',
		})
	})

	test('channel policy overrides the global backlog policy', async () => {
		const manual = {
			...config, mode: 'whitelist', initialBacklog: { mode: 'none' },
			channelSettingsById: new Map([['UCfixture', {
				id: 'UCfixture', initialBacklog: { mode: 'all' },
			}]]),
		}
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(sendVideoEmail).toHaveBeenCalledTimes(1)
	})

	test('emails only the newest N items from the initial feed', async () => {
		const manual = { ...config, mode: 'whitelist',
			initialBacklog: { mode: 'newest', count: 1 } }
		vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({ items: [
			{ videoId: 'older', title: 'Old', isoDate: '2026-01-01T00:00:00Z' },
			{ videoId: 'newer', title: 'New', isoDate: '2026-01-02T00:00:00Z' },
		] } as never)
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(sendVideoEmail.mock.calls.map(call => call[0].videoId))
			.toEqual(['newer'])
		expect(await db.get(`SELECT emailOutcome FROM video_observations
			WHERE videoId='older'`)).toEqual({ emailOutcome: 'backlog_skipped' })
	})

	test('records and emails a video with an unknown publication date',
		async () => {
			const manual = { ...config, mode: 'whitelist' }
			vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({ items: [
				{ videoId: 'no-date', title: 'Video', isoDate: 'invalid' },
			] } as never)
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect(await db.get(`SELECT publishedAt, emailOutcome
				FROM video_observations WHERE videoId='no-date'`))
				.toEqual({ publishedAt: null, emailOutcome: 'sent' })
		})

	test('stores API videos even when duration is unavailable', async () => {
		list.mockResolvedValue({ data: { items: [{
			snippet: { publishedAt: '2026-01-01T00:00:00Z', title: 'Video',
				channelTitle: 'Creator', thumbnails: { high: { url: 'thumb' } } },
			contentDetails: {},
		}] } })
		await parseFeedsAndNotify(args())
		expect(await db.get(`SELECT durationSeconds, emailOutcome
			FROM video_observations WHERE videoId='new-video'`))
			.toEqual({ durationSeconds: null, emailOutcome: 'sent' })
	})

	test('observes an active livestream and emails the VOD', async () => {
		const base = { snippet: {
			publishedAt: '2026-01-01T00:00:00Z', title: 'Live',
			channelTitle: 'Creator', thumbnails: { high: { url: 'thumb' } },
		}, contentDetails: { duration: 'PT1M' } }
		list.mockResolvedValueOnce({ data: { items: [{
			...base, liveStreamingDetails: {
				actualStartTime: '2026-01-01T00:00:00Z',
			},
		}] } }).mockResolvedValueOnce({ data: { items: [{
			...base, liveStreamingDetails: { actualEndTime: '2026-01-01T01:00:00Z' },
		}] } })
		await parseFeedsAndNotify(args())
		expect(sendVideoEmail).not.toHaveBeenCalled()
		expect(await db.get(`SELECT contentType, emailOutcome
			FROM video_observations WHERE videoId='new-video'`)).toEqual({
			contentType: 'livestream', emailOutcome: 'discovered',
		})
		await parseFeedsAndNotify(args())
		expect(sendVideoEmail).toHaveBeenCalledTimes(1)
		expect(await db.get(`SELECT emailOutcome FROM video_observations
			WHERE videoId='new-video'`)).toEqual({ emailOutcome: 'sent' })
	})

	test('unmuting does not replay muted videos', async () => {
		const muted = { ...config, mode: 'whitelist', channelSettingsById:
			new Map([['UCfixture', { id: 'UCfixture', notify: false }]]) }
		await parseFeedsAndNotify({ ...args(), config: muted } as never)
		vi.mocked(RSSParser.prototype.parseURL).mockResolvedValue({ items: [
			{ videoId: 'new-video', title: 'Video',
				isoDate: '2026-01-01T00:00:00Z' },
			{ videoId: 'later', title: 'Later',
				isoDate: '2026-01-02T00:00:00Z' },
		] } as never)
		await parseFeedsAndNotify({ ...args(), config:
			{ ...muted, channelSettingsById: new Map() } } as never)
		expect(sendVideoEmail.mock.calls.map(call => call[0].videoId))
			.toEqual(['later'])
		expect(await db.get(`SELECT emailOutcome FROM video_observations
			WHERE videoId='new-video'`)).toEqual({ emailOutcome: 'muted' })
	})

	test('retention does not cause video emails to be resent', async () => {
		const manual = { ...config, mode: 'whitelist', videoRetentionDays: 1 }
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		await db.run(`UPDATE video_observations
			SET observedAt='2000-01-01T00:00:00.000Z'`)
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(sendVideoEmail).toHaveBeenCalledTimes(1)
		expect(await db.get('SELECT * FROM video_observations')).toBeUndefined()
		expect(await db.get('SELECT videoId FROM videos')).toEqual({
			videoId: 'new-video',
		})
	})

	test('does not resend a video when email delivery is uncertain', async () => {
		const manual = { ...config, mode: 'whitelist' }
		sendVideoEmail.mockRejectedValueOnce(new Error('connection lost'))
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(sendVideoEmail).toHaveBeenCalledTimes(1)
		expect(await db.get(`SELECT emailOutcome FROM video_observations
			WHERE videoId='new-video'`)).toEqual({ emailOutcome: 'uncertain' })
	})

	test('records an explicit SMTP rejection as failed without resending',
		async () => {
			const manual = { ...config, mode: 'whitelist' }
			const rejection = Object.assign(new Error('rejected'), {
				responseCode: 550,
			})
			sendVideoEmail.mockRejectedValueOnce(rejection)
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect(await db.get(`SELECT emailOutcome FROM video_observations
				WHERE videoId='new-video'`)).toEqual({ emailOutcome: 'failed' })
		})

	test('records the attempt before sending and saves the sent time',
		async () => {
			const manual = { ...config, mode: 'whitelist' }
			sendVideoEmail.mockImplementationOnce(async () => {
				expect(await db.get(`SELECT emailOutcome FROM video_observations
				WHERE videoId='new-video'`)).toEqual({ emailOutcome: 'pending' })
			})
			await parseFeedsAndNotify({ ...args(), config: manual } as never)
			expect(await db.get(`SELECT emailOutcome, sentAt FROM video_observations
			WHERE videoId='new-video'`)).toEqual({
				emailOutcome: 'sent', sentAt: expect.any(String),
			})
		})
})
