import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { ISendErrorEmail } from './email'
import { AlertReporter } from './lib/alertState'
import { classifyError } from './lib/classifyError'
import { fetchCookieChannels } from './lib/cookieDiscovery'
import { RefreshResult } from './refreshResult'

interface CookieRefreshDependencies {
	store: CookieConnectionStore,
	config: Config,
	alerts: AlertReporter,
	logger: { info: (message: string) => void, warn: (message: string) => void,
		error: (error: unknown) => void },
	fetch?: typeof fetchCookieChannels,
}

type CookieMailers = {
	sendErrorEmail: (email: ISendErrorEmail) => Promise<unknown>,
}

export const createCookieRefresh = (deps: CookieRefreshDependencies) =>
	async (mailers?: CookieMailers)
		: Promise<RefreshResult> => {
		const warn = (message: string) => {
			try { deps.logger.warn(message) } catch {
				// Diagnostics cannot replace the refresh result.
			}
		}
		const report = async (err: unknown) => {
			try {
				await deps.alerts.notify(classifyError(err), err, {
					source: 'cookie', emailOnError: deps.config.logging.emailOnError,
					logger: deps.logger, sendErrorEmail: mailers?.sendErrorEmail ??
						(async () => { throw new Error('SMTP unavailable.') }),
				})
			} catch { warn('Could not record the cookie incident.') }
		}
		let generation: string | undefined
		try {
			const connection = await deps.store.read()
			if (!connection) throw new Error('Cookie connection is unavailable.')
			generation = connection.generation
			const channels = await (deps.fetch ?? fetchCookieChannels)({
				cookie: connection.cookieHeader, targetProfile: connection.profile,
				onProgress: () => undefined,
			})
			if (!await deps.store.refresh(generation, channels)) {
				throw new Error('Cookie connection changed during refresh.')
			}
			const unknown = channels.filter(channel =>
				channel.notificationState === 'unknown')
			deps.config.cookieStale = unknown.length > 0
			if (unknown.length) {
				await report(new Error('Some YouTube bell states are unconfirmed.'))
				return {
					status: unknown.length === channels.length ? 'failed' : 'partial',
					total: channels.length, succeeded: channels.length - unknown.length,
					failed: unknown.length, skipped: 0,
					failedChannels: unknown.map(channel => channel.channelId),
					errorCategory: 'other' }
			}
			try { await deps.alerts.clear(['auth', 'other'], 'cookie') } catch {
				warn('Could not clear the cookie incident.')
			}
			return { status: 'success', total: channels.length,
				succeeded: channels.length, failed: 0, skipped: 0, failedChannels: [] }
		} catch (err) {
			let current = !generation
			try { if (generation) current = await deps.store.markStale(generation) }
			catch { warn('Could not record stale cookie status.') }
			if (current) {
				deps.config.cookieStale = true
				await report(err)
			}
			return { status: 'failed', total: null, succeeded: 0, failed: 0,
				skipped: 0, failedChannels: [], errorCategory: classifyError(err) }
		}
	}
