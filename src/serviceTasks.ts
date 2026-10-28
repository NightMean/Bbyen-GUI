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
import { classifyError, ErrorCategory } from './lib/classifyError'

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
	authRevision?: () => Promise<string>,
	initialAuth?: OAuth2Client,
	alerts?: AlertReporter,
	retryPendingAlerts?: (send: Mailers['sendErrorEmail'], enabled: boolean) =>
		Promise<void>,
	reportQuotaDurably?: (options: AlertDeps) => Promise<boolean>,
	refreshCookies?: (mailers?: Mailers) => Promise<RefreshResult>,
	verifyCombinedAuth?: (auth: OAuth2Client) => Promise<void>,
	verifyApiAuth?: (auth: OAuth2Client) => Promise<unknown>,
	refreshCombinedMetadata?: (auth: OAuth2Client) => Promise<{
		matched: number, total: number,
	}>,
}

const unavailable = (category: ErrorCategory): RefreshResult => ({
	status: 'failed', total: null, succeeded: 0, failed: 0, skipped: 0,
	failedChannels: [], errorCategory: category,
})

/** Resolve credentials again when needed without restarting the service. */
export const createServiceTasks = (deps: TaskDependencies) => {
	let auth: OAuth2Client | undefined = deps.initialAuth
	let authRevision: string | undefined
	let loadingAuth: Promise<OAuth2Client> | undefined
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
		restarts = 0,
	): Promise<{ auth?: OAuth2Client, category?: ErrorCategory }> => {
		if (deps.config.mode !== 'youtube' && !deps.config.apiEnrichment) {
			return {}
		}
		try {
			const revision = await deps.authRevision?.()
			if (auth && (!deps.authRevision || authRevision === revision)) {
				if (deps.config.apiEnrichment) {
					if (!deps.verifyCombinedAuth) throw new Error('Identity unavailable.')
					await deps.verifyCombinedAuth(auth)
				}
				if (deps.config.mode === 'youtube') await deps.verifyApiAuth?.(auth)
				await alerts.clear(['auth', 'quota'], 'service-auth')
				return { auth }
			}
			if (!loadingAuth) {
				auth = undefined
				const work = (async () => {
					for (let attempt = 0; attempt < 3; attempt++) {
						const before = await deps.authRevision?.()
						const loaded = await deps.loadAuth()
						const after = await deps.authRevision?.()
						if (before === after) {
							auth = loaded
							authRevision = after
							return loaded
						}
					}
					throw new Error('Authorization changed during reload.')
				})()
				loadingAuth = work
				void work.finally(() => {
					if (loadingAuth === work) loadingAuth = undefined
				}).catch(() => undefined)
			}
			const loaded = await loadingAuth
			if (deps.authRevision && authRevision !== await deps.authRevision()) {
				if (restarts >= 2) throw new Error('Authorization changed repeatedly.')
				return getAuth(mailers, restarts + 1)
			}
			if (deps.config.apiEnrichment) {
				if (!deps.verifyCombinedAuth) throw new Error('Identity unavailable.')
				await deps.verifyCombinedAuth(loaded)
			}
			if (deps.config.mode === 'youtube') await deps.verifyApiAuth?.(loaded)
			await alerts.clear(['auth', 'quota'], 'service-auth')
			return { auth: loaded }
		} catch (error) {
			const category = classifyError(error) === 'quota' ? 'quota' : 'auth'
			await jobAlerts.notify(category, new Error(
				'YouTube authorization unavailable; reconnect the account.'), {
				source: 'service-auth',
				sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert,
				emailOnError: deps.config.logging.emailOnError,
				logger: deps.logger,
			})
			return { category }
		}
	}
	const runSubscriptions = async (): Promise<RefreshResult> => {
		if (deps.config.manualTransitionPending) return unavailable('other')
		const mailers = await getMailers()
		if (deps.config.mode === 'cookie') {
			if (!deps.refreshCookies) return unavailable('other')
			const result = await deps.refreshCookies(mailers)
			if (!deps.config.apiEnrichment || result.status === 'failed') {
				return result
			}
			const authorization = await getAuth(mailers)
			const currentAuth = authorization.auth
			if (!currentAuth || !deps.refreshCombinedMetadata) {
				return { ...result, status: 'partial',
					errorCategory: authorization.category ?? 'auth' }
			}
			try {
				const metadata = await deps.refreshCombinedMetadata(currentAuth)
				if (metadata.matched < metadata.total) {
					await jobAlerts.notify('other', new Error(
						'Some cookie subscriptions have no API metadata.'), {
						source: 'combined-api',
						emailOnError: deps.config.logging.emailOnError, logger: deps.logger,
						sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert })
					return { ...result, status: 'partial', errorCategory: 'other',
						apiChecked: true }
				}
				await alerts.clear(['auth', 'other', 'quota'], 'combined-api')
				return { ...result, apiChecked: true }
			} catch (error) {
				const category = classifyError(error)
				await jobAlerts.notify(category, error, { source: 'combined-api',
					emailOnError: deps.config.logging.emailOnError, logger: deps.logger,
					sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert })
				return { ...result, status: 'partial', errorCategory: category,
					apiChecked: true }
			}
		}
		const currentAuth = (await getAuth(mailers)).auth
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
	const runCookieSubscriptions = async (): Promise<RefreshResult> => {
		if (deps.config.manualTransitionPending) return unavailable('other')
		if (deps.config.mode !== 'cookie' || !deps.refreshCookies) {
			return unavailable('other')
		}
		return deps.refreshCookies(await getMailers())
	}
	const runVideos = async (): Promise<RefreshResult> => {
		if (deps.config.manualTransitionPending) return unavailable('other')
		const mailers = await getMailers()
		if (!mailers) return unavailable('other')
		const authorization = await getAuth(mailers)
		const currentAuth = authorization.auth
		if (deps.config.apiEnrichment && authorization.category === 'quota') {
			return unavailable('quota')
		}
		if (deps.config.mode === 'youtube' && !currentAuth) {
			return unavailable('auth')
		}
		const result = await parseFeedsAndNotify({
			db: deps.db, service: deps.service, auth: currentAuth,
			config: deps.config,
			sendVideoEmail: mailers.sendVideoEmail,
			sendErrorEmail: mailers.sendErrorEmail,
			alerts: jobAlerts,
			rssOnly: !!deps.config.apiEnrichment && !currentAuth,
		})
		if (result.errorCategory === 'auth' && auth === currentAuth) {
			auth = undefined
		}
		return deps.config.apiEnrichment && !currentAuth
			? { ...result, status: result.status === 'failed' ? 'failed' : 'partial',
				errorCategory: 'auth' } : result
	}
	const runRssVideos = async (): Promise<RefreshResult> => {
		if (deps.config.manualTransitionPending) return unavailable('other')
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
	return { runSubscriptions, runCookieSubscriptions, runVideos, runRssVideos,
		retryAlerts, reportQuota, clearQuota }
}
