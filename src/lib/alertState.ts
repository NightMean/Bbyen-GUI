import { ErrorCategory } from './classifyError'
import { isChannelId } from './channelId'

export interface AlertDeps {
	source?: string,
	channelId?: string,
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

const ACTIONS: Record<ErrorCategory, string> = {
	auth: 'Reconnect the YouTube account and retry the affected refresh.',
	quota: 'Check the YouTube API quota and retry after it resets.',
	other: 'Check the affected refresh and service status, then retry.',
}

const SOURCES: Record<string, string> = {
	videos: 'Video refresh',
	subscriptions: 'Subscription refresh',
	'service-auth': 'YouTube authorization',
	cookie: 'YouTube cookie sync',
	smtp: 'Email delivery',
	service: 'Service',
}

export const buildSafeAlert = (
	category: ErrorCategory, sourceKey?: string, channelId?: string,
): { stack: string; message: string; subject: string } => {
	const source = SOURCES[sourceKey ?? 'service'] ?? 'Service'
	const channel = channelId && isChannelId(channelId)
		? ` Channel: ${channelId}.` : ''
	return { stack: '',
		message: `${source} failed.${channel} ${ACTIONS[category]}`,
		subject: SUBJECTS[category] }
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
	// External exception text and stacks may contain cookies or tokens.
	void err
	const safe = buildSafeAlert(category, deps.source, deps.channelId)
	const { message } = safe
	const episode = alerted[category]
	episode.sources.add(deps.source ?? 'service')

	if (!deps.emailOnError) {
		deps.logger.error(message)
		return
	}
	if (episode.sent || episode.pending) {
		deps.logger.warn(
			`Suppressing repeat ${category} alert email for current episode.`)
		deps.logger.error(message)
		await episode.pending
		return
	}

	episode.pending = (async () => {
		try {
			await deps.sendErrorEmail(safe)
			episode.sent = true
			deps.logger.info(`Sent ${category} alert email.`)
		} catch {
			deps.logger.warn('Failed to send alert email about a previous error.')
			deps.logger.error('Check SMTP settings and retry the alert.')
		}
	})()
	await episode.pending
	episode.pending = undefined
	deps.logger.error(message)
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
