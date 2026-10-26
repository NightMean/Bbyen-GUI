import * as sqlite from 'sqlite'
import { youtube_v3 } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { Config } from './config'
import { ISendErrorEmail, SendVideoEmail } from './email'
import { clearErrorState, notifyError } from './lib/alertState'
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
}

const unavailable = (category: 'auth' | 'other'): RefreshResult => ({
	status: 'failed', total: null, succeeded: 0, failed: 0, skipped: 0,
	failedChannels: [], errorCategory: category,
})

/** Resolve credentials again when needed without restarting the service. */
export const createServiceTasks = (deps: TaskDependencies) => {
	let auth: OAuth2Client | undefined = deps.initialAuth
	let smtpAvailable: boolean | undefined
	const getMailers = async (): Promise<Mailers | undefined> => {
		try {
			const mailers = await deps.loadMailers()
			if (smtpAvailable === false) {
				deps.logger.info('SMTP settings are available.')
			}
			smtpAvailable = true
			return mailers
		} catch {
			if (smtpAvailable !== false) {
				deps.logger.warn('SMTP configuration unavailable; video checks paused.')
			}
			smtpAvailable = false
			return undefined
		}
	}
	const missingAlert = async (): Promise<never> => {
		throw new Error('SMTP configuration is unavailable.')
	}
	const getAuth = async (
		mailers?: Mailers,
	): Promise<OAuth2Client | undefined> => {
		if (deps.config.mode === 'whitelist') return undefined
		if (auth) return auth
		try {
			auth = await deps.loadAuth()
			clearErrorState(['auth'], 'service-auth')
			return auth
		} catch {
			await notifyError('auth', new Error(
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
		const currentAuth = await getAuth(mailers)
		if (deps.config.mode !== 'whitelist' && !currentAuth) {
			return unavailable('auth')
		}
		const result = await updateSubscriptions({
			db: deps.db, service: deps.service, auth: currentAuth,
			config: deps.config,
			sendErrorEmail: mailers?.sendErrorEmail ?? missingAlert,
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
		if (deps.config.mode !== 'whitelist' && !currentAuth) {
			return unavailable('auth')
		}
		const result = await parseFeedsAndNotify({
			db: deps.db, service: deps.service, auth: currentAuth,
			config: deps.config,
			sendVideoEmail: mailers.sendVideoEmail,
			sendErrorEmail: mailers.sendErrorEmail,
		})
		if (result.errorCategory === 'auth' && auth === currentAuth) {
			auth = undefined
		}
		return result
	}
	return { runSubscriptions, runVideos }
}
