import { expect, describe, test, vi, beforeEach } from 'vitest'

import { notifyError, clearErrorState, _resetAlertState } from './alertState'

const makeDeps = (emailOnError = true) => ({
	sendErrorEmail: vi.fn().mockResolvedValue(undefined),
	emailOnError,
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
})

describe('alertState', () => {
	beforeEach(() => _resetAlertState())

	test('emails once on first error of a category', async () => {
		const deps = makeDeps()
		await notifyError('auth', new Error('x'), deps)
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(1)
	})

	test('suppresses a repeat of the same category', async () => {
		const deps = makeDeps()
		await notifyError('auth', new Error('x'), deps)
		await notifyError('auth', new Error('x'), deps)
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(1)
	})

	test('emails again after clearErrorState', async () => {
		const deps = makeDeps()
		await notifyError('auth', new Error('x'), deps)
		clearErrorState([ 'auth' ])
		await notifyError('auth', new Error('x'), deps)
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(2)
	})

	test('does not email when emailOnError is false', async () => {
		const deps = makeDeps(false)
		await notifyError('auth', new Error('x'), deps)
		expect(deps.sendErrorEmail).not.toHaveBeenCalled()
	})

	test('tracks categories independently', async () => {
		const deps = makeDeps()
		await notifyError('auth', new Error('x'), deps)
		await notifyError('quota', new Error('y'), deps)
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(2)
	})

	test('a failing sendErrorEmail does not throw', async () => {
		const deps = makeDeps()
		deps.sendErrorEmail.mockRejectedValueOnce(new Error('smtp down'))
		await expect(notifyError('other', new Error('x'), deps))
			.resolves.toBeUndefined()
	})
})
