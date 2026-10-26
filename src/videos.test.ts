import { expect, describe, test, vi, beforeEach, afterEach } from 'vitest'
import RSSParser from 'rss-parser'
import * as sqlite from 'sqlite'

import { shouldSendEmail, parseFeedsAndNotify } from './videos'
import { ChannelEntry, Config } from './config'
import { init } from './database'
import { _resetAlertState, notifyError } from './lib/alertState'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn(),
}) }))

describe('shouldSendEmail', () => {
	const on = { notifyOnFirstScan: true }
	const off = { notifyOnFirstScan: false }

	test('no entry, not first scan, global on → send', () => {
		expect(shouldSendEmail(on, undefined, false)).toBe(true)
	})
	test('no entry, first scan, global on → send', () => {
		expect(shouldSendEmail(on, undefined, true)).toBe(true)
	})
	test('no entry, first scan, global off → skip', () => {
		expect(shouldSendEmail(off, undefined, true)).toBe(false)
	})
	test('muted, not first scan → skip', () => {
		const e: ChannelEntry = { id: 'A', notify: false }
		expect(shouldSendEmail(on, e, false)).toBe(false)
	})
	test('muted, first scan → skip', () => {
		const e: ChannelEntry = { id: 'A', notify: false }
		expect(shouldSendEmail(on, e, true)).toBe(false)
	})
	test('per-channel notifyOnFirstScan false overrides global on', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: false }
		expect(shouldSendEmail(on, e, true)).toBe(false)
	})
	test('per-channel notifyOnFirstScan true overrides global off', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: true }
		expect(shouldSendEmail(off, e, true)).toBe(true)
	})
	test('per-channel notifyOnFirstScan false, not first scan → send', () => {
		const e: ChannelEntry = { id: 'A', notifyOnFirstScan: false }
		expect(shouldSendEmail(on, e, false)).toBe(true)
	})
})

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
		await parseFeedsAndNotify(args())
		expect(sendErrorEmail).toHaveBeenCalledTimes(1)
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

	test('records metadata and skipped backlog outcome', async () => {
		const manual = { ...config, mode: 'whitelist', notifyOnFirstScan: false }
		await parseFeedsAndNotify({ ...args(), config: manual } as never)
		expect(await db.get(`SELECT title, emailOutcome FROM video_observations
			WHERE videoId='new-video'`)).toEqual({
			title: 'Video', emailOutcome: 'backlog_skipped',
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
