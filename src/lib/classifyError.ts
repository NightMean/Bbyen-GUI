import { CookieSessionError } from './cookieSessionError'

export type ErrorCategory = 'auth' | 'quota' | 'other'

const AUTH_REASONS = [
	'invalid_grant', 'invalid_token', 'autherror', 'unauthorized',
]
const QUOTA_REASONS = [
	'quotaexceeded', 'ratelimitexceeded', 'dailylimitexceeded',
	'userratelimitexceeded', 'quota exceeded', 'rate limit exceeded',
	'resource_exhausted',
]

// Classify an unknown thrown value into a coarse category so the alerting
// layer can track and de-duplicate by cause. Total: never throws, unknown
// shapes fall through to 'other'.
export const classifyError = (err: unknown): ErrorCategory => {
	if (err instanceof CookieSessionError) return 'auth'
	if (typeof err !== 'object' || err === null) {
		return 'other'
	}

	const anyErr = err as {
		code?: unknown,
		response?: { status?: unknown, data?: { error?: {
			errors?: unknown, message?: unknown, status?: unknown,
		} } },
		errors?: unknown,
		message?: unknown,
	}

	const status = anyErr.response?.status ??
		(typeof anyErr.code === 'number' ? anyErr.code : undefined)
	const nested = anyErr.response?.data?.error
	const reasons = (value: unknown): string[] => Array.isArray(value)
		? value.slice(0, 10).map(item =>
			typeof item?.reason === 'string' ? item.reason.toLowerCase() : '') : []
	const text = [anyErr.message, nested?.message, nested?.status,
		...reasons(anyErr.errors), ...reasons(nested?.errors)]
		.filter((value): value is string => typeof value === 'string')
		.map(value => value.toLowerCase())

	const mentions = (list: string[]) =>
		list.some(needle => text.some(value => value.includes(needle)))

	if (status === 401 || mentions(AUTH_REASONS)) {
		return 'auth'
	}
	if (status === 429 || (status === 403 && mentions(QUOTA_REASONS))) {
		return 'quota'
	}
	return 'other'
}
