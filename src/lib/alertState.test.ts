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

	test('does not send or log untrusted exception text', async () => {
		const deps = makeDeps()
		deps.sendErrorEmail.mockRejectedValueOnce(new Error('smtp secret fixture'))
		await notifyError('other', new Error('cookie secret fixture'), {
			...deps, source: 'videos', channelId: 'UC0000000000000000000000',
		})
		expect(deps.sendErrorEmail.mock.calls[0][0].message)
			.toContain('UC0000000000000000000000')
		expect(JSON.stringify(deps.sendErrorEmail.mock.calls))
			.not.toContain('cookie secret fixture')
		expect(JSON.stringify(deps.logger.error.mock.calls))
			.not.toContain('secret fixture')
	})

	test('coalesces concurrent notifications for the same outage', async () => {
		const deps = makeDeps()
		await Promise.all([
			notifyError('auth', new Error('x'), deps),
			notifyError('auth', new Error('x'), deps),
		])
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(1)
	})

	test('retries an email failure on the next failure report', async () => {
		const deps = makeDeps()
		deps.sendErrorEmail.mockRejectedValueOnce(new Error('SMTP unavailable'))
		await notifyError('other', new Error('x'), deps)
		await notifyError('other', new Error('x'), deps)
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(2)
	})

	test('waits for every affected source to recover', async () => {
		const deps = makeDeps()
		await notifyError('auth', new Error('x'), { ...deps, source: 'videos' })
		await notifyError('auth', new Error('x'), {
			...deps, source: 'subscriptions',
		})
		clearErrorState(['auth'], 'videos')
		await notifyError('auth', new Error('x'), {
			...deps, source: 'subscriptions',
		})
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(1)
		clearErrorState(['auth'], 'subscriptions')
		await notifyError('auth', new Error('x'), { ...deps, source: 'videos' })
		expect(deps.sendErrorEmail).toHaveBeenCalledTimes(2)
	})
})
