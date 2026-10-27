import { Config } from './config'
import { CookieConnectionStore } from './cookieConnection'
import { ISendErrorEmail } from './email'
import { AlertReporter } from './lib/alertState'
import { classifyError } from './lib/classifyError'
import { fetchCookieChannels } from './lib/cookieDiscovery'
import { RefreshResult } from './refreshResult'
import { normalizeCookieHeader } from './lib/innertubeChannels'

interface CookieRefreshDependencies {
	store: CookieConnectionStore,
	config: Config,
	alerts: AlertReporter,
	logger: { info: (message: string) => void, warn: (message: string) => void,
		error: (error: unknown) => void },
	fetch?: typeof fetchCookieChannels,
	loadReplacement?: () => Promise<string | null>,
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
			const fetch = deps.fetch ?? fetchCookieChannels
			let channels
			let replacement: string | null = null
			let recoveredError: unknown
			try {
				channels = await fetch({ cookie: connection.cookieHeader,
					targetProfile: connection.profile, onProgress: () => undefined })
			} catch (err) {
				if (!deps.loadReplacement) throw err
				try {
					const file = await deps.loadReplacement()
					if (file) replacement = normalizeCookieHeader(file)
					if (!replacement || replacement === connection.cookieHeader) throw err
					channels = await fetch({ cookie: replacement,
						targetProfile: connection.profile, onProgress: () => undefined })
					recoveredError = err
				} catch {
					warn('Could not verify an updated cookie file for this profile.')
					throw err
				}
			}
			const next = replacement ? await deps.store.replaceAndRefresh(
				generation, replacement, channels) :
				await deps.store.refresh(generation, channels) ? generation : null
			if (!next) throw new Error('Cookie connection changed during refresh.')
			generation = next
			if (replacement) {
				try { deps.logger.info('Updated the cookie connection from the file.') }
				catch { warn('Could not log cookie renewal.') }
				await report(recoveredError)
				if (classifyError(recoveredError) === 'auth') {
					try { await deps.alerts.clear(['auth'], 'cookie') } catch {
						warn('Could not clear the cookie authentication incident.')
					}
				}
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
