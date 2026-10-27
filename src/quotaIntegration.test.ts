import { expect, test, vi } from 'vitest'
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

test('quota retry uses the service jobs and sends only the final alert',
	async () => {
		const db = await init({ filename: ':memory:' })
		try {
			let time = Date.parse('2026-01-01T00:00:00Z')
			const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
			const alerts = new IncidentReporter(db, logger, () => new Date(time))
			const sendErrorEmail = vi.fn().mockResolvedValue(undefined)
			const list = vi.fn().mockRejectedValue({ response: { status: 429 } })
			const config = { mode: 'youtube', emailSelectionPolicy: 'allowlist',
				logging: { emailOnError: true } } as unknown as Config
			const tasks = createServiceTasks({ db, config, logger, alerts,
				service: { subscriptions: { list } } as never,
				loadAuth: vi.fn().mockResolvedValue({}),
				loadMailers: vi.fn().mockResolvedValue({
					sendErrorEmail, sendVideoEmail: vi.fn(),
				}),
				reportQuotaDurably: options => alerts.notifyDurable('quota',
					new Error('fixture'), options),
			})
			const backoff = new QuotaBackoff(db, () => new Date(time))
			const runner = new QuotaRunner({
				coordinator: new RefreshCoordinator(db, logger), backoff, enabled: true,
				alertsEnabled: () => true,
				work: { subscriptions: tasks.runSubscriptions,
					videos: tasks.runVideos },
				reportQuota: tasks.reportQuota, clearQuota: tasks.clearQuota,
				warn: logger.warn,
			})
			await runner.run('subscriptions')
			for (const delay of [30, 60, 120]) {
				time += delay * 60_000
				await runner.tick()
				expect(sendErrorEmail).not.toHaveBeenCalled()
			}
			time += 240 * 60_000
			await runner.tick()
			expect(sendErrorEmail).toHaveBeenCalledTimes(1)
			list.mockResolvedValue({ data: { items: [] } })
			time += 240 * 60_000
			await runner.tick()
			expect(await db.get('SELECT COUNT(*) AS count FROM quota_backoff'))
				.toEqual({ count: 0 })
			expect(sendErrorEmail).toHaveBeenCalledTimes(1)
		} finally { await db.close() }
	})
