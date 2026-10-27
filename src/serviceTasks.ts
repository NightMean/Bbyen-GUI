import * as sqlite from 'sqlite'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { Config } from './config'
import { ISendErrorEmail, SendVideoEmail } from './email'
import {
	AlertDeps, AlertReporter, defaultAlertReporter,
} from './lib/alertState'
import { RefreshResult } from './refreshResult'
import { updateSubscriptions } from './subscriptions'
import { parseFeedsAndNotify } from './videos'

interface Mailers {
	sendVideoEmail: SendVideoEmail,
	sendErrorEmail: (error: ISendErrorEmail) => Promise<unknown>,
}

interface TaskDependencies {
	db: sqlite.Database,
	service: youtube_v3.Youtube,
	config: Config,
	logger: {
		info: (message: string) => void,
		warn: (message: string) => void,
		error: (error: unknown) => void,
	},
	loadMailers: () => Promise<Mailers>,
	loadAuth: () => Promise<OAuth2Client>,
	initialAuth?: OAuth2Client,
	alerts?: AlertReporter,
	retryPendingAlerts?: (send: Mailers['sendErrorEmail'], enabled: boolean) =>
		Promise<void>,
	reportQuotaDurably?: (options: AlertDeps) => Promise<boolean>,
	refreshCookies?: (mailers?: Mailers) => Promise<RefreshResult>,
}

const unavailable = (category: 'auth' | 'other'): RefreshResult => ({
	status: 'failed', total: null, succeeded: 0, failed: 0, skipped: 0,
	failedChannels: [], errorCategory: category,
})

/** Resolve credentials again when needed without restarting the service. */
export const createServiceTasks = (deps: TaskDependencies) => {
	let auth: OAuth2Client | undefined = deps.initialAuth
	let smtpAvailable: boolean | undefined
	const alerts = deps.alerts ?? defaultAlertReporter
	const jobAlerts: AlertReporter = {
		notify: (category, err, options) => alerts.notify(category, err,
			category === 'quota' ? { ...options, emailOnError: false } : options),
		clear: (categories, source, channelId) =>
			alerts.clear(categories, source, channelId),
	}
	const missingAlert = async (): Promise<never> => {
		throw new Error('SMTP configuration is unavailable.')
	}
	const getMailers = async (): Promise<Mailers | undefined> => {
		try {
			const mailers = await deps.loadMailers()
			if (smtpAvailable === false) {
				deps.logger.info('SMTP settings are available.')
				await alerts.clear(['other'], 'smtp')
			}
			smtpAvailable = true
			return mailers
		} catch {
			if (smtpAvailable !== false) {
				deps.logger.warn('SMTP configuration unavailable; video checks paused.')
				await alerts.notify('other', new Error('SMTP unavailable'), {
					source: 'smtp', emailOnError: deps.config.logging.emailOnError,
					logger: deps.logger, sendErrorEmail: missingAlert,
				})
			}
			smtpAvailable = false
			return undefined
		}
	}
	const getAuth = async (
		mailers?: Mailers,
	): Promise<OAuth2Client | undefined> => {
		if (deps.config.mode !== 'youtube') return undefined
		if (auth) return auth
		try {
			auth = await deps.loadAuth()
			await alerts.clear(['auth'], 'service-auth')
			return auth
		} catch {
			await alerts.notify('auth', new Error(
				'YouTube authorization unavailable; reconnect the account.'), {
				source: 'service-auth',
				sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert,
				emailOnError: deps.config.logging.emailOnError,
				logger: deps.logger,
			})
			return undefined
		}
	}
	const runSubscriptions = async (): Promise<RefreshResult> => {
		const mailers = await getMailers()
		if (deps.config.mode === 'cookie') {
			if (!deps.refreshCookies) return unavailable('other')
			return deps.refreshCookies(mailers)
		}
		const currentAuth = await getAuth(mailers)
		if (deps.config.mode === 'youtube' && !currentAuth) {
			return unavailable('auth')
		}
		const result = await updateSubscriptions({
			db: deps.db, service: deps.service, auth: currentAuth,
			config: deps.config,
			sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert,
			alerts: jobAlerts,
		})
		if (result.errorCategory === 'auth' && auth === currentAuth) {
			auth = undefined
		}
		return result
	}
	const runVideos = async (): Promise<RefreshResult> => {
		const mailers = await getMailers()
		if (!mailers) return unavailable('other')
		const currentAuth = await getAuth(mailers)
		if (deps.config.mode === 'youtube' && !currentAuth) {
			return unavailable('auth')
		}
		const result = await parseFeedsAndNotify({
			db: deps.db, service: deps.service, auth: currentAuth,
			config: deps.config,
			sendVideoEmail: mailers.sendVideoEmail,
			sendErrorEmail: mailers.sendErrorEmail,
			alerts: jobAlerts,
		})
		if (result.errorCategory === 'auth' && auth === currentAuth) {
			auth = undefined
		}
		return result
	}
	const runRssVideos = async (): Promise<RefreshResult> => {
		const mailers = await getMailers()
		if (!mailers) return unavailable('other')
		return parseFeedsAndNotify({ db: deps.db, service: deps.service,
			config: deps.config, rssOnly: true, alerts: jobAlerts,
			sendVideoEmail: mailers.sendVideoEmail,
			sendErrorEmail: mailers.sendErrorEmail })
	}
	const retryAlerts = async (): Promise<void> => {
		const mailers = await getMailers()
		if (mailers && deps.retryPendingAlerts) {
			await deps.retryPendingAlerts(
				mailers.sendErrorEmail, deps.config.logging.emailOnError)
		}
	}
	const reportQuota = async (): Promise<boolean> => {
		const mailers = await getMailers()
		const options: AlertDeps = {
			source: 'service', emailOnError: deps.config.logging.emailOnError,
			logger: deps.logger,
			sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert,
		}
		if (deps.reportQuotaDurably) return deps.reportQuotaDurably(options)
		await alerts.notify('quota', new Error('API quota retry limit reached.'),
			options)
		return false
	}
	const clearQuota = () => alerts.clear(['quota'], 'service')
	return { runSubscriptions, runVideos, runRssVideos, retryAlerts,
		reportQuota, clearQuota }
}
