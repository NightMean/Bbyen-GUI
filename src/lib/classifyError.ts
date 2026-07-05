export type ErrorCategory = 'auth' | 'quota' | 'other'

const AUTH_REASONS = [
	'invalid_grant', 'invalid_token', 'autherror', 'unauthorized',
]
const QUOTA_REASONS = [
	'quotaexceeded', 'ratelimitexceeded', 'dailylimitexceeded',
	'userratelimitexceeded',
]

// Classify an unknown thrown value into a coarse category so the alerting
// layer can track and de-duplicate by cause. Total: never throws, unknown
// shapes fall through to 'other'.
export const classifyError = (err: unknown): ErrorCategory => {
	if (typeof err !== 'object' || err === null) {
		return 'other'
	}

	const anyErr = err as {
		code?: number | string,
		response?: { status?: number },
		errors?: Array<{ reason?: string }>,
		message?: string,
	}

	const status = anyErr.response?.status ??
		(typeof anyErr.code === 'number' ? anyErr.code : undefined)
	const reason = anyErr.errors?.[0]?.reason?.toLowerCase() ?? ''
	const message = anyErr.message?.toLowerCase() ?? ''

	const mentions = (list: string[]) =>
		list.some(needle => reason.includes(needle) || message.includes(needle))

	if (status === 401 || mentions(AUTH_REASONS)) {
		return 'auth'
	}
	if (status === 403 && mentions(QUOTA_REASONS)) {
		return 'quota'
	}
	return 'other'
}
