import { google } from 'googleapis'
import parseDuration from 'parse-duration'
import { loadConfig, loadConfigRaw, loadEmailConfig } from './config'
import * as database from './database'
import { recoverPendingVideoEmails } from './videoSchema'
import authorize from './google/auth'
import * as mailer from './email'
import setIntervalInstant from './lib/setIntervalInstant'
import { RefreshCoordinator } from './refreshCoordinator'
import { createServiceTasks } from './serviceTasks'
import { IncidentReporter } from './incidentReporter'
import { assertTimerWithinLimit } from './lib/timerLimit'
import setupLogger from './lib/logger'

const main = async () => {
	const logger = await setupLogger({ label: 'main' })

	try {
		const service = google.youtube('v3')
		const raw = await loadConfigRaw()
		// A usable token still supports API fallback while normalizing channels.
		const initialAuth = raw.mode === 'whitelist' ? undefined :
			await authorize({ interactive: false }).catch(() => undefined)
		const config = await loadConfig(service, initialAuth, {
			resolveEmail: false,
		})
		const db = await database.init(config.database)
		await recoverPendingVideoEmails(db)

		// Reject over-long intervals up front: Node's timer delay is a 32-bit
		// int, so anything larger silently fires every 1 ms.
		const subscriptionsTimer = assertTimerWithinLimit(
			'subscriptions', parseDuration(config.timers.subscriptions) as number)
		const videosTimer = assertTimerWithinLimit(
			'videos', parseDuration(config.timers.videos) as number)

		// Both jobs share one SQLite connection and may open transactions.
		const jobs = new RefreshCoordinator(db, logger)
		await jobs.recoverInterrupted()
		const alerts = new IncidentReporter(db, logger)
		await alerts.recoverInterrupted()
		const tasks = createServiceTasks({ db, service, config, logger,
			initialAuth, alerts,
			retryPendingAlerts: (send, enabled) => alerts.retryPending(send, enabled),
			loadMailers: async () => mailer.init(await loadEmailConfig()),
			loadAuth: () => authorize({ interactive: false }),
		})
		setIntervalInstant(
			() => jobs.run('subscriptions', tasks.runSubscriptions)
				.catch(() => logger.error('Subscription refresh failed unexpectedly.')),
			subscriptionsTimer,
			config.kickoff.subscriptions,
		)

		setIntervalInstant(
			() => jobs.run('videos', tasks.runVideos)
				.catch(() => logger.error('Video refresh failed unexpectedly.')),
			videosTimer,
			config.kickoff.videos,
		)
		setIntervalInstant(
			() => jobs.maintenance('alerts', async () => {
				await alerts.recoverInterrupted()
				await tasks.retryAlerts()
			})
				.catch(() => logger.warn('Could not retry incident alerts.')),
			60_000,
			false,
		)

	} catch {
		logger.error('Service startup failed. Check configuration and storage.')
		process.exit(1)
	}
}

main()
