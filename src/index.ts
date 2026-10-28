import { google } from 'googleapis'
import parseDuration from 'parse-duration'
import { createServer, Server } from 'http'
import {
	CHANNELS_FILE, CONFIG_DIR, CONFIG_FILE, SECRETS_FILE, loadConfig,
	loadEmailConfig, loadValidatedConfigRaw,
} from './config'
import * as database from './database'
import { recoverPendingVideoEmails } from './videoSchema'
import authorize, { authorizationRevision } from './google/auth'
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
import { ApiSubscriptionActions } from './apiSubscriptionActions'
import {
	setApiChannelNotify, setCookieChannelNotify,
} from './channelPreferences'
import { removeApiManualChannel, setApiChannelList } from './apiChannelLists'
import { saveUnsubscribePreference } from './unsubscribePreference'
import { TitleAlerts } from './titleAlerts'
import { ChannelAddedAlerts } from './channelAddedAlerts'
import { pruneActivity } from './activityRetention'
import { IncidentReminders } from './incidentReminders'
import { IncidentRecoveries } from './incidentRecoveries'
import { readCookieFile } from './cookieFile'
import { CookieFileRecovery } from './cookieFileRecovery'
import { recoverOAuthCleanup } from './oauthCleanup'
import { compareConnectionIdentities } from './combinedIdentity'
import { RemoteDesktopAuth } from './remoteDesktopAuth'
import { CombinedMode } from './combinedMode'
import { refreshCombinedMetadata } from './combinedMetadata'
import { readAccountIdentity, sameAccount } from './google/accountIdentity'
import { withAuthorizationTimeout } from './google/desktopAuthorization'
import { ApiSourceSwitch } from './apiSourceSwitch'
import { ApiManualSwitch, recoverApiManualSwitch } from './apiManualSwitch'
import { ManualApiSwitch, recoverManualApiSwitch } from './manualApiSwitch'
import { normalizeApiChannelLists } from './apiChannelLists'
import fs from 'fs/promises'
import { parseEmailSelectionPolicy } from './emailPolicy'

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
		let raw = await loadValidatedConfigRaw()
		db = await database.init(raw.database)
		const databaseConnection = db
		let recoveredManual = false
		try {
			if (await recoverApiManualSwitch(db, CONFIG_DIR, CONFIG_FILE,
				CHANNELS_FILE)) {
				recoveredManual = true
				raw = await loadValidatedConfigRaw()
			}
			if (await recoverManualApiSwitch(db, CONFIG_DIR, CONFIG_FILE,
				CHANNELS_FILE, authorizationRevision)) {
				recoveredManual = true
				raw = await loadValidatedConfigRaw()
			}
		} catch (error) {
			logger.error('Source recovery failed. Check config.json, ' +
				'channels.json and their lock files; preserve any external edits.')
			try {
				const reporter = new IncidentReporter(db, logger)
				await reporter.notify('other', error, { source: 'source-switch',
					emailOnError: raw.logging.emailOnError, logger,
					sendErrorEmail: async message => (await mailer.init(
						await loadEmailConfig())).sendErrorEmail(message) })
			} catch { logger.warn('Could not report source recovery failure.') }
			throw error
		}
		await recoverPendingVideoEmails(db)
		const cookieStore = new CookieConnectionStore(db)
		try { await recoverCookieCleanup(db, CONFIG_DIR) } catch {
			logger.warn('Cookie cleanup is pending.')
		}
		const cookieStatus = await cookieStore.status()
		const combined = await db.get('SELECT profileKey FROM combined_connection')
		if (combined && !cookieStatus) {
			throw new Error('Combined connection is missing its cookie profile.')
		}
		// A persisted cookie connection overrides an older API-mode config.
		const initialAuth = raw.mode !== 'youtube' || cookieStatus ? undefined :
			await authorize({ interactive: false }).catch(() => undefined)
		const config = await loadConfig(service, initialAuth, {
			resolveEmail: false,
		})
		config.apiEnrichment = false
		config.manualTransitionPending = false
		if (cookieStatus) {
			config.mode = 'cookie'
			config.cookieStale = cookieStatus.stale
			if (combined && combined.profileKey !== cookieStatus.channelId) {
				throw new Error('Combined account identity does not match the cookie.')
			}
			config.apiEnrichment = !!combined
		}
		if (config.mode !== 'youtube' && !config.apiEnrichment) {
			try { await recoverOAuthCleanup(db, CONFIG_DIR) } catch {
				logger.warn('YouTube authorization cleanup is pending.')
			}
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
		if (recoveredManual) await alerts.clear(['other'], 'source-switch')
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
			verifyCombinedAuth: async auth => {
				const connection = await cookieStore.read()
				const revision = await authorizationRevision()
				const identity = await withAuthorizationTimeout(
					readAccountIdentity(service, auth))
				if (!connection || !sameAccount(identity.channelId,
					connection.profile.channelId) ||
					(await cookieStore.read())?.generation !== connection.generation ||
					revision !== await authorizationRevision() || !config.apiEnrichment) {
					throw new Error('YouTube account identities do not match.')
				}
			},
			refreshCombinedMetadata: async auth => {
				return refreshCombinedMetadata({ db: databaseConnection, service, auth,
					store: cookieStore, revision: authorizationRevision })
			},
			retryPendingAlerts: (send, enabled) => alerts.retryPending(send, enabled),
			reportQuotaDurably: options => alerts.notifyDurable('quota',
				new Error('API quota retry limit reached.'), options),
			loadMailers: async () => mailer.init(await loadEmailConfig()),
			loadAuth: () => authorize({ interactive: false }),
			authRevision: authorizationRevision,
		})
		const quota = new QuotaRunner({ coordinator: jobs,
			backoff: new QuotaBackoff(db), enabled: () =>
				config.mode === 'youtube' || !!config.apiEnrichment,
			alertsEnabled: () => config.logging.emailOnError,
			work: { subscriptions: tasks.runSubscriptions, videos: tasks.runVideos },
			rssFallback: tasks.runRssVideos,
			subscriptionFallback: tasks.runCookieSubscriptions,
			subscriptionFallbackEnabled: () => !!config.apiEnrichment,
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
		const cookieSourceRevision = async () => {
			if (config.mode === 'youtube') {
				return `youtube:${await authorizationRevision()}`
			}
			if (config.mode === 'cookie') {
				return `cookie:${(await cookieStore.read())?.generation ?? 'missing'}`
			}
			return config.mode
		}
		const cookiePreviews = new CookiePreviewService(db, undefined, undefined,
			cookieSourceRevision)
		const manualSwitch = new ManualSourceSwitch(db, config, CONFIG_FILE,
			CHANNELS_FILE, CONFIG_DIR, cookiePreviews)
		const combinedMode = new CombinedMode(db, config, cookieStore, service,
			() => authorize(), authorizationRevision, CONFIG_DIR)
		const apiSourceSwitch = new ApiSourceSwitch(db, config, cookieStore,
			cookiePreviews, service, () => authorize(), authorizationRevision,
			CONFIG_DIR, CONFIG_FILE)
		const reportManualRecovery = () => alerts.notify('other', new Error(
			'Confirmed source switch is awaiting recovery.'), {
			source: 'source-switch', emailOnError: config.logging.emailOnError,
			logger, sendErrorEmail: async message => (await mailer.init(
				await loadEmailConfig())).sendErrorEmail(message),
		})
		const apiManualSwitch = new ApiManualSwitch(db, config, CONFIG_DIR,
			CONFIG_FILE, CHANNELS_FILE, authorizationRevision, Date.now,
			reportManualRecovery)
		const manualApiSwitch = new ManualApiSwitch(db, config, CONFIG_DIR,
			CONFIG_FILE, CHANNELS_FILE, service, () => authorize(),
			authorizationRevision, Date.now, reportManualRecovery)
		const verifyApiProfile = async (channelId: string) => {
			if (config.mode !== 'youtube') throw new Error('API mode is unavailable.')
			const revision = await authorizationRevision()
			const identity = await withAuthorizationTimeout(
				readAccountIdentity(service, await authorize()))
			if (!sameAccount(identity.channelId, channelId) ||
					config.mode !== 'youtube' ||
					revision !== await authorizationRevision()) {
				throw new Error('YouTube profiles do not match.')
			}
		}
		const handler = createDashboardHandler(db, jobs, {
			config,
			combinedMode,
			apiSourceSwitch,
			apiManualSwitch,
			manualApiSwitch,
			verifyApiProfile,
			cookiePreviews,
			cookieStatus: () => cookieStore.status(),
			cookieCleanupPending: () => cookieStore.cleanupPending(),
			oauthCleanupPending: () => cookieStore.oauthCleanupPending(),
			remoteDesktopAuth: new RemoteDesktopAuth(config, cookieStore, service,
				CONFIG_DIR, authorizationRevision),
			compareIdentities: async () => {
				if (await cookieStore.oauthCleanupPending()) {
					throw new Error('Authorization cleanup is pending.')
				}
				return compareConnectionIdentities({ store: cookieStore, service,
					loadAuth: () => authorize(), authRevision: authorizationRevision })
			},
			manualSwitch,
			bellActions: new CookieBellActions(db, config, cookieStore,
				tasks.runCookieSubscriptions),
			subscriptionActions: new CookieSubscriptionActions(db, config,
				cookieStore, tasks.runCookieSubscriptions),
			apiSubscriptionActions: new ApiSubscriptionActions(db, config, service,
				() => authorize({ interactive: false }), authorizationRevision),
			activateCookie: (candidateId, previewId) => activateConfirmedCookie(
				config, cookieStore, cookiePreviews, candidateId, previewId, {
					directory: CONFIG_DIR, sourceRevision: cookieSourceRevision,
					recover: () => recoverOAuthCleanup(databaseConnection, CONFIG_DIR),
					verifyApiProfile,
				}),
			imports: new SubscriptionImportService(CHANNELS_FILE, config),
			add: (id, backlog) =>
				addManualChannel(CHANNELS_FILE, config, id, backlog),
			resolve: resolveChannelId,
			setNotify: (id, notify) => config.mode === 'cookie'
				? setCookieChannelNotify(databaseConnection, CHANNELS_FILE, config,
					id, notify)
				: config.mode === 'youtube'
					? setApiChannelNotify(databaseConnection, CHANNELS_FILE, config,
						id, notify)
					: setManualChannelNotify(CHANNELS_FILE, config, id, notify),
			setApiList: (id, list, included) => setApiChannelList(
				databaseConnection, CHANNELS_FILE, config, id, list, included),
			remove: id => config.mode === 'youtube'
				? removeApiManualChannel(CHANNELS_FILE, config, id)
				: removeManualChannel(CHANNELS_FILE, config, id),
			manualMode: () => config.mode === 'whitelist',
			channelNotify: id => config.mode === 'cookie' ||
				config.mode === 'youtube' ||
				config.whitelistedChannelIds?.some(c => c.id === id)
				? config.channelSettingsById?.get(id)?.notify !== false &&
					!(config.mode === 'whitelist' &&
						config.channelSettingsById?.get(id)?.manualPolicyExcluded) : null,
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
			() => jobs.maintenance('api-manual-recovery', async () => {
				if (!config.manualTransitionPending) return
				const api = await recoverManualApiSwitch(databaseConnection, CONFIG_DIR,
					CONFIG_FILE, CHANNELS_FILE, authorizationRevision)
				if (api) {
					manualApiSwitch.finishRuntime(api)
					await alerts.clear(['other'], 'source-switch')
					return
				}
				let lists = await recoverApiManualSwitch(databaseConnection, CONFIG_DIR,
					CONFIG_FILE, CHANNELS_FILE)
				if (!lists) {
					const current = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'))
					if (current.mode !== 'whitelist' && current.mode !== 'youtube') {
						throw new Error('Manual source recovery is incomplete.')
					}
					lists = await normalizeApiChannelLists(
						JSON.parse(await fs.readFile(CHANNELS_FILE, 'utf8')))
					if (current.mode === 'youtube') {
						manualApiSwitch.finishRuntime({ lists,
							policy: parseEmailSelectionPolicy(
								current.emailSelectionPolicy ?? 'allowlist') })
						await alerts.clear(['other'], 'source-switch')
						return
					}
				}
				apiManualSwitch.finishRuntime(lists)
				await recoverOAuthCleanup(databaseConnection, CONFIG_DIR)
				await alerts.clear(['other'], 'source-switch')
			}).catch(async () => {
				logger.warn('Source recovery is pending.')
				try { await reportManualRecovery() } catch {
					logger.warn('Could not report source recovery failure.')
				}
			}),
			60_000, false,
		)
		setIntervalInstant(
			() => jobs.maintenance('oauth-cleanup', async () => {
				if (config.mode !== 'youtube' && !config.apiEnrichment) {
					await recoverOAuthCleanup(databaseConnection, CONFIG_DIR)
				}
			}).catch(() => logger.warn('YouTube authorization cleanup is pending.')),
			60_000, false,
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
