import { expect, test, vi } from 'vitest'
import RSSParser from 'rss-parser'
import { init } from './database'
import { IncidentReporter } from './incidentReporter'
import { QuotaBackoff } from './quotaBackoff'
import { QuotaRunner } from './quotaRunner'
import { RefreshCoordinator } from './refreshCoordinator'
import { createServiceTasks } from './serviceTasks'
import { Config } from './config'

vi.mock('./lib/logger', () => ({ default: async () => ({
	info: vi.fn(), verbose: vi.fn(), debug: vi.fn(),
	warn: vi.fn(), error: vi.fn(),
}) }))

test('RSS continues during quota backoff and API recovery enriches videos',
	async () => {
		const db = await init({ filename: ':memory:' })
		const id = 'UC0000000000000000000001'
		try {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail)
				VALUES (?, 'Creator', 'img')`, id)
			const feed = {
				title: 'Creator', items: [{ videoId: 'video', title: 'Video',
					isoDate: '2026-01-01T00:00:00Z' }],
			} as never
			vi.spyOn(RSSParser.prototype, 'parseURL')
				.mockResolvedValueOnce(feed).mockResolvedValueOnce(feed)
				.mockResolvedValue({ title: 'Creator', items: [] } as never)
			const list = vi.fn().mockRejectedValueOnce({ response: { status: 429 } })
				.mockResolvedValue({ data: { items: [{
					snippet: { title: 'Video', channelTitle: 'Creator',
						publishedAt: '2026-01-01T00:00:00Z',
						thumbnails: { high: { url: 'image' } } },
					contentDetails: { duration: 'PT2M' },
				}] } })
			const sendVideoEmail = vi.fn().mockResolvedValue(undefined)
			const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
			const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
				whitelistedChannelIds: [{ id }], blacklistedChannelIds: [],
				notifyOnFirstScan: true,
				logging: { emailOnError: true } } as unknown as Config
			const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
			let time = Date.parse('2026-01-01T00:00:00Z')
			const alerts = new IncidentReporter(db, logger, () => new Date(time))
			await alerts.notify('other', new Error('fixture'), {
				source: 'videos', channelId: id, emailOnError: false,
				logger, sendErrorEmail,
			})
			const tasks = createServiceTasks({ db, config, logger, alerts,
				service: { videos: { list } } as never,
				loadAuth: vi.fn().mockResolvedValue({}),
				loadMailers: vi.fn().mockResolvedValue({
					sendVideoEmail, sendErrorEmail,
				}),
			})
			const runner = new QuotaRunner({
				coordinator: new RefreshCoordinator(db, logger),
				backoff: new QuotaBackoff(db, () => new Date(time)), enabled: true,
				alertsEnabled: () => true,
				work: { videos: tasks.runVideos,
					subscriptions: tasks.runSubscriptions },
				rssFallback: tasks.runRssVideos,
				reportQuota: tasks.reportQuota, clearQuota: tasks.clearQuota,
				warn: logger.warn,
			})
			const first = await runner.run('videos')
			expect(first).toMatchObject({ status: 'partial',
				degradedReason: 'quota' })
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect(await db.get(`SELECT resolvedAt FROM incidents WHERE
				source='videos' AND category='other' AND channelId=?`, id))
				.toEqual({ resolvedAt: null })
			expect(await db.get(`SELECT durationSeconds, apiMetadataAt
				FROM video_observations WHERE videoId='video'`))
				.toEqual({ durationSeconds: null, apiMetadataAt: null })
			expect(await runner.run('videos')).toMatchObject({
				status: 'partial', degradedReason: 'quota',
			})
			expect(list).toHaveBeenCalledTimes(1)
			time += 30 * 60_000
			await runner.tick()
			expect(await db.get(`SELECT durationSeconds, apiMetadataAt
				FROM video_observations WHERE videoId='video'`)).toEqual({
				durationSeconds: 120, apiMetadataAt: expect.any(String),
			})
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect(await db.get('SELECT COUNT(*) AS count FROM quota_backoff'))
				.toEqual({ count: 0 })
		} finally {
			vi.restoreAllMocks()
			await db.close()
		}
	})

test('RSS persists videos through authorization failure and API recovery',
	async () => {
		const db = await init({ filename: ':memory:' })
		const id = 'UC0000000000000000000001'
		try {
			await db.run(`INSERT INTO subscriptions
				(channelId, channelTitle, channelThumbnail)
				VALUES (?, 'Creator', 'img')`, id)
			vi.spyOn(RSSParser.prototype, 'parseURL').mockResolvedValue({
				title: 'Creator', items: [{ videoId: 'video', title: 'Video',
					isoDate: '2026-01-01T00:00:00Z' }],
			} as never)
			const sendVideoEmail = vi.fn().mockResolvedValue(undefined)
			const loadAuth = vi.fn().mockRejectedValueOnce(new Error('expired'))
				.mockResolvedValue({})
			const list = vi.fn().mockResolvedValue({ data: { items: [{
				snippet: { title: 'Video', channelTitle: 'Creator',
					publishedAt: '2026-01-01T00:00:00Z',
					thumbnails: { high: { url: 'image' } } },
				contentDetails: { duration: 'PT2M' },
			}] } })
			const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
				whitelistedChannelIds: [{ id }], blacklistedChannelIds: [],
				notifyOnFirstScan: true,
				logging: { emailOnError: false } } as unknown as Config
			const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
			const tasks = createServiceTasks({ db, config, logger, loadAuth,
				service: { videos: { list } } as never,
				loadMailers: vi.fn().mockResolvedValue({ sendVideoEmail,
					sendErrorEmail: vi.fn() }),
			})
			expect(await tasks.runVideos()).toMatchObject({ status: 'partial',
				errorCategory: 'auth', apiChecked: false })
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect((await tasks.runVideos()).status).toBe('success')
			expect(sendVideoEmail).toHaveBeenCalledTimes(1)
			expect(await db.get('SELECT durationSeconds FROM video_observations ' +
				'WHERE videoId=?', 'video')).toEqual({ durationSeconds: 120 })
		} finally { vi.restoreAllMocks(); await db.close() }
	})
