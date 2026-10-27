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
import { saveGeneralSettings } from './generalSettings'
import { CookieConnectionStore } from './cookieConnection'
import { createCookieRefresh } from './cookieRefresh'
import { CookiePreviewService } from './cookiePreview'
import { activateConfirmedCookie } from './activateCookie'
import { recoverCookieCleanup } from './cookieCleanup'
import { ManualSourceSwitch } from './manualSourceSwitch'
import { CookieBellActions } from './cookieBellActions'
import { CookieSubscriptionActions } from './cookieSubscriptionActions'
import { setCookieChannelNotify } from './cookieChannelPreferences'
import { saveUnsubscribePreference } from './unsubscribePreference'
import { TitleAlerts } from './titleAlerts'
import { ChannelAddedAlerts } from './channelAddedAlerts'
import { pruneActivity } from './activityRetention'
import { IncidentReminders } from './incidentReminders'
import { IncidentRecoveries } from './incidentRecoveries'
import { readCookieFile } from './cookieFile'
import { CookieFileRecovery } from './cookieFileRecovery'

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
		const cookieStore = new CookieConnectionStore(db)
		try { await recoverCookieCleanup(db, CONFIG_DIR) } catch {
			logger.warn('Cookie cleanup is pending.')
		}
		const cookieStatus = await cookieStore.status()
		if (cookieStatus) {
			config.mode = 'cookie'
			config.cookieStale = cookieStatus.stale
		}

		// Reject over-long intervals up front: Node's timer delay is a 32-bit
		// int, so anything larger silently fires every 1 ms.
		const subscriptionsTimer = assertTimerWithinLimit(
			'subscriptions', parseDuration(config.timers.subscriptions) as number)
		const videosTimer = assertTimerWithinLimit(
			'videos', parseDuration(config.timers.videos) as number)

		// Both jobs share one SQLite connection and may open transactions.
		const jobs = new RefreshCoordinator(db, logger)
		await jobs.recoverInterrupted()
		const alerts = new IncidentReporter(db, logger, undefined,
			() => config.notifyRecoveries === true)
		await alerts.recoverInterrupted()
		const titleAlerts = new TitleAlerts(db, async () => {
			const email = await mailer.init(await loadEmailConfig())
			return alert => email.sendTitleAlert({ ...alert,
				cookieStale: config.cookieStale })
		}, message => logger.warn(message))
		await titleAlerts.recoverInterrupted()
		const channelAlerts = new ChannelAddedAlerts(db, async () => {
			const email = await mailer.init(await loadEmailConfig())
			return channels => email.sendChannelAdded(channels, config.cookieStale)
		}, message => logger.warn(message))
		await channelAlerts.recoverInterrupted()
		const reminders = new IncidentReminders(db, async () => {
			const email = await mailer.init(await loadEmailConfig())
			return email.sendErrorEmail
		}, message => logger.warn(message))
		await reminders.recoverInterrupted()
		const recoveries = new IncidentRecoveries(db, async () => {
			const email = await mailer.init(await loadEmailConfig())
			return email.sendErrorEmail
		}, message => logger.warn(message))
		await recoveries.recoverInterrupted()
		const refreshCookies = createCookieRefresh({ store: cookieStore,
			config, alerts, logger,
			loadReplacement: () => readCookieFile(CONFIG_DIR) })
		const tasks = createServiceTasks({ db, service, config, logger,
			initialAuth, alerts, refreshCookies,
			retryPendingAlerts: (send, enabled) => alerts.retryPending(send, enabled),
			reportQuotaDurably: options => alerts.notifyDurable('quota',
				new Error('API quota retry limit reached.'), options),
			loadMailers: async () => mailer.init(await loadEmailConfig()),
			loadAuth: () => authorize({ interactive: false }),
		})
		const quota = new QuotaRunner({ coordinator: jobs,
			backoff: new QuotaBackoff(db), enabled: () => config.mode === 'youtube',
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
		const fileRecovery = new CookieFileRecovery(config, cookieStore,
			() => readCookieFile(CONFIG_DIR), () => runRefresh('subscriptions'))
		let cookieFileWarning = false
		schedule = new RefreshSchedule(runRefresh)
		const activeSchedule = schedule
		schedule.configure({ subscriptions: subscriptionsTimer,
			videos: videosTimer })
		const cookiePreviews = new CookiePreviewService(db)
		const manualSwitch = new ManualSourceSwitch(db, config, CONFIG_FILE,
			CHANNELS_FILE, CONFIG_DIR, cookiePreviews)
		const handler = createDashboardHandler(db, jobs, {
			config,
			cookiePreviews,
			cookieStatus: () => cookieStore.status(),
			cookieCleanupPending: () => cookieStore.cleanupPending(),
			manualSwitch,
			bellActions: new CookieBellActions(db, config, cookieStore,
				tasks.runSubscriptions),
			subscriptionActions: new CookieSubscriptionActions(db, config,
				cookieStore, tasks.runSubscriptions),
			activateCookie: (candidateId, previewId) => activateConfirmedCookie(
				config, cookieStore, cookiePreviews, candidateId, previewId),
			imports: new SubscriptionImportService(CHANNELS_FILE, config),
			add: (id, backlog) =>
				addManualChannel(CHANNELS_FILE, config, id, backlog),
			resolve: resolveChannelId,
			setNotify: (id, notify) => config.mode === 'cookie'
				? setCookieChannelNotify(databaseConnection, CHANNELS_FILE, config,
					id, notify)
				: setManualChannelNotify(CHANNELS_FILE, config, id, notify),
			remove: id => removeManualChannel(CHANNELS_FILE, config, id),
			manualMode: () => config.mode === 'whitelist',
			manualNotify: id => config.mode === 'cookie' ||
				config.whitelistedChannelIds?.some(c => c.id === id)
				? config.channelSettingsById?.get(id)?.notify !== false : null,
			emailSettings: () => ({ settings: publicEmailSettings(config),
				userFromEnvironment: process.env.BBYEN_EMAIL_USER !== undefined,
				passFromEnvironment: process.env.BBYEN_EMAIL_PASS !== undefined }),
			saveEmail: settings => saveEmailSettings(CONFIG_FILE, config, settings),
			saveCredentials: value => saveEmailCredentials(SECRETS_FILE, value),
			saveSchedule: value =>
				saveRefreshIntervals(CONFIG_FILE, config, activeSchedule, value),
			saveGeneral: async value => {
				if (config.notifyTitleChanges === false) await titleAlerts.run(false)
				if (config.notifyChannelAdded === false) await channelAlerts.run(false)
				if (config.notifyRecoveries !== true) await recoveries.run(false)
				await saveGeneralSettings(CONFIG_FILE, config, value)
				await pruneActivity(databaseConnection,
					config.activityRetentionDays ?? null)
				if (!value.notifyTitleChanges) await titleAlerts.run(false)
				if (!value.notifyChannelAdded) await channelAlerts.run(false)
				if (!value.notifyRecoveries) await recoveries.run(false)
			},
			saveUnsubscribePreference: value =>
				saveUnsubscribePreference(CONFIG_FILE, config, value),
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
			() => jobs.maintenance('cookie-cleanup', () =>
				recoverCookieCleanup(databaseConnection, CONFIG_DIR))
				.catch(() => logger.warn('Cookie cleanup is pending.')),
			60_000,
			false,
		)
		setIntervalInstant(
			() => jobs.maintenance('cookie-file-recovery', () => fileRecovery.check())
				.then(() => { cookieFileWarning = false }, () => {
					if (!cookieFileWarning) logger.warn('Could not inspect cookie file.')
					cookieFileWarning = true
				}),
			60_000,
			true,
		)
		setIntervalInstant(
			() => jobs.maintenance('title-alerts', () =>
				titleAlerts.run(config.notifyTitleChanges !== false))
				.catch(() => logger.warn('Could not process title alerts.')),
			60_000,
			true,
		)
		setIntervalInstant(
			() => jobs.maintenance('channel-alerts', () =>
				channelAlerts.run(config.notifyChannelAdded !== false))
				.catch(() => logger.warn('Could not process channel alerts.')),
			60_000,
			true,
		)
		setIntervalInstant(
			() => jobs.maintenance('activity-retention', () =>
				pruneActivity(databaseConnection, config.activityRetentionDays ?? null))
				.catch(() => logger.warn('Could not prune activity history.')),
			60_000,
			true,
		)
		setIntervalInstant(
			() => jobs.maintenance('incident-reminders', () =>
				reminders.run(config.notifyFailureReminders === true))
				.catch(() => logger.warn('Could not process incident reminders.')),
			60_000,
			true,
		)
		setIntervalInstant(
			() => jobs.maintenance('incident-recoveries', () =>
				recoveries.run(config.notifyRecoveries === true))
				.catch(() => logger.warn('Could not process recovery emails.')),
			60_000,
			true,
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
