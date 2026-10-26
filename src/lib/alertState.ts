import { ErrorCategory } from './classifyError'

export interface AlertDeps {
	source?: string,
	sendErrorEmail: (error: {
		stack: string,
		message: string,
		subject?: string,
	}) => Promise<unknown>,
	emailOnError: boolean,
	logger: {
		info: (message: string) => void,
		warn: (message: string) => void,
		error: (error: unknown) => void,
	},
}

const SUBJECTS: Record<ErrorCategory, string> = {
	auth: 'BBYEN: YouTube authentication failed',
	quota: 'BBYEN: YouTube API quota exceeded',
	other: 'BBYEN encountered an error',
}

// In-memory record of which categories have already alerted this episode.
interface Episode {
	sent: boolean,
	pending?: Promise<void>,
	sources: Set<string>,
}
const newEpisode = (): Episode => ({ sent: false, sources: new Set() })
const alerted: Record<ErrorCategory, Episode> = {
	auth: newEpisode(),
	quota: newEpisode(),
	other: newEpisode(),
}

// Email the user about a failed task run, at most once per category until the
// state is cleared by a successful run. Never throws.
export const notifyError = async (
	category: ErrorCategory,
	err: unknown,
	deps: AlertDeps,
): Promise<void> => {
	const asError = err instanceof Error ? err : new Error(String(err))
	const episode = alerted[category]
	episode.sources.add(deps.source ?? 'service')

	if (!deps.emailOnError) {
		deps.logger.error(asError)
		return
	}
	if (episode.sent || episode.pending) {
		deps.logger.warn(
			`Suppressing repeat ${category} alert email for current episode.`)
		deps.logger.error(asError)
		await episode.pending
		return
	}

	episode.pending = (async () => {
		try {
			await deps.sendErrorEmail({
				stack: asError.stack ?? '',
				message: asError.message,
				subject: SUBJECTS[category],
			})
			episode.sent = true
			deps.logger.info(`Sent ${category} alert email.`)
		} catch (sendErr) {
			deps.logger.warn('Failed to send alert email about a previous error.')
			deps.logger.error(sendErr)
		}
	})()
	await episode.pending
	episode.pending = undefined
	deps.logger.error(asError)
}

// Clear alert flags for the given categories after a successful task run so a
// future recurrence alerts again.
export const clearErrorState = (
	categories: ErrorCategory[], source = 'service',
): void => {
	for (const category of categories) {
		alerted[category].sources.delete(source)
		if (alerted[category].sources.size === 0) {
			alerted[category] = newEpisode()
		}
	}
}

// Test-only: reset all flags.
export const _resetAlertState = (): void => {
	alerted.auth = newEpisode()
	alerted.quota = newEpisode()
	alerted.other = newEpisode()
}
