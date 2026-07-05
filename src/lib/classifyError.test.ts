import { expect, describe, test } from 'vitest'

import { classifyError } from './classifyError'

describe('classifyError', () => {
	test('401 status is auth', () => {
		expect(classifyError({ response: { status: 401 } })).toBe('auth')
	})
	test('invalid_grant reason is auth', () => {
		expect(classifyError({ errors: [ { reason: 'invalid_grant' } ] }))
			.toBe('auth')
	})
	test('quotaExceeded is quota', () => {
		expect(classifyError({
			response: { status: 403 },
			errors: [ { reason: 'quotaExceeded' } ],
		})).toBe('quota')
	})
	test('rateLimitExceeded is quota', () => {
		expect(classifyError({
			response: { status: 403 },
			errors: [ { reason: 'rateLimitExceeded' } ],
		})).toBe('quota')
	})
	test('500 status is other', () => {
		expect(classifyError({ response: { status: 500 } })).toBe('other')
	})
	test('plain Error is other', () => {
		expect(classifyError(new Error('boom'))).toBe('other')
	})
	test('undefined is other', () => {
		expect(classifyError(undefined)).toBe('other')
	})
})
