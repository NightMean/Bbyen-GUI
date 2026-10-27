import { google } from 'googleapis'
import parseDuration from 'parse-duration'
import { createServer, Server } from 'http'
import {
	CHANNELS_FILE, CONFIG_DIR, CONFIG_FILE, SECRETS_FILE, loadConfig,
	loadConfigRaw, loadEmailConfig,
} from './config'
import * as database from './database'
import { recoverPendingVideoEmails } from './videoSchema'
import authorize from './google/auth'
import * as mailer from './email'
import setIntervalInstant from './lib/setIntervalInstant'
import { RefreshCoordinator } from './refreshCoordinator'
import { createServiceTasks } from './serviceTasks'
import { IncidentReporter } from './incidentReporter'
import { QuotaBackoff } from './quotaBackoff'
import { QuotaRunner } from './quotaRunner'
import { assertTimerWithinLimit } from './lib/timerLimit'
import setupLogger from './lib/logger'
import { createDashboardHandler, dashboardPort } from './dashboardServer'
import {
	createBootstrapHandler, missingConfiguration,
} from './dashboardBootstrap'
import {
	addManualChannel, removeManualChannel, setManualChannelNotify,
} from './manualChannels'
import { resolveChannelId } from './lib/resolveChannelId'
import {
	publicEmailSettings, saveEmailCredentials, saveEmailSettings,
} from './emailSettings'
import { sendTestEmail } from './emailTest'
import { SubscriptionImportService } from './subscriptionImportService'
import { RefreshSchedule, saveRefreshIntervals } from './refreshSchedule'

const listen = async (server: Server): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(dashboardPort(process.env.BBYEN_DASHBOARD_PORT),
			'0.0.0.0', () => { server.removeListener('error', reject); resolve() })
	})
}

const startService = async (existingServer?: Server) => {
	const logger = await setupLogger({ label: 'main' })
	let db: Awaited<ReturnType<typeof database.init>> | undefined
	let schedule: RefreshSchedule | undefined
	try {
		const service = google.youtube('v3')
		const raw = await loadConfigRaw()
		// A usable token still supports API fallback while normalizing channels.
		const initialAuth = raw.mode === 'whitelist' ? undefined :
			await authorize({ interactive: false }).catch(() => undefined)
		const config = await loadConfig(service, initialAuth, {
			resolveEmail: false,
		})
		db = await database.init(config.database)
		const databaseConnection = db
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
			reportQuotaDurably: options => alerts.notifyDurable('quota',
				new Error('API quota retry limit reached.'), options),
			loadMailers: async () => mailer.init(await loadEmailConfig()),
			loadAuth: () => authorize({ interactive: false }),
		})
		const quota = new QuotaRunner({ coordinator: jobs,
			backoff: new QuotaBackoff(db), enabled: config.mode === 'youtube',
			alertsEnabled: () => config.logging.emailOnError,
			work: { subscriptions: tasks.runSubscriptions, videos: tasks.runVideos },
			rssFallback: tasks.runRssVideos,
			reportQuota: tasks.reportQuota, clearQuota: tasks.clearQuota,
			warn: message => logger.warn(message),
		})
		const runRefresh = (kind: 'subscriptions' | 'videos') => {
			void quota.run(kind).catch(() =>
				logger.error('Refresh failed unexpectedly.'))
		}
		schedule = new RefreshSchedule(runRefresh)
		const activeSchedule = schedule
		schedule.configure({ subscriptions: subscriptionsTimer,
			videos: videosTimer })
		const handler = createDashboardHandler(db, jobs, {
			config,
			imports: new SubscriptionImportService(CHANNELS_FILE, config),
			add: (id, backlog) =>
				addManualChannel(CHANNELS_FILE, config, id, backlog),
			resolve: resolveChannelId,
			setNotify: (id, notify) =>
				setManualChannelNotify(CHANNELS_FILE, config, id, notify),
			remove: id => removeManualChannel(CHANNELS_FILE, config, id),
			manualMode: () => config.mode === 'whitelist',
			manualNotify: id => config.whitelistedChannelIds?.some(c => c.id === id)
				? config.channelSettingsById?.get(id)?.notify !== false : null,
			emailSettings: () => ({ settings: publicEmailSettings(config),
				userFromEnvironment: process.env.BBYEN_EMAIL_USER !== undefined,
				passFromEnvironment: process.env.BBYEN_EMAIL_PASS !== undefined }),
			saveEmail: settings => saveEmailSettings(CONFIG_FILE, config, settings),
			saveCredentials: value => saveEmailCredentials(SECRETS_FILE, value),
			saveSchedule: value =>
				saveRefreshIntervals(CONFIG_FILE, config, activeSchedule, value),
			testEmail: () => sendTestEmail(databaseConnection, async () => {
				const mail = await mailer.init(await loadEmailConfig())
				await mail.sendTestEmail()
			}),
			refresh: runRefresh,
		})
		const server = existingServer ?? createServer(handler)
		if (existingServer) {
			server.removeAllListeners('request')
			server.on('request', handler)
		} else await listen(server)
		server.on('error', () => logger.error('Dashboard server failed.'))
		if (config.kickoff.subscriptions) runRefresh('subscriptions')
		if (config.kickoff.videos) runRefresh('videos')
		setIntervalInstant(
			() => jobs.maintenance('alerts', async () => {
				await alerts.recoverInterrupted()
				await tasks.retryAlerts()
			})
				.catch(() => logger.warn('Could not retry incident alerts.')),
			60_000,
			false,
		)
		setIntervalInstant(
			() => quota.tick().catch(() => logger.warn('Quota retry check failed.')),
			60_000,
			true,
		)

	} catch (err) {
		logger.error('Service startup failed. Check configuration and storage.')
		schedule?.stop()
		if (db) await db.close().catch(() => logger.warn('Database close failed.'))
		throw err
	}
}

const main = async () => {
	const missing = await missingConfiguration(CONFIG_FILE, CHANNELS_FILE)
	if (!missing.config && !missing.channels) return startService()
	const server = createServer()
	server.on('request', createBootstrapHandler({ config: CONFIG_FILE,
		channels: CHANNELS_FILE, directory: CONFIG_DIR,
		start: () => startService(server),
	}))
	await listen(server)
	server.on('error', () => console.error('Dashboard setup server failed.'))
}

void main().catch(() => {
	console.error('Service startup failed. Check configuration and storage.')
	process.exit(1)
})
