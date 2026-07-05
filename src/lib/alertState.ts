import { ErrorCategory } from './classifyError'

export interface AlertDeps {
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
const alerted: Record<ErrorCategory, boolean> = {
	auth: false,
	quota: false,
	other: false,
}

// Email the user about a failed task run, at most once per category until the
// state is cleared by a successful run. Never throws.
export const notifyError = async (
	category: ErrorCategory,
	err: unknown,
	deps: AlertDeps,
): Promise<void> => {
	const asError = err instanceof Error ? err : new Error(String(err))

	if (!deps.emailOnError) {
		deps.logger.error(asError)
		return
	}
	if (alerted[category]) {
		deps.logger.warn(
			`Suppressing repeat ${category} alert email; already notified.`)
		deps.logger.error(asError)
		return
	}

	try {
		await deps.sendErrorEmail({
			stack: asError.stack ?? '',
			message: asError.message,
			subject: SUBJECTS[category],
		})
		alerted[category] = true
		deps.logger.info(`Sent ${category} alert email.`)
	} catch (sendErr) {
		deps.logger.warn('Failed to send alert email about a previous error.')
		deps.logger.error(sendErr)
	}
	deps.logger.error(asError)
}

// Clear alert flags for the given categories after a successful task run so a
// future recurrence alerts again.
export const clearErrorState = (categories: ErrorCategory[]): void => {
	for (const category of categories) {
		alerted[category] = false
	}
}

// Test-only: reset all flags.
export const _resetAlertState = (): void => {
	alerted.auth = false
	alerted.quota = false
	alerted.other = false
}
